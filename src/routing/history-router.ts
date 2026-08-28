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

/**
 * Dimensões de CUSTO que dependem de instrumento externo ao harness: o medidor
 * de assinatura do provider e a estimativa de equivalência em dólar da CLI.
 *
 * Elas são OPCIONAIS por um motivo empírico. Nenhum profile Codex de
 * assinatura expõe medidor de conta, e nenhum profile subscription-only reporta
 * custo de API — exigi-las tornava a evidência histórica desses profiles
 * permanentemente insuficiente, ou seja, tornava o aprendizado impossível
 * exatamente onde ele era mais necessário. A ausência descrevia o instrumento,
 * não a execução.
 *
 * A regra que substitui a exigência não inventa nada: uma dimensão opcional só
 * participa da comparação quando é conhecida para TODAS as séries elegíveis.
 * Conhecida para umas e ausente para outras, ela é OMITIDA e registrada — pois
 * comparar um número observado contra um UNKNOWN só poderia inventar o lado
 * ausente ou penalizar quem não tem medidor.
 */
export const OPTIONAL_HISTORY_UTILITY_DIMENSIONS = [
  'quota_consumed_pp_p90_total',
  'api_equivalent_usd_p90',
] as const;
export type OptionalHistoryUtilityDimension = (typeof OPTIONAL_HISTORY_UTILITY_DIMENSIONS)[number];

