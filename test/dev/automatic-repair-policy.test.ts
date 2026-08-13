import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideAutomaticRepair } from '../../dev/lib/automatic-repair.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  validationFailedAttemptPath,
  writeAttemptAbandonment,
  writeCompletion,
  writeInfraFailedAttempt,
  writeLaunchRecord,
  writeValidationFailedAttempt,
} from '../../dev/lib/records.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { makeSandboxRepo, type Sandbox } from './helpers.js';

/**
 * A política de reparo automático bounded deriva SOMENTE de evidência
 * histórica (ValidationFailedAttemptRecord + travessia capability-neutral de
 * InfraFailedAttemptRecord). Nenhum teste aqui usa `attempts > 1` como
 * critério — o número operacional só delimita até onde a cadeia é lida.
 */

const TASK = 'T1';
const PROFILE = 'fake-orchestrator-v2';
const OTHER_PROFILE = 'claude-sonnet-high-v1';
const NOW = '2026-08-12T21:00:00.000Z';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let baseSha: string;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  baseSha = await headSha(sandbox.root);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha }),
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

function hex64(seed: string): string {
  const hex = [...seed].map((ch) => (/[0-9a-f]/i.test(ch) ? ch.toLowerCase() : 'a')).join('');
  return hex.padEnd(64, '0').slice(0, 64);
}

function validationFailed(attempt: number, profileId = PROFILE) {
  return {
    schema_version: 1 as const,
    task_id: TASK,
    attempt,
    source_base_sha: baseSha,
    profile_id: profileId,
    worker_self_reported_result: 'SUCCESS' as const,
    report_candidate_commit: null,
    orchestrator_verdict: 'REJECTED_BY_OFFICIAL_VALIDATION' as const,
    finalization_mode: 'normal' as const,
    launch_record_sha256: hex64(`launch-v-${attempt}`),
    original_completion_sha256: hex64(`completion-${attempt}`),
    report_sha256: hex64(`report-${attempt}`),
    handoff_draft_sha256: hex64(`handoff-${attempt}`),
    source_binding_sha256: hex64(`binding-${attempt}`),
    patch_fingerprint: hex64(`patch-${attempt}`),
    changed_files: ['src/t1.txt'],
    original_validation_results: [
      { argv: ['grep', '-qx', 'repaired', 'src/t1.txt'], exit_code: 1, timed_out: false, duration_ms: 1 },
    ],
    change_bundle: {
      manifest_path: `failed-attempts/${TASK}/attempt-${attempt}/changes-manifest.json`,
      manifest_sha256: hex64(`manifest-${attempt}`),
      patch_path: `failed-attempts/${TASK}/attempt-${attempt}/changes.patch`,
      patch_sha256: hex64(`patch-bytes-${attempt}`),
      patch_size_bytes: 12,
    },
    reason_code: 'OFFICIAL_VALIDATION_FAILURE' as const,
    reason: `attempt ${attempt} reprovado pela validation oficial`,
    archived_at: NOW,
  };
}

function infraFailed(attempt: number) {
  return {
    schema_version: 1 as const,
    task_id: TASK,
    attempt,
    source_base_sha: baseSha,
    profile_id: PROFILE,
    process: {
      pid: 1000 + attempt,
      pgid: 1000 + attempt,
      started_at: NOW,
      proc_start_ticks: attempt,
      command_sha256: hex64(`command-${attempt}`),
    },
    launch_id: `00000000-0000-4000-8000-00000000000${attempt}`,
    launch_classification: 'INFRA_ERROR' as const,
    launch_record_sha256: hex64(`launch-i-${attempt}`),
    exit_code: 1,
    timed_out: false as const,
    started_at: NOW,
    finished_at: NOW,
    provider_failure: {
      is_error: true,
      terminal_reason: 'authentication_failed',
      api_error_status: 401,
      subtype: null,
      num_turns: null,
      message: 'OAuth 401',
      message_sha256: hex64(`oauth-${attempt}`),
      signals: ['http_401'],
    },
    provider_failure_source: 'launch_record' as const,
    billing: null,
    subscription_usage: null,
    rate_limit_observations: null,
    worker_output_present: false as const,
    candidate_commit: null,
    working_tree_clean: true as const,
    head_sha: baseSha,
    evidence: [
      {
        path: `failed-attempts/${TASK}/attempt-${attempt}/launch.infra.json`,
        source_path: `logs/${TASK}.launch.json`,
        sha256: hex64(`ev-${attempt}`),
        size_bytes: 1,
      },
    ],
    reason_code: 'PROVIDER_TERMINAL_FAILURE' as const,
    reason: 'OAuth 401',
    archived_at: NOW,
  };
}

