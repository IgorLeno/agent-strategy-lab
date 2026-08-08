import { readFile } from 'node:fs/promises';
import { canonicalJson, canonicalSha256, sha256Hex } from './canonical.js';
import {
  changedFiles,
  commitExists,
  commitTree,
  gitOrThrow,
  headSha,
  isWorkingTreeClean,
  parentShas,
  patchFingerprint,
  recordedCommitMessage,
  restoreStagedFiles,
  stageFiles,
  stagedFiles,
  workingTreeFiles,
  writeTree,
} from './git.js';
import { maintenanceChainBetween } from './maintenance.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import {
  completionPath,
  handoffDraftPath,
  listOrchestratedRevalidations,
  nextRevalidationSequence,
  originalCompletionEvidencePath,
  readCloseManifest,
  readHandoff,
  readOrchestratedFinalization,
  readPacket,
  readRevalidationCheckpoint,
  reportPath,
  sourceBindingPath,
  writeCloseManifest,
  writeCompletion,
  writeHandoff,
  writeOrchestratedRevalidation,
  writeRevalidationCheckpoint,
} from './records.js';
import {
  AgentCompletionReport,
  CloseManifest,
  CommitMessage,
  CompletionRecord,
  DEV_SCHEMA_VERSION,
  OrchestratedRevalidationRecord,
  RevalidationCheckpoint,
  RevalidationReasonCode,
  RevalidationSourceBinding,
  parseHandoffDraft,
  type CompletionRecord as CompletionRecordType,
  type HandoffDraft,
  type HandoffRecord,
  type OrchestratedRevalidationRecord as OrchestratedRevalidationRecordType,
  type RevalidationCheckpoint as RevalidationCheckpointType,
  type TaskPacket,
  type ValidationCommand,
  type ValidationEvidence,
  type ValidationResult,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';
import {
  nextValidationEvidenceSequence,
  runOfficialValidation,
  type OfficialValidationExecution,
} from './validation-evidence.js';

export class OrchestratedRevalidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratedRevalidationError';
  }
}

export interface RevalidationRunnerContext {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly attempt: number;
  readonly sequence: number;
}

export type RevalidationRunner = (
  command: ValidationCommand,
  context: RevalidationRunnerContext,
) => Promise<OfficialValidationExecution>;

export interface RevalidateOrchestratedInput {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly taskId: string;
  readonly reasonCode: string;
  readonly reason: string;
  readonly validationRunner?: RevalidationRunner;
  readonly now?: () => string;
  readonly afterCommitCreated?: (candidate: string) => Promise<void>;
  readonly afterRevalidationWritten?: (
    record: OrchestratedRevalidationRecordType,
  ) => Promise<void>;
  readonly afterCompletionWritten?: (completion: CompletionRecordType) => Promise<void>;
}

export interface RevalidationResult {
  readonly record: OrchestratedRevalidationRecordType;
  readonly completion: CompletionRecordType | null;
  readonly handoff: HandoffRecord | null;
  readonly alreadyFinalized: boolean;
}

interface BoundSource {
  readonly binding: RevalidationSourceBinding;
  readonly bindingSha256: string;
  readonly originalCompletion: CompletionRecordType;
  readonly originalCompletionBytes: Buffer;
  readonly report: AgentCompletionReport;
  readonly reportBytes: Buffer;
  readonly handoff: HandoffDraft;
  readonly handoffBytes: Buffer;
  readonly packet: TaskPacket;
}

const HARNESS_GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Agent Strategy Lab Harness',
  GIT_AUTHOR_EMAIL: 'harness@agent-strategy-lab.invalid',
  GIT_COMMITTER_NAME: 'Agent Strategy Lab Harness',
  GIT_COMMITTER_EMAIL: 'harness@agent-strategy-lab.invalid',
};

function now(input: RevalidateOrchestratedInput): string {
  return (input.now ?? (() => new Date().toISOString()))();
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OrchestratedRevalidationError(`${label} ausente`);
    }
    throw error;
  }
}

