/**
 * Consulta estritamente read-only de performance histórica. A camada lê a
 * história selada com `readTrialHistory`, delega métricas de trial a
 * `derivePerformance` e apenas agrega os records derivados.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { QualificationStatus } from '../core/enums.js';
import { canonicalSha256 } from '../envelope/index.js';
import type { RunPerformanceRecord, TaskPerformanceRecord } from '../schemas/performance.js';
import type { QuotaUsage } from '../schemas/quota-usage.js';
import { AttemptRole, type AttemptFacts } from './attempt-facts.js';
import {
  COMPARABLE_FACT_UNKNOWN,
  COMPARABLE_RUN_FACTS_FILE_NAME,
  ComparableRunFacts,
  ComparableRunIdentity,
  type ComparableRunIdentity as ComparableRunIdentityValue,
  type ComparableRunFacts as ComparableRunFactsValue,
  unknownComparableRunFacts,
} from './comparable-run.js';
import { derivePerformance } from './derive-performance.js';
import {
  readTrialHistory,
  type EvaluationSelection,
  type ExcludedRun,
  type RunReadResult,
} from './history.js';

const EXECUTION_DIR = 'execution';

export type AggregationStatus = 'AVAILABLE' | 'INSUFFICIENT_SAMPLE' | 'UNAVAILABLE';

export interface EvidenceAggregation<T> {
  readonly value: T | null;
  readonly sample_size: number;
  readonly population_size: number;
  readonly status: AggregationStatus;
  readonly reason: string | null;
  readonly provenance: readonly string[];
}

export interface NumericDistribution {
  readonly values: readonly number[];
  readonly total: number;
  readonly mean: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly max: number;
}

export interface TrialPerformanceQuery {
  readonly trial_id: string;
  readonly selection?: EvaluationSelection;
}

export interface PerformanceHistoryFilter {
  readonly task_class?: string;
  readonly difficulty?: string;
  readonly stack?: readonly string[];
  readonly profile_id?: string;
  readonly profile_fingerprint_sha256?: string;
}

export interface PerformanceHistoryQueryInput {
  readonly schema_version?: 1;
  readonly runs_dir: string;
  readonly trials: readonly TrialPerformanceQuery[];
  readonly minimum_sample_size: number;
  readonly filter?: PerformanceHistoryFilter;
}

export interface PerformanceHistoryQueryInputV2 {
  readonly schema_version: 2;
  readonly runs_dir: string;
  readonly trials: readonly TrialPerformanceQuery[];
  readonly minimum_sample_size: number;
  readonly work_definition_fingerprint_sha256?: string;
  /** Policy corrente: filtra séries retornadas sem amputar lifecycle do episódio. */
  readonly eligible_profile_ids?: readonly string[];
  readonly filter?: PerformanceHistoryFilter;
}

export interface QueryExcludedRun extends ExcludedRun {
  readonly trial_id: string;
}

export interface QueryExcludedTrial {
  readonly trial_id: string;
  readonly reason: string;
}

export interface ComparableFactsIssue {
  readonly trial_id: string;
  readonly run_id: string;
  readonly reason: string;
}

export interface QualificationAggregation {
  readonly counts: EvidenceAggregation<Readonly<Record<string, number>>>;
  readonly qualified_rate: EvidenceAggregation<number>;
}

export interface QuotaWindowAggregation {
  readonly provider: string;
  readonly window_id: string;
  readonly consumed_pp: EvidenceAggregation<NumericDistribution>;
}

export interface SeriesAggregations {
  readonly trials: EvidenceAggregation<number>;
  readonly attempts: {
    readonly operational: EvidenceAggregation<number>;
    readonly with_inference: EvidenceAggregation<number>;
    readonly without_inference: EvidenceAggregation<number>;
    readonly inference_unknown: EvidenceAggregation<number>;
    readonly infra_error: EvidenceAggregation<number>;
  };
  readonly first_operational_pass_rate: EvidenceAggregation<number>;
  readonly first_inference_bearing_pass_rate: EvidenceAggregation<number>;
  readonly final_pass_rate: EvidenceAggregation<number>;
  readonly repair_rate: EvidenceAggregation<number>;
  readonly escalation_rate: EvidenceAggregation<number>;
  readonly duration_ms: EvidenceAggregation<NumericDistribution>;
  readonly tokens: {
    readonly total: EvidenceAggregation<NumericDistribution>;
    readonly input: EvidenceAggregation<NumericDistribution>;
    readonly cached_input: EvidenceAggregation<NumericDistribution>;
    readonly fresh_input: EvidenceAggregation<NumericDistribution>;
    readonly output: EvidenceAggregation<NumericDistribution>;
    readonly reasoning: EvidenceAggregation<NumericDistribution>;
  };
  readonly quota: EvidenceAggregation<readonly QuotaWindowAggregation[]>;
  readonly api_equivalent_usd: EvidenceAggregation<NumericDistribution>;
  readonly human_intervention_rate: EvidenceAggregation<number>;
  readonly qualification: QualificationAggregation;
  readonly context_pressure: EvidenceAggregation<Readonly<Record<string, number>>>;
}

