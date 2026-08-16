/**
 * Slice ponta a ponta do caminho feliz: `init` → `task create` → prepara/
 * executa um run com o fake agent num clone descartável → `evaluate` num
 * workspace SEPARADO do agente → `score` → indexação SQLite → `report`.
 *
 * Fronteira: exercita exatamente o que o operador do lab faria, na ordem que
 * faria — sem atalho de estado em memória entre etapas que na vida real leem
 * só do disco (mesma garantia que cada teste isolado de CLI já cobre; aqui a
 * costura entre eles é o que importa).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus, QualificationStatus } from '../../src/core/enums.js';
import { evaluateRun } from '../../src/cli/evaluate.js';
import { buildRunReport, formatRunReportJson, formatRunReportText } from '../../src/cli/report.js';
import { executeRun, RUN_INDEX_FILE_NAME } from '../../src/cli/run-execute.js';
import { prepareRun } from '../../src/cli/run-prepare.js';
import { scoreRun } from '../../src/cli/score.js';
import { runTaskCreate } from '../../src/cli/task-create.js';
import { FAKE_ADAPTER_IDENTITY } from '../../src/adapters/index.js';
import { EVALUATION_PLAN_FILE_NAME } from '../../src/evaluator/index.js';
import type { GraderSpec } from '../../src/evaluator/index.js';
import { RunIndex, verifyRunIntegrity } from '../../src/storage/index.js';
import { EvaluationPlan, TaskSpec, type EnvironmentProfile, type Trial } from '../../src/schemas/index.js';
import { runAgentlabCli } from '../cli/helpers.js';

const execFileAsync = promisify(execFile);


const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-e2e-happy-path-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

interface FixtureRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

/** Repo-alvo mínimo — a "fixture repo" que o slice inteiro opera em cima. */
async function fixtureRepo(): Promise<FixtureRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], { env: GIT_ENV });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await writeFile(path.join(repoPath, 'README.md'), 'base\n', 'utf8');
  await git(repoPath, ['add', '--', 'README.md']);
  await git(repoPath, ['commit', '--quiet', '-m', 'base']);

  return { repoPath, baseSha: (await git(repoPath, ['rev-parse', 'HEAD'])).trim() };
}

function combinedTaskInput(): Record<string, unknown> {
  return {
    id: 'add-retry-policy',
    description: 'Adicionar retentativas limitadas ao cliente HTTP.',
    visible_criteria: ['Retenta somente erros transitórios.'],
    task_class: 'feature',
    difficulty: 'medium',
    stack: ['typescript'],
    public_graders: ['typecheck'],
    budgets: {
      duration_ms: { expected: 120_000, maximum: 300_000 },
      tokens: { expected: 8_000, maximum: 20_000 },
      changed_files: { expected: 3, maximum: 6 },
    },
    hidden_graders: ['patch-scope'],
    rubric: { 'patch-scope': 'o patch fica dentro do escopo esperado' },
    weights: { 'patch-scope': 1 },
  };
}

const environmentProfile: EnvironmentProfile = {
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

async function collectFilePaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectFilePaths(full)));
    } else {
      paths.push(full);
    }
  }
  return paths;
}

