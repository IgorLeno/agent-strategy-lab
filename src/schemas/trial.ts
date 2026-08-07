import { z } from 'zod';

import { AgentProfile, EnvironmentProfile } from './profiles.js';
import { StrategyDef } from './strategy.js';
import { TaskBudgets, TaskSpec } from './task-spec.js';

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const gitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'base_sha deve ser SHA-1 de commit em hex minúsculo');

/**
 * Estado da intenção experimental, separado dos outcomes de cada run.
 * REPEATED registra que uma falha de infraestrutura exige nova evidência;
 * FAIL pertence à avaliação do run e deliberadamente não é aceito aqui.
 */
export const TrialStatus = z.enum(['PLANNED', 'EXECUTED', 'CANCELLED', 'REPEATED']);
export type TrialStatus = z.infer<typeof TrialStatus>;

/**
 * Tentativa planejada com todos os fatores experimentais materializados.
 * O modelo faz parte do AgentProfile, junto da CLI, versão e flags que o
 * executarão, evitando uma segunda fonte de verdade para essa escolha.
 */
export const Trial = z
  .object({
    id: identifier,
    task: TaskSpec,
    agent: AgentProfile,
    strategy: StrategyDef,
    environment: EnvironmentProfile,
    status: TrialStatus,
  })
  .strict();
export type Trial = z.infer<typeof Trial>;

/** Entrada completa para o runner materializar um run. */
export const ExecutionRequest = z
  .object({
    trial: Trial,
    base_sha: gitCommitSha,
    budgets: TaskBudgets,
    timeout_ms: z.number().int().positive(),
  })
  .strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequest>;
