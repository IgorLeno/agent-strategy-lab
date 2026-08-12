import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus } from '../../src/core/index.js';
import { executionEnvelopeSha256, type ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import {
  derivePerformance,
  listEvaluations,
  listScores,
  readTrialHistory,
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
  sealEvaluation,
  sealScore,
  RunIndex,
  type RunDirectory,
  type RunRecord,
} from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-history-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

const TASK_ID = 'task-history';
const TRIAL_ID = 'trial-history';

const budgets = {
  duration_ms: { expected: 1000, maximum: 5000 },
  tokens: { expected: 100, maximum: 1000 },
  changed_files: { expected: 1, maximum: 10 },
};

const taskSpec: TaskSpec = {
  id: TASK_ID,
  description: 'Corrigir o bug X',
  visible_criteria: ['os testes passam'],
  task_class: 'bugfix',
  difficulty: 'easy',
  stack: ['typescript'],
  public_graders: ['tests'],
  budgets,
};

const agentProfile: AgentProfile = {
  id: 'agent-claude',
  cli: 'claude-code',
  cli_version: '1.0.0',
  model: 'claude-sonnet-5',
  flags: ['reasoning_effort:high'],
};

const strategy: StrategyDef = { name: 'baseline', version: 1, prompt: 'Resolva a tarefa.' };

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

function buildEnvelope(): ExecutionEnvelopeManifest {
  return {
    task_spec: taskSpec,
    strategy,
    compiled_prompt: 'Resolva a tarefa.',
    base_sha: '0'.repeat(40),
    agent_profile: agentProfile,
    environment_profile: environmentProfile,
    adapter: { name: 'fake-agent', version: '1.0.0' },
    budgets,
    timeout_ms: 60_000,
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

interface BuildRunOptions {
  readonly labRoot: string;
  readonly runId: string;
  readonly status: ExecutionStatus;
  readonly tokens: number | null;
  readonly quotaUsage?: 'none' | 'valid' | 'invalid-schema' | 'tampered';
}

async function buildRun(options: BuildRunOptions): Promise<RunDirectory> {
  const run = await createIndexedRunDirectory(options.labRoot, options.runId);
  const envelope = buildEnvelope();
  const envelopeSha256 = executionEnvelopeSha256(envelope);

  await writeJson(path.join(run.executionDir, 'execution-envelope.json'), envelope);
  await writeJson(path.join(run.executionDir, 'execution-record.json'), {
    status: options.status,
    exit_code: options.status === ExecutionStatus.COMPLETED ? 0 : 1,
    duration_ms: 1234,
    execution_envelope_sha256: envelopeSha256,
    metrics: {
      tokens: { value: options.tokens, provenance: 'observed' },
      changed_files: { value: 1, provenance: 'observed' },
      input_tokens: { value: options.tokens, provenance: 'observed' },
      cached_input_tokens: { value: 0, provenance: 'observed' },
      output_tokens: { value: options.tokens, provenance: 'observed' },
    },
  });

  if (options.quotaUsage === 'valid' || options.quotaUsage === 'tampered') {
    await writeJson(path.join(run.executionDir, 'quota-usage.json'), validQuotaUsage());
  } else if (options.quotaUsage === 'invalid-schema') {
    // Presente e sintaticamente JSON, mas sem os campos que QuotaUsage exige.
    await writeJson(path.join(run.executionDir, 'quota-usage.json'), { provider: 'anthropic' });
  }

  await finalizeExecution(run.runDir);

  if (options.quotaUsage === 'tampered') {
    // Adulteração pós-selagem: bytes diferentes do que o manifest/ledger provam.
    await writeJson(path.join(run.executionDir, 'quota-usage.json'), {
      ...validQuotaUsage(),
      provider: 'tampered-provider',
    });
  }

  return run;
}

function validQuotaUsage(): QuotaUsage {
  return {
    provider: 'anthropic',
    observation: {
      status: QuotaObservationStatus.OBSERVED,
      reason_code: QuotaReasonCode.OK,
      provenance: 'probe',
    },
    windows: [
      {
        window_id: 'five_hour',
        before_used_pct: 10,
        after_used_pct: 12,
        consumed_pp: 2,
        same_window: true,
        reason_code: QuotaReasonCode.OK,
        provenance: 'probe',
      },
    ],
  };
}

async function createIndexedRunDirectory(labRoot: string, runId: string): Promise<RunDirectory> {
  const run = await createRunDirectory({ labRoot, runId });

  const runRecord: RunRecord = {
    task: { id: TASK_ID, task_class: taskSpec.task_class, difficulty: taskSpec.difficulty, description: taskSpec.description },
    trial: { id: TRIAL_ID, task_id: TASK_ID, agent_id: agentProfile.id, strategy_name: strategy.name, status: 'EXECUTED' },
    run: { run_id: runId, trial_id: TRIAL_ID, run_dir: run.runDir, created_at: new Date().toISOString(), status: null },
  };

  const index = RunIndex.open(path.join(run.dataDir, 'index.sqlite'));
  try {
    await index.indexRun(run.runDir, runRecord);
  } finally {
    index.close();
  }

  return run;
}

async function sealEvaluationRecord(
  runDir: string,
  evaluationId: string,
  outcome: EvaluationOutcome,
): Promise<void> {
  const record: EvaluationRecord = {
    evaluation_id: evaluationId,
    outcome,
    grader_results: { tests: { outcome, required: true } },
    grader_versions: { tests: '1.0.0' },
    evaluation_envelope_sha256: '1'.repeat(64),
  };
  await writeJson(path.join(runDir, 'evaluations', evaluationId, 'evaluation-record.json'), record);
  await sealEvaluation(runDir, evaluationId);
}

async function sealScoreRecord(runDir: string, scoreId: string): Promise<void> {
  const record: ScoreRecord = {
    score_profile_id: 'default',
    score_profile_version: '1.0.0',
    sub_scores: { correctness: { value: 1, weight: 1, required: true } },
    budgets_used: budgets,
    coverage: 1,
  };
  await writeJson(path.join(runDir, 'scores', scoreId, 'score-record.json'), record);
  await sealScore(runDir, scoreId);
}

describe('readTrialHistory', () => {
  it('M33-like fim a fim: INFRA_ERROR seguido de COMPLETED/PASS, com seleção pinada no record', async () => {
    const labRoot = await temporaryRoot();
    const runA = await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FA1', status: ExecutionStatus.INFRA_ERROR, tokens: 0 });
    const runB = await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FA2', status: ExecutionStatus.COMPLETED, tokens: 500 });
    await sealEvaluationRecord(runB.runDir, 'ev-1', EvaluationOutcome.PASS);
    await sealScoreRecord(runB.runDir, 'sc-1');

    const selection: EvaluationSelection = {
      [runB.runId]: { evaluation_id: 'ev-1', score_id: 'sc-1' },
    };

    const runsDir = path.join(labRoot, 'data', 'runs');
    const result = await readTrialHistory(runsDir, TRIAL_ID, selection);

    expect(result.excludedRuns).toEqual([]);
    expect(result.runs.map((run) => run.run_id)).toEqual([runA.runId, runB.runId]);

    const record = derivePerformance(result.history);
    expect(record.attempts.operational_attempts).toBe(2);
    expect(record.attempts.infra_error_attempts).toBe(1);
    expect(record.attempts.attempts_with_inference).toBe(1);
    expect(record.attempts.attempts_without_inference).toBe(1);
    expect(record.success.first_operational_pass).toBe(false);
    expect(record.success.first_inference_bearing_pass).toBe(true);
    expect(record.success.final_pass).toBe(true);

    const runBPerformance = result.runs[1]?.performance;
    expect(runBPerformance?.identity.evaluation_id).toBe('ev-1');
    expect(runBPerformance?.identity.score_id).toBe('sc-1');
    expect(runBPerformance?.quality.evaluation_outcome).toBe(EvaluationOutcome.PASS);
    expect(runBPerformance?.quality.score_profile_id).toBe('default');
    expect(runBPerformance?.quality.coverage).toBe(1);
  });

  it('uma segunda evaluation no mesmo run não muda o record derivado com a seleção original', async () => {
    const labRoot = await temporaryRoot();
    const run = await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FB1', status: ExecutionStatus.COMPLETED, tokens: 500 });
    await sealEvaluationRecord(run.runDir, 'ev-1', EvaluationOutcome.PASS);

    const runsDir = path.join(labRoot, 'data', 'runs');
    const selection: EvaluationSelection = { [run.runId]: { evaluation_id: 'ev-1', score_id: null } };

    const before = await readTrialHistory(runsDir, TRIAL_ID, selection);
    expect(before.excludedRuns).toEqual([]);
    const beforeSerialized = JSON.stringify(before.runs[0]?.performance);

    await sealEvaluationRecord(run.runDir, 'ev-2', EvaluationOutcome.FAIL);
    expect(await listEvaluations(run.runDir)).toEqual(['ev-1', 'ev-2']);

    const after = await readTrialHistory(runsDir, TRIAL_ID, selection);
    expect(after.excludedRuns).toEqual([]);
    expect(JSON.stringify(after.runs[0]?.performance)).toBe(beforeSerialized);
    expect(after.runs[0]?.performance.quality.evaluation_outcome).toBe(EvaluationOutcome.PASS);
  });

  it('sem seleção, outcome é NOT_EVALUATED e quality não inventa scalar score', async () => {
    const labRoot = await temporaryRoot();
    const run = await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FC1', status: ExecutionStatus.COMPLETED, tokens: 500 });
    await sealEvaluationRecord(run.runDir, 'ev-1', EvaluationOutcome.PASS);
    await sealScoreRecord(run.runDir, 'sc-1');
    expect(await listScores(run.runDir)).toEqual(['sc-1']);

    const runsDir = path.join(labRoot, 'data', 'runs');
    const result = await readTrialHistory(runsDir, TRIAL_ID, {});

    expect(result.excludedRuns).toEqual([]);
    const performance = result.runs[0]?.performance;
    expect(performance?.identity.evaluation_id).toBeNull();
    expect(performance?.identity.score_id).toBeNull();
    expect(performance?.quality.evaluation_outcome).toBe(EvaluationOutcome.NOT_EVALUATED);
    expect(performance?.quality.score_profile_id).toBeNull();
    expect(performance?.quality.score_profile_version).toBeNull();
    expect(performance?.quality.sub_scores).toBeNull();
    expect(performance?.quality.coverage).toBeNull();
    expect(result.history.attempts[0]?.evaluation_outcome).toBeNull();
  });

  it('run sem quota-usage.json produz quota_usage null com artifact_not_present', async () => {
    const labRoot = await temporaryRoot();
    const run = await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FD1', status: ExecutionStatus.COMPLETED, tokens: 500, quotaUsage: 'none' });

    const runsDir = path.join(labRoot, 'data', 'runs');
    const result = await readTrialHistory(runsDir, TRIAL_ID, {});

    expect(result.excludedRuns).toEqual([]);
    const quota = result.runs[0]?.performance.cost.quota_usage;
    expect(quota?.value).toBeNull();
    expect(quota?.provenance).toBe('artifact_not_present');
  });

  it('run com quota-usage.json válido expõe QuotaUsage parseado', async () => {
    const labRoot = await temporaryRoot();
    const run = await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FE1', status: ExecutionStatus.COMPLETED, tokens: 500, quotaUsage: 'valid' });

    const runsDir = path.join(labRoot, 'data', 'runs');
    const result = await readTrialHistory(runsDir, TRIAL_ID, {});

    expect(result.excludedRuns).toEqual([]);
    const quota = result.runs[0]?.performance.cost.quota_usage;
    expect(quota?.provenance).toBe('quota_usage_artifact');
    expect(quota?.value).toEqual(validQuotaUsage());
  });

  it('run com quota-usage.json presente mas inválido é excluído com motivo', async () => {
    const labRoot = await temporaryRoot();
    await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FF1', status: ExecutionStatus.COMPLETED, tokens: 500, quotaUsage: 'invalid-schema' });

    const runsDir = path.join(labRoot, 'data', 'runs');
    const result = await readTrialHistory(runsDir, TRIAL_ID, {});

    expect(result.runs).toEqual([]);
    expect(result.excludedRuns).toHaveLength(1);
    expect(result.excludedRuns[0]?.reason).toContain('quota-usage.json');
  });

  it('run com quota-usage.json adulterado após a selagem é excluído por integridade violada', async () => {
    const labRoot = await temporaryRoot();
    await buildRun({ labRoot, runId: '01ARZ3NDEKTSV4RRFFQ69G5FG1', status: ExecutionStatus.COMPLETED, tokens: 500, quotaUsage: 'tampered' });

    const runsDir = path.join(labRoot, 'data', 'runs');
    const result = await readTrialHistory(runsDir, TRIAL_ID, {});

    expect(result.runs).toEqual([]);
    expect(result.excludedRuns).toHaveLength(1);
    expect(result.excludedRuns[0]?.reason).toContain('integridade violada');
  });
});
