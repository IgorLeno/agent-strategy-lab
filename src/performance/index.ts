/**
 * Área de performance: fatos derivados por attempt e (em módulos futuros)
 * os records agregados de RunPerformance/TaskPerformance. Nenhum I/O aqui —
 * quem lê disco vive em `storage`/`dev`.
 */
export {
  AttemptRole,
  deriveAttemptFacts,
  type AttemptFacts,
  type AttemptFactsInput,
  type InferenceEvidence,
  type WithProvenance,
} from './attempt-facts.js';
export { derivePerformance, type AttemptHistory } from './derive-performance.js';
