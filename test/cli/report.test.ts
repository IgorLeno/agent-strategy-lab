import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus, QualificationStatus } from '../../src/core/enums.js';
import { evaluateRun } from '../../src/cli/evaluate.js';
import { buildRunReport, formatRunReportJson, formatRunReportText, type RunReport } from '../../src/cli/report.js';
import { executeRun } from '../../src/cli/run-execute.js';
import { prepareRun, type PreparedRun } from '../../src/cli/run-prepare.js';
import { scoreRun } from '../../src/cli/score.js';
import { FAKE_ADAPTER_IDENTITY } from '../../src/adapters/index.js';
import type { EnvironmentProfile, EvaluationPlan, Trial } from '../../src/schemas/index.js';
import type { GraderSpec } from '../../src/evaluator/index.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_AGENT_ENTRY = path.join(REPO_ROOT, 'fixtures', 'fake-agent', 'index.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-report-cli-test-'));
  temporaryRoots.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

interface SourceRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

async function sourceRepo(): Promise<SourceRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], {
    env: GIT_ENV,
  });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await writeFile(path.join(repoPath, 'README.md'), 'base\n', 'utf8');
  await git(repoPath, ['add', '--', 'README.md']);
  await git(repoPath, ['commit', '--quiet', '-m', 'base']);

  return { repoPath, baseSha: (await git(repoPath, ['rev-parse', 'HEAD'])).trim() };
}

const budgets = {
  duration_ms: { expected: 120_000, maximum: 300_000 },
  tokens: { expected: 8_000, maximum: 20_000 },
  changed_files: { expected: 3, maximum: 6 },
};

