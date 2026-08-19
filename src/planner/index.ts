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
