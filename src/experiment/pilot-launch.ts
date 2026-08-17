/**
 * Caminho oficial do piloto real Claude Sonnet 5 Medium vs High (M70).
 *
 * `runExperimentSchedule` (`runner.ts`) permanece genérico: `observeQuota`
 * continua opcional para o scheduler, e fixtures nunca precisam dele. Este
 * módulo é a camada que o piloto real não pode contornar — a Claude quota
 * probe (`adapters/claude/quota.ts`) é dependência obrigatória (nunca
 * opcional aqui), o adapter Claude REAL_INFERENCE é o único executor ligado,
 * e autorização humana nunca é fabricada quando ausente.
 *
 * Ordem de cada launch, inclusive todo retry:
 *   authorizeSlot (evidência humana, sem fabricar AUTHORIZED)
 *   → probeClaudeQuota (nova probe a cada launch)
 *   → deriveQuotaAvailability (política congelada do ExperimentSpec)
 *   → BillingGuard (`decideExecutionAuthorization`)
 *   → ALLOW → executeSlot
 *   INSUFFICIENT/BLOCK → executeSlot nunca é chamado.
 *
 * A existência deste caminho NÃO autoriza o piloto: `inspectOfficialPilot` é
 * o único ponto que não observa quota de provider nem autoriza inferência
 * (`authorizes_real_inference: false`), e `runOfficialPilot` exige que quem
 * chama passe `humanAuthorization` explicitamente — sem ele a guard bloqueia
 * com `AUTHORIZATION_UNKNOWN` antes de qualquer spawn.
 */
import {
  CLAUDE_ADAPTER_IDENTITY,
  probeClaudeQuota,
  resolveAdapter,
  type ClaudeQuotaCommandRunner,
  type ClaudeQuotaProbeOutcome,
  type ClaudeQuotaWindowReading,
  type ProbeClaudeQuotaOptions,
  type ProviderAdapter,
} from '../adapters/index.js';
import {
  decideExecutionAuthorization,
  type BillingGuardDecision,
  type QuotaAvailability,
  type RealExecutionAuthorization,
} from '../billing/index.js';
import type { ExecutionStatus } from '../core/enums.js';
import {
  QuotaObservationStatus,
  QuotaReasonCode,
  QuotaUsage,
  type QuotaWindow,
} from '../schemas/index.js';
import { deriveQuotaAvailability } from './quota-availability.js';
import { buildPilotExperimentSpec } from './pilot.js';
import {
  materializeSlotOrder,
  runExperimentSchedule,
  type PlannedSlot,
  type RunExperimentScheduleResult,
} from './runner.js';
import type { FrozenExperimentSpec } from './index.js';

export const OFFICIAL_PILOT_QUOTA_OBSERVER = 'claude_quota_probe' as const;

export interface OfficialPilotQuotaObservation {
  readonly slot: PlannedSlot;
  readonly usage: QuotaUsage;
  readonly availability: QuotaAvailability | null;
}

export interface OfficialPilotBindings {
  readonly adapter: ProviderAdapter;
  readonly authorizeSlot: (slot: PlannedSlot) => BillingGuardDecision;
  readonly observeQuota: (slot: PlannedSlot) => Promise<QuotaUsage>;
  readonly observeQuotaKind: typeof OFFICIAL_PILOT_QUOTA_OBSERVER;
}

export interface RunOfficialPilotOptions {
  readonly frozen: FrozenExperimentSpec;
  /**
   * Evidência humana explícita. Ausência não vira AUTHORIZED — a guarda
   * bloqueia com AUTHORIZATION_UNKNOWN antes de qualquer spawn.
   */
  readonly humanAuthorization?: RealExecutionAuthorization;
  /** Sempre a Claude quota probe; testes injetam `runner` fake, nunca a CLI real. */
  readonly quotaProbe: ProbeClaudeQuotaOptions;
  /** Caminho de execução existente (prepareRun/executeRun). Só corre após ALLOW. */
  readonly executeSlot: (slot: PlannedSlot) => Promise<ExecutionStatus> | ExecutionStatus;
  readonly maxRetriesPerSlot?: number;
}