function parseJson<T>(file: string, bytes: Buffer, parse: (input: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new OrchestratedRevalidationError(
      `${file} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function exactFiles(files: readonly string[], label: string): string[] {
  const sorted = [...files].sort();
  if (sorted.length === 0 || new Set(sorted).size !== sorted.length) {
    throw new OrchestratedRevalidationError(`${label} precisa ser não vazio, único e ordenável`);
  }
  return sorted;
}

function assertExactFiles(actual: readonly string[], expected: readonly string[]): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new OrchestratedRevalidationError(
      `arquivos reais divergem do report: real [${left.join(', ')}], report [${right.join(', ')}]`,
    );
  }
}

export function isForbiddenRevalidationPath(file: string): boolean {
  if (file === 'dev/plan.yaml') return true;
  return ['.dev', '.dev-inbox', '.claude', '.agents', '.codex'].some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`),
  );
}

async function loadBoundSource(
  paths: HarnessPaths,
  loaded: LoadedPlan,
  taskId: string,
  attempt: number,
): Promise<BoundSource> {
  const bindingFile = sourceBindingPath(paths, taskId, attempt);
  const bindingBytes = await readRequired(bindingFile, 'RevalidationSourceBinding');
  const parsedBinding = parseJson(bindingFile, bindingBytes, (value) =>
    RevalidationSourceBinding.parse(value),
  );
  if (!parsedBinding) throw new OrchestratedRevalidationError('RevalidationSourceBinding ausente');
  if (
    parsedBinding.task_id !== taskId ||
    parsedBinding.attempt !== attempt ||
    parsedBinding.original_completion_path !== 'original-completion.fail.json'
  ) {
    throw new OrchestratedRevalidationError('source binding não corresponde à task/attempt');
  }

  const originalFile = originalCompletionEvidencePath(paths, taskId, attempt);
  const reportFile = reportPath(paths, taskId);
  const handoffFile = handoffDraftPath(paths, taskId);
  const [originalCompletionBytes, reportBytes, handoffBytes, packet] = await Promise.all([
    readRequired(originalFile, 'CompletionRecord FAIL original'),
    readRequired(reportFile, 'AgentCompletionReport'),
    readRequired(handoffFile, 'HandoffDraft'),
    readPacket(paths, taskId),
  ]);
  if (!packet) throw new OrchestratedRevalidationError('TaskPacket ausente');
  if (sha256Hex(originalCompletionBytes) !== parsedBinding.original_completion_sha256) {
    throw new OrchestratedRevalidationError('hash do CompletionRecord FAIL original diverge');
  }
  if (sha256Hex(reportBytes) !== parsedBinding.report_sha256) {
    throw new OrchestratedRevalidationError('hash do report diverge do source binding');
  }
  if (sha256Hex(handoffBytes) !== parsedBinding.handoff_draft_sha256) {
    throw new OrchestratedRevalidationError('hash do handoff draft diverge do source binding');
  }
  const originalCompletion = parseJson(originalFile, originalCompletionBytes, (value) =>
    CompletionRecord.parse(value),
  );
  const report = parseJson(reportFile, reportBytes, (value) => AgentCompletionReport.parse(value));
  const handoff = parseJson(handoffFile, handoffBytes, parseHandoffDraft);
  if (originalCompletion.status !== 'FAIL') {
    throw new OrchestratedRevalidationError('evidence histórica não é CompletionRecord FAIL');
  }
  if (originalCompletion.report === null || canonicalJson(originalCompletion.report) !== canonicalJson(report)) {
    throw new OrchestratedRevalidationError('report atual diverge do report preservado no FAIL');
  }
  if (report.task_id !== taskId || handoff.task_id !== taskId || packet.task_id !== taskId) {
    throw new OrchestratedRevalidationError('source evidence pertence a outra tarefa');
  }
  if (canonicalJson(packet.validation) !== canonicalJson(loaded.byId.get(taskId)?.validation)) {
    throw new OrchestratedRevalidationError('TaskPacket diverge das validations do plano');
  }
  return {
    binding: parsedBinding,
    bindingSha256: sha256Hex(bindingBytes),
    originalCompletion,
    originalCompletionBytes,
    report,
    reportBytes,
    handoff,
    handoffBytes,
    packet,
  };
}

