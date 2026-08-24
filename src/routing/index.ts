/**
 * Registro estruturado das capacidades de profile (session isolation,
 * mutation/read-only, ownership, compatibilidade de role) para o control
 * plane impor políticas de diversidade e routing sem reimplementar as
 * derivações de `dev/lib/doctor.ts`. Nenhuma decisão de routing mora aqui.
 */
export {
  CapabilityRegistry,
  DuplicateCapabilityError,
  ProfileCapability,
  capabilityOf,
  type Agent,
  type Determinable,
  type DiversityFacts,
  type ProfileCapabilityInput,
  type ReasoningEffortSource,
} from './capability.js';

/**
 * Router inicial determinístico e PREVISÃO advisory de runtime (M78).
 * A previsão não rejeita profile: quem decide é capability contra as
 * características da work unit.
 */
export {
  CandidateConsideration,
  CandidateRejectionCode,
  CapabilityTier,
  ExecutionRuntimeForecast,
  InitialRoutingResult,
  RoutingBlocked,
  RoutingCandidate,
  RoutingDecision,
  StructuredWorkUnit,
  WorkerRole,
  WorkUnitSource,
  routeInitialProfile,
  type InitialRoutingInput,
} from './router.js';

/** Camada histórica read-only sobre M78 (M82). */
export {
  HISTORY_UTILITY_AGGREGATIONS,
  HistoryInformedRoutingResult,
  HistoryRoutingEvidence,
  HistoryRoutingRecommendation,
  HistoryRoutingSource,
  HistoryExecutionRuntimeForecast,
  routeHistoryInformedProfile,
  routeInitialProfileWithHistory,
  type HistoryRoutingInput,
  type HistorySeriesConsideration,
  type HistoryUtility,
} from './history-router.js';

/** Failure diagnosis e intervenção provider-neutral (M79). */
export {
  BoundedRepairBudget,
  FailureDiagnosis,
  FailureDiagnosisClassification,
  FailureInterventionAction,
  FailureInterventionDecision,
  HumanInterventionDecision,
  decideFailureIntervention,
  type FailureInterventionOptions,
} from './diagnosis.js';

/** Ladder e autorização pura de escalation (M79). */
export {
  DEFAULT_ESCALATION_ORDER_RATIONALE,
  DiscardedEscalationStep,
  EscalationAuthorization,
  EscalationDiscardReason,
  EscalationDecision,
  EscalationExecutionPolicy,
  EscalationLadder,
  EscalationStep,
  HumanEscalationReason,
  RepairSequenceEvidence,
  decideEscalation,
  resolveEscalationLadder,
  type EscalationCandidatePreflight,
  type EscalationDecisionInput,
  type ResolvedEscalationLadder,
} from './escalation.js';
