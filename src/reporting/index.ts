/**
 * Relatório: leitura da evidência de um run e renderização para terminal e
 * para `--json`.
 *
 * Fronteira: as três dimensões aparecem SEPARADAS — execução, avaliação e
 * qualificação. Métrica ausente é exibida como null com a origem registrada,
 * nunca como zero, que se confundiria com medição real.
 *
 * O relatório de um run (M38) vive em `src/cli/report.ts`. Esta área abriga,
 * a partir de M66, a comparação entre arms de um experimento — ver
 * `compare.ts`.
 */
export {
  DEFAULT_MIN_QUALIFIED_N,
  compareTaskPerformance,
  type ArmAggregateResult,
  type ArmPosteriorCounts,
  type ArmTaskComparisonResult,
  type CompareOptions,
  type CompareResult,
  type TaskComparisonResult,
  type TaskPerformanceObservation,
} from './compare.js';