export interface PerformanceSeries {
  readonly identity: ComparableRunIdentityValue;
  readonly automatic_merge_eligible: boolean;
  readonly trial_ids: readonly string[];
  readonly run_ids: readonly string[];
  readonly aggregations: SeriesAggregations;
}

export interface PerformanceHistoryQueryResult {
  readonly schema_version: 1;
  readonly minimum_sample_size: number;
  readonly series: readonly PerformanceSeries[];
  readonly excluded_runs: readonly QueryExcludedRun[];
  readonly excluded_trials: readonly QueryExcludedTrial[];
  readonly comparable_facts_issues: readonly ComparableFactsIssue[];
}

export interface EpisodePerformance {
  readonly execution_episode_id: string;
  readonly work_definition_fingerprint_sha256: string;
  readonly initial_profile_id: string;
  readonly initial_profile_fingerprint_sha256: string;
  readonly trial_ids: readonly string[];
  readonly run_ids: readonly string[];
  readonly performance: TaskPerformanceRecord;
}

export interface RoleExecutionAggregations {
  readonly run_ids: readonly string[];
  readonly runs: EvidenceAggregation<number>;
  readonly with_inference: EvidenceAggregation<number>;
  readonly duration_ms: EvidenceAggregation<NumericDistribution>;
  readonly tokens: SeriesAggregations['tokens'];
  readonly quota: EvidenceAggregation<readonly QuotaWindowAggregation[]>;
  readonly api_equivalent_usd: EvidenceAggregation<NumericDistribution>;
  readonly qualification: QualificationAggregation;
  readonly context_pressure: EvidenceAggregation<Readonly<Record<string, number>>>;
}

export interface ComparableProfileSeriesV2 {
  readonly identity: ComparableRunIdentityValue;
  readonly automatic_merge_eligible: boolean;
  readonly initial_routing_eligible: boolean;
  readonly episode_ids: readonly string[];
  readonly trial_ids: readonly string[];
  readonly run_ids: readonly string[];
  readonly execution_by_role: {
    readonly INITIAL: RoleExecutionAggregations;
    readonly REPAIR: RoleExecutionAggregations;
    readonly ESCALATION: RoleExecutionAggregations;
    readonly UNKNOWN: RoleExecutionAggregations;
  };
  readonly routing_aggregations: SeriesAggregations;
}

export interface QueryExcludedEpisode {
  readonly execution_episode_id: string;
  readonly reason: string;
}

export interface PerformanceHistoryQueryResultV2 {
  readonly schema_version: 2;
  readonly minimum_sample_size: number;
  readonly episodes: readonly EpisodePerformance[];
  readonly series: readonly ComparableProfileSeriesV2[];
  readonly excluded_runs: readonly QueryExcludedRun[];
  readonly excluded_trials: readonly QueryExcludedTrial[];
  readonly excluded_episodes: readonly QueryExcludedEpisode[];
  readonly comparable_facts_issues: readonly ComparableFactsIssue[];
}

interface TrialObservation {
  readonly trial_id: string;
  readonly task: TaskPerformanceRecord;
  readonly runs: readonly RunReadResult[];
  readonly facts: readonly ComparableRunFactsValue[];
  readonly identity: ComparableRunIdentityValue;
}

interface EpisodeRunObservation {
  readonly run: RunReadResult;
  readonly facts: ComparableRunFactsValue;
  readonly identity: ComparableRunIdentityValue;
}

interface EpisodeObservation {
  readonly episode: EpisodePerformance;
  readonly initialIdentity: ComparableRunIdentityValue;
  readonly runs: readonly EpisodeRunObservation[];
}

function known<T>(value: T, provenance: string) {
  return { value, provenance };
}

function unknown(provenance: string) {
  return { value: COMPARABLE_FACT_UNKNOWN, provenance } as const;
}

