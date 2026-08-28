/**
 * FATOS OPERACIONAIS de um launch de projeto externo — credencial e quota.
 *
 * Existe porque o control plane superior afirmava, em código, duas coisas que
 * nunca produziu:
 *
 *     quota_available: true
 *     credential_proved: true
 *
 * O launcher continuava fazendo `runBillingPreflight` logo antes do spawn, de
 * modo que nenhuma cobrança escapava — mas o gate de autorização registrava
 * "quota disponível" e "credencial provada" sem nenhuma evidência por trás. Um
 * relatório que declara um fato que ninguém observou é pior do que um campo
 * ausente: ele passa a ser citado como prova.
 *
 * A regra desta primitive é uma só:
 *
 *     UNKNOWN nunca vira TRUE para permitir progresso.
 *
 * Por isso cada dimensão é tri-state — PROVEN TRUE, PROVEN FALSE, UNKNOWN — e
 * carrega proveniência textual do que foi de fato consultado. Nada aqui chama
 * provider pago nem gasta inferência: a credencial vem do MESMO
 * `runBillingPreflight` local que o launcher usa, e a quota vem da observação
 * READ-ONLY que ESTA atividade acabou de fazer.
 *
 * A segunda regra, tão dura quanto a primeira:
 *
 *     QUOTA ATUAL É SEMPRE OBSERVADA AGORA.
 *
 * Nenhum `LaunchRecord` anterior, nenhuma folga persistida e nenhum
 * esgotamento histórico entram aqui. Eles descrevem launches que já
 * terminaram — são analytics de consumo passado, não capacidade presente. Se o
 * probe fresco falhou, a quota é UNKNOWN e permanece UNKNOWN.
 *
 * Esta primitive NÃO decide: ela só coleta. ALLOW/HUMAN_REQUIRED continua
 * inteiramente em `authorizeProjectLaunch`, e a guarda final e autoritativa
 * continua sendo o `runBillingPreflight` de `launch.ts`, imediatamente antes
 * do spawn. Defense in depth é intencional: coletar aqui não substitui lá.
 */

import path from 'node:path';

import {
  CapacityStatus,
  type PoolCapacityObservation,
} from '../../src/quota/index.js';
import type { EscalationCandidatePreflight, QuotaHeadroom } from '../../src/routing/index.js';
import {
  assertNoApiCredentials,
  expectedSubscriptionSource,
  runBillingPreflight,
  type CommandRunner,
} from './billing.js';
import type { HarnessPaths } from './paths.js';
import {
  observeEligiblePoolCapacities,
  quotaPoolOfProfile,
  type PoolCapacityProbe,
} from './pool-capacity-observer.js';
import { buildEnvironment, type LauncherProfile } from './profile.js';

/**
 * Fato tri-state com proveniência. `true` e `false` são observações; `null` é
 * ausência de observação e permanece ausência — nunca é reescrito.
 */
export interface LaunchFact {
  readonly availability: boolean | null;
  readonly provenance: string;
}

/** Rótulo textual da proveniência, publicado no relatório sem segredo algum. */
export type LaunchFactEvidence = 'PROVEN_TRUE' | 'PROVEN_FALSE' | 'UNKNOWN';

export function evidenceOf(fact: LaunchFact): LaunchFactEvidence {
  return fact.availability === null
    ? 'UNKNOWN'
    : fact.availability
      ? 'PROVEN_TRUE'
      : 'PROVEN_FALSE';
}

export interface ProjectLaunchFacts {
  readonly profile_id: string;
  /** O provider pôde ser autorizado pelo preflight local de cobrança. */
  readonly provider: LaunchFact;
  readonly credential: LaunchFact;
  readonly quota: LaunchFact;
  /** Recusa textual do preflight de cobrança; `null` quando liberado. */
  readonly billing_refusal: string | null;
}

