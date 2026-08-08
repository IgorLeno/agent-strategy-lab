import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeOrchestratedTask,
  type OrchestratedValidationRunner,
} from '../../dev/lib/finalize-orchestrated.js';
import { headSha, isWorkingTreeClean } from '../../dev/lib/git.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  completionPath,
  ensureTaskInbox,
  failedAttemptCompletionPath,
  handoffDraftPath,
  readCompletion,
  readValidationFailedAttempt,
  reportPath,
  writeLaunchRecord,
  writePacket,
} from '../../dev/lib/records.js';
import { retryFailedAttempt } from '../../dev/lib/retry-failed.js';
import { bindRevalidationSource } from '../../dev/lib/revalidation-bind.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { makeSandboxRepo, type Sandbox } from './helpers.js';

/**
 * Regressão do incidente do M23: o CompletionRecord FAIL de um attempt
 * rejeitado ficava no slot corrente e fazia a selagem do attempt SEGUINTE
 * falhar com "CompletionRecord existente diverge do finalization record".
 *
 * O teste percorre a transição inteira com os módulos reais — validation
 * oficial FAIL, dev-retry-failed, novo attempt, validation oficial PASS,
 * selagem — porque o defeito só aparece no encadeamento, não em nenhum dos
 * passos isolados.
 */

/** argv de todo subprocesso do ciclo: nenhum provider pode ser executado. */
const spawnLog = vi.hoisted(() => [] as string[][]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      spawnLog.push([String(args[0]), ...(Array.isArray(args[1]) ? args[1].map(String) : [])]);
      return actual.spawn(...args);
    },
  };
});

/** `timeout --signal=TERM --kill-after=Xs Ns <programa> …` embrulha o comando real. */
function spawnedProgram(argv: readonly string[]): string {
  return argv[0] === 'timeout' ? (argv[4] ?? '') : (argv[0] ?? '');
}

const NOW = '2026-08-08T12:00:00.000Z';
const TASK = 'T1';
const REASON = 'a solução do worker foi reprovada pela suíte oficial completa';
const CHANGED = 'src/one.ts';

const PLAN = `
schema_version: 1
tasks:
  - id: ${TASK}
    title: tarefa orquestrada
    objective: produzir patch
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
  - id: T2
    title: próxima
    blocked_by: [${TASK}]
    objective: não executar
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
`;

const passingRunner: OrchestratedValidationRunner = async (command) => ({
  argv: [...command.argv],
  exit_code: 0,
  timed_out: false,
  duration_ms: 1,
});

const failingRunner: OrchestratedValidationRunner = async (command) => ({
  argv: [...command.argv],
  exit_code: 1,
  timed_out: false,
  duration_ms: 1,
});

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let baseSha: string;

