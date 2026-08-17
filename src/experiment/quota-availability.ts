/**
 * Consumidor explícito de `ExperimentBillingPolicy.quota_stop_threshold_pct`
 * (M69) — fecha a lacuna documentada em `docs/reviews/M2-REVIEW.md` §3:
 * `quota_stop_threshold_pct` era política congelada como dado, sem nenhum
 * código do produto lendo `QuotaUsage.windows` e comparando contra o
 * threshold.
 *
 * A medição (`QuotaUsage`, M44/M59) continua no adapter; a decisão
 * ALLOW/BLOCK continua inteiramente em `decideExecutionAuthorization`
 * (`billing/guard.ts`, provider-neutral, inalterado por esta tarefa). Este
 * módulo só deriva `quota.availability` a partir de `QuotaUsage` + política
 * congelada no `ExperimentSpec` — a ponte que faltava, nada mais.
 *
 * Ausência de `QuotaUsage`, `observation.status === UNAVAILABLE` e janela
 * incomparável permanecem `null` — nunca viram 0% nem `SUFFICIENT` por
 * omissão. Janelas de `window_id` distintos nunca são somadas: o threshold é
 * comparado contra o snapshot mais atual de CADA janela individualmente
 * (nunca `consumed_pp`, que é delta, não snapshot).
 */
import {
  type Evidence,
  type QuotaAvailability,
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
}

/**
 * `QuotaUsage` + `ExperimentBillingPolicy` → evidência de quota do
 * experimento. Não consulta provider nem decide ALLOW/BLOCK.
 *
 * - `usage` ausente (`null`/`undefined`) ou `UNAVAILABLE` → `null`.
 * - Nenhuma janela comparável (todas incompatíveis/incomparáveis) → `null`.
 * - Usado_pct da janela decisiva < threshold → `SUFFICIENT`.
 * - Usado_pct da janela decisiva >= threshold → `INSUFFICIENT` (igual conta
 *   como acima, nunca como ainda suficiente).
 */
export function deriveQuotaAvailability(
  usage: QuotaUsage | null | undefined,
  policy: ExperimentBillingPolicy,
): DerivedQuotaAvailability {
  if (usage == null) return absent(USAGE_ABSENT_PROVENANCE);

  if (usage.observation.status === QuotaObservationStatus.UNAVAILABLE) {
    return absent(usage.observation.provenance);
  }

  return fromObservedWindows(usage, policy);
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

  // Janelas distintas nunca são somadas: a decisão usa a mais crítica
  // (maior uso), cada uma comparada isoladamente contra o mesmo threshold.
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
 * Snapshot relevante de uma janela — nunca `consumed_pp` (delta entre
 * before/after, não estado da janela). `after_used_pct` é o snapshot mais
 * recente da própria janela; `before_used_pct` só serve quando não há
 * `after` e a janela não trocou de instância (`same_window !== false`) —
 * usar o `before` de uma instância anterior descartada seria comparar contra
 * uma janela incompatível.
 */
function relevantUsedPct(quotaWindow: QuotaWindow): ComparedWindow | null {
  if (isFiniteNumber(quotaWindow.after_used_pct)) {
    return { window_id: quotaWindow.window_id, used_pct: quotaWindow.after_used_pct };
  }
  if (quotaWindow.same_window === false) return null;
  if (isFiniteNumber(quotaWindow.before_used_pct)) {
    return { window_id: quotaWindow.window_id, used_pct: quotaWindow.before_used_pct };
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
