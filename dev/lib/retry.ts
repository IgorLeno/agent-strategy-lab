import { access, readFile } from 'node:fs/promises';
import { assertAttemptHead } from './base-guard.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { HarnessPaths } from './paths.js';
import { isSameProcessAlive } from './process-identity.js';
import {
  handoffDraftPath,
  readAttemptAbandonment,
  readLaunchRecord,
  reportPath,
  writeAttemptAbandonment,
} from './records.js';
import {
  AttemptAbandonmentRecord,
  AttemptAbandonmentReasonCode,
  AgentCompletionReport,
  DEV_SCHEMA_VERSION,
  parseHandoffDraft,
  type AttemptAbandonmentReasonCode as AttemptAbandonmentReasonCodeType,
  type DevelopmentState,
  type LaunchRecord,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';

export class RetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryError';
  }
}

export interface RetryInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reason: string;
  readonly allowPendingMaintenance?: boolean;
  readonly allowInfraOutput?: boolean;
  readonly reasonCode?: AttemptAbandonmentReasonCodeType;
  readonly now?: () => string;
  /** Teste da fronteira transacional: record existe, state ainda não mudou. */
  readonly afterRecordWritten?: () => Promise<void>;
}

interface InfrastructureOutputEvidence {
  readonly reasonCode: AttemptAbandonmentReasonCodeType;
  readonly reportSha256: string;
  readonly handoffDraftSha256: string;
}

