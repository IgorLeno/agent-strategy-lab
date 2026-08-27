import { describe, expect, it } from 'vitest';

import { ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution, type PlannedTask } from '../../src/planner/index.js';
import type {
  EvidenceAggregation,
  NumericDistribution,
  PerformanceHistoryQueryResult,
  PerformanceHistoryQueryResultV2,
  PerformanceSeries,
} from '../../src/performance/index.js';
import {
  CapabilityRegistry,
  capabilityOf,
  routeInitialProfile,
  routeInitialProfileWithHistory,
  type EvidenceBalanceFacts,
  type HistoryRoutingInput,
  type InitialRoutingInput,
  type ProfileCapability,
  type RoutingCandidate,
  type StructuredWorkUnit,
} from '../../src/routing/index.js';

const HEAD_SHA = 'a'.repeat(40);
const FINGERPRINT_A = '1'.repeat(64);
const FINGERPRINT_B = '2'.repeat(64);
const SERIES_A = 'a'.repeat(64);
const SERIES_B = 'b'.repeat(64);

function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'M82-fixture',
    objective: 'Implementar uma mudança local',
    blocked_by: [],
    taxonomy: {
      version: 1,
      task_class: 'feature',
      difficulty_declared: 'easy',
      complexity: 'local',
      ambiguity: 'low',
      verification: 'deterministic',
    },
    risk: 'low',
    acceptance: ['mudança validada'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 1 }],
    initial_files: ['src/routing/history-router.ts'],
    probable_files: ['test/routing/history-router.test.ts'],
    context_scope: { areas: ['routing'] },
    context_requirements: [{ description: 'router', source_anchor: 'src/routing/router.ts' }],
    environment_requirements: [{ kind: 'tool', name: 'node', reason: 'typecheck' }],
    estimated_duration: { expected: 500_000, maximum: 1_500_000 },
    validation_budget: { expected: 60_000, maximum: 300_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 10_000, maximum: 50_000 },
      changed_files: { expected: 2, maximum: 5 },
    },
    ...overrides,
  };
}

function inspection(): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: {
      known: true,
      value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git',
    },
    stack: {
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'fs:package.json',
    },
    package_manager: { known: true, value: 'pnpm', provenance: 'fs:pnpm-lock.yaml' },
    build_system: { known: true, value: 'typescript', provenance: 'fs:tsconfig.json' },
    directories: [],
    tests: { known: true, value: { framework: 'vitest', test_directories: ['test'] }, provenance: 'fs' },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json:scripts' },
    ],
    dependencies_state: {
      known: true,
      value: { lockfile_path: 'pnpm-lock.yaml', installed: true },
      provenance: 'fs',
    },
    required_tools: [],
    required_services: [],
    filesystem_permissions: {
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs',
    },
    feedback_sources: [],
    project_instructions: [{ path: 'AGENTS.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'routing', path: 'src/routing' }],
    relevant_files: [],
    risks: [],
  };
}

function workUnit(plannedTask: PlannedTask = task()): StructuredWorkUnit {
  const facts = inspection();
  return {
    source: 'planner',
    task: plannedTask,
    assessment: assessExecution(plannedTask, {
      inspection: facts,
      expectedBaseRevisionSha: HEAD_SHA,
      factsSource: 'full_inspection',
    }),
    project_facts: facts,
  };
}

function capability(profileId: string): ProfileCapability {
  return capabilityOf({
    profile_id: profileId,
    agent: 'codex',
    model: 'gpt-5.6-luna',
    reasoning_effort: 'medium',
    reasoning_effort_source: 'codex_config_override',
    billing_mode: 'subscription_only',
    credential_source: 'chatgpt_subscription',
    environment_mode: 'real-world',
    instruction_environment: 'sanitized_user_home',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    sandbox: 'workspace-write',
    session_persistence: 'ephemeral',
  });
}

function candidate(profileId: string): RoutingCandidate {
  return {
    profile_id: profileId,
    availability: { value: true, provenance: 'doctor.ok' },
  };
}

