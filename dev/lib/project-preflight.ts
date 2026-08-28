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
import { buildEnvironment, type LauncherProfile } from './profile.js';
import { LaunchRecord, type PoolCapacityRecord, type RateLimitObservation } from './schemas.js';

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
  /** Snapshot fresco, read-only e já deduplicado pelo assessment atual. */
  readonly capacityObservation?: PoolCapacityObservation | null;
  /** Fallback persistido do mesmo pool; nunca sobrepõe um snapshot fresco bem-sucedido. */
  readonly historicalHeadroom?: QuotaHeadroom;
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
 * FOLGA de quota por provider, a partir da evidência JÁ GRAVADA neste runtime.
 *
 * A fonte é o probe de assinatura que o próprio launch executou — nenhuma
 * chamada nova ao provider acontece aqui, e portanto medir a folga não custa
 * exatamente aquilo que o experimento quer medir. Um provider sem medidor de
 * assinatura permanece `UNKNOWN` COM MOTIVO: ausência de instrumento nunca
 * vira "quota livre" nem "quota esgotada".
 */
export async function quotaHeadroomByPool(
  paths: HarnessPaths,
  quotaPoolOf: (profileId: string) => string | null,
): Promise<Record<string, QuotaHeadroom>> {
  const headroom: Record<string, QuotaHeadroom> = {};
  // `launchRecordsOf` devolve do mais recente para o mais antigo: o primeiro
  // record utilizável de cada POOL é a observação mais nova. Indexar por pool,
  // e não por executável, é o que impede que Codex e OpenCode contra a mesma
  // conta OpenAI apareçam como duas franquias.
  for (const { record, file } of await launchRecordsOf(paths)) {
    const pool = quotaPoolOf(record.profile_id);
    if (pool === null || headroom[pool] !== undefined) continue;

    // Observação normalizada de capacidade, quando o launch a gravou. Ela é a
    // fonte para os pools novos (OpenAI, OpenCode Go, OpenRouter).
    const capacity = record.pool_capacity?.after ?? null;
    if (capacity !== null) {
      const observed = headroomFromCapacity(capacity, file);
      if (observed !== null) {
        headroom[pool] = observed;
        continue;
      }
    }

    // Caminho histórico do Claude, preservado: records antigos só têm
    // `subscription_usage`, e reescrevê-los não é opção.
    const usage = record.subscription_usage;
    if (usage === null || !usage.probe_contract.after.available) continue;
    const used = usage.five_hour.after_used_pct;
    if (used === null || !Number.isFinite(used)) continue;
    headroom[pool] = {
      status: 'OBSERVED',
      remaining_pct: Math.min(100, Math.max(0, 100 - used)),
      provenance: `${file}: subscription_usage.five_hour.after_used_pct=${used}`,
    };
  }
  return headroom;
}

/**
 * Observação normalizada -> folga de routing.
 *
 * Só duas coisas atravessam: uma folga OBSERVADA (a menor entre as janelas —
 * a mais crítica manda) e um esgotamento DECLARADO pelo provider. `UNKNOWN` e
 * `AVAILABLE_WITHOUT_METER` não produzem folga nenhuma: sem medidor não há
 * número, e inventar um faria a comparação entre pools mentir.
 */
export function headroomFromCapacity(
  capacity: NonNullable<PoolCapacityRecord['after']>,
  file: string,
): QuotaHeadroom | null {
  if (capacity.status === CapacityStatus.EXHAUSTED) {
    return {
      status: 'EXHAUSTED',
      provenance: `${file}: provider declarou esgotamento — ${capacity.reason} (${capacity.source})`,
    };
  }
  if (capacity.status !== CapacityStatus.KNOWN) return null;

  // O snapshot é lido como record gravado (passthrough), então as janelas são
  // conferidas em vez de presumidas: um record de uma versão futura do contrato
  // continua legível, e um campo ausente vira "sem folga observável".
  const windows = Array.isArray(capacity['windows']) ? (capacity['windows'] as unknown[]) : [];
  const remainders = windows
    .map((window) =>
      typeof window === 'object' && window !== null
        ? (window as Record<string, unknown>)['remaining_percent']
        : null,
    )
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (remainders.length === 0) return null;
  // A janela mais apertada é a que manda: janelas distintas nunca são somadas
  // nem promediadas, porque têm denominadores e políticas diferentes.
  const remaining = Math.min(...remainders);
  return {
    status: 'OBSERVED',
    remaining_pct: Math.min(100, Math.max(0, remaining)),
    provenance: `${file}: pool_capacity.after menor folga observada=${remaining}% (${capacity.source})`,
  };
}

