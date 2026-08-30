import { readFile, rm } from 'node:fs/promises';
import { writeFileOnce } from './atomic.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  finalizationFingerprint,
  lookupCandidateReview,
} from './candidate-review.js';
import {
  preserveFailedAttemptBundle,
  resetFilesToBase,
  type PreservedBundle,
} from './failed-attempt-bundle.js';
import {
  FailedAttemptSourceError,
  materializeFailedAttemptSource,
} from './failed-attempt-source.js';
import {
  headSha,
  gitOrThrow,
  isWorkingTreeClean,
  parentSha,
  patchFingerprint,
  stagedFiles,
  workingTreeFiles,
} from './git.js';
import {
  InboxArtifactError,
  archiveInboxArtifacts,
  readArchivedInboxArtifacts,
  readCurrentInboxArtifacts,
  releaseCurrentInboxArtifacts,
  type InboxArtifactPair,
  type InboxReleaseHooks,
} from './inbox-artifacts.js';
import type { HarnessPaths } from './paths.js';
import {
  completionPath,
  failedAttemptCompletionPath,
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  launchRecordPath,
  readInfraFailedAttempt,
  readAttemptAbandonment,
  readProtocolInvalidAttempt,
  readReviewRejectedAttempt,
  readReviewRejectionClassification,
  readOrchestratedFinalization,
  readValidationFailedAttempt,
  reviewRejectedAttemptPath,
  sourceBindingPath,
  validationFailedAttemptPath,
  writeValidationFailedAttempt,
  writeReviewRejectedAttempt,
} from './records.js';
import { isForbiddenRevalidationPath } from './revalidate.js';
import {
  AgentCompletionReport,
  CompletionRecord,
  DEV_SCHEMA_VERSION,
  LaunchRecord,
  RevalidationSourceBinding,
  ReviewRejectedAttemptRecord,
  ValidationFailedAttemptReasonCode,
  ValidationFailedAttemptRecord,
  parseHandoffDraft,
  type PreviousAttemptDiagnostics,
  type PreviousAttemptFailedValidation,
  type ValidationFailedAttemptRecord as ValidationFailedAttemptRecordType,
  type ReviewRejectedAttemptRecord as ReviewRejectedAttemptRecordType,
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
 *
 * Arquivar inclui os bytes do CompletionRecord FAIL: o slot corrente
 * (`.dev/completions/<task>.completion.json`) é do fechamento MAIS RECENTE, e um
 * FAIL histórico esquecido lá faz a selagem do attempt seguinte bater em
 * "CompletionRecord existente diverge do finalization record".
 */
export class RetryFailedAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryFailedAttemptError';
  }
}

/**
 * O mesmo attempt não pode ser, ao mesmo tempo, um FAIL de validation e um
 * INFRA_ERROR. Escolher um silenciosamente apagaria a outra evidência.
 */
export class InconsistentAttemptEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InconsistentAttemptEvidenceError';
  }
}

export interface RetryFailedAttemptInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reasonCode: string;
  readonly reason: string;
  readonly now?: () => string;
  /** Ponto de crash injetado pelos testes, entre record e archive do completion. */
  readonly afterRecordWritten?: (record: ValidationFailedAttemptRecordType) => Promise<void>;
  /** Ponto de crash injetado pelos testes, entre archive do completion e do inbox. */
  readonly afterCompletionArchived?: (record: ValidationFailedAttemptRecordType) => Promise<void>;
  /** Ponto de crash injetado pelos testes, entre archive do inbox e a liberação. */
  readonly afterInboxArchived?: (record: ValidationFailedAttemptRecordType) => Promise<void>;
  /** Hooks da liberação do inbox — fronteira entre os dois `rm` dos slots. */
  readonly inboxReleaseHooks?: InboxReleaseHooks;
  /** Ponto de crash injetado pelos testes, entre liberação dos slots e reset. */
  readonly afterCompletionReleased?: (record: ValidationFailedAttemptRecordType) => Promise<void>;
  /** Ponto de crash injetado pelos testes, entre o reset e a volta a READY. */
  readonly afterPatchReset?: (record: ValidationFailedAttemptRecordType) => Promise<void>;
}

export interface RetryFailedAttemptResult {
  readonly record: ValidationFailedAttemptRecordType;
  readonly recordPath: string;
  readonly bundle: PreservedBundle | null;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly alreadyArchived: boolean;
  /** Onde os bytes do CompletionRecord FAIL ficaram preservados. */
  readonly completionArchivePath: string;
  /** Onde os bytes do output do worker deste attempt ficaram preservados. */
  /** `null` quando o attempt não tinha nota do worker para preservar. */
  readonly reportArchivePath: string | null;
  readonly handoffArchivePath: string | null;
  /** `true` quando esta execução foi a que removeu o slot corrente. */
  readonly releasedCurrentCompletion: boolean;
  /** `true` quando esta execução foi a que liberou os slots do inbox. */
  readonly releasedCurrentInbox: boolean;
  /**
   * `true` quando o source binding não existia e foi derivado agora, por
   * compatibilidade com um FAIL anterior à selagem automática.
   */
  readonly bindingRecovered: boolean;
}

export interface RetryReviewRejectedAttemptInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reason: string;
  readonly now?: () => string;
  readonly inboxReleaseHooks?: InboxReleaseHooks;
  readonly afterRecordWritten?: (record: ReviewRejectedAttemptRecordType) => Promise<void>;
  readonly afterHeadMoved?: (record: ReviewRejectedAttemptRecordType) => Promise<void>;
  readonly afterPatchReset?: (record: ReviewRejectedAttemptRecordType) => Promise<void>;
}

export interface RetryReviewRejectedAttemptResult {
  readonly record: ReviewRejectedAttemptRecordType;
  readonly recordPath: string;
  readonly bundle: PreservedBundle | null;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly alreadyArchived: boolean;
  readonly reportArchivePath: string;
  readonly handoffArchivePath: string;
  readonly releasedCurrentInbox: boolean;
}

/** Nota do worker malformada vira `null`, do mesmo jeito que nota ausente. */
function tryParseNote<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  const bytes = await readIfPresent(file);
  if (bytes === null) throw new RetryFailedAttemptError(`${label} ausente`);
  return bytes;
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
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
  /** `true` quando esta execução derivou o binding de um FAIL legado. */
  readonly bindingRecovered: boolean;
  readonly completion: CompletionRecord;
  readonly completionBytes: Buffer;
  readonly completionSha256: string;
  /** Record já publicado deste attempt — presente só em retomada. */
  readonly archived: ValidationFailedAttemptRecordType | null;
  readonly inboxBytes: InboxArtifactPair | null;
  readonly reportSha256: string | null;
  readonly handoffSha256: string | null;
  readonly launch: LaunchRecord;
  readonly launchSha256: string;
  readonly authorizedHead: string;
}

/**
 * Os bytes do FAIL vêm do slot corrente enquanto ele existir. Depois que o
 * archival publicou a evidência e liberou o slot, a fonte passa a ser o archive
 * append-only do próprio attempt — é o que permite que uma retomada depois de
 * crash não dependa de um arquivo que o fluxo já removeu de propósito.
 */
async function loadCompletionEvidence(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  archived: ValidationFailedAttemptRecordType | null,
): Promise<Buffer> {
  const current = await readIfPresent(completionPath(paths, taskId));
  if (current !== null) return current;
  if (archived === null) throw new RetryFailedAttemptError('CompletionRecord ausente');

  const bytes = await readRequired(
    failedAttemptCompletionPath(paths, taskId, attempt),
    'CompletionRecord arquivado',
  );
  if (sha256Hex(bytes) !== archived.original_completion_sha256) {
    throw new RetryFailedAttemptError(
      'completion.fail.json diverge de original_completion_sha256 do attempt arquivado',
    );
  }
  return bytes;
}

/**
 * O output do worker vem dos slots correntes do inbox enquanto eles existirem.
 * Depois que o archival preservou os bytes no diretório do attempt e liberou os
 * slots, a fonte passa a ser esse archive — pelo mesmo motivo do CompletionRecord:
 * uma retomada depois de crash não pode depender de arquivos que o próprio fluxo
 * removeu de propósito.
 *
 * Um slot corrente que sobreviveu sozinho só é aceito se for byte-idêntico ao
 * que já está arquivado; qualquer divergência é output de OUTRO attempt no
 * caminho compartilhado, que é exatamente o defeito que este módulo isola.
 */