export interface ProjectLaunchFactsInput {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  /**
   * Subdiretório de HOME saneado usado só para montar o ambiente do probe. O
   * default é o mesmo que a escalation já usava.
   */
  readonly homeNamespace?: string;
  /** Injetável nos testes: nenhum binário real de provider é executado. */
  readonly runner?: CommandRunner;
  /**
   * Snapshot fresco, read-only e já deduplicado por ESTE assessment. Ausente
   * significa que nenhuma observação foi feita agora — e isso é UNKNOWN, nunca
   * um convite para consultar histórico.
   */
  readonly capacityObservation?: PoolCapacityObservation | null;
}

/**
 * Credencial a partir do probe LOCAL e gratuito que o harness já possui.
 *
 * As três respostas possíveis são deliberadamente assimétricas:
 *
 * - PROVEN TRUE exige prova positiva da assinatura esperada para o agente.
 * - PROVEN FALSE exige prova positiva do contrário (fonte de API), porque
 *   recusar por engano também é um erro.
 * - qualquer outra coisa — CLI não autenticada, saída não reconhecida, probe
 *   que não respondeu — permanece UNKNOWN.
 *
 * Um perfil FALSO não fala com provider nenhum: nenhuma credencial é exigida,
 * e isso é um fato observável do próprio perfil, não uma suposição.
 */
function credentialFactOf(
  profile: LauncherProfile,
  billing: Awaited<ReturnType<typeof runBillingPreflight>>,
): LaunchFact {
  if (profile.agent === 'fake') {
    return {
      availability: true,
      provenance: 'launcher_profile.agent=fake: worker falso não fala com provider nenhum',
    };
  }
  const probe = billing.credential;
  const detail = `${probe.command}: ${probe.source} — ${probe.detail}`;
  if (probe.verified && probe.source === expectedSubscriptionSource(profile.agent, profile.provider)) {
    return { availability: true, provenance: detail };
  }
  if (probe.verified && probe.source === 'api') {
    return { availability: false, provenance: detail };
  }
  return { availability: null, provenance: detail };
}

/**
 * Observação FRESCA -> folga de routing.
 *
 * Só duas coisas atravessam: uma folga OBSERVADA (a menor entre as janelas —
 * a mais crítica manda) e um esgotamento DECLARADO pelo provider. `UNKNOWN` e
 * `AVAILABLE_WITHOUT_METER` não produzem folga nenhuma: sem medidor não há
 * número, e inventar um faria a comparação entre pools mentir.
 */
