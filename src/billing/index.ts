/** Provider-neutral authorization boundary for inference-bearing execution. */
export {
  BillingGuardBlockedError,
  decideExecutionAuthorization,
  type AuthorizationStatus,
  type BillingGuardDecision,
  type BillingGuardDecisionKind,
  type BillingGuardReasonCode,
  type BillingMode,
  type Evidence,
  type ExecutionKind,
  type QuotaAvailability,
  type RealExecutionAuthorization,
} from './guard.js';
