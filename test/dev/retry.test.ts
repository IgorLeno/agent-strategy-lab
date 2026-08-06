import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../dev/lib/canonical.js';
import { checkProgressionBase } from '../../dev/lib/base-guard.js';
import { headSha } from '../../dev/lib/git.js';
import { acquireLock } from '../../dev/lib/lock.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { readProcStartTicks } from '../../dev/lib/process-identity.js';
import {
  attemptAbandonmentPath,
  handoffDraftPath,
  readAttemptAbandonment,
  reportPath,
  writeLaunchRecord,
} from '../../dev/lib/records.js';
import { retryAbandonedAttempt } from '../../dev/lib/retry.js';
import type { DevelopmentState, ProcessIdentity } from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

const PLAN = `
schema_version: 1
tasks:
  - id: M01
    title: concluída
    objective: preservar histórico
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
  - id: M02
    title: abandonada
    blocked_by: [M01]
    objective: repetir depois
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
`;

const STARTED_AT = '2026-08-06T16:00:06.551Z';
const FINISHED_AT = '2026-08-06T16:03:57.996Z';
const ABANDONED_AT = '2026-08-06T17:00:00.000Z';
const REASON = 'attempt 1 bloqueado pelo sandbox Codex read-only';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let baseSha: string;
let deadProcess: ProcessIdentity;

