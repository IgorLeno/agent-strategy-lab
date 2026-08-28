/**
 * Seleção de reviewer diante de capacidade FRESCA.
 *
 * O requirement de review grava o profile pinado no candidate. Isso não pode
 * tornar um pool EXHAUSTED num bloqueio permanente: UNKNOWN não exclui, e
 * EXHAUSTED fresco autoriza escolher outro profile já permitido pela policy.
 * Falha de invocação INFRA também exclui o profile (não o pool) e autoriza o
 * próximo da policy; o mesmo profile não é relançado na mesma decisão.
 */
import { CapacityStatus } from '../../src/quota/index.js';

export interface ReviewerCapacitySelection {
  readonly profileId: string | null;
  readonly rerouted: boolean;
  readonly reason: string;
}

export function isRetryableReviewerInvocationFailure(code: string): boolean {
  return code === 'REVIEW_INVOCATION_FAILED';
}

export function selectReviewerProfileForFreshCapacity(input: {
  readonly pinnedProfileId: string;
  readonly policyProfiles: readonly {
    readonly id: string;
    readonly capability_rank: number;
  }[];
  readonly poolOf: (profileId: string) => string | null;
  readonly capacityByPool: ReadonlyMap<string, { readonly status: string }>;
  readonly excludedProfileIds?: readonly string[];
}): ReviewerCapacitySelection {
  const excluded = new Set(input.excludedProfileIds ?? []);
  const exhausted = (profileId: string): boolean => {
    const pool = input.poolOf(profileId);
    if (pool === null) return false;
    return input.capacityByPool.get(pool)?.status === CapacityStatus.EXHAUSTED;
  };
  const ineligible = (profileId: string): boolean => excluded.has(profileId) || exhausted(profileId);

  if (!ineligible(input.pinnedProfileId)) {
    return {
      profileId: input.pinnedProfileId,
      rerouted: false,
      reason: `reviewer pinado ${input.pinnedProfileId} permanece elegível pela observação fresca`,
    };
  }

  const ordered = [...input.policyProfiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  );
  const alternative = ordered.find((entry) => !ineligible(entry.id));
  if (alternative === undefined) {
    const infra = [...excluded].join(', ');
    return {
      profileId: null,
      rerouted: false,
      reason:
        excluded.size > 0
          ? `nenhum reviewer restante na policy: INFRA em [${infra}] e os demais pools estão EXHAUSTED ou também excluídos`
          : `reviewer pinado ${input.pinnedProfileId} está EXHAUSTED e nenhum outro profile ` +
            `da policy tem pool fresco não-EXHAUSTED`,
    };
  }
  return {
    profileId: alternative.id,
    rerouted: true,
    reason: excluded.has(input.pinnedProfileId)
      ? `reviewer pinado ${input.pinnedProfileId} falhou por INFRA; rerroteado para ${alternative.id} dentro da policy autorizada`
      : `reviewer pinado ${input.pinnedProfileId} EXHAUSTED; rerroteado para ${alternative.id} ` +
        `dentro da policy autorizada`,
  };
}
