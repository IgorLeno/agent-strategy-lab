/**
 * Consumidor explícito de `ExperimentBillingPolicy.quota_stop_threshold_pct`.
 *
 * A medição (`QuotaUsage`) continua no adapter; a decisão ALLOW/BLOCK continua
 * em `decideExecutionAuthorization`. Esta camada só deriva a evidência
 * `quota.availability` a partir da política congelada no `ExperimentSpec`.
 *
 * Ausência, `UNAVAILABLE` e janela incomparável permanecem `null` — nunca
 * viram 0%. Janelas de `window_id` distintos nunca são somadas.
 */
import {
  decideExecutionAuthorization,
  type Evidence,
  type ExecutionKind,
  type QuotaAvailability,
  type RealExecutionAuthorization,
  type BillingGuardDecision,
} from '../billing/index.js';
import {
  QuotaObservationStatus,
  type ExperimentBillingPolicy,
  type QuotaUsage,
  type QuotaWindow,
} from '../schemas/index.js';

const USAGE_ABSENT_PROVENANCE = 'experiment_quota_policy:usage_absent';

export interface DerivedQuotaAvailability {
  readonly availability: Evidence<QuotaAvailability>;
  readonly remaining: Evidence<number>;
  readonly unit: string | null;
}

interface ComparedWindow {
  readonly window_id: string;
  readonly used_pct: number;
  readonly field: 'after_used_pct' | 'before_used_pct';
}

/**
 * `QuotaUsage` + política experimental → evidência de quota. Não consulta
 * provider, não decide ALLOW/BLOCK e não reescreve o kernel da guarda.
 */
export function deriveQuotaAvailability(
  usage: QuotaUsage | null | undefined,
  policy: ExperimentBillingPolicy,
): DerivedQuotaAvailability {
  if (usage == null) return absent(USAGE_ABSENT_PROVENANCE);

  switch (usage.observation.status) {
    case QuotaObservationStatus.UNAVAILABLE:
      return absent(usage.observation.provenance);
    case QuotaObservationStatus.OBSERVED:
      return fromObservedWindows(usage, policy);
    default: {
      const _exhaustive: never = usage.observation.status;
      return _exhaustive;
    }
  }
}

/** Substitui `evidence.quota` pela derivação; o restante da evidência permanece. */
export function withDerivedExperimentQuota(
  evidence: RealExecutionAuthorization,
  usage: QuotaUsage | null | undefined,
  policy: ExperimentBillingPolicy,
): RealExecutionAuthorization {
  const derived = deriveQuotaAvailability(usage, policy);
  return {
    ...evidence,
    quota: {
      availability: derived.availability,
      remaining: derived.remaining,
      unit: derived.unit,
    },
  };
}

/**
 * Caminho que alimenta a guarda: deriva availability e só então chama
 * `decideExecutionAuthorization`.
 */
export function decideExperimentSlotAuthorization(
  executionKind: ExecutionKind,
  evidence: RealExecutionAuthorization,
  usage: QuotaUsage | null | undefined,
  policy: ExperimentBillingPolicy,
): BillingGuardDecision {
  return decideExecutionAuthorization(
    executionKind,
    withDerivedExperimentQuota(evidence, usage, policy),
  );
}

function fromObservedWindows(
  usage: QuotaUsage,
  policy: ExperimentBillingPolicy,
): DerivedQuotaAvailability {
  const compared: ComparedWindow[] = [];
  for (const quotaWindow of usage.windows) {
    const relevant = relevantUsedPct(quotaWindow);
    if (relevant !== null) compared.push(relevant);
  }
  if (compared.length === 0) return absent(usage.observation.provenance);

  const decidingUsedPct = Math.max(...compared.map((entry) => entry.used_pct));
  const insufficient = decidingUsedPct >= policy.quota_stop_threshold_pct;
  const provenance = JSON.stringify({
    source: 'experiment_quota_policy',
    threshold_pct: policy.quota_stop_threshold_pct,
    observation_provenance: usage.observation.provenance,
    compared_windows: compared,
    deciding_used_pct: decidingUsedPct,
  });

  return {
    availability: {
      value: insufficient ? 'INSUFFICIENT' : 'SUFFICIENT',
      provenance,
    },
    remaining: {
      value: Number(Math.max(0, 100 - decidingUsedPct).toFixed(6)),
      provenance,
    },
    unit: 'percent',
  };
}

/**
 * Utilização corrente de uma janela. `after_used_pct` é o snapshot mais
 * recente; `before_used_pct` só vale quando a instância da janela é a mesma
 * (pre-launch ou after ausente). `same_window === false` descarta o before
 * da instância anterior e nunca usa `consumed_pp`.
 */
function relevantUsedPct(quotaWindow: QuotaWindow): ComparedWindow | null {
  if (isFiniteNumber(quotaWindow.after_used_pct)) {
    return {
      window_id: quotaWindow.window_id,
      used_pct: quotaWindow.after_used_pct,
      field: 'after_used_pct',
    };
  }
  if (quotaWindow.same_window === false) return null;
  if (isFiniteNumber(quotaWindow.before_used_pct)) {
    return {
      window_id: quotaWindow.window_id,
      used_pct: quotaWindow.before_used_pct,
      field: 'before_used_pct',
    };
  }
  return null;
}

function absent(provenance: string): DerivedQuotaAvailability {
  return {
    availability: { value: null, provenance },
    remaining: { value: null, provenance },
    unit: null,
  };
}

function isFiniteNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value);
}