/** Deriva a identidade sem consultar I/O e sem inferir dimensões ausentes. */
export function deriveComparableRunIdentity(
  performance: RunPerformanceRecord,
  facts: ComparableRunFactsValue,
): ComparableRunIdentityValue {
  const taxonomy = performance.identity.taxonomy;
  const reasoning = performance.identity.reasoning_effort;
  const dimensions = {
    task: {
      task_class:
        taxonomy === undefined
          ? unknown('RunPerformanceRecord.identity.taxonomy_not_recorded')
          : known(taxonomy.task_class, 'RunPerformanceRecord.identity.taxonomy.task_class'),
      difficulty:
        taxonomy === undefined
          ? unknown('RunPerformanceRecord.identity.taxonomy_not_recorded')
          : known(taxonomy.difficulty, 'RunPerformanceRecord.identity.taxonomy.difficulty'),
      stack: known(performance.identity.stack, 'RunPerformanceRecord.identity.stack'),
    },
    profile: {
      profile_id: facts.profile_id,
      profile_fingerprint_sha256: facts.profile_fingerprint_sha256,
    },
    execution: {
      provider: facts.provider,
      agent_cli: known(performance.identity.agent_cli, 'RunPerformanceRecord.identity.agent_cli'),
      model: known(performance.identity.model, 'RunPerformanceRecord.identity.model'),
      reasoning_effort:
        reasoning.value === null
          ? unknown(reasoning.provenance)
          : known(reasoning.value, reasoning.provenance),
      transport: facts.transport,
      worker_role: facts.worker_role,
      strategy_name: known(
        performance.identity.strategy.name,
        'RunPerformanceRecord.identity.strategy.name',
      ),
      strategy_version: known(
        performance.identity.strategy.version,
        'RunPerformanceRecord.identity.strategy.version',
      ),
      environment_profile_id: known(
        performance.identity.environment_profile.id,
        'RunPerformanceRecord.identity.environment_profile.id',
      ),
      environment_mode: known(
        performance.identity.environment_profile.mode,
        'RunPerformanceRecord.identity.environment_profile.mode',
      ),
    },
    context: {
      context_pressure: facts.context_pressure,
      environment_readiness: facts.environment_readiness,
    },
  };

  const required: readonly [string, { readonly value: unknown }][] = [
    ['task.task_class', dimensions.task.task_class],
    ['task.difficulty', dimensions.task.difficulty],
    ['task.stack', dimensions.task.stack],
    ['profile.profile_id', dimensions.profile.profile_id],
    ['profile.profile_fingerprint_sha256', dimensions.profile.profile_fingerprint_sha256],
    ['execution.provider', dimensions.execution.provider],
    ['execution.agent_cli', dimensions.execution.agent_cli],
    ['execution.model', dimensions.execution.model],
    ['execution.reasoning_effort', dimensions.execution.reasoning_effort],
    ['execution.transport', dimensions.execution.transport],
    ['execution.worker_role', dimensions.execution.worker_role],
    ['execution.strategy_name', dimensions.execution.strategy_name],
    ['execution.strategy_version', dimensions.execution.strategy_version],
    ['execution.environment_profile_id', dimensions.execution.environment_profile_id],
    ['execution.environment_mode', dimensions.execution.environment_mode],
    ['context.context_pressure', dimensions.context.context_pressure],
    ['context.environment_readiness', dimensions.context.environment_readiness],
  ];
  const blocking = required
    .filter(([, fact]) => fact.value === COMPARABLE_FACT_UNKNOWN)
    .map(([name]) => name);
  const comparisonPayload = {
    schema_version: 1,
    task: valuesOf(dimensions.task),
    profile: valuesOf(dimensions.profile),
    execution: valuesOf(dimensions.execution),
    context: valuesOf(dimensions.context),
  };

  return ComparableRunIdentity.parse({
    schema_version: 1,
    ...dimensions,
    comparable: blocking.length === 0,
    blocking_unknown_dimensions: blocking,
    series_key: blocking.length === 0 ? canonicalSha256(comparisonPayload) : null,
  });
}

function valuesOf(facts: Readonly<Record<string, { readonly value: unknown }>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(facts).map(([key, fact]) => [key, fact.value]));
}

/**
 * Única entrada com I/O. Lê os artifacts selados, nunca cria diretório,
 * arquivo, índice, migration ou cache.
 */
export function queryPerformanceHistory(
  input: PerformanceHistoryQueryInput,
): Promise<PerformanceHistoryQueryResult>;
export function queryPerformanceHistory(
  input: PerformanceHistoryQueryInputV2,
): Promise<PerformanceHistoryQueryResultV2>;
export function queryPerformanceHistory(
  input: PerformanceHistoryQueryInput | PerformanceHistoryQueryInputV2,
): Promise<PerformanceHistoryQueryResult | PerformanceHistoryQueryResultV2> {
  return input.schema_version === 2
    ? queryPerformanceHistoryV2(input)
    : queryPerformanceHistoryV1(input);
}

async function queryPerformanceHistoryV1(
  input: PerformanceHistoryQueryInput,
): Promise<PerformanceHistoryQueryResult> {
  if (!Number.isInteger(input.minimum_sample_size) || input.minimum_sample_size < 1) {
    throw new RangeError('minimum_sample_size deve ser inteiro positivo');
  }
  const duplicate = duplicateTrialId(input.trials);
  if (duplicate !== null) throw new Error(`trial_id duplicado na consulta: ${duplicate}`);

  const observations: TrialObservation[] = [];
  const excludedRuns: QueryExcludedRun[] = [];
  const excludedTrials: QueryExcludedTrial[] = [];
  const factsIssues: ComparableFactsIssue[] = [];

  for (const trial of input.trials) {
    const read = await readTrialHistory(input.runs_dir, trial.trial_id, trial.selection ?? {});
    excludedRuns.push(
      ...read.excludedRuns.map((run) => ({ trial_id: trial.trial_id, ...run })),
    );
    if (read.runs.length === 0) {
      excludedTrials.push({ trial_id: trial.trial_id, reason: 'nenhum run histórico legível' });
      continue;
    }

    const facts: ComparableRunFactsValue[] = [];
    for (const run of read.runs) {
      const result = await readComparableFacts(input.runs_dir, run.run_id);
      facts.push(result.facts);
      if (result.issue !== null) {
        factsIssues.push({ trial_id: trial.trial_id, run_id: run.run_id, reason: result.issue });
      }
    }

    const enrichedAttempts = read.history.attempts.map((attempt, index) =>
      applyRecordedAttemptRole(attempt, facts[index]),
    );
    const task = derivePerformance({ ...read.history, attempts: enrichedAttempts });
    const anchorRun = read.runs[0] as RunReadResult;
    const anchorFacts = facts[0] as ComparableRunFactsValue;
    const identity = deriveComparableRunIdentity(anchorRun.performance, anchorFacts);
    if (!matchesFilter(identity, input.filter)) continue;
    observations.push({ trial_id: trial.trial_id, task, runs: read.runs, facts, identity });
  }

  return {
    schema_version: 1,
    minimum_sample_size: input.minimum_sample_size,
    series: aggregateObservations(observations, input.minimum_sample_size),
    excluded_runs: excludedRuns,
    excluded_trials: excludedTrials,
    comparable_facts_issues: factsIssues,
  };
}

