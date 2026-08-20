import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus } from '../../src/core/index.js';
import { executionEnvelopeSha256, type ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import {
  AttemptRole,
  COMPARABLE_FACT_UNKNOWN,
  COMPARABLE_RUN_FACTS_FILE_NAME,
  comparableRunFactsFromEvidence,
  queryPerformanceHistory,
  type ComparableRunFacts,
  type EvaluationSelection,
} from '../../src/performance/index.js';
import {
  QuotaObservationStatus,
  QuotaReasonCode,
  type AgentProfile,
  type EnvironmentProfile,
  type EvaluationRecord,
  type QuotaUsage,
  type ScoreRecord,
  type StrategyDef,
  type TaskSpec,
} from '../../src/schemas/index.js';
import {
  createRunDirectory,
  finalizeExecution,
  RunIndex,
  sealEvaluation,
  sealScore,
  type RunDirectory,
  type RunHistoryContextV1,
  type RunRecord,
} from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-query-'));
  temporaryRoots.push(root);
  return root;
}

const budgets = {
  duration_ms: { expected: 1_000, maximum: 5_000 },
  tokens: { expected: 100, maximum: 1_000 },
  changed_files: { expected: 1, maximum: 10 },
};

const agentProfile: AgentProfile = {
  id: 'agent-shared-model',
  cli: 'fake-cli',
  cli_version: '1.0.0',
  model: 'same-model',
  flags: ['reasoning_effort:high'],
};

const strategy: StrategyDef = { name: 'baseline', version: 1, prompt: 'Resolva.' };
const environmentProfile: EnvironmentProfile = {
  id: 'env-controlled',
  mode: 'controlled',
  home: 'sanitized',
  env_allowlist: [],
  instruction_files: [],
  plugins: [],
  skills: [],
  mcp_servers: [],
};

function taskSpec(id: string): TaskSpec {
  return {
    id,
    description: 'Corrigir um bug TypeScript',
    visible_criteria: ['testes passam'],
    task_class: 'bugfix',
    difficulty: 'easy',
    stack: ['typescript'],
    public_graders: ['tests'],
    budgets,
  };
}

function envelope(task: TaskSpec): ExecutionEnvelopeManifest {
  return {
    task_spec: task,
    strategy,
    compiled_prompt: 'Resolva.',
    base_sha: '0'.repeat(40),
    agent_profile: agentProfile,
    environment_profile: environmentProfile,
    adapter: { name: 'fake-agent', version: '1.0.0' },
    budgets,
    timeout_ms: 60_000,
  };
}

const fact = <T>(value: T) => ({ value, provenance: 'fixture_authoritative_evidence' });

function comparableFacts(
  profile: { readonly id: string; readonly argv: readonly string[] },
  attemptRole: AttemptRole,
): ComparableRunFacts {
  return comparableRunFactsFromEvidence({
    authoritative_profile: profile,
    provider: fact('fake-provider'),
    transport: fact('jsonl'),
    worker_role: fact('implementer'),
    attempt_role: fact(attemptRole),
    context_pressure: fact('low'),
    environment_readiness: fact('READY'),
  });
}