export function headroomFromCapacity(
  capacity: PoolCapacityObservation,
): QuotaHeadroom | null {
  const origin = `observação fresca de ${capacity.quota_pool} em ${capacity.observed_at}`;
  if (capacity.status === CapacityStatus.EXHAUSTED) {
    return {
      status: 'EXHAUSTED',
      provenance: `${origin}: provider declarou esgotamento — ${capacity.reason} (${capacity.source})`,
    };
  }
  if (capacity.status !== CapacityStatus.KNOWN) return null;

  const remainders = capacity.windows
    .map((window) => window.remaining_percent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (remainders.length === 0) return null;
  // A janela mais apertada é a que manda: janelas distintas nunca são somadas
  // nem promediadas, porque têm denominadores e políticas diferentes.
  const remaining = Math.min(...remainders);
  return {
    status: 'OBSERVED',
    remaining_pct: Math.min(100, Math.max(0, remaining)),
    provenance: `${origin}: menor folga observada=${remaining}% (${capacity.source})`,
  };
}

/**
 * Folga ATUAL de um pool, derivada EXCLUSIVAMENTE da observação desta
 * atividade.
 *
 * Não existe fallback histórico. Um probe que falhou é `UNKNOWN`, e `UNKNOWN`
 * permanece `UNKNOWN`: a última leitura de outra work unit descreve o passado
 * daquele launch, não a capacidade de agora. Preencher a falha instrumental
 * com o número antigo faria o routing decidir com um fato que já pode ter
 * expirado — inclusive um esgotamento que já resetou.
 */
export function currentQuotaHeadroom(
  fresh: PoolCapacityObservation | null | undefined,
): QuotaHeadroom {
  if (fresh === undefined || fresh === null) {
    return {
      status: 'UNKNOWN',
      reason: 'nenhuma observação fresca de capacidade foi feita para este pool nesta atividade',
    };
  }
  if (fresh.status === CapacityStatus.UNKNOWN) {
    return { status: 'UNKNOWN', reason: `${fresh.reason} (${fresh.source})` };
  }
  return (
    headroomFromCapacity(fresh) ?? {
      status: 'UNKNOWN',
      reason:
        `observação fresca bem-sucedida sem percentual comparável: ` +
        `${fresh.status} — ${fresh.reason} (${fresh.source})`,
    }
  );
}

/**
 * Folga atual por POOL, a partir do snapshot deduplicado deste assessment.
 * Pools ausentes do snapshot simplesmente não aparecem — e o router já lê
 * ausência como `UNKNOWN`, nunca como zero.
 */
export function currentQuotaHeadroomByPool(
  fresh: ReadonlyMap<string, PoolCapacityObservation>,
): Record<string, QuotaHeadroom> {
  const current: Record<string, QuotaHeadroom> = {};
  for (const [pool, observation] of fresh) {
    current[pool] = currentQuotaHeadroom(observation);
  }
  return current;
}

/**
 * Quota do pool NESTE instante, e só a partir da observação desta atividade.
 *
 * Os endpoints de capacidade são read-only e não fazem inferência, portanto o
 * ciclo de produção observa o pool imediatamente antes de rotear e passa o
 * resultado para cá. Existem exatamente três respostas:
 *
 *     EXHAUSTED fresco        -> PROVEN FALSE
 *     qualquer outra medida   -> PROVEN TRUE
 *     UNKNOWN fresco/ausente  -> UNKNOWN
 *
 * Não há uma quarta. Um chamador isolado que não forneça observação recebe
 * UNKNOWN: esta função não abre `LaunchRecord` nenhum para fabricar capacidade
 * presente a partir de um launch que já terminou.
 */
export function quotaFactOf(input: {
  readonly capacityObservation?: PoolCapacityObservation | null;
}): LaunchFact {
  const fresh = input.capacityObservation ?? null;
  if (fresh === null) {
    return {
      availability: null,
      provenance:
        'nenhuma observação fresca de capacidade foi fornecida a esta coleta; ' +
        'quota atual permanece UNKNOWN e nenhum LaunchRecord anterior a substitui',
    };
  }
  if (fresh.status === CapacityStatus.EXHAUSTED) {
    return {
      availability: false,
      provenance: `observação fresca do pool ${fresh.quota_pool}: ${fresh.reason} (${fresh.source})`,
    };
  }
  if (fresh.status === CapacityStatus.UNKNOWN) {
    return {
      availability: null,
      provenance:
        `probe fresco UNKNOWN do pool ${fresh.quota_pool}: ${fresh.reason} (${fresh.source}); ` +
        'UNKNOWN não é zero, não é esgotamento e não recorre a histórico',
    };
  }
  return {
    availability: true,
    provenance:
      `observação fresca do pool ${fresh.quota_pool}: ${fresh.status}; ` +
      `${fresh.reason} (${fresh.source})`,
  };
}

/**
 * Coleta os fatos permitidos pelas primitives canônicas, sem inventar nenhum.
 *
 * Reusa `buildEnvironment` + `assertNoApiCredentials` + `runBillingPreflight`:
 * é o MESMO preflight de cobrança do launcher e da escalation, e não um
 * segundo regime de verificação. O que muda é só o consumidor — aqui a saída
 * vira fato com proveniência, em vez de exceção.
 */
export async function collectProjectLaunchFacts(
  input: ProjectLaunchFactsInput,
): Promise<ProjectLaunchFacts> {
  const { paths, profile } = input;
  const home = path.join(
    paths.devDir,
    'project',
    input.homeNamespace ?? 'homes',
    profile.id,
  );
  const env = buildEnvironment(profile, process.env, { sanitizedHome: home });
  assertNoApiCredentials(`preflight de launch de ${profile.id}`, env);
  const billing = await runBillingPreflight({
    agent: profile.agent,
    provider: profile.provider,
    billingMode: profile.billing_mode,
    binary: profile.argv[0] as string,
    env,
    orchestratorEnv: process.env,
    ...(input.runner === undefined ? {} : { runner: input.runner }),
  });

  return {
    profile_id: profile.id,
    provider: {
      availability: billing.ok,
      provenance: `runBillingPreflight(${profile.id}): ${billing.refusal ?? 'sem recusa'}`,
    },
    credential: credentialFactOf(profile, billing),
    quota: quotaFactOf({
      ...(input.capacityObservation === undefined
        ? {}
        : { capacityObservation: input.capacityObservation }),
    }),
    billing_refusal: billing.refusal,
  };
}

/**
 * FATOS DE UMA ATIVIDADE provider-backed, com a observação de quota feita
 * AGORA. Este é o caminho ÚNICO de todo role — planner, deliberador,
 * implementer, reviewer, repair e degrau de escalation. Não existe um segundo
 * regime de quota por role, e é por isso que nenhum deles pode afirmar mais do
 * que os outros sobre a mesma franquia.
 *
 * `observed` é a ÚNICA reutilização permitida: o snapshot já lido por ESTA
 * decisão imediata, para que dois profiles do mesmo pool não gerem duas
 * requisições. Ausente, a atividade faz a própria leitura. Um snapshot de
 * outra atividade nunca chega aqui — não há parâmetro que o aceite.
 */
export async function collectCurrentLaunchFacts(input: {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  readonly probe: PoolCapacityProbe;
  readonly homeNamespace?: string;
  readonly runner?: CommandRunner;
  readonly poolOf?: (profile: LauncherProfile) => string | null;
  readonly observed?: ReadonlyMap<string, PoolCapacityObservation>;
}): Promise<ProjectLaunchFacts> {
  const poolOf = input.poolOf ?? quotaPoolOfProfile;
  const pool = poolOf(input.profile);
  const snapshot =
    input.observed ??
    (await observeEligiblePoolCapacities([input.profile], input.probe, poolOf));
  return collectProjectLaunchFacts({
    paths: input.paths,
    profile: input.profile,
    capacityObservation: pool === null ? null : (snapshot.get(pool) ?? null),
    ...(input.homeNamespace === undefined ? {} : { homeNamespace: input.homeNamespace }),
    ...(input.runner === undefined ? {} : { runner: input.runner }),
  });
}

/**
 * Mesma evidência, na forma que o decisor de escalation (M80) consome. A
 * ladder continua decidindo sozinha: o que se compartilha é o FATO, nunca a
 * decisão — e é por isso que esta função não olha diagnosis, degrau nem
 * autorização anterior.
 */
export function escalationPreflightOf(
  profile: LauncherProfile,
  facts: ProjectLaunchFacts,
): EscalationCandidatePreflight {
  return {
    profile_id: facts.profile_id,
    provider_availability: {
      value: facts.provider.availability,
      provenance: facts.provider.provenance,
    },
    credential_availability: {
      value: facts.credential.availability,
      provenance: facts.credential.provenance,
    },
    real_execution_authorization: {
      authorization: {
        value: facts.provider.availability === true ? 'AUTHORIZED' : 'DENIED',
        provenance: facts.provider.provenance,
      },
      billing_mode: {
        value: profile.billing_mode === 'subscription_only' ? 'SUBSCRIPTION' : 'NO_CHARGE',
        provenance: 'launcher_profile.billing_mode',
      },
      quota: {
        // `null` continua UNKNOWN na billing guard: desconhecida não bloqueia
        // por si só, mas também nunca é lida como suficiente.
        availability:
          facts.quota.availability === false
            ? { value: 'INSUFFICIENT', provenance: facts.quota.provenance }
            : { value: null, provenance: facts.quota.provenance },
        remaining: { value: null, provenance: facts.quota.provenance },
        unit: null,
      },
      cost: {
        api_equivalent_usd: { value: null, provenance: 'nenhuma cobrança projetada em assinatura' },
        projected_incremental_charge_usd: {
          value: null,
          provenance: 'nenhuma cobrança projetada em assinatura',
        },
        actual_incremental_charge_usd: { value: null, provenance: 'não observada' },
        actual_incremental_charge_authoritative: false,
      },
      budget: {
        maximum_incremental_charge_usd: {
          value: null,
          provenance: 'nenhum budget de cobrança em assinatura',
        },
      },
    },
  };
}
