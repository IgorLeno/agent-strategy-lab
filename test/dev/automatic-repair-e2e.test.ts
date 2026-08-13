import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTOMATIC_REPAIR_EXHAUSTED } from '../../dev/lib/automatic-repair.js';
import { finalizeOrchestratedTask } from '../../dev/lib/finalize-orchestrated.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  ensureTaskInbox,
  handoffDraftPath,
  readLaunchRecord,
  readPacket,
  readValidationFailedAttempt,
  reportPath,
  writeLaunchRecord,
  writePacket,
} from '../../dev/lib/records.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

const PROFILE = 'fake-orchestrator-v2';
const PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: primeira tarefa
    objective: criar src/t1.txt
    initial_files: [README.md]
    acceptance: ['arquivo criado']
    validation:
      - argv: ['grep', '-qx', 'repaired', 'src/t1.txt']
        timeout_seconds: 30
  - id: T2
    title: segunda tarefa
    blocked_by: [T1]
    include_previous_handoff: true
    objective: criar src/t2.txt
    acceptance: ['arquivo criado']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;

const PROFILE_YAML = [
  `id: ${PROFILE}`,
  'agent: fake',
  'commit_owner: orchestrator',
  'official_validation_owner: orchestrator',
  'worker_validation_policy: targeted',
  'argv: [node, fixtures/fake-worker.mjs]',
  'prompt_delivery: argv',
  'timeout_seconds: 60',
  'forbidden_flags: []',
  'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE]',
].join('\n');

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

beforeEach(async () => {
  sandbox = await makeSandboxRepo(PLAN);
  paths = resolveHarnessPaths(sandbox.root);
  await mkdir(path.join(sandbox.root, 'dev', 'profiles'), { recursive: true });
  await writeFile(path.join(sandbox.root, 'dev', 'profiles', `${PROFILE}.yaml`), PROFILE_YAML, 'utf8');
  const baseline = await commitAll(sandbox.root, 'perfil orchestrator-owned');
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }),
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

function orchestrate(mode: string, extra: readonly string[] = []) {
  return runDevCli(
    'dev-orchestrate.ts',
    ['--repo', sandbox.root, '--profile', PROFILE, ...extra],
    { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: mode },
  );
}