async function queryPerformanceHistoryV2(
  input: PerformanceHistoryQueryInputV2,
): Promise<PerformanceHistoryQueryResultV2> {
  validateQueryInput(input.minimum_sample_size, input.trials);
  const excludedRuns: QueryExcludedRun[] = [];
  const excludedTrials: QueryExcludedTrial[] = [];
  const excludedEpisodes: QueryExcludedEpisode[] = [];
  const factsIssues: ComparableFactsIssue[] = [];
  const candidates = new Map<string, EpisodeRunObservation[]>();

  for (const trial of input.trials) {
    const read = await readTrialHistory(input.runs_dir, trial.trial_id, trial.selection ?? {});
    excludedRuns.push(...read.excludedRuns.map((run) => ({ trial_id: trial.trial_id, ...run })));
    if (read.runs.length === 0) {
      excludedTrials.push({ trial_id: trial.trial_id, reason: 'nenhum run histórico legível' });
      continue;
    }
    for (const run of read.runs) {
      const context = run.history_context;
      if (context === null) {
        excludedRuns.push({
          trial_id: trial.trial_id,
          run_id: run.run_id,
          reason: 'RunRecord histórico não possui RunHistoryContextV1',
        });
        continue;
      }
      if (
        input.work_definition_fingerprint_sha256 !== undefined &&
        context.work_definition_fingerprint_sha256 !== input.work_definition_fingerprint_sha256
      ) {
        continue;
      }
      if (
        run.performance.identity.evaluation_id !== context.selection.evaluation_id ||
        run.performance.identity.score_id !== context.selection.score_id
      ) {
        excludedRuns.push({
          trial_id: trial.trial_id,
          run_id: run.run_id,
          reason: 'EvaluationSelection fornecida diverge da seleção pinada no RunHistoryContextV1',
        });
        continue;
      }
      const result = await readComparableFacts(input.runs_dir, run.run_id);
      if (result.issue !== null) {
        factsIssues.push({ trial_id: trial.trial_id, run_id: run.run_id, reason: result.issue });
      }
      const enrichedRun: RunReadResult = {
        ...run,
        facts: applyHistoryContextInference(
          applyRecordedAttemptRole(run.facts, result.facts),
          context.observed_had_inference,
        ),
      };
      const identity = deriveComparableRunIdentity(enrichedRun.performance, result.facts);
      const observation = { run: enrichedRun, facts: result.facts, identity };
      const episodeRuns = candidates.get(context.execution_episode_id);
      if (episodeRuns === undefined) candidates.set(context.execution_episode_id, [observation]);
      else episodeRuns.push(observation);
    }
  }

  const episodes: EpisodeObservation[] = [];
  for (const [episodeId, unordered] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...unordered].sort(
      (left, right) =>
        left.run.history_context!.episode_attempt_ordinal - right.run.history_context!.episode_attempt_ordinal,
    );
    const contexts = ordered.map((item) => item.run.history_context!);
    const first = contexts[0]!;
    const ordinals = contexts.map((context) => context.episode_attempt_ordinal);
    const coherent = contexts.every(
      (context) =>
        context.work_definition_fingerprint_sha256 === first.work_definition_fingerprint_sha256 &&
        context.initial_profile_id === first.initial_profile_id &&
        context.initial_profile_fingerprint_sha256 === first.initial_profile_fingerprint_sha256,
    );
    if (!coherent || new Set(ordinals).size !== ordinals.length) {
      excludedEpisodes.push({
        execution_episode_id: episodeId,
        reason: coherent
          ? 'episode_attempt_ordinal duplicado'
          : 'RunHistoryContextV1 divergente dentro do episódio',
      });
      continue;
    }
    const initial = ordered.find(
      (item) =>
        item.facts.attempt_role.value === AttemptRole.INITIAL &&
        item.identity.profile.profile_id.value === first.initial_profile_id &&
        item.identity.profile.profile_fingerprint_sha256.value ===
          first.initial_profile_fingerprint_sha256,
    );
    if (initial === undefined) {
      excludedEpisodes.push({
        execution_episode_id: episodeId,
        reason: 'episódio não possui INITIAL compatível com a identidade inicial pinada',
      });
      continue;
    }
    const performance = derivePerformance({
      task_id: initial.run.performance.identity.task_id,
      trial_id: episodeId,
      attempts: ordered.map((item) => item.run.facts),
    });
    episodes.push({
      initialIdentity: initial.identity,
      runs: ordered,
      episode: {
        execution_episode_id: episodeId,
        work_definition_fingerprint_sha256: first.work_definition_fingerprint_sha256,
        initial_profile_id: first.initial_profile_id,
        initial_profile_fingerprint_sha256: first.initial_profile_fingerprint_sha256,
        trial_ids: unique(ordered.map((item) => item.run.trial_id)),
        run_ids: ordered.map((item) => item.run.run_id),
        performance,
      },
    });
  }

  return {
    schema_version: 2,
    minimum_sample_size: input.minimum_sample_size,
    episodes: episodes.map((item) => item.episode),
    series: aggregateProfileSeriesV2(
      episodes,
      [...candidates.values()].flat(),
      input.minimum_sample_size,
      input.filter,
      input.eligible_profile_ids,
    ),
    excluded_runs: excludedRuns,
    excluded_trials: excludedTrials,
    excluded_episodes: excludedEpisodes,
    comparable_facts_issues: factsIssues,
  };
}

