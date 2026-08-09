import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome } from '../../src/core/enums.js';
import { evaluateRun } from '../../src/cli/evaluate.js';
import { executeRun } from '../../src/cli/run-execute.js';
import { prepareRun, type PreparedRun } from '../../src/cli/run-prepare.js';
import { FAKE_ADAPTER_IDENTITY } from '../../src/adapters/index.js';
import { LEDGER_FILE_NAME } from '../../src/storage/index.js';
import { EvaluationRecord as EvaluationRecordSchema } from '../../src/schemas/index.js';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-evaluate-cli-test-'));
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
const FAIL: GraderSpec = { argv: nodeArgv('process.exit(1)'), required: true, version: 'v1' };

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function executedRun(labRoot: string, source: SourceRepo): Promise<PreparedRun> {
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

  // O fake agent só emite eventos — quem materializa a mudança capturada pelo
  // change bundle é o teste, do mesmo jeito que faria a estratégia real.
  await writeFile(
    path.join(prepared.clone.clonePath, 'README.md'),
    'base\nlinha do agente\n',
    'utf8',
  );

  await executeRun({
    prepared,
    argv: [process.execPath, FAKE_AGENT_ENTRY, 'success'],
  });

  return prepared;
}

describe('evaluateRun', () => {
  it('cria EvaluationRecord para um run já selado', async () => {
    const labRoot = await temporaryRoot();
    const source = await sourceRepo();
    const prepared = await executedRun(labRoot, source);

    const result = await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': PASS },
      evaluatorEnvironment,
      parentDir: await temporaryRoot(),
    });

    expect(result.evaluationId).toBe('ev-1');
    expect(result.record.outcome).toBe(EvaluationOutcome.PASS);
    expect(EvaluationRecordSchema.parse(result.record)).toEqual(result.record);
    expect(result.sealed.section).toBe('evaluations/ev-1');

    const sectionDir = path.join(prepared.runDir, 'evaluations', 'ev-1');
    const persisted = JSON.parse(
      await readFile(path.join(sectionDir, 'evaluation-record.json'), 'utf8'),
    );
    expect(persisted.evaluation_id).toBe('ev-1');
  });

  it('rodar de novo cria um segundo diretório, sem sobrescrever o primeiro', async () => {
    const labRoot = await temporaryRoot();
    const source = await sourceRepo();
    const prepared = await executedRun(labRoot, source);

    const first = await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': PASS },
      evaluatorEnvironment,
      parentDir: await temporaryRoot(),
    });
    const firstRecordBefore = await readFile(
      path.join(prepared.runDir, 'evaluations', 'ev-1', 'evaluation-record.json'),
      'utf8',
    );

    const second = await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-2',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': FAIL },
      evaluatorEnvironment,
      parentDir: await temporaryRoot(),
    });

    expect(first.record.outcome).toBe(EvaluationOutcome.PASS);
    expect(second.record.outcome).toBe(EvaluationOutcome.FAIL);
    expect(second.sealed.section).toBe('evaluations/ev-2');

    await expect(
      readFile(path.join(prepared.runDir, 'evaluations', 'ev-1', 'evaluation-record.json'), 'utf8'),
    ).resolves.toBe(firstRecordBefore);

    expect((await readdir(path.join(prepared.runDir, 'evaluations'))).sort()).toEqual([
      'ev-1',
      'ev-2',
    ]);
  });

  it('ledger ganha uma entrada por avaliação', async () => {
    const labRoot = await temporaryRoot();
    const source = await sourceRepo();
    const prepared = await executedRun(labRoot, source);

    await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': PASS },
      evaluatorEnvironment,
      parentDir: await temporaryRoot(),
    });
    await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-2',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': PASS },
      evaluatorEnvironment,
      parentDir: await temporaryRoot(),
    });

    const ledgerContent = await readFile(path.join(prepared.runDir, LEDGER_FILE_NAME), 'utf8');
    const entries = ledgerContent
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { section: string });

    // execution + duas avaliações.
    expect(entries.map((entry) => entry.section)).toEqual([
      'execution',
      'evaluations/ev-1',
      'evaluations/ev-2',
    ]);
  });
});