function quotaUsage(): QuotaUsage {
  return {
    provider: 'fake-provider',
    observation: {
      status: QuotaObservationStatus.OBSERVED,
      reason_code: QuotaReasonCode.OK,
      provenance: 'fixture_probe',
    },
    windows: [
      {
        window_id: 'daily',
        before_used_pct: 10,
        after_used_pct: 12,
        consumed_pp: 2,
        same_window: true,
        reason_code: QuotaReasonCode.OK,
        provenance: 'fixture_probe',
      },
    ],
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface RunFixtureOptions {
  readonly labRoot: string;
  readonly runId: string;
  readonly trialId: string;
  readonly taskId: string;
  readonly outcome: EvaluationOutcome;
  readonly facts: ComparableRunFacts | null;
  readonly durationMs: number;
  readonly tokens: number | null;
  readonly includeQuota?: boolean;
  readonly includeApiEquivalent?: boolean;
  readonly historyContext?: RunHistoryContextV1;
  /** Conteúdo bruto de `execution/interventions.json`; ausente = run legado. */
  readonly interventions?: unknown;
}

async function buildRun(options: RunFixtureOptions): Promise<RunDirectory> {
  const run = await createRunDirectory({ labRoot: options.labRoot, runId: options.runId });
  const task = taskSpec(options.taskId);
  const manifest = envelope(task);
  const manifestSha = executionEnvelopeSha256(manifest);

  const runRecord: RunRecord = {
    task: {
      id: task.id,
      task_class: task.task_class,
      difficulty: task.difficulty,
      description: task.description,
    },
    trial: {
      id: options.trialId,
      task_id: task.id,
      agent_id: agentProfile.id,
      strategy_name: strategy.name,
      status: 'EXECUTED',
    },
    run: {
      run_id: options.runId,
      trial_id: options.trialId,
      run_dir: run.runDir,
      created_at: '2026-08-19T00:00:00.000Z',
      status: ExecutionStatus.COMPLETED,
    },
    ...(options.historyContext === undefined ? {} : { history_context: options.historyContext }),
  };
  const index = RunIndex.open(path.join(run.dataDir, 'index.sqlite'));
  try {
    await index.indexRun(run.runDir, runRecord);
  } finally {
    index.close();
  }

  await writeJson(path.join(run.executionDir, 'execution-envelope.json'), manifest);
  const metrics = {
    tokens: fact(options.tokens),
    changed_files: fact(1),
    input_tokens: fact(options.tokens),
    cached_input_tokens: fact(0),
    output_tokens: fact(options.tokens),
    reasoning_tokens: fact(10),
    ...(options.includeApiEquivalent === false ? {} : { api_equivalent_usd: fact(0.25) }),
  };
  await writeJson(path.join(run.executionDir, 'execution-record.json'), {
    status: ExecutionStatus.COMPLETED,
    exit_code: 0,
    duration_ms: options.durationMs,
    execution_envelope_sha256: manifestSha,
    metrics,
  });
  if (options.includeQuota !== false) {
    await writeJson(path.join(run.executionDir, 'quota-usage.json'), quotaUsage());
  }
  if (options.facts !== null) {
    await writeJson(
      path.join(run.executionDir, COMPARABLE_RUN_FACTS_FILE_NAME),
      options.facts,
    );
  }
  if (options.interventions !== undefined) {
    await writeJson(path.join(run.executionDir, 'interventions.json'), options.interventions);
  }
  await finalizeExecution(run.runDir);

  const evaluation: EvaluationRecord = {
    evaluation_id: 'evaluation-1',
    outcome: options.outcome,
    grader_results: { tests: { outcome: options.outcome, required: true } },
    grader_versions: { tests: '1.0.0' },
    evaluation_envelope_sha256: '1'.repeat(64),
  };
  await writeJson(
    path.join(run.runDir, 'evaluations', 'evaluation-1', 'evaluation-record.json'),
    evaluation,
  );
  await sealEvaluation(run.runDir, 'evaluation-1');

  const score: ScoreRecord = {
    score_profile_id: 'default',
    score_profile_version: '1.0.0',
    sub_scores: { correctness: { value: 1, weight: 1, required: true } },
    budgets_used: budgets,
    coverage: 1,
  };
  await writeJson(path.join(run.runDir, 'scores', 'score-1', 'score-record.json'), score);
  await sealScore(run.runDir, 'score-1');
  return run;
}

function selection(runId: string): EvaluationSelection {
  return { [runId]: { evaluation_id: 'evaluation-1', score_id: 'score-1' } };
}

function historyContext(
  episodeId: string,
  ordinal: number,
  initialProfileId: string,
  initialProfileFingerprint: string,
): RunHistoryContextV1 {
  return {
    schema_version: 1,
    execution_episode_id: episodeId,
    episode_attempt_ordinal: ordinal,
    work_definition_fingerprint_sha256: 'f'.repeat(64),
    initial_profile_id: initialProfileId,
    initial_profile_fingerprint_sha256: initialProfileFingerprint,
    selection: { evaluation_id: 'evaluation-1', score_id: 'score-1' },
  };
}

async function snapshotFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        result[path.relative(root, absolute)] = createHash('sha256')
          .update(await readFile(absolute))
          .digest('hex');
      }
    }
  }
  await visit(root);
  return result;
}

