/**
 * Slice ponta a ponta de hardening do Marco 1: adulteração de artifact
 * detectada, zero vazamento de secrets em `data/` mesmo com um run
 * contaminado, e estabilidade do `execution_envelope_sha256` entre duas
 * preparações com a mesma config — só o envelope de avaliação muda quando o
 * hidden grader muda. Mesma fronteira operacional do caminho feliz (M39A):
 * clone descartável, execução, avaliação sobre disco, nada em memória entre
 * etapas.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { evaluateRun } from '../../src/cli/evaluate.js';
import { executeRun } from '../../src/cli/run-execute.js';
import { prepareRun } from '../../src/cli/run-prepare.js';
import { runTaskCreate } from '../../src/cli/task-create.js';
import { FAKE_ADAPTER_IDENTITY } from '../../src/adapters/index.js';
import type { GraderSpec } from '../../src/evaluator/index.js';
import { verifyRunIntegrity } from '../../src/storage/index.js';
import { EvaluationPlan, TaskSpec, type EnvironmentProfile, type Trial } from '../../src/schemas/index.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-e2e-hardening-'));
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

/** Mesmo repo-alvo mínimo do caminho feliz — cada cenário recebe o seu próprio. */
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

function combinedTaskInput(hiddenGrader: string): Record<string, unknown> {
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
    hidden_graders: [hiddenGrader],
    rubric: { [hiddenGrader]: 'o patch fica dentro do escopo esperado' },
    weights: { [hiddenGrader]: 1 },
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

interface TaskFixture {
  readonly taskSpec: TaskSpec;
  readonly evaluationPlan: EvaluationPlan;
}

async function createTask(labRoot: string, hiddenGrader: string): Promise<TaskFixture> {
  const inputPath = path.join(labRoot, 'task-input.json');
  await writeFile(inputPath, JSON.stringify(combinedTaskInput(hiddenGrader)), 'utf8');
  const result = await runTaskCreate({ input: inputPath, labRoot });

  return {
    taskSpec: TaskSpec.parse(JSON.parse(await readFile(result.taskSpecPath, 'utf8'))),
    evaluationPlan: EvaluationPlan.parse(JSON.parse(await readFile(result.evaluationPlanPath, 'utf8'))),
  };
}

function trialFor(taskSpec: TaskSpec): Trial {
  return {
    id: 'trial-add-retry',
    task: taskSpec,
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
    environment: environmentProfile,
    status: 'PLANNED',
  };
}

/** Lê recursivamente todo arquivo sob `root`, como bytes crus — sem assumir texto ou JSON. */
async function collectFileBuffers(root: string): Promise<Buffer[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const buffers: Buffer[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      buffers.push(...(await collectFileBuffers(full)));
    } else if (entry.isFile()) {
      buffers.push(await readFile(full));
    }
  }
  return buffers;
}

