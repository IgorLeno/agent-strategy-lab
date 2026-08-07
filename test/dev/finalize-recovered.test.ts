import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../dev/lib/canonical.js';
import {
  finalizeRecovered,
  isForbiddenRecoveredPath,
  type RecoveredValidationRunner,
} from '../../dev/lib/finalize-recovered.js';
import { headSha, parentShas, stagedFiles, workingTreeFiles } from '../../dev/lib/git.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { recover, verifyCloseBundle } from '../../dev/lib/recover.js';
import {
  readCloseManifest,
  readCompletion,
  readHandoff,
  readRecoveredFinalization,
  recoveryRecordPath,
  writeAttemptAbandonment,
} from '../../dev/lib/records.js';
import type { ProcessIdentity } from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { makeSandboxRepo, runGit, type Sandbox } from './helpers.js';

const PLAN = `
schema_version: 1
tasks:
  - id: M01
    title: concluída
    objective: preservar histórico
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
  - id: M02
    title: recuperar
    blocked_by: [M01]
    objective: recuperar patch
    acceptance: ['ok']
    validation:
      - argv: ['true']
        timeout_seconds: 30
  - id: M03
    title: próxima
    blocked_by: [M02]
    objective: não executar
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
`;

const STARTED_AT = '2026-08-06T20:09:38.784Z';
const FINISHED_AT = '2026-08-06T20:13:29.544Z';
const ABANDONED_AT = '2026-08-07T01:00:00.000Z';
const FINALIZED_AT = '2026-08-07T02:00:00.000Z';
const REASON = 'worker bloqueado por Git e IPC';
const COMMIT_MESSAGE = 'feat(M02): add independent core status dimensions';
const PRODUCT_FILE = 'src/core/value.ts';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let baseSha: string;
let processIdentity: ProcessIdentity;

const passingRunner: RecoveredValidationRunner = async (command) => ({
  argv: [...command.argv],
  exit_code: 0,
  timed_out: false,
  duration_ms: 1,
});

