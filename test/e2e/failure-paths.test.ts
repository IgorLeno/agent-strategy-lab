/**
 * Slice ponta a ponta dos caminhos de falha: timeout (TIMED_OUT), fake
 * failure (COMPLETED com avaliação FAIL) e child-process-leak (cleanup não
 * confirmado). Mesma fronteira operacional do caminho feliz (M39A) — clone
 * descartável, execução, avaliação e score sobre disco — só que cada `it`
 * aqui empurra o fake agent por um desfecho não-feliz.
 *
 * Nenhuma asserção depende de qual evento o processo chegou a emitir antes de
 * ser morto pelo timeout: a ordem em que `stdout` é escrito e flushado versus
 * o sinal de kill não é determinística, então a dimensão de execução
 * (`ExecutionRecord.status`, `exit_code`, métricas) é o que se verifica —
 * nunca o conteúdo de `events.jsonl` do caso de timeout.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus, QualificationStatus } from '../../src/core/enums.js';
import { evaluateRun } from '../../src/cli/evaluate.js';
import { executeRun } from '../../src/cli/run-execute.js';
import { prepareRun } from '../../src/cli/run-prepare.js';
import { scoreRun } from '../../src/cli/score.js';
import { runTaskCreate } from '../../src/cli/task-create.js';
import { FAKE_ADAPTER_IDENTITY, FAKE_AGENT_VARIANT_ENV } from '../../src/adapters/index.js';
import type { GraderSpec } from '../../src/evaluator/index.js';
import { ProcessGroupSurvivorError } from '../../src/runner/index.js';
import { EvaluationPlan, TaskSpec, type EnvironmentProfile, type Trial } from '../../src/schemas/index.js';

const execFileAsync = promisify(execFile);


const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];
/** pids de descendentes escapados que um teste precisou matar à mão — nenhum sobrevive à suíte. */
const strayPids: number[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-e2e-failure-paths-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  for (const pid of strayPids.splice(0)) {
    killIfAlive(pid);
  }
});

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

interface FixtureRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

/** Mesmo repo-alvo mínimo do caminho feliz — cada `it` recebe o seu próprio. */
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

/** Grader obrigatório que sempre reprova — existe só para o caso fake-failure. */
const FAIL: GraderSpec = { argv: nodeArgv('process.exit(1)'), required: true, version: 'v1' };

interface Scenario {
  readonly source: FixtureRepo;
  readonly labRoot: string;
  readonly taskSpec: TaskSpec;
  readonly evaluationPlan: EvaluationPlan;
  readonly trial: Trial;
}

/** Monta task + trial válidos, um repo-alvo e um lab root novos para o cenário. */
async function setupScenario(): Promise<Scenario> {
  const source = await fixtureRepo();
  const labRoot = await temporaryRoot();

  const inputPath = path.join(labRoot, 'task-input.json');
  await writeFile(inputPath, JSON.stringify(combinedTaskInput()), 'utf8');
  const taskCreateResult = await runTaskCreate({ input: inputPath, labRoot });

  const taskSpec = TaskSpec.parse(JSON.parse(await readFile(taskCreateResult.taskSpecPath, 'utf8')));
  const evaluationPlan = EvaluationPlan.parse(
    JSON.parse(await readFile(taskCreateResult.evaluationPlanPath, 'utf8')),
  );

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

  return { source, labRoot, taskSpec, evaluationPlan, trial };
}

