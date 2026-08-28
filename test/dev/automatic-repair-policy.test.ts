import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdditionalRepairAuthorizationError,
  consumeAdditionalRepairAuthorization,
  decideAutomaticRepair,
  grantAdditionalRepairAuthorization,
} from '../../dev/lib/automatic-repair.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  validationFailedAttemptPath,
  writeAttemptAbandonment,
  writeCompletion,
  writeInfraFailedAttempt,
  writeLaunchRecord,
  writeProtocolInvalidAttempt,
  writeReviewRejectedAttempt,
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

function reviewRejected(attempt: number, profileId = PROFILE) {
  return {
    schema_version: 1 as const,
    task_id: TASK,
    attempt,
    source_base_sha: baseSha,
    profile_id: profileId,
    candidate_sha: 'b'.repeat(40),
    finalization_record_sha256: hex64(`finalization-${attempt}`),
    review_record_sha256: hex64(`review-${attempt}`),
    rejection_classification_sha256: hex64(`classification-${attempt}`),
    rejection_disposition: 'IMPLEMENTATION_DEFECT' as const,
    review_reason: 'defeito concreto contra acceptance existente',
    changed_files: ['src/t1.txt'],
    original_validation_results: [
      { argv: ['true'], exit_code: 0, timed_out: false, duration_ms: 1 },
    ],
    patch_fingerprint: hex64(`review-patch-${attempt}`),
    change_bundle: {
      manifest_path: `failed-attempts/${TASK}/attempt-${attempt}/changes-manifest.json`,
      manifest_sha256: hex64(`review-manifest-${attempt}`),
      patch_path: `failed-attempts/${TASK}/attempt-${attempt}/changes.patch`,
      patch_sha256: hex64(`review-patch-bytes-${attempt}`),
      patch_size_bytes: 12,
    },
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

function protocolInvalid(attempt: number) {
  const digest = hex64(`protocol-${attempt}`);
  const archive = (name: string, source: string) => ({
    path: `failed-attempts/${TASK}/attempt-${attempt}/${name}`,
    source_path: source,
    sha256: digest,
    size_bytes: 1,
  });
  return {
    schema_version: 1 as const,
    task_id: TASK,
    attempt,
    classification: 'PROTOCOL_OUTPUT_INVALID' as const,
    reason_code: 'PROTOCOL_OUTPUT_INVALID' as const,
    reason: 'protocol I/O declarado como patch',
    source_base_sha: baseSha,
    head_sha: baseSha,
    authorized_head_sha: baseSha,
    profile_id: PROFILE,
    execution_policy: {
      commit_owner: 'orchestrator' as const,
      official_validation_owner: 'orchestrator' as const,
      worker_validation_policy: 'targeted' as const,
    },
    process: {
      pid: 3000 + attempt,
      pgid: 3000 + attempt,
      started_at: NOW,
      proc_start_ticks: attempt,
      command_sha256: digest,
    },
    launch_id: `00000000-0000-4000-8000-10000000000${attempt}`,
    launch_record: archive('protocol-invalid/launch.json', `logs/${TASK}.launch.json`),
    worker_self_reported_result: 'SUCCESS' as const,
    handoff_result: 'PASS' as const,
    report_candidate_commit: null,
    state_candidate_commit: null,
    state_accepted_commit: null,
    protocol_invalid_paths: [
      `.dev-inbox/${TASK}/handoff-draft.json`,
      `.dev-inbox/${TASK}/report.json`,
    ],
    changed_files: ['dev/lib/example.ts'],
    actual_patch_matches_normalized_report: true as const,
    patch_fingerprint: digest,
    patch_files: [
      {
        path: 'dev/lib/example.ts',
        git_status: ' M',
        content_state: 'ARCHIVED' as const,
        archive_path: `failed-attempts/${TASK}/attempt-${attempt}/protocol-invalid/files/dev/lib/example.ts`,
        size_bytes: 1,
        sha256: digest,
      },
    ],
    change_bundle: {
      manifest_path: `failed-attempts/${TASK}/attempt-${attempt}/changes-manifest.json`,
      manifest_sha256: digest,
      patch_path: `failed-attempts/${TASK}/attempt-${attempt}/changes.patch`,
      patch_sha256: digest,
      patch_size_bytes: 1,
    },
    report: archive('report.json', `../.dev-inbox/${TASK}/report.json`),
    handoff_draft: archive('handoff-draft.json', `../.dev-inbox/${TASK}/handoff-draft.json`),
    capability_verdict: null,
    official_validation_verdict: null,
    attempts_preserved: attempt,
    archived_at: NOW,
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

  it('M56-like: somente protocol-invalid é capability-neutral e não autoriza repair', async () => {
    await writeProtocolInvalidAttempt(paths, protocolInvalid(1));
    await setTask('READY', 1);

    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });

  it('validation 1 + protocol-invalid 2 mantém o repair do FAIL 1 elegível', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeProtocolInvalidAttempt(paths, protocolInvalid(2));
    await setTask('READY', 2);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 1,
      needs_archival: false,
    });
  });

  it('validation 1 + protocol-invalid 2 + validation FAIL 3 esgota o repair', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeProtocolInvalidAttempt(paths, protocolInvalid(2));
    await setTask('FAIL', 3);
    await writeOfficialFailCompletion();
    await writeLaunch();

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_EXHAUSTED',
      source_attempt: 1,
      validation_fail_count: 2,
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

  it('abandonment 1 + validation arquivada 2 preserva o primeiro FAIL do segmento atual', async () => {
    await writeAttemptAbandonment(paths, abandoned(1));
    await writeValidationFailedAttempt(paths, validationFailed(2));
    await setTask('READY', 2);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 2,
      profile_id: PROFILE,
      needs_archival: false,
    });
  });

  it('abandonment 1 + validation oficial não arquivada 2 permite archival automático', async () => {
    await writeAttemptAbandonment(paths, abandoned(1));
    await setTask('FAIL', 2);
    await writeOfficialFailCompletion();
    await writeLaunch();

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 2,
      profile_id: PROFILE,
      needs_archival: true,
    });
  });

  it('validation 1 + abandonment 2 + validation arquivada 3 usa somente source 3', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeAttemptAbandonment(paths, abandoned(2));
    await writeValidationFailedAttempt(paths, validationFailed(3));
    await setTask('READY', 3);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 3,
      needs_archival: false,
    });
  });

  it('validation 1 + abandonment 2 + validation oficial não arquivada 3 usa source 3', async () => {
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await writeAttemptAbandonment(paths, abandoned(2));
    await setTask('FAIL', 3);
    await writeOfficialFailCompletion();
    await writeLaunch();

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 3,
      profile_id: PROFILE,
      needs_archival: true,
    });
  });

  it('abandonment 1 + validation 2 + infra 3 mantém source 2 conectado', async () => {
    await writeAttemptAbandonment(paths, abandoned(1));
    await writeValidationFailedAttempt(paths, validationFailed(2));
    await writeInfraFailedAttempt(paths, infraFailed(3));
    await setTask('READY', 3);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 2,
      needs_archival: false,
    });
  });

  it('dois validation FAILs pós-boundary esgotam o repair automático', async () => {
    await writeAttemptAbandonment(paths, abandoned(1));
    await writeValidationFailedAttempt(paths, validationFailed(2));
    await writeInfraFailedAttempt(paths, infraFailed(3));
    await setTask('FAIL', 4);
    await writeOfficialFailCompletion();
    await writeLaunch();

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_EXHAUSTED',
      source_attempt: 2,
      validation_fail_count: 2,
    });
  });

  it('READY com dois validation FAILs pós-boundary mantém a escalada manual', async () => {
    await writeAttemptAbandonment(paths, abandoned(1));
    await writeValidationFailedAttempt(paths, validationFailed(2));
    await writeValidationFailedAttempt(paths, validationFailed(3));
    await setTask('READY', 3);

    expect(await decideAutomaticRepair(paths, TASK)).toEqual({ action: 'NOT_APPLICABLE' });
  });
});

