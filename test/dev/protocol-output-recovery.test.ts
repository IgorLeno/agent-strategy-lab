import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { patchFingerprint, workingTreeFiles } from '../../dev/lib/git.js';
import * as records from '../../dev/lib/records.js';
import * as schemas from '../../dev/lib/schemas.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { PROCESS_GONE_START_TICKS, captureProcessIdentity } from '../../dev/lib/process-identity.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { REPO_ROOT, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

const SHA = '1'.repeat(40);
const DIGEST = 'a'.repeat(64);
const NOW = '2026-08-15T18:00:00.000Z';
const REASON =
  'Attempt 1 abandonado: worker incluiu os dois arquivos de protocol I/O do .dev-inbox em changed_files; patch e output originais arquivados sem capability verdict';
const TASK = 'T1';
const PATCH_FILES = [
  'src/adapters/claude/invocation.ts',
  'src/adapters/contract.ts',
  'src/adapters/index.ts',
  'test/adapters/claude-invocation.test.ts',
  'test/adapters/contract.test.ts',
] as const;
const TRACKED_FILES = [
  'src/adapters/contract.ts',
  'src/adapters/index.ts',
  'test/adapters/contract.test.ts',
] as const;
const ADDED_FILES = [
  'src/adapters/claude/invocation.ts',
  'test/adapters/claude-invocation.test.ts',
] as const;

interface Fixture {
  readonly sandbox: Sandbox;
  readonly paths: HarnessPaths;
  readonly baseSha: string;
  readonly files: readonly string[];
  readonly reportBytes: Buffer;
  readonly handoffBytes: Buffer;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf8');
}

function protocolPaths(taskId = TASK): string[] {
  return [`.dev-inbox/${taskId}/report.json`, `.dev-inbox/${taskId}/handoff-draft.json`];
}

function reportObject(changedFiles: readonly string[]) {
  return {
    schema_version: 1,
    task_id: TASK,
    self_reported_result: 'SUCCESS',
    summary: 'patch pronto; metadata de protocolo ambígua',
    candidate_commit: null,
    changed_files: [...changedFiles],
    validations: [],
    decisions: [],
    lessons: [],
    relevant_files: [...PATCH_FILES.slice(0, 5)],
  };
}

function handoffObject(changedFiles: readonly string[]) {
  return {
    schema_version: 1,
    task_id: TASK,
    result: 'PASS',
    changed_files: [...changedFiles],
    validations: [],
    decisions: [],
    lessons: [],
    next_relevant_files: [...PATCH_FILES.slice(0, 5)],
  };
}

async function writeWorkerOutput(
  paths: HarnessPaths,
  reportChangedFiles: readonly string[],
  handoffChangedFiles: readonly string[] = reportChangedFiles,
): Promise<{ reportBytes: Buffer; handoffBytes: Buffer }> {
  await mkdir(path.dirname(records.reportPath(paths, TASK)), { recursive: true });
  const reportBytes = Buffer.from(` ${JSON.stringify(reportObject(reportChangedFiles), null, 1)}\n`, 'utf8');
  const handoffBytes = Buffer.from(`\n${JSON.stringify(handoffObject(handoffChangedFiles))}\n`, 'utf8');
  await writeFile(records.reportPath(paths, TASK), reportBytes);
  await writeFile(records.handoffDraftPath(paths, TASK), handoffBytes);
  return { reportBytes, handoffBytes };
}

async function setup(options: { readonly deletedFile?: string } = {}): Promise<Fixture> {
  const sandbox = await makeSandboxRepo();
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  await ensureRuntimeDirs(paths);

  for (const file of TRACKED_FILES) await write(sandbox.root, file, `base:${file}\n`);
  if (options.deletedFile) {
    await write(sandbox.root, options.deletedFile, `base:${options.deletedFile}\n`);
  }
  await runGit(sandbox.root, ['add', '-A']);
  await runGit(sandbox.root, ['commit', '-q', '-m', 'base M56']);
  const baseSha = (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();

  for (const file of TRACKED_FILES) await write(sandbox.root, file, `worker:${file}\n`);
  for (const file of ADDED_FILES) await write(sandbox.root, file, `worker:${file}\n`);
  if (options.deletedFile) await rm(path.join(sandbox.root, options.deletedFile));

  const files = [...PATCH_FILES, ...(options.deletedFile ? [options.deletedFile] : [])].sort();
  const declared = [...files, ...protocolPaths()];
  const output = await writeWorkerOutput(paths, declared);
  const processIdentity = {
    pid: 424242,
    pgid: 424242,
    started_at: NOW,
    proc_start_ticks: PROCESS_GONE_START_TICKS,
    command_sha256: digest('worker-command'),
  };
  await records.writeLaunchRecord(paths, {
    schema_version: 1,
    task_id: TASK,
    profile_id: 'codex-build-worker-subscription-sol-medium-v2',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    argv: ['codex', 'exec'],
    process: processIdentity,
    launch_id: '08e0a5a1-c55b-4697-a7a3-0d94f21dfbac',
    survivors_killed: [],
    survivors_remaining: [],
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 10,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: null,
    rate_limit_observations: null,
    subscription_usage: null,
    provider_failure: null,
  });

  const loaded = await loadPlan(paths.planFile);
  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha });
  state = withTaskState(state, TASK, {
    status: 'RUNNING',
    phase: 'FINALIZING',
    attempts: 1,
    process: processIdentity,
    base_sha: baseSha,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics: 'caminho proibido: .dev-inbox/T1/handoff-draft.json',
    started_at: NOW,
    finished_at: null,
  });
  await writeState(paths, { ...state, authorized_head_sha: baseSha });

  return { sandbox, paths, baseSha, files, ...output };
}

