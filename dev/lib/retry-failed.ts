import { readFile } from 'node:fs/promises';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  preserveFailedAttemptBundle,
  resetFilesToBase,
  type PreservedBundle,
} from './failed-attempt-bundle.js';
import {
  headSha,
  isWorkingTreeClean,
  patchFingerprint,
  stagedFiles,
  workingTreeFiles,
} from './git.js';
import type { HarnessPaths } from './paths.js';
import {
  completionPath,
  handoffDraftPath,
  launchRecordPath,
  readValidationFailedAttempt,
  reportPath,
  sourceBindingPath,
  validationFailedAttemptPath,
  writeValidationFailedAttempt,
} from './records.js';
import { isForbiddenRevalidationPath } from './revalidate.js';
import {
  AgentCompletionReport,
  CompletionRecord,
  DEV_SCHEMA_VERSION,
  LaunchRecord,
  RevalidationSourceBinding,
  ValidationFailedAttemptReasonCode,
  ValidationFailedAttemptRecord,
  parseHandoffDraft,
  type PreviousAttemptDiagnostics,
  type PreviousAttemptFailedValidation,
  type ValidationFailedAttemptRecord as ValidationFailedAttemptRecordType,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';

/**
 * Reparo auditável depois de um FAIL LEGÍTIMO da validation oficial.
 *
 * A distinção que este módulo existe para preservar: o worker reportou SUCCESS
 * e o orquestrador REJEITOU a solução. Isso não é falha de infraestrutura, não
 * é nondeterminismo do gate e não é defeito do harness — reusar qualquer um
 * desses vocabulários apagaria a única evidência de que a solução foi medida e
 * reprovada. Por isso o record é próprio, e o único reason_code inicial é
 * `OFFICIAL_VALIDATION_FAILURE`.
 *
 * Nenhum provider é chamado aqui. O comando arquiva, limpa e devolve a tarefa a
 * READY; lançar o próximo attempt continua sendo do dev-launch.
 */
export class RetryFailedAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryFailedAttemptError';
  }
}

export interface RetryFailedAttemptInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reasonCode: string;
  readonly reason: string;
  readonly now?: () => string;
  /** Ponto de crash injetado pelos testes, entre record e reset. */
  readonly afterRecordWritten?: (record: ValidationFailedAttemptRecordType) => Promise<void>;
}

export interface RetryFailedAttemptResult {
  readonly record: ValidationFailedAttemptRecordType;
  readonly recordPath: string;
  readonly bundle: PreservedBundle | null;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly alreadyArchived: boolean;
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RetryFailedAttemptError(`${label} ausente`);
    }
    throw error;
  }
}