async function loadInboxEvidence(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  archived: ValidationFailedAttemptRecordType | null,
): Promise<InboxArtifactPair | null> {
  const current = await readCurrentInboxArtifacts(paths, taskId);
  if (current.report !== null && current.handoff !== null) {
    return { report: current.report, handoff: current.handoff };
  }
  // Nota que NUNCA existiu não tem o que preservar. Isso não impede o repair:
  // o patch reprovado, o binding e a validação oficial continuam no disco.
  if (archived === null) return null;
  if (archived.report_sha256 === undefined || archived.handoff_draft_sha256 === undefined) {
    return null;
  }

  const expected = {
    reportSha256: archived.report_sha256,
    handoffDraftSha256: archived.handoff_draft_sha256,
  };
  let preserved: InboxArtifactPair | null;
  try {
    preserved = await readArchivedInboxArtifacts(paths, taskId, attempt, expected);
  } catch (error) {
    if (error instanceof InboxArtifactError) throw new RetryFailedAttemptError(error.message);
    throw error;
  }
  if (preserved === null) {
    throw new RetryFailedAttemptError(
      'output do worker ausente no inbox e não preservado no attempt arquivado',
    );
  }
  if (current.report !== null && !current.report.equals(preserved.report)) {
    throw new RetryFailedAttemptError('report.json corrente diverge do archive deste attempt');
  }
  if (current.handoff !== null && !current.handoff.equals(preserved.handoff)) {
    throw new RetryFailedAttemptError(
      'handoff-draft.json corrente diverge do archive deste attempt',
    );
  }
  return preserved;
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

  if (task.attempts < 1) throw new RetryFailedAttemptError('FAIL sem attempt');
  const attempt = task.attempts;
  const archived = await readValidationFailedAttempt(paths, taskId, attempt);

  // A guarda de uma operação NOVA continua sendo FAIL. READY só é aceito como
  // RETOMADA: o record append-only deste mesmo attempt já está publicado, e o
  // que resta é convergir os efeitos que faltaram depois dele.
  if (task.status !== 'FAIL' && !(task.status === 'READY' && archived !== null)) {
    throw new RetryFailedAttemptError(
      `dev-retry-failed exige tarefa FAIL, encontrada ${task.status}`,
    );
  }
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

  const completionBytes = await loadCompletionEvidence(paths, taskId, attempt, archived);
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

  // A NOTA do worker é auxiliar aqui também. O repair existe para consertar um
  // problema TÉCNICO num patch real e reprovado; nota ausente ou malformada não
  // é motivo para negar reparo a um attempt que o Git e o validador oficial já
  // descrevem por inteiro.
  const inboxBytes = await loadInboxEvidence(paths, taskId, attempt, archived);
  const reportBytes = inboxBytes?.report ?? null;
  const handoffBytes = inboxBytes?.handoff ?? null;
  const report =
    reportBytes === null
      ? null
      : tryParseNote(() => AgentCompletionReport.parse(JSON.parse(reportBytes.toString('utf8'))));
  const handoff =
    handoffBytes === null
      ? null
      : tryParseNote(() => parseHandoffDraft(JSON.parse(handoffBytes.toString('utf8'))));
  if (report !== null && report.task_id !== taskId) {
    throw new RetryFailedAttemptError('evidence do worker pertence a outra tarefa');
  }
  if (handoff !== null && handoff.task_id !== taskId) {
    throw new RetryFailedAttemptError('evidence do worker pertence a outra tarefa');
  }
  // FAILURE DECLARADO continua tendo caminho próprio (dev-retry). Nota ausente
  // não é FAILURE declarado.
  if (report !== null && report.self_reported_result !== 'SUCCESS') {
    throw new RetryFailedAttemptError(
      'dev-retry-failed exige worker report SUCCESS — FAILURE explícito é dev-retry',
    );
  }
  if (
    report !== null &&
    completion.report !== null &&
    canonicalJson(completion.report) !== canonicalJson(report)
  ) {
    throw new RetryFailedAttemptError('report atual diverge do report preservado no FAIL');
  }
  if (!evidence.revalidation.some((result) => result.exit_code !== 0 || result.timed_out)) {
    throw new RetryFailedAttemptError('FAIL sem validation oficial malsucedida');
  }

  const launchBytes = await readRequired(launchRecordPath(paths, taskId), 'LaunchRecord');
  const launch = parseJson('LaunchRecord', launchBytes, (value) => LaunchRecord.parse(value));
  if (launch.task_id !== taskId) {
    throw new RetryFailedAttemptError(`LaunchRecord pertence a ${launch.task_id}`);
  }

  // Repositório antes do binding: derivar a fonte de um FAIL legado ESCREVE
  // evidência, e escrever evidência a partir de um repositório que já não é o
  // do FAIL seria selar o patch errado.
  const head = await headSha(paths.repoRoot);
  if (head !== state.authorized_head_sha) {
    throw new RetryFailedAttemptError(
      `HEAD ${head} diverge do authorized_head_sha ${state.authorized_head_sha}`,
    );
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new RetryFailedAttemptError('index contém mudanças staged');
  }

  // FAIL LEGADO: antes de o finalization selar a fonte no instante do FAIL, um
  // attempt reprovado terminava sem binding e ficava impossível de arquivar —
  // era o beco sem saída do M39B. O binding pode ser DERIVADO agora, porque
  // toda a evidência necessária continua no disco e é conferida acima; o que
  // não pode é ser inventado. Por isso a derivação passa pelo mesmo helper
  // fail-closed do caminho normal, e a proveniência registra que ela aconteceu
  // na recuperação, não no FAIL original.
  const bindingFile = sourceBindingPath(paths, taskId, attempt);
  let bindingBytes = await readIfPresent(bindingFile);
  const bindingRecovered = bindingBytes === null;
  if (bindingBytes === null) {
    if (task.base_sha === null) throw new RetryFailedAttemptError('FAIL sem base_sha no state');
    try {
      await materializeFailedAttemptSource({
        paths,
        taskId,
        attempt,
        completionBytes,
        stateBaseSha: task.base_sha,
        // O patch legado continua no disco, mas o authorized head pode ter
        // avançado desde o FAIL — uma manutenção adotada para consertar o
        // próprio harness, por exemplo. A observação honesta é contra o head
        // atual, que é a referência real da working tree; `source_base_sha`
        // segue registrando a base do attempt.
        expectedHeadSha: state.authorized_head_sha,
        provenance: 'derived_during_failed_attempt_recovery',
        now: input.now ?? (() => new Date().toISOString()),
      });
    } catch (error) {
      if (error instanceof FailedAttemptSourceError) {
        throw new RetryFailedAttemptError(
          `RevalidationSourceBinding ausente e não derivável: ${error.message}`,
        );
      }
      throw error;
    }
    bindingBytes = await readRequired(bindingFile, 'RevalidationSourceBinding');
  }
  const binding = parseJson('RevalidationSourceBinding', bindingBytes, (value) =>
    RevalidationSourceBinding.parse(value),
  );
  if (binding.task_id !== taskId || binding.attempt !== attempt) {
    throw new RetryFailedAttemptError('source binding pertence a outra task/attempt');
  }
  if (binding.original_completion_sha256 !== sha256Hex(completionBytes)) {
    throw new RetryFailedAttemptError('source binding não corresponde aos bytes atuais');
  }
  // Hash da nota é conferido SÓ quando o binding o declara e a nota existe.
  // Ausente dos dois lados é UNKNOWN coerente; presente nos dois tem que bater.
  if (
    (binding.report_sha256 !== undefined &&
      binding.report_sha256 !== (reportBytes === null ? undefined : sha256Hex(reportBytes))) ||
    (binding.handoff_draft_sha256 !== undefined &&
      binding.handoff_draft_sha256 !== (handoffBytes === null ? undefined : sha256Hex(handoffBytes)))
  ) {
    throw new RetryFailedAttemptError('source binding não corresponde aos bytes atuais');
  }
  if (binding.source_base_sha !== evidence.base_sha || binding.source_base_sha !== task.base_sha) {
    throw new RetryFailedAttemptError('source_base_sha diverge entre binding, completion e state');
  }

  // AUTORIDADE: material derivado do Git pelo orquestrador no fechamento, e
  // selado no binding. A declaração do worker não participa.
  const files = [...new Set(evidence.changed_files)].sort();
  if (files.length === 0) {
    throw new RetryFailedAttemptError('orchestrator evidence sem changed_files');
  }
  if (canonicalJson(files) !== canonicalJson(binding.changed_files)) {
    throw new RetryFailedAttemptError('changed_files diverge entre binding e evidence');
  }
  const forbidden = files.find(isForbiddenRevalidationPath);
  if (forbidden) throw new RetryFailedAttemptError(`caminho proibido: ${forbidden}`);

  return {
    attempt,
    files,
    binding,
    bindingSha256: sha256Hex(bindingBytes),
    bindingRecovered,
    completion,
    completionBytes,
    completionSha256: sha256Hex(completionBytes),
    archived,
    inboxBytes,
    reportSha256: reportBytes === null ? null : sha256Hex(reportBytes),
    handoffSha256: handoffBytes === null ? null : sha256Hex(handoffBytes),
    launch,
    launchSha256: sha256Hex(launchBytes),
    authorizedHead: state.authorized_head_sha,
  };
}

