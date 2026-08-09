import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeOrchestratedTask,
  type OrchestratedValidationRunner,
} from '../../dev/lib/finalize-orchestrated.js';
import { sha256Hex } from '../../dev/lib/canonical.js';
import { headSha, isWorkingTreeClean, patchFingerprint } from '../../dev/lib/git.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  completionPath,
  ensureTaskInbox,
  failedAttemptCompletionPath,
  handoffDraftPath,
  originalCompletionEvidencePath,
  readCompletion,
  readRevalidationSourceBinding,
  readValidationFailedAttempt,
  reportPath,
  sourceBindingPath,
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

  // Nenhum bind manual: um FAIL oficial já nasce com a fonte selada, e é isso
  // que torna dev-retry-failed executável IMEDIATAMENTE depois dele.
  const failBytes = await readFile(completionPath(paths, TASK));
  await retryFailedAttempt({
    paths,
    taskId: TASK,
    reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
    reason: REASON,
    now: () => NOW,
  });
  return failBytes;
}

/**
 * Regressão do incidente do M39B: a validation oficial reprovava o attempt, o
 * finalization gravava `status = FAIL` + CompletionRecord oficial + patch
 * rejeitado, e NÃO materializava o source binding. A tarefa terminava num
 * estado que nem `dev-revalidate` nem `dev-retry-failed` conseguiam tocar.
 *
 * O contrato que estes testes fixam: um FAIL oficial nasce selado, e selado
 * ANTES de o veredito ficar observável.
 */
describe('FAIL oficial nasce com a fonte selada', () => {
  it('materializa binding e CompletionRecord original no próprio finalization', async () => {
    await armAttempt(1);
    const fingerprint = await patchFingerprint(sandbox.root);
    const outcome = await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: failingRunner,
      now: () => NOW,
    });
    expect(outcome.kind).toBe('FAIL');

    const failBytes = await readFile(completionPath(paths, TASK));
    const binding = await readRevalidationSourceBinding(paths, TASK, 1);
    expect(binding).toMatchObject({
      task_id: TASK,
      attempt: 1,
      source_base_sha: baseSha,
      original_completion_path: 'original-completion.fail.json',
      original_completion_sha256: sha256Hex(failBytes),
      report_sha256: sha256Hex(await readFile(reportPath(paths, TASK))),
      handoff_draft_sha256: sha256Hex(await readFile(handoffDraftPath(paths, TASK))),
      changed_files: [CHANGED],
      derived_patch_fingerprint: fingerprint,
      fingerprint_provenance: 'derived_at_official_validation_failure',
    });

    // O archive que a revalidação auditada consome é byte-idêntico ao slot.
    expect(await readFile(originalCompletionEvidencePath(paths, TASK, 1))).toEqual(failBytes);
  });

  it('dev-retry-failed roda imediatamente depois do FAIL, sem bind manual', async () => {
    await armAttempt(1);
    await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: failingRunner,
      now: () => NOW,
    });

    const result = await retryFailedAttempt({
      paths,
      taskId: TASK,
      reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
      reason: REASON,
      now: () => NOW,
    });
    // A fonte veio pronta do finalization: não houve nada a recuperar.
    expect(result.bindingRecovered).toBe(false);
    expect(result.record.attempt).toBe(1);
    expect(await isWorkingTreeClean(sandbox.root)).toBe(true);
  });

  it('o binding contemporâneo recusa um patch trocado depois do FAIL', async () => {
    await armAttempt(1);
    await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: failingRunner,
      now: () => NOW,
    });

    // O fingerprint foi observado no instante do FAIL, então substituir a
    // solução depois não passa despercebido.
    await writeFile(path.join(sandbox.root, CHANGED), 'export const value = 99;\n');
    await expect(
      retryFailedAttempt({
        paths,
        taskId: TASK,
        reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
        reason: REASON,
        now: () => NOW,
      }),
    ).rejects.toThrow(/patch fingerprint diverge/i);
  });

  it('a revalidação auditada continua selando a mesma fonte como já vinculada', async () => {
    await armAttempt(1);
    await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: failingRunner,
      now: () => NOW,
    });
    const sealed = await readFile(sourceBindingPath(paths, TASK, 1));

    const bound = await bindRevalidationSource({ paths, taskId: TASK, now: () => NOW });
    expect(bound.alreadyBound).toBe(true);
    expect(bound.binding.fingerprint_provenance).toBe('derived_at_official_validation_failure');
    // O preflight confere, não reescreve: os bytes selados são os mesmos.
    expect(await readFile(sourceBindingPath(paths, TASK, 1))).toEqual(sealed);
  });

  it('não sela fonte quando o worker reportou FAILURE', async () => {
    await armAttempt(1);
    const report = JSON.parse(await readFile(reportPath(paths, TASK), 'utf8'));
    await writeFile(
      reportPath(paths, TASK),
      `${JSON.stringify({ ...report, self_reported_result: 'FAILURE' }, null, 2)}\n`,
    );
    const draft = JSON.parse(await readFile(handoffDraftPath(paths, TASK), 'utf8'));
    await writeFile(
      handoffDraftPath(paths, TASK),
      `${JSON.stringify({ ...draft, result: 'FAIL' }, null, 2)}\n`,
    );

    const outcome = await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: failingRunner,
      now: () => NOW,
    });
    expect(outcome.kind).toBe('FAIL');
    expect(outcome.reason).toMatch(/worker reportou FAILURE/);
    expect(await readRevalidationSourceBinding(paths, TASK, 1)).toBeNull();
  });

  it('crash entre selar a fonte e publicar o FAIL converge sem divergir bytes', async () => {
    await armAttempt(1);
    class Crash extends Error {}
    await expect(
      finalizeOrchestratedTask({
        paths,
        loaded,
        taskId: TASK,
        validationRunner: failingRunner,
        now: () => NOW,
        afterFailSourceSealed: async () => {
          throw new Crash('crash depois de selar a fonte');
        },
      }),
    ).rejects.toThrow(/crash depois de selar a fonte/);

    // Estado observável no crash: fonte selada, veredito ainda não publicado.
    const sealed = await readFile(originalCompletionEvidencePath(paths, TASK, 1));
    expect(await readRevalidationSourceBinding(paths, TASK, 1)).not.toBeNull();
    expect(await readCompletion(paths, TASK)).toBeNull();
    const halfway = (await readState(paths)).tasks.find((task) => task.id === TASK);
    expect(halfway?.status).toBe('RUNNING');
    expect(halfway?.phase).toBe('FINALIZING');

    // A retomada NÃO reabre o gate: mesmo com um runner que passaria, o
    // veredito selado é o que vale, e os bytes publicados são os mesmos.
    const resumed = await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: TASK,
      validationRunner: passingRunner,
      now: () => NOW,
    });
    expect(resumed.kind).toBe('FAIL');
    expect(await readFile(completionPath(paths, TASK))).toEqual(sealed);
    expect(await headSha(sandbox.root)).toBe(baseSha);
    expect((await readState(paths)).tasks.find((task) => task.id === TASK)?.status).toBe('FAIL');

    // E o attempt segue arquivável — que é o ponto do incidente inteiro.
    const archived = await retryFailedAttempt({
      paths,
      taskId: TASK,
      reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
      reason: REASON,
      now: () => NOW,
    });
    expect(archived.record.attempt).toBe(1);
    expect((await readState(paths)).tasks.find((task) => task.id === TASK)?.status).toBe('READY');
  });
});

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