beforeEach(async () => {
  spawnLog.length = 0;
  sandbox = await makeSandboxRepo(PLAN);
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  baseSha = await headSha(sandbox.root);
  await ensureRuntimeDirs(paths);
  await ensureTaskInbox(paths, TASK);
  await writePacket(
    paths,
    buildTaskPacket({ task: loaded.byId.get(TASK)!, baseSha, previousHandoff: null }),
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

/** Coloca a tarefa em RUNNING/FINALIZING com a evidence do worker no lugar. */
async function armAttempt(attempt: number): Promise<void> {
  const state = await readState(paths).catch(() =>
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha, now: NOW }),
  );
  await writeState(
    paths,
    withTaskState(state, TASK, {
      status: 'RUNNING',
      phase: 'FINALIZING',
      attempts: attempt,
      base_sha: baseSha,
      process: null,
      candidate_commit: null,
      accepted_commit: null,
      started_at: NOW,
      finished_at: null,
    }),
  );
  await writeLaunchRecord(paths, {
    schema_version: 1,
    task_id: TASK,
    profile_id: 'orchestrator-v2',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    argv: ['fake-worker'],
    process: {
      pid: 999_997,
      pgid: 999_997,
      started_at: NOW,
      proc_start_ticks: 1,
      command_sha256: 'e'.repeat(64),
    },
    launch_id: '123e4567-e89b-42d3-a456-426614174000',
    survivors_killed: [],
    survivors_remaining: [],
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 1,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: null,
  });
  await writeFile(
    reportPath(paths, TASK),
    `${JSON.stringify(
      {
        schema_version: 1,
        task_id: TASK,
        self_reported_result: 'SUCCESS',
        summary: `patch do attempt ${attempt}`,
        candidate_commit: null,
        changed_files: [CHANGED],
        validations: [],
        decisions: ['decisão'],
        lessons: ['lição'],
        relevant_files: [CHANGED],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    handoffDraftPath(paths, TASK),
    `${JSON.stringify(
      {
        schema_version: 1,
        task_id: TASK,
        result: 'PASS',
        changed_files: [CHANGED],
        validations: [],
        decisions: ['decisão'],
        lessons: ['lição'],
        next_relevant_files: [CHANGED],
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(path.dirname(path.join(sandbox.root, CHANGED)), { recursive: true });
  await writeFile(
    path.join(sandbox.root, CHANGED),
    `export const value = ${attempt};\n`,
  );
}

/** attempt reprovado pela validation oficial, arquivado por dev-retry-failed. */
async function failAndArchive(attempt: number): Promise<Buffer> {
  await armAttempt(attempt);
  const failed = await finalizeOrchestratedTask({
    paths,
    loaded,
    taskId: TASK,
    validationRunner: failingRunner,
    now: () => NOW,
  });
  expect(failed.kind).toBe('FAIL');
  expect(failed.completion?.status).toBe('FAIL');

  const failBytes = await readFile(completionPath(paths, TASK));
  await bindRevalidationSource({ paths, taskId: TASK, now: () => NOW });
  await retryFailedAttempt({
    paths,
    taskId: TASK,
    reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
    reason: REASON,
    now: () => NOW,
  });
  return failBytes;
}

describe('ciclo FAIL oficial → dev-retry-failed → novo attempt PASS', () => {
  it('sela o attempt seguinte sem colidir com o CompletionRecord FAIL anterior', async () => {
    const failBytes = await failAndArchive(1);

    // O que dev-retry-failed deixou: FAIL preservado byte a byte, slot livre,
    // tarefa READY e working tree de volta à base autorizada.
    const archiveFile = failedAttemptCompletionPath(paths, TASK, 1);
    expect(await readFile(archiveFile)).toEqual(failBytes);
    expect(await readCompletion(paths, TASK)).toBeNull();
    const reopened = await readState(paths);
    expect(reopened.tasks.find((task) => task.id === TASK)?.status).toBe('READY');
    expect(reopened.tasks.find((task) => task.id === TASK)?.attempts).toBe(1);
    expect(await isWorkingTreeClean(sandbox.root)).toBe(true);
    expect(await headSha(sandbox.root)).toBe(baseSha);

    // Attempt 2: worker SUCCESS e validations oficiais PASS.
    await armAttempt(2);
    const outcome = await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: passingRunner,
      now: () => NOW,
    });

    expect(outcome.kind).toBe('PASS');
    const candidate = await headSha(sandbox.root);
    expect(candidate).not.toBe(baseSha);

    const completion = await readCompletion(paths, TASK);
    expect(completion?.status).toBe('PASS');
    expect(completion?.orchestrator_evidence.accepted_commit).toBe(candidate);
    expect(completion?.orchestrated_finalization_attempt).toBe(2);

    const state = await readState(paths);
    const task = state.tasks.find((entry) => entry.id === TASK);
    expect(task?.status).toBe('PASS');
    expect(task?.accepted_commit).toBe(candidate);
    expect(state.authorized_head_sha).toBe(candidate);

    // A evidência do attempt reprovado sobrevive ao fechamento aceito.
    expect(await readFile(archiveFile)).toEqual(failBytes);
    expect(await readValidationFailedAttempt(paths, TASK, 1)).not.toBeNull();
  });

  it('o FAIL de volta no slot corrente reproduz a colisão original', async () => {
    // Controle negativo: prova que o teste acima cobre a causa confirmada, e
    // não outro caminho que por acaso passou a funcionar.
    await failAndArchive(1);
    await copyFile(failedAttemptCompletionPath(paths, TASK, 1), completionPath(paths, TASK));

    await armAttempt(2);
    await expect(
      finalizeOrchestratedTask({
        paths,
        loaded,
        taskId: TASK,
        validationRunner: passingRunner,
        now: () => NOW,
      }),
    ).rejects.toThrow(/CompletionRecord existente diverge do finalization record/);
  });

  it('nenhum provider é executado no ciclo inteiro', async () => {
    await failAndArchive(1);
    await armAttempt(2);
    await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: passingRunner,
      now: () => NOW,
    });

    expect(spawnLog.length).toBeGreaterThan(0);
    expect([...new Set(spawnLog.map(spawnedProgram))]).toEqual(['git']);
  });
});