function originalFailedCommands(source: BoundSource): ValidationCommand[] {
  const original = source.originalCompletion.orchestrator_evidence.revalidation;
  if (original.length !== source.packet.validation.length) {
    throw new OrchestratedRevalidationError('validation oficial original não corresponde ao TaskPacket');
  }
  const failed: ValidationCommand[] = [];
  for (let index = 0; index < original.length; index += 1) {
    const result = original[index] as ValidationResult;
    const command = source.packet.validation[index] as ValidationCommand;
    if (canonicalJson(result.argv) !== canonicalJson(command.argv)) {
      throw new OrchestratedRevalidationError('validation oficial original diverge do TaskPacket');
    }
    if (result.exit_code !== 0 || result.timed_out) failed.push(command);
  }
  if (failed.length === 0) {
    throw new OrchestratedRevalidationError('FAIL sem validation oficial malsucedida');
  }
  return failed;
}

function assertCommonSource(
  source: BoundSource,
  taskId: string,
  attempt: number,
  sourceBase: string | null,
): string[] {
  if (source.originalCompletion.finalization_mode !== 'normal') {
    throw new OrchestratedRevalidationError('CompletionRecord.finalization_mode deve ser normal');
  }
  if (source.report.self_reported_result !== 'SUCCESS') {
    throw new OrchestratedRevalidationError('revalidation exige worker report SUCCESS');
  }
  if (source.report.candidate_commit !== null) {
    throw new OrchestratedRevalidationError('report.candidate_commit deve ser null');
  }
  if (
    source.originalCompletion.orchestrator_evidence.candidate_commit !== null ||
    source.originalCompletion.orchestrator_evidence.accepted_commit !== null
  ) {
    throw new OrchestratedRevalidationError('orchestrator evidence candidate/accepted deve ser null');
  }
  if (
    source.binding.source_base_sha !== source.packet.base_sha ||
    source.binding.source_base_sha !== source.originalCompletion.orchestrator_evidence.base_sha ||
    source.binding.source_base_sha !== sourceBase
  ) {
    throw new OrchestratedRevalidationError('source_base_sha diverge entre binding, packet, completion e state');
  }
  if (source.binding.task_id !== taskId || source.binding.attempt !== attempt) {
    throw new OrchestratedRevalidationError('source binding pertence a outra task/attempt');
  }
  const files = exactFiles(source.report.changed_files, 'report.changed_files');
  if (
    canonicalJson(files) !== canonicalJson(source.binding.changed_files) ||
    canonicalJson(files) !== canonicalJson([...source.originalCompletion.orchestrator_evidence.changed_files].sort())
  ) {
    throw new OrchestratedRevalidationError('changed_files diverge da evidence histórica');
  }
  const forbidden = files.find(isForbiddenRevalidationPath);
  if (forbidden) throw new OrchestratedRevalidationError(`caminho proibido: ${forbidden}`);
  originalFailedCommands(source);
  return files;
}

/**
 * `HARNESS_VALIDATION_DEFECT` só é dizível quando alguém já respondeu pelo
 * defeito: precisa existir manutenção ADOTADA entre a base histórica da task e
 * a base de finalização, e essa manutenção não pode ter tocado nenhum arquivo
 * do patch — se tocou, o que passa na revalidation não é mais o patch do
 * worker, e o veredito seria sobre outro conteúdo.
 */
