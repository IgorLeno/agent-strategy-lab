import { readFile } from 'node:fs/promises';
import { canonicalJson, canonicalSha256, sha256Hex } from './canonical.js';
import {
  changedFiles,
  commitExists,
  gitOrThrow,
  headSha,
  isWorkingTreeClean,
  parentShas,
  recordedCommitMessage,
  restoreStagedFiles,
  stageFiles,
  stagedFiles,
  workingTreeFiles,
} from './git.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import {
  attemptAbandonmentPath,
  handoffDraftPath,
  readCloseManifest,
  readCompletion,
  readHandoff,
  readRecoveredFinalization,
  reportPath,
  writeCloseManifest,
  writeCompletion,
  writeHandoff,
  writeRecoveredFinalization,
} from './records.js';
import {
  AgentCompletionReport,
  AttemptAbandonmentRecord,
  CommitMessage,
  DEV_SCHEMA_VERSION,
  RecoveredFinalizationRecord,
  parseHandoffDraft,
  type CompletionRecord,
  type HandoffDraft,
  type HandoffRecord,
  type RecoveredFinalizationRecord as RecoveredFinalizationRecordType,
  type ValidationCommand,
  type ValidationEvidence,
  type ValidationResult,
} from './schemas.js';
import {
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from './state.js';
import { runOfficialValidation } from './validation-evidence.js';

export class RecoveredFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveredFinalizationError';
  }
}

export const RECOVERABLE_ABANDONMENT_REASON_CODES = ['WORKER_ENVIRONMENT_BLOCKED'] as const;
const RECOVERABLE_REASON_SET = new Set<string>(RECOVERABLE_ABANDONMENT_REASON_CODES);

const HARNESS_GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Agent Strategy Lab Harness',
  GIT_AUTHOR_EMAIL: 'harness@agent-strategy-lab.invalid',
  GIT_COMMITTER_NAME: 'Agent Strategy Lab Harness',
  GIT_COMMITTER_EMAIL: 'harness@agent-strategy-lab.invalid',
};

export type RecoveredValidationRunner = (
  command: ValidationCommand,
  cwd: string,
) => Promise<ValidationResult>;

export interface FinalizeRecoveredInput {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly taskId: string;
  readonly sourceAttempt: number;
  readonly reason: string;
  readonly commitMessage: string;
  readonly validationRunner?: RecoveredValidationRunner;
  readonly now?: () => string;
  readonly afterCommitCreated?: (candidate: string) => Promise<void>;
  readonly afterRecoveryWritten?: (record: RecoveredFinalizationRecordType) => Promise<void>;
  readonly afterCompletionWritten?: (completion: CompletionRecord) => Promise<void>;
}

export interface RecoveredFinalizationResult {
  readonly record: RecoveredFinalizationRecordType;
  readonly completion: CompletionRecord;
  readonly handoff: HandoffRecord;
  readonly alreadyFinalized: boolean;
}

interface SourceEvidence {
  readonly abandonment: AttemptAbandonmentRecord;
  readonly abandonmentSha256: string;
  readonly report: AgentCompletionReport;
  readonly reportSha256: string;
  readonly handoff: HandoffDraft;
  readonly handoffSha256: string;
}

