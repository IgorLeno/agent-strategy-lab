/**
 * Avaliação: workspace próprio do evaluator (novo clone do base SHA + apply do
 * changes.patch), graders por comando e orquestração que produz o
 * EvaluationRecord.
 *
 * Fronteira: o EvaluationPlan é injetado SÓ aqui e nunca no workspace do
 * agente. Um run tem N avaliações independentes — reavaliar cria
 * `evaluations/<novo-id>/` e não toca na anterior.
 *
 * Preenchido por M27A, M27B e M28.
 */
export {
  createEvaluatorWorkspace,
  withEvaluatorWorkspace,
  EVALUATION_PLAN_FILE_NAME,
  type CreateEvaluatorWorkspaceOptions,
  type EvaluatorWorkspace,
} from './workspace.js';
export {
  runCommandGrader,
  GRADER_ARTIFACTS_DIR_NAME,
  type RunCommandGraderOptions,
  type CommandGraderRun,
  type CommandGraderArtifacts,
} from './command-grader.js';