function trial(): Trial {
  return {
    id: 'trial-add-retry',
    task: {
      id: 'add-retry-policy',
      description: 'Adicionar retentativas limitadas ao cliente HTTP.',
      visible_criteria: ['Retenta somente erros transitórios.'],
      task_class: 'feature',
      difficulty: 'medium',
      stack: ['typescript'],
      public_graders: ['typecheck'],
      budgets,
    },
    agent: {
      id: 'fake-agent-profile',
      cli: 'fake-agent',
      cli_version: '1.0.0',
      model: 'fake-model',
      flags: [],
    },
    strategy: {
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    },
    environment: {
      id: 'controlled-clean-room',
      mode: 'controlled',
      env_allowlist: ['PATH', 'LANG'],
      home: 'sanitized',
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    status: 'PLANNED',
  };
}

const evaluationPlan: EvaluationPlan = {
  hidden_graders: ['patch-scope'],
  rubric: { 'patch-scope': 'o patch fica dentro do escopo esperado' },
  weights: { 'patch-scope': 1 },
};

const evaluatorEnvironment: EnvironmentProfile = {
  id: 'controlled-clean-room',
  mode: 'controlled',
  env_allowlist: ['PATH', 'LANG'],
  home: 'sanitized',
  instruction_files: [],
  plugins: [],
  skills: [],
  mcp_servers: [],
};

function nodeArgv(source: string): string[] {
  return [process.execPath, '-e', source];
}

const PASS: GraderSpec = { argv: nodeArgv('process.exit(0)'), required: true, version: 'v1' };

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fullyScoredRun(): Promise<PreparedRun> {
  const labRoot = await temporaryRoot();
  const source = await sourceRepo();

  const prepared = await prepareRun({
    trial: trial(),
    baseSha: source.baseSha,
    budgets,
    timeoutMs: 60_000,
    sourceRepo: source.repoPath,
    adapter: FAKE_ADAPTER_IDENTITY,
    labRoot,
    parentDir: await temporaryRoot(),
  });

  await writeFile(
    path.join(prepared.clone.clonePath, 'README.md'),
    'base\nlinha do agente\n',
    'utf8',
  );

  await executeRun({
    prepared,
    argv: [process.execPath, FAKE_AGENT_ENTRY, 'success'],
  });

  await evaluateRun({
    runDir: prepared.runDir,
    evaluationId: 'ev-1',
    sourceRepo: source.repoPath,
    evaluationPlan,
    graders: { 'patch-scope': PASS },
    evaluatorEnvironment,
    parentDir: await temporaryRoot(),
  });

  await scoreRun({
    runDir: prepared.runDir,
    evaluationId: 'ev-1',
    scoreId: 'sc-1',
  });

  return prepared;
}

describe('buildRunReport', () => {
  it('lê execução, avaliação e qualificação já seladas, separadas em três blocos', async () => {
    const prepared = await fullyScoredRun();

    const report = await buildRunReport({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      scoreId: 'sc-1',
    });

    expect(report.execution.status).toBe(ExecutionStatus.COMPLETED);
    expect(report.evaluation.evaluation_id).toBe('ev-1');
    expect(report.evaluation.outcome).toBe(EvaluationOutcome.PASS);
    expect(report.qualification.status).toBe(QualificationStatus.QUALIFIED);
    expect(report.score.score_profile_id).toBe('v1');

    // As três dimensões vivem em campos distintos — nenhuma se sobrepõe.
    expect(Object.keys(report)).toEqual(['execution', 'evaluation', 'score', 'qualification']);
  });

  it('produz JSON estável — duas chamadas sobre a mesma evidência selada são idênticas', async () => {
    const prepared = await fullyScoredRun();

    const first = await buildRunReport({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      scoreId: 'sc-1',
    });
    const second = await buildRunReport({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      scoreId: 'sc-1',
    });

    const firstJson = formatRunReportJson(first);
    expect(formatRunReportJson(second)).toBe(firstJson);
    expect(JSON.parse(firstJson)).toEqual(JSON.parse(formatRunReportJson(first)));
  });

  it('a saída de texto mostra execução, avaliação e qualificação em blocos separados', async () => {
    const prepared = await fullyScoredRun();

    const report = await buildRunReport({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      scoreId: 'sc-1',
    });
    const text = formatRunReportText(report);

    const executionIndex = text.indexOf('== Execução ==');
    const evaluationIndex = text.indexOf('== Avaliação ==');
    const qualificationIndex = text.indexOf('== Qualificação ==');

    expect(executionIndex).toBeGreaterThanOrEqual(0);
    expect(evaluationIndex).toBeGreaterThan(executionIndex);
    expect(qualificationIndex).toBeGreaterThan(evaluationIndex);
    expect(text).toContain('status: COMPLETED');
    expect(text).toContain('evaluation_id: ev-1');
    expect(text).toContain(`status: ${QualificationStatus.QUALIFIED}`);
  });
});

describe('formatRunReportText / formatRunReportJson', () => {
  function reportWithMissingMetric(): RunReport {
    return {
      execution: {
        status: ExecutionStatus.COMPLETED,
        exit_code: 0,
        duration_ms: 1234,
        execution_envelope_sha256: '0'.repeat(64),
        metrics: {
          tokens: { value: null, provenance: 'no telemetry for this adapter' },
          changed_files: { value: 2, provenance: 'git diff --name-only' },
        },
      },
      evaluation: {
        evaluation_id: 'ev-1',
        outcome: EvaluationOutcome.PASS,
        grader_results: { 'patch-scope': { outcome: EvaluationOutcome.PASS, required: true } },
        grader_versions: { 'patch-scope': 'v1' },
        evaluation_envelope_sha256: '0'.repeat(64),
      },
      score: {
        score_profile_id: 'v1',
        score_profile_version: '1.0.0',
        sub_scores: {
          outcome: { value: 1, weight: 0.4, required: true },
          tokens: { value: null, weight: 0.2, required: false },
        },
        budgets_used: budgets,
        coverage: 0.8,
      },
      qualification: { status: QualificationStatus.QUALIFIED, justification: null },
    };
  }

  it('métrica ausente aparece como null com a origem registrada, nunca como zero', () => {
    const report = reportWithMissingMetric();
    const text = formatRunReportText(report);

    expect(text).toContain('tokens: null (origem: no telemetry for this adapter)');
    expect(text).not.toMatch(/tokens: 0\b/);

    const json = JSON.parse(formatRunReportJson(report)) as RunReport;
    expect(json.execution.metrics.tokens.value).toBeNull();
    expect(json.execution.metrics.tokens.provenance).toBe('no telemetry for this adapter');
    expect(json.score.sub_scores.tokens?.value).toBeNull();
  });

  it('--json produz saída parseável que reconstrói exatamente as três dimensões', () => {
    const report = reportWithMissingMetric();
    const parsed = JSON.parse(formatRunReportJson(report)) as RunReport;

    expect(parsed).toEqual(report);
  });
});