describe('dev-orchestrate — reparo automático bounded da validation oficial', () => {
  it('1 — FIRST_PASS FAIL + REPAIR PASS => tarefa aceita, mesmo profile', async () => {
    const result = await orchestrate('official-fail-then-repair', ['--max-iterations', '1']);
    expect(result.exitCode, result.stderr).toBe(9);

    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iteration_count: number;
      total_api_equivalent_usd: number | null;
      iterations: {
        task_id: string;
        attempt: number;
        attempt_kind: string;
        result: string;
        api_equivalent_usd: number | null;
      }[];
    };
    expect(summary.stopped_by).toBe('LIMIT_REACHED');
    expect(summary.iteration_count).toBe(2);
    expect(summary.iterations.map((item) => item.task_id)).toEqual(['T1', 'T1']);
    expect(summary.iterations.map((item) => item.attempt_kind)).toEqual(['FIRST_PASS', 'REPAIR']);
    expect(summary.iterations.map((item) => item.result)).toEqual(['FAIL', 'PASS']);
    expect(summary.iterations.map((item) => item.attempt)).toEqual([1, 2]);
    expect(result.stdout).not.toContain('automatic_repair');
    expect(result.stdout).not.toContain('repair_source_attempt');
    const estimates = summary.iterations
      .map((item) => item.api_equivalent_usd)
      .filter((value): value is number => value !== null);
    expect(summary.total_api_equivalent_usd).toBe(
      estimates.length === 0 ? null : estimates.reduce((sum, value) => sum + value, 0),
    );

    const state = await readState(paths);
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS', 'READY']);
    expect(await readValidationFailedAttempt(paths, 'T1', 1)).not.toBeNull();
    expect(await readValidationFailedAttempt(paths, 'T1', 2)).toBeNull();
    expect((await readLaunchRecord(paths, 'T1'))?.profile_id).toBe(PROFILE);
    expect((await readPacket(paths, 'T1'))?.previous_attempt_diagnostics?.profile_id).toBe(PROFILE);
    expect((await readPacket(paths, 'T1'))?.previous_attempt_diagnostics?.attempt).toBe(1);
  }, 60_000);

  it('2 — FIRST_PASS FAIL + REPAIR FAIL => STOP, nenhum terceiro launch', async () => {
    const result = await orchestrate('official-fail', ['--max-iterations', '2']);
    expect(result.exitCode, result.stderr).toBe(9);

    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iteration_count: number;
      iterations: { task_id: string; attempt: number; attempt_kind: string; result: string }[];
    };
    expect(summary.stopped_by).toBe(AUTOMATIC_REPAIR_EXHAUSTED);
    expect(summary.iteration_count).toBe(2);
    expect(summary.iterations.map((item) => item.attempt_kind)).toEqual(['FIRST_PASS', 'REPAIR']);
    expect(summary.iterations.map((item) => item.result)).toEqual(['FAIL', 'FAIL']);
    expect(summary.iterations.map((item) => item.attempt)).toEqual([1, 2]);

    const state = await readState(paths);
    expect(state.tasks[0]?.status).toBe('FAIL');
    expect(state.tasks[1]?.status).toBe('READY');
    expect(await readValidationFailedAttempt(paths, 'T1', 1)).not.toBeNull();
  }, 60_000);

  it('3/20 — --max-iterations 1 com FAIL+REPAIR PASS não lança a próxima tarefa', async () => {
    const result = await orchestrate('official-fail-then-repair', ['--max-iterations', '1']);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iterations: { task_id: string }[];
    };
    expect(summary.stopped_by).toBe('LIMIT_REACHED');
    expect(summary.iterations.every((item) => item.task_id === 'T1')).toBe(true);
    expect((await readState(paths)).tasks[1]?.status).toBe('READY');
  }, 60_000);

  it('4 — --max-iterations 1 com FAIL+REPAIR FAIL para no repair, sem T2', async () => {
    const result = await orchestrate('official-fail', ['--max-iterations', '1']);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iteration_count: number;
    };
    expect(summary.stopped_by).toBe(AUTOMATIC_REPAIR_EXHAUSTED);
    expect(summary.iteration_count).toBe(2);
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['FAIL', 'READY']);
  }, 60_000);

  it('16 — restart depois de REPAIR validation FAIL => STOP, nenhum terceiro attempt', async () => {
    const first = await orchestrate('official-fail', ['--max-iterations', '1']);
    expect(JSON.parse(first.stdout).stopped_by).toBe(AUTOMATIC_REPAIR_EXHAUSTED);

    const second = await orchestrate('official-fail', ['--max-iterations', '1']);
    expect(second.exitCode).toBe(9);
    const summary = JSON.parse(second.stdout) as {
      stopped_by: string;
      iteration_count: number;
    };
    expect(summary.stopped_by).toBe(AUTOMATIC_REPAIR_EXHAUSTED);
    expect(summary.iteration_count).toBe(0);
    expect((await readState(paths)).tasks[0]?.attempts).toBe(2);
  }, 60_000);

  it('14/15 — restart depois do FIRST FAIL (antes e depois do archival) dispara um único REPAIR', async () => {
    const now = '2026-08-12T22:00:00.000Z';
    const baseSha = (await readState(paths)).authorized_head_sha!;
    await ensureTaskInbox(paths, 'T1');
    await writePacket(
      paths,
      buildTaskPacket({
        task: loaded.byId.get('T1')!,
        baseSha,
        previousHandoff: null,
        now,
      }),
    );
    await writeState(
      paths,
      withTaskState(await readState(paths), 'T1', {
        status: 'RUNNING',
        phase: 'FINALIZING',
        attempts: 1,
        base_sha: baseSha,
        process: null,
        candidate_commit: null,
        accepted_commit: null,
        started_at: now,
        finished_at: null,
      }),
    );
    await writeLaunchRecord(paths, {
      schema_version: 1,
      task_id: 'T1',
      profile_id: PROFILE,
      execution_policy: {
        commit_owner: 'orchestrator',
        official_validation_owner: 'orchestrator',
        worker_validation_policy: 'targeted',
      },
      argv: ['node', 'fixtures/fake-worker.mjs'],
      process: {
        pid: 4242,
        pgid: 4242,
        started_at: now,
        proc_start_ticks: 1,
        command_sha256: 'e'.repeat(64),
      },
      launch_id: '123e4567-e89b-42d3-a456-426614174000',
      survivors_killed: [],
      survivors_remaining: [],
      started_at: now,
      finished_at: now,
      duration_ms: 1,
      exit_code: 0,
      timed_out: false,
      controlled: {},
      billing: null,
    });
    await writeFile(
      reportPath(paths, 'T1'),
      `${JSON.stringify({
        schema_version: 1,
        task_id: 'T1',
        self_reported_result: 'SUCCESS',
        summary: 'patch do attempt 1',
        candidate_commit: null,
        changed_files: ['src/t1.txt'],
        validations: [],
        decisions: [],
        lessons: [],
        relevant_files: ['src/t1.txt'],
      })}\n`,
    );
    await writeFile(
      handoffDraftPath(paths, 'T1'),
      `${JSON.stringify({
        schema_version: 1,
        task_id: 'T1',
        result: 'PASS',
        changed_files: ['src/t1.txt'],
        validations: [],
        decisions: [],
        lessons: [],
        next_relevant_files: ['src/t1.txt'],
      })}\n`,
    );
    await mkdir(path.join(sandbox.root, 'src'), { recursive: true });
    await writeFile(path.join(sandbox.root, 'src', 't1.txt'), 'broken\n', 'utf8');
    const failed = await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: 'T1',
      validationRunner: async (command) => ({
        argv: [...command.argv],
        exit_code: 1,
        timed_out: false,
        duration_ms: 1,
      }),
      now: () => now,
    });
    expect(failed.kind).toBe('FAIL');
    expect((await readState(paths)).tasks[0]?.status).toBe('FAIL');
    expect(await readValidationFailedAttempt(paths, 'T1', 1)).toBeNull();

    const result = await orchestrate('official-fail-then-repair', ['--max-iterations', '1']);
    expect(result.exitCode, result.stderr).toBe(9);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iteration_count: number;
      iterations: { attempt: number; attempt_kind: string; result: string }[];
    };
    expect(summary.stopped_by).toBe('LIMIT_REACHED');
    expect(summary.iteration_count).toBe(1);
    expect(summary.iterations[0]).toMatchObject({
      attempt: 2,
      attempt_kind: 'REPAIR',
      result: 'PASS',
    });
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['PASS', 'READY']);
    expect(await readValidationFailedAttempt(paths, 'T1', 1)).not.toBeNull();
  }, 60_000);

  it('verbose inclui automatic_repair no REPAIR sem quebrar o compacto', async () => {
    const result = await orchestrate('official-fail-then-repair', [
      '--max-iterations',
      '1',
      '--verbose',
    ]);
    const summary = JSON.parse(result.stdout) as {
      iterations: {
        attempt_kind: string;
        automatic_repair?: boolean;
        repair_source_attempt?: number;
      }[];
    };
    expect(summary.iterations[0]?.attempt_kind).toBe('FIRST_PASS');
    expect(summary.iterations[1]).toMatchObject({
      attempt_kind: 'REPAIR',
      automatic_repair: true,
      repair_source_attempt: 1,
    });
  }, 60_000);
});
