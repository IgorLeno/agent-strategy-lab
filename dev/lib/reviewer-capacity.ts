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

/**
 * POR QUE não sobrou reviewer. Os três casos já existiam — só em prosa, o que
 * obrigava quem classificava a parada a tratar os três como a mesma coisa.
 *
 * A distinção importa porque só UM deles é autoridade humana: uma policy que
 * não contém nenhum profile capaz de satisfazer `diversity=required` só é
 * resolvida por alguém ampliando a policy. Pool esgotado e falha de INFRA se
 * resolvem sozinhos no reset da janela ou com o conserto técnico.
 *
 * Nomear a causa NÃO muda a seleção: ordem de failover, exclusões e retry
 * continuam idênticos.
 */
export type ReviewerUnavailabilityCause =
  /** A policy não oferece nenhum profile que satisfaça a diversidade exigida. */
  | 'DIVERSITY_POLICY_HAS_NO_ALTERNATIVE'
  /** Todos os candidatos restantes falharam por INFRA nesta decisão. */
  | 'ALL_CANDIDATES_FAILED_INFRA'
  /** Os pools autorizados estão esgotados agora; a janela reseta sozinha. */
  | 'ALL_POOLS_EXHAUSTED';

export interface ReviewerCapacitySelection {
  readonly profileId: string | null;
  readonly rerouted: boolean;
  readonly reason: string;
  /** Presente exatamente quando `profileId` é `null`. */
  readonly cause: ReviewerUnavailabilityCause | null;
}

export function isRetryableReviewerInvocationFailure(code: string): boolean {
  return code === 'REVIEW_INVOCATION_FAILED';
}

/** Indisponibilidade que exclui o profile e tenta o próximo da policy. */
export function isRetryableReviewerUnavailability(code: string): boolean {
  return isRetryableReviewerInvocationFailure(code) || code === 'REVIEW_DIVERSITY_REQUIRED';
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
  readonly implementerProfileId?: string;
  readonly diversityRequirement?: string;
}): ReviewerCapacitySelection {
  const excluded = new Set(input.excludedProfileIds ?? []);
  const diversityBlocked =
    input.diversityRequirement === 'required' ? (input.implementerProfileId ?? null) : null;
  const exhausted = (profileId: string): boolean => {
    const pool = input.poolOf(profileId);
    if (pool === null) return false;
    return input.capacityByPool.get(pool)?.status === CapacityStatus.EXHAUSTED;
  };
  const ineligible = (profileId: string): boolean =>
    excluded.has(profileId) || exhausted(profileId) || profileId === diversityBlocked;

  if (!ineligible(input.pinnedProfileId)) {
    return {
      profileId: input.pinnedProfileId,
      rerouted: false,
      reason: `reviewer pinado ${input.pinnedProfileId} permanece elegível pela observação fresca`,
      cause: null,
    };
  }

  const ordered = [...input.policyProfiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  );
  const alternative = ordered.find((entry) => !ineligible(entry.id));
  if (alternative === undefined) {
    const infra = [...excluded].join(', ');
    const diversityReason =
      diversityBlocked !== null
        ? `diversity=required exclui o implementer ${diversityBlocked}`
        : null;
    return {
      profileId: null,
      rerouted: false,
      cause:
        excluded.size > 0
          ? 'ALL_CANDIDATES_FAILED_INFRA'
          : diversityReason !== null
            ? 'DIVERSITY_POLICY_HAS_NO_ALTERNATIVE'
            : 'ALL_POOLS_EXHAUSTED',
      reason:
        excluded.size > 0
          ? `nenhum reviewer restante na policy: INFRA em [${infra}] e os demais pools estão EXHAUSTED ou também excluídos`
          : diversityReason !== null
            ? `reviewer pinado ${input.pinnedProfileId} coincide com o implementer e nenhum outro profile da policy satisfaz diversity=required`
            : `reviewer pinado ${input.pinnedProfileId} está EXHAUSTED e nenhum outro profile ` +
              `da policy tem pool fresco não-EXHAUSTED`,
    };
  }
  const diversityReroute = input.pinnedProfileId === diversityBlocked;
  return {
    profileId: alternative.id,
    rerouted: true,
    cause: null,
    reason: excluded.has(input.pinnedProfileId)
      ? `reviewer pinado ${input.pinnedProfileId} falhou por INFRA; rerroteado para ${alternative.id} dentro da policy autorizada`
      : diversityReroute
        ? `reviewer pinado ${input.pinnedProfileId} coincide com o implementer e diversity=required; rerroteado para ${alternative.id} dentro da policy autorizada`
        : `reviewer pinado ${input.pinnedProfileId} EXHAUSTED; rerroteado para ${alternative.id} ` +
          `dentro da policy autorizada`,
  };
}