function metric<T>(value: T, sampleSize = 3): EvidenceAggregation<T> {
  return {
    value,
    sample_size: sampleSize,
    population_size: sampleSize,
    status: 'AVAILABLE',
    reason: null,
    provenance: ['fixture'],
  };
}

function distribution(p90: number, sampleSize = 3): NumericDistribution {
  const values = Array.from({ length: sampleSize }, (_, index) =>
    index === sampleSize - 1 ? p90 : Math.max(0, p90 - (sampleSize - index) * 100),
  );
  return {
    values,
    total: values.reduce((total, value) => total + value, 0),
    mean: values.reduce((total, value) => total + value, 0) / values.length,
    min: values[0]!,
    p50: values[Math.ceil(values.length / 2) - 1]!,
    p90,
    max: p90,
  };
}

interface SeriesUtilityOverrides {
  readonly firstPass?: number;
  readonly finalPass?: number;
  readonly repair?: number;
  readonly escalation?: number;
  readonly durationP90?: number;
  readonly tokensP90?: number;
  readonly quotaP90?: number;
  readonly costP90?: number;
  readonly intervention?: number;
  readonly qualification?: number;
  readonly sampleSize?: number;
  readonly costUnavailable?: boolean;
  readonly quotaUnavailable?: boolean;
  /** Métrica OBRIGATÓRIA ausente: a série continua insuficiente. */
  readonly durationUnavailable?: boolean;
  readonly difficulty?: string;
  readonly contextPressure?: 'low' | 'medium' | 'high';
}

function series(
  profileId: string,
  fingerprint: string,
  seriesKey: string,
  overrides: SeriesUtilityOverrides = {},
): PerformanceSeries {
  const sampleSize = overrides.sampleSize ?? 3;
  const cost = overrides.costUnavailable
    ? {
        value: null,
        sample_size: 0,
        population_size: sampleSize,
        status: 'UNAVAILABLE' as const,
        reason: 'métrica não registrada',
        provenance: ['fixture_missing'],
      }
    : metric(distribution(overrides.costP90 ?? 1, sampleSize), sampleSize);
  const unavailable = <T>(): EvidenceAggregation<T> => ({
    value: null,
    sample_size: 0,
    population_size: sampleSize,
    status: 'UNAVAILABLE' as const,
    reason: 'métrica não registrada',
    provenance: ['fixture_missing'],
  });
  return {
    identity: {
      schema_version: 1,
      task: {
        task_class: { value: 'feature', provenance: 'fixture' },
        difficulty: { value: overrides.difficulty ?? 'easy', provenance: 'fixture' },
        stack: { value: ['node'], provenance: 'fixture' },
      },
      profile: {
        profile_id: { value: profileId, provenance: 'fixture' },
        profile_fingerprint_sha256: { value: fingerprint, provenance: 'fixture' },
      },
      execution: {
        provider: { value: 'openai', provenance: 'fixture' },
        agent_cli: { value: 'codex', provenance: 'fixture' },
        model: { value: 'gpt-5.6-luna', provenance: 'fixture' },
        reasoning_effort: { value: 'medium', provenance: 'fixture' },
        transport: { value: 'jsonl', provenance: 'fixture' },
        worker_role: { value: 'implementer', provenance: 'fixture' },
        strategy_name: { value: 'baseline', provenance: 'fixture' },
        strategy_version: { value: 1, provenance: 'fixture' },
        environment_profile_id: { value: 'env-real', provenance: 'fixture' },
        environment_mode: { value: 'real-world', provenance: 'fixture' },
      },
      context: {
        context_pressure: { value: overrides.contextPressure ?? 'low', provenance: 'fixture' },
        environment_readiness: { value: 'READY', provenance: 'fixture' },
      },
      comparable: true,
      blocking_unknown_dimensions: [],
      series_key: seriesKey,
    },
    automatic_merge_eligible: true,
    trial_ids: Array.from({ length: sampleSize }, (_, index) => `trial-${profileId}-${index}`),
    run_ids: Array.from({ length: sampleSize }, (_, index) => `run-${profileId}-${index}`),
    aggregations: {
      trials: metric(sampleSize, sampleSize),
      attempts: {
        operational: metric(sampleSize, sampleSize),
        with_inference: metric(sampleSize, sampleSize),
        without_inference: metric(0, sampleSize),
        inference_unknown: metric(0, sampleSize),
        infra_error: metric(0, sampleSize),
      },
      first_operational_pass_rate: metric(overrides.firstPass ?? 1, sampleSize),
      first_inference_bearing_pass_rate: metric(overrides.firstPass ?? 1, sampleSize),
      final_pass_rate: metric(overrides.finalPass ?? 1, sampleSize),
      repair_rate: metric(overrides.repair ?? 0, sampleSize),
      escalation_rate: metric(overrides.escalation ?? 0, sampleSize),
      duration_ms: overrides.durationUnavailable
        ? unavailable<NumericDistribution>()
        : metric(distribution(overrides.durationP90 ?? 1_000, sampleSize), sampleSize),
      tokens: {
        total: metric(distribution(overrides.tokensP90 ?? 1_000, sampleSize), sampleSize),
        input: metric(distribution(500, sampleSize), sampleSize),
        cached_input: metric(distribution(100, sampleSize), sampleSize),
        fresh_input: metric(distribution(400, sampleSize), sampleSize),
        output: metric(distribution(300, sampleSize), sampleSize),
        reasoning: metric(distribution(200, sampleSize), sampleSize),
      },
      quota: overrides.quotaUnavailable
        ? unavailable<readonly { readonly provider: string; readonly window_id: string; readonly consumed_pp: EvidenceAggregation<NumericDistribution> }[]>()
        : metric(
            [
              {
                provider: 'openai',
                window_id: 'weekly',
                consumed_pp: metric(distribution(overrides.quotaP90 ?? 1, sampleSize), sampleSize),
              },
            ],
            sampleSize,
          ),
      api_equivalent_usd: cost,
      human_intervention_rate: metric(overrides.intervention ?? 0, sampleSize),
      qualification: {
        counts: metric({ QUALIFIED: sampleSize }, sampleSize),
        qualified_rate: metric(overrides.qualification ?? 1, sampleSize),
      },
      context_pressure: metric(
        { [overrides.contextPressure ?? 'low']: sampleSize },
        sampleSize,
      ),
    },
  };
}