function applyHistoryContextInference(
  attempt: AttemptFacts,
  observed: { readonly value: boolean; readonly provenance: string } | undefined,
): AttemptFacts {
  return observed === undefined ? attempt : { ...attempt, had_inference: observed };
}

function validateQueryInput(
  minimumSampleSize: number,
  trials: readonly TrialPerformanceQuery[],
): void {
  if (!Number.isInteger(minimumSampleSize) || minimumSampleSize < 1) {
    throw new RangeError('minimum_sample_size deve ser inteiro positivo');
  }
  const duplicate = duplicateTrialId(trials);
  if (duplicate !== null) throw new Error(`trial_id duplicado na consulta: ${duplicate}`);
}

function duplicateTrialId(trials: readonly TrialPerformanceQuery[]): string | null {
  const seen = new Set<string>();
  for (const trial of trials) {
    if (seen.has(trial.trial_id)) return trial.trial_id;
    seen.add(trial.trial_id);
  }
  return null;
}

async function readComparableFacts(
  runsDir: string,
  runId: string,
): Promise<{ facts: ComparableRunFactsValue; issue: string | null }> {
  const filePath = path.join(
    runsDir,
    runId,
    EXECUTION_DIR,
    COMPARABLE_RUN_FACTS_FILE_NAME,
  );
  let bytes: string;
  try {
    bytes = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
      return { facts: unknownComparableRunFacts(), issue: null };
    }
    throw error;
  }
  try {
    const parsed = ComparableRunFacts.safeParse(JSON.parse(bytes));
    if (parsed.success) return { facts: parsed.data, issue: null };
    return {
      facts: unknownComparableRunFacts('comparable_run_facts_artifact_invalid'),
      issue: 'comparable-run-facts.json não corresponde ao contrato ComparableRunFacts v1',
    };
  } catch {
    return {
      facts: unknownComparableRunFacts('comparable_run_facts_artifact_invalid'),
      issue: 'comparable-run-facts.json não é JSON válido',
    };
  }
}

function applyRecordedAttemptRole(
  attempt: AttemptFacts,
  facts: ComparableRunFactsValue | undefined,
): AttemptFacts {
  const role = facts?.attempt_role.value;
  if (role === undefined || role === COMPARABLE_FACT_UNKNOWN) return attempt;
  return { ...attempt, attempt_role: role as AttemptRole };
}

function matchesFilter(
  identity: ComparableRunIdentityValue,
  filter: PerformanceHistoryFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (filter.task_class !== undefined && identity.task.task_class.value !== filter.task_class) return false;
  if (filter.difficulty !== undefined && identity.task.difficulty.value !== filter.difficulty) return false;
  if (filter.stack !== undefined) {
    const stack = identity.task.stack.value;
    if (stack === COMPARABLE_FACT_UNKNOWN || JSON.stringify(stack) !== JSON.stringify(filter.stack)) return false;
  }
  if (filter.profile_id !== undefined && identity.profile.profile_id.value !== filter.profile_id) return false;
  if (
    filter.profile_fingerprint_sha256 !== undefined &&
    identity.profile.profile_fingerprint_sha256.value !== filter.profile_fingerprint_sha256
  ) return false;
  return true;
}