async function recoveryModule(): Promise<{
  recoverProtocolOutput(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}> {
  const loaded = await import('../../dev/lib/protocol-output-recovery.js').catch(() => null);
  expect(loaded).not.toBeNull();
  return loaded as unknown as {
    recoverProtocolOutput(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
}

async function recover(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  const module = await recoveryModule();
  return module.recoverProtocolOutput({
    paths: fixture.paths,
    taskId: TASK,
    reason: REASON,
    now: () => NOW,
    ...overrides,
  });
}

async function expectNoWriteRefusal(fixture: Fixture, pattern: RegExp): Promise<void> {
  const before = {
    state: await readFile(fixture.paths.stateFile),
    report: await readFile(records.reportPath(fixture.paths, TASK)),
    handoff: await readFile(records.handoffDraftPath(fixture.paths, TASK)),
    fingerprint: await patchFingerprint(fixture.sandbox.root),
  };
  await expect(recover(fixture)).rejects.toThrow(pattern);
  expect(await readFile(fixture.paths.stateFile)).toEqual(before.state);
  expect(await readFile(records.reportPath(fixture.paths, TASK))).toEqual(before.report);
  expect(await readFile(records.handoffDraftPath(fixture.paths, TASK))).toEqual(before.handoff);
  expect(await patchFingerprint(fixture.sandbox.root)).toBe(before.fingerprint);
  expect(await exists(records.protocolInvalidAttemptPath(fixture.paths, TASK, 1))).toBe(false);
}

function archived(path: string, sourcePath: string) {
  return { path, source_path: sourcePath, sha256: DIGEST, size_bytes: 10 };
}

function validRecord(): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'M56',
    attempt: 1,
    classification: 'PROTOCOL_OUTPUT_INVALID',
    reason_code: 'PROTOCOL_OUTPUT_INVALID',
    reason: 'worker incluiu protocol I/O em changed_files',
    source_base_sha: SHA,
    head_sha: SHA,
    authorized_head_sha: SHA,
    profile_id: 'worker-v2',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    process: {
      pid: 4242,
      pgid: 4242,
      started_at: NOW,
      proc_start_ticks: 1,
      command_sha256: DIGEST,
    },
    launch_id: '08e0a5a1-c55b-4697-a7a3-0d94f21dfbac',
    launch_record: archived(
      'failed-attempts/M56/attempt-1/protocol-invalid/launch.json',
      'logs/M56.launch.json',
    ),
    worker_self_reported_result: 'SUCCESS',
    handoff_result: 'PASS',
    report_candidate_commit: null,
    state_candidate_commit: null,
    state_accepted_commit: null,
    protocol_invalid_paths: [
      '.dev-inbox/M56/handoff-draft.json',
      '.dev-inbox/M56/report.json',
    ],
    changed_files: ['src/a.ts', 'test/a.test.ts'],
    actual_patch_matches_normalized_report: true,
    patch_fingerprint: DIGEST,
    patch_files: [
      {
        path: 'src/a.ts',
        git_status: ' M',
        content_state: 'ARCHIVED',
        archive_path: 'failed-attempts/M56/attempt-1/protocol-invalid/files/src/a.ts',
        size_bytes: 10,
        sha256: DIGEST,
      },
      {
        path: 'test/a.test.ts',
        git_status: ' D',
        content_state: 'ABSENT',
        archive_path: null,
        size_bytes: null,
        sha256: null,
      },
    ],
    change_bundle: {
      manifest_path: 'failed-attempts/M56/attempt-1/changes-manifest.json',
      manifest_sha256: DIGEST,
      patch_path: 'failed-attempts/M56/attempt-1/changes.patch',
      patch_sha256: DIGEST,
      patch_size_bytes: 10,
    },
    report: archived(
      'failed-attempts/M56/attempt-1/report.json',
      '../.dev-inbox/M56/report.json',
    ),
    handoff_draft: archived(
      'failed-attempts/M56/attempt-1/handoff-draft.json',
      '../.dev-inbox/M56/handoff-draft.json',
    ),
    capability_verdict: null,
    official_validation_verdict: null,
    attempts_preserved: 1,
    archived_at: NOW,
  };
}

function protocolInvalidSchema(): { parse(input: unknown): unknown } {
  const schema = (schemas as Record<string, unknown>)['ProtocolInvalidAttemptRecord'];
  if (schema === undefined) throw new Error('ProtocolInvalidAttemptRecord ausente');
  return schema as { parse(input: unknown): unknown };
}

describe('ProtocolInvalidAttemptRecord', () => {
  it('separa protocol-invalid de capability e validation verdicts', () => {
    const schema = protocolInvalidSchema();

    expect(schema).toBeDefined();
    expect(() => schema.parse(validRecord())).not.toThrow();
    expect(() =>
      schema.parse({ ...validRecord(), capability_verdict: 'FAIL' }),
    ).toThrow();
    expect(() =>
      schema.parse({ ...validRecord(), official_validation_verdict: 'FAIL' }),
    ).toThrow();
  });

  it('exige paths exatos, patch ordenado e marcadores de conteúdo coerentes', () => {
    const schema = protocolInvalidSchema();
    const record = validRecord();

    expect(() =>
      schema.parse({ ...record, protocol_invalid_paths: ['.dev-inbox/M56/report.json'] }),
    ).toThrow();
    expect(() => schema.parse({ ...record, changed_files: ['test/a.test.ts', 'src/a.ts'] })).toThrow();
    const patchFiles = record['patch_files'] as Array<Record<string, unknown>>;
    expect(() =>
      schema.parse({
        ...record,
        patch_files: [{ ...patchFiles[0], archive_path: null }, patchFiles[1]],
      }),
    ).toThrow();
  });

  it('usa record append-only dentro do diretório protocol-invalid do attempt', () => {
    const paths = resolveHarnessPaths('/repo');
    const pathFunction = (records as Record<string, unknown>)['protocolInvalidAttemptPath'] as
      | ((typeof records)['validationFailedAttemptPath'])
      | undefined;

    expect(pathFunction).toBeDefined();
    expect(pathFunction?.(paths, 'M56', 1)).toBe(
      '/repo/.dev/failed-attempts/M56/attempt-1/protocol-invalid/protocol-invalid-attempt.json',
    );
  });
});

describe('recoverProtocolOutput', () => {
  it('arquiva byte-exact e reabre um caso M56 equivalente sem verdict', async () => {
    const fixture = await setup();

    const result = await recover(fixture);
    const record = result['record'] as schemas.ProtocolInvalidAttemptRecord;
    const state = await readState(fixture.paths);
    const task = getTaskState(state, TASK);

    expect(record.classification).toBe('PROTOCOL_OUTPUT_INVALID');
    expect(record.protocol_invalid_paths).toEqual([
      '.dev-inbox/T1/handoff-draft.json',
      '.dev-inbox/T1/report.json',
    ]);
    expect(record.changed_files).toEqual([...PATCH_FILES]);
    expect(record.actual_patch_matches_normalized_report).toBe(true);
    expect(record.capability_verdict).toBeNull();
    expect(record.official_validation_verdict).toBeNull();
    expect(await readFile(records.failedAttemptReportPath(fixture.paths, TASK, 1))).toEqual(
      fixture.reportBytes,
    );
    expect(await readFile(records.failedAttemptHandoffDraftPath(fixture.paths, TASK, 1))).toEqual(
      fixture.handoffBytes,
    );
    expect(await readFile(path.join(fixture.paths.devDir, record.launch_record.path))).toEqual(
      await readFile(records.launchRecordPath(fixture.paths, TASK)),
    );
    for (const file of record.patch_files.filter((entry) => entry.content_state === 'ARCHIVED')) {
      expect(await readFile(path.join(fixture.paths.devDir, file.archive_path as string))).toEqual(
        Buffer.from(`worker:${file.path}\n`, 'utf8'),
      );
    }
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
    for (const file of TRACKED_FILES) {
      expect(await readFile(path.join(fixture.sandbox.root, file), 'utf8')).toBe(`base:${file}\n`);
    }
    for (const file of ADDED_FILES) expect(await exists(path.join(fixture.sandbox.root, file))).toBe(false);
    expect(task.status).toBe('READY');
    expect(task.phase).toBeNull();
    expect(task.process).toBeNull();
    expect(task.attempts).toBe(1);
    expect(task.candidate_commit).toBeNull();
    expect(task.accepted_commit).toBeNull();
    expect(task.diagnostics).toMatch(/protocol.*inválido.*nenhum verdict de capability/i);
    expect(state.authorized_head_sha).toBe(fixture.baseSha);
    expect(await exists(records.completionPath(fixture.paths, TASK))).toBe(false);
    expect(await exists(records.reportPath(fixture.paths, TASK))).toBe(false);
    expect(await exists(records.handoffDraftPath(fixture.paths, TASK))).toBe(false);
  });

  it('arquiva deleção com marcador explícito de conteúdo ausente e a restaura', async () => {
    const deletedFile = 'src/adapters/deleted.ts';
    const fixture = await setup({ deletedFile });

    const result = await recover(fixture);
    const record = result['record'] as schemas.ProtocolInvalidAttemptRecord;
    expect(record.patch_files.find((file) => file.path === deletedFile)).toEqual({
      path: deletedFile,
      git_status: ' D',
      content_state: 'ABSENT',
      archive_path: null,
      size_bytes: null,
      sha256: null,
    });
    expect(await readFile(path.join(fixture.sandbox.root, deletedFile), 'utf8')).toBe(
      `base:${deletedFile}\n`,
    );
  });

  it.each([
    '.dev/other.json',
    '.claude/settings.json',
    '.codex/config.toml',
    '.agents/rule.md',
    'dev/plan.yaml',
  ])('recusa terceiro path proibido sem escrever: %s', async (forbidden) => {
    const fixture = await setup();
    const declared = [...PATCH_FILES, ...protocolPaths(), forbidden];
    await writeWorkerOutput(fixture.paths, declared);
    await expectNoWriteRefusal(fixture, /paths? de protocolo|proibido/i);
  });

  it('recusa arquivo real extra sem escrever', async () => {
    const fixture = await setup();
    await write(fixture.sandbox.root, 'extra.txt', 'fora do report\n');
    await expectNoWriteRefusal(fixture, /working tree diverge|patch real/i);
  });

  it('recusa path reportado faltante sem escrever', async () => {
    const fixture = await setup();
    const declared = [...PATCH_FILES.slice(0, -1), ...protocolPaths()];
    await writeWorkerOutput(fixture.paths, declared);
    await expectNoWriteRefusal(fixture, /working tree diverge|patch real/i);
  });

  it('recusa arrays changed_files divergentes sem escrever', async () => {
    const fixture = await setup();
    await writeWorkerOutput(
      fixture.paths,
      [...PATCH_FILES, ...protocolPaths()],
      [...PATCH_FILES.slice(0, -1), ...protocolPaths()],
    );
    await expectNoWriteRefusal(fixture, /changed_files.*divergem/i);
  });

  it('recusa HEAD divergente sem escrever', async () => {
    const fixture = await setup();
    await runGit(fixture.sandbox.root, ['commit', '--allow-empty', '-q', '-m', 'HEAD divergente']);
    await expectNoWriteRefusal(fixture, /HEAD .*diverge|base_sha/i);
  });

  it('recusa index previamente sujo sem escrever', async () => {
    const fixture = await setup();
    await runGit(fixture.sandbox.root, ['add', PATCH_FILES[0]]);
    await expectNoWriteRefusal(fixture, /index contém mudanças staged/i);
  });

  it('recusa processo registrado ainda vivo sem escrever', async () => {
    const fixture = await setup();
    const identity = await captureProcessIdentity(process.pid, process.pid, ['vitest'], NOW);
    const launch = await records.readLaunchRecord(fixture.paths, TASK);
    if (!launch) throw new Error('LaunchRecord ausente no fixture');
    await records.writeLaunchRecord(fixture.paths, { ...launch, process: identity });
    const state = await readState(fixture.paths);
    await writeState(fixture.paths, withTaskState(state, TASK, { process: identity }));
    await expectNoWriteRefusal(fixture, /processo registrado ainda está vivo/i);
  });

  it('recusa policy que não pertence ao orquestrador sem escrever', async () => {
    const fixture = await setup();
    const launch = await records.readLaunchRecord(fixture.paths, TASK);
    if (!launch) throw new Error('LaunchRecord ausente no fixture');
    await records.writeLaunchRecord(fixture.paths, {
      ...launch,
      execution_policy: {
        commit_owner: 'worker',
        official_validation_owner: 'worker',
        worker_validation_policy: 'full',
      },
    });
    await expectNoWriteRefusal(fixture, /execution_policy|orquestrador/i);
  });

  it('recusa outra task RUNNING sem escrever', async () => {
    const fixture = await setup();
    const state = await readState(fixture.paths);
    await writeState(
      fixture.paths,
      withTaskState(state, 'T2', { status: 'RUNNING', phase: 'EXECUTING', attempts: 1 }),
    );
    await expectNoWriteRefusal(fixture, /outra tarefa RUNNING: T2/i);
  });

  it('crash antes do record completo não limpa patch, inbox ou state', async () => {
    const fixture = await setup();
    await expect(
      recover(fixture, {
        afterPatchFilesArchived: async () => {
          throw new Error('CRASH_BEFORE_RECORD');
        },
      }),
    ).rejects.toThrow(/CRASH_BEFORE_RECORD/);

    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([...PATCH_FILES]);
    expect(await exists(records.reportPath(fixture.paths, TASK))).toBe(true);
    expect(await exists(records.handoffDraftPath(fixture.paths, TASK))).toBe(true);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('RUNNING');
    expect(await exists(records.protocolInvalidAttemptPath(fixture.paths, TASK, 1))).toBe(false);
  });

  it('crash após record publicado converge sem perder evidência', async () => {
    const fixture = await setup();
    await expect(
      recover(fixture, {
        afterRecordWritten: async () => {
          throw new Error('CRASH_AFTER_RECORD');
        },
      }),
    ).rejects.toThrow(/CRASH_AFTER_RECORD/);

    expect(await exists(records.protocolInvalidAttemptPath(fixture.paths, TASK, 1))).toBe(true);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([...PATCH_FILES]);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('RUNNING');

    const resumed = await recover(fixture);
    expect(resumed['alreadyArchived']).toBe(true);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('READY');
  });

  it('verifica novamente todo archive publicado antes de limpar o patch', async () => {
    const fixture = await setup();
    await expect(
      recover(fixture, {
        afterRecordWritten: async (record: schemas.ProtocolInvalidAttemptRecord) => {
          const first = record.patch_files[0];
          if (!first || first.archive_path === null) throw new Error('patch file arquivado ausente');
          await writeFile(path.join(fixture.paths.devDir, first.archive_path), 'adulterado\n');
        },
      }),
    ).rejects.toThrow(/evidência arquivada foi alterada/i);

    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([...PATCH_FILES]);
    expect(await exists(records.reportPath(fixture.paths, TASK))).toBe(true);
    expect(await exists(records.handoffDraftPath(fixture.paths, TASK))).toBe(true);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('RUNNING');
  });

  it('crash depois do reset e antes do state converge pelo record', async () => {
    const fixture = await setup();
    await expect(
      recover(fixture, {
        afterPatchReset: async () => {
          throw new Error('CRASH_AFTER_RESET');
        },
      }),
    ).rejects.toThrow(/CRASH_AFTER_RESET/);

    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('RUNNING');
    const resumed = await recover(fixture);
    expect(resumed['alreadyArchived']).toBe(true);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('READY');
  });

  it('reexecução com mesmos bytes é idempotente', async () => {
    const fixture = await setup();
    const first = await recover(fixture);
    const firstRecord = await readFile(records.protocolInvalidAttemptPath(fixture.paths, TASK, 1));
    const second = await recover(fixture);

    expect(first['alreadyArchived']).toBe(false);
    expect(second['alreadyArchived']).toBe(true);
    expect(await readFile(records.protocolInvalidAttemptPath(fixture.paths, TASK, 1))).toEqual(
      firstRecord,
    );
    expect(getTaskState(await readState(fixture.paths), TASK).attempts).toBe(1);
  });

  it('bytes arquivados divergentes recusam a retomada', async () => {
    const fixture = await setup();
    await expect(
      recover(fixture, {
        afterRecordWritten: async () => {
          throw new Error('CRASH_AFTER_RECORD');
        },
      }),
    ).rejects.toThrow(/CRASH_AFTER_RECORD/);
    await writeFile(records.failedAttemptReportPath(fixture.paths, TASK, 1), 'adulterado\n');

    await expect(recover(fixture)).rejects.toThrow(/arquivad.*alterad|diverge/i);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([...PATCH_FILES]);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('RUNNING');
  });
});

describe('dev-recover-protocol-output CLI', () => {
  it('aceita --repo/--task/--reason e emite classificação auditável', async () => {
    const fixture = await setup();

    const cli = await runDevCli('dev-recover-protocol-output.ts', [
      '--repo',
      fixture.sandbox.root,
      '--task',
      TASK,
      '--reason',
      REASON,
    ]);

    expect(cli.exitCode, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      status: 'RECOVERED',
      task_id: TASK,
      attempt: 1,
      classification: 'PROTOCOL_OUTPUT_INVALID',
      capability_fail_recorded: false,
      official_validation_fail_recorded: false,
      changed_files: [...PATCH_FILES],
    });
    const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['dev-recover-protocol-output']).toBe(
      'tsx dev/cli/dev-recover-protocol-output.ts',
    );
  });
});