export interface RetryResult {
  readonly record: AttemptAbandonmentRecord;
  readonly state: DevelopmentState;
  readonly alreadyRetried: boolean;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function classifyLaunch(launch: LaunchRecord): AttemptAbandonmentRecord['launch_classification'] {
  if (launch.timed_out) return 'TIMED_OUT';
  if (
    launch.exit_code === null ||
    [125, 126, 127].includes(launch.exit_code) ||
    launch.survivors_remaining.length > 0
  ) {
    return 'INFRA_ERROR';
  }
  return 'FINISHED';
}

async function assertHead(
  input: RetryInput,
  state: DevelopmentState,
  baseSha: string,
): Promise<string> {
  try {
    return await assertAttemptHead({
      repoRoot: input.paths.repoRoot,
      baseSha,
      authorizedHeadSha: state.authorized_head_sha,
      allowPendingMaintenance: input.allowPendingMaintenance === true,
      label: 'retry',
    });
  } catch (error) {
    throw new RetryError(error instanceof Error ? error.message : String(error));
  }
}

function sameRecord(
  existing: AttemptAbandonmentRecord,
  expected: AttemptAbandonmentRecord,
): boolean {
  return canonicalJson(existing) === canonicalJson(expected);
}

async function readInfrastructureOutput(
  input: RetryInput,
): Promise<InfrastructureOutputEvidence | null> {
  const reportFile = reportPath(input.paths, input.taskId);
  const handoffFile = handoffDraftPath(input.paths, input.taskId);
  const reportPresent = await exists(reportFile);
  const handoffPresent = await exists(handoffFile);

  if (!input.allowInfraOutput) {
    if (input.reasonCode !== undefined) {
      throw new RetryError('--reason-code exige --allow-infra-output');
    }
    if (reportPresent) throw new RetryError('AgentCompletionReport presente; retry recusado');
    if (handoffPresent) throw new RetryError('HandoffDraft presente; retry recusado');
    return null;
  }

  if (input.reasonCode === undefined) {
    throw new RetryError('--reason-code é obrigatório com --allow-infra-output');
  }
  const reasonCode = AttemptAbandonmentReasonCode.parse(input.reasonCode);
  if (!reportPresent) throw new RetryError('AgentCompletionReport ausente no output de infraestrutura');
  if (!handoffPresent) throw new RetryError('HandoffDraft ausente no output de infraestrutura');

  const [reportBytes, handoffBytes] = await Promise.all([
    readFile(reportFile),
    readFile(handoffFile),
  ]);
  let report;
  let handoff;
  try {
    report = AgentCompletionReport.parse(JSON.parse(reportBytes.toString('utf8')));
  } catch (error) {
    throw new RetryError(
      `AgentCompletionReport inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    handoff = parseHandoffDraft(JSON.parse(handoffBytes.toString('utf8')));
  } catch (error) {
    throw new RetryError(
      `HandoffDraft inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (report.task_id !== input.taskId) {
    throw new RetryError(`report pertence a outra tarefa: ${report.task_id}`);
  }
  if (handoff.task_id !== input.taskId) {
    throw new RetryError(`handoff draft pertence a outra tarefa: ${handoff.task_id}`);
  }
  if (report.self_reported_result !== 'FAILURE') {
    throw new RetryError('output de infraestrutura exige report FAILURE');
  }
  if (report.candidate_commit !== null) {
    throw new RetryError('report.candidate_commit precisa ser null');
  }

  return {
    reasonCode,
    reportSha256: sha256Hex(reportBytes),
    handoffDraftSha256: sha256Hex(handoffBytes),
  };
}

export async function retryAbandonedAttempt(input: RetryInput): Promise<RetryResult> {
  const reason = input.reason.trim();
  if (reason === '') throw new RetryError('--reason é obrigatório');

  let state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  const existing = await readAttemptAbandonment(input.paths, input.taskId, task.attempts);

  if (task.status === 'READY') {
    const expectedReasonCode = input.allowInfraOutput ? input.reasonCode : undefined;
    if (
      !existing ||
      existing.reason !== reason ||
      existing.reason_code !== expectedReasonCode
    ) {
      throw new RetryError('tarefa READY sem AttemptAbandonmentRecord correspondente');
    }
    return { record: existing, state, alreadyRetried: true };
  }
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING') {
    throw new RetryError('retry exige tarefa RUNNING/FINALIZING');
  }
  if (task.attempts < 1) throw new RetryError('tentativa RUNNING sem número de attempt');
  if (!task.process) throw new RetryError('processo registrado ausente');
  if (await isSameProcessAlive(task.process)) throw new RetryError('processo registrado ainda está vivo');
  if (task.candidate_commit !== null) throw new RetryError('candidate_commit precisa ser null');
  if (task.accepted_commit !== null) throw new RetryError('accepted_commit precisa ser null');
  const otherRunning = state.tasks.find(
    (candidate) => candidate.id !== input.taskId && candidate.status === 'RUNNING',
  );
  if (otherRunning) throw new RetryError(`outra tarefa RUNNING: ${otherRunning.id}`);

  const launch = await readLaunchRecord(input.paths, input.taskId).catch(() => null);
  if (!launch) throw new RetryError('LaunchRecord ausente ou inválido');
  if (launch.finished_at === null) throw new RetryError('LaunchRecord ainda não foi finalizado');
  if (canonicalJson(launch.process) !== canonicalJson(task.process)) {
    throw new RetryError('processo do LaunchRecord diverge do state');
  }

  if (!task.base_sha) throw new RetryError('base_sha ausente na tentativa');

  const infrastructureOutput = await readInfrastructureOutput(input);

  const head = await assertHead(input, state, task.base_sha);
  const abandonedAt = existing?.abandoned_at ?? (input.now ?? (() => new Date().toISOString()))();
  const record = AttemptAbandonmentRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    attempt: task.attempts,
    base_sha: task.base_sha,
    process: task.process,
    launch_classification: classifyLaunch(launch),
    exit_code: launch.exit_code,
    started_at: launch.started_at,
    finished_at: launch.finished_at,
    reason,
    previous_diagnostics: task.diagnostics,
    candidate_commit: null,
    working_tree_clean: true,
    head_sha: head,
    report_present: infrastructureOutput !== null,
    handoff_present: infrastructureOutput !== null,
    reason_code: infrastructureOutput?.reasonCode,
    report_sha256: infrastructureOutput?.reportSha256,
    handoff_draft_sha256: infrastructureOutput?.handoffDraftSha256,
    source_report_result: infrastructureOutput ? 'FAILURE' : undefined,
    source_base_sha: infrastructureOutput ? task.base_sha : undefined,
    abandoned_at: abandonedAt,
  });

  if (existing) {
    if (!sameRecord(existing, record)) {
      throw new RetryError('AttemptAbandonmentRecord existente diverge da solicitação');
    }
  } else {
    await writeAttemptAbandonment(input.paths, record);
    await input.afterRecordWritten?.();
  }

  state = withTaskState(state, input.taskId, {
    status: 'READY',
    phase: null,
    process: null,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics: `attempt ${task.attempts} abandonado: ${reason}`,
    started_at: null,
    finished_at: null,
  });
  await writeState(input.paths, state);
  state = await readState(input.paths);
  return { record, state, alreadyRetried: false };
}