function aggregateProfileSeriesV2(
  episodes: readonly EpisodeObservation[],
  observations: readonly EpisodeRunObservation[],
  minimumSampleSize: number,
  filter: PerformanceHistoryFilter | undefined,
  eligibleProfileIds: readonly string[] | undefined,
): ComparableProfileSeriesV2[] {
  const groups = new Map<string, { identity: ComparableRunIdentityValue; runs: EpisodeRunObservation[] }>();
  for (const observation of observations) {
    if (!matchesFilter(observation.identity, filter)) continue;
    const profileId = observation.identity.profile.profile_id.value;
    if (
      eligibleProfileIds !== undefined &&
      (profileId === COMPARABLE_FACT_UNKNOWN || !eligibleProfileIds.includes(profileId))
    ) {
      continue;
    }
    const key = observation.identity.series_key ?? `unmergeable:${observation.run.run_id}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { identity: observation.identity, runs: [observation] });
    else group.runs.push(observation);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => {
      const initialEpisodes = episodes.filter((episode) => {
        const initialKey = episode.initialIdentity.series_key ??
          `unmergeable:${episode.runs.find((run) => run.identity === episode.initialIdentity)?.run.run_id ?? ''}`;
        return initialKey === key;
      });
      const routingTrials: TrialObservation[] = initialEpisodes.map((episode) => {
        const initialRuns = episode.runs.filter(
          (run) =>
            run.facts.attempt_role.value === AttemptRole.INITIAL &&
            run.identity.series_key === episode.initialIdentity.series_key,
        );
        return {
          trial_id: episode.episode.execution_episode_id,
          task: episode.episode.performance,
          runs: initialRuns.map((run) => run.run),
          facts: initialRuns.map((run) => run.facts),
          identity: episode.initialIdentity,
        };
      });
      const roleRuns = (role: AttemptRole) =>
        group.runs.filter((run) => run.facts.attempt_role.value === role);

      return {
        identity: group.identity,
        automatic_merge_eligible: group.identity.comparable,
        initial_routing_eligible: group.identity.comparable && routingTrials.length > 0,
        episode_ids: unique(group.runs.map((run) => run.run.history_context!.execution_episode_id)),
        trial_ids: unique(group.runs.map((run) => run.run.trial_id)),
        run_ids: group.runs.map((run) => run.run.run_id).sort(),
        execution_by_role: {
          INITIAL: aggregateRoleExecution(roleRuns(AttemptRole.INITIAL)),
          REPAIR: aggregateRoleExecution(roleRuns(AttemptRole.REPAIR)),
          ESCALATION: aggregateRoleExecution(roleRuns(AttemptRole.ESCALATION)),
          UNKNOWN: aggregateRoleExecution(roleRuns(AttemptRole.UNKNOWN)),
        },
        routing_aggregations:
          routingTrials.length === 0
            ? emptySeriesAggregations()
            : aggregateSeries(routingTrials, minimumSampleSize).aggregations,
      };
    });
}

function aggregateRoleExecution(
  observations: readonly EpisodeRunObservation[],
): RoleExecutionAggregations {
  const runs = observations.map((item) => item.run);
  const facts = observations.map((item) => item.facts);
  const population = runs.length;
  const token = (pick: (run: RunPerformanceRecord) => { value: number | null; provenance: string }) =>
    numericMetric(runs.map((run) => pick(run.performance)), population);
  const inferenceValues = runs.flatMap((run) =>
    run.facts.had_inference.value === null ? [] : [run.facts.had_inference.value],
  );
  return {
    run_ids: runs.map((run) => run.run_id).sort(),
    runs: population === 0
      ? unavailable(0, ['RunHistoryContextV1.attempt_role'], 'nenhum run para o role')
      : countMetric(population, population, ['RunHistoryContextV1.attempt_role']),
    with_inference: inferenceValues.length === 0
      ? unavailable(population, runs.map((run) => run.facts.had_inference.provenance), 'had_inference não registrado')
      : countMetric(inferenceValues.filter(Boolean).length, inferenceValues.length, runs.map((run) => run.facts.had_inference.provenance)),
    duration_ms: distributionMetric(
      runs.map((run) => run.performance.cost.duration_ms),
      population,
      ['RunPerformanceRecord.cost.duration_ms'],
    ),
    tokens: {
      total: token((run) => run.cost.tokens.total_tokens),
      input: token((run) => run.cost.tokens.input_tokens),
      cached_input: token((run) => run.cost.tokens.cached_input_tokens),
      fresh_input: token((run) => run.cost.tokens.fresh_input_tokens),
      output: token((run) => run.cost.tokens.output_tokens),
      reasoning: token((run) => run.cost.tokens.reasoning_tokens),
    },
    quota: aggregateQuota(runs),
    api_equivalent_usd: token((run) => run.cost.api_equivalent_usd),
    qualification: aggregateQualification(runs, 1),
    context_pressure: categoricalMetric(facts.map((fact) => fact.context_pressure), population),
  };
}

function emptySeriesAggregations(): SeriesAggregations {
  const noCount = unavailable<number>(0, ['RunHistoryContextV1.initial_profile'], 'nenhum episódio iniciado por este profile');
  const noRate = unavailable<number>(0, ['RunHistoryContextV1.initial_profile'], 'nenhum episódio iniciado por este profile');
  const noDistribution = unavailable<NumericDistribution>(0, ['RunHistoryContextV1.initial_profile'], 'nenhum run INITIAL para este profile');
  return {
    trials: noCount,
    attempts: {
      operational: noCount,
      with_inference: noCount,
      without_inference: noCount,
      inference_unknown: noCount,
      infra_error: noCount,
    },
    first_operational_pass_rate: noRate,
    first_inference_bearing_pass_rate: noRate,
    final_pass_rate: noRate,
    repair_rate: noRate,
    escalation_rate: noRate,
    duration_ms: noDistribution,
    tokens: {
      total: noDistribution,
      input: noDistribution,
      cached_input: noDistribution,
      fresh_input: noDistribution,
      output: noDistribution,
      reasoning: noDistribution,
    },
    quota: unavailable(0, ['RunHistoryContextV1.initial_profile'], 'nenhum run INITIAL para este profile'),
    api_equivalent_usd: noDistribution,
    human_intervention_rate: noRate,
    qualification: {
      counts: unavailable(0, ['RunHistoryContextV1.initial_profile'], 'nenhum run INITIAL para este profile'),
      qualified_rate: noRate,
    },
    context_pressure: unavailable(0, ['RunHistoryContextV1.initial_profile'], 'nenhum run INITIAL para este profile'),
  };
}

function aggregateObservations(
  observations: readonly TrialObservation[],
  minimumSampleSize: number,
): PerformanceSeries[] {
  const groups = new Map<string, TrialObservation[]>();
  for (const observation of observations) {
    const key = observation.identity.series_key ?? `unmergeable:${observation.trial_id}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [observation]);
    else group.push(observation);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => aggregateSeries(group, minimumSampleSize));
}

