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
