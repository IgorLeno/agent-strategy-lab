/**
 * Schemas zod dos contratos de dados: TaskSpec, EvaluationPlan, AgentProfile,
 * EnvironmentProfile, StrategyDef, Trial, ExecutionRequest e os records de
 * execução, avaliação, score e qualificação.
 *
 * Fronteira: TaskSpec (público, pode ir ao workspace do agente) e
 * EvaluationPlan (privado, nunca sai do lab) são tipos SEPARADOS. Sem herança
 * nem reuso entre os dois — é assim que campo oculto vaza.
 *
 * Preenchido por M03, M03B, M04, M05, M06, M07, M08 e M09.
 */
export { TaskBudget, TaskBudgets, TaskSpec, TaskTaxonomy } from './task-spec.js';
export { EvaluationPlan } from './evaluation-plan.js';
export {
  AgentProfile,
  EnvironmentProfile,
  InstructionFileFingerprint,
} from './profiles.js';
export { StrategyDef } from './strategy.js';
export {
  ExperimentArm,
  ExperimentBillingPolicy,
  ExperimentOrdering,
  ExperimentSpec,
} from './experiment-spec.js';
export { ExecutionRequest, Trial, TrialStatus } from './trial.js';
export {
  EvaluationRecord,
  ExecutionMetrics,
  ExecutionRecord,
  GraderResult,
} from './execution-record.js';
export {
  QualificationRecord,
  ScoreRecord,
  SubScore,
} from './evaluation-record.js';
export {
  QuotaObservationStatus,
  QuotaReasonCode,
  QuotaUsage,
  QuotaWindow,
} from './quota-usage.js';
export { InterventionRecord, InterventionType, RunInterventionsRecord } from './intervention.js';
export { RunPerformanceRecord, TaskPerformanceRecord } from './performance.js';
export {
  ExtensionKind,
  ExtensionManifest,
  IncubationState,
  IncubationStatus,
  loadExtension,
} from './extension.js';
export type { Extension } from './extension.js';