function aggregateSeries(
  trials: readonly TrialObservation[],
  minimumSampleSize: number,
): PerformanceSeries {
  const trialCount = trials.length;
  const runs = trials.flatMap((trial) => trial.runs);
  const taskRecords = trials.map((trial) => trial.task);
  const facts = trials.flatMap((trial) => trial.facts);
  const attemptCounts = taskRecords.map((task) => task.attempts);
  const knownRoleAttempts = sum(attemptCounts.map((item) => item.operational_attempts - item.attempts_role_unknown));

  const token = (pick: (run: RunPerformanceRecord) => { value: number | null; provenance: string }) =>
    numericMetric(runs.map((run) => pick(run.performance)), runs.length);

  return {
    identity: trials[0]!.identity,
    automatic_merge_eligible: trials[0]!.identity.comparable,
    trial_ids: trials.map((trial) => trial.trial_id).sort(),
    run_ids: runs.map((run) => run.run_id).sort(),
    aggregations: {
      trials: countMetric(trialCount, trialCount, ['query.trials']),
      attempts: {
        operational: countMetric(sum(attemptCounts.map((item) => item.operational_attempts)), trialCount, ['derivePerformance.attempts.operational_attempts']),
        with_inference: countMetric(sum(attemptCounts.map((item) => item.attempts_with_inference)), trialCount, ['derivePerformance.attempts.attempts_with_inference']),
        without_inference: countMetric(sum(attemptCounts.map((item) => item.attempts_without_inference)), trialCount, ['derivePerformance.attempts.attempts_without_inference']),
        inference_unknown: countMetric(sum(attemptCounts.map((item) => item.attempts_inference_unknown)), trialCount, ['derivePerformance.attempts.attempts_inference_unknown']),
        infra_error: countMetric(sum(attemptCounts.map((item) => item.infra_error_attempts)), trialCount, ['derivePerformance.attempts.infra_error_attempts']),
      },
      first_operational_pass_rate: booleanRate(taskRecords.map((task) => task.success.first_operational_pass), minimumSampleSize, 'derivePerformance.success.first_operational_pass'),
      first_inference_bearing_pass_rate: booleanRate(taskRecords.map((task) => task.success.first_inference_bearing_pass), minimumSampleSize, 'derivePerformance.success.first_inference_bearing_pass'),
      final_pass_rate: booleanRate(taskRecords.map((task) => task.success.final_pass), minimumSampleSize, 'derivePerformance.success.final_pass'),
      repair_rate: countRate(sum(attemptCounts.map((item) => item.repair_attempts)), knownRoleAttempts, sum(attemptCounts.map((item) => item.operational_attempts)), minimumSampleSize, ['derivePerformance.attempts.repair_attempts', ...attemptRoleProvenance(facts)]),
      escalation_rate: countRate(sum(attemptCounts.map((item) => item.escalations)), knownRoleAttempts, sum(attemptCounts.map((item) => item.operational_attempts)), minimumSampleSize, ['derivePerformance.attempts.escalations', ...attemptRoleProvenance(facts)]),
      duration_ms: distributionMetric(runs.map((run) => run.performance.cost.duration_ms), runs.length, ['RunPerformanceRecord.cost.duration_ms']),
      tokens: {
        total: token((run) => run.cost.tokens.total_tokens),
        input: token((run) => run.cost.tokens.input_tokens),
        cached_input: token((run) => run.cost.tokens.cached_input_tokens),
        fresh_input: token((run) => run.cost.tokens.fresh_input_tokens),
        output: token((run) => run.cost.tokens.output_tokens),
        reasoning: token((run) => run.cost.tokens.reasoning_tokens),
      },
      quota: aggregateQuota(runs),
      api_equivalent_usd: token((run) => run.cost.api_equivalent_usd),
      human_intervention_rate: booleanRate(taskRecords.map((task) => task.intervention.human_intervention.value), minimumSampleSize, ...taskRecords.map((task) => task.intervention.human_intervention.provenance)),
      qualification: aggregateQualification(runs, minimumSampleSize),
      context_pressure: categoricalMetric(facts.map((fact) => fact.context_pressure), facts.length),
    },
  };
}

function countMetric(value: number, sampleSize: number, provenance: readonly string[]): EvidenceAggregation<number> {
  return { value, sample_size: sampleSize, population_size: sampleSize, status: 'AVAILABLE', reason: null, provenance: unique(provenance) };
}

function booleanRate(
  values: readonly (boolean | null)[],
  minimumSampleSize: number,
  ...provenance: readonly string[]
): EvidenceAggregation<number> {
  const available = values.filter((value): value is boolean => value !== null);
  return countRate(available.filter(Boolean).length, available.length, values.length, minimumSampleSize, provenance);
}