async function assertHarnessDefectLineage(
  paths: HarnessPaths,
  sourceBase: string,
  finalizationBase: string,
  files: readonly string[],
): Promise<void> {
  if (sourceBase === finalizationBase) {
    throw new OrchestratedRevalidationError(
      'HARNESS_VALIDATION_DEFECT exige manutenção adotada entre source_base_sha e finalization_base_sha',
    );
  }
  let chain;
  try {
    chain = await maintenanceChainBetween(paths, sourceBase, finalizationBase);
  } catch (error) {
    throw new OrchestratedRevalidationError(
      `HARNESS_VALIDATION_DEFECT sem MaintenanceRecord válido: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const patched = new Set(files);
  for (const record of chain) {
    const overlap = record.changed_files.filter((file) => patched.has(file));
    if (overlap.length > 0) {
      throw new OrchestratedRevalidationError(
        `manutenção adotada ${record.adopted_head_sha} tocou arquivo do patch da task: ${overlap.join(', ')}`,
      );
    }
  }
}

function commitMessage(input: RevalidateOrchestratedInput): string {
  const task = input.loaded.byId.get(input.taskId);
  if (!task) throw new OrchestratedRevalidationError(`tarefa ausente no plano: ${input.taskId}`);
  return CommitMessage.parse(`feat(${task.id}): ${task.title}`);
}

async function assertCandidate(
  paths: HarnessPaths,
  candidate: string,
  finalizationBase: string,
  files: readonly string[],
  message: string,
  tree: string,
): Promise<void> {
  if (!(await commitExists(paths.repoRoot, candidate))) {
    throw new OrchestratedRevalidationError(`candidate não existe: ${candidate}`);
  }
  if (canonicalJson(await parentShas(paths.repoRoot, candidate)) !== canonicalJson([finalizationBase])) {
    throw new OrchestratedRevalidationError('candidate.parent diverge de finalization_base_sha');
  }
  if (canonicalJson(await changedFiles(paths.repoRoot, candidate)) !== canonicalJson([...files].sort())) {
    throw new OrchestratedRevalidationError('candidate contém arquivos divergentes');
  }
  if ((await recordedCommitMessage(paths.repoRoot, candidate)) !== message) {
    throw new OrchestratedRevalidationError('candidate contém mensagem divergente');
  }
  if ((await commitTree(paths.repoRoot, candidate)) !== tree) {
    throw new OrchestratedRevalidationError('candidate tree diverge do checkpoint validado');
  }
}

function assertCheckpoint(
  checkpoint: RevalidationCheckpointType,
  source: BoundSource,
  sequence: number,
  finalizationBase: string,
  reasonCode: string,
  reason: string,
  message: string,
  files: readonly string[],
): void {
  if (
    checkpoint.task_id !== source.binding.task_id ||
    checkpoint.attempt !== source.binding.attempt ||
    checkpoint.sequence !== sequence ||
    checkpoint.reason_code !== reasonCode ||
    checkpoint.reason !== reason ||
    checkpoint.source_binding_sha256 !== source.bindingSha256 ||
    checkpoint.source_base_sha !== source.binding.source_base_sha ||
    checkpoint.finalization_base_sha !== finalizationBase ||
    checkpoint.original_completion_sha256 !== source.binding.original_completion_sha256 ||
    checkpoint.report_sha256 !== source.binding.report_sha256 ||
    checkpoint.handoff_draft_sha256 !== source.binding.handoff_draft_sha256 ||
    checkpoint.patch_fingerprint !== source.binding.derived_patch_fingerprint ||
    checkpoint.commit_message !== message ||
    canonicalJson(checkpoint.changed_files) !== canonicalJson(files)
  ) {
    throw new OrchestratedRevalidationError('RevalidationCheckpoint diverge da solicitação/source');
  }
}

async function executeValidations(
  input: RevalidateOrchestratedInput,
  attempt: number,
  commands: readonly ValidationCommand[],
): Promise<{ results: ValidationResult[]; evidence: ValidationEvidence[] }> {
  let evidenceSequence = await nextValidationEvidenceSequence(
    input.paths,
    input.taskId,
    attempt,
  );
  const results: ValidationResult[] = [];
  const evidence: ValidationEvidence[] = [];
  for (const command of commands) {
    const context = {
      paths: input.paths,
      taskId: input.taskId,
      attempt,
      sequence: evidenceSequence,
    };
    const execution = input.validationRunner
      ? await input.validationRunner(command, context)
      : await runOfficialValidation({
          paths: input.paths,
          taskId: input.taskId,
          attempt,
          command,
          sequence: evidenceSequence,
        });
    if (canonicalJson(execution.result.argv) !== canonicalJson(command.argv)) {
      throw new OrchestratedRevalidationError('validation runner retornou argv divergente');
    }
    results.push(execution.result);
    evidence.push(execution.evidence);
    evidenceSequence += 1;
  }
  return { results, evidence };
}

function buildRecord(
  input: RevalidateOrchestratedInput,
  source: BoundSource,
  checkpoint: RevalidationCheckpointType | null,
  sequence: number,
  finalizationBase: string,
  files: readonly string[],
  message: string,
  results: readonly ValidationResult[],
  evidence: readonly ValidationEvidence[],
  candidate: string | null,
  candidateTree: string | null,
): OrchestratedRevalidationRecordType {
  const failed = results.some((result) => result.exit_code !== 0 || result.timed_out);
  return OrchestratedRevalidationRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    attempt: source.binding.attempt,
    sequence,
    outcome: failed ? 'FAIL' : 'PASS',
    reason_code: RevalidationReasonCode.parse(input.reasonCode),
    reason: input.reason,
    source_binding_sha256: source.bindingSha256,
    source_base_sha: source.binding.source_base_sha,
    finalization_base_sha: finalizationBase,
    original_completion_sha256: source.binding.original_completion_sha256,
    report_sha256: source.binding.report_sha256,
    handoff_draft_sha256: source.binding.handoff_draft_sha256,
    patch_fingerprint: source.binding.derived_patch_fingerprint,
    original_validation_results: source.originalCompletion.orchestrator_evidence.revalidation,
    revalidation_results: [...results],
    validation_evidence: [...evidence],
    changed_files: [...files],
    commit_message: message,
    candidate_commit: candidate,
    candidate_tree_sha: candidateTree,
    commit_origin: 'orchestrator',
    working_tree_clean: candidate !== null,
    revalidated_at: checkpoint?.checkpointed_at ?? now(input),
  });
}

function completionFrom(
  source: BoundSource,
  record: OrchestratedRevalidationRecordType,
): CompletionRecordType {
  const candidate = record.candidate_commit as string;
  return CompletionRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    status: 'PASS',
    report: source.report,
    orchestrator_evidence: {
      task_id: record.task_id,
      base_sha: record.finalization_base_sha,
      candidate_commit: candidate,
      accepted_commit: candidate,
      changed_files: record.changed_files,
      working_tree_clean: true,
      process: source.originalCompletion.orchestrator_evidence.process,
      duration_ms: record.revalidation_results.reduce((sum, result) => sum + result.duration_ms, 0),
      exit_code: 0,
      timed_out: false,
      revalidation: record.revalidation_results,
      validation_evidence: record.validation_evidence,
      observed_at: record.revalidated_at,
    },
    report_matches_evidence: true,
    discrepancies: [],
    finalization_mode: 'normal',
    commit_origin: 'orchestrator',
    revalidated_after_validation_failure: true,
    revalidation_attempt: record.attempt,
    revalidation_sequence: record.sequence,
    revalidation_record_sha256: canonicalSha256(record),
    closed_at: record.revalidated_at,
  });
}

function handoffFrom(source: BoundSource, record: OrchestratedRevalidationRecordType): HandoffRecord {
  return {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    result: 'PASS',
    changed_files: record.changed_files,
    validations: record.revalidation_results,
    decisions: source.handoff.decisions,
    lessons: source.handoff.lessons,
    next_relevant_files: source.handoff.next_relevant_files,
    accepted_commit: record.candidate_commit as string,
    sealed_at: record.revalidated_at,
  };
}

export async function verifyOrchestratedRevalidationRecord(
  paths: HarnessPaths,
  loaded: LoadedPlan,
  record: OrchestratedRevalidationRecordType,
): Promise<BoundSource> {
  OrchestratedRevalidationRecord.parse(record);
  if (record.outcome !== 'PASS' || record.candidate_commit === null || record.candidate_tree_sha === null) {
    throw new OrchestratedRevalidationError('somente revalidation PASS pode ser aceita');
  }
  const source = await loadBoundSource(paths, loaded, record.task_id, record.attempt);
  if (
    source.bindingSha256 !== record.source_binding_sha256 ||
    source.binding.source_base_sha !== record.source_base_sha ||
    source.binding.original_completion_sha256 !== record.original_completion_sha256 ||
    source.binding.report_sha256 !== record.report_sha256 ||
    source.binding.handoff_draft_sha256 !== record.handoff_draft_sha256 ||
    source.binding.derived_patch_fingerprint !== record.patch_fingerprint ||
    canonicalJson(source.binding.changed_files) !== canonicalJson(record.changed_files) ||
    canonicalJson(source.originalCompletion.orchestrator_evidence.revalidation) !==
      canonicalJson(record.original_validation_results)
  ) {
    throw new OrchestratedRevalidationError('RevalidationRecord diverge da source evidence');
  }
  if (record.reason_code === 'HARNESS_VALIDATION_DEFECT') {
    await assertHarnessDefectLineage(
      paths,
      record.source_base_sha,
      record.finalization_base_sha,
      record.changed_files,
    );
  }
  await assertCandidate(
    paths,
    record.candidate_commit,
    record.finalization_base_sha,
    record.changed_files,
    record.commit_message,
    record.candidate_tree_sha,
  );
  return source;
}

export async function sealOrchestratedRevalidation(
  paths: HarnessPaths,
  loaded: LoadedPlan,
  record: OrchestratedRevalidationRecordType,
  options: { afterCompletionWritten?: (completion: CompletionRecordType) => Promise<void> } = {},
): Promise<{ completion: CompletionRecordType; handoff: HandoffRecord }> {
  const source = await verifyOrchestratedRevalidationRecord(paths, loaded, record);
  const completion = completionFrom(source, record);
  const handoff = handoffFrom(source, record);
  const manifest = CloseManifest.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    accepted_commit: record.candidate_commit,
    completion_sha256: canonicalSha256(completion),
    handoff_sha256: canonicalSha256(handoff),
    sealed_at: record.revalidated_at,
  });
  await writeCompletion(paths, completion);
  await options.afterCompletionWritten?.(completion);
  await writeHandoff(paths, handoff);
  await writeCloseManifest(paths, manifest);
  return { completion, handoff };
}

async function promoteState(
  input: RevalidateOrchestratedInput,
  record: OrchestratedRevalidationRecordType,
): Promise<void> {
  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  if (task.status === 'PASS') {
    if (task.accepted_commit !== record.candidate_commit) {
      throw new OrchestratedRevalidationError('PASS existente discorda do revalidation candidate');
    }
    return;
  }
  if (state.authorized_head_sha !== record.finalization_base_sha) {
    throw new OrchestratedRevalidationError('authorized_head_sha diverge de finalization_base_sha');
  }
  const next = withTaskState(state, input.taskId, {
    status: 'PASS',
    phase: null,
    process: task.process,
    candidate_commit: record.candidate_commit,
    accepted_commit: record.candidate_commit,
    diagnostics: null,
    finished_at: record.revalidated_at,
  });
  await writeState(input.paths, { ...next, authorized_head_sha: record.candidate_commit });
}

export async function revalidateOrchestrated(
  input: RevalidateOrchestratedInput,
): Promise<RevalidationResult> {
  const reasonCode = RevalidationReasonCode.parse(input.reasonCode);
  if (input.reason.trim() === '') throw new OrchestratedRevalidationError('--reason é obrigatório');
  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  const existingRecords = await listOrchestratedRevalidations(
    input.paths,
    input.taskId,
    task.attempts,
  );
  const accepted = [...existingRecords].reverse().find((record) => record.outcome === 'PASS');
  if (accepted) {
    if (accepted.reason_code !== reasonCode || accepted.reason !== input.reason) {
      throw new OrchestratedRevalidationError('revalidation PASS existente diverge da solicitação');
    }
    const sealed = await sealOrchestratedRevalidation(
      input.paths,
      input.loaded,
      accepted,
      input.afterCompletionWritten
        ? { afterCompletionWritten: input.afterCompletionWritten }
        : {},
    );
    await promoteState(input, accepted);
    return { record: accepted, ...sealed, alreadyFinalized: true };
  }

  if (task.status !== 'FAIL') {
    throw new OrchestratedRevalidationError(`dev-revalidate exige tarefa FAIL, encontrada ${task.status}`);
  }
  if (task.attempts < 1) throw new OrchestratedRevalidationError('FAIL sem attempt');
  const otherRunning = state.tasks.find(
    (candidate) => candidate.id !== input.taskId && candidate.status === 'RUNNING',
  );
  if (otherRunning) throw new OrchestratedRevalidationError(`outra tarefa RUNNING: ${otherRunning.id}`);
  if (task.candidate_commit !== null || task.accepted_commit !== null) {
    throw new OrchestratedRevalidationError('FAIL não pode ter candidate/accepted commit');
  }
  if (state.authorized_head_sha === null) {
    throw new OrchestratedRevalidationError('authorized_head_sha ausente');
  }
  const finalizationBase = state.authorized_head_sha;
  const source = await loadBoundSource(input.paths, input.loaded, input.taskId, task.attempts);
  const files = assertCommonSource(source, input.taskId, task.attempts, task.base_sha);
  if (reasonCode === 'HARNESS_VALIDATION_DEFECT') {
    await assertHarnessDefectLineage(
      input.paths,
      source.binding.source_base_sha,
      finalizationBase,
      files,
    );
  }
  const message = commitMessage(input);
  if (await readOrchestratedFinalization(input.paths, input.taskId, task.attempts)) {
    throw new OrchestratedRevalidationError('attempt já possui candidate/finalization record');
  }
  if ((await readCloseManifest(input.paths, input.taskId)) || (await readHandoff(input.paths, input.taskId))) {
    throw new OrchestratedRevalidationError('FAIL possui evidence de fechamento autoritativo inesperada');
  }

  const currentCompletionBytes = await readRequired(
    completionPath(input.paths, input.taskId),
    'CompletionRecord FAIL atual',
  );
  const currentCompletion = parseJson(completionPath(input.paths, input.taskId), currentCompletionBytes, (value) =>
    CompletionRecord.parse(value),
  );
  if (currentCompletion.status !== 'FAIL') {
    throw new OrchestratedRevalidationError('CompletionRecord atual não é FAIL');
  }
  if (sha256Hex(currentCompletionBytes) !== source.binding.original_completion_sha256) {
    throw new OrchestratedRevalidationError('CompletionRecord FAIL atual diverge do archive original');
  }

  const sequence = await nextRevalidationSequence(input.paths, input.taskId, task.attempts);
  let checkpoint = await readRevalidationCheckpoint(
    input.paths,
    input.taskId,
    task.attempts,
    sequence,
  );
  let candidate = await headSha(input.paths.repoRoot);
  let results: ValidationResult[];
  let evidence: ValidationEvidence[];
  let candidateTree: string;

  if (checkpoint) {
    assertCheckpoint(
      checkpoint,
      source,
      sequence,
      finalizationBase,
      reasonCode,
      input.reason,
      message,
      files,
    );
    results = checkpoint.revalidation_results;
    evidence = checkpoint.validation_evidence;
    candidateTree = checkpoint.staged_tree_sha;
    if (candidate === finalizationBase) {
      const staged = await stagedFiles(input.paths.repoRoot);
      if (staged.length > 0) {
        assertExactFiles(staged, files);
        if ((await writeTree(input.paths.repoRoot)) !== candidateTree) {
          throw new OrchestratedRevalidationError('index staged diverge do checkpoint');
        }
      } else {
        assertExactFiles(await workingTreeFiles(input.paths.repoRoot), files);
        if ((await patchFingerprint(input.paths.repoRoot)) !== source.binding.derived_patch_fingerprint) {
          throw new OrchestratedRevalidationError('patch fingerprint diverge antes do resume');
        }
        await stageFiles(input.paths.repoRoot, files);
        if ((await writeTree(input.paths.repoRoot)) !== candidateTree) {
          await restoreStagedFiles(input.paths.repoRoot, files);
          throw new OrchestratedRevalidationError('staged tree diverge do checkpoint');
        }
      }
      try {
        await gitOrThrow(input.paths.repoRoot, ['commit', '-m', message], HARNESS_GIT_IDENTITY);
      } catch (error) {
        await restoreStagedFiles(input.paths.repoRoot, files).catch(() => undefined);
        throw error;
      }
      candidate = await headSha(input.paths.repoRoot);
      await input.afterCommitCreated?.(candidate);
    } else {
      if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
        throw new OrchestratedRevalidationError('HEAD avançou e working tree não está limpa');
      }
    }
  } else {
    if (candidate !== finalizationBase) {
      throw new OrchestratedRevalidationError('HEAD diverge do authorized_head_sha sem checkpoint');
    }
    if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
      throw new OrchestratedRevalidationError('index contém mudanças staged');
    }
    assertExactFiles(await workingTreeFiles(input.paths.repoRoot), files);
    if ((await patchFingerprint(input.paths.repoRoot)) !== source.binding.derived_patch_fingerprint) {
      throw new OrchestratedRevalidationError('patch fingerprint diverge do source binding');
    }

    const failedCommands = originalFailedCommands(source);
    const execution = await executeValidations(
      input,
      task.attempts,
      [...source.packet.validation, ...failedCommands],
    );
    results = execution.results;
    evidence = execution.evidence;
    if ((await headSha(input.paths.repoRoot)) !== finalizationBase) {
      throw new OrchestratedRevalidationError('HEAD mudou durante revalidation');
    }
    if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
      const changed = await stagedFiles(input.paths.repoRoot);
      await restoreStagedFiles(input.paths.repoRoot, changed);
      throw new OrchestratedRevalidationError('index mudou durante revalidation e foi restaurado');
    }
    assertExactFiles(await workingTreeFiles(input.paths.repoRoot), files);
    if ((await patchFingerprint(input.paths.repoRoot)) !== source.binding.derived_patch_fingerprint) {
      throw new OrchestratedRevalidationError('patch fingerprint mudou durante revalidation');
    }

    if (results.some((result) => result.exit_code !== 0 || result.timed_out)) {
      const record = buildRecord(
        input,
        source,
        null,
        sequence,
        finalizationBase,
        files,
        message,
        results,
        evidence,
        null,
        null,
      );
      await writeOrchestratedRevalidation(input.paths, record);
      await input.afterRevalidationWritten?.(record);
      return { record, completion: null, handoff: null, alreadyFinalized: false };
    }

    await stageFiles(input.paths.repoRoot, files);
    try {
      assertExactFiles(await stagedFiles(input.paths.repoRoot), files);
      const diffExecution = await executeValidations(input, task.attempts, [
        { argv: ['git', 'diff', '--cached', '--check'], timeout_seconds: 300 },
      ]);
      results.push(...diffExecution.results);
      evidence.push(...diffExecution.evidence);
      if (diffExecution.results.some((result) => result.exit_code !== 0 || result.timed_out)) {
        await restoreStagedFiles(input.paths.repoRoot, files);
        const record = buildRecord(
          input,
          source,
          null,
          sequence,
          finalizationBase,
          files,
          message,
          results,
          evidence,
          null,
          null,
        );
        await writeOrchestratedRevalidation(input.paths, record);
        await input.afterRevalidationWritten?.(record);
        return { record, completion: null, handoff: null, alreadyFinalized: false };
      }
      candidateTree = await writeTree(input.paths.repoRoot);
      checkpoint = RevalidationCheckpoint.parse({
        schema_version: DEV_SCHEMA_VERSION,
        task_id: input.taskId,
        attempt: task.attempts,
        sequence,
        reason_code: reasonCode,
        reason: input.reason,
        source_binding_sha256: source.bindingSha256,
        source_base_sha: source.binding.source_base_sha,
        finalization_base_sha: finalizationBase,
        original_completion_sha256: source.binding.original_completion_sha256,
        report_sha256: source.binding.report_sha256,
        handoff_draft_sha256: source.binding.handoff_draft_sha256,
        patch_fingerprint: source.binding.derived_patch_fingerprint,
        original_validation_results: source.originalCompletion.orchestrator_evidence.revalidation,
        revalidation_results: results,
        validation_evidence: evidence,
        changed_files: files,
        commit_message: message,
        staged_tree_sha: candidateTree,
        checkpointed_at: now(input),
      });
      await writeRevalidationCheckpoint(input.paths, checkpoint);
      await gitOrThrow(input.paths.repoRoot, ['commit', '-m', message], HARNESS_GIT_IDENTITY);
      candidate = await headSha(input.paths.repoRoot);
      await input.afterCommitCreated?.(candidate);
    } catch (error) {
      if ((await headSha(input.paths.repoRoot)) === finalizationBase) {
        await restoreStagedFiles(input.paths.repoRoot, files).catch(() => undefined);
      }
      throw error;
    }
  }

  await assertCandidate(input.paths, candidate, finalizationBase, files, message, candidateTree);
  if (!(await isWorkingTreeClean(input.paths.repoRoot)) || (await stagedFiles(input.paths.repoRoot)).length > 0) {
    throw new OrchestratedRevalidationError('candidate não deixou working tree/index limpos');
  }
  const record = buildRecord(
    input,
    source,
    checkpoint,
    sequence,
    finalizationBase,
    files,
    message,
    results,
    evidence,
    candidate,
    candidateTree,
  );
  await writeOrchestratedRevalidation(input.paths, record);
  await input.afterRevalidationWritten?.(record);
  const sealed = await sealOrchestratedRevalidation(
    input.paths,
    input.loaded,
    record,
    input.afterCompletionWritten
      ? { afterCompletionWritten: input.afterCompletionWritten }
      : {},
  );
  await promoteState(input, record);
  return { record, ...sealed, alreadyFinalized: false };
}
