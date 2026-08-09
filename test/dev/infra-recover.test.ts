import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { headSha } from '../../dev/lib/git.js';
import { InfraRecoveryError, recoverInfraAttempt } from '../../dev/lib/infra-recover.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  handoffDraftPath,
  infraAttemptEvidencePath,
  infraFailedAttemptPath,
  launchRecordPath,
  readInfraFailedAttempt,
  reportPath,
} from '../../dev/lib/records.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { launchTask, prepareNextTask } from '../../dev/lib/steps.js';
import { REPO_ROOT, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

/**
 * Recuperação de um attempt morto por falha terminal do provider.
 *
 * NENHUM teste deste arquivo chama Claude de verdade: a CLI é um fixture que
 * imita `auth status`, o probe `/usage` e o transporte `stream-json`. Nada aqui
 * gasta franquia nem toca a rede.
 */

const PROFILE_ID = 'claude-provider-stream-v1';
const FAKE_CLI_DIR = path.join(REPO_ROOT, 'fixtures', 'fake-clis');

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let originalPath: string | undefined;

/** Perfil de assinatura cujo binário é a CLI falsa completa do fixture. */
const PROFILE_YAML = `
id: ${PROFILE_ID}
agent: claude
billing_mode: subscription_only
environment_mode: real-world
commit_owner: orchestrator
official_validation_owner: orchestrator
worker_validation_policy: targeted
argv:
  - claude-provider
  - --print
  - --output-format
  - stream-json
  - --verbose
prompt_delivery: argv
timeout_seconds: 60
forbidden_flags:
  - --bare
env_allowlist:
  - PATH
  - HOME
  - LANG
  - LC_ALL
env_extra:
  AGENTLAB_FAKE_STREAM: api-error
control_markers: {}
notes:
  - 'Fixture: imita transporte e credencial; não fala com provider nenhum.'
`;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  await copyFile(
    path.join(REPO_ROOT, 'fixtures', 'fake-claude-stream.mjs'),
    path.join(sandbox.root, 'fixtures', 'fake-claude-stream.mjs'),
  );
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${PROFILE_ID}.yaml`),
    PROFILE_YAML,
    'utf8',
  );
  await runGit(sandbox.root, ['add', '-A']);
  await runGit(sandbox.root, ['commit', '-q', '-m', 'fixture do provider']);

  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, {
      baselineSha: await headSha(paths.repoRoot),
    }),
  );

  // O binário do perfil é resolvido pelo PATH do lançamento; a CLI falsa
  // precisa estar na frente para que nenhum `claude` real seja alcançado.
  originalPath = process.env['PATH'];
  process.env['PATH'] = `${FAKE_CLI_DIR}:${originalPath ?? ''}`;
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = originalPath;
  await rm(sandbox.root, { recursive: true, force: true });
});

function devEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    AGENTLAB_DEV_DIR: sandbox.devDir,
    PATH: `${FAKE_CLI_DIR}:${originalPath ?? ''}`,
    ...extra,
  };
}

/** Um attempt real do launcher contra o fixture: mesmo caminho do orquestrador. */
async function runFailedAttempt(): Promise<void> {
  const { packet } = await prepareNextTask(paths, loaded);
  if (!packet) throw new Error('nenhuma tarefa selecionada');
  const result = await launchTask(paths, packet, PROFILE_ID);
  if (result.classification !== 'INFRA_ERROR') {
    throw new Error(`esperado INFRA_ERROR, veio ${result.classification}: ${result.reason}`);
  }
}

function recoverCli(args: readonly string[] = []) {
  return runDevCli(
    'dev-recover-infra.ts',
    ['--repo', sandbox.root, '--task', 'T1', '--reason', 'provider caiu no attempt 1', ...args],
    devEnv(),
  );
}

function recover(overrides: Partial<Parameters<typeof recoverInfraAttempt>[0]> = {}) {
  return recoverInfraAttempt({
    paths,
    taskId: 'T1',
    reason: 'provider caiu no attempt 1',
    ...overrides,
  });
}

/** LaunchRecord como o harness gravava ANTES de saber classificar o provider. */
async function stripProviderFailureFromLaunchRecord(): Promise<void> {
  const file = launchRecordPath(paths, 'T1');
  const launch = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  delete launch['provider_failure'];
  await writeFile(file, `${JSON.stringify(launch, null, 2)}\n`, 'utf8');
}

/**
 * O incidente REAL da M33: o launcher classificava o run como FINISHED e o
 * fechamento parava pedindo um report que nunca existiu. Reproduz o state
 * exatamente como ele ficava antes desta manutenção.
 */
async function simulateLegacyFinalizingState(): Promise<void> {
  const state = await readState(paths);
  await writeState(
    paths,
    withTaskState(state, 'T1', {
      status: 'RUNNING',
      phase: 'FINALIZING',
      diagnostics: 'AgentCompletionReport ausente',
      finished_at: null,
    }),
  );
}

describe('orquestrador diante de falha terminal do provider', () => {
  it('E/F — para sem fechar a tarefa e sem iniciar a próxima', async () => {
    const result = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', PROFILE_ID, '--max-iterations', '2'],
      devEnv(),
    );

    expect(result.exitCode).toBe(9);
    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      reason: string;
      iterations: { task_id: string; launch: string; close: string | null }[];
    };
    expect(output.stopped_by).toBe('INFRA_ERROR');
    expect(output.reason).toMatch(/falha terminal do provider/);
    expect(output.iterations).toHaveLength(1);
    // Nenhum fechamento foi tentado: `close` fica null na iteração.
    expect(output.iterations[0]).toMatchObject({
      task_id: 'T1',
      launch: 'INFRA_ERROR',
      close: null,
    });

    const state = await readState(paths);
    expect(getTaskState(state, 'T1')).toMatchObject({
      status: 'INFRA_ERROR',
      phase: null,
      attempts: 1,
      candidate_commit: null,
    });
    // A tarefa seguinte não foi tocada.
    expect(getTaskState(state, 'T2')).toMatchObject({ status: 'READY', attempts: 0 });
    // O worker nunca escreveu: o inbox continua vazio.
    await expect(readFile(reportPath(paths, 'T1'))).rejects.toThrow();
  });

  it('D — a tarefa não vira FAIL de capacidade nem exige AgentCompletionReport', async () => {
    await runFailedAttempt();

    const task = getTaskState(await readState(paths), 'T1');
    expect(task.status).toBe('INFRA_ERROR');
    expect(task.diagnostics).toMatch(/falha terminal do provider/);
  });
});

describe('dev-recover-infra', () => {
  it('K/L — arquiva a evidência ANTES de liberar, e attempts não regride', async () => {
    await runFailedAttempt();
    const launchBefore = await readFile(launchRecordPath(paths, 'T1'));
    const stdoutBefore = await readFile(path.join(paths.logsDir, 'T1.stdout.log'));

    const result = await recoverCli();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'READY', attempt: 1 });

    const record = await readInfraFailedAttempt(paths, 'T1', 1);
    expect(record).toMatchObject({
      task_id: 'T1',
      attempt: 1,
      launch_classification: 'INFRA_ERROR',
      timed_out: false,
      worker_output_present: false,
      candidate_commit: null,
      reason_code: 'PROVIDER_TERMINAL_FAILURE',
    });
    expect(record?.provider_failure).toMatchObject({
      is_error: true,
      terminal_reason: 'api_error',
      message: 'API Error: Unable to connect to API (ENOTFOUND)',
    });

    // Evidência byte-idêntica, no diretório do attempt.
    expect(await readFile(infraAttemptEvidencePath(paths, 'T1', 1, 'launch.infra.json'))).toEqual(
      launchBefore,
    );
    expect(await readFile(infraAttemptEvidencePath(paths, 'T1', 1, 'stdout.log'))).toEqual(
      stdoutBefore,
    );
    expect(record?.evidence).toHaveLength(3);

    const task = getTaskState(await readState(paths), 'T1');
    expect(task).toMatchObject({
      status: 'READY',
      phase: null,
      process: null,
      attempts: 1,
      candidate_commit: null,
      accepted_commit: null,
    });
    expect(task.diagnostics).toMatch(/falha de infraestrutura do provider/);
  });

  it('G — o consumo observado (zero, aqui) é preservado no record do attempt', async () => {
    await runFailedAttempt();
    await recover();

    const record = await readInfraFailedAttempt(paths, 'T1', 1);
    expect(record?.billing?.provider_estimated_api_equivalent_usd).toBe(0);
    expect(record?.subscription_usage?.five_hour).toMatchObject({
      before_used_pct: 95,
      after_used_pct: 95,
      consumed_pp: 0,
    });
    expect(record?.exit_code).toBe(1);
  });

  it('caso M33 — RUNNING/FINALIZING com "AgentCompletionReport ausente" é recuperável', async () => {
    await runFailedAttempt();
    await simulateLegacyFinalizingState();

    const result = await recoverCli();
    expect(result.exitCode).toBe(0);

    expect(getTaskState(await readState(paths), 'T1')).toMatchObject({
      status: 'READY',
      attempts: 1,
    });
    expect(await readInfraFailedAttempt(paths, 'T1', 1)).not.toBeNull();
  });

  it('O — repetir é idempotente e não republica evidência divergente', async () => {
    await runFailedAttempt();
    const first = await recover();
    expect(first.alreadyArchived).toBe(false);

    const second = await recover();
    expect(second.alreadyArchived).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(getTaskState(await readState(paths), 'T1').attempts).toBe(1);
  });

  it('O — crash entre evidência e record converge na repetição', async () => {
    await runFailedAttempt();
    await expect(
      recover({
        afterEvidenceArchived: async () => {
          throw new Error('crash injetado');
        },
      }),
    ).rejects.toThrow('crash injetado');

    // A evidência já está publicada, o record não. A tarefa não mudou.
    expect(await readInfraFailedAttempt(paths, 'T1', 1)).toBeNull();
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');

    const result = await recover();
    expect(result.alreadyArchived).toBe(false);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('READY');
  });

  it('O — crash entre record e state também converge, sem duplicar o record', async () => {
    await runFailedAttempt();
    await expect(
      recover({
        afterRecordWritten: async () => {
          throw new Error('crash injetado');
        },
      }),
    ).rejects.toThrow('crash injetado');

    const published = await readInfraFailedAttempt(paths, 'T1', 1);
    expect(published).not.toBeNull();
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');

    const result = await recover();
    expect(result.record).toEqual(published);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('READY');
  });

  it('M — recusa quando a working tree tem trabalho inesperado', async () => {
    await runFailedAttempt();
    await writeFile(path.join(sandbox.root, 'patch-inesperado.txt'), 'algo\n', 'utf8');

    await expect(recover()).rejects.toThrow(/working tree suja/i);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');
  });

  it('M — recusa quando existe commit sobre o base_sha', async () => {
    await runFailedAttempt();
    await writeFile(path.join(sandbox.root, 'src-extra.txt'), 'algo\n', 'utf8');
    await runGit(sandbox.root, ['add', '-A']);
    await runGit(sandbox.root, ['commit', '-q', '-m', 'trabalho externo']);

    await expect(recover()).rejects.toThrow(/HEAD.*diverge do base_sha/i);
  });

  it('N — recusa quando o state registra candidate commit', async () => {
    await runFailedAttempt();
    const state = await readState(paths);
    await writeState(paths, withTaskState(state, 'T1', { candidate_commit: 'a'.repeat(40) }));

    await expect(recover()).rejects.toThrow(/candidate_commit precisa ser null/i);
  });

  it('D — recusa quando existe output do worker: esse caminho é do dev-retry', async () => {
    await runFailedAttempt();
    await mkdir(path.dirname(reportPath(paths, 'T1')), { recursive: true });
    await writeFile(reportPath(paths, 'T1'), '{}', 'utf8');

    await expect(recover()).rejects.toThrow(/AgentCompletionReport presente/i);

    await rm(reportPath(paths, 'T1'));
    await writeFile(handoffDraftPath(paths, 'T1'), '{}', 'utf8');
    await expect(recover()).rejects.toThrow(/HandoffDraft presente/i);
  });

  it('I — recusa attempt encerrado por timeout: timeout tem diagnóstico próprio', async () => {
    await runFailedAttempt();
    const file = launchRecordPath(paths, 'T1');
    const launch = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...launch, timed_out: true }, null, 2), 'utf8');

    await expect(recover()).rejects.toThrow(/timeout/i);
  });

  it('LaunchRecord anterior ao campo: a falha é derivada do stdout preservado', async () => {
    await runFailedAttempt();
    await stripProviderFailureFromLaunchRecord();

    const record = (await recover()).record;
    expect(record.provider_failure_source).toBe('stdout_stream');
    expect(record.provider_failure).toMatchObject({
      is_error: true,
      terminal_reason: 'api_error',
      message: 'API Error: Unable to connect to API (ENOTFOUND)',
    });
    expect(getTaskState(await readState(paths), 'T1').status).toBe('READY');
  });

  it('recusa quando nem o record nem o stdout provam falha terminal do provider', async () => {
    await runFailedAttempt();
    await stripProviderFailureFromLaunchRecord();
    await writeFile(
      path.join(paths.logsDir, 'T1.stdout.log'),
      `${JSON.stringify({ type: 'result', is_error: false, terminal_reason: 'completed' })}\n`,
      'utf8',
    );

    await expect(recover()).rejects.toThrow(InfraRecoveryError);
    await expect(recover()).rejects.toThrow(/o result do stream declarou término normal/i);
  });

  it('recusa derivar de stdout corrompido: o contrato do transporte continua valendo', async () => {
    await runFailedAttempt();
    await stripProviderFailureFromLaunchRecord();
    await writeFile(path.join(paths.logsDir, 'T1.stdout.log'), 'isto não é JSON\n', 'utf8');

    await expect(recover()).rejects.toThrow(/exatamente uma mensagem type=result/i);
  });

  it('recusa tarefa READY sem record correspondente e exige --reason', async () => {
    await runFailedAttempt();
    const state = await readState(paths);
    await writeState(paths, withTaskState(state, 'T1', { status: 'READY', phase: null }));

    await expect(recover()).rejects.toThrow(/sem InfraFailedAttemptRecord/i);
    await expect(recover({ reason: '  ' })).rejects.toThrow(/--reason/);
  });

  it('a retomada em READY confere a integridade da evidência arquivada', async () => {
    await runFailedAttempt();
    const record = (await recover()).record;
    await writeFile(
      infraAttemptEvidencePath(paths, 'T1', 1, 'stdout.log'),
      'evidência trocada\n',
      'utf8',
    );

    await expect(recover()).rejects.toThrow(/evidência arquivada foi alterada/i);
    expect(record.evidence).toHaveLength(3);
    expect(infraFailedAttemptPath(paths, 'T1', 1)).toMatch(/failed-attempts\/T1\/attempt-1\//);
  });
});

describe('dev-recover depois da recuperação de infra', () => {
  it('não encontra nada a reconciliar', async () => {
    await runFailedAttempt();
    await recover();

    const result = await runDevCli(
      'dev-recover.ts',
      ['--repo', sandbox.root, '--dry-run'],
      devEnv(),
    );
    const output = JSON.parse(result.stdout) as { reconciliations: unknown[] };
    expect(output.reconciliations).toEqual([]);
  });
});