beforeEach(async () => {
  sandbox = await makeSandboxRepo(PLAN);
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  baseSha = await headSha(sandbox.root);
  processIdentity = {
    pid: 999_998,
    pgid: 999_998,
    started_at: STARTED_AT,
    proc_start_ticks: 1,
    command_sha256: 'a'.repeat(64),
  };
  await ensureRuntimeDirs(paths);
  await prepareReadyTask();
  await writeSourceArtifacts([PRODUCT_FILE]);
  await writeProductFile(PRODUCT_FILE);
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

async function prepareReadyTask(): Promise<void> {
  let state = buildInitialState(loaded.plan, loaded.planSha256, {
    baselineSha: baseSha,
    now: '2026-08-06T19:00:00.000Z',
  });
  state = withTaskState(state, 'M01', {
    status: 'PASS',
    attempts: 1,
    base_sha: baseSha,
    candidate_commit: baseSha,
    accepted_commit: baseSha,
    started_at: '2026-08-06T19:10:00.000Z',
    finished_at: '2026-08-06T19:20:00.000Z',
  });
  state = withTaskState(state, 'M02', {
    status: 'READY',
    attempts: 2,
    base_sha: baseSha,
    diagnostics: 'attempt 2 abandonado',
  });
  await writeState(paths, state);
}

async function writeProductFile(file: string, contents = 'export const value = 1;\n'): Promise<void> {
  const absolute = path.join(sandbox.root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

async function writeSourceArtifacts(
  changedFiles: string[],
  options: {
    reportOverrides?: Record<string, unknown>;
    handoffOverrides?: Record<string, unknown>;
    reasonCode?: 'WORKER_ENVIRONMENT_BLOCKED' | 'WORKER_REPORTED_FAILURE';
  } = {},
): Promise<void> {
  const reportContents = `${JSON.stringify({
    schema_version: 1,
    task_id: 'M02',
    self_reported_result: 'FAILURE',
    summary: 'implementação produzida; infraestrutura bloqueou fechamento',
    candidate_commit: null,
    changed_files: changedFiles,
    validations: [],
    decisions: ['decisão preservada'],
    lessons: ['lição preservada'],
    relevant_files: changedFiles.slice(0, 5),
    ...options.reportOverrides,
  })}\n`;
  const handoffContents = `${JSON.stringify({
    schema_version: 1,
    task_id: 'M02',
    result: 'FAIL',
    changed_files: changedFiles,
    validations: [],
    decisions: ['decisão preservada'],
    lessons: ['lição preservada'],
    next_relevant_files: changedFiles.slice(0, 5),
    ...options.handoffOverrides,
  })}\n`;
  const inbox = path.join(paths.inboxDir, 'M02');
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, 'report.json'), reportContents, 'utf8');
  await writeFile(path.join(inbox, 'handoff-draft.json'), handoffContents, 'utf8');
  await writeAttemptAbandonment(paths, {
    schema_version: 1,
    task_id: 'M02',
    attempt: 2,
    base_sha: baseSha,
    process: processIdentity,
    launch_classification: 'FINISHED',
    exit_code: 0,
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    reason: REASON,
    previous_diagnostics: 'working tree suja',
    candidate_commit: null,
    working_tree_clean: true,
    head_sha: baseSha,
    report_present: true,
    handoff_present: true,
    reason_code: options.reasonCode ?? 'WORKER_ENVIRONMENT_BLOCKED',
    report_sha256: sha256Hex(reportContents),
    handoff_draft_sha256: sha256Hex(handoffContents),
    source_report_result: 'FAILURE',
    source_base_sha: baseSha,
    abandoned_at: ABANDONED_AT,
  });
}

function finalize(overrides: Partial<Parameters<typeof finalizeRecovered>[0]> = {}) {
  return finalizeRecovered({
    paths,
    loaded,
    taskId: 'M02',
    sourceAttempt: 2,
    reason: REASON,
    commitMessage: COMMIT_MESSAGE,
    validationRunner: passingRunner,
    now: () => FINALIZED_AT,
    ...overrides,
  });
}

async function commitCount(): Promise<number> {
  return Number((await runGit(sandbox.root, ['rev-list', '--count', `${baseSha}..HEAD`])).stdout.trim());
}

describe('recovered finalization preconditions', () => {
  it('requires READY task', async () => {
    const state = await readState(paths);
    await writeState(paths, withTaskState(state, 'M02', { status: 'FAIL' }));

    await expect(finalize()).rejects.toThrow(/READY/i);
  });

  it('requires the source abandonment record', async () => {
    await rm(path.join(paths.attemptsDir, 'M02', '2-abandoned.json'));

    await expect(finalize()).rejects.toThrow(/AttemptAbandonmentRecord/i);
  });

  it('rejects a non-recoverable reason code', async () => {
    await writeSourceArtifacts([PRODUCT_FILE], { reasonCode: 'WORKER_REPORTED_FAILURE' });

    await expect(finalize()).rejects.toThrow(/não recuperável/i);
  });

  it('rejects a report changed after abandonment', async () => {
    await writeFile(path.join(paths.inboxDir, 'M02', 'report.json'), '{}\n', 'utf8');

    await expect(finalize()).rejects.toThrow(/hash.*report/i);
  });

  it('rejects a handoff changed after abandonment', async () => {
    await writeFile(path.join(paths.inboxDir, 'M02', 'handoff-draft.json'), '{}\n', 'utf8');

    await expect(finalize()).rejects.toThrow(/hash.*handoff/i);
  });

  it('rejects an extra real file', async () => {
    await writeProductFile('src/core/extra.ts');

    await expect(finalize()).rejects.toThrow(/arquivos.*divergem/i);
  });

  it('rejects a reported file absent from the real patch', async () => {
    await writeSourceArtifacts([PRODUCT_FILE, 'src/core/missing.ts']);

    await expect(finalize()).rejects.toThrow(/arquivos.*divergem/i);
  });

  it.each([
    '.claude/settings.local.json',
    '.dev/manual.json',
    '.dev-inbox/M02/manual.json',
    'dev/plan.yaml',
    '.agents/rules.md',
    '.codex/config.toml',
  ])('classifies forbidden recovery path: %s', (file) => {
    expect(isForbiddenRecoveredPath(file)).toBe(true);
  });

  it('rejects dev/plan.yaml when it is part of the real patch', async () => {
    await writeFile(paths.planFile, `${PLAN}\n# modified\n`, 'utf8');
    await writeSourceArtifacts([PRODUCT_FILE, 'dev/plan.yaml']);

    await expect(finalize()).rejects.toThrow(/proibido.*dev\/plan\.yaml/i);
  });

  it.each(['.claude/settings.local.json', '.dev/tracked-evidence.json'])(
    'rejects a tracked forbidden path in the real patch: %s',
    async (forbiddenFile) => {
      await writeProductFile(forbiddenFile, 'base\n');
      await runGit(sandbox.root, ['add', '-f', forbiddenFile]);
      await runGit(sandbox.root, ['commit', '-q', '-m', 'maintenance base']);
      const maintenanceHead = await headSha(sandbox.root);
      const state = await readState(paths);
      await writeState(paths, { ...state, authorized_head_sha: maintenanceHead });
      await writeProductFile(forbiddenFile, 'changed\n');
      await writeSourceArtifacts([PRODUCT_FILE, forbiddenFile]);

      await expect(finalize()).rejects.toThrow(new RegExp(`proibido.*${forbiddenFile.split('/')[0]}`, 'i'));
    },
  );

  it('rejects pre-existing staged changes', async () => {
    await runGit(sandbox.root, ['add', PRODUCT_FILE]);

    await expect(finalize()).rejects.toThrow(/staged|index/i);
  });

  it.each(['', '   ', 'line one\nline two', 'x'.repeat(201), 'á'.repeat(101)])(
    'rejects invalid commit message %j',
    async (commitMessage) => {
      await expect(finalize({ commitMessage })).rejects.toThrow(/commit-message/i);
    },
  );
});

describe('recovered finalization transaction', () => {
  it('default runner preserva logs externos nas novas finalizações recuperadas', async () => {
    const result = await finalizeRecovered({
      paths,
      loaded,
      taskId: 'M02',
      sourceAttempt: 2,
      reason: REASON,
      commitMessage: COMMIT_MESSAGE,
      now: () => FINALIZED_AT,
    });
    const completion = await readCompletion(paths, 'M02');

    expect(result.record.validation_evidence).toHaveLength(2);
    expect(completion?.orchestrator_evidence.validation_evidence).toEqual(
      result.record.validation_evidence,
    );
    for (const evidence of result.record.validation_evidence ?? []) {
      const stdout = await readFile(path.join(paths.devDir, evidence.stdout_path));
      const stderr = await readFile(path.join(paths.devDir, evidence.stderr_path));
      expect(createHash('sha256').update(stdout).digest('hex')).toBe(evidence.stdout_sha256);
      expect(createHash('sha256').update(stderr).digest('hex')).toBe(evidence.stderr_sha256);
    }
  });

  it('validation failure creates no commit or PASS state', async () => {
    const failingRunner: RecoveredValidationRunner = async (command) => ({
      argv: [...command.argv],
      exit_code: 1,
      timed_out: false,
      duration_ms: 1,
    });

    await expect(finalize({ validationRunner: failingRunner })).rejects.toThrow(/validação/i);

    expect(await headSha(sandbox.root)).toBe(baseSha);
    expect(getTaskState(await readState(paths), 'M02').status).toBe('READY');
  });

  it('commit failure restores only the index and preserves the working patch', async () => {
    const hook = path.join(sandbox.root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', 'utf8');
    await chmod(hook, 0o755);

    await expect(finalize()).rejects.toThrow(/falha ao criar recovery commit/i);

    expect(await headSha(sandbox.root)).toBe(baseSha);
    expect(await stagedFiles(sandbox.root)).toEqual([]);
    expect(await workingTreeFiles(sandbox.root)).toEqual([PRODUCT_FILE]);
    expect(await readFile(path.join(sandbox.root, PRODUCT_FILE), 'utf8')).toBe(
      'export const value = 1;\n',
    );
  });

  it('creates exactly one direct-child commit with exact files and message', async () => {
    const result = await finalize();

    expect(await commitCount()).toBe(1);
    expect(await parentShas(sandbox.root, result.record.candidate_commit)).toEqual([baseSha]);
    expect(result.record.changed_files).toEqual([PRODUCT_FILE]);
    expect(result.record.commit_message).toBe(COMMIT_MESSAGE);
    expect(
      (await runGit(sandbox.root, ['log', '-1', '--format=%B', result.record.candidate_commit])).stdout.replace(/\n+$/, ''),
    ).toBe(COMMIT_MESSAGE);
    expect(
      (await runGit(sandbox.root, ['show', '--pretty=', '--name-only', result.record.candidate_commit])).stdout.trim(),
    ).toBe(PRODUCT_FILE);
    expect(
      (await runGit(sandbox.root, [
        'show',
        '-s',
        '--format=%an|%ae|%cn|%ce',
        result.record.candidate_commit,
      ])).stdout.trim(),
    ).toBe(
      'Agent Strategy Lab Harness|harness@agent-strategy-lab.invalid|Agent Strategy Lab Harness|harness@agent-strategy-lab.invalid',
    );
  });

  it('passes commit-message as a literal argv value without shell interpolation', async () => {
    const literal = 'feat(M02): keep literal $(touch shell-was-used)';

    const result = await finalize({ commitMessage: literal });

    expect(result.record.commit_message).toBe(literal);
    expect(
      (await runGit(sandbox.root, ['log', '-1', '--format=%B', result.record.candidate_commit])).stdout.replace(/\n+$/, ''),
    ).toBe(literal);
    await expect(readFile(path.join(sandbox.root, 'shell-was-used'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves worker FAILURE while sealing orchestrator PASS', async () => {
    const result = await finalize();
    const completion = await readCompletion(paths, 'M02');
    const handoff = await readHandoff(paths, 'M02');

    expect(result.record).toMatchObject({
      source_report_result: 'FAILURE',
      commit_origin: 'orchestrator_recovery',
      working_tree_clean: true,
    });
    expect(completion).toMatchObject({
      status: 'PASS',
      finalization_mode: 'recovered',
      commit_origin: 'orchestrator_recovery',
      report: { self_reported_result: 'FAILURE', candidate_commit: null },
    });
    expect(completion?.discrepancies.join(' ')).toMatch(/infraestrutura.*orquestrador/i);
    expect(handoff).toMatchObject({
      result: 'PASS',
      changed_files: [PRODUCT_FILE],
      accepted_commit: result.record.candidate_commit,
      decisions: ['decisão preservada'],
      lessons: ['lição preservada'],
    });
  });

  it('advances only M02 and authorized head while preserving attempts, M01, and M03', async () => {
    const before = await readState(paths);
    const result = await finalize();
    const after = await readState(paths);

    expect(getTaskState(after, 'M01')).toEqual(getTaskState(before, 'M01'));
    expect(getTaskState(after, 'M02')).toMatchObject({
      status: 'PASS',
      attempts: 2,
      candidate_commit: result.record.candidate_commit,
      accepted_commit: result.record.candidate_commit,
    });
    expect(getTaskState(after, 'M03')).toEqual(getTaskState(before, 'M03'));
    expect(after.authorized_head_sha).toBe(result.record.candidate_commit);
  });

  it('writes a recovery record whose source hashes match exact bytes', async () => {
    const result = await finalize();
    const stored = await readRecoveredFinalization(paths, 'M02', 2);
    const report = await readFile(path.join(paths.inboxDir, 'M02', 'report.json'));
    const handoff = await readFile(path.join(paths.inboxDir, 'M02', 'handoff-draft.json'));
    const abandonment = await readFile(path.join(paths.attemptsDir, 'M02', '2-abandoned.json'));

    expect(stored).toEqual(result.record);
    expect(stored).toMatchObject({
      report_sha256: sha256Hex(report),
      handoff_draft_sha256: sha256Hex(handoff),
      abandonment_record_sha256: sha256Hex(abandonment),
    });
    expect(await readFile(recoveryRecordPath(paths, 'M02', 2), 'utf8')).toContain(COMMIT_MESSAGE);
  });

  it('resumes after a crash immediately after commit without creating a second commit', async () => {
    await expect(
      finalize({
        afterCommitCreated: async () => {
          throw new Error('crash after commit');
        },
      }),
    ).rejects.toThrow('crash after commit');
    expect(await commitCount()).toBe(1);

    const result = await finalize();

    expect(await commitCount()).toBe(1);
    expect(getTaskState(await readState(paths), 'M02').status).toBe('PASS');
    expect(result.alreadyFinalized).toBe(false);
  });

  it('a second successful invocation is idempotent', async () => {
    const first = await finalize();
    const recordBefore = await readFile(recoveryRecordPath(paths, 'M02', 2), 'utf8');

    const second = await finalize();

    expect(second.alreadyFinalized).toBe(true);
    expect(second.record.candidate_commit).toBe(first.record.candidate_commit);
    expect(await commitCount()).toBe(1);
    expect(await readFile(recoveryRecordPath(paths, 'M02', 2), 'utf8')).toBe(recordBefore);
  });

  it('dev-recover dry-run reports but does not seal a recovery record after crash', async () => {
    await expect(
      finalize({
        afterRecoveryWritten: async () => {
          throw new Error('crash after recovery record');
        },
      }),
    ).rejects.toThrow('crash after recovery record');

    const dry = await recover(paths, loaded);

    expect(getTaskState(dry.state, 'M02').status).toBe('READY');
    expect(dry.reconciliations.some((entry) => /recovered finalization/i.test(entry.reason))).toBe(true);
    expect(await readCompletion(paths, 'M02')).toBeNull();
    expect(await readCloseManifest(paths, 'M02')).toBeNull();
  });

  it('dev-recover applied seals a valid recovery record without a second commit', async () => {
    await expect(
      finalize({
        afterRecoveryWritten: async () => {
          throw new Error('crash after recovery record');
        },
      }),
    ).rejects.toThrow('crash after recovery record');

    const applied = await recover(paths, loaded, { applyRecovered: true });

    expect(await commitCount()).toBe(1);
    expect(getTaskState(applied.state, 'M02').status).toBe('PASS');
    expect((await verifyCloseBundle(paths, 'M02')).status).toBe('VALID');
  });

  it('dev-recover completes a bundle interrupted after CompletionRecord', async () => {
    await expect(
      finalize({
        afterCompletionWritten: async () => {
          throw new Error('crash after completion');
        },
      }),
    ).rejects.toThrow('crash after completion');
    expect(await readCompletion(paths, 'M02')).not.toBeNull();
    expect(await readHandoff(paths, 'M02')).toBeNull();

    const applied = await recover(paths, loaded, { applyRecovered: true });

    expect(getTaskState(applied.state, 'M02').status).toBe('PASS');
    expect(await readHandoff(paths, 'M02')).not.toBeNull();
    expect(await readCloseManifest(paths, 'M02')).not.toBeNull();
    expect(await commitCount()).toBe(1);
  });

  it('dev-recover never accepts an advanced HEAD without a recovery record', async () => {
    await expect(
      finalize({
        afterCommitCreated: async () => {
          throw new Error('crash before recovery record');
        },
      }),
    ).rejects.toThrow('crash before recovery record');

    const applied = await recover(paths, loaded, { applyRecovered: true });

    expect(getTaskState(applied.state, 'M02').status).toBe('READY');
    expect(await readCompletion(paths, 'M02')).toBeNull();
  });

  it('a recovered CompletionRecord is incomplete when its recovery record is missing', async () => {
    await finalize();
    await rm(recoveryRecordPath(paths, 'M02', 2));

    expect((await verifyCloseBundle(paths, 'M02')).status).toBe('INCOMPLETE');
  });

  it('a recovered CompletionRecord is incomplete when its recovery record changes', async () => {
    await finalize();
    const file = recoveryRecordPath(paths, 'M02', 2);
    const record = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, `${JSON.stringify({ ...record, reason: 'alterado' }, null, 2)}\n`, 'utf8');

    expect((await verifyCloseBundle(paths, 'M02')).status).toBe('INCOMPLETE');
  });
});
