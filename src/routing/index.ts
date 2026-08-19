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

/** Router inicial determinístico e budget de runtime do worker (M78). */
export {
  BudgetUnsupported,
  CandidateConsideration,
  CandidateRejectionCode,
  CapabilityTier,
  InitialRoutingResult,
  RoutingBlocked,
  RoutingCandidate,
  RoutingDecision,
  RuntimeBoundSource,
  StructuredWorkUnit,
  WorkerRole,
  WorkerRuntimeBound,
  WorkerRuntimeBudget,
  WorkUnitSource,
  routeInitialProfile,
  type BudgetViolation,
  type InitialRoutingInput,
} from './router.js';
