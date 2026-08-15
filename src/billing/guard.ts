/**
 * Guarda provider-neutral para execuções reais que podem consumir inferência.
 *
 * A entrada mantém separadas as evidências de autorização, modo de cobrança,
 * quota, custo e budget. `null` significa desconhecido; zero é sempre uma
 * medição explícita. Custo equivalente de API é apenas informativo e nunca
 * participa da decisão de cobrança incremental.
 */

export type ExecutionKind = 'FIXTURE' | 'REAL_INFERENCE';
export type BillingMode = 'SUBSCRIPTION' | 'API' | 'NO_CHARGE';
export type AuthorizationStatus = 'AUTHORIZED' | 'DENIED';
export type QuotaAvailability = 'SUFFICIENT' | 'INSUFFICIENT';
export type BillingGuardDecisionKind = 'ALLOW' | 'BLOCK';

export interface Evidence<T> {
  /** `null` é desconhecido, nunca zero implícito. */
  readonly value: T | null;
  readonly provenance: string;
}

export interface RealExecutionAuthorization {
  /** Autoriza iniciar sob o modo de cobrança declarado abaixo. */
  readonly authorization: Evidence<AuthorizationStatus>;
  readonly billing_mode: Evidence<BillingMode>;
  readonly quota: {
    readonly availability: Evidence<QuotaAvailability>;
    readonly remaining: Evidence<number>;
    readonly unit: string | null;
  };
  readonly cost: {
    /** Estimativa contrafactual por tabela de API; nunca é cobrança real. */
    readonly api_equivalent_usd: Evidence<number>;
    /** Projeção de cobrança incremental usada para aplicar budget em modo API. */
    readonly projected_incremental_charge_usd: Evidence<number>;
    /** Cobrança observada, somente válida com fonte autoritativa. */
    readonly actual_incremental_charge_usd: Evidence<number>;
    readonly actual_incremental_charge_authoritative: boolean;
  };
  readonly budget: {
    readonly maximum_incremental_charge_usd: Evidence<number>;
  };
}

export type BillingGuardReasonCode =
  | 'NON_REAL_FIXTURE'
  | 'AUTHORIZATION_CONFIRMED'
  | 'AUTHORIZATION_DENIED'
  | 'AUTHORIZATION_UNKNOWN'
  | 'BILLING_MODE_UNKNOWN'
  | 'QUOTA_SUFFICIENT'
  | 'QUOTA_INSUFFICIENT'
  | 'QUOTA_UNKNOWN'
  | 'API_BUDGET_UNKNOWN'
  | 'API_PROJECTED_CHARGE_UNKNOWN'
  | 'API_PROJECTED_CHARGE_WITHIN_BUDGET'
  | 'API_PROJECTED_CHARGE_EXCEEDS_BUDGET'
  | 'NON_AUTHORITATIVE_ACTUAL_CHARGE'
  | 'INVALID_EVIDENCE';

export interface BillingGuardDecision {
  readonly decision: BillingGuardDecisionKind;
  readonly execution_kind: ExecutionKind;
  readonly policy: { readonly id: 'agentlab-real-execution-billing-guard'; readonly version: 1 };
  readonly reasons: readonly BillingGuardReasonCode[];
  /** Snapshot da evidência usada; `null` somente para evidência ausente. */
  readonly evidence: RealExecutionAuthorization | null;
}

/**
 * Decide sem consultar provider nem ambiente. A mesma evidência produz a
 * mesma decisão e pode ser persistida pelo chamador como trilha de auditoria.
 */
