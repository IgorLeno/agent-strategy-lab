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