function parseJson<T>(label: string, bytes: Buffer, parse: (input: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new RetryFailedAttemptError(
      `${label} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface FailedSource {
  readonly attempt: number;
  readonly files: string[];
  readonly binding: RevalidationSourceBinding;
  readonly bindingSha256: string;
  readonly completion: CompletionRecord;
  readonly completionSha256: string;
  readonly reportSha256: string;
  readonly handoffSha256: string;
  readonly launch: LaunchRecord;
  readonly launchSha256: string;
  readonly authorizedHead: string;
}

/**
 * Precondições fail-closed. Todas são conferidas antes de qualquer escrita e
 * antes de qualquer efeito no repositório: um único desacordo entre state,
 * records, binding e disco significa que a solução preservada não seria a que
 * foi reprovada, e aí não há reparo auditável nenhum a fazer.
 */
async function loadFailedSource(input: RetryFailedAttemptInput): Promise<FailedSource> {
  const { paths, taskId } = input;
  const state = await readState(paths);
  const task = getTaskState(state, taskId);

  if (task.status !== 'FAIL') {
    throw new RetryFailedAttemptError(
      `dev-retry-failed exige tarefa FAIL, encontrada ${task.status}`,
    );
  }
  if (task.attempts < 1) throw new RetryFailedAttemptError('FAIL sem attempt');
  const otherRunning = state.tasks.find(
    (candidate) => candidate.id !== taskId && candidate.status === 'RUNNING',
  );
  if (otherRunning) {
    throw new RetryFailedAttemptError(`outra tarefa RUNNING: ${otherRunning.id}`);
  }
  if (task.candidate_commit !== null || task.accepted_commit !== null) {
    throw new RetryFailedAttemptError('FAIL não pode ter candidate/accepted commit no state');
  }
  if (state.authorized_head_sha === null) {
    throw new RetryFailedAttemptError('authorized_head_sha ausente');
  }
  const attempt = task.attempts;

  const completionBytes = await readRequired(
    completionPath(paths, taskId),
    'CompletionRecord',
  );
  const completion = parseJson('CompletionRecord', completionBytes, (value) =>
    CompletionRecord.parse(value),
  );
  if (completion.task_id !== taskId) {
    throw new RetryFailedAttemptError(`CompletionRecord pertence a ${completion.task_id}`);
  }
  if (completion.status !== 'FAIL') {
    throw new RetryFailedAttemptError('CompletionRecord não é FAIL');
  }
  if (completion.finalization_mode !== 'normal') {
    throw new RetryFailedAttemptError('CompletionRecord.finalization_mode deve ser normal');
  }
  const evidence = completion.orchestrator_evidence;
  if (evidence.candidate_commit !== null || evidence.accepted_commit !== null) {
    throw new RetryFailedAttemptError('orchestrator evidence candidate/accepted deve ser null');
  }

  const reportBytes = await readRequired(reportPath(paths, taskId), 'AgentCompletionReport');
  const report = parseJson('AgentCompletionReport', reportBytes, (value) =>
    AgentCompletionReport.parse(value),
  );
  const handoffBytes = await readRequired(handoffDraftPath(paths, taskId), 'HandoffDraft');
  const handoff = parseJson('HandoffDraft', handoffBytes, parseHandoffDraft);
  if (report.task_id !== taskId || handoff.task_id !== taskId) {
    throw new RetryFailedAttemptError('evidence do worker pertence a outra tarefa');
  }
  if (report.self_reported_result !== 'SUCCESS') {
    throw new RetryFailedAttemptError(
      'dev-retry-failed exige worker report SUCCESS — FAILURE explícito é dev-retry',
    );
  }
  if (report.candidate_commit !== null) {
    throw new RetryFailedAttemptError('report.candidate_commit deve ser null');
  }
  if (completion.report === null || canonicalJson(completion.report) !== canonicalJson(report)) {
    throw new RetryFailedAttemptError('report atual diverge do report preservado no FAIL');
  }
  if (!evidence.revalidation.some((result) => result.exit_code !== 0 || result.timed_out)) {
    throw new RetryFailedAttemptError('FAIL sem validation oficial malsucedida');
  }

  const bindingBytes = await readRequired(
    sourceBindingPath(paths, taskId, attempt),
    'RevalidationSourceBinding',
  );
  const binding = parseJson('RevalidationSourceBinding', bindingBytes, (value) =>
    RevalidationSourceBinding.parse(value),
  );
  if (binding.task_id !== taskId || binding.attempt !== attempt) {
    throw new RetryFailedAttemptError('source binding pertence a outra task/attempt');
  }
  if (
    binding.original_completion_sha256 !== sha256Hex(completionBytes) ||
    binding.report_sha256 !== sha256Hex(reportBytes) ||
    binding.handoff_draft_sha256 !== sha256Hex(handoffBytes)
  ) {
    throw new RetryFailedAttemptError('source binding não corresponde aos bytes atuais');
  }
  if (binding.source_base_sha !== evidence.base_sha || binding.source_base_sha !== task.base_sha) {
    throw new RetryFailedAttemptError('source_base_sha diverge entre binding, completion e state');
  }

  const files = [...new Set(report.changed_files)].sort();
  if (files.length === 0) throw new RetryFailedAttemptError('report.changed_files vazio');
  if (
    canonicalJson(files) !== canonicalJson(binding.changed_files) ||
    canonicalJson(files) !== canonicalJson([...new Set(evidence.changed_files)].sort())
  ) {
    throw new RetryFailedAttemptError('changed_files diverge entre report, binding e evidence');
  }
  const forbidden = files.find(isForbiddenRevalidationPath);
  if (forbidden) throw new RetryFailedAttemptError(`caminho proibido: ${forbidden}`);

  const launchBytes = await readRequired(launchRecordPath(paths, taskId), 'LaunchRecord');
  const launch = parseJson('LaunchRecord', launchBytes, (value) => LaunchRecord.parse(value));
  if (launch.task_id !== taskId) {
    throw new RetryFailedAttemptError(`LaunchRecord pertence a ${launch.task_id}`);
  }

  const head = await headSha(paths.repoRoot);
  if (head !== state.authorized_head_sha) {
    throw new RetryFailedAttemptError(
      `HEAD ${head} diverge do authorized_head_sha ${state.authorized_head_sha}`,
    );
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new RetryFailedAttemptError('index contém mudanças staged');
  }

  return {
    attempt,
    files,
    binding,
    bindingSha256: sha256Hex(bindingBytes),
    completion,
    completionSha256: sha256Hex(completionBytes),
    reportSha256: sha256Hex(reportBytes),
    handoffSha256: sha256Hex(handoffBytes),
    launch,
    launchSha256: sha256Hex(launchBytes),
    authorizedHead: state.authorized_head_sha,
  };
}

/** A working tree tem que ser EXATAMENTE o patch reprovado, byte a byte. */
async function assertPatchOnDisk(
  paths: HarnessPaths,
  source: FailedSource,
): Promise<string> {
  const actual = await workingTreeFiles(paths.repoRoot);
  if (canonicalJson(actual) !== canonicalJson(source.files)) {
    throw new RetryFailedAttemptError(
      `working tree diverge do report: real [${actual.join(', ')}], report [${source.files.join(', ')}]`,
    );
  }
  const fingerprint = await patchFingerprint(paths.repoRoot);
  if (fingerprint !== source.binding.derived_patch_fingerprint) {
    throw new RetryFailedAttemptError('patch fingerprint diverge do source binding');
  }
  return fingerprint;
}

function buildRecord(
  input: RetryFailedAttemptInput,
  source: FailedSource,
  bundle: PreservedBundle,
  reasonCode: string,
  timestamp: string,
): ValidationFailedAttemptRecordType {
  const evidence = source.completion.orchestrator_evidence;
  return ValidationFailedAttemptRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    attempt: source.attempt,
    source_base_sha: source.binding.source_base_sha,
    profile_id: source.launch.profile_id,
    worker_self_reported_result: 'SUCCESS',
    report_candidate_commit: null,
    orchestrator_verdict: 'REJECTED_BY_OFFICIAL_VALIDATION',
    finalization_mode: 'normal',
    launch_record_sha256: source.launchSha256,
    original_completion_sha256: source.completionSha256,
    report_sha256: source.reportSha256,
    handoff_draft_sha256: source.handoffSha256,
    source_binding_sha256: source.bindingSha256,
    patch_fingerprint: source.binding.derived_patch_fingerprint,
    changed_files: source.files,
    original_validation_results: evidence.revalidation,
    ...(evidence.validation_evidence === undefined
      ? {}
      : { original_validation_evidence: evidence.validation_evidence }),
    change_bundle: bundle.ref,
    reason_code: reasonCode,
    reason: input.reason,
    archived_at: timestamp,
  });
}

function assertMatchesRequest(
  record: ValidationFailedAttemptRecordType,
  source: FailedSource,
  reasonCode: string,
  reason: string,
): void {
  if (
    record.task_id !== source.binding.task_id ||
    record.attempt !== source.attempt ||
    record.source_base_sha !== source.binding.source_base_sha ||
    record.source_binding_sha256 !== source.bindingSha256 ||
    record.original_completion_sha256 !== source.completionSha256 ||
    record.report_sha256 !== source.reportSha256 ||
    record.handoff_draft_sha256 !== source.handoffSha256 ||
    record.patch_fingerprint !== source.binding.derived_patch_fingerprint ||
    canonicalJson(record.changed_files) !== canonicalJson(source.files)
  ) {
    throw new RetryFailedAttemptError('ValidationFailedAttemptRecord já gravado diverge da source');
  }
  if (record.reason_code !== reasonCode || record.reason !== reason) {
    throw new RetryFailedAttemptError(
      'ValidationFailedAttemptRecord já gravado diverge do reason solicitado',
    );
  }
}

/** Reabre a tarefa para um NOVO attempt. `attempts` nunca diminui. */
async function reopenTask(
  paths: HarnessPaths,
  taskId: string,
  record: ValidationFailedAttemptRecordType,
): Promise<void> {
  const state = await readState(paths);
  const task = getTaskState(state, taskId);
  if (task.status === 'READY') return;
  if (task.status !== 'FAIL') {
    throw new RetryFailedAttemptError(`tarefa mudou para ${task.status} durante o reparo`);
  }
  if (task.attempts < record.attempt) {
    throw new RetryFailedAttemptError('attempts regrediu durante o reparo');
  }
  await writeState(
    paths,
    withTaskState(state, taskId, {
      status: 'READY',
      phase: null,
      process: null,
      candidate_commit: null,
      accepted_commit: null,
      diagnostics: `attempt ${record.attempt} arquivado (${record.reason_code}) — aguardando novo attempt`,
      finished_at: null,
    }),
  );
}

export async function retryFailedAttempt(
  input: RetryFailedAttemptInput,
): Promise<RetryFailedAttemptResult> {
  const reasonCode = ValidationFailedAttemptReasonCode.parse(input.reasonCode);
  if (input.reason.trim() === '') throw new RetryFailedAttemptError('--reason é obrigatório');
  const { paths, taskId } = input;
  const now = input.now ?? (() => new Date().toISOString());

  const source = await loadFailedSource(input);
  const archived = await readValidationFailedAttempt(paths, taskId, source.attempt);
  if (archived) assertMatchesRequest(archived, source, reasonCode, input.reason);

  // Retomada idempotente: se o crash foi DEPOIS do reset, não há patch em disco
  // para preservar de novo — o record já publicado é a evidência, e o que falta
  // é apenas a transição de state.
  const treeClean = await isWorkingTreeClean(paths.repoRoot);
  if (archived && treeClean) {
    await reopenTask(paths, taskId, archived);
    return {
      record: archived,
      recordPath: validationFailedAttemptPath(paths, taskId, source.attempt),
      bundle: null,
      restored: [],
      removed: [],
      alreadyArchived: true,
    };
  }

  const fingerprint = await assertPatchOnDisk(paths, source);
  const bundle = await preserveFailedAttemptBundle({
    paths,
    taskId,
    attempt: source.attempt,
    baseSha: source.authorizedHead,
    files: source.files,
    patchFingerprint: fingerprint,
    now,
  });

  const record = archived ?? buildRecord(input, source, bundle, reasonCode, now());
  if (!archived) await writeValidationFailedAttempt(paths, record);
  await input.afterRecordWritten?.(record);

  // Só depois de todo artifact append-only estar publicado o patch some do disco.
  const reset = await resetFilesToBase({
    repoRoot: paths.repoRoot,
    baseSha: source.authorizedHead,
    files: source.files,
  });
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    throw new RetryFailedAttemptError('working tree não ficou limpa após o reset');
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new RetryFailedAttemptError('index não ficou limpo após o reset');
  }
  if ((await headSha(paths.repoRoot)) !== source.authorizedHead) {
    throw new RetryFailedAttemptError('HEAD mudou durante o reset');
  }

  await reopenTask(paths, taskId, record);
  return {
    record,
    recordPath: validationFailedAttemptPath(paths, taskId, source.attempt),
    bundle,
    restored: reset.restored,
    removed: reset.removed,
    alreadyArchived: archived !== null,
  };
}

// ---------------------------------------------------------------------------
// Feedback para o attempt de reparo
// ---------------------------------------------------------------------------

/**
 * O que o próximo worker recebe sobre o attempt anterior: SOMENTE fatos que o
 * orquestrador derivou de records selados. Nada de transcript, raciocínio,
 * sumário do worker ou conversa do provider — a limpeza de contexto entre
 * sessões continua sendo a garantia central do protocolo, e o packet segue
 * sendo o único canal de entrada.
 *
 * Determinístico: mesmo record sempre produz os mesmos bytes.
 */
export function previousAttemptDiagnosticsFrom(
  record: ValidationFailedAttemptRecordType,
): PreviousAttemptDiagnostics {
  const evidence = record.original_validation_evidence ?? [];
  const failed: PreviousAttemptFailedValidation[] = [];
  for (let index = 0; index < record.original_validation_results.length; index += 1) {
    const result = record.original_validation_results[index];
    if (!result || (result.exit_code === 0 && !result.timed_out)) continue;
    const logs = evidence[index];
    const matches = logs !== undefined && canonicalJson(logs.argv) === canonicalJson(result.argv);
    failed.push({
      argv: [...result.argv],
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      ...(matches ? { stdout_path: logs.stdout_path, stderr_path: logs.stderr_path } : {}),
    });
  }
  return {
    attempt: record.attempt,
    profile_id: record.profile_id,
    worker_self_reported_result: 'SUCCESS',
    reason_code: record.reason_code,
    reason: record.reason,
    failed_validations: failed,
    changed_files: [...record.changed_files],
    validation_logs_dir: `validation-logs/${record.task_id}/attempt-${record.attempt}`,
  };
}

/**
 * Diagnóstico do attempt imediatamente anterior, quando ele foi arquivado por
 * este comando. Ausente em qualquer outro caminho — inclusive no attempt 1.
 */
export async function readPreviousAttemptDiagnostics(
  paths: HarnessPaths,
  taskId: string,
  attempts: number,
): Promise<PreviousAttemptDiagnostics | null> {
  if (attempts < 1) return null;
  const record = await readValidationFailedAttempt(paths, taskId, attempts);
  return record === null ? null : previousAttemptDiagnosticsFrom(record);
}