describe('slice E2E — caminho feliz', () => {
  it('init, task create, run, evaluate (workspace separado), score, índice SQLite e report — tudo verde', async () => {
    const source = await fixtureRepo();
    const labRoot = await temporaryRoot();
    const dataDir = path.join(labRoot, 'data');

    // 1. init — cria .agentlab/project.yaml no repo-alvo.
    const initResult = await runAgentlabCli(['init', '--repo', source.repoPath]);
    expect(initResult.exitCode).toBe(0);
    const projectYamlPath = path.join(source.repoPath, '.agentlab', 'project.yaml');
    expect(await readFile(projectYamlPath, 'utf8')).toContain('data_dir: data');

    // 2. task create — TaskSpec (público) e EvaluationPlan (privado) em arquivos separados.
    const inputPath = path.join(labRoot, 'task-input.json');
    await writeFile(inputPath, JSON.stringify(combinedTaskInput()), 'utf8');
    const taskCreateResult = await runTaskCreate({ input: inputPath, labRoot });

    const taskSpec = TaskSpec.parse(JSON.parse(await readFile(taskCreateResult.taskSpecPath, 'utf8')));
    const evaluationPlan = EvaluationPlan.parse(
      JSON.parse(await readFile(taskCreateResult.evaluationPlanPath, 'utf8')),
    );
    expect(evaluationPlan.hidden_graders).toEqual(['patch-scope']);

    // 3. trial — combina o TaskSpec público com agente, estratégia e ambiente.
    const trial: Trial = {
      id: 'trial-add-retry',
      task: taskSpec,
      agent: {
        id: 'fake-agent-profile',
        cli: 'fake',
        cli_version: '1.0.0',
        model: 'fake-model',
        flags: [],
      },
      strategy: {
        name: 'direct',
        version: 1,
        prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
      },
      environment: environmentProfile,
      status: 'PLANNED',
    };

    // 4. prepara o run: clone descartável + execution-envelope.json.
    const prepared = await prepareRun({
      trial,
      baseSha: source.baseSha,
      budgets: taskSpec.budgets,
      timeoutMs: 60_000,
      sourceRepo: source.repoPath,
      adapter: FAKE_ADAPTER_IDENTITY,
      labRoot,
      parentDir: await temporaryRoot(),
    });

    // EvaluationPlan nunca aparece no workspace do agente — busca no snapshot
    // inteiro do clone, antes de qualquer dispose, procurando o critério oculto.
    const agentSnapshotPaths = await collectFilePaths(prepared.clone.clonePath);
    for (const filePath of agentSnapshotPaths) {
      expect(path.basename(filePath)).not.toBe(EVALUATION_PLAN_FILE_NAME);
      const content = await readFile(filePath, 'utf8').catch(() => '');
      expect(content).not.toContain('patch-scope');
      expect(content).not.toContain('hidden_graders');
    }

    // 5. o fake agent "trabalha": muda um arquivo já rastreado no clone.
    await writeFile(path.join(prepared.clone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');

    // 6. executa: captura eventos, stream sanitizado e change bundle; sela execution/.
    const executed = await executeRun({ prepared });
    expect(executed.record.status).toBe(ExecutionStatus.COMPLETED);

    // 7. layout de evidência de execution/.
    const executionEntries = new Set(await readdir(prepared.executionDir));
    expect(executionEntries).toEqual(
      new Set([
        'execution-envelope.json',
        'execution-record.json',
        'events.jsonl',
        'provider-sanitized.jsonl',
        'prompt',
        'changes',
        'manifest.json',
      ]),
    );
    const providerSanitizedRaw = await readFile(
      path.join(prepared.executionDir, 'provider-sanitized.jsonl'),
      'utf8',
    );
    const providerSanitizedLines = providerSanitizedRaw.split('\n').filter((line) => line !== '');
    expect(providerSanitizedLines.length).toBeGreaterThan(0);
    for (const line of providerSanitizedLines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const changesEntries = await readdir(path.join(prepared.executionDir, 'changes'));
    expect(changesEntries).toContain('changes.patch');

    // ledger.jsonl na raiz do run, com a primeira entrada (execution).
    const ledgerAfterExecution = (await readFile(path.join(prepared.runDir, 'ledger.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line !== '');
    expect(ledgerAfterExecution).toHaveLength(1);
    expect(JSON.parse(ledgerAfterExecution[0]!)).toMatchObject({ section: 'execution', sequence: 1 });

    // 8. avalia num workspace SEPARADO do clone do agente (já descartado por `executeRun`).
    const evaluated = await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': PASS },
      evaluatorEnvironment: environmentProfile,
      parentDir: await temporaryRoot(),
    });
    expect(evaluated.record.outcome).toBe(EvaluationOutcome.PASS);

    const evaluationDir = path.join(prepared.runDir, 'evaluations', 'ev-1');
    expect(new Set(await readdir(evaluationDir))).toEqual(
      new Set(['evaluation-record.json', 'manifest.json', 'grader-artifacts']),
    );

    // 9. pontua.
    const scored = await scoreRun({ runDir: prepared.runDir, evaluationId: 'ev-1', scoreId: 'sc-1' });
    expect(scored.qualification.status).toBe(QualificationStatus.QUALIFIED);

    const scoreDir = path.join(prepared.runDir, 'scores', 'sc-1');
    expect(new Set(await readdir(scoreDir))).toEqual(
      new Set(['score-record.json', 'qualification-record.json', 'manifest.json']),
    );

    // ledger com as três seções, encadeado.
    const ledgerFinal = (await readFile(path.join(prepared.runDir, 'ledger.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { section: string; sequence: number; previous_entry_sha256: string | null });
    expect(ledgerFinal.map((entry) => entry.section)).toEqual(['execution', 'evaluations/ev-1', 'scores/sc-1']);
    expect(ledgerFinal[0]!.previous_entry_sha256).toBeNull();
    expect(ledgerFinal[1]!.previous_entry_sha256).not.toBeNull();
    expect(ledgerFinal[2]!.previous_entry_sha256).not.toBeNull();

    // integridade completa: nenhuma violação em todo o run selado.
    const integrity = await verifyRunIntegrity(prepared.runDir);
    expect(integrity.ok).toBe(true);
    expect(integrity.violations).toEqual([]);

    // 10. índice SQLite — task, trial e run aparecem depois de `executeRun`.
    const dbPath = path.join(dataDir, RUN_INDEX_FILE_NAME);
    const index = RunIndex.open(dbPath);
    try {
      expect(index.getTask('add-retry-policy')).toEqual({
        id: 'add-retry-policy',
        task_class: 'feature',
        difficulty: 'medium',
        description: taskSpec.description,
      });
      expect(index.getTrial('trial-add-retry')).toMatchObject({
        id: 'trial-add-retry',
        task_id: 'add-retry-policy',
        agent_id: 'fake-agent-profile',
        strategy_name: 'direct',
        status: 'EXECUTED',
      });
      const runRow = index.getRun(prepared.runId);
      expect(runRow?.run_dir).toBe(prepared.runDir);
      expect(runRow?.status).toBe(ExecutionStatus.COMPLETED);
    } finally {
      index.close();
    }

    // 11. report — as três dimensões, seladas, sem recálculo.
    const report = await buildRunReport({ runDir: prepared.runDir, evaluationId: 'ev-1', scoreId: 'sc-1' });
    expect(report.execution.status).toBe(ExecutionStatus.COMPLETED);
    expect(report.evaluation.outcome).toBe(EvaluationOutcome.PASS);
    expect(report.qualification.status).toBe(QualificationStatus.QUALIFIED);

    const text = formatRunReportText(report);
    expect(text).toContain('== Execução ==');
    expect(text).toContain('== Avaliação ==');
    expect(text).toContain('== Qualificação ==');

    const json = JSON.parse(formatRunReportJson(report));
    expect(json).toEqual(report);
  });
});