export interface RunOfficialPilotResult extends RunExperimentScheduleResult {
  readonly adapterName: typeof CLAUDE_ADAPTER_IDENTITY.name;
  readonly executionKind: 'REAL_INFERENCE';
  readonly humanAuthorizationProvided: boolean;
  readonly observeQuotaKind: typeof OFFICIAL_PILOT_QUOTA_OBSERVER;
  readonly quotaObservations: readonly OfficialPilotQuotaObservation[];
}

export interface OfficialPilotInspection {
  readonly spec_id: string;
  readonly hash: string;
  readonly planned_slot_count: number;
  readonly quota_stop_threshold_pct: number;
  readonly arm_ids: readonly string[];
  readonly slot_ids: readonly string[];
  readonly adapter_name: typeof CLAUDE_ADAPTER_IDENTITY.name;
  readonly execution_kind: 'REAL_INFERENCE';
  readonly observe_quota: typeof OFFICIAL_PILOT_QUOTA_OBSERVER;
  readonly authorizes_real_inference: false;
}

/**
 * Snapshot pré-launch: `before_used_pct` é a leitura corrente; `after`
 * permanece ausente porque o probe roda antes do launch, não depois.
 * UNAVAILABLE e leitura nula nunca viram 0% nem SUFFICIENT implícito.
 */
export function quotaUsageFromClaudePreLaunchProbe(outcome: ClaudeQuotaProbeOutcome): QuotaUsage {
  if (outcome.status === QuotaObservationStatus.UNAVAILABLE || outcome.reading === null) {
    return unavailableUsage(outcome.provenance);
  }
  return QuotaUsage.parse({
    provider: 'claude',
    observation: {
      status: QuotaObservationStatus.OBSERVED,
      reason_code: QuotaReasonCode.OK,
      provenance: outcome.provenance,
    },
    windows: [
      preLaunchWindow('five_hour', outcome.reading.five_hour, outcome.provenance),
      preLaunchWindow('seven_day_all_models', outcome.reading.seven_day_all_models, outcome.provenance),
    ],
  });
}

/** Observer obrigatório do piloto: uma probe Claude nova a cada launch, inclusive retry. */
export function createClaudePilotQuotaObserver(
  options: ProbeClaudeQuotaOptions,
): (slot: PlannedSlot) => Promise<QuotaUsage> {
  return async () => {
    const outcome = await probeClaudeQuota(options);
    return quotaUsageFromClaudePreLaunchProbe(outcome);
  };
}

/** Confere que todos os arms resolvem o adapter Claude REAL_INFERENCE antes de ligar o executor. */
export function bindClaudePilotExecutor(frozen: FrozenExperimentSpec): ProviderAdapter {
  for (const arm of frozen.spec.arms) {
    const adapter = resolveAdapter(arm.agent_profile.cli);
    if (adapter.identity.name !== CLAUDE_ADAPTER_IDENTITY.name) {
      throw new Error(
        `caminho oficial do piloto exige adapter Claude; arm "${arm.id}" usa cli "${arm.agent_profile.cli}"`,
      );
    }
    if (adapter.executionKind !== 'REAL_INFERENCE') {
      throw new Error(`caminho oficial do piloto exige REAL_INFERENCE; arm "${arm.id}" não qualifica`);
    }
  }
  return resolveAdapter(CLAUDE_ADAPTER_IDENTITY.name);
}

/**
 * Monta as dependências oficiais do piloto. `observeQuota` não é omitível
 * neste caminho — só o scheduler genérico continua aceitando ausência.
 */