const HistoryUtility = z
  .object({
    first_pass_rate: z.number().min(0).max(1),
    final_pass_rate: z.number().min(0).max(1),
    repair_rate: z.number().min(0),
    escalation_rate: z.number().min(0),
    duration_p90_ms: z.number().nonnegative(),
    total_tokens_p90: z.number().nonnegative(),
    /** `null` é UNKNOWN observado: o provider não expõe medidor de assinatura. */
    quota_consumed_pp_p90_total: z.number().nonnegative().nullable(),
    /** `null` é UNKNOWN observado: run de assinatura não reporta custo de API. */
    api_equivalent_usd_p90: z.number().nonnegative().nullable(),
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
    /** Dimensões opcionais que ficaram fora da comparação, com o motivo. */
    dimensions_omitted: z
      .array(z.object({ dimension: nonEmpty, reason: nonEmpty }).strict())
      .default([]),
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

/**
 * Previsão derivada da HISTÓRIA: o p90 da duração observada em execuções
 * comparáveis. Continua sendo previsão — nada aqui autoriza, rejeita ou
 * encerra. Sem `checked_runtime_bounds`: não há mais bound contra o qual
 * comparar, porque a previsão deixou de ter poder de recusa.
 */
export const HistoryExecutionRuntimeForecast = z
  .object({
    kind: z.literal('HISTORY_DERIVED_EXECUTION_RUNTIME_FORECAST'),
    authority: z.literal('ADVISORY'),
    predicted_runtime_ms: z.number().int().nonnegative(),
    statistic: z.literal('observed_duration_ms_p90'),
    observed_distribution: NumericDistributionSchema,
    sample_size: z.number().int().positive(),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type HistoryExecutionRuntimeForecast = z.infer<typeof HistoryExecutionRuntimeForecast>;

export const HistoryRoutingRecommendation = z
  .object({
    outcome: z.literal('ROUTED'),
    profile: ProfileCapability,
    execution_runtime_forecast: HistoryExecutionRuntimeForecast,
    series_key: sha256,
  })
  .strict();
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

  // Dimensões de custo: ausentes ficam `null` e SAEM da comparação mais
  // adiante. Ausência aqui nunca desqualifica a série — ela só descreve que
  // este provider não tem o instrumento correspondente.
  const quotaAvailable =
    available(aggregates.quota, minimumSampleSize) &&
    aggregates.quota.value.length > 0 &&
    aggregates.quota.value.every((window) => available(window.consumed_pp, minimumSampleSize));
  const quotaWindows = quotaAvailable ? aggregates.quota.value : [];
  const costAvailable = available(aggregates.api_equivalent_usd, minimumSampleSize);

  const sampleSizes = [
    ...required.map(([, metric]) => metric.sample_size),
    ...(quotaAvailable ? [aggregates.quota.sample_size] : []),
    ...quotaWindows.map((window) => window.consumed_pp.sample_size),
    ...(costAvailable ? [aggregates.api_equivalent_usd.sample_size] : []),
  ];
  const firstPassRate = aggregates.first_operational_pass_rate.value!;
  const finalPassRate = aggregates.final_pass_rate.value!;
  const repairRate = aggregates.repair_rate.value!;
  const escalationRate = aggregates.escalation_rate.value!;
  const durationDistribution = aggregates.duration_ms.value!;
  const tokenDistribution = aggregates.tokens.total.value!;
  const costDistribution = costAvailable ? aggregates.api_equivalent_usd.value : null;
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
      quota_consumed_pp_p90_total: quotaAvailable
        ? quotaWindows.reduce((total, window) => total + (window.consumed_pp.value?.p90 ?? 0), 0)
        : null,
      api_equivalent_usd_p90: costDistribution === null ? null : costDistribution.p90,
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
const REQUIRED_MINIMIZE: readonly (keyof HistoryUtility)[] = [
  'repair_rate',
  'escalation_rate',
  'duration_p90_ms',
  'total_tokens_p90',
  'human_intervention_rate',
];

function numberAt(utility: HistoryUtility, key: keyof HistoryUtility): number {
  return utility[key] as number;
}

/**
 * Dominância de Pareto sobre as dimensões ATIVAS: nenhuma ponderação, nenhuma
 * precisão externa aos dados e nenhuma dimensão comparada contra um UNKNOWN.
 */
function dominates(
  left: HistoryUtility,
  right: HistoryUtility,
  minimize: readonly (keyof HistoryUtility)[],
): boolean {
  const noWorse =
    maximize.every((key) => numberAt(left, key) >= numberAt(right, key)) &&
    minimize.every((key) => numberAt(left, key) <= numberAt(right, key));
  const strictlyBetter =
    maximize.some((key) => numberAt(left, key) > numberAt(right, key)) ||
    minimize.some((key) => numberAt(left, key) < numberAt(right, key));
  return noWorse && strictlyBetter;
}

/**
 * Uma dimensão opcional só entra na comparação quando é conhecida para TODAS
 * as séries elegíveis. Conhecida só para algumas, ela é omitida com motivo —
 * nem inventar o lado ausente, nem punir quem não tem o instrumento.
 */
function activeMinimizeDimensions(eligible: readonly EligibleSeries[]): {
  readonly minimize: readonly (keyof HistoryUtility)[];
  readonly omitted: readonly { readonly dimension: string; readonly reason: string }[];
} {
  const omitted: { dimension: string; reason: string }[] = [];
  const optional: (keyof HistoryUtility)[] = [];
  for (const dimension of OPTIONAL_HISTORY_UTILITY_DIMENSIONS) {
    const missing = eligible.filter((entry) => entry.utility[dimension] === null);
    if (missing.length === 0) {
      optional.push(dimension);
      continue;
    }
    omitted.push({
      dimension,
      reason:
        missing.length === eligible.length
          ? `UNKNOWN em todas as ${eligible.length} séries elegíveis: dimensão fora da comparação, nunca substituída por zero`
          : `UNKNOWN em ${missing.length} de ${eligible.length} séries elegíveis (${missing
              .map((entry) => entry.capability.profile_id)
              .sort()
              .join(', ')}): comparar observado contra UNKNOWN inventaria o lado ausente`,
    });
  }
  return { minimize: [...REQUIRED_MINIMIZE, ...optional], omitted };
}

function fallback(
  input: HistoryRoutingInput,
  minimumSampleSize: number,
  considerations: readonly HistorySeriesConsideration[],
  reason: string,
  dimensionsOmitted: readonly { readonly dimension: string; readonly reason: string }[] = [],
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
      dimensions_omitted: dimensionsOmitted,
    },
    rationale: [
      reason,
      `histórico não decidiu; fallback determinístico para M78 com minimum_sample_size=${minimumSampleSize}`,
    ],
    provenance: ['PerformanceHistoryQueryResult(M81, read-only)', 'routeInitialProfile(M78)'],
  });
}

/**
 * Recomenda profile e previsão ADVISORY de runtime somente quando uma série
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
          ...(input.selection_policy === undefined
            ? {}
            : { selection_policy: input.selection_policy }),
          ...(input.evidence_balance === undefined
            ? {}
            : { evidence_balance: input.evidence_balance }),
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
    const currentlyUnavailable =
      profileId !== null && !structurallyEligibleProfileIds.has(profileId)
        ? 'profile histórico não está elegível na observação operacional atual'
        : null;
    const trialSampleSize = series.aggregations.trials.sample_size;
    if (
      compatibility !== null ||
      currentlyUnavailable !== null ||
      candidate === undefined ||
      capability === undefined
    ) {
      considerations.push({
        series_key: series.identity.series_key,
        profile_id: profileId,
        trial_sample_size: trialSampleSize,
        minimum_metric_sample_size: 0,
        status: 'INCOMPATIBLE',
        reason: compatibility ?? currentlyUnavailable ?? 'profile/candidate ausente',
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
  const dimensions = activeMinimizeDimensions(eligible);
  const frontier = eligible.filter(
    (candidate) =>
      !eligible.some(
        (other) => other !== candidate && dominates(other.utility, candidate.utility, dimensions.minimize),
      ),
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
      dimensions.omitted,
    );
  }

  const selected = frontier[0]!;
  const seriesKey = selected.series.identity.series_key!;
  const duration = selected.series.aggregations.duration_ms;
  if (!available(duration, minimumSampleSize)) {
    return fallback(
      input,
      minimumSampleSize,
      considerations,
      'distribuição de duração selecionada deixou de ser suficiente',
      dimensions.omitted,
    );
  }
  if (!Number.isSafeInteger(duration.value.p90)) {
    return fallback(
      input,
      minimumSampleSize,
      considerations,
      'p90 observado não é um inteiro seguro de milissegundos',
      dimensions.omitted,
    );
  }
  const forecast = HistoryExecutionRuntimeForecast.parse({
    kind: 'HISTORY_DERIVED_EXECUTION_RUNTIME_FORECAST',
    authority: 'ADVISORY',
    predicted_runtime_ms: duration.value.p90,
    statistic: 'observed_duration_ms_p90',
    observed_distribution: duration.value,
    sample_size: duration.sample_size,
    provenance: [
      `PerformanceSeries(${seriesKey}).aggregations.duration_ms`,
      'NumericDistribution.p90 (nearest-rank observado por M81)',
      'ADVISORY: hipótese de duração; não autoriza, não rejeita e não encerra nada',
    ],
  });
  const evidence = {
    query_minimum_sample_size: input.history.minimum_sample_size,
    decision_minimum_sample_size: minimumSampleSize,
    selected_series_key: seriesKey,
    selected_series_sample_size: selected.series.aggregations.trials.sample_size,
    aggregations_considered: [...HISTORY_UTILITY_AGGREGATIONS],
    series_considered: considerations,
    dimensions_omitted: dimensions.omitted,
  };
  const common = {
    schema_version: 1 as const,
    source: 'HISTORY' as const,
    fallback: null,
    evidence,
    rationale: [
      `série=${seriesKey} profile=${selected.capability.profile_id} é a única dominante sem pesos inventados`,
      `minimum_sample_size=${minimumSampleSize}; menor amostra de métrica=${selected.minimumMetricSampleSize}`,
      dimensions.omitted.length === 0
        ? 'todas as dimensões de utilidade participaram da comparação'
        : `dimensões omitidas por UNKNOWN observado: ${dimensions.omitted.map((entry) => entry.dimension).join(', ')}`,
      `previsão=${forecast.predicted_runtime_ms}ms deriva do p90 da duração observada; é ADVISORY e não substitui decomposição/capacidade exigida por M78`,
    ],
    provenance: [
      `PerformanceHistoryQueryResult.series[series_key=${seriesKey}]`,
      `PerformanceSeries.trial_ids=${selected.series.trial_ids.join(',')}`,
      `PerformanceSeries.run_ids=${selected.series.run_ids.join(',')}`,
      ...HISTORY_UTILITY_AGGREGATIONS.map((name) => `SeriesAggregations.${name}`),
      'routeInitialProfile(M78) usado para elegibilidade estrutural do profile isolado',
    ],
  };

  return HistoryInformedRoutingResult.parse({
    ...common,
    recommendation: {
      outcome: 'ROUTED',
      profile: selected.capability,
      execution_runtime_forecast: forecast,
      series_key: seriesKey,
    },
  });
}

/** Nome curto para consumidores que tratam a camada como router próprio. */
export const routeHistoryInformedProfile = routeInitialProfileWithHistory;
