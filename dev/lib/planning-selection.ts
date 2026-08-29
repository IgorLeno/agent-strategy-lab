/**
 * Seleção de PAPEL para PLANNING. Não é o router de implementação.
 *
 * IMPLEMENTATION escolhe capacidade suficiente, histórico, quota, custo e
 * evidência. PLANNING escolhe qualidade/capacidade primeiro: um erro aqui
 * contamina todas as work units seguintes. Custo é secundário.
 *
 * Esta preferência NÃO é autorização. Fora da profile_policy da run, o
 * profile não entra — nem como cold-start, nem como failover.
 */
import type {
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  PlanningWorkerPort,
} from '../../src/planner/draft.js';
import type { CapabilityTier } from '../../src/routing/index.js';

/** Cold-start declarado. História comparável de planning é FUTURO, não política atual. */
export const PLANNING_COLD_START_TOP_TIER_PROFILE_IDS = [
  'claude-build-worker-subscription-opus5-high-v3',
  'codex-build-worker-subscription-sol-high-v2',
] as const;

export type PlanningColdStartProfileId =
  (typeof PLANNING_COLD_START_TOP_TIER_PROFILE_IDS)[number];

const TIER_STRENGTH: Readonly<Record<CapabilityTier, number>> = {
  economy: 0,
  intermediate: 1,
  advanced: 2,
};

export interface PlanningProfileSnapshot {
  readonly id: string;
  readonly agent: 'claude' | 'codex' | 'opencode' | 'fake';
  readonly declared_provider: string | null;
  readonly billing_mode: string;
  readonly capability_rank: number;
  readonly capability_tier: CapabilityTier | null;
  /**
   * `true` provado, `false` provado incompatível, `null` UNKNOWN.
   * UNKNOWN não afirma capacidade de planning.
   */
  readonly planner_compatible: boolean | null;
  /** `true` provado, `false` recusado, `null` UNKNOWN — UNKNOWN bloqueia. */
  readonly credential_available: boolean | null;
  /** `true` disponível, `false` EXHAUSTED, `null` UNKNOWN — UNKNOWN NÃO bloqueia. */
  readonly quota_available: boolean | null;
}

export interface PlanningPolicyContext {
  readonly allowed_providers: readonly string[];
  readonly allowed_billing_modes: readonly string[];
  readonly policy_profile_ids: readonly string[];
}

export type PlanningSelectionOutcome =
  | {
      readonly outcome: 'SELECTED';
      readonly profile_id: string;
      readonly ranked_profile_ids: readonly string[];
      readonly reason: string;
    }
  | {
      readonly outcome: 'EXPLICIT_NOT_IN_POLICY';
      readonly profile_id: string;
      readonly reason: string;
    }
  | {
      readonly outcome: 'EXPLICIT_INELIGIBLE';
      readonly profile_id: string;
      readonly reason: string;
    }
  | {
      readonly outcome: 'NONE_ELIGIBLE';
      readonly reason: string;
    };

export function coldStartRank(profileId: string): number | null {
  const index = (PLANNING_COLD_START_TOP_TIER_PROFILE_IDS as readonly string[]).indexOf(
    profileId,
  );
  return index === -1 ? null : index;
}

export function planningIneligibilityReason(
  snapshot: PlanningProfileSnapshot,
  policy: PlanningPolicyContext,
): string | null {
  if (!policy.policy_profile_ids.includes(snapshot.id)) {
    return `profile ${snapshot.id} não pertence à profile_policy da run`;
  }
  if (!policy.allowed_providers.includes(snapshot.agent)) {
    return `provider ${snapshot.agent} fora da profile policy autorizada`;
  }
  if (!policy.allowed_billing_modes.includes(snapshot.billing_mode)) {
    return `billing_mode ${snapshot.billing_mode} fora da autorização da run`;
  }
  if (snapshot.planner_compatible !== true) {
    return snapshot.planner_compatible === false
      ? `profile ${snapshot.id} não é planner-compatible`
      : `planner compatibility de ${snapshot.id} UNKNOWN: não afirmar capacidade que não foi provada`;
  }
  if (snapshot.credential_available !== true) {
    return snapshot.credential_available === false
      ? `credencial de ${snapshot.id} recusada`
      : `credencial de ${snapshot.id} UNKNOWN: credencial desconhecida bloqueia`;
  }
  if (snapshot.quota_available === false) {
    return `quota atual de ${snapshot.id} é EXHAUSTED`;
  }
  return null;
}

export function isPlanningEligible(
  snapshot: PlanningProfileSnapshot,
  policy: PlanningPolicyContext,
): boolean {
  return planningIneligibilityReason(snapshot, policy) === null;
}

/**
 * Ordem de PLANNING: menor retorno = mais preferido. Ordem total:
 *
 * 1. cold-start top-tier (Opus, depois Sol);
 * 2. capability_tier (advanced > intermediate > economy) — prior, não verdade;
 * 3. capability_rank da policy, DESC (degrau mais capaz primeiro);
 * 4. profile_id, determinístico e auditável.
 *
 * História comparável de planning é FUTURO: não governa produção até existir
 * evidência canônica. GLM/Qwen/Kimi/MiniMax/DeepSeek Pro não recebem ordem
 * inventada entre si.
 */