function abandoned(attempt: number) {
  return {
    schema_version: 1 as const,
    task_id: TASK,
    attempt,
    base_sha: baseSha,
    process: {
      pid: 2000 + attempt,
      pgid: 2000 + attempt,
      started_at: NOW,
      proc_start_ticks: attempt,
      command_sha256: hex64(`abandoned-command-${attempt}`),
    },
    launch_classification: 'FINISHED' as const,
    exit_code: 0,
    started_at: NOW,
    finished_at: NOW,
    reason: `attempt ${attempt} abandonado manualmente`,
    previous_diagnostics: null,
    candidate_commit: null,
    working_tree_clean: true as const,
    head_sha: baseSha,
    report_present: false as const,
    handoff_present: false as const,
    abandoned_at: NOW,
  };
}

async function setTask(
  status: 'READY' | 'FAIL' | 'TIMED_OUT' | 'INFRA_ERROR' | 'RUNNING',
  attempts: number,
): Promise<void> {
  await writeState(
    paths,
    withTaskState(await readState(paths), TASK, {
      status,
      phase: status === 'RUNNING' ? 'FINALIZING' : null,
      attempts,
      candidate_commit: null,
      accepted_commit: null,
    }),
  );
}

async function writeOfficialFailCompletion(workerResult: 'SUCCESS' | 'FAILURE' = 'SUCCESS') {
  const failed = workerResult === 'SUCCESS';
  await writeCompletion(paths, {
    schema_version: 1,
    task_id: TASK,
    status: 'FAIL',
    report: {
      schema_version: 1,
      task_id: TASK,
      self_reported_result: workerResult,
      summary: 'fixture',
      candidate_commit: null,
      changed_files: ['src/t1.txt'],
      validations: [],
      decisions: [],
      lessons: [],
      relevant_files: ['src/t1.txt'],
    },
    orchestrator_evidence: {
      task_id: TASK,
      base_sha: baseSha,
      candidate_commit: null,
      accepted_commit: null,
      changed_files: ['src/t1.txt'],
      working_tree_clean: false,
      process: null,
      duration_ms: 1,
      exit_code: 0,
      timed_out: false,
      revalidation: failed
        ? [{ argv: ['grep', '-qx', 'repaired', 'src/t1.txt'], exit_code: 1, timed_out: false, duration_ms: 1 }]
        : [],
      observed_at: NOW,
    },
    report_matches_evidence: true,
    discrepancies: [],
    finalization_mode: 'normal',
    commit_origin: 'orchestrator',
    orchestrated_finalization_attempt: 1,
    orchestrated_finalization_record_sha256: hex64('finalization'),
    closed_at: NOW,
  });
}

async function writeLaunch(profileId = PROFILE) {
  await writeLaunchRecord(paths, {
    schema_version: 1,
    task_id: TASK,
    profile_id: profileId,
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    argv: ['fake-worker'],
    process: {
      pid: 4242,
      pgid: 4242,
      started_at: NOW,
      proc_start_ticks: 1,
      command_sha256: hex64('cmd'),
    },
    launch_id: '123e4567-e89b-42d3-a456-426614174000',
    survivors_killed: [],
    survivors_remaining: [],
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 10,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: null,
  });
}

describe('decideAutomaticRepair — autorização por ValidationFailedAttemptRecord', () => {
  it('A — primeiro FAIL oficial sem record anterior => REPAIR_ALLOWED', async () => {
    await setTask('FAIL', 1);
    await writeOfficialFailCompletion();
    await writeLaunch();

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 1,
      profile_id: PROFILE,
      needs_archival: true,
    });
  });

  it('B — task FAIL com dois ValidationFailedAttemptRecords => REPAIR_EXHAUSTED', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeValidationFailedAttempt(paths, validationFailed(2));
    await setTask('FAIL', 2);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision.action).toBe('REPAIR_EXHAUSTED');
  });

  it('READY com dois ValidationFailedAttemptRecords é intervenção humana e não bloqueia', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeValidationFailedAttempt(paths, validationFailed(2));
    await setTask('READY', 2);

    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('C — validation 1 + infra 2 + validation FAIL 3 => segundo capability FAIL, STOP', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeInfraFailedAttempt(paths, infraFailed(2));
    await setTask('FAIL', 3);
    await writeOfficialFailCompletion();
    await writeLaunch();

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision.action).toBe('REPAIR_EXHAUSTED');
  });

  it('D — INFRA attempt 1 + validation FAIL attempt 2 => primeiro capability FAIL, repair permitido', async () => {
    await writeInfraFailedAttempt(paths, infraFailed(1));
    await setTask('FAIL', 2);
    await writeOfficialFailCompletion();
    await writeLaunch();

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 2,
      profile_id: PROFILE,
      needs_archival: true,
    });
  });

  it('READY depois de um ValidationFailedAttempt => repair ainda autorizado, sem archival', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await setTask('READY', 1);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 1,
      profile_id: PROFILE,
      needs_archival: false,
    });
  });

  it('validation FAIL 1 + infra 2 READY => repair continua autorizado (infra não consome)', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeInfraFailedAttempt(paths, infraFailed(2));
    await setTask('READY', 2);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 1,
      needs_archival: false,
    });
  });

  it('não usa o número operacional do attempt como critério: attempts=2 só com INFRA não autoriza repair', async () => {
    await writeInfraFailedAttempt(paths, infraFailed(1));
    await writeInfraFailedAttempt(paths, infraFailed(2));
    await setTask('READY', 2);

    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('profile_id do repair é o do ValidationFailedAttempt, não um perfil novo', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1, OTHER_PROFILE));
    await setTask('READY', 1);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision).toMatchObject({ action: 'REPAIR_ALLOWED', profile_id: OTHER_PROFILE });
  });
});