function history(seriesValues: readonly PerformanceSeries[], minimumSampleSize = 3): PerformanceHistoryQueryResult {
  return {
    schema_version: 1,
    minimum_sample_size: minimumSampleSize,
    series: seriesValues,
    excluded_runs: [],
    excluded_trials: [],
    comparable_facts_issues: [],
  };
}

function historyV2(
  seriesValues: readonly PerformanceSeries[],
  minimumSampleSize = 3,
  escalationOnlyProfileIds: readonly string[] = [],
): PerformanceHistoryQueryResultV2 {
  return {
    schema_version: 2,
    minimum_sample_size: minimumSampleSize,
    episodes: [],
    series: seriesValues.map((item) => {
      const role = {
        run_ids: item.run_ids,
        runs: item.aggregations.trials,
        with_inference: item.aggregations.attempts.with_inference,
        duration_ms: item.aggregations.duration_ms,
        tokens: item.aggregations.tokens,
        quota: item.aggregations.quota,
        api_equivalent_usd: item.aggregations.api_equivalent_usd,
        qualification: item.aggregations.qualification,
        context_pressure: item.aggregations.context_pressure,
      };
      const profileId = item.identity.profile.profile_id.value;
      return {
        identity: item.identity,
        automatic_merge_eligible: item.automatic_merge_eligible,
        initial_routing_eligible:
          profileId !== 'UNKNOWN' && !escalationOnlyProfileIds.includes(profileId),
        episode_ids: item.trial_ids.map((trialId) => `episode-${trialId}`),
        trial_ids: item.trial_ids,
        run_ids: item.run_ids,
        execution_by_role: { INITIAL: role, REPAIR: role, ESCALATION: role, UNKNOWN: role },
        routing_aggregations: item.aggregations,
      };
    }),
    excluded_runs: [],
    excluded_trials: [],
    excluded_episodes: [],
    comparable_facts_issues: [],
  };
}

