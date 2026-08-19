import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { patchFingerprint, workingTreeFiles } from '../../dev/lib/git.js';
import { recoverIncompleteWorkerOutput } from '../../dev/lib/incomplete-worker-output-recovery.js';
import * as records from '../../dev/lib/records.js';
import { recoverProtocolOutput } from '../../dev/lib/protocol-output-recovery.js';
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

const NOW = '2026-08-19T03:00:00.000Z';
const REASON = 'worker output protocol incomplete: AgentCompletionReport ausente, HandoffDraft ausente';
const TASK = 'T1';
const PATCH_FILES = ['src/intake/index.ts', 'src/note.ts', 'test/intake/intake.test.ts'] as const;
const TRACKED_FILES = ['src/note.ts'] as const;
const ADDED_FILES = ['src/intake/index.ts', 'test/intake/intake.test.ts'] as const;

interface Fixture {
  readonly sandbox: Sandbox;
  readonly paths: HarnessPaths;
  readonly baseSha: string;
  readonly files: readonly string[];
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

async function setup(): Promise<Fixture> {
  const sandbox = await makeSandboxRepo();
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  await ensureRuntimeDirs(paths);

  for (const file of TRACKED_FILES) await write(sandbox.root, file, `base:${file}\n`);
  await runGit(sandbox.root, ['add', '-A']);
  await runGit(sandbox.root, ['commit', '-q', '-m', 'base incomplete']);
  const baseSha = (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();

  for (const file of TRACKED_FILES) await write(sandbox.root, file, `worker:${file}\n`);
  for (const file of ADDED_FILES) await write(sandbox.root, file, `worker:${file}\n`);

  const processIdentity = {
    pid: 424243,
    pgid: 424243,
    started_at: NOW,
    proc_start_ticks: PROCESS_GONE_START_TICKS,
    command_sha256: digest('worker-command'),
  };
  await records.writeLaunchRecord(paths, {
    schema_version: 1,
    task_id: TASK,
    profile_id: 'claude-build-worker-subscription-sonnet5-medium-stream-v4',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    argv: ['claude', '--print'],
    process: processIdentity,
    launch_id: 'f61b68bd-3402-4805-b8a5-c912d538403a',
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
  await writeFile(path.join(paths.logsDir, `${TASK}.stdout.log`), 'worker stdout\n');
  await writeFile(path.join(paths.logsDir, `${TASK}.stderr.log`), '');

  const loaded = await loadPlan(paths.planFile);
  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha });
  state = withTaskState(state, TASK, {
    status: 'RUNNING',
    phase: 'FINALIZING',
    attempts: 2,
    process: processIdentity,
    base_sha: baseSha,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics: 'AgentCompletionReport ausente',
    started_at: NOW,
    finished_at: null,
  });
  await writeState(paths, { ...state, authorized_head_sha: baseSha });

  return { sandbox, paths, baseSha, files: [...PATCH_FILES] };
}

async function recover(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return recoverIncompleteWorkerOutput({
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
    fingerprint: await patchFingerprint(fixture.sandbox.root),
    files: await workingTreeFiles(fixture.sandbox.root),
  };
  await expect(recover(fixture)).rejects.toThrow(pattern);
  expect(await readFile(fixture.paths.stateFile)).toEqual(before.state);
  expect(await patchFingerprint(fixture.sandbox.root)).toBe(before.fingerprint);
  expect(await workingTreeFiles(fixture.sandbox.root)).toEqual(before.files);
  expect(await exists(records.attemptAbandonmentPath(fixture.paths, TASK, 2))).toBe(false);
}

describe('recoverIncompleteWorkerOutput', () => {
  it('preserva patch e logs de processo morto sem report/handoff e reabre READY', async () => {
    const fixture = await setup();
    const fingerprint = await patchFingerprint(fixture.sandbox.root);

    const result = await recover(fixture);
    const task = getTaskState(await readState(fixture.paths), TASK);

    expect(result.changed_files).toEqual([...PATCH_FILES]);
    expect(result.patch_fingerprint).toBe(fingerprint);
    expect(result.report_present).toBe(false);
    expect(result.handoff_present).toBe(false);
    expect(result.capability_fail_recorded).toBe(false);
    expect(result.official_validation_fail_recorded).toBe(false);
    expect(result.record.report_present).toBe(false);
    expect(result.record.handoff_present).toBe(false);
    expect(result.record.report_sha256).toBeUndefined();
    expect(result.record.handoff_draft_sha256).toBeUndefined();
    expect(result.record.source_report_result).toBeUndefined();
    expect(await exists(records.preservedBundlePatchPath(fixture.paths, TASK, 2))).toBe(true);
    expect(await exists(records.infraAttemptEvidencePath(fixture.paths, TASK, 2, 'stdout.log'))).toBe(
      true,
    );
    expect(await exists(records.infraAttemptEvidencePath(fixture.paths, TASK, 2, 'stderr.log'))).toBe(
      true,
    );
    expect(
      await exists(records.infraAttemptEvidencePath(fixture.paths, TASK, 2, 'launch.infra.json')),
    ).toBe(true);
    expect(await exists(records.validationFailedAttemptPath(fixture.paths, TASK, 2))).toBe(false);
    expect(await exists(records.infraFailedAttemptPath(fixture.paths, TASK, 2))).toBe(false);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
    expect(await readFile(path.join(fixture.sandbox.root, 'src/note.ts'), 'utf8')).toBe(
      'base:src/note.ts\n',
    );
    expect(await exists(path.join(fixture.sandbox.root, 'src/intake/index.ts'))).toBe(false);
    expect(await exists(path.join(fixture.sandbox.root, 'src/intake'))).toBe(false);
    expect(await exists(path.join(fixture.sandbox.root, 'test/intake/intake.test.ts'))).toBe(false);
    expect(await exists(path.join(fixture.sandbox.root, 'test/intake'))).toBe(false);
    expect(task.status).toBe('READY');
    expect(task.phase).toBeNull();
    expect(task.process).toBeNull();
    expect(task.attempts).toBe(2);
    expect(task.diagnostics).toMatch(/protocol incomplete.*report ausente.*handoff ausente/i);
    expect(task.diagnostics).not.toMatch(/capability fail|validation oficial/i);
  });

  it('recusa processo ainda vivo sem limpar o patch', async () => {
    const fixture = await setup();
    const identity = await captureProcessIdentity(process.pid, process.pid, ['vitest'], NOW);
    const launch = await records.readLaunchRecord(fixture.paths, TASK);
    if (!launch) throw new Error('LaunchRecord ausente no fixture');
    await records.writeLaunchRecord(fixture.paths, { ...launch, process: identity });
    const state = await readState(fixture.paths);
    await writeState(fixture.paths, withTaskState(state, TASK, { process: identity }));
    await expectNoWriteRefusal(fixture, /processo registrado ainda está vivo/i);
  });

  it('recusa candidate_commit presente sem limpar o patch', async () => {
    const fixture = await setup();
    const state = await readState(fixture.paths);
    await writeState(
      fixture.paths,
      withTaskState(state, TASK, { candidate_commit: 'a'.repeat(40) }),
    );
    await expectNoWriteRefusal(fixture, /candidate_commit precisa ser null/i);
  });

  it('recusa CompletionRecord já existente sem limpar o patch', async () => {
    const fixture = await setup();
    await writeFile(records.completionPath(fixture.paths, TASK), '{}\n');
    await expectNoWriteRefusal(fixture, /CompletionRecord presente/i);
  });

  it('recusa lifecycle record incompatível sem limpar o patch', async () => {
    const fixture = await setup();
    await mkdir(path.dirname(records.validationFailedAttemptPath(fixture.paths, TASK, 2)), {
      recursive: true,
    });
    await writeFile(records.validationFailedAttemptPath(fixture.paths, TASK, 2), '{}\n');
    await expectNoWriteRefusal(fixture, /ValidationFailedAttemptRecord presente/i);
  });

  it('recusa path proibida no patch sem cleanup', async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.sandbox.root, 'dev/plan.yaml'), 'schema_version: 1\n', 'utf8');
    await expectNoWriteRefusal(fixture, /path proibida no patch: dev\/plan\.yaml/i);
    expect(await exists(records.preservedBundlePatchPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('crash após preserve e rerun é idempotente e não perde o patch', async () => {
    const fixture = await setup();
    const fingerprint = await patchFingerprint(fixture.sandbox.root);
    await expect(
      recover(fixture, {
        afterPatchPreserved: async () => {
          throw new Error('CRASH_AFTER_PRESERVE');
        },
      }),
    ).rejects.toThrow(/CRASH_AFTER_PRESERVE/);

    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([...PATCH_FILES]);
    expect(await exists(records.preservedBundlePatchPath(fixture.paths, TASK, 2))).toBe(true);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('RUNNING');
    expect(await exists(records.attemptAbandonmentPath(fixture.paths, TASK, 2))).toBe(false);

    const result = await recover(fixture);
    expect(result.patch_fingerprint).toBe(fingerprint);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('READY');
    expect(result.capability_fail_recorded).toBe(false);
  });

  it('crash após record/reset e rerun converge para READY', async () => {
    const fixture = await setup();
    await expect(
      recover(fixture, {
        afterRecordWritten: async () => {
          throw new Error('CRASH_AFTER_RECORD');
        },
      }),
    ).rejects.toThrow(/CRASH_AFTER_RECORD/);

    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
    expect(await exists(records.attemptAbandonmentPath(fixture.paths, TASK, 2))).toBe(true);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('RUNNING');

    const result = await recover(fixture);
    expect(getTaskState(await readState(fixture.paths), TASK).status).toBe('READY');
    expect(result.record.report_present).toBe(false);
    expect(result.capability_fail_recorded).toBe(false);
    expect(result.official_validation_fail_recorded).toBe(false);
  });

  it('recusa quando report e handoff existem — o recovery protocol-invalid permanece o dono', async () => {
    const fixture = await setup();
    await mkdir(path.dirname(records.reportPath(fixture.paths, TASK)), { recursive: true });
    await writeFile(records.reportPath(fixture.paths, TASK), '{}\n');
    await writeFile(records.handoffDraftPath(fixture.paths, TASK), '{}\n');
    await expectNoWriteRefusal(fixture, /completion artifacts presentes/i);
  });
});

describe('protocol-output-recovery permanece no contrato anterior', () => {
  it('continua recusando AgentCompletionReport ausente em vez de inventar o artifact', async () => {
    const fixture = await setup();
    await expect(
      recoverProtocolOutput({
        paths: fixture.paths,
        taskId: TASK,
        reason: REASON,
        now: () => NOW,
      }),
    ).rejects.toThrow(/AgentCompletionReport ausente/);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([...PATCH_FILES]);
  });
});

describe('dev-recover-incomplete-worker-output CLI', () => {
  it('aceita --repo/--task/--reason e emite preservação sem verdict', async () => {
    const fixture = await setup();
    const cli = await runDevCli('dev-recover-incomplete-worker-output.ts', [
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
      attempt: 2,
      report_present: false,
      handoff_present: false,
      capability_fail_recorded: false,
      official_validation_fail_recorded: false,
      state: 'READY',
      changed_files: [...PATCH_FILES],
    });
    const packageJson = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['dev-recover-incomplete-worker-output']).toBe(
      'tsx dev/cli/dev-recover-incomplete-worker-output.ts',
    );
  });
});