describe('decideAutomaticRepair — caminhos que esta automação não cobre', () => {
  it('worker FAILURE => NOT_APPLICABLE', async () => {
    await setTask('FAIL', 1);
    await writeOfficialFailCompletion('FAILURE');
    await writeLaunch();

    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('PENDING/RUNNING => NOT_APPLICABLE', async () => {
    await setTask('RUNNING', 1);
    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('TIMED_OUT => NOT_APPLICABLE', async () => {
    await setTask('TIMED_OUT', 1);
    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('INFRA_ERROR => NOT_APPLICABLE', async () => {
    await setTask('INFRA_ERROR', 1);
    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('READY sem nenhum ValidationFailedAttempt => NOT_APPLICABLE (FIRST_PASS)', async () => {
    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('FAIL sem CompletionRecord não adivinha autorização', async () => {
    await setTask('FAIL', 1);
    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('AttemptAbandonmentRecord é fronteira conhecida, não gap histórico', async () => {
    await writeAttemptAbandonment(paths, abandoned(1));
    await setTask('READY', 1);

    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('validation anterior não é atravessada depois de AttemptAbandonmentRecord', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeAttemptAbandonment(paths, abandoned(2));
    await setTask('READY', 2);

    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });
});

describe('decideAutomaticRepair — fail closed', () => {
  it('Validation + Infra no mesmo attempt => BLOCKED', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeInfraFailedAttempt(paths, infraFailed(1));
    await setTask('READY', 1);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision.action).toBe('BLOCKED');
    if (decision.action === 'BLOCKED') {
      expect(decision.code).toBe('INCONSISTENT_EVIDENCE');
    }
  });

  it('Validation + AttemptAbandonment no mesmo attempt => BLOCKED', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeAttemptAbandonment(paths, abandoned(1));
    await setTask('READY', 1);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision).toMatchObject({ action: 'BLOCKED', code: 'INCONSISTENT_EVIDENCE' });
  });

  it('Infra + AttemptAbandonment no mesmo attempt => BLOCKED', async () => {
    await writeInfraFailedAttempt(paths, infraFailed(1));
    await writeAttemptAbandonment(paths, abandoned(1));
    await setTask('READY', 1);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision).toMatchObject({ action: 'BLOCKED', code: 'INCONSISTENT_EVIDENCE' });
  });

  it('gap histórico sem record => BLOCKED, sem repair automático', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await setTask('READY', 2);

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision.action).toBe('BLOCKED');
    if (decision.action === 'BLOCKED') {
      expect(decision.code).toBe('HISTORICAL_GAP');
    }
  });

  it('record de validation inválido => BLOCKED', async () => {
    await setTask('READY', 1);
    const file = validationFailedAttemptPath(paths, TASK, 1);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"schema_version":1,"task_id":"T1"}\n', 'utf8');

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision.action).toBe('BLOCKED');
    if (decision.action === 'BLOCKED') {
      expect(decision.code).toBe('INVALID_EVIDENCE');
    }
  });

  it('CompletionRecord ilegível num FAIL não autoriza repair', async () => {
    await setTask('FAIL', 1);
    await mkdir(path.dirname(path.join(paths.completionsDir, `${TASK}.completion.json`)), {
      recursive: true,
    });
    await writeFile(
      path.join(paths.completionsDir, `${TASK}.completion.json`),
      '{nao-json',
      'utf8',
    );

    const decision = await decideAutomaticRepair(paths, TASK);
    expect(decision.action).toBe('BLOCKED');
    if (decision.action === 'BLOCKED') {
      expect(decision.code).toBe('INVALID_EVIDENCE');
    }
  });
});