describe('ComparableRunFacts', () => {
  it('usa fingerprint canônico do profile inteiro e separa mudança do mesmo id', () => {
    const ordered = { id: 'profile-a', argv: ['fake', '--model', 'same-model'], timeout_seconds: 30 };
    const reordered = { timeout_seconds: 30, argv: ['fake', '--model', 'same-model'], id: 'profile-a' };
    const changed = { ...ordered, timeout_seconds: 31 };

    const first = comparableRunFactsFromEvidence({ authoritative_profile: ordered });
    const same = comparableRunFactsFromEvidence({ authoritative_profile: reordered });
    const different = comparableRunFactsFromEvidence({ authoritative_profile: changed });

    expect(first.profile_id.value).toBe('profile-a');
    expect(first.profile_fingerprint_sha256.value).toBe(same.profile_fingerprint_sha256.value);
    expect(first.profile_fingerprint_sha256.value).not.toBe(different.profile_fingerprint_sha256.value);
    expect(first).not.toHaveProperty('profile_version');
  });
});

describe('queryPerformanceHistory', () => {
  it('V2 separa lifecycle do episódio e séries comparáveis em escalation cross-profile', async () => {
    const labRoot = await temporaryRoot();
    const profileA = { id: 'profile-a', argv: ['fake', '--profile', 'a'] } as const;
    const profileB = { id: 'profile-b', argv: ['fake', '--profile', 'b'] } as const;
    const profileC = { id: 'profile-c', argv: ['fake', '--profile', 'c'] } as const;
    const fingerprintA = comparableFacts(profileA, AttemptRole.INITIAL).profile_fingerprint_sha256.value;
    const fingerprintB = comparableFacts(profileB, AttemptRole.ESCALATION).profile_fingerprint_sha256.value;
    const fingerprintC = comparableFacts(profileC, AttemptRole.REPAIR).profile_fingerprint_sha256.value;
    expect(fingerprintA).not.toBe(COMPARABLE_FACT_UNKNOWN);
    expect(fingerprintB).not.toBe(COMPARABLE_FACT_UNKNOWN);

    const initial = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5V21',
      trialId: 'trial-episode-a',
      taskId: 'task-episode',
      outcome: EvaluationOutcome.FAIL,
      facts: comparableFacts(profileA, AttemptRole.INITIAL),
      durationMs: 1_000,
      tokens: 100,
      historyContext: historyContext('episode-1', 1, 'profile-a', fingerprintA as string),
    });
    const repair = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5V22',
      trialId: 'trial-episode-a',
      taskId: 'task-episode',
      outcome: EvaluationOutcome.FAIL,
      facts: comparableFacts(profileA, AttemptRole.REPAIR),
      durationMs: 2_000,
      tokens: 200,
      historyContext: historyContext('episode-1', 2, 'profile-a', fingerprintA as string),
    });
    const escalation = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5V23',
      trialId: 'trial-episode-b',
      taskId: 'task-episode',
      outcome: EvaluationOutcome.PASS,
      facts: comparableFacts(profileB, AttemptRole.ESCALATION),
      durationMs: 3_000,
      tokens: 300,
      historyContext: historyContext('episode-1', 3, 'profile-a', fingerprintA as string),
    });
    const orphanRepair = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5V24',
      trialId: 'trial-orphan-repair',
      taskId: 'task-episode',
      outcome: EvaluationOutcome.PASS,
      facts: comparableFacts(profileC, AttemptRole.REPAIR),
      durationMs: 4_000,
      tokens: 400,
      historyContext: historyContext('episode-orphan', 2, 'profile-c', fingerprintC as string),
    });
    const selections = {
      ...selection(initial.runId),
      ...selection(repair.runId),
      ...selection(escalation.runId),
      ...selection(orphanRepair.runId),
    };

    const result = await queryPerformanceHistory({
      schema_version: 2,
      runs_dir: path.join(labRoot, 'data', 'runs'),
      minimum_sample_size: 1,
      work_definition_fingerprint_sha256: 'f'.repeat(64),
      trials: [
        { trial_id: 'trial-episode-a', selection: selections },
        { trial_id: 'trial-episode-b', selection: selections },
        { trial_id: 'trial-orphan-repair', selection: selections },
      ],
    });

    expect(result.schema_version).toBe(2);
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.performance.attempts).toMatchObject({
      operational_attempts: 3,
      repair_attempts: 1,
      escalations: 1,
    });
    expect(result.episodes[0]?.performance.success.final_pass).toBe(true);
    expect(result.excluded_episodes).toContainEqual({
      execution_episode_id: 'episode-orphan',
      reason: expect.stringContaining('não possui INITIAL'),
    });
    expect(result.series).toHaveLength(3);

    const seriesA = result.series.find((item) => item.identity.profile.profile_id.value === 'profile-a');
    const seriesB = result.series.find((item) => item.identity.profile.profile_id.value === 'profile-b');
    const seriesC = result.series.find((item) => item.identity.profile.profile_id.value === 'profile-c');
    expect(seriesA?.run_ids).toEqual([initial.runId, repair.runId]);
    expect(seriesA?.execution_by_role.INITIAL.run_ids).toEqual([initial.runId]);
    expect(seriesA?.execution_by_role.REPAIR.run_ids).toEqual([repair.runId]);
    expect(seriesA?.initial_routing_eligible).toBe(true);
    expect(seriesA?.routing_aggregations.final_pass_rate.value).toBe(1);
    expect(seriesB?.run_ids).toEqual([escalation.runId]);
    expect(seriesB?.execution_by_role.ESCALATION.run_ids).toEqual([escalation.runId]);
    expect(seriesB?.initial_routing_eligible).toBe(false);
    expect(seriesB?.routing_aggregations.trials.sample_size).toBe(0);
    expect(seriesC?.execution_by_role.REPAIR.run_ids).toEqual([orphanRepair.runId]);
    expect(seriesC?.initial_routing_eligible).toBe(false);
  });

  it('V2 trata interventions como evidência: ausente=UNKNOWN, []=zero provado, inválido=fail closed', async () => {
    const labRoot = await temporaryRoot();
    const proven = { id: 'profile-proven', argv: ['fake', '--profile', 'proven'] } as const;
    const legacy = { id: 'profile-legacy', argv: ['fake', '--profile', 'legacy'] } as const;
    const corrupted = { id: 'profile-corrupted', argv: ['fake', '--profile', 'corrupted'] } as const;
    const provenFacts = comparableFacts(proven, AttemptRole.INITIAL);
    const legacyFacts = comparableFacts(legacy, AttemptRole.INITIAL);
    const corruptedFacts = comparableFacts(corrupted, AttemptRole.INITIAL);
    const zeroArtifact = {
      schema_version: 1,
      provenance: 'lifecycle autônomo provou zero intervenções',
      interventions: [],
    };

    const trials: { trial_id: string; selection: EvaluationSelection }[] = [];
    for (let index = 0; index < 3; index += 1) {
      const provenRun = await buildRun({
        labRoot,
        runId: `01ARZ3NDEKTSV4RRFFQ69G5P0${index + 1}`,
        trialId: `trial-proven-${index + 1}`,
        taskId: 'task-interventions',
        outcome: EvaluationOutcome.PASS,
        facts: provenFacts,
        durationMs: 1_000,
        tokens: 100,
        historyContext: historyContext(
          `episode-proven-${index + 1}`,
          1,
          proven.id,
          provenFacts.profile_fingerprint_sha256.value as string,
        ),
        interventions: zeroArtifact,
      });
      const legacyRun = await buildRun({
        labRoot,
        runId: `01ARZ3NDEKTSV4RRFFQ69G5Q0${index + 1}`,
        trialId: `trial-legacy-${index + 1}`,
        taskId: 'task-interventions',
        outcome: EvaluationOutcome.PASS,
        facts: legacyFacts,
        durationMs: 1_000,
        tokens: 100,
        historyContext: historyContext(
          `episode-legacy-${index + 1}`,
          1,
          legacy.id,
          legacyFacts.profile_fingerprint_sha256.value as string,
        ),
      });
      trials.push(
        { trial_id: `trial-proven-${index + 1}`, selection: selection(provenRun.runId) },
        { trial_id: `trial-legacy-${index + 1}`, selection: selection(legacyRun.runId) },
      );
    }
    const corruptedRun = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5R01',
      trialId: 'trial-corrupted',
      taskId: 'task-interventions',
      outcome: EvaluationOutcome.PASS,
      facts: corruptedFacts,
      durationMs: 1_000,
      tokens: 100,
      historyContext: historyContext(
        'episode-corrupted',
        1,
        corrupted.id,
        corruptedFacts.profile_fingerprint_sha256.value as string,
      ),
      interventions: { schema_version: 1, interventions: 'nenhuma' },
    });
    trials.push({ trial_id: 'trial-corrupted', selection: selection(corruptedRun.runId) });

    const result = await queryPerformanceHistory({
      schema_version: 2,
      runs_dir: path.join(labRoot, 'data', 'runs'),
      minimum_sample_size: 3,
      work_definition_fingerprint_sha256: 'f'.repeat(64),
      trials,
    });

    const provenSeries = result.series.find((item) => item.identity.profile.profile_id.value === proven.id);
    const legacySeries = result.series.find((item) => item.identity.profile.profile_id.value === legacy.id);
    expect(provenSeries?.routing_aggregations.human_intervention_rate).toMatchObject({
      value: 0,
      sample_size: 3,
      status: 'AVAILABLE',
    });
    expect(legacySeries?.routing_aggregations.human_intervention_rate).toMatchObject({
      value: null,
      sample_size: 0,
      status: 'UNAVAILABLE',
    });
    expect(result.series.some((item) => item.identity.profile.profile_id.value === corrupted.id)).toBe(false);
    expect(result.excluded_runs).toContainEqual({
      trial_id: 'trial-corrupted',
      run_id: corruptedRun.runId,
      reason: expect.stringContaining('interventions.json'),
    });
  });

  it('V2 conta intervenção humana registrada no episódio', async () => {
    const labRoot = await temporaryRoot();
    const profile = { id: 'profile-intervened', argv: ['fake', '--profile', 'intervened'] } as const;
    const facts = comparableFacts(profile, AttemptRole.INITIAL);
    const fingerprint = facts.profile_fingerprint_sha256.value as string;
    const initial = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5S01',
      trialId: 'trial-intervened',
      taskId: 'task-interventions',
      outcome: EvaluationOutcome.FAIL,
      facts,
      durationMs: 1_000,
      tokens: 100,
      historyContext: historyContext('episode-intervened', 1, profile.id, fingerprint),
      interventions: { schema_version: 1, provenance: 'lifecycle autônomo', interventions: [] },
    });
    const afterHuman = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5S02',
      trialId: 'trial-intervened',
      taskId: 'task-interventions',
      outcome: EvaluationOutcome.PASS,
      facts: comparableFacts(profile, AttemptRole.REPAIR),
      durationMs: 1_000,
      tokens: 100,
      historyContext: historyContext('episode-intervened', 2, profile.id, fingerprint),
      interventions: {
        schema_version: 1,
        provenance: 'humano liberou gate de review REJECT',
        interventions: [
          {
            intervention_id: 'human-release:T1:attempt-1',
            type: 'design_decision',
            description: 'humano autorizou o attempt seguinte',
            occurred_at: '2026-08-20T10:00:00.000Z',
            affects_autonomy: true,
          },
        ],
      },
    });

    const result = await queryPerformanceHistory({
      schema_version: 2,
      runs_dir: path.join(labRoot, 'data', 'runs'),
      minimum_sample_size: 1,
      work_definition_fingerprint_sha256: 'f'.repeat(64),
      trials: [
        {
          trial_id: 'trial-intervened',
          selection: { ...selection(initial.runId), ...selection(afterHuman.runId) },
        },
      ],
    });
    expect(result.episodes[0]?.performance.intervention.human_intervention).toMatchObject({
      value: true,
      provenance: 'intervention_recorded',
    });
    expect(result.series[0]?.routing_aggregations.human_intervention_rate).toMatchObject({
      value: 1,
      sample_size: 1,
      status: 'AVAILABLE',
    });
  });

  it('V2 distingue zero, amostra insuficiente, série disponível e dimensão UNKNOWN', async () => {
    const labRoot = await temporaryRoot();
    const profile = { id: 'profile-history', argv: ['fake', '--profile', 'history'] } as const;
    const facts = comparableFacts(profile, AttemptRole.INITIAL);
    const fingerprint = facts.profile_fingerprint_sha256.value as string;
    const runs: RunDirectory[] = [];
    for (let index = 0; index < 3; index += 1) {
      runs.push(await buildRun({
        labRoot,
        runId: `01ARZ3NDEKTSV4RRFFQ69G5H0${index + 1}`,
        trialId: `trial-history-${index + 1}`,
        taskId: 'task-history',
        outcome: EvaluationOutcome.PASS,
        facts,
        durationMs: 1_000 + index,
        tokens: 100 + index,
        historyContext: historyContext(`episode-history-${index + 1}`, 1, profile.id, fingerprint),
      }));
    }
    const trials = runs.map((run, index) => ({
      trial_id: `trial-history-${index + 1}`,
      selection: selection(run.runId),
    }));
    const input = {
      schema_version: 2 as const,
      runs_dir: path.join(labRoot, 'data', 'runs'),
      minimum_sample_size: 3,
      work_definition_fingerprint_sha256: 'f'.repeat(64),
    };

    const empty = await queryPerformanceHistory({ ...input, trials: [] });
    expect(empty.episodes).toHaveLength(0);
    expect(empty.series).toHaveLength(0);

    const insufficient = await queryPerformanceHistory({ ...input, trials: trials.slice(0, 2) });
    expect(insufficient.series[0]?.routing_aggregations.final_pass_rate).toMatchObject({
      sample_size: 2,
      status: 'INSUFFICIENT_SAMPLE',
    });

    const available = await queryPerformanceHistory({ ...input, trials });
    expect(available.series[0]?.routing_aggregations.trials).toMatchObject({
      sample_size: 3,
      status: 'AVAILABLE',
    });
    expect(available.series[0]?.routing_aggregations.tokens.total).toMatchObject({
      sample_size: 3,
      population_size: 3,
      status: 'AVAILABLE',
    });
    expect(available.series[0]?.routing_aggregations.quota).toMatchObject({
      sample_size: 3,
      status: 'AVAILABLE',
    });
    expect(available.series[0]?.routing_aggregations.api_equivalent_usd).toMatchObject({
      sample_size: 3,
      status: 'AVAILABLE',
    });

    const unknownProfile = { id: 'profile-unknown-metric', argv: ['fake', '--profile', 'unknown'] } as const;
    const unknownFacts = comparableFacts(unknownProfile, AttemptRole.INITIAL);
    const unknownFingerprint = unknownFacts.profile_fingerprint_sha256.value as string;
    const unknownRuns: RunDirectory[] = [];
    for (let index = 0; index < 3; index += 1) {
      unknownRuns.push(await buildRun({
        labRoot,
        runId: `01ARZ3NDEKTSV4RRFFQ69G5J0${index + 1}`,
        trialId: `trial-unknown-${index + 1}`,
        taskId: 'task-history',
        outcome: EvaluationOutcome.PASS,
        facts: unknownFacts,
        durationMs: 1_000 + index,
        tokens: index === 2 ? null : 100 + index,
        historyContext: historyContext(`episode-unknown-${index + 1}`, 1, unknownProfile.id, unknownFingerprint),
      }));
    }
    const withUnknown = await queryPerformanceHistory({
      ...input,
      trials: [
        ...trials,
        ...unknownRuns.map((run, index) => ({
          trial_id: `trial-unknown-${index + 1}`,
          selection: selection(run.runId),
        })),
      ],
    });
    const unknownRequiredMetric = withUnknown.series.find(
      (series) => series.identity.profile.profile_id.value === unknownProfile.id,
    );
    expect(unknownRequiredMetric?.routing_aggregations.tokens.total).toMatchObject({
      sample_size: 2,
      population_size: 3,
      status: 'AVAILABLE',
    });

    const incompatibleFingerprint = await queryPerformanceHistory({
      ...input,
      trials,
      filter: { profile_fingerprint_sha256: '0'.repeat(64) },
    });
    expect(incompatibleFingerprint.series).toHaveLength(0);

    const incompatibleStack = await queryPerformanceHistory({
      ...input,
      trials,
      filter: { stack: ['python'] },
    });
    expect(incompatibleStack.series).toHaveLength(0);
  });

  it('mantém custo e quota ausentes como null com motivo e sample_size zero', async () => {
    const labRoot = await temporaryRoot();
    const run = await buildRun({
      labRoot,
      runId: '01ARZ3NDEKTSV4RRFFQ69G5Q00',
      trialId: 'trial-missing',
      taskId: 'task-missing',
      outcome: EvaluationOutcome.PASS,
      facts: comparableFacts(
        { id: 'profile-missing', argv: ['fake', '--mode', 'missing'] },
        AttemptRole.INITIAL,
      ),
      durationMs: 1_000,
      tokens: 100,
      includeQuota: false,
      includeApiEquivalent: false,
    });

    const result = await queryPerformanceHistory({
      runs_dir: path.join(labRoot, 'data', 'runs'),
      minimum_sample_size: 1,
      trials: [{ trial_id: 'trial-missing', selection: selection(run.runId) }],
    });
    const aggregates = result.series[0]?.aggregations;
    expect(aggregates?.quota).toMatchObject({
      value: null,
      sample_size: 0,
      status: 'UNAVAILABLE',
      reason: 'quota_usage não registrada',
    });
    expect(aggregates?.api_equivalent_usd).toMatchObject({
      value: null,
      sample_size: 0,
      status: 'UNAVAILABLE',
      reason: 'métrica não registrada',
    });
  });

  it('agrega somente série comparável, isola UNKNOWN e mesmo modelo com profile diferente, sem alterar records', async () => {
    const labRoot = await temporaryRoot();
    const profileV1 = { id: 'profile-a', argv: ['fake', '--mode', 'v1'] } as const;
    const profileV2 = { id: 'profile-a', argv: ['fake', '--mode', 'v2'] } as const;
    const fixtures = [
      await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5QA1', trialId: 'trial-a', taskId: 'task-a', outcome: EvaluationOutcome.PASS, facts: comparableFacts(profileV1, AttemptRole.INITIAL), durationMs: 1_000, tokens: 100 }),
      await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5QA2', trialId: 'trial-b', taskId: 'task-b', outcome: EvaluationOutcome.FAIL, facts: comparableFacts(profileV1, AttemptRole.REPAIR), durationMs: 3_000, tokens: 300 }),
      await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5QA3', trialId: 'trial-c', taskId: 'task-c', outcome: EvaluationOutcome.PASS, facts: comparableFacts(profileV2, AttemptRole.INITIAL), durationMs: 2_000, tokens: 200 }),
      await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5QA4', trialId: 'trial-d', taskId: 'task-d', outcome: EvaluationOutcome.PASS, facts: null, durationMs: 2_000, tokens: 200 }),
      await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5QA5', trialId: 'trial-e', taskId: 'task-e', outcome: EvaluationOutcome.PASS, facts: null, durationMs: 2_000, tokens: 200 }),
    ];
    const runsDir = path.join(labRoot, 'data', 'runs');
    const before = await snapshotFiles(path.join(labRoot, 'data'));

    const result = await queryPerformanceHistory({
      runs_dir: runsDir,
      minimum_sample_size: 2,
      trials: fixtures.map((run, index) => ({
        trial_id: `trial-${String.fromCharCode(97 + index)}`,
        selection: selection(run.runId),
      })),
    });

    expect(await snapshotFiles(path.join(labRoot, 'data'))).toEqual(before);
    expect(result.excluded_runs).toEqual([]);
    expect(result.series).toHaveLength(4);

    const merged = result.series.find((series) => series.trial_ids.length === 2);
    expect(merged?.automatic_merge_eligible).toBe(true);
    expect(merged?.trial_ids).toEqual(['trial-a', 'trial-b']);
    expect(merged?.aggregations.first_operational_pass_rate).toMatchObject({
      value: 0.5,
      sample_size: 2,
      status: 'AVAILABLE',
    });
    expect(merged?.aggregations.repair_rate).toMatchObject({ value: 0.5, sample_size: 2 });
    expect(merged?.aggregations.escalation_rate).toMatchObject({ value: 0, sample_size: 2 });
    expect(merged?.aggregations.duration_ms.value?.values).toEqual([1_000, 3_000]);
    expect(merged?.aggregations.duration_ms.value?.p90).toBe(3_000);
    expect(merged?.aggregations.tokens.total.value?.total).toBe(400);
    expect(merged?.aggregations.quota.value?.[0]?.consumed_pp.value?.total).toBe(4);
    expect(merged?.aggregations.api_equivalent_usd.value?.total).toBe(0.5);
    expect(merged?.aggregations.qualification.qualified_rate.value).toBe(1);
    expect(merged?.aggregations.context_pressure.value).toEqual({ low: 2 });
    expect(merged?.aggregations.human_intervention_rate).toMatchObject({
      value: null,
      sample_size: 0,
      status: 'UNAVAILABLE',
    });

    const changedProfile = result.series.find((series) => series.trial_ids[0] === 'trial-c');
    expect(changedProfile?.identity.execution.model.value).toBe('same-model');
    expect(changedProfile?.identity.profile.profile_id.value).toBe('profile-a');
    expect(changedProfile?.identity.series_key).not.toBe(merged?.identity.series_key);
    expect(changedProfile?.aggregations.final_pass_rate).toMatchObject({
      value: null,
      sample_size: 1,
      status: 'INSUFFICIENT_SAMPLE',
    });

    const unknownSeries = result.series.filter((series) => series.identity.series_key === null);
    expect(unknownSeries).toHaveLength(2);
    expect(unknownSeries.every((series) => series.trial_ids.length === 1)).toBe(true);
    expect(unknownSeries[0]?.identity.profile.profile_id.value).toBe(COMPARABLE_FACT_UNKNOWN);
    expect(unknownSeries[0]?.identity.blocking_unknown_dimensions).toContain(
      'profile.profile_fingerprint_sha256',
    );
  });
});