describe('decideAutomaticRepair — rejeição de implementation defect', () => {
  it('autoriza o mesmo bounded repair após um ReviewRejectedAttemptRecord', async () => {
    await writeReviewRejectedAttempt(paths, reviewRejected(1));
    await setTask('READY', 1);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 1,
      profile_id: PROFILE,
      needs_archival: false,
    });
  });

  it('uma rejeição de review mais um FAIL oficial consomem o único repair', async () => {
    await writeReviewRejectedAttempt(paths, reviewRejected(1));
    await writeValidationFailedAttempt(paths, validationFailed(2));
    await setTask('FAIL', 2);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_EXHAUSTED',
      source_attempt: 1,
      validation_fail_count: 2,
    });
  });

  it('duas rejeições de review estruturadas param mesmo com a task já reaberta', async () => {
    await writeReviewRejectedAttempt(paths, reviewRejected(1));
    await writeReviewRejectedAttempt(paths, reviewRejected(2));
    await setTask('READY', 2);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_EXHAUSTED',
      source_attempt: 1,
      validation_fail_count: 2,
    });
  });

  it('sem autorização humana adicional a exhaustion de review continua bloqueada', async () => {
    await writeReviewRejectedAttempt(paths, reviewRejected(1));
    await writeReviewRejectedAttempt(paths, reviewRejected(2));
    await setTask('READY', 2);

    await expect(
      grantAdditionalRepairAuthorization({
        paths,
        taskId: TASK,
        reason: '',
      }),
    ).rejects.toBeInstanceOf(AdditionalRepairAuthorizationError);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_EXHAUSTED',
    });
  });

  it('autorização humana one-shot libera exatamente um repair adicional', async () => {
    await writeReviewRejectedAttempt(paths, reviewRejected(1));
    await writeReviewRejectedAttempt(paths, reviewRejected(2));
    await setTask('READY', 2);

    const granted = await grantAdditionalRepairAuthorization({
      paths,
      taskId: TASK,
      reason: 'defeitos mecânicos de ruff/black; validação oficial passou',
    });

    expect(granted.record.additional_attempts).toBe(1);
    expect(granted.record.task_id).toBe(TASK);
    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      source_attempt: 2,
      profile_id: PROFILE,
      needs_archival: false,
      additional_authorization_sha256: granted.sha256,
    });

    await expect(
      grantAdditionalRepairAuthorization({
        paths,
        taskId: TASK,
        reason: 'não empilha um segundo extra enquanto o primeiro não foi consumido',
      }),
    ).rejects.toBeInstanceOf(AdditionalRepairAuthorizationError);

    await consumeAdditionalRepairAuthorization({
      paths,
      taskId: TASK,
      grantSha256: granted.sha256,
      attempt: 3,
    });

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_EXHAUSTED',
      validation_fail_count: 2,
    });
  });

  it('segunda tentativa extra exige nova decisão humana', async () => {
    await writeReviewRejectedAttempt(paths, reviewRejected(1));
    await writeReviewRejectedAttempt(paths, reviewRejected(2));
    await setTask('READY', 2);

    const first = await grantAdditionalRepairAuthorization({
      paths,
      taskId: TASK,
      reason: 'primeira autorização one-shot',
    });
    await consumeAdditionalRepairAuthorization({
      paths,
      taskId: TASK,
      grantSha256: first.sha256,
      attempt: 3,
    });

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_EXHAUSTED',
    });

    const second = await grantAdditionalRepairAuthorization({
      paths,
      taskId: TASK,
      reason: 'nova decisão humana para um segundo extra',
    });
    expect(second.sha256).not.toBe(first.sha256);
    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'REPAIR_ALLOWED',
      additional_authorization_sha256: second.sha256,
    });
  });

  it('autorização com provenance inválida falha fechada', async () => {
    await writeReviewRejectedAttempt(paths, reviewRejected(1));
    await writeReviewRejectedAttempt(paths, reviewRejected(2));
    await setTask('READY', 2);

    await mkdir(path.join(paths.additionalRepairAuthorizationsDir, TASK), { recursive: true });
    await writeFile(
      path.join(paths.additionalRepairAuthorizationsDir, TASK, 'grant-not-a-record.json'),
      '{not-json',
    );

    await expect(decideAutomaticRepair(paths, TASK)).resolves.toMatchObject({
      action: 'BLOCKED',
      code: 'INVALID_EVIDENCE',
    });
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

  it('Protocol-invalid + Validation no mesmo attempt => BLOCKED', async () => {
    await writeProtocolInvalidAttempt(paths, protocolInvalid(1));
    await writeValidationFailedAttempt(paths, validationFailed(1));
    await setTask('READY', 1);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'BLOCKED',
      code: 'INCONSISTENT_EVIDENCE',
    });
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

  it('gap no segmento atual depois da boundary continua HISTORICAL_GAP', async () => {
    await writeAttemptAbandonment(paths, abandoned(1));
    await writeValidationFailedAttempt(paths, validationFailed(3));
    await setTask('READY', 3);

    expect(await decideAutomaticRepair(paths, TASK)).toMatchObject({
      action: 'BLOCKED',
      code: 'HISTORICAL_GAP',
    });
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