/**
 * Libera o slot corrente da nota do worker — quando existe nota a liberar.
 * Attempt sem nota não tem slot ocupado, então não há o que liberar nem o que
 * conferir; devolver "nada liberado" é o fato honesto.
 */
async function releaseCurrentInboxNote(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  reportSha256: string | undefined,
  handoffDraftSha256: string | undefined,
  hooks: RetryFailedAttemptInput['inboxReleaseHooks'],
): Promise<{ readonly report: boolean; readonly handoff: boolean }> {
  if (reportSha256 === undefined || handoffDraftSha256 === undefined) {
    return { report: false, handoff: false };
  }
  return releaseCurrentInboxArtifacts(
    paths,
    taskId,
    { attempt, hashes: { reportSha256, handoffDraftSha256 } },
    hooks,
  );
}

/** A working tree tem que ser EXATAMENTE o patch reprovado, byte a byte. */
async function assertPatchOnDisk(
  paths: HarnessPaths,
  source: FailedSource,
): Promise<string> {
  const actual = await workingTreeFiles(paths.repoRoot);
  if (canonicalJson(actual) !== canonicalJson(source.files)) {
    throw new RetryFailedAttemptError(
      `working tree diverge do material preservado: real [${actual.join(', ')}], ` +
        `preservado [${source.files.join(', ')}]`,
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

/**
 * Preserva os bytes exatos do CompletionRecord FAIL dentro do attempt e confere
 * o binding criptográfico contra `original_completion_sha256` — o record é o
 * único source of truth desse hash. Append-only: republicar com os mesmos bytes
 * é aceito, com bytes diferentes é recusado.
 */
async function archiveFailedCompletion(
  paths: HarnessPaths,
  source: FailedSource,
  record: ValidationFailedAttemptRecordType,
): Promise<string> {
  const file = failedAttemptCompletionPath(paths, record.task_id, record.attempt);
  try {
    await writeFileOnce(file, source.completionBytes);
  } catch (error) {
    throw new RetryFailedAttemptError(
      `archive do CompletionRecord FAIL diverge do já publicado: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const published = await readRequired(file, 'CompletionRecord arquivado');
  if (sha256Hex(published) !== record.original_completion_sha256) {
    throw new RetryFailedAttemptError(
      'completion.fail.json publicado diverge de original_completion_sha256',
    );
  }
  return file;
}

/**
 * Preserva os bytes exatos do output do worker deste attempt e confere o
 * binding criptográfico contra os hashes do record — a mesma disciplina do
 * CompletionRecord, pelo mesmo motivo: os caminhos correntes do inbox são do
 * attempt MAIS RECENTE, e o que ficar lá depois do archival seria lido como
 * output do próximo attempt.
 */
async function archiveInboxEvidence(
  paths: HarnessPaths,
  source: FailedSource,
  record: ValidationFailedAttemptRecordType,
): Promise<{ readonly reportPath: string; readonly handoffPath: string } | null> {
  if (
    source.inboxBytes === null ||
    record.report_sha256 === undefined ||
    record.handoff_draft_sha256 === undefined
  ) {
    return null;
  }
  try {
    const archived = await archiveInboxArtifacts({
      paths,
      taskId: record.task_id,
      attempt: record.attempt,
      bytes: source.inboxBytes,
      expected: {
        reportSha256: record.report_sha256,
        handoffDraftSha256: record.handoff_draft_sha256,
      },
    });
    return { reportPath: archived.reportPath, handoffPath: archived.handoffPath };
  } catch (error) {
    if (error instanceof InboxArtifactError) throw new RetryFailedAttemptError(error.message);
    throw error;
  }
}

/**
 * Libera o slot do fechamento corrente para que o PRÓXIMO attempt escreva o
 * CompletionRecord dele. Só é chamado depois que bundle, record e archive já
 * estão publicados e conferidos: até lá, o FAIL corrente é a única cópia.
 *
 * Remove exatamente este arquivo — nenhum outro completion é tocado.
 */
async function releaseCurrentCompletion(paths: HarnessPaths, taskId: string): Promise<boolean> {
  const file = completionPath(paths, taskId);
  const existed = (await readIfPresent(file)) !== null;
  await rm(file, { force: true });
  return existed;
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
  const archived = source.archived;
  if (archived) assertMatchesRequest(archived, source, reasonCode, input.reason);

  // Retomada idempotente: se o crash foi DEPOIS do reset, não há patch em disco
  // para preservar de novo — o record já publicado é a evidência, e o que falta
  // é apenas convergir archive, slot corrente e state.
  const treeClean = await isWorkingTreeClean(paths.repoRoot);
  if (archived && treeClean) {
    const completionArchivePath = await archiveFailedCompletion(paths, source, archived);
    const inboxArchive = await archiveInboxEvidence(paths, source, archived);
    const releasedCurrentCompletion = await releaseCurrentCompletion(paths, taskId);
    const releasedInbox = await releaseCurrentInboxNote(
      paths,
      taskId,
      archived.attempt,
      archived.report_sha256,
      archived.handoff_draft_sha256,
      input.inboxReleaseHooks,
    );
    await reopenTask(paths, taskId, archived);
    return {
      record: archived,
      recordPath: validationFailedAttemptPath(paths, taskId, source.attempt),
      bundle: null,
      restored: [],
      removed: [],
      alreadyArchived: true,
      completionArchivePath,
      reportArchivePath: inboxArchive?.reportPath ?? null,
      handoffArchivePath: inboxArchive?.handoffPath ?? null,
      releasedCurrentCompletion,
      releasedCurrentInbox: releasedInbox.report || releasedInbox.handoff,
      bindingRecovered: source.bindingRecovered,
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

  const completionArchivePath = await archiveFailedCompletion(paths, source, record);
  await input.afterCompletionArchived?.(record);

  const inboxArchive = await archiveInboxEvidence(paths, source, record);
  await input.afterInboxArchived?.(record);

  // Bundle, record e os três archives publicados e conferidos: agora — e só
  // agora — os slots correntes podem ser liberados para o próximo attempt.
  const releasedCurrentCompletion = await releaseCurrentCompletion(paths, taskId);
  const releasedInbox = await releaseCurrentInboxNote(
    paths,
    taskId,
    record.attempt,
    record.report_sha256,
    record.handoff_draft_sha256,
    input.inboxReleaseHooks,
  );
  await input.afterCompletionReleased?.(record);

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
  await input.afterPatchReset?.(record);

  await reopenTask(paths, taskId, record);
  return {
    record,
    recordPath: validationFailedAttemptPath(paths, taskId, source.attempt),
    bundle,
    restored: reset.restored,
    removed: reset.removed,
    alreadyArchived: archived !== null,
    completionArchivePath,
    reportArchivePath: inboxArchive?.reportPath ?? null,
    handoffArchivePath: inboxArchive?.handoffPath ?? null,
    releasedCurrentCompletion,
    releasedCurrentInbox: releasedInbox.report || releasedInbox.handoff,
    bindingRecovered: source.bindingRecovered,
  };
}

function canonicalFingerprint(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJson(value), 'utf8'));
}

/**
 * Arquiva um candidate validado e REJEITADO por review como fonte do mesmo
 * bounded-repair lifecycle. Não fabrica CompletionRecord FAIL: validation
 * continua PASS, review continua REJECT e ambos ficam ligados no record.
 */
export async function retryReviewRejectedAttempt(
  input: RetryReviewRejectedAttemptInput,
): Promise<RetryReviewRejectedAttemptResult> {
  if (input.reason.trim() === '') throw new RetryFailedAttemptError('reason é obrigatório');
  const { paths, taskId } = input;
  const now = input.now ?? (() => new Date().toISOString());
  const state = await readState(paths);
  const task = getTaskState(state, taskId);
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING' || task.attempts < 1) {
    throw new RetryFailedAttemptError(
      `review repair exige RUNNING/FINALIZING com attempt, encontrado ${task.status}/${task.phase ?? 'null'}`,
    );
  }
  if (task.base_sha === null || state.authorized_head_sha === null) {
    throw new RetryFailedAttemptError('base_sha/authorized_head_sha ausente');
  }
  if (task.base_sha !== state.authorized_head_sha) {
    throw new RetryFailedAttemptError('base_sha diverge do authorized_head_sha');
  }
  if (task.accepted_commit !== null) {
    throw new RetryFailedAttemptError('candidate rejeitado não pode ter accepted_commit');
  }
  const otherRunning = state.tasks.find(
    (candidate) => candidate.id !== taskId && candidate.status === 'RUNNING',
  );
  if (otherRunning !== undefined) {
    throw new RetryFailedAttemptError(`outra tarefa RUNNING: ${otherRunning.id}`);
  }

  const attempt = task.attempts;
  const finalization = await readOrchestratedFinalization(paths, taskId, attempt);
  if (finalization === null) throw new RetryFailedAttemptError('finalization do candidate ausente');
  if (
    finalization.task_id !== taskId ||
    finalization.attempt !== attempt ||
    finalization.base_sha !== task.base_sha
  ) {
    throw new RetryFailedAttemptError('finalization diverge de task/attempt/base');
  }
  if (
    finalization.validation_results.some(
      (result) => result.exit_code !== 0 || result.timed_out,
    )
  ) {
    throw new RetryFailedAttemptError('review repair exige validation oficial PASS');
  }
  const lookup = await lookupCandidateReview(paths, finalization);
  if (lookup.status !== 'REJECTED' || lookup.record === null) {
    throw new RetryFailedAttemptError(`candidate não tem REJECT durável válido: ${lookup.status}`);
  }
  const review = lookup.record;

  let disposition = review.rejection_disposition;
  let classificationFingerprint: string;
  if (disposition === undefined) {
    const classification = await readReviewRejectionClassification(paths, taskId, attempt);
    if (classification === null) {
      throw new RetryFailedAttemptError('REJECT legado ainda não tem classificação estruturada');
    }
    if (
      classification.candidate_sha !== finalization.candidate_commit ||
      classification.review_record_sha256 !== canonicalFingerprint(review)
    ) {
      throw new RetryFailedAttemptError('classificação legada diverge do candidate/review');
    }
    disposition = classification.disposition;
    classificationFingerprint = canonicalFingerprint(classification);
  } else {
    classificationFingerprint = canonicalFingerprint(review);
  }
  if (disposition !== 'IMPLEMENTATION_DEFECT') {
    throw new RetryFailedAttemptError(
      `review disposition ${disposition} não autoriza reparo de implementação`,
    );
  }

  const existing = await readReviewRejectedAttempt(paths, taskId, attempt);
  const currentHead = await headSha(paths.repoRoot);
  if (existing === null && currentHead !== finalization.candidate_commit) {
    throw new RetryFailedAttemptError(
      `HEAD ${currentHead} diverge do candidate rejeitado ${finalization.candidate_commit}`,
    );
  }
  if ((await parentSha(paths.repoRoot, finalization.candidate_commit)) !== task.base_sha) {
    throw new RetryFailedAttemptError('candidate rejeitado não é filho direto da base autorizada');
  }
  const files = [...new Set(finalization.changed_files)].sort();
  const dirtyFiles = await workingTreeFiles(paths.repoRoot);
  const staged = await stagedFiles(paths.repoRoot);
  const resumingAfterHeadMove = existing !== null && currentHead === task.base_sha;
  if (
    dirtyFiles.length > 0 &&
    (!resumingAfterHeadMove || dirtyFiles.some((file) => !files.includes(file)))
  ) {
    throw new RetryFailedAttemptError('working tree contém mudanças fora do candidate rejeitado');
  }
  if (staged.length > 0 && (!resumingAfterHeadMove || staged.some((file) => !files.includes(file)))) {
    throw new RetryFailedAttemptError('index contém mudanças fora do candidate rejeitado');
  }
  const currentInbox = await readCurrentInboxArtifacts(paths, taskId);
  const currentPair =
    currentInbox.report !== null && currentInbox.handoff !== null
      ? { report: currentInbox.report, handoff: currentInbox.handoff }
      : null;
  const reportSha256 =
    existing?.archived_report_sha256 ??
    finalization.report_sha256 ??
    (currentPair === null ? undefined : sha256Hex(currentPair.report));
  const handoffDraftSha256 =
    existing?.archived_handoff_draft_sha256 ??
    finalization.handoff_draft_sha256 ??
    (currentPair === null ? undefined : sha256Hex(currentPair.handoff));
  if (reportSha256 === undefined || handoffDraftSha256 === undefined) {
    throw new RetryFailedAttemptError(
      'output do worker sem par completo nem hashes suficientes para archive',
    );
  }
  if (
    (finalization.report_sha256 !== undefined &&
      finalization.report_sha256 !== reportSha256) ||
    (finalization.handoff_draft_sha256 !== undefined &&
      finalization.handoff_draft_sha256 !== handoffDraftSha256)
  ) {
    throw new RetryFailedAttemptError(
      'hashes do archive divergem da provenance declarada na finalization',
    );
  }
  const outputHashes = { reportSha256, handoffDraftSha256 };
  const bundle =
    existing === null
      ? await preserveFailedAttemptBundle({
          paths,
          taskId,
          attempt,
          baseSha: task.base_sha,
          files,
          patchFingerprint: finalization.patch_fingerprint,
          now,
        })
      : null;
  const record =
    existing ??
    ReviewRejectedAttemptRecord.parse({
      schema_version: DEV_SCHEMA_VERSION,
      task_id: taskId,
      attempt,
      source_base_sha: task.base_sha,
      profile_id: finalization.profile_id,
      candidate_sha: finalization.candidate_commit,
      finalization_record_sha256: finalizationFingerprint(finalization),
      review_record_sha256: canonicalFingerprint(review),
      rejection_classification_sha256: classificationFingerprint,
      rejection_disposition: disposition,
      review_reason: review.reason,
      // Findings blocking do veredito que autorizou o reparo. É o que define o
      // escopo da re-review focada: sem eles, ela só teria o reason textual.
      ...(review.findings === undefined
        ? {}
        : (() => {
            const blocking = review.findings.filter(
              (finding) => finding.severity === 'BLOCKING',
            );
            return blocking.length === 0 ? {} : { blocking_findings: blocking };
          })()),
      changed_files: files,
      original_validation_results: finalization.validation_results,
      ...(finalization.validation_evidence === undefined
        ? {}
        : { original_validation_evidence: finalization.validation_evidence }),
      patch_fingerprint: finalization.patch_fingerprint,
      change_bundle: bundle?.ref,
      archived_report_sha256: outputHashes.reportSha256,
      archived_handoff_draft_sha256: outputHashes.handoffDraftSha256,
      archived_at: now(),
    });
  if (existing === null) await writeReviewRejectedAttempt(paths, record);
  await input.afterRecordWritten?.(record);

  let inboxBytes: InboxArtifactPair;
  if (currentPair !== null) {
    inboxBytes = currentPair;
  } else {
    const archived = await readArchivedInboxArtifacts(paths, taskId, attempt, outputHashes);
    if (archived === null) {
      throw new RetryFailedAttemptError('output do worker ausente no inbox e no archive');
    }
    inboxBytes = archived;
  }
  const archivedInbox = await archiveInboxArtifacts({
    paths,
    taskId,
    attempt,
    bytes: inboxBytes,
    expected: outputHashes,
  });
  const released = await releaseCurrentInboxArtifacts(
    paths,
    taskId,
    {
      attempt,
      hashes: outputHashes,
    },
    input.inboxReleaseHooks,
  );

  if (currentHead === finalization.candidate_commit) {
    // Move somente a ref corrente, com compare-and-swap. O commit rejeitado já
    // está preservado por SHA + bundle; index/worktree são limpos abaixo por
    // pathspec, sem reset/clean globais.
    await gitOrThrow(paths.repoRoot, [
      'update-ref',
      'HEAD',
      task.base_sha,
      finalization.candidate_commit,
    ]);
    await input.afterHeadMoved?.(record);
  }
  const reset = await resetFilesToBase({
    repoRoot: paths.repoRoot,
    baseSha: task.base_sha,
    files,
  });
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    throw new RetryFailedAttemptError('working tree não ficou limpa após retirar candidate');
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new RetryFailedAttemptError('index não ficou limpo após retirar candidate');
  }
  if ((await headSha(paths.repoRoot)) !== task.base_sha) {
    throw new RetryFailedAttemptError('HEAD não voltou à base autorizada');
  }
  await input.afterPatchReset?.(record);

  const latest = await readState(paths);
  const latestTask = getTaskState(latest, taskId);
  if (latestTask.status !== 'READY') {
    await writeState(
      paths,
      withTaskState(latest, taskId, {
        status: 'READY',
        phase: null,
        process: null,
        candidate_commit: null,
        accepted_commit: null,
        diagnostics:
          `attempt ${attempt} arquivado (REPAIRABLE_REVIEW_REJECTION) — ` +
          'aguardando bounded repair',
        finished_at: null,
      }),
    );
  }
  return {
    record,
    recordPath: reviewRejectedAttemptPath(paths, taskId, attempt),
    bundle,
    restored: reset.restored,
    removed: reset.removed,
    alreadyArchived: existing !== null,
    reportArchivePath: archivedInbox.reportPath,
    handoffArchivePath: archivedInbox.handoffPath,
    releasedCurrentInbox: released.report || released.handoff,
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

export function previousReviewRejectionDiagnosticsFrom(
  record: ReviewRejectedAttemptRecordType,
): PreviousAttemptDiagnostics {
  return {
    attempt: record.attempt,
    profile_id: record.profile_id,
    worker_self_reported_result: 'SUCCESS',
    reason_code: 'REJECTED_BY_INDEPENDENT_REVIEW',
    reason: record.review_reason,
    failed_validations: [],
    review_rejection: {
      disposition: record.rejection_disposition,
      candidate_sha: record.candidate_sha,
      reason: record.review_reason,
    },
    changed_files: [...record.changed_files],
  };
}

/**
 * Diagnóstico do último ValidationFailedAttemptRecord alcançável a partir de
 * `attempts`. INFRA_ERROR é capability-neutral: a travessia só continua enquanto
 * cada gap intermediário estiver comprovado por InfraFailedAttemptRecord.
 * Qualquer outro gap interrompe a cadeia. Ausente quando não há FAIL de
 * validation conectado — inclusive no primeiro capability launch depois de
 * só infraestrutura.
 *
 * Validation e Infra no mesmo attempt é evidência inconsistente: fail closed.
 */
export async function readPreviousAttemptDiagnostics(
  paths: HarnessPaths,
  taskId: string,
  attempts: number,
): Promise<PreviousAttemptDiagnostics | null> {
  if (attempts < 1) return null;
  let current = attempts;
  while (current >= 1) {
    const validation = await readValidationFailedAttempt(paths, taskId, current);
    const infra = await readInfraFailedAttempt(paths, taskId, current);
    const protocolInvalid = await readProtocolInvalidAttempt(paths, taskId, current);
    const abandonment = await readAttemptAbandonment(paths, taskId, current);
    const reviewRejected = await readReviewRejectedAttempt(paths, taskId, current);
    const recordNames = [
      validation === null ? null : 'ValidationFailedAttemptRecord',
      reviewRejected === null ? null : 'ReviewRejectedAttemptRecord',
      infra === null ? null : 'InfraFailedAttemptRecord',
      protocolInvalid === null ? null : 'ProtocolInvalidAttemptRecord',
      abandonment === null ? null : 'AttemptAbandonmentRecord',
    ].filter((name): name is string => name !== null);
    if (recordNames.length > 1) {
      throw new InconsistentAttemptEvidenceError(
        `attempt ${current} de ${taskId} tem ${recordNames.join(' e ')} simultâneos`,
      );
    }
    if (abandonment !== null) return null;
    if (validation !== null) return previousAttemptDiagnosticsFrom(validation);
    if (reviewRejected !== null) return previousReviewRejectionDiagnosticsFrom(reviewRejected);
    if (infra !== null || protocolInvalid !== null) {
      current -= 1;
      continue;
    }
    return null;
  }
  return null;
}
