import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { headSha } from '../../dev/lib/git.js';
import { InfraRecoveryError, recoverInfraAttempt } from '../../dev/lib/infra-recover.js';
import {
  adoptMaintenanceRange,
  type MaintenanceValidationRunner,
} from '../../dev/lib/maintenance.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  handoffDraftPath,
  infraAttemptEvidencePath,
  infraFailedAttemptPath,
  launchRecordPath,
  readInfraFailedAttempt,
  readValidationFailedAttempt,
  reportPath,
  validationFailedAttemptPath,
  writeValidationFailedAttempt,
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

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

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
 * Incidente real do piloto Semi-Imperium: Codex `exec --json` morreu com
 * `turn.failed` de quota, o launcher gravou FINISHED (sem provider_failure) e
 * o fechamento ficou PENDING por material Git vazio.
 */
async function rewriteLaunchAsCodexUsageLimit(): Promise<void> {
  const file = launchRecordPath(paths, 'T1');
  const launch = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  launch['argv'] = [
    'codex',
    'exec',
    '--json',
    '--strict-config',
    '--ignore-user-config',
    '--sandbox',
    'workspace-write',
    '--ephemeral',
    '--ignore-rules',
    '--model',
    'gpt-5.6-sol',
    '-',
  ];
  launch['profile_id'] = 'codex-build-worker-subscription-sol-high-v2';
  delete launch['provider_failure'];
  await writeFile(file, `${JSON.stringify(launch, null, 2)}\n`, 'utf8');
  const message =
    "You've hit your usage limit. Upgrade to Pro or try again at 4:45 AM.";
  await writeFile(
    path.join(paths.logsDir, 'T1.stdout.log'),
    [
      '{"type":"thread.started","thread_id":"th_quota"}',
      '{"type":"turn.started"}',
      JSON.stringify({ type: 'error', message }),
      JSON.stringify({ type: 'turn.failed', error: { message } }),
      '',
    ].join('\n'),
    'utf8',
  );
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

/**
 * Par report/handoff que o attempt 1 deixou nos caminhos correntes do inbox
 * depois de ser reprovado pela validation oficial. O record do attempt 1 é a
 * ÚNICA autoridade sobre os hashes desse par.
 */
const STALE_REPORT = `${JSON.stringify(
  {
    schema_version: 1,
    task_id: 'T1',
    self_reported_result: 'SUCCESS',
    summary: 'solução do attempt 1, reprovada pela validation oficial',
    candidate_commit: null,
    changed_files: ['src/alvo.ts'],
    validations: [],
    decisions: [],
    lessons: [],
    relevant_files: ['src/alvo.ts'],
  },
  null,
  2,
)}\n`;
const STALE_HANDOFF = `${JSON.stringify(
  {
    schema_version: 1,
    task_id: 'T1',
    result: 'PASS',
    changed_files: ['src/alvo.ts'],
    validations: [],
    decisions: [],
    lessons: [],
    next_relevant_files: ['src/alvo.ts'],
  },
  null,
  2,
)}\n`;

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Reproduz o estado da M50: attempt 1 arquivado como ValidationFailedAttempt,
 * attempt 2 morto por falha do provider, par stale nos slots correntes.
 */
async function simulateStalePair(
  overrides: { readonly report?: string; readonly handoff?: string } = {},
): Promise<{ readonly report: string; readonly handoff: string }> {
  const report = overrides.report ?? STALE_REPORT;
  const handoff = overrides.handoff ?? STALE_HANDOFF;
  await mkdir(path.dirname(reportPath(paths, 'T1')), { recursive: true });
  await writeFile(reportPath(paths, 'T1'), report, 'utf8');
  await writeFile(handoffDraftPath(paths, 'T1'), handoff, 'utf8');

  await writeValidationFailedAttempt(paths, {
    schema_version: 1,
    task_id: 'T1',
    attempt: 1,
    source_base_sha: await headSha(paths.repoRoot),
    profile_id: PROFILE_ID,
    worker_self_reported_result: 'SUCCESS',
    report_candidate_commit: null,
    orchestrator_verdict: 'REJECTED_BY_OFFICIAL_VALIDATION',
    finalization_mode: 'normal',
    launch_record_sha256: digest('launch'),
    original_completion_sha256: digest('completion'),
    report_sha256: digest(STALE_REPORT),
    handoff_draft_sha256: digest(STALE_HANDOFF),
    source_binding_sha256: digest('binding'),
    patch_fingerprint: digest('patch'),
    changed_files: ['src/alvo.ts'],
    original_validation_results: [
      { argv: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 1 },
    ],
    change_bundle: {
      manifest_path: 'failed-attempts/T1/attempt-1/changes-manifest.json',
      manifest_sha256: digest('manifest'),
      patch_path: 'failed-attempts/T1/attempt-1/changes.patch',
      patch_sha256: digest('patch-bytes'),
      patch_size_bytes: 12,
    },
    reason_code: 'OFFICIAL_VALIDATION_FAILURE',
    reason: 'attempt 1 reprovado pela validation oficial',
    archived_at: '2026-08-12T18:14:28.960Z',
  });

  // O attempt vivo é o 2: mesmo desenho da M50, com attempts preservado.
  const state = await readState(paths);
  await writeState(paths, withTaskState(state, 'T1', { attempts: 2 }));
  return { report, handoff };
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
      iterations: {
        task_id: string;
        result: string;
        attempt: number;
        provider_failure?: { terminal_reason: string | null; message: string | null };
      }[];
    };
    expect(output.stopped_by).toBe('INFRA_ERROR');
    expect(output.reason).toMatch(/falha terminal do provider/);
    expect(output.iterations).toHaveLength(1);
    // Nenhum fechamento foi tentado: o veredito da iteração é o do launch.
    expect(output.iterations[0]).toMatchObject({
      task_id: 'T1',
      result: 'INFRA_ERROR',
      attempt: 1,
    });
    // A falha do provider chega resumida na saída PADRÃO: exigir `--verbose`
    // para descobrir por que a sessão morreu custaria outra execução paga.
    expect(output.iterations[0]?.provider_failure?.terminal_reason).toBeTruthy();
    expect(output.iterations[0]?.provider_failure?.message).toBeTruthy();

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

  it('Codex turn.failed de quota no stdout, sem provider_failure no LaunchRecord, é INFRA recuperável', async () => {
    await runFailedAttempt();
    await simulateLegacyFinalizingState();
    await rewriteLaunchAsCodexUsageLimit();

    const record = (await recover()).record;
    expect(record.provider_failure_source).toBe('stdout_stream');
    expect(record.provider_failure).toMatchObject({
      is_error: true,
      terminal_reason: 'turn.failed',
      signals: ['turn.failed'],
    });
    expect(record.provider_failure.message).toMatch(/usage limit/i);
    expect(getTaskState(await readState(paths), 'T1')).toMatchObject({
      status: 'READY',
      phase: null,
      attempts: 1,
    });
  });

  it('resume do orquestrador recupera FINALIZING+quota Codex em vez de ficar em PENDING', async () => {
    await runFailedAttempt();
    await simulateLegacyFinalizingState();
    await rewriteLaunchAsCodexUsageLimit();

    const result = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', PROFILE_ID, '--max-iterations', '1'],
      devEnv(),
    );
    const output = JSON.parse(result.stdout) as { stopped_by: string; reason: string };
    expect(output.stopped_by).not.toBe('PENDING');
    expect(output.reason).not.toMatch(/material derivado do Git está vazio/i);
    expect(await readInfraFailedAttempt(paths, 'T1', 1)).not.toBeNull();
    expect(getTaskState(await readState(paths), 'T1').phase).not.toBe('FINALIZING');
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

/**
 * O incidente REAL da M50: o attempt 1 foi reprovado pela validation oficial e
 * arquivado, mas o par report/handoff dele continuou nos caminhos correntes do
 * inbox. O attempt 2 morreu por 401 do provider sem escrever nada — e a
 * recuperação foi recusada porque o harness leu output do attempt 1 como se
 * fosse do attempt 2. A posse é decidida por hash, nunca por timestamp,
 * `changed_files` ou semelhança de conteúdo.
 */
describe('dev-recover-infra diante de output stale do attempt anterior', () => {
  it('recupera o attempt de infra e preserva o par no attempt dono', async () => {
    await runFailedAttempt();
    const stale = await simulateStalePair();

    const result = await recover();

    expect(result.staleInboxOwnerAttempt).toBe(1);
    // Preservado byte a byte no diretório do attempt 1 — não do 2.
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1), 'utf8')).toBe(stale.report);
    expect(await readFile(failedAttemptHandoffDraftPath(paths, 'T1', 1), 'utf8')).toBe(stale.handoff);
    expect(await exists(failedAttemptReportPath(paths, 'T1', 2))).toBe(false);
    // Slots correntes liberados para o próximo attempt.
    expect(await exists(reportPath(paths, 'T1'))).toBe(false);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(false);

    // Semântica histórica preservada: attempt 2 é INFRA, sem report próprio.
    const record = await readInfraFailedAttempt(paths, 'T1', 2);
    expect(record).toMatchObject({
      attempt: 2,
      launch_classification: 'INFRA_ERROR',
      worker_output_present: false,
      reason_code: 'PROVIDER_TERMINAL_FAILURE',
    });
    expect(await readValidationFailedAttempt(paths, 'T1', 1)).not.toBeNull();
    expect(getTaskState(await readState(paths), 'T1')).toMatchObject({
      status: 'READY',
      attempts: 2,
      candidate_commit: null,
    });
  });

  it('preserva o par ANTES de liberar os slots — crash no meio converge', async () => {
    await runFailedAttempt();
    const stale = await simulateStalePair();

    await expect(
      recover({
        afterStaleInboxMigrated: async () => {
          throw new Error('crash injetado');
        },
      }),
    ).rejects.toThrow('crash injetado');

    // Archive publicado; o inbox já foi liberado porque a preservação veio antes.
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1), 'utf8')).toBe(stale.report);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');

    const result = await recover();
    expect(result.staleInboxOwnerAttempt).toBeNull();
    expect(getTaskState(await readState(paths), 'T1')).toMatchObject({
      status: 'READY',
      attempts: 2,
    });
  });

  it('recusa par sem attempt dono comprovado: esse output pode ser deste attempt', async () => {
    await runFailedAttempt();
    await simulateStalePair();
    // Sem record anterior nenhum, o par não tem proveniência.
    await rm(validationFailedAttemptPath(paths, 'T1', 1));

    await expect(recover()).rejects.toThrow(/sem pertencer comprovadamente a um attempt anterior/i);
    expect(await exists(reportPath(paths, 'T1'))).toBe(true);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');
  });

  it('recusa quando só o report bate com o record do attempt anterior', async () => {
    await runFailedAttempt();
    await simulateStalePair({ handoff: `${JSON.stringify({ schema_version: 1 })}\n` });

    await expect(recover()).rejects.toThrow(/sem pertencer comprovadamente a um attempt anterior/i);
    expect(await exists(failedAttemptReportPath(paths, 'T1', 1))).toBe(false);
  });

  it('recusa quando só o handoff bate com o record do attempt anterior', async () => {
    await runFailedAttempt();
    await simulateStalePair({ report: `${JSON.stringify({ schema_version: 1 })}\n` });

    await expect(recover()).rejects.toThrow(/sem pertencer comprovadamente a um attempt anterior/i);
    expect(await exists(failedAttemptHandoffDraftPath(paths, 'T1', 1))).toBe(false);
  });

  it('recusa meio par: só o report stale em disco', async () => {
    await runFailedAttempt();
    await simulateStalePair();
    await rm(handoffDraftPath(paths, 'T1'));

    await expect(recover()).rejects.toThrow(/AgentCompletionReport presente/i);
  });

  it('recusa meio par: só o handoff stale em disco', async () => {
    await runFailedAttempt();
    await simulateStalePair();
    await rm(reportPath(paths, 'T1'));

    await expect(recover()).rejects.toThrow(/HandoffDraft presente/i);
  });

  it('F — retoma release parcial (crash entre os dois rm) e arquiva o INFRA attempt', async () => {
    await runFailedAttempt();
    const stale = await simulateStalePair();

    await expect(
      recover({
        inboxReleaseHooks: {
          afterReportRemoved: async () => {
            throw new Error('crash entre os deletes do inbox');
          },
        },
      }),
    ).rejects.toThrow(/crash entre os deletes do inbox/);

    // Archive do attempt dono publicado; report corrente sumiu; handoff + intent restam.
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1), 'utf8')).toBe(stale.report);
    expect(await exists(reportPath(paths, 'T1'))).toBe(false);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(true);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');

    const result = await recover();
    expect(result.staleInboxOwnerAttempt).toBeNull();
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(false);
    expect(await exists(failedAttemptReportPath(paths, 'T1', 1))).toBe(true);
    expect(await readInfraFailedAttempt(paths, 'T1', 2)).toMatchObject({
      attempt: 2,
      launch_classification: 'INFRA_ERROR',
      worker_output_present: false,
    });
    expect(getTaskState(await readState(paths), 'T1')).toMatchObject({
      status: 'READY',
      attempts: 2,
    });
  });

  it('recusa quando o par stale pertence ao PRÓPRIO attempt corrente', async () => {
    await runFailedAttempt();
    await simulateStalePair();
    // O record passa a ser do attempt 2: já não há attempt anterior dono.
    const record = await readFile(validationFailedAttemptPath(paths, 'T1', 1), 'utf8');
    await rm(validationFailedAttemptPath(paths, 'T1', 1));
    await mkdir(path.dirname(validationFailedAttemptPath(paths, 'T1', 2)), { recursive: true });
    await writeFile(
      validationFailedAttemptPath(paths, 'T1', 2),
      record.replace('"attempt": 1', '"attempt": 2'),
      'utf8',
    );

    await expect(recover()).rejects.toThrow(/sem pertencer comprovadamente a um attempt anterior/i);
  });
});

