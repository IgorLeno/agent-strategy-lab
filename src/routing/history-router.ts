/**
 * Camada histórica pura sobre o router inicial de M78.
 *
 * Esta camada nunca consulta nem escreve história: recebe o resultado read-only
 * de M81, avalia cada série comparável isoladamente e, quando a evidência não
 * decide, devolve explicitamente o resultado determinístico de M78.
 */
import { z } from 'zod';

import type {
  EvidenceAggregation,
  NumericDistribution,
  PerformanceHistoryQueryResult,
  PerformanceHistoryQueryResultV2,
  PerformanceSeries,
} from '../performance/query.js';
import { ProfileCapability } from './capability.js';
import {
  InitialRoutingResult,
  WorkerRuntimeBound,
  routeInitialProfile,
  type InitialRoutingInput,
  type RoutingCandidate,
} from './router.js';

const nonEmpty = z.string().trim().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const HistoryRoutingSource = z.enum(['HISTORY', 'M78_FALLBACK']);
export type HistoryRoutingSource = z.infer<typeof HistoryRoutingSource>;

export const HISTORY_UTILITY_AGGREGATIONS = [
  'first_operational_pass_rate',
  'final_pass_rate',
  'repair_rate',
  'escalation_rate',
  'duration_ms.p90',
  'tokens.total.p90',
  'quota.consumed_pp.p90_total',
  'api_equivalent_usd.p90',
  'human_intervention_rate',
  'qualification.qualified_rate',
  'context_pressure.compatibility',
  'environment_readiness.compatibility',
] as const;

const HistoryUtility = z
  .object({
    first_pass_rate: z.number().min(0).max(1),
    final_pass_rate: z.number().min(0).max(1),
    repair_rate: z.number().min(0),
    escalation_rate: z.number().min(0),
    duration_p90_ms: z.number().nonnegative(),
    total_tokens_p90: z.number().nonnegative(),
    quota_consumed_pp_p90_total: z.number().nonnegative(),
    api_equivalent_usd_p90: z.number().nonnegative(),
    human_intervention_rate: z.number().min(0).max(1),
    qualified_rate: z.number().min(0).max(1),
    context_pressure_compatibility: z.number().min(0).max(1),
  })
  .strict();
export type HistoryUtility = z.infer<typeof HistoryUtility>;

const HistorySeriesConsideration = z
  .object({
    series_key: sha256.nullable(),
    profile_id: nonEmpty.nullable(),
    trial_sample_size: z.number().int().nonnegative(),
    minimum_metric_sample_size: z.number().int().nonnegative(),
    status: z.enum(['ELIGIBLE', 'INCOMPATIBLE', 'INSUFFICIENT_EVIDENCE', 'AMBIGUOUS']),
    reason: nonEmpty,
    utility: HistoryUtility.nullable(),
  })
  .strict();
export type HistorySeriesConsideration = z.infer<typeof HistorySeriesConsideration>;

export const HistoryRoutingEvidence = z
  .object({
    query_minimum_sample_size: z.number().int().positive(),
    decision_minimum_sample_size: z.number().int().positive(),
    selected_series_key: sha256.nullable(),
    selected_series_sample_size: z.number().int().nonnegative(),
    aggregations_considered: z.array(nonEmpty).min(1),
    series_considered: z.array(HistorySeriesConsideration),
  })
  .strict();
export type HistoryRoutingEvidence = z.infer<typeof HistoryRoutingEvidence>;

const NumericDistributionSchema = z
  .object({
    values: z.array(z.number().nonnegative()).min(1),
    total: z.number().nonnegative(),
    mean: z.number().nonnegative(),
    min: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p90: z.number().nonnegative(),
    max: z.number().nonnegative(),
  })
  .strict();