export function isForbiddenRecoveredPath(file: string): boolean {
  if (file === 'dev/plan.yaml') return true;
  return ['.dev', '.dev-inbox', '.claude', '.agents', '.codex'].some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`),
  );
}

export function validateCommitMessage(message: string): string {
  try {
    return CommitMessage.parse(message);
  } catch (error) {
    throw new RecoveredFinalizationError(
      `--commit-message inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseJson<T>(file: string, bytes: Buffer, parse: (input: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new RecoveredFinalizationError(
      `${file} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RecoveredFinalizationError(`${label} ausente`);
    }
    throw error;
  }
}

async function loadSourceEvidence(
  paths: HarnessPaths,
  taskId: string,
  sourceAttempt: number,
): Promise<SourceEvidence> {
  const abandonmentFile = attemptAbandonmentPath(paths, taskId, sourceAttempt);
  const abandonmentBytes = await readRequired(abandonmentFile, 'AttemptAbandonmentRecord');
  const abandonment = parseJson(abandonmentFile, abandonmentBytes, (input) =>
    AttemptAbandonmentRecord.parse(input),
  );
  if (abandonment.task_id !== taskId || abandonment.attempt !== sourceAttempt) {
    throw new RecoveredFinalizationError('AttemptAbandonmentRecord não corresponde à origem');
  }
  if (
    abandonment.reason_code === undefined ||
    abandonment.report_sha256 === undefined ||
    abandonment.handoff_draft_sha256 === undefined ||
    abandonment.source_base_sha === undefined ||
    abandonment.source_report_result !== 'FAILURE'
  ) {
    throw new RecoveredFinalizationError('AttemptAbandonmentRecord não contém output recuperável');
  }

  const reportFile = reportPath(paths, taskId);
  const handoffFile = handoffDraftPath(paths, taskId);
  const [reportBytes, handoffBytes] = await Promise.all([
    readRequired(reportFile, 'AgentCompletionReport'),
    readRequired(handoffFile, 'HandoffDraft'),
  ]);
  const reportSha256 = sha256Hex(reportBytes);
  const handoffSha256 = sha256Hex(handoffBytes);
  if (reportSha256 !== abandonment.report_sha256) {
    throw new RecoveredFinalizationError('hash do report diverge do abandonment record');
  }
  if (handoffSha256 !== abandonment.handoff_draft_sha256) {
    throw new RecoveredFinalizationError('hash do handoff diverge do abandonment record');
  }

  const report = parseJson(reportFile, reportBytes, (input) => AgentCompletionReport.parse(input));
  const handoff = parseJson(handoffFile, handoffBytes, parseHandoffDraft);
  if (report.task_id !== taskId) {
    throw new RecoveredFinalizationError(`report pertence a outra tarefa: ${report.task_id}`);
  }
  if (handoff.task_id !== taskId) {
    throw new RecoveredFinalizationError(`handoff pertence a outra tarefa: ${handoff.task_id}`);
  }
  if (report.self_reported_result !== 'FAILURE') {
    throw new RecoveredFinalizationError('report original precisa continuar FAILURE');
  }
  if (report.candidate_commit !== null) {
    throw new RecoveredFinalizationError('report.candidate_commit precisa continuar null');
  }

  return {
    abandonment,
    abandonmentSha256: sha256Hex(abandonmentBytes),
    report,
    reportSha256,
    handoff,
    handoffSha256,
  };
}

function assertRecoverable(evidence: SourceEvidence): void {
  if (!RECOVERABLE_REASON_SET.has(evidence.abandonment.reason_code ?? '')) {
    throw new RecoveredFinalizationError(
      `reason_code não recuperável: ${evidence.abandonment.reason_code ?? 'ausente'}`,
    );
  }
}

function exactReportedFiles(report: AgentCompletionReport): string[] {
  const sorted = [...report.changed_files].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new RecoveredFinalizationError('report.changed_files contém duplicatas');
  }
  return sorted;
}

function assertExactFiles(actual: readonly string[], reported: readonly string[]): void {
  const left = [...actual].sort();
  const right = [...reported].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new RecoveredFinalizationError(
      `arquivos reais divergem do report: real [${left.join(', ')}], report [${right.join(', ')}]`,
    );
  }
  const forbidden = left.find(isForbiddenRecoveredPath);
  if (forbidden) throw new RecoveredFinalizationError(`caminho proibido na recuperação: ${forbidden}`);
}

async function runOfficialValidations(
  input: FinalizeRecoveredInput,
  diffArgv: string[],
): Promise<{ results: ValidationResult[]; evidence: ValidationEvidence[] }> {
  const planTask = input.loaded.byId.get(input.taskId);
  if (!planTask) throw new RecoveredFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  const commands: ValidationCommand[] = [
    ...planTask.validation,
    { argv: diffArgv, timeout_seconds: 300 },
  ];
  const results: ValidationResult[] = [];
  const validationEvidence: ValidationEvidence[] = [];
  for (const command of commands) {
    const execution = input.validationRunner
      ? { result: await input.validationRunner(command, input.paths.repoRoot), evidence: null }
      : await runOfficialValidation({
          paths: input.paths,
          taskId: input.taskId,
          attempt: input.sourceAttempt,
          command,
        });
    const result = execution.result;
    results.push(result);
    if (execution.evidence) validationEvidence.push(execution.evidence);
    if (result.exit_code !== 0 || result.timed_out) {
      throw new RecoveredFinalizationError(
        `validação falhou: ${command.argv.join(' ')} (exit ${result.exit_code ?? 'null'})`,
      );
    }
  }
  return { results, evidence: validationEvidence };
}

async function assertCandidate(
  paths: HarnessPaths,
  candidate: string,
  base: string,
  files: readonly string[],
  commitMessage: string,
): Promise<void> {
  if (!(await commitExists(paths.repoRoot, candidate))) {
    throw new RecoveredFinalizationError(`candidate commit não existe: ${candidate}`);
  }
  const parents = await parentShas(paths.repoRoot, candidate);
  if (parents.length !== 1 || parents[0] !== base) {
    throw new RecoveredFinalizationError('candidate não é filho direto da finalization base');
  }
  assertExactFiles(await changedFiles(paths.repoRoot, candidate), files);
  const recorded = await recordedCommitMessage(paths.repoRoot, candidate);
  if (recorded !== commitMessage) {
    throw new RecoveredFinalizationError('mensagem do candidate diverge de commit_message');
  }
}

function deterministicCompletion(
  record: RecoveredFinalizationRecordType,
  evidence: SourceEvidence,
): CompletionRecord {
  const duration = Math.max(
    0,
    Date.parse(evidence.abandonment.finished_at) - Date.parse(evidence.abandonment.started_at),
  );
  return {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    status: 'PASS',
    report: evidence.report,
    orchestrator_evidence: {
      task_id: record.task_id,
      base_sha: record.finalization_base_sha,
      candidate_commit: record.candidate_commit,
      accepted_commit: record.candidate_commit,
      changed_files: [...record.changed_files],
      working_tree_clean: true,
      process: evidence.abandonment.process,
      duration_ms: duration,
      exit_code: evidence.abandonment.exit_code,
      timed_out: evidence.abandonment.launch_classification === 'TIMED_OUT',
      revalidation: [...record.validation_results],
      ...(record.validation_evidence === undefined
        ? {}
        : { validation_evidence: [...record.validation_evidence] }),
      observed_at: record.finalized_at,
    },
    report_matches_evidence: false,
    discrepancies: [
      'worker reportou FAILURE por limitação de infraestrutura; implementação revalidada e commitada pelo orquestrador durante recovered finalization',
    ],
    finalization_mode: 'recovered',
    commit_origin: 'orchestrator_recovery',
    recovery_source_attempt: record.source_attempt,
    recovery_record_sha256: canonicalSha256(record),
    closed_at: record.finalized_at,
  };
}

function deterministicHandoff(
  record: RecoveredFinalizationRecordType,
  source: HandoffDraft,
): HandoffRecord {
  return {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    result: 'PASS',
    changed_files: [...record.changed_files],
    validations: [...record.validation_results],
    decisions: [...source.decisions],
    lessons: [...source.lessons],
    next_relevant_files: [...source.next_relevant_files],
    accepted_commit: record.candidate_commit,
    sealed_at: record.finalized_at,
  };
}

async function assertOrWrite<T>(
  label: string,
  existing: T | null,
  expected: T,
  write: () => Promise<void>,
): Promise<void> {
  if (existing === null) {
    await write();
    return;
  }
  if (canonicalJson(existing) !== canonicalJson(expected)) {
    throw new RecoveredFinalizationError(`${label} existente diverge da recuperação`);
  }
}

export async function verifyRecoveredFinalizationRecord(
  paths: HarnessPaths,
  record: RecoveredFinalizationRecordType,
): Promise<SourceEvidence> {
  RecoveredFinalizationRecord.parse(record);
  const evidence = await loadSourceEvidence(paths, record.task_id, record.source_attempt);
  assertRecoverable(evidence);
  if (record.abandonment_record_sha256 !== evidence.abandonmentSha256) {
    throw new RecoveredFinalizationError('hash do abandonment record diverge da recuperação');
  }
  if (
    record.report_sha256 !== evidence.reportSha256 ||
    record.handoff_draft_sha256 !== evidence.handoffSha256
  ) {
    throw new RecoveredFinalizationError('hashes dos artifacts divergem da recuperação');
  }
  if (
    record.source_base_sha !== evidence.abandonment.source_base_sha ||
    record.reason_code !== evidence.abandonment.reason_code
  ) {
    throw new RecoveredFinalizationError('origem registrada diverge do abandonment record');
  }
  if (evidence.abandonment.source_base_sha !== evidence.abandonment.base_sha) {
    throw new RecoveredFinalizationError('source_base_sha diverge do base_sha abandonado');
  }
  assertExactFiles(record.changed_files, exactReportedFiles(evidence.report));
  await assertCandidate(
    paths,
    record.candidate_commit,
    record.finalization_base_sha,
    record.changed_files,
    record.commit_message,
  );
  return evidence;
}

export async function sealRecoveredFinalization(
  paths: HarnessPaths,
  record: RecoveredFinalizationRecordType,
  options: { afterCompletionWritten?: (completion: CompletionRecord) => Promise<void> } = {},
): Promise<{ completion: CompletionRecord; handoff: HandoffRecord }> {
  const evidence = await verifyRecoveredFinalizationRecord(paths, record);
  const completion = deterministicCompletion(record, evidence);
  const handoff = deterministicHandoff(record, evidence.handoff);
  const manifest = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    accepted_commit: record.candidate_commit,
    completion_sha256: canonicalSha256(completion),
    handoff_sha256: canonicalSha256(handoff),
    sealed_at: record.finalized_at,
  } as const;

  await assertOrWrite(
    'CompletionRecord',
    await readCompletion(paths, record.task_id),
    completion,
    () => writeCompletion(paths, completion),
  );
  await options.afterCompletionWritten?.(completion);
  await assertOrWrite(
    'HandoffRecord',
    await readHandoff(paths, record.task_id),
    handoff,
    () => writeHandoff(paths, handoff),
  );
  await assertOrWrite(
    'CloseManifest',
    await readCloseManifest(paths, record.task_id),
    manifest,
    () => writeCloseManifest(paths, manifest),
  );
  return { completion, handoff };
}

async function finishState(
  input: FinalizeRecoveredInput,
  record: RecoveredFinalizationRecordType,
): Promise<void> {
  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  if (task.status === 'PASS') {
    if (task.accepted_commit !== record.candidate_commit) {
      throw new RecoveredFinalizationError('PASS existente diverge do recovery candidate');
    }
    return;
  }
  if (task.status !== 'READY') {
    throw new RecoveredFinalizationError(`recovery exige tarefa READY, encontrada ${task.status}`);
  }
  if (state.authorized_head_sha !== record.finalization_base_sha) {
    throw new RecoveredFinalizationError('authorized_head_sha diverge da finalization base recuperada');
  }
  const next = withTaskState(state, input.taskId, {
    status: 'PASS',
    phase: null,
    process: null,
    candidate_commit: record.candidate_commit,
    accepted_commit: record.candidate_commit,
    diagnostics: null,
    finished_at: record.finalized_at,
  });
  await writeState(input.paths, { ...next, authorized_head_sha: record.candidate_commit });
}

export async function finalizeRecovered(
  input: FinalizeRecoveredInput,
): Promise<RecoveredFinalizationResult> {
  if (!Number.isInteger(input.sourceAttempt) || input.sourceAttempt < 1) {
    throw new RecoveredFinalizationError('--source-attempt deve ser inteiro positivo');
  }
  const reason = input.reason.trim();
  if (reason === '') throw new RecoveredFinalizationError('--reason é obrigatório');
  const commitMessage = validateCommitMessage(input.commitMessage);

  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  if (task.status !== 'READY' && task.status !== 'PASS') {
    throw new RecoveredFinalizationError(
      `recovered finalization exige tarefa READY, encontrada ${task.status}`,
    );
  }
  if (task.attempts !== input.sourceAttempt) {
    throw new RecoveredFinalizationError('source-attempt não corresponde ao attempt atual');
  }
  const otherRunning = state.tasks.find(
    (candidate) => candidate.id !== input.taskId && candidate.status === 'RUNNING',
  );
  if (otherRunning) throw new RecoveredFinalizationError(`outra tarefa RUNNING: ${otherRunning.id}`);
  if (task.status !== 'PASS' && task.accepted_commit !== null) {
    throw new RecoveredFinalizationError('tarefa READY não pode ter accepted_commit');
  }

  const existing = await readRecoveredFinalization(input.paths, input.taskId, input.sourceAttempt);
  if (existing) {
    if (
      existing.task_id !== input.taskId ||
      existing.source_attempt !== input.sourceAttempt ||
      existing.reason !== reason ||
      existing.commit_message !== commitMessage
    ) {
      throw new RecoveredFinalizationError('RecoveredFinalizationRecord diverge da solicitação');
    }
    const sealed = await sealRecoveredFinalization(
      input.paths,
      existing,
      input.afterCompletionWritten
        ? { afterCompletionWritten: input.afterCompletionWritten }
        : {},
    );
    await finishState(input, existing);
    return {
      record: existing,
      completion: sealed.completion,
      handoff: sealed.handoff,
      alreadyFinalized: task.status === 'PASS',
    };
  }

  if (task.status !== 'READY') {
    throw new RecoveredFinalizationError('PASS sem RecoveredFinalizationRecord correspondente');
  }
  if (state.authorized_head_sha === null) {
    throw new RecoveredFinalizationError('authorized_head_sha ausente');
  }
  if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
    throw new RecoveredFinalizationError('index contém mudanças staged antes da recuperação');
  }

  const source = await loadSourceEvidence(input.paths, input.taskId, input.sourceAttempt);
  assertRecoverable(source);
  const reportedFiles = exactReportedFiles(source.report);
  const finalizationBase = state.authorized_head_sha;
  let candidate = await headSha(input.paths.repoRoot);
  let validationResults: ValidationResult[];
  let validationEvidence: ValidationEvidence[];

  if (candidate === finalizationBase) {
    const actualFiles = await workingTreeFiles(input.paths.repoRoot);
    if (actualFiles.length === 0) {
      throw new RecoveredFinalizationError('working tree não contém alterações para recuperar');
    }
    assertExactFiles(actualFiles, reportedFiles);
    const validationBatch = await runOfficialValidations(input, ['git', 'diff', '--check']);
    validationResults = validationBatch.results;
    validationEvidence = validationBatch.evidence;

    if ((await headSha(input.paths.repoRoot)) !== finalizationBase) {
      throw new RecoveredFinalizationError('HEAD mudou durante as validações');
    }
    if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
      throw new RecoveredFinalizationError('index mudou durante as validações');
    }
    assertExactFiles(await workingTreeFiles(input.paths.repoRoot), reportedFiles);

    try {
      await stageFiles(input.paths.repoRoot, reportedFiles);
      await gitOrThrow(
        input.paths.repoRoot,
        ['commit', '-m', commitMessage],
        HARNESS_GIT_IDENTITY,
      );
    } catch (error) {
      await restoreStagedFiles(input.paths.repoRoot, reportedFiles).catch(() => undefined);
      throw new RecoveredFinalizationError(
        `falha ao criar recovery commit: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    candidate = await headSha(input.paths.repoRoot);
    await input.afterCommitCreated?.(candidate);
  } else {
    // Crash depois do commit e antes do recovery record: o mesmo comando pode
    // revalidar o commit já existente e continuar sem criar um segundo.
    if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
      throw new RecoveredFinalizationError('HEAD avançou e working tree não está limpa');
    }
    await assertCandidate(
      input.paths,
      candidate,
      finalizationBase,
      reportedFiles,
      commitMessage,
    );
    const validationBatch = await runOfficialValidations(input, [
      'git',
      'diff',
      '--check',
      `${finalizationBase}..${candidate}`,
    ]);
    validationResults = validationBatch.results;
    validationEvidence = validationBatch.evidence;
  }

  await assertCandidate(input.paths, candidate, finalizationBase, reportedFiles, commitMessage);
  if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
    throw new RecoveredFinalizationError('working tree não ficou limpa após recovery commit');
  }
  if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
    throw new RecoveredFinalizationError('index não ficou limpo após recovery commit');
  }

  const record = RecoveredFinalizationRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    source_attempt: input.sourceAttempt,
    source_base_sha: source.abandonment.source_base_sha,
    finalization_base_sha: finalizationBase,
    abandonment_record_sha256: source.abandonmentSha256,
    report_sha256: source.reportSha256,
    handoff_draft_sha256: source.handoffSha256,
    source_report_result: 'FAILURE',
    reason_code: source.abandonment.reason_code,
    reason,
    commit_message: commitMessage,
    changed_files: reportedFiles,
    validation_results: validationResults,
    validation_evidence: validationEvidence,
    candidate_commit: candidate,
    commit_origin: 'orchestrator_recovery',
    working_tree_clean: true,
    finalized_at: (input.now ?? (() => new Date().toISOString()))(),
  });

  await writeRecoveredFinalization(input.paths, record);
  await input.afterRecoveryWritten?.(record);
  const sealed = await sealRecoveredFinalization(
    input.paths,
    record,
    input.afterCompletionWritten
      ? { afterCompletionWritten: input.afterCompletionWritten }
      : {},
  );
  await finishState(input, record);
  return {
    record,
    completion: sealed.completion,
    handoff: sealed.handoff,
    alreadyFinalized: false,
  };
}