/**
 * O blocker que sobrava na M50: a manutenção auditada avançou a base autorizada
 * de A até C enquanto o attempt de infra continuava sem ser arquivado. O attempt
 * é de A e continua sendo — o que muda é que a diferença até C está inteiramente
 * explicada por MaintenanceRecords adotados, e recusar isso deixaria a tarefa
 * permanentemente irrecuperável.
 */
describe('dev-recover-infra atravessando manutenção adotada', () => {
  const passingValidations: MaintenanceValidationRunner = async (command) => ({
    argv: [...command.argv],
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
  });

  async function maintenanceCommit(file: string, contents: string): Promise<string> {
    await mkdir(path.dirname(path.join(sandbox.root, file)), { recursive: true });
    await writeFile(path.join(sandbox.root, file), contents, 'utf8');
    await runGit(sandbox.root, ['add', '-A']);
    await runGit(sandbox.root, ['commit', '-q', '-m', `manutenção: ${file}`]);
    return headSha(sandbox.root);
  }

  /** Dois commits de manutenção adotados como faixa pela primitive oficial. */
  async function adoptRange(): Promise<string> {
    await maintenanceCommit('docs/manutencao-um.md', 'primeiro conserto\n');
    const target = await maintenanceCommit('test/dev/manutencao-dois.test.ts', 'export {};\n');
    await adoptMaintenanceRange({
      paths,
      target,
      maxCommits: 3,
      reason: 'faixa de manutenção auditada antes de recuperar a M50',
      validationRunner: passingValidations,
      now: () => '2026-08-12T19:00:00.000Z',
    });
    return target;
  }

  it('caso M50 — attempt nascido em A é recuperado com a base autorizada em C', async () => {
    await runFailedAttempt();
    const stale = await simulateStalePair();
    const base = getTaskState(await readState(paths), 'T1').base_sha;
    const authorized = await adoptRange();
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
    expect(base).not.toBe(authorized);

    const result = await recover();

    expect(result.headMode).toBe('adopted_maintenance');
    expect(result.adoptedMaintenance).toEqual([authorized]);
    // O attempt continua sendo de A; o HEAD registrado é o REAL da recuperação.
    expect(result.record.source_base_sha).toBe(base);
    expect(result.record.head_sha).toBe(authorized);
    expect(result.record.attempt).toBe(2);

    // O par stale do attempt 1 foi preservado no attempt DONO e os slots
    // correntes ficaram livres, exatamente como sem manutenção no caminho.
    expect(result.staleInboxOwnerAttempt).toBe(1);
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1), 'utf8')).toBe(stale.report);
    expect(await readFile(failedAttemptHandoffDraftPath(paths, 'T1', 1), 'utf8')).toBe(stale.handoff);
    expect(await exists(reportPath(paths, 'T1'))).toBe(false);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(false);

    const task = getTaskState(await readState(paths), 'T1');
    expect(task).toMatchObject({ status: 'READY', attempts: 2, candidate_commit: null });
    // A base histórica do attempt não foi reescrita para o head novo.
    expect(task.base_sha).toBe(base);
  });

  it('a CLI publica a base histórica, o head real e a cadeia atravessada', async () => {
    await runFailedAttempt();
    const base = getTaskState(await readState(paths), 'T1').base_sha;
    const authorized = await adoptRange();

    const result = await recoverCli();
    expect(result.exitCode).toBe(0);

    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'READY',
      attempt: 1,
      source_base_sha: base,
      head_sha: authorized,
      head_mode: 'adopted_maintenance',
      adopted_maintenance: [authorized],
      authorized_head_sha: authorized,
    });
  });

  it('manutenção ainda NÃO adotada continua recusada: HEAD avançou sem record', async () => {
    await runFailedAttempt();
    await maintenanceCommit('docs/manutencao-pendente.md', 'sem adoção\n');

    // Sem adoção, `authorized_head_sha` ainda é a base do attempt: a recusa é a
    // antiga, e nada aqui passou a aceitar descendente por descendência.
    await expect(recover()).rejects.toThrow(/HEAD.*diverge do base_sha/i);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');
  });

  it('commit externo depois da manutenção adotada bloqueia a recuperação', async () => {
    await runFailedAttempt();
    const authorized = await adoptRange();
    await writeFile(path.join(sandbox.root, 'externo.txt'), 'trabalho externo\n', 'utf8');
    await runGit(sandbox.root, ['add', '-A']);
    await runGit(sandbox.root, ['commit', '-q', '-m', 'trabalho externo']);

    await expect(recover()).rejects.toThrow(/diverge de authorized_head_sha/i);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('INFRA_ERROR');
  });

  it('repetir depois da manutenção continua idempotente e attempts não muda', async () => {
    await runFailedAttempt();
    await simulateStalePair();
    await adoptRange();

    const first = await recover();
    const second = await recover();

    expect(second.alreadyArchived).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(second.headMode).toBeNull();
    expect(getTaskState(await readState(paths), 'T1').attempts).toBe(2);
  });
});

describe('dev-recover depois da recuperação de infra', () => {
  it('não encontra nada a reconciliar', async () => {
    await runFailedAttempt();
    await recover();

    const result = await runDevCli(
      'dev-recover.ts',
      ['--repo', sandbox.root, '--dry-run', '--verbose'],
      devEnv(),
    );
    const output = JSON.parse(result.stdout) as { reconciliations: unknown[] };
    expect(output.reconciliations).toEqual([]);
  });
});