/**
 * Combina capacidade atual e histórica sem transformar falha instrumental em
 * consumo. Um probe fresco bem-sucedido é autoritativo para este assessment;
 * somente UNKNOWN permite recorrer ao último fato persistido.
 */
export function effectiveQuotaHeadroom(
  fresh: PoolCapacityObservation | null | undefined,
  historical: QuotaHeadroom | undefined,
): QuotaHeadroom {
  if (fresh === undefined || fresh === null) {
    return historical ?? {
      status: 'UNKNOWN',
      reason: 'nenhuma observação fresca ou histórica de capacidade para este pool',
    };
  }
  if (fresh.status === CapacityStatus.UNKNOWN) {
    if (historical !== undefined) {
      return historical.status === 'UNKNOWN'
        ? {
            status: 'UNKNOWN',
            reason: `${fresh.reason} (${fresh.source}); fallback histórico também UNKNOWN: ${historical.reason}`,
          }
        : {
            ...historical,
            provenance: `${fresh.reason} (${fresh.source}); fallback histórico: ${historical.provenance}`,
          };
    }
    return {
      status: 'UNKNOWN',
      reason: `${fresh.reason} (${fresh.source})`,
    };
  }

  const current = headroomFromCapacity(fresh, `observação fresca ${fresh.observed_at}`);
  return current ?? {
    status: 'UNKNOWN',
    reason:
      `observação fresca bem-sucedida sem percentual comparável: ` +
      `${fresh.status} — ${fresh.reason} (${fresh.source})`,
  };
}

export function effectiveQuotaHeadroomByPool(
  historical: Readonly<Record<string, QuotaHeadroom>>,
  fresh: ReadonlyMap<string, PoolCapacityObservation>,
): Record<string, QuotaHeadroom> {
  const effective: Record<string, QuotaHeadroom> = { ...historical };
  for (const [pool, observation] of fresh) {
    effective[pool] = effectiveQuotaHeadroom(observation, historical[pool]);
  }
  return effective;
}

/**
 * Quota do pool no instante do assessment. Os endpoints de capacidade atuais
 * são read-only e não fazem inferência, portanto o ciclo de produção fornece
 * `capacityObservation` sempre que o pool possui instrumento autorizado.
 * História permanece fallback honesto para falha de probe; não é cache atual.
 */
export async function quotaFactOf(input: {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  readonly now?: () => Date;
  readonly capacityObservation?: PoolCapacityObservation | null;
  readonly historicalHeadroom?: QuotaHeadroom;
}): Promise<LaunchFact> {
  if (input.capacityObservation !== undefined && input.capacityObservation !== null) {
    const fresh = input.capacityObservation;
    if (fresh.status === CapacityStatus.EXHAUSTED) {
      return {
        availability: false,
        provenance: `observação fresca do pool ${fresh.quota_pool}: ${fresh.reason} (${fresh.source})`,
      };
    }
    if (fresh.status !== CapacityStatus.UNKNOWN) {
      return {
        availability: true,
        provenance:
          `observação fresca do pool ${fresh.quota_pool}: ${fresh.status}; ` +
          `${fresh.reason} (${fresh.source})`,
      };
    }
    if (input.historicalHeadroom?.status === 'EXHAUSTED') {
      return {
        availability: false,
        provenance:
          `probe fresco UNKNOWN: ${fresh.reason} (${fresh.source}); ` +
          `fallback histórico: ${input.historicalHeadroom.provenance}`,
      };
    }
    if (input.historicalHeadroom?.status === 'OBSERVED') {
      return {
        availability: true,
        provenance:
          `probe fresco UNKNOWN: ${fresh.reason} (${fresh.source}); ` +
          `fallback histórico: ${input.historicalHeadroom.provenance}`,
      };
    }
    return {
      availability: null,
      provenance: `probe fresco UNKNOWN: ${fresh.reason} (${fresh.source})`,
    };
  }

  if (input.historicalHeadroom?.status === 'EXHAUSTED') {
    return { availability: false, provenance: input.historicalHeadroom.provenance };
  }
  if (input.historicalHeadroom?.status === 'OBSERVED') {
    return { availability: true, provenance: input.historicalHeadroom.provenance };
  }

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
        'nenhuma observação fresca de capacidade foi fornecida a esta coleta isolada',
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
    quota: await quotaFactOf({
      paths,
      profile,
      ...(input.capacityObservation === undefined
        ? {}
        : { capacityObservation: input.capacityObservation }),
      ...(input.historicalHeadroom === undefined
        ? {}
        : { historicalHeadroom: input.historicalHeadroom }),
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