beforeEach(async () => {
  sandbox = await makeSandboxRepo(PLAN);
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  baseSha = await headSha(sandbox.root);
  deadProcess = {
    pid: 999_999,
    pgid: 999_999,
    started_at: STARTED_AT,
    proc_start_ticks: 1,
    command_sha256: canonicalSha256(['codex', 'exec']),
  };
  await ensureRuntimeDirs(paths);
  await prepareRunningAttempt(deadProcess);
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

async function prepareRunningAttempt(processIdentity: ProcessIdentity): Promise<void> {
  let state = buildInitialState(loaded.plan, loaded.planSha256, {
    baselineSha: baseSha,
    now: '2026-08-06T15:00:00.000Z',
  });
  state = withTaskState(state, 'M01', {
    status: 'PASS',
    attempts: 1,
    base_sha: baseSha,
    candidate_commit: baseSha,
    accepted_commit: baseSha,
    started_at: '2026-08-06T15:10:00.000Z',
    finished_at: '2026-08-06T15:20:00.000Z',
  });
  state = withTaskState(state, 'M02', {
    status: 'RUNNING',
    phase: 'FINALIZING',
    attempts: 1,
    process: processIdentity,
    base_sha: baseSha,
    diagnostics: 'AgentCompletionReport ausente',
    started_at: STARTED_AT,
  });
  await writeState(paths, state);
  await writeLaunchRecord(paths, {
    schema_version: 1,
    task_id: 'M02',
    profile_id: 'codex-build-worker-subscription-high-v1',
    argv: ['timeout', 'codex', 'exec'],
    process: processIdentity,
    launch_id: 'fdbe004f-166f-49ab-9a0d-c1850992438f',
    survivors_killed: [],
    survivors_remaining: [],
    started_at: STARTED_AT,
    finished_at: FINISHED_AT,
    duration_ms: 231_445,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: null,
  });
}

function retry(overrides: Partial<Parameters<typeof retryAbandonedAttempt>[0]> = {}) {
  return retryAbandonedAttempt({
    paths,
    taskId: 'M02',
    reason: REASON,
    now: () => ABANDONED_AT,
    ...overrides,
  });
}

async function writeArtifact(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{}\n', 'utf8');
}

async function commitFile(file: string, contents: string, force = false): Promise<string> {
  const absolute = path.join(sandbox.root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
  if (force) {
    await runGit(sandbox.root, ['add', '-f', file]);
    await runGit(sandbox.root, ['commit', '-q', '-m', `change ${file}`]);
    return (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();
  }
  return commitAll(sandbox.root, `change ${file}`);
}

describe('retry de tentativa abandonada', () => {
  it('processo morto, árvore limpa e nenhum output permitem retry normal', async () => {
    const result = await retry();
    const state = await readState(paths);
    const task = getTaskState(state, 'M02');

    expect(result.alreadyRetried).toBe(false);
    expect(task).toMatchObject({
      status: 'READY',
      phase: null,
      attempts: 1,
      process: null,
      candidate_commit: null,
      accepted_commit: null,
      started_at: null,
      finished_at: null,
    });
    expect(task.diagnostics).toMatch(/attempt 1.*abandonado/);
    expect(state.authorized_head_sha).toBe(baseSha);
    expect(await readAttemptAbandonment(paths, 'M02', 1)).toMatchObject({
      task_id: 'M02',
      attempt: 1,
      base_sha: baseSha,
      launch_classification: 'FINISHED',
      exit_code: 0,
      reason: REASON,
      previous_diagnostics: 'AgentCompletionReport ausente',
      working_tree_clean: true,
      head_sha: baseSha,
      report_present: false,
      handoff_present: false,
      abandoned_at: ABANDONED_AT,
    });
  });

  it('processo vivo recusa', async () => {
    const alive: ProcessIdentity = {
      ...deadProcess,
      pid: process.pid,
      pgid: process.pid,
      proc_start_ticks: await readProcStartTicks(process.pid),
    };
    await prepareRunningAttempt(alive);
    await expect(retry()).rejects.toThrow(/processo.*vivo/i);
  });

  it('árvore suja recusa', async () => {
    await writeFile(path.join(sandbox.root, 'dirty.txt'), 'dirty\n', 'utf8');
    await expect(retry()).rejects.toThrow(/working tree.*suja/i);
  });

  it('HEAD divergente recusa no modo normal', async () => {
    await commitFile('docs/fix.md', 'fix\n');
    await expect(retry()).rejects.toThrow(/HEAD.*base_sha/i);
  });

  it('report presente recusa mesmo quando inválido', async () => {
    await writeArtifact(reportPath(paths, 'M02'));
    await expect(retry()).rejects.toThrow(/AgentCompletionReport.*presente/i);
  });

  it('handoff draft presente recusa mesmo quando inválido', async () => {
    await writeArtifact(handoffDraftPath(paths, 'M02'));
    await expect(retry()).rejects.toThrow(/HandoffDraft.*presente/i);
  });

  it('candidate commit presente recusa', async () => {
    const state = await readState(paths);
    await writeState(paths, withTaskState(state, 'M02', { candidate_commit: baseSha }));
    await expect(retry()).rejects.toThrow(/candidate_commit.*null/i);
  });

  it('LaunchRecord ausente recusa', async () => {
    await rm(path.join(paths.logsDir, 'M02.launch.json'));
    await expect(retry()).rejects.toThrow(/LaunchRecord.*ausente/i);
  });

  it('outra tarefa RUNNING recusa', async () => {
    let state = await readState(paths);
    state = withTaskState(state, 'M01', {
      status: 'RUNNING',
      phase: 'EXECUTING',
      accepted_commit: null,
      candidate_commit: null,
      process: deadProcess,
    });
    await writeState(paths, state);
    await expect(retry()).rejects.toThrow(/outra tarefa RUNNING.*M01/i);
  });

  it('record é gravado antes do state', async () => {
    await retry({
      afterRecordWritten: async () => {
        expect(await readAttemptAbandonment(paths, 'M02', 1)).not.toBeNull();
        expect(getTaskState(await readState(paths), 'M02').status).toBe('RUNNING');
      },
    });
  });

  it('crash entre record e state é reconciliado sem record divergente', async () => {
    await expect(
      retry({
        afterRecordWritten: async () => {
          throw new Error('crash injetado');
        },
      }),
    ).rejects.toThrow('crash injetado');

    const file = attemptAbandonmentPath(paths, 'M02', 1);
    const before = await readFile(file, 'utf8');
    expect(getTaskState(await readState(paths), 'M02').status).toBe('RUNNING');

    const result = await retry({ now: () => '2026-08-06T18:00:00.000Z' });

    expect(result.alreadyRetried).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(getTaskState(await readState(paths), 'M02').status).toBe('READY');
  });

  it('repetir a mesma solicitação depois do state é idempotente', async () => {
    await retry();
    const before = await readFile(attemptAbandonmentPath(paths, 'M02', 1), 'utf8');

    const result = await retry({ now: () => '2026-08-06T18:00:00.000Z' });

    expect(result.alreadyRetried).toBe(true);
    expect(await readFile(attemptAbandonmentPath(paths, 'M02', 1), 'utf8')).toBe(before);
  });

  it('M01 e authorized_head_sha permanecem intactos', async () => {
    const before = await readState(paths);
    const m01 = getTaskState(before, 'M01');

    await retry();

    const after = await readState(paths);
    expect(getTaskState(after, 'M01')).toEqual(m01);
    expect(after.authorized_head_sha).toBe(before.authorized_head_sha);
  });

  it('CLI disputa o lock do harness antes de alterar a tentativa', async () => {
    const lock = await acquireLock(paths, 'teste-concorrente');
    try {
      const result = await runDevCli(
        'dev-retry.ts',
        ['--repo', sandbox.root, '--task', 'M02', '--reason', REASON],
        { AGENTLAB_DEV_DIR: sandbox.devDir },
      );
      expect(result.exitCode).toBe(10);
      expect(result.stderr).toMatch(/harness ocupado/);
      expect(getTaskState(await readState(paths), 'M02').status).toBe('RUNNING');
    } finally {
      await lock.release();
    }
  });
});

describe('--allow-pending-maintenance', () => {
  it('aceita exatamente um commit filho direto permitido sem autorizar o HEAD', async () => {
    const maintenanceHead = await commitFile('docs/fix.md', 'fix\n');

    const result = await retry({ allowPendingMaintenance: true });
    const state = await readState(paths);

    expect(result.record.head_sha).toBe(maintenanceHead);
    expect(getTaskState(state, 'M02')).toMatchObject({ status: 'READY', attempts: 1 });
    expect(state.authorized_head_sha).toBe(baseSha);
    expect(await checkProgressionBase(paths, state)).toMatch(/não é a base esperada/);
  });

  it('recusa mais de um commit sobre a base', async () => {
    await commitFile('docs/one.md', 'one\n');
    await commitFile('docs/two.md', 'two\n');
    await expect(retry({ allowPendingMaintenance: true })).rejects.toThrow(/exatamente um commit/i);
  });

  it.each([
    ['src/core.ts', false],
    ['dev/plan.yaml', false],
    ['.dev/manual.json', true],
    ['.dev-inbox/M02/manual.json', true],
    ['docs/S15-run-real.md', false],
  ])('recusa caminho fora da manutenção: %s', async (file, force) => {
    await commitFile(file, 'forbidden\n', force);
    await expect(retry({ allowPendingMaintenance: true })).rejects.toThrow(/fora do escopo.*manutenção/i);
  });
});