function countRate(
  numerator: number,
  sampleSize: number,
  populationSize: number,
  minimumSampleSize: number,
  provenance: readonly string[],
): EvidenceAggregation<number> {
  if (sampleSize === 0) return unavailable(populationSize, provenance, 'métrica não registrada');
  if (sampleSize < minimumSampleSize) {
    return { value: null, sample_size: sampleSize, population_size: populationSize, status: 'INSUFFICIENT_SAMPLE', reason: `sample_size=${sampleSize} abaixo de minimum_sample_size=${minimumSampleSize}`, provenance: unique(provenance) };
  }
  return { value: numerator / sampleSize, sample_size: sampleSize, population_size: populationSize, status: 'AVAILABLE', reason: null, provenance: unique(provenance) };
}

function numericMetric(
  values: readonly { readonly value: number | null; readonly provenance: string }[],
  populationSize: number,
): EvidenceAggregation<NumericDistribution> {
  const recorded = values.flatMap((metric) => metric.value === null ? [] : [metric.value]);
  return distributionMetric(recorded, populationSize, values.map((metric) => metric.provenance));
}

function distributionMetric(
  values: readonly number[],
  populationSize: number,
  provenance: readonly string[],
): EvidenceAggregation<NumericDistribution> {
  if (values.length === 0) return unavailable(populationSize, provenance, 'métrica não registrada');
  const sorted = [...values].sort((left, right) => left - right);
  const total = sum(sorted);
  return {
    value: {
      values: sorted,
      total,
      mean: total / sorted.length,
      min: sorted[0] as number,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
      max: sorted[sorted.length - 1] as number,
    },
    sample_size: sorted.length,
    population_size: populationSize,
    status: 'AVAILABLE',
    reason: null,
    provenance: unique(provenance),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.ceil(fraction * sorted.length) - 1] as number;
}

function categoricalMetric(
  facts: readonly { readonly value: string; readonly provenance: string }[],
  populationSize: number,
): EvidenceAggregation<Readonly<Record<string, number>>> {
  const available = facts.filter((fact) => fact.value !== COMPARABLE_FACT_UNKNOWN);
  if (available.length === 0) return unavailable(populationSize, facts.map((fact) => fact.provenance), 'métrica não registrada');
  const counts: Record<string, number> = {};
  for (const fact of available) counts[fact.value] = (counts[fact.value] ?? 0) + 1;
  return { value: counts, sample_size: available.length, population_size: populationSize, status: 'AVAILABLE', reason: null, provenance: unique(available.map((fact) => fact.provenance)) };
}

function aggregateQualification(
  runs: readonly RunReadResult[],
  minimumSampleSize: number,
): QualificationAggregation {
  const statuses = runs.map((run) => run.performance.quality.qualification_status);
  const counts: Record<string, number> = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  return {
    counts: { value: counts, sample_size: statuses.length, population_size: runs.length, status: 'AVAILABLE', reason: null, provenance: ['RunPerformanceRecord.quality.qualification_status'] },
    qualified_rate: countRate(statuses.filter((status) => status === QualificationStatus.QUALIFIED).length, statuses.length, runs.length, minimumSampleSize, ['RunPerformanceRecord.quality.qualification_status']),
  };
}

function aggregateQuota(
  runs: readonly RunReadResult[],
): EvidenceAggregation<readonly QuotaWindowAggregation[]> {
  const groups = new Map<string, { provider: string; windowId: string; values: number[]; provenance: string[] }>();
  const provenance: string[] = [];
  let usagesRecorded = 0;
  for (const run of runs) {
    const metric = run.performance.cost.quota_usage;
    provenance.push(metric.provenance);
    const usage: QuotaUsage | null = metric.value;
    if (usage === null) continue;
    usagesRecorded += 1;
    provenance.push(usage.observation.provenance);
    for (const window of usage.windows) {
      if (window.consumed_pp === null) continue;
      const key = `${usage.provider}\u0000${window.window_id}`;
      const current = groups.get(key) ?? { provider: usage.provider, windowId: window.window_id, values: [], provenance: [] };
      current.values.push(window.consumed_pp);
      current.provenance.push(metric.provenance, usage.observation.provenance, window.provenance);
      groups.set(key, current);
    }
  }
  if (usagesRecorded === 0) {
    return unavailable(runs.length, provenance, 'quota_usage não registrada');
  }
  const windows = [...groups.values()]
    .sort((left, right) => `${left.provider}:${left.windowId}`.localeCompare(`${right.provider}:${right.windowId}`))
    .map((group) => ({ provider: group.provider, window_id: group.windowId, consumed_pp: distributionMetric(group.values, runs.length, group.provenance) }));
  return {
    value: windows,
    sample_size: usagesRecorded,
    population_size: runs.length,
    status: 'AVAILABLE',
    reason: null,
    provenance: unique(provenance),
  };
}

function attemptRoleProvenance(facts: readonly ComparableRunFactsValue[]): string[] {
  return facts.map((fact) => fact.attempt_role.provenance);
}

function unavailable<T>(
  populationSize: number,
  provenance: readonly string[],
  reason: string,
): EvidenceAggregation<T> {
  return { value: null, sample_size: 0, population_size: populationSize, status: 'UNAVAILABLE', reason, provenance: unique(provenance) };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