export function comparePlanningPreference(
  left: PlanningProfileSnapshot,
  right: PlanningProfileSnapshot,
): number {
  const leftCold = coldStartRank(left.id);
  const rightCold = coldStartRank(right.id);
  if (leftCold !== null || rightCold !== null) {
    if (leftCold === null) return 1;
    if (rightCold === null) return -1;
    if (leftCold !== rightCold) return leftCold - rightCold;
  }

  const leftTier = left.capability_tier === null ? -1 : TIER_STRENGTH[left.capability_tier];
  const rightTier = right.capability_tier === null ? -1 : TIER_STRENGTH[right.capability_tier];
  if (leftTier !== rightTier) return rightTier - leftTier;

  if (left.capability_rank !== right.capability_rank) {
    return right.capability_rank - left.capability_rank;
  }
  return left.id.localeCompare(right.id);
}

export function rankPlanningCandidates(
  candidates: readonly PlanningProfileSnapshot[],
): PlanningProfileSnapshot[] {
  return [...candidates].sort((left, right) => comparePlanningPreference(left, right));
}

export function selectPlanningProfile(input: {
  readonly snapshots: readonly PlanningProfileSnapshot[];
  readonly policy: PlanningPolicyContext;
  readonly requested_profile_id?: string;
}): PlanningSelectionOutcome {
  const byId = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));

  if (input.requested_profile_id !== undefined) {
    const requested = input.requested_profile_id;
    if (!input.policy.policy_profile_ids.includes(requested)) {
      return {
        outcome: 'EXPLICIT_NOT_IN_POLICY',
        profile_id: requested,
        reason:
          `--planner-profile ${requested} não pertence à profile policy da run; ` +
          'o pedido explícito não foi substituído em silêncio.',
      };
    }
    const snapshot = byId.get(requested);
    const reason =
      snapshot === undefined
        ? `planner profile ${requested} recusado: profile ilegível ou ausente do catálogo`
        : planningIneligibilityReason(snapshot, input.policy);
    if (reason !== null) {
      return {
        outcome: 'EXPLICIT_INELIGIBLE',
        profile_id: requested,
        reason: `--planner-profile ${requested} foi respeitado e recusado: ${reason}`,
      };
    }
    return {
      outcome: 'SELECTED',
      profile_id: requested,
      ranked_profile_ids: [requested],
      reason: `--planner-profile ${requested} autorizado e elegível; failover automático desligado porque o pedido é explícito`,
    };
  }

  const eligible = input.snapshots.filter((snapshot) => isPlanningEligible(snapshot, input.policy));
  if (eligible.length === 0) {
    return {
      outcome: 'NONE_ELIGIBLE',
      reason:
        'nenhum profile da policy é elegível para PLANNING ' +
        '(autorização, provider, billing, planner-compatible, credencial, quota ≠ EXHAUSTED)',
    };
  }

  const ranked = rankPlanningCandidates(eligible);
  const first = ranked[0];
  if (first === undefined) {
    return { outcome: 'NONE_ELIGIBLE', reason: 'nenhum profile elegível para o planner.' };
  }
  return {
    outcome: 'SELECTED',
    profile_id: first.id,
    ranked_profile_ids: ranked.map((entry) => entry.id),
    reason: planningSelectionReason(first, ranked),
  };
}

function planningSelectionReason(
  selected: PlanningProfileSnapshot,
  ranked: readonly PlanningProfileSnapshot[],
): string {
  const cold = coldStartRank(selected.id);
  const fallback = ranked
    .slice(1)
    .map((entry) => entry.id)
    .join(', ');
  const coldLabel =
    cold === 0
      ? 'cold-start top-tier Opus'
      : cold === 1
        ? 'cold-start top-tier Sol'
        : selected.capability_tier === null
          ? 'capacidade declarada na policy'
          : `prior de capacidade ${selected.capability_tier}`;
  return fallback.length === 0
    ? `planner ${selected.id} (${coldLabel})`
    : `planner ${selected.id} (${coldLabel}); failover: ${fallback}`;
}

const RETRYABLE_PLANNING_FAILURE_CODES = new Set([
  'PROVIDER_INVOCATION_FAILED',
  'PROVIDER_TERMINAL_FAILURE',
  'TRANSPORT_MALFORMED',
  'PLANNING_QUOTA_EXHAUSTED',
  'DELIBERATION_QUOTA_EXHAUSTED',
]);

export function isRetryablePlanningInvocationFailure(code: string): boolean {
  return RETRYABLE_PLANNING_FAILURE_CODES.has(code);
}

/**
 * Porta que tenta o próximo profile elegível quando a invocação corrente
 * falha por INFRA ou quota EXHAUSTED. Conteúdo inválido do draft não
 * dispara failover: isso é do planner, não da plataforma.
 */
export function createPlanningFailoverPort(input: {
  readonly ranked_profile_ids: readonly string[];
  readonly invokeWith: (
    profileId: string,
    invocation: PlanningWorkerInvocation,
  ) => Promise<PlanningWorkerInvocationResult>;
}): PlanningWorkerPort {
  return {
    async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
      let last: PlanningWorkerInvocationResult | null = null;
      for (const profileId of input.ranked_profile_ids) {
        const result = await input.invokeWith(profileId, invocation);
        last = result;
        if (result.outcome !== 'INVOCATION_FAILED') return result;
        if (!isRetryablePlanningInvocationFailure(result.failure.code)) {
          return result;
        }
      }
      return (
        last ?? {
          outcome: 'INVOCATION_FAILED',
          invocation_id: 'planning-failover',
          provider_id: 'none',
          model: 'none',
          failure: {
            code: 'NO_PLANNER_ELIGIBLE',
            message: 'nenhum planner restante na policy após failover de INFRA/quota',
            retryable: false,
          },
        }
      );
    },
  };
}
