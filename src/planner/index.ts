/**
 * Contrato formal das tasks produzidas pelo planner. Ver `task.ts` para o
 * envelope adaptativo (`PlannedTask`) e as dimensões que ele compõe a partir
 * de `src/schemas/task-spec.ts`.
 */
export {
  ContextRequirement,
  ContextScope,
  EnvironmentRequirement,
  PlannedTask,
  PlannerTaskMetadata,
  TaskRisk,
  ValidationCommand,
} from './task.js';

/**
 * Motor de decomposição AVC (Atomic Validatable Change) — avalia um
 * `PlannedTask` já formado e decide, por sinais estruturais, se ele precisa
 * ser dividido. Ver `decomposition.ts` para a lista de sinais e limiares.
 */
export {
  DecompositionSignalId,
  DecompositionVerdict,
  EMITTED_DECOMPOSITION_SIGNALS,
  evaluateDecomposition,
  SignalProvenance,
  TriggeredSignal,
} from './decomposition.js';

/**
 * Validação determinística do plano inteiro (M75) mais a policy de workflow
 * proporcional (`DECOMPOSITION_REQUIRED` / `MERGE_RECOMMENDED` /
 * `DIRECT_ALLOWED` / `REVIEWED_REQUIRED`) e a Direct Task Normalization. Ver
 * `validate.ts` para o contrato completo.
 */
export {
  DirectAllowanceCriterion,
  DirectAllowanceCriterionStatus,
  MINIMAL_FACTUAL_PREFLIGHT_REQUIREMENTS,
  MinimalFactualPreflightRequirement,
  MinimalFactualPreflightSource,
  PlanValidationIssue,
  PlanValidationIssueCode,
  TaskWorkflowVerdict,
  evaluatePlan,
  evaluatePlanWorkflow,
  normalizeDirectTask,
  validatePlan,
} from './validate.js';
export type {
  DirectTaskClassification,
  DirectTaskNormalizationInput,
  DirectTaskNormalizationResult,
  PlanEvaluationResult,
  PlanValidationResult,
  WorkflowEvaluationContext,
} from './validate.js';

/**
 * Avaliação determinística e rule-based de execução de uma `PlannedTask`
 * (M76): difficulty, risk, context pressure, environment readiness,
 * verification strength, review requirement e confidence. Ver `assess.ts`.
 */
export {
  ConfidenceLevel,
  ContextPressureLevel,
  DifficultyLevel,
  DiversityRequirement,
  ENVIRONMENT_READINESS_REQUIREMENTS,
  EnvironmentReadinessAssessment,
  EnvironmentReadinessCheck,
  EnvironmentReadinessCheckStatus,
  EnvironmentReadinessRequirement,
  EnvironmentReadinessStatus,
  ExecutionAssessment,
  ReadinessFactsSource,
  ReviewRequirementAssessment,
  VerificationStrengthLevel,
  assessExecution,
} from './assess.js';
export type { ExecutionAssessmentContext } from './assess.js';

/** Contrato provider-agnostic do planning worker e draft sempre nao confiavel. */
export {
  CONTROL_PLANE_PLANNING_POLICY,
  MAX_PLANNER_PACKET_BYTES,
  MAX_PLANNER_TASKS,
  PLANNING_PIPELINE,
  PlannerPacket,
  PlanningPolicy,
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  UntrustedPlanDraft,
  buildPlannerPacket,
  normalizeUntrustedPlanDraft,
} from './draft.js';
export type {
  BuildPlannerPacketInput,
  DraftIssue,
  DraftNormalizationResult,
  PlanningWorkerPort,
} from './draft.js';

/** Composicao autorizada do plano e projecao pura para o PlanFile do harness. */
export {
  ImplementationPlan,
  PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS,
  PlanGenerationStage,
  ProjectedPlanFile,
  generateImplementationPlan,
  projectImplementationPlan,
} from './generate.js';
export type {
  GenerateImplementationPlanInput,
  PlanGenerationResult,
} from './generate.js';