describe('slice E2E — caminhos de falha', () => {
  it('timeout: processo que nunca termina sela TIMED_OUT sem tokens nem changed_files', async () => {
    const { source, labRoot, taskSpec, trial } = await setupScenario();

    const prepared = await prepareRun({
      trial,
      baseSha: source.baseSha,
      budgets: taskSpec.budgets,
      timeoutMs: 200,
      sourceRepo: source.repoPath,
      adapter: FAKE_ADAPTER_IDENTITY,
      labRoot,
      parentDir: await temporaryRoot(),
    });

    const executed = await executeRun({
      prepared,
      env: { ...process.env, [FAKE_AGENT_VARIANT_ENV]: 'timeout' },
    });

    expect(executed.record.status).toBe(ExecutionStatus.TIMED_OUT);
    expect(executed.record.exit_code).toBeNull();
    expect(executed.record.metrics.tokens.value).toBeNull();
    expect(executed.record.metrics.changed_files.value).toBeNull();

    // Mesmo com timeout, a seção sela por completo — evidência parcial preservada.
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

    const ledger = (await readFile(path.join(prepared.runDir, 'ledger.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line !== '');
    expect(ledger).toHaveLength(1);
    expect(JSON.parse(ledger[0]!)).toMatchObject({ section: 'execution', sequence: 1 });
  });

  it('fake failure: exit 0 com result de outcome failure sela COMPLETED, e avaliação vira FAIL', async () => {
    const { source, labRoot, taskSpec, evaluationPlan, trial } = await setupScenario();

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

    // O fake agent só relata a tarefa como falha — quem muda o workspace é o
    // teste, do mesmo jeito que o caminho feliz (M39A): sem isso o change
    // bundle fica vazio e o clone do evaluator não tem patch nenhum a aplicar.
    await writeFile(path.join(prepared.clone.clonePath, 'README.md'), 'base\ntentativa que falhou\n', 'utf8');

    const executed = await executeRun({
      prepared,
      env: { ...process.env, [FAKE_AGENT_VARIANT_ENV]: 'failure' },
    });

    // Outcome relatado é `failure`, mas a execução em si terminou por completo.
    expect(executed.record.status).toBe(ExecutionStatus.COMPLETED);
    expect(executed.record.exit_code).toBe(0);
    expect(executed.record.metrics.tokens.value).toBe(64);
    expect(executed.record.metrics.changed_files.value).toBe(0);

    const evaluated = await evaluateRun({
      runDir: prepared.runDir,
      evaluationId: 'ev-1',
      sourceRepo: source.repoPath,
      evaluationPlan,
      graders: { 'patch-scope': FAIL },
      evaluatorEnvironment: environmentProfile,
      parentDir: await temporaryRoot(),
    });
    expect(evaluated.record.outcome).toBe(EvaluationOutcome.FAIL);

    const scored = await scoreRun({ runDir: prepared.runDir, evaluationId: 'ev-1', scoreId: 'sc-1' });
    // Métricas obrigatórias presentes (execução COMPLETED com result) — o teto
    // de FAIL zera os sub-scores medidos, mas nenhuma métrica falta.
    expect(scored.qualification.status).toBe(QualificationStatus.QUALIFIED);
    expect(scored.score.sub_scores['outcome']).toMatchObject({ value: 0 });
  });

  it('child-process-leak: descendente escapado do group rejeita a execução, e nada sobrevive ao teste', async () => {
    const { source, labRoot, taskSpec, trial } = await setupScenario();

    const prepared = await prepareRun({
      trial,
      baseSha: source.baseSha,
      budgets: taskSpec.budgets,
      // Generoso o bastante para o descendente detached aparecer em `/proc`
      // antes da foto do timeout: spawnar um processo node novo mede na casa
      // de algumas centenas de ms neste ambiente, e a foto de
      // `snapshotCandidates` (timeout.ts) só pega quem já existe no instante
      // do SIGTERM — tarde demais para o filho não conta como sobrevivente.
      timeoutMs: 1_000,
      sourceRepo: source.repoPath,
      adapter: FAKE_ADAPTER_IDENTITY,
      labRoot,
      parentDir: await temporaryRoot(),
    });

    let caught: unknown;
    try {
      await executeRun({
        prepared,
        env: { ...process.env, [FAKE_AGENT_VARIANT_ENV]: 'child-process-leak' },
        // Bem menor que os 5s de vida do descendente escapado (ver
        // fixtures/fake-agent): a confirmação vence com ele ainda vivo, e é
        // exatamente isso que este cenário verifica — não um cleanup lento.
        cleanupConfirmTimeoutMs: 600,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProcessGroupSurvivorError);
    const survivorError = caught as ProcessGroupSurvivorError;
    expect(survivorError.survivors.length).toBeGreaterThan(0);

    // Cleanup não confirmado nunca sela: a execução propaga como rejeição
    // antes de qualquer artifact além do envelope existir, e nada indexa um
    // desfecho COMPLETED silencioso.
    expect(new Set(await readdir(prepared.executionDir))).toEqual(new Set(['execution-envelope.json']));
    await expect(readFile(path.join(prepared.runDir, 'ledger.jsonl'), 'utf8')).rejects.toThrow();

    // O descendente escapou do process group do run — `-pgid` nunca o alcança
    // — mas o pid em si é conhecido pela foto que `confirmCleanup` tirou.
    // Matar por pid é limpeza do teste, não parte do contrato do produto: o
    // cenário confirma que a suíte não deixa o processo escapado vivo, e não
    // que o produto o teria matado sozinho.
    strayPids.push(...survivorError.survivors);
    for (const pid of survivorError.survivors) {
      killIfAlive(pid);
    }
    for (const pid of survivorError.survivors) {
      expect(await waitUntilDead(pid, 2_000)).toBe(true);
    }
  });
});