describe('slice E2E — hardening do Marco 1', () => {
  it('adulterar um artifact do slice real (execution/) é detectado pela reverificação de integridade', async () => {
    const source = await fixtureRepo();
    const labRoot = await temporaryRoot();
    const { taskSpec } = await createTask(labRoot, 'patch-scope');
    const trial = trialFor(taskSpec);

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

    await writeFile(path.join(prepared.clone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');
    await executeRun({ prepared, argv: [process.execPath, FAKE_AGENT_ENTRY, 'success'] });

    // A seção acabou de selar: a reverificação a partir do disco confirma
    // integridade antes de qualquer adulteração.
    const before = await verifyRunIntegrity(prepared.runDir);
    expect(before.ok).toBe(true);
    expect(before.violations).toEqual([]);

    // Adultera um artifact já selado — mesmo caminho que um operador mal
    // intencionado (ou um bug de disco) tocaria depois do fato.
    const eventsPath = path.join(prepared.executionDir, 'events.jsonl');
    const original = await readFile(eventsPath, 'utf8');
    await writeFile(eventsPath, `${original}{"type":"unknown","raw":"linha injetada depois do selo"}\n`, 'utf8');

    const after = await verifyRunIntegrity(prepared.runDir);
    expect(after.ok).toBe(false);
    expect(after.violations).toContainEqual(
      expect.objectContaining({
        kind: 'ARTIFACT_MODIFIED',
        section: 'execution',
        artifact: 'events.jsonl',
      }),
    );
  });

  it('secrets falsos que atravessam a execução não aparecem em nenhum arquivo de data/ depois do run', async () => {
    const FAKE_SECRET = 'sk-ant-api03-hardening-fake-secret-1234567890abcdef';
    const source = await fixtureRepo();
    const labRoot = await temporaryRoot();
    const dataDir = path.join(labRoot, 'data');
    const { taskSpec, evaluationPlan } = await createTask(labRoot, 'patch-scope');
    const trial = trialFor(taskSpec);

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

    await writeFile(path.join(prepared.clone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');

    // Argv próprio, não o fixture fake-agent: emite uma linha CRUA (não é a
    // interface interna) contendo um segredo de formato reconhecido, igual ao
    // caso `malformed-stream` documentado em fixtures/fake-agent — é
    // exatamente esse caminho (evento `unknown`) que passa por `redactString`
    // antes de qualquer artifact ir para o disco.
    const contaminatedAgent = nodeArgv(
      [
        `process.stdout.write(JSON.stringify({type:'message',role:'assistant',text:'Analisando a tarefa.'}) + '\\n')`,
        `process.stdout.write('token vazado: ${FAKE_SECRET}\\n')`,
        `process.stdout.write(JSON.stringify({type:'result',outcome:'success',tokens:16,changed_files:1}) + '\\n')`,
      ].join(';\n'),
    );

    const executed = await executeRun({ prepared, argv: contaminatedAgent });
    expect(executed.record.exit_code).toBe(0);

    const evaluated = await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': PASS },
      evaluatorEnvironment: environmentProfile,
      parentDir: await temporaryRoot(),
    });
    expect(evaluated.record.outcome).toBeDefined();

    // Nenhum arquivo escrito por baixo de data/ — eventos, stream sanitizado,
    // manifests, ledger, índice sqlite — contém o segredo em claro.
    const secretBytes = Buffer.from(FAKE_SECRET, 'utf8');
    const dataFiles = await collectFileBuffers(dataDir);
    expect(dataFiles.length).toBeGreaterThan(0);
    for (const buffer of dataFiles) {
      expect(buffer.includes(secretBytes)).toBe(false);
    }

    // A evidência de que a redaction de fato agiu (não que o segredo nunca
    // foi emitido): events.jsonl guarda o placeholder no lugar dele.
    const eventsRaw = await readFile(path.join(prepared.executionDir, 'events.jsonl'), 'utf8');
    expect(eventsRaw).toContain('[REDACTED');
  });

  it('duas preparações com a mesma config produzem o mesmo execution_envelope_sha256; só o envelope de avaliação muda com o hidden grader', async () => {
    const source = await fixtureRepo();
    const labRootA = await temporaryRoot();
    const labRootB = await temporaryRoot();

    const taskA = await createTask(labRootA, 'patch-scope');
    const taskB = await createTask(labRootB, 'patch-scope-v2');

    // O hidden grader muda o EvaluationPlan (privado), nunca o TaskSpec
    // (público) — é por isso que o envelope de execução, que só depende do
    // TaskSpec, não deveria mudar.
    expect(taskA.taskSpec).toEqual(taskB.taskSpec);
    expect(taskA.evaluationPlan).not.toEqual(taskB.evaluationPlan);

    const trial = trialFor(taskA.taskSpec);

    const preparedA = await prepareRun({
      trial,
      baseSha: source.baseSha,
      budgets: taskA.taskSpec.budgets,
      timeoutMs: 60_000,
      sourceRepo: source.repoPath,
      adapter: FAKE_ADAPTER_IDENTITY,
      labRoot: labRootA,
      parentDir: await temporaryRoot(),
    });
    const preparedB = await prepareRun({
      trial,
      baseSha: source.baseSha,
      budgets: taskA.taskSpec.budgets,
      timeoutMs: 60_000,
      sourceRepo: source.repoPath,
      adapter: FAKE_ADAPTER_IDENTITY,
      labRoot: labRootB,
      parentDir: await temporaryRoot(),
    });

    expect(preparedB.executionEnvelopeSha256).toBe(preparedA.executionEnvelopeSha256);

    await writeFile(path.join(preparedA.clone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');
    await writeFile(path.join(preparedB.clone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');

    const executedA = await executeRun({ prepared: preparedA, argv: [process.execPath, FAKE_AGENT_ENTRY, 'success'] });
    const executedB = await executeRun({ prepared: preparedB, argv: [process.execPath, FAKE_AGENT_ENTRY, 'success'] });

    // Sela em runs diferentes, mas ambos carregam o mesmo digest de execução.
    expect(executedA.record.execution_envelope_sha256).toBe(preparedA.executionEnvelopeSha256);
    expect(executedB.record.execution_envelope_sha256).toBe(executedA.record.execution_envelope_sha256);

    const evaluatedA = await evaluateRun({
      runDir: preparedA.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan: taskA.evaluationPlan,
      graders: { 'patch-scope': PASS },
      evaluatorEnvironment: environmentProfile,
      parentDir: await temporaryRoot(),
    });
    const evaluatedB = await evaluateRun({
      runDir: preparedB.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan: taskB.evaluationPlan,
      graders: { 'patch-scope-v2': PASS },
      evaluatorEnvironment: environmentProfile,
      parentDir: await temporaryRoot(),
    });

    // Mudar o hidden grader muda só o envelope de avaliação: o de execução
    // (embutido no manifest de avaliação) segue idêntico nos dois runs.
    expect(evaluatedB.record.evaluation_envelope_sha256).not.toBe(evaluatedA.record.evaluation_envelope_sha256);
  });
});