export function bindOfficialPilotDependencies(options: {
  readonly frozen: FrozenExperimentSpec;
  readonly humanAuthorization?: RealExecutionAuthorization;
  readonly quotaProbe: ProbeClaudeQuotaOptions;
}): OfficialPilotBindings {
  const adapter = bindClaudePilotExecutor(options.frozen);
  return {
    adapter,
    authorizeSlot: () => decideExecutionAuthorization('REAL_INFERENCE', options.humanAuthorization),
    observeQuota: createClaudePilotQuotaObserver(options.quotaProbe),
    observeQuotaKind: OFFICIAL_PILOT_QUOTA_OBSERVER,
  };
}

/**
 * Inspeção/preflight do piloto: lê o spec congelado e liga o adapter Claude,
 * mas NÃO autoriza inferência real, NÃO observa quota de provider e NÃO
 * executa nenhum slot — `authorizes_real_inference` é sempre `false`.
 */
export async function inspectOfficialPilot(repoRoot: string): Promise<OfficialPilotInspection> {
  const frozen = await buildPilotExperimentSpec(repoRoot);
  const adapter = bindClaudePilotExecutor(frozen);
  return {
    spec_id: frozen.spec.id,
    hash: frozen.hash,
    planned_slot_count: frozen.spec.planned_slot_count,
    quota_stop_threshold_pct: frozen.spec.billing_policy.quota_stop_threshold_pct,
    arm_ids: frozen.spec.arms.map((arm) => arm.id),
    slot_ids: materializeSlotOrder(frozen).map((slot) => slot.slot_id),
    adapter_name: CLAUDE_ADAPTER_IDENTITY.name,
    execution_kind: 'REAL_INFERENCE',
    observe_quota: OFFICIAL_PILOT_QUOTA_OBSERVER,
    authorizes_real_inference: false,
  };
}

/**
 * Agenda oficial do piloto real: sempre injeta a Claude quota probe fresca
 * antes de cada launch (inclusive retries) e nunca fabrica autorização
 * humana. `executeSlot` só corre depois de ALLOW.
 */
export async function runOfficialPilot(options: RunOfficialPilotOptions): Promise<RunOfficialPilotResult> {
  const bindings = bindOfficialPilotDependencies({
    frozen: options.frozen,
    quotaProbe: options.quotaProbe,
    ...(options.humanAuthorization === undefined ? {} : { humanAuthorization: options.humanAuthorization }),
  });
  const quotaObservations: OfficialPilotQuotaObservation[] = [];
  const policy = options.frozen.spec.billing_policy;

  const result = await runExperimentSchedule({
    frozen: options.frozen,
    executeSlot: options.executeSlot,
    authorizeSlot: bindings.authorizeSlot,
    observeQuota: async (slot) => {
      const usage = await bindings.observeQuota(slot);
      const derived = deriveQuotaAvailability(usage, policy);
      quotaObservations.push({ slot, usage, availability: derived.availability.value });
      return usage;
    },
    ...(options.maxRetriesPerSlot === undefined ? {} : { maxRetriesPerSlot: options.maxRetriesPerSlot }),
  });

  return {
    ...result,
    adapterName: CLAUDE_ADAPTER_IDENTITY.name,
    executionKind: 'REAL_INFERENCE',
    humanAuthorizationProvided: options.humanAuthorization !== undefined,
    observeQuotaKind: OFFICIAL_PILOT_QUOTA_OBSERVER,
    quotaObservations,
  };
}

export type { ClaudeQuotaCommandRunner, ProbeClaudeQuotaOptions };

function unavailableUsage(provenance: string): QuotaUsage {
  return QuotaUsage.parse({
    provider: 'claude',
    observation: {
      status: QuotaObservationStatus.UNAVAILABLE,
      reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
      provenance,
    },
    windows: [],
  });
}

function preLaunchWindow(
  windowId: string,
  reading: ClaudeQuotaWindowReading,
  provenance: string,
): QuotaWindow {
  return {
    window_id: windowId,
    before_used_pct: reading.used_pct,
    after_used_pct: null,
    consumed_pp: null,
    same_window: true,
    reason_code: QuotaReasonCode.OK,
    provenance,
  };
}
