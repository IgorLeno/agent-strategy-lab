/**
 * Seleção de reviewer diante de capacidade FRESCA.
 *
 * O requirement de review grava o profile pinado no candidate. Isso não pode
 * tornar um pool EXHAUSTED num bloqueio permanente: UNKNOWN não exclui, e
 * EXHAUSTED fresco autoriza escolher outro profile já permitido pela policy.
 */
import { CapacityStatus } from '../../src/quota/index.js';

export interface ReviewerCapacitySelection {
  readonly profileId: string | null;
  readonly rerouted: boolean;
  readonly reason: string;
}

export function selectReviewerProfileForFreshCapacity(input: {
  readonly pinnedProfileId: string;
  readonly policyProfiles: readonly {
    readonly id: string;
    readonly capability_rank: number;
  }[];
  readonly poolOf: (profileId: string) => string | null;
  readonly capacityByPool: ReadonlyMap<string, { readonly status: string }>;
}): ReviewerCapacitySelection {
  const exhausted = (profileId: string): boolean => {
    const pool = input.poolOf(profileId);
    if (pool === null) return false;
    return input.capacityByPool.get(pool)?.status === CapacityStatus.EXHAUSTED;
  };

  if (!exhausted(input.pinnedProfileId)) {
    return {
      profileId: input.pinnedProfileId,
      rerouted: false,
      reason: `reviewer pinado ${input.pinnedProfileId} permanece elegível pela observação fresca`,
    };
  }

  const ordered = [...input.policyProfiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  );
  const alternative = ordered.find((entry) => !exhausted(entry.id));
  if (alternative === undefined) {
    return {
      profileId: null,
      rerouted: false,
      reason:
        `reviewer pinado ${input.pinnedProfileId} está EXHAUSTED e nenhum outro profile ` +
        `da policy tem pool fresco não-EXHAUSTED`,
    };
  }
  return {
    profileId: alternative.id,
    rerouted: true,
    reason:
      `reviewer pinado ${input.pinnedProfileId} EXHAUSTED; rerroteado para ${alternative.id} ` +
      `dentro da policy autorizada`,
  };
}