export const HistoryWorkerRuntimeBudget = z
  .object({
    kind: z.literal('HISTORY_DERIVED_WORKER_RUNTIME_BUDGET'),
    milliseconds: z.number().int().nonnegative(),
    statistic: z.literal('observed_duration_ms_p90'),
    observed_distribution: NumericDistributionSchema,
    sample_size: z.number().int().positive(),
    checked_runtime_bounds: z.array(WorkerRuntimeBound).min(1),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type HistoryWorkerRuntimeBudget = z.infer<typeof HistoryWorkerRuntimeBudget>;

const HistoryBudgetViolation = z
  .object({
    profile_id: nonEmpty,
    requested_budget_ms: z.number().int().nonnegative(),
    violated_bound: WorkerRuntimeBound,
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();

const HistoryRoutedRecommendation = z
  .object({
    outcome: z.literal('ROUTED'),
    profile: ProfileCapability,
    worker_runtime_budget: HistoryWorkerRuntimeBudget,
    series_key: sha256,
  })
  .strict();

const HistoryBudgetUnsupportedRecommendation = z
  .object({
    outcome: z.literal('BUDGET_UNSUPPORTED'),
    profile: ProfileCapability,
    worker_runtime_budget: HistoryWorkerRuntimeBudget,
    violations: z.array(HistoryBudgetViolation).min(1),
    allowed_next_steps: z.tuple([
      z.literal('TRY_ANOTHER_PROFILE'),
      z.literal('RECONFIGURE_RUNTIME'),
      z.literal('REPLAN'),
      z.literal('HUMAN_REQUIRED'),
    ]),
    series_key: sha256,
  })
  .strict();

export const HistoryRoutingRecommendation = z.discriminatedUnion('outcome', [
  HistoryRoutedRecommendation,
  HistoryBudgetUnsupportedRecommendation,
]);
export type HistoryRoutingRecommendation = z.infer<typeof HistoryRoutingRecommendation>;

/**
 * `fallback` contém o resultado de M78 sem alteração. A metadata externa deixa
 * explícito por que a história não decidiu, sem mudar o contrato do router base.
 */
export const HistoryInformedRoutingResult = z
  .object({
    schema_version: z.literal(1),
    source: HistoryRoutingSource,
    recommendation: HistoryRoutingRecommendation.nullable(),
    fallback: InitialRoutingResult.nullable(),
    evidence: HistoryRoutingEvidence,
    rationale: z.array(nonEmpty).min(1),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict()
  .superRefine((result, context) => {
    const historyShape = result.source === 'HISTORY' && result.recommendation !== null && result.fallback === null;
    const fallbackShape = result.source === 'M78_FALLBACK' && result.recommendation === null && result.fallback !== null;
    if (!historyShape && !fallbackShape) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'HISTORY exige recommendation; M78_FALLBACK exige fallback',
      });
    }
  });
export type HistoryInformedRoutingResult = z.infer<typeof HistoryInformedRoutingResult>;

export interface HistoryRoutingInput extends InitialRoutingInput {
  /** Resultado já consultado por M81; esta função não realiza I/O. */
  readonly history: PerformanceHistoryQueryResult | PerformanceHistoryQueryResultV2;
  /** Pode tornar a decisão mais conservadora que a consulta, nunca inventa amostras. */
  readonly minimum_sample_size?: number;
  /** Fingerprints autoritativos dos profiles candidatos no momento da decisão. */
  readonly profile_fingerprints_sha256?: Readonly<Record<string, string>>;
}

function routingSeries(
  history: PerformanceHistoryQueryResult | PerformanceHistoryQueryResultV2,
): readonly PerformanceSeries[] {
  if (history.schema_version === 1) return history.series;
  return history.series.map((series) => ({
    identity: series.identity,
    automatic_merge_eligible: series.automatic_merge_eligible && series.initial_routing_eligible,
    trial_ids: series.trial_ids,
    run_ids: series.run_ids,
    aggregations: series.routing_aggregations,
  }));
}

interface EligibleSeries {
  readonly series: PerformanceSeries;
  readonly capability: z.infer<typeof ProfileCapability>;
  readonly candidate: RoutingCandidate;
  readonly utility: HistoryUtility;
  readonly minimumMetricSampleSize: number;
}

interface UtilityExtraction {
  readonly utility: HistoryUtility | null;
  readonly minimumMetricSampleSize: number;
  readonly reason: string | null;
}

function available<T>(
  aggregation: EvidenceAggregation<T>,
  minimumSampleSize: number,
): aggregation is EvidenceAggregation<T> & { readonly value: T } {
  return (
    aggregation.status === 'AVAILABLE' &&
    aggregation.value !== null &&
    aggregation.sample_size >= minimumSampleSize
  );
}

function utilityOf(
  series: PerformanceSeries,
  minimumSampleSize: number,
  contextPressure: string,
): UtilityExtraction {
  const aggregates = series.aggregations;
  const required: readonly (readonly [string, EvidenceAggregation<unknown>])[] = [
    ['first_operational_pass_rate', aggregates.first_operational_pass_rate],
    ['final_pass_rate', aggregates.final_pass_rate],
    ['repair_rate', aggregates.repair_rate],
    ['escalation_rate', aggregates.escalation_rate],
    ['duration_ms', aggregates.duration_ms],
    ['tokens.total', aggregates.tokens.total],
    ['api_equivalent_usd', aggregates.api_equivalent_usd],
    ['human_intervention_rate', aggregates.human_intervention_rate],
    ['qualification.qualified_rate', aggregates.qualification.qualified_rate],
    ['context_pressure', aggregates.context_pressure],
  ] as const;
  const unavailable = required.find(([, aggregation]) => !available(aggregation, minimumSampleSize));
  if (unavailable !== undefined) {
    const [name, aggregation] = unavailable;
    return {
      utility: null,
      minimumMetricSampleSize: Math.min(...required.map(([, metric]) => metric.sample_size)),
      reason: `${name} sem amostra disponível >= minimum_sample_size=${minimumSampleSize} (status=${aggregation.status}, sample_size=${aggregation.sample_size})`,
    };
  }
  if (!available(aggregates.quota, minimumSampleSize) || aggregates.quota.value.length === 0) {
    return {
      utility: null,
      minimumMetricSampleSize: aggregates.quota.sample_size,
      reason: `quota sem amostra disponível >= minimum_sample_size=${minimumSampleSize}`,
    };
  }
  const quotaWindows = aggregates.quota.value;
  const unavailableQuota = quotaWindows.find(
    (window) => !available(window.consumed_pp, minimumSampleSize),
  );
  if (unavailableQuota !== undefined) {
    return {
      utility: null,
      minimumMetricSampleSize: unavailableQuota.consumed_pp.sample_size,
      reason: `quota ${unavailableQuota.provider}/${unavailableQuota.window_id} sem amostra disponível >= minimum_sample_size=${minimumSampleSize}`,
    };
  }

  const sampleSizes = [
    ...required.map(([, metric]) => metric.sample_size),
    aggregates.quota.sample_size,
    ...quotaWindows.map((window) => window.consumed_pp.sample_size),
  ];
  const firstPassRate = aggregates.first_operational_pass_rate.value!;
  const finalPassRate = aggregates.final_pass_rate.value!;
  const repairRate = aggregates.repair_rate.value!;
  const escalationRate = aggregates.escalation_rate.value!;
  const durationDistribution = aggregates.duration_ms.value!;
  const tokenDistribution = aggregates.tokens.total.value!;
  const costDistribution = aggregates.api_equivalent_usd.value!;
  const interventionRate = aggregates.human_intervention_rate.value!;
  const qualifiedRate = aggregates.qualification.qualified_rate.value!;
  const contextCounts = aggregates.context_pressure.value!;
  const contextCount = contextCounts[contextPressure] ?? 0;
  return {
    utility: HistoryUtility.parse({
      first_pass_rate: firstPassRate,
      final_pass_rate: finalPassRate,
      repair_rate: repairRate,
      escalation_rate: escalationRate,
      duration_p90_ms: durationDistribution.p90,
      total_tokens_p90: tokenDistribution.p90,
      quota_consumed_pp_p90_total: quotaWindows.reduce(
        (total, window) => total + (window.consumed_pp.value?.p90 ?? 0),
        0,
      ),
      api_equivalent_usd_p90: costDistribution.p90,
      human_intervention_rate: interventionRate,
      qualified_rate: qualifiedRate,
      context_pressure_compatibility: contextCount / aggregates.context_pressure.sample_size,
    }),
    minimumMetricSampleSize: Math.min(...sampleSizes),
    reason: null,
  };
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compatibilityReason(
  input: HistoryRoutingInput,
  series: PerformanceSeries,
  candidate: RoutingCandidate | undefined,
  capability: z.infer<typeof ProfileCapability> | undefined,
): string | null {
  const identity = series.identity;
  if (!identity.comparable || identity.series_key === null) {
    return `série possui dimensões UNKNOWN: ${identity.blocking_unknown_dimensions.join(', ')}`;
  }
  if (!series.automatic_merge_eligible) {
    return 'série não possui episódios INITIAL elegíveis para routing inicial';
  }
  const profileId = identity.profile.profile_id.value;
  if (profileId === 'UNKNOWN' || candidate === undefined || capability === undefined) {
    return `profile histórico=${profileId} não corresponde a candidato registrável`;
  }
  const currentFingerprint = input.profile_fingerprints_sha256?.[profileId];
  if (currentFingerprint === undefined) {
    return `fingerprint atual de ${profileId} não foi fornecido; ausência não prova comparabilidade`;
  }
  if (identity.profile.profile_fingerprint_sha256.value !== currentFingerprint) {
    return `fingerprint histórico de ${profileId} difere do fingerprint atual`;
  }

  const taskClass = input.work_unit.task.taxonomy.task_class;
  const difficulty = input.work_unit.assessment.difficulty.value;
  const stack = input.work_unit.project_facts.stack;
  if (!stack.known) return 'stack atual desconhecida';
  if (identity.task.task_class.value !== taskClass) return 'task_class histórica incompatível';
  if (identity.task.difficulty.value !== difficulty) return 'difficulty histórica incompatível';
  if (
    identity.task.stack.value === 'UNKNOWN' ||
    !sameArray(identity.task.stack.value, stack.value.ecosystems_detected)
  ) {
    return 'stack histórica incompatível';
  }
  if (identity.execution.model.value !== capability.model) return 'model histórico incompatível';
  if (identity.execution.reasoning_effort.value !== capability.reasoning_effort) {
    return 'reasoning_effort histórico incompatível';
  }
  if (identity.execution.worker_role.value !== input.role) return 'worker_role histórico incompatível';
  if (identity.execution.environment_mode.value !== capability.environment_mode) {
    return 'environment_mode histórico incompatível';
  }
  if (identity.context.context_pressure.value !== input.work_unit.assessment.context_pressure.value) {
    return 'context_pressure histórico incompatível';
  }
  if (identity.context.environment_readiness.value !== input.work_unit.assessment.environment_readiness.status) {
    return 'environment_readiness histórico incompatível';
  }

  const isolatedBase = routeInitialProfile({
    work_unit: input.work_unit,
    role: input.role,
    capability_registry: input.capability_registry,
    candidates: [candidate],
  });
  if (isolatedBase.outcome === 'HUMAN_REQUIRED') {
    return `M78 recusou o profile isolado: ${isolatedBase.reason}`;
  }
  return null;
}

const maximize: readonly (keyof HistoryUtility)[] = [
  'first_pass_rate',
  'final_pass_rate',
  'qualified_rate',
  'context_pressure_compatibility',
];
const minimize: readonly (keyof HistoryUtility)[] = [
  'repair_rate',
  'escalation_rate',
  'duration_p90_ms',
  'total_tokens_p90',
  'quota_consumed_pp_p90_total',
  'api_equivalent_usd_p90',
  'human_intervention_rate',
];

/** Dominância de Pareto: nenhuma ponderação ou precisão externa aos dados. */
function dominates(left: HistoryUtility, right: HistoryUtility): boolean {
  const noWorse =
    maximize.every((key) => left[key] >= right[key]) &&
    minimize.every((key) => left[key] <= right[key]);
  const strictlyBetter =
    maximize.some((key) => left[key] > right[key]) ||
    minimize.some((key) => left[key] < right[key]);
  return noWorse && strictlyBetter;
}

function fallback(
  input: HistoryRoutingInput,
  minimumSampleSize: number,
  considerations: readonly HistorySeriesConsideration[],
  reason: string,
): HistoryInformedRoutingResult {
  return HistoryInformedRoutingResult.parse({
    schema_version: 1,
    source: 'M78_FALLBACK',
    recommendation: null,
    fallback: routeInitialProfile(input),
    evidence: {
      query_minimum_sample_size: input.history.minimum_sample_size,
      decision_minimum_sample_size: minimumSampleSize,
      selected_series_key: null,
      selected_series_sample_size: 0,
      aggregations_considered: [...HISTORY_UTILITY_AGGREGATIONS],
      series_considered: considerations,
    },
    rationale: [
      reason,
      `histórico não decidiu; fallback determinístico para M78 com minimum_sample_size=${minimumSampleSize}`,
    ],
    provenance: ['PerformanceHistoryQueryResult(M81, read-only)', 'routeInitialProfile(M78)'],
  });
}

/**
 * Recomenda profile e worker runtime budget somente quando uma única série
 * suficiente domina todas as alternativas. Trade-off, empate ou ausência de
 * qualquer dimensão obrigatória cai no M78.
 */
export function routeInitialProfileWithHistory(input: HistoryRoutingInput): HistoryInformedRoutingResult {
  const minimumSampleSize = input.minimum_sample_size ?? input.history.minimum_sample_size;
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize < 1) {
    throw new RangeError('minimum_sample_size deve ser inteiro positivo');
  }

  const candidates = new Map(input.candidates.map((candidate) => [candidate.profile_id, candidate]));
  const structurallyEligibleProfileIds = new Set(
    input.candidates
      .filter((candidate) => {
        const isolated = routeInitialProfile({
          work_unit: input.work_unit,
          role: input.role,
          capability_registry: input.capability_registry,
          candidates: [candidate],
        });
        return isolated.outcome !== 'HUMAN_REQUIRED';
      })
      .map((candidate) => candidate.profile_id),
  );
  const considerations: HistorySeriesConsideration[] = [];
  const eligible: EligibleSeries[] = [];

  for (const series of [...routingSeries(input.history)].sort((left, right) =>
    (left.identity.series_key ?? '').localeCompare(right.identity.series_key ?? ''),
  )) {
    const profileValue = series.identity.profile.profile_id.value;
    const profileId = profileValue === 'UNKNOWN' ? null : profileValue;
    const candidate = profileId === null ? undefined : candidates.get(profileId);
    const capability = profileId === null ? undefined : input.capability_registry.get(profileId);
    const compatibility = compatibilityReason(input, series, candidate, capability);
    const trialSampleSize = series.aggregations.trials.sample_size;
    if (compatibility !== null || candidate === undefined || capability === undefined) {
      considerations.push({
        series_key: series.identity.series_key,
        profile_id: profileId,
        trial_sample_size: trialSampleSize,
        minimum_metric_sample_size: 0,
        status: 'INCOMPATIBLE',
        reason: compatibility ?? 'profile/candidate ausente',
        utility: null,
      });
      continue;
    }

    const extraction = utilityOf(
      series,
      minimumSampleSize,
      input.work_unit.assessment.context_pressure.value,
    );
    if (extraction.utility === null) {
      considerations.push({
        series_key: series.identity.series_key,
        profile_id: profileId,
        trial_sample_size: trialSampleSize,
        minimum_metric_sample_size: extraction.minimumMetricSampleSize,
        status: 'INSUFFICIENT_EVIDENCE',
        reason: extraction.reason ?? 'agregação obrigatória indisponível',
        utility: null,
      });
      continue;
    }
    considerations.push({
      series_key: series.identity.series_key,
      profile_id: profileId,
      trial_sample_size: trialSampleSize,
      minimum_metric_sample_size: extraction.minimumMetricSampleSize,
      status: 'ELIGIBLE',
      reason: `mesma série comparável com todas as agregações e minimum_sample_size=${minimumSampleSize}`,
      utility: extraction.utility,
    });
    eligible.push({
      series,
      capability,
      candidate,
      utility: extraction.utility,
      minimumMetricSampleSize: extraction.minimumMetricSampleSize,
    });
  }

  const profilesWithPartialSeriesEvidence = [
    ...new Set(
      considerations
        .filter(
          (entry) =>
            entry.status === 'INSUFFICIENT_EVIDENCE' &&
            entry.profile_id !== null &&
            structurallyEligibleProfileIds.has(entry.profile_id) &&
            eligible.some((candidate) => candidate.capability.profile_id === entry.profile_id),
        )
        .map((entry) => entry.profile_id!),
    ),
  ].sort();
  if (profilesWithPartialSeriesEvidence.length > 0) {
    return fallback(
      input,
      minimumSampleSize,
      considerations,
      `profiles com série suficiente e série comparável incompleta: ${profilesWithPartialSeriesEvidence.join(', ')}`,
    );
  }

  const profilesWithoutSufficientEvidence = [...structurallyEligibleProfileIds]
    .filter((profileId) => !eligible.some((entry) => entry.capability.profile_id === profileId))
    .sort();
  for (const profileId of profilesWithoutSufficientEvidence) {
    if (considerations.some((entry) => entry.profile_id === profileId)) continue;
    considerations.push({
      series_key: null,
      profile_id: profileId,
      trial_sample_size: 0,
      minimum_metric_sample_size: 0,
      status: 'INSUFFICIENT_EVIDENCE',
      reason: `profile estruturalmente elegível em M78 não possui série comparável; ausência não prova utilidade inferior`,
      utility: null,
    });
  }
  if (profilesWithoutSufficientEvidence.length > 0) {
    return fallback(
      input,
      minimumSampleSize,
      considerations,
      `profiles elegíveis sem evidência suficiente: ${profilesWithoutSufficientEvidence.join(', ')}`,
    );
  }

  if (eligible.length === 0) {
    return fallback(input, minimumSampleSize, considerations, 'nenhuma série compatível tem evidência suficiente');
  }
  const frontier = eligible.filter(
    (candidate) => !eligible.some((other) => other !== candidate && dominates(other.utility, candidate.utility)),
  );
  if (frontier.length !== 1) {
    const frontierKeys = new Set(frontier.map((entry) => entry.series.identity.series_key));
    const ambiguous = considerations.map((entry) =>
      entry.series_key !== null && frontierKeys.has(entry.series_key) && entry.status === 'ELIGIBLE'
        ? { ...entry, status: 'AMBIGUOUS' as const, reason: 'empate ou trade-off não dominado na fronteira de utilidade' }
        : entry,
    );
    return fallback(
      input,
      minimumSampleSize,
      ambiguous,
      `${frontier.length} séries permanecem empatadas ou ambíguas sem pesos autorizados`,
    );
  }

  const selected = frontier[0]!;
  const seriesKey = selected.series.identity.series_key!;
  const duration = selected.series.aggregations.duration_ms;
  if (!available(duration, minimumSampleSize)) {
    return fallback(input, minimumSampleSize, considerations, 'distribuição de duração selecionada deixou de ser suficiente');
  }
  if (!Number.isSafeInteger(duration.value.p90)) {
    return fallback(input, minimumSampleSize, considerations, 'p90 observado não é um inteiro seguro de milissegundos');
  }
  const budget = HistoryWorkerRuntimeBudget.parse({
    kind: 'HISTORY_DERIVED_WORKER_RUNTIME_BUDGET',
    milliseconds: duration.value.p90,
    statistic: 'observed_duration_ms_p90',
    observed_distribution: duration.value,
    sample_size: duration.sample_size,
    checked_runtime_bounds: selected.candidate.runtime_bounds,
    provenance: [
      `PerformanceSeries(${seriesKey}).aggregations.duration_ms`,
      'NumericDistribution.p90 (nearest-rank observado por M81)',
      'RoutingCandidate.runtime_bounds (WORKER_RUNTIME_BOUND only)',
    ],
  });
  const violatedBounds = selected.candidate.runtime_bounds.filter(
    (bound) => budget.milliseconds > bound.maximum_ms,
  );
  const evidence = {
    query_minimum_sample_size: input.history.minimum_sample_size,
    decision_minimum_sample_size: minimumSampleSize,
    selected_series_key: seriesKey,
    selected_series_sample_size: selected.series.aggregations.trials.sample_size,
    aggregations_considered: [...HISTORY_UTILITY_AGGREGATIONS],
    series_considered: considerations,
  };
  const common = {
    schema_version: 1 as const,
    source: 'HISTORY' as const,
    fallback: null,
    evidence,
    rationale: [
      `série=${seriesKey} profile=${selected.capability.profile_id} é a única dominante sem pesos inventados`,
      `minimum_sample_size=${minimumSampleSize}; menor amostra de métrica=${selected.minimumMetricSampleSize}`,
      `budget=${budget.milliseconds}ms deriva diretamente do p90 da duração observada; não substitui decomposição/capacidade exigida por M78`,
    ],
    provenance: [
      `PerformanceHistoryQueryResult.series[series_key=${seriesKey}]`,
      `PerformanceSeries.trial_ids=${selected.series.trial_ids.join(',')}`,
      `PerformanceSeries.run_ids=${selected.series.run_ids.join(',')}`,
      ...HISTORY_UTILITY_AGGREGATIONS.map((name) => `SeriesAggregations.${name}`),
      'routeInitialProfile(M78) usado para elegibilidade estrutural do profile isolado',
    ],
  };

  if (violatedBounds.length > 0) {
    return HistoryInformedRoutingResult.parse({
      ...common,
      recommendation: {
        outcome: 'BUDGET_UNSUPPORTED',
        profile: selected.capability,
        worker_runtime_budget: budget,
        violations: violatedBounds.map((bound) => ({
          profile_id: selected.capability.profile_id,
          requested_budget_ms: budget.milliseconds,
          violated_bound: bound,
          provenance: [...budget.provenance, bound.provenance],
        })),
        allowed_next_steps: [
          'TRY_ANOTHER_PROFILE',
          'RECONFIGURE_RUNTIME',
          'REPLAN',
          'HUMAN_REQUIRED',
        ],
        series_key: seriesKey,
      },
    });
  }

  return HistoryInformedRoutingResult.parse({
    ...common,
    recommendation: {
      outcome: 'ROUTED',
      profile: selected.capability,
      worker_runtime_budget: budget,
      series_key: seriesKey,
    },
  });
}

/** Nome curto para consumidores que tratam a camada como router próprio. */
export const routeHistoryInformedProfile = routeInitialProfileWithHistory;
