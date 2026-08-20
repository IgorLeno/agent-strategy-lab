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
 * `runBillingPreflight` local que o launcher usa, e a quota vem de evidência
 * já gravada em disco por launches anteriores.
 *
 * Esta primitive NÃO decide: ela só coleta. ALLOW/HUMAN_REQUIRED continua
 * inteiramente em `authorizeProjectLaunch`, e a guarda final e autoritativa
 * continua sendo o `runBillingPreflight` de `launch.ts`, imediatamente antes
 * do spawn. Defense in depth é intencional: coletar aqui não substitui lá.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { EscalationCandidatePreflight } from '../../src/routing/index.js';
import {
  assertNoApiCredentials,
  expectedSubscriptionSource,
  runBillingPreflight,
  type CommandRunner,
} from './billing.js';
import type { HarnessPaths } from './paths.js';
import { buildEnvironment, type LauncherProfile } from './profile.js';
import { LaunchRecord, type RateLimitObservation } from './schemas.js';

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
  readonly now?: () => Date;
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
  if (probe.verified && probe.source === expectedSubscriptionSource(profile.agent)) {
    return { availability: true, provenance: detail };
  }
  if (probe.verified && probe.source === 'api') {
    return { availability: false, provenance: detail };
  }
  return { availability: null, provenance: detail };
}

/** Status de rate limit que representam RECUSA do provider, não aviso. */
const REJECTING_STATUS = /reject|exceed|exhaust|limit_reached|blocked/i;

function rejectingObservation(
  observations: readonly RateLimitObservation[],
): RateLimitObservation | undefined {
  return [...observations]
    .reverse()
    .find(
      (observation) =>
        (observation.status !== null && REJECTING_STATUS.test(observation.status)) ||
        (observation.overage_status !== null && REJECTING_STATUS.test(observation.overage_status)),
    );
}

/**
 * Instante de reset da janela, SÓ quando ele é datável sem adivinhação. A CLI
 * emite ISO em algumas versões e um número em outras, e o número não declara
 * unidade: convertê-lo seria inventar a janela. Número vira `null`, e `null`
 * aqui degrada o fato para UNKNOWN — nunca para "quota insuficiente".
 */
function resetInstantOf(observation: RateLimitObservation): number | null {
  const raw = observation.resets_at;
  if (typeof raw !== 'string') return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

interface DatedLaunchRecord {
  readonly record: LaunchRecord;
  readonly file: string;
}

async function launchRecordsOf(paths: HarnessPaths): Promise<DatedLaunchRecord[]> {
  let entries: string[];
  try {
    entries = await readdir(paths.logsDir);
  } catch {
    // Runtime ainda sem logs: ausência de evidência, não evidência de ausência.
    return [];
  }
  const records: DatedLaunchRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.launch.json')) continue;
    const file = path.join(paths.logsDir, entry);
    try {
      records.push({ record: LaunchRecord.parse(JSON.parse(await readFile(file, 'utf8'))), file });
    } catch {
      // Record ilegível não vira fato: seguir sem ele preserva UNKNOWN.
      continue;
    }
  }
  return records.sort((left, right) =>
    right.record.started_at.localeCompare(left.record.started_at),
  );
}

/**
 * Quota a partir da evidência JÁ GRAVADA pelos launches anteriores deste
 * runtime. Nenhum probe novo é executado aqui de propósito: medir quota antes
 * do launch exigiria uma chamada à CLI do provider, e o preço de saber seria
 * exatamente aquilo que o experimento quer medir.
 *
 * Consequência aceita e explícita: quota NUNCA é PROVEN TRUE antes do launch.
 * Ela é PROVEN FALSE quando o provider recusou por limite numa janela que
 * comprovadamente ainda não resetou, e UNKNOWN em todo o resto.
 */
export async function quotaFactOf(input: {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  readonly now?: () => Date;
}): Promise<LaunchFact> {
  const now = (input.now ?? (() => new Date()))().getTime();
  const records = (await launchRecordsOf(input.paths)).filter(
    (entry) => entry.record.profile_id === input.profile.id,
  );
  const observed = records.find((entry) => entry.record.rate_limit_observations !== null);
  if (observed === undefined) {
    return {
      availability: null,
      provenance:
        `nenhuma observação de rate limit para ${input.profile.id} neste runtime; ` +
        'quota não é probada antes do launch porque medi-la custaria uma chamada ao provider',
    };
  }

  const observations = observed.record.rate_limit_observations?.observed ?? [];
  const rejecting = rejectingObservation(observations);
  if (rejecting === undefined) {
    return {
      availability: null,
      provenance:
        `${observed.file}: nenhuma observação de recusa por limite; ` +
        'ausência de recusa não prova quota suficiente para o próximo launch',
    };
  }

  const resetsAt = resetInstantOf(rejecting);
  if (resetsAt === null) {
    return {
      availability: null,
      provenance:
        `${observed.file}: recusa por limite observada, mas o reset da janela não é datável ` +
        'sem adivinhar unidade; a janela pode já ter resetado',
    };
  }
  if (resetsAt <= now) {
    return {
      availability: null,
      provenance:
        `${observed.file}: recusa por limite observada numa janela que já resetou em ` +
        `${new Date(resetsAt).toISOString()}; o reset não prova quota suficiente`,
    };
  }
  return {
    availability: false,
    provenance:
      `${observed.file}: provider recusou por limite e a janela só reseta em ` +
      `${new Date(resetsAt).toISOString()}`,
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
    quota: await quotaFactOf({
      paths,
      profile,
      ...(input.now === undefined ? {} : { now: input.now }),
    }),
    billing_refusal: billing.refusal,
  };
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
