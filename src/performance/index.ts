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
export {
  COMPARABLE_FACT_UNKNOWN,
  COMPARABLE_RUN_FACTS_FILE_NAME,
  ComparableRunFacts,
  ComparableRunIdentity,
  comparableRunFactsFromEvidence,
  unknownComparableRunFacts,
  type AuthoritativeProfileIdentity,
  type ComparableRunFactsEvidence,
  type ComparableStringFact,
} from './comparable-run.js';
export {
  listEvaluations,
  listScores,
  readTrialHistory,
  type EvaluationSelection,
  type EvaluationSelectionEntry,
  type ExcludedRun,
  type RunReadResult,
  type TrialHistoryResult,
} from './history.js';
export {
  deriveComparableRunIdentity,
  queryPerformanceHistory,
  type AggregationStatus,
  type ComparableFactsIssue,
  type EvidenceAggregation,
  type NumericDistribution,
  type PerformanceHistoryFilter,
  type PerformanceHistoryQueryInput,
  type PerformanceHistoryQueryResult,
  type PerformanceSeries,
  type QualificationAggregation,
  type QueryExcludedRun,
  type QueryExcludedTrial,
  type QuotaWindowAggregation,
  type SeriesAggregations,
  type TrialPerformanceQuery,
} from './query.js';