function input(
  seriesValues: readonly PerformanceSeries[],
  options: {
    readonly plannedTask?: PlannedTask;
    readonly candidates?: readonly RoutingCandidate[];
    readonly capabilities?: readonly ProfileCapability[];
    readonly minimumSampleSize?: number;
  } = {},
): HistoryRoutingInput & { readonly history: PerformanceHistoryQueryResult } {
  const capabilities = options.capabilities ?? [capability('profile-a')];
  const candidates = options.candidates ?? capabilities.map((entry) => candidate(entry.profile_id));
  return {
    work_unit: workUnit(options.plannedTask),
    role: 'implementer',
    capability_registry: new CapabilityRegistry(capabilities),
    candidates,
    history: history(seriesValues),
    minimum_sample_size: options.minimumSampleSize ?? 3,
    profile_fingerprints_sha256: {
      'profile-a': FINGERPRINT_A,
      'profile-b': FINGERPRINT_B,
    },
  };
}

/** Fatos de balanceamento que favorecem descaradamente `profile-b`. */
function balanceTowardsB(): EvidenceBalanceFacts {
  return {
    profile_sample_sizes: { 'profile-a': 99, 'profile-b': 0 },
    provider_sample_sizes: { codex: 99 },
    run_launches_by_provider: { codex: 99 },
    quota_headroom_by_pool: {},
    provenance: ['fixture'],
  };
}

function m78Input(value: HistoryRoutingInput): InitialRoutingInput {
  return {
    work_unit: value.work_unit,
    role: value.role,
    capability_registry: value.capability_registry,
    candidates: value.candidates,
  };
}

