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
export { TaskBudget, TaskBudgets, TaskSpec } from './task-spec.js';
export { EvaluationPlan } from './evaluation-plan.js';