export function decideExecutionAuthorization(
  executionKind: ExecutionKind,
  evidence?: RealExecutionAuthorization,
): BillingGuardDecision {
  const policy = { id: 'agentlab-real-execution-billing-guard', version: 1 } as const;
  if (executionKind === 'FIXTURE') {
    return {
      decision: 'ALLOW',
      execution_kind: executionKind,
      policy,
      reasons: ['NON_REAL_FIXTURE'],
      evidence: evidence === undefined ? null : structuredClone(evidence),
    };
  }

  if (evidence === undefined) {
    return {
      decision: 'BLOCK',
      execution_kind: executionKind,
      policy,
      reasons: ['AUTHORIZATION_UNKNOWN', 'BILLING_MODE_UNKNOWN', 'QUOTA_UNKNOWN'],
      evidence: null,
    };
  }

  const reasons: BillingGuardReasonCode[] = [];
  let blocked = false;

  if (!hasValidEvidence(evidence)) {
    reasons.push('INVALID_EVIDENCE');
    blocked = true;
  }

  if (evidence.authorization.value === 'AUTHORIZED') {
    reasons.push('AUTHORIZATION_CONFIRMED');
  } else if (evidence.authorization.value === 'DENIED') {
    reasons.push('AUTHORIZATION_DENIED');
    blocked = true;
  } else {
    reasons.push('AUTHORIZATION_UNKNOWN');
    blocked = true;
  }

  if (evidence.billing_mode.value === null) {
    reasons.push('BILLING_MODE_UNKNOWN');
    blocked = true;
  }

  if (evidence.quota.availability.value === 'SUFFICIENT') {
    reasons.push('QUOTA_SUFFICIENT');
  } else if (evidence.quota.availability.value === 'INSUFFICIENT') {
    reasons.push('QUOTA_INSUFFICIENT');
    blocked = true;
  } else {
    // Ausência de probe permanece desconhecida; nunca é reescrita como zero.
    reasons.push('QUOTA_UNKNOWN');
  }

  const actualCharge = evidence.cost.actual_incremental_charge_usd.value;
  if (actualCharge !== null && !evidence.cost.actual_incremental_charge_authoritative) {
    reasons.push('NON_AUTHORITATIVE_ACTUAL_CHARGE');
    blocked = true;
  }

  if (evidence.billing_mode.value === 'API') {
    const budget = evidence.budget.maximum_incremental_charge_usd.value;
    const projectedCharge = evidence.cost.projected_incremental_charge_usd.value;
    if (budget === null) {
      reasons.push('API_BUDGET_UNKNOWN');
      blocked = true;
    }
    if (projectedCharge === null) {
      reasons.push('API_PROJECTED_CHARGE_UNKNOWN');
      blocked = true;
    }
    if (budget !== null && projectedCharge !== null) {
      if (projectedCharge > budget) {
        reasons.push('API_PROJECTED_CHARGE_EXCEEDS_BUDGET');
        blocked = true;
      } else {
        reasons.push('API_PROJECTED_CHARGE_WITHIN_BUDGET');
      }
    }
  }

  return {
    decision: blocked ? 'BLOCK' : 'ALLOW',
    execution_kind: executionKind,
    policy,
    reasons,
    evidence: structuredClone(evidence),
  };
}

function hasValidEvidence(evidence: RealExecutionAuthorization): boolean {
  const provenances = [
    evidence.authorization.provenance,
    evidence.billing_mode.provenance,
    evidence.quota.availability.provenance,
    evidence.quota.remaining.provenance,
    evidence.cost.api_equivalent_usd.provenance,
    evidence.cost.projected_incremental_charge_usd.provenance,
    evidence.cost.actual_incremental_charge_usd.provenance,
    evidence.budget.maximum_incremental_charge_usd.provenance,
  ];
  const numbers = [
    evidence.quota.remaining.value,
    evidence.cost.api_equivalent_usd.value,
    evidence.cost.projected_incremental_charge_usd.value,
    evidence.cost.actual_incremental_charge_usd.value,
    evidence.budget.maximum_incremental_charge_usd.value,
  ];

  return (
    (evidence.quota.remaining.value === null ||
      (evidence.quota.unit !== null && evidence.quota.unit.trim().length > 0)) &&
    provenances.every((provenance) => provenance.trim().length > 0) &&
    numbers.every((value) => value === null || (Number.isFinite(value) && value >= 0))
  );
}

export class BillingGuardBlockedError extends Error {
  readonly decision: BillingGuardDecision;

  constructor(decision: BillingGuardDecision) {
    super(`execução real bloqueada pela billing guard: ${decision.reasons.join(', ')}`);
    this.name = 'BillingGuardBlockedError';
    this.decision = decision;
  }
}