describe('routeInitialProfileWithHistory', () => {
  it('V2 muda a decisão real de A para B e volta a M78 quando falta métrica obrigatória', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const base = input([], { capabilities });
    expect(routeInitialProfile(m78Input(base))).toMatchObject({ profile: { profile_id: 'profile-a' } });

    const historicalA = series('profile-a', FINGERPRINT_A, SERIES_A, {
      firstPass: 0.5,
      finalPass: 0.5,
      repair: 0.5,
      escalation: 0.5,
      durationP90: 2_000,
      tokensP90: 2_000,
      quotaP90: 2,
      costP90: 2,
      intervention: 0.5,
      qualification: 0.5,
    });
    const historicalB = series('profile-b', FINGERPRINT_B, SERIES_B);
    const withHistory: HistoryRoutingInput = {
      ...base,
      history: historyV2([historicalA, historicalB]),
    };
    const routed = routeInitialProfileWithHistory(withHistory);
    expect(routed.source).toBe('HISTORY');
    expect(routed.recommendation?.profile.profile_id).toBe('profile-b');
    expect(routed.evidence.selected_series_sample_size).toBe(3);

    const insufficient = routeInitialProfileWithHistory({
      ...withHistory,
      history: historyV2([
        historicalA,
        series('profile-b', FINGERPRINT_B, SERIES_B, { durationUnavailable: true }),
      ]),
    });
    expect(insufficient.source).toBe('M78_FALLBACK');
    expect(insufficient.fallback).toEqual(routeInitialProfile(m78Input(base)));
  });

  it('V2 nunca usa série observada somente em ESCALATION para routing inicial', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const value = input([], { capabilities });
    const result = routeInitialProfileWithHistory({
      ...value,
      history: historyV2(
        [
          series('profile-a', FINGERPRINT_A, SERIES_A),
          series('profile-b', FINGERPRINT_B, SERIES_B),
        ],
        3,
        ['profile-b'],
      ),
    });
    expect(result.source).toBe('M78_FALLBACK');
    expect(result.evidence.series_considered).toContainEqual(
      expect.objectContaining({ profile_id: 'profile-b', status: 'INCOMPATIBLE' }),
    );
  });

  it('policy de profile único não é ampliada por recomendação histórica externa', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const value = input([], {
      capabilities,
      candidates: [candidate('profile-a')],
    });
    const result = routeInitialProfileWithHistory({
      ...value,
      history: historyV2([
        series('profile-b', FINGERPRINT_B, SERIES_B),
      ]),
      profile_fingerprints_sha256: {
        'profile-a': FINGERPRINT_A,
      },
    });

    expect(result.source).toBe('M78_FALLBACK');
    expect(result.fallback).toMatchObject({
      outcome: 'ROUTED',
      profile: { profile_id: 'profile-a' },
    });
    expect(result.evidence.series_considered).toContainEqual(
      expect.objectContaining({ profile_id: 'profile-b', status: 'INCOMPATIBLE' }),
    );
  });

  it('produz profile e budget p90 a partir de uma única série suficiente', () => {
    const value = input([
      series('profile-a', FINGERPRINT_A, SERIES_A, { durationP90: 4_000_000 }),
    ]);
    const result = routeInitialProfileWithHistory(value);

    expect(result.source).toBe('HISTORY');
    expect(result.fallback).toBeNull();
    expect(result.recommendation).toMatchObject({
      outcome: 'ROUTED',
      profile: { profile_id: 'profile-a' },
      execution_runtime_forecast: {
        predicted_runtime_ms: 4_000_000,
        statistic: 'observed_duration_ms_p90',
        sample_size: 3,
      },
    });
    expect(result.evidence).toMatchObject({
      decision_minimum_sample_size: 3,
      selected_series_key: SERIES_A,
      selected_series_sample_size: 3,
    });
    expect(result.evidence.aggregations_considered).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(result.rationale.join(' ')).toContain('não substitui decomposição');
  });

  it('seleciona somente a série que domina em toda a utilidade observada', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const result = routeInitialProfileWithHistory(
      input(
        [
          series('profile-b', FINGERPRINT_B, SERIES_B, {
            firstPass: 0.5,
            finalPass: 0.75,
            repair: 0.4,
            escalation: 0.2,
            durationP90: 2_000,
            tokensP90: 2_000,
            quotaP90: 2,
            costP90: 2,
            intervention: 0.25,
            qualification: 0.75,
          }),
          series('profile-a', FINGERPRINT_A, SERIES_A),
        ],
        { capabilities },
      ),
    );

    expect(result.source).toBe('HISTORY');
    expect(result.recommendation?.profile.profile_id).toBe('profile-a');
  });

  it('amostra minúscula e métrica ausente caem no M78 sem fabricar certeza', () => {
    for (const historical of [
      series('profile-a', FINGERPRINT_A, SERIES_A, { sampleSize: 1 }),
      series('profile-a', FINGERPRINT_A, SERIES_A, { durationUnavailable: true }),
    ]) {
      const value = input([historical]);
      const result = routeInitialProfileWithHistory(value);
      expect(result.source).toBe('M78_FALLBACK');
      expect(result.recommendation).toBeNull();
      expect(result.fallback).toEqual(routeInitialProfile(m78Input(value)));
      expect(result.evidence.series_considered[0]).toMatchObject({
        status: 'INSUFFICIENT_EVIDENCE',
        utility: null,
      });
    }
  });

  it('profile elegível sem série também torna a comparação insuficiente', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const value = input([series('profile-a', FINGERPRINT_A, SERIES_A)], { capabilities });
    const result = routeInitialProfileWithHistory(value);

    expect(result.source).toBe('M78_FALLBACK');
    expect(result.evidence.series_considered).toContainEqual(
      expect.objectContaining({
        profile_id: 'profile-b',
        series_key: null,
        status: 'INSUFFICIENT_EVIDENCE',
        utility: null,
      }),
    );
  });

  it('não ignora uma segunda série comparável com amostra insuficiente do mesmo profile', () => {
    const result = routeInitialProfileWithHistory(
      input([
        series('profile-a', FINGERPRINT_A, SERIES_A),
        series('profile-a', FINGERPRINT_A, SERIES_B, { sampleSize: 1 }),
      ]),
    );

    expect(result.source).toBe('M78_FALLBACK');
    expect(result.rationale.join(' ')).toContain('série comparável incompleta');
  });

  it('empate e trade-off permanecem ambíguos e o fallback não depende da ordem histórica', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const first = input(
      [
        series('profile-a', FINGERPRINT_A, SERIES_A),
        series('profile-b', FINGERPRINT_B, SERIES_B),
      ],
      { capabilities },
    );
    const second = input([...first.history.series].reverse(), { capabilities });

    const left = routeInitialProfileWithHistory(first);
    const right = routeInitialProfileWithHistory(second);
    expect(left).toEqual(right);
    expect(left.source).toBe('M78_FALLBACK');
    expect(left.evidence.series_considered.every((entry) => entry.status === 'AMBIGUOUS')).toBe(true);
  });

  it('budget acima de validation timeout continua válido quando cabe no runtime bound', () => {
    const result = routeInitialProfileWithHistory(
      input([series('profile-a', FINGERPRINT_A, SERIES_A, { durationP90: 4_000_000 })]),
    );
    expect(result.recommendation?.outcome).toBe('ROUTED');
    expect(result.recommendation?.execution_runtime_forecast.predicted_runtime_ms).toBeGreaterThan(1_000);
    expect(result.recommendation?.execution_runtime_forecast.provenance.join(' ')).not.toContain(
      'timeout_seconds',
    );
  });

  it('p90 histórico muito acima do antigo bound continua ROUTED: previsão não recusa', () => {
    const result = routeInitialProfileWithHistory(
      input([series('profile-a', FINGERPRINT_A, SERIES_A, { durationP90: 4_000_000 })], {
        candidates: [candidate('profile-a')],
      }),
    );
    expect(result.source).toBe('HISTORY');
    expect(result.recommendation).toMatchObject({
      outcome: 'ROUTED',
      execution_runtime_forecast: {
        kind: 'HISTORY_DERIVED_EXECUTION_RUNTIME_FORECAST',
        authority: 'ADVISORY',
        predicted_runtime_ms: 4_000_000,
      },
    });
  });

  it('histórico não contorna capacidade/decomposição exigida pelo M78', () => {
    const broadTask = task({
      taxonomy: {
        ...task().taxonomy,
        difficulty_declared: 'hard',
        complexity: 'cross_cutting',
        ambiguity: 'high',
        verification: 'subjective',
      },
      risk: 'critical',
      context_scope: { areas: ['a', 'b', 'c', 'd'] },
    });
    const incompatibleHistory = series('profile-a', FINGERPRINT_A, SERIES_A, {
      difficulty: 'hard',
      contextPressure: 'high',
    });
    const value = input([incompatibleHistory], { plannedTask: broadTask });
    const result = routeInitialProfileWithHistory(value);

    expect(result.source).toBe('M78_FALLBACK');
    expect(result.fallback?.outcome).toBe('HUMAN_REQUIRED');
    expect(result.evidence.series_considered[0]?.reason).toContain('M78 recusou');
  });

  it('fingerprint ausente ou divergente nunca vira comparabilidade presumida', () => {
    const value = input([series('profile-a', FINGERPRINT_A, SERIES_A)]);
    const withoutFingerprint: HistoryRoutingInput = {
      ...value,
      profile_fingerprints_sha256: {},
    };
    const result = routeInitialProfileWithHistory(withoutFingerprint);
    expect(result.source).toBe('M78_FALLBACK');
    expect(result.evidence.series_considered[0]).toMatchObject({
      status: 'INCOMPATIBLE',
      utility: null,
    });
    expect(result.evidence.series_considered[0]?.reason).toContain('não foi fornecido');
  });
});

describe('UNKNOWN não impossibilita o aprendizado, e história suficiente ainda decide', () => {
  it('história suficiente vence o balanceamento de cold-start', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const base = input(
      [
        series('profile-a', FINGERPRINT_A, SERIES_A),
        series('profile-b', FINGERPRINT_B, SERIES_B, {
          firstPass: 0.4,
          finalPass: 0.5,
          repair: 0.6,
          escalation: 0.4,
          durationP90: 5_000,
          tokensP90: 5_000,
          intervention: 0.5,
          qualification: 0.5,
        }),
      ],
      { capabilities },
    );
    const routed = routeInitialProfileWithHistory({
      ...base,
      selection_policy: 'evidence_balanced',
      evidence_balance: balanceTowardsB(),
    });

    // A série de A domina; o balanceamento queria B com 0 amostras e não venceu.
    expect(routed.source).toBe('HISTORY');
    expect(routed.recommendation?.profile.profile_id).toBe('profile-a');
    expect(routed.fallback).toBeNull();
  });

  it('quota e custo UNKNOWN em TODAS as séries saem da comparação e a história decide', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const routed = routeInitialProfileWithHistory(
      input(
        [
          series('profile-a', FINGERPRINT_A, SERIES_A, {
            quotaUnavailable: true,
            costUnavailable: true,
            firstPass: 0.4,
            finalPass: 0.5,
            repair: 0.6,
            escalation: 0.4,
            durationP90: 5_000,
            tokensP90: 5_000,
            intervention: 0.5,
            qualification: 0.5,
          }),
          series('profile-b', FINGERPRINT_B, SERIES_B, {
            quotaUnavailable: true,
            costUnavailable: true,
          }),
        ],
        { capabilities },
      ),
    );

    expect(routed.source).toBe('HISTORY');
    expect(routed.recommendation?.profile.profile_id).toBe('profile-b');
    expect(routed.evidence.dimensions_omitted.map((entry) => entry.dimension).sort()).toEqual([
      'api_equivalent_usd_p90',
      'quota_consumed_pp_p90_total',
    ]);
    for (const omitted of routed.evidence.dimensions_omitted) {
      expect(omitted.reason).toContain('UNKNOWN em todas');
    }
    // A dimensão ausente ficou `null` — nunca virou zero.
    const considered = routed.evidence.series_considered.find((entry) => entry.status === 'ELIGIBLE');
    expect(considered?.utility?.quota_consumed_pp_p90_total).toBeNull();
    expect(considered?.utility?.api_equivalent_usd_p90).toBeNull();
  });

  it('quota conhecida só para uma série é omitida em vez de punir quem não tem medidor', () => {
    const capabilities = [capability('profile-a'), capability('profile-b')];
    const routed = routeInitialProfileWithHistory(
      input(
        [
          // A gasta quota pouquíssima e é observável; B não tem medidor. Se a
          // dimensão participasse, A venceria por um número que B não tem como
          // apresentar.
          series('profile-a', FINGERPRINT_A, SERIES_A, {
            quotaP90: 0,
            costP90: 0,
            firstPass: 0.4,
            finalPass: 0.5,
            repair: 0.6,
            escalation: 0.4,
            durationP90: 5_000,
            tokensP90: 5_000,
            intervention: 0.5,
            qualification: 0.5,
          }),
          series('profile-b', FINGERPRINT_B, SERIES_B, {
            quotaUnavailable: true,
            costUnavailable: true,
          }),
        ],
        { capabilities },
      ),
    );

    expect(routed.source).toBe('HISTORY');
    expect(routed.recommendation?.profile.profile_id).toBe('profile-b');
    for (const omitted of routed.evidence.dimensions_omitted) {
      expect(omitted.reason).toContain('inventaria o lado ausente');
    }
  });

  it('métrica obrigatória ausente continua tornando a série insuficiente', () => {
    const routed = routeInitialProfileWithHistory(
      input([series('profile-a', FINGERPRINT_A, SERIES_A, { durationUnavailable: true })]),
    );
    expect(routed.source).toBe('M78_FALLBACK');
    expect(routed.evidence.series_considered[0]).toMatchObject({
      status: 'INSUFFICIENT_EVIDENCE',
      utility: null,
    });
  });
});
