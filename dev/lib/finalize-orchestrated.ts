import { readFile } from 'node:fs/promises';
import { canonicalJson, canonicalSha256, sha256Hex } from './canonical.js';
import type { CloseOutcome } from './close.js';
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
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { isSameProcessAlive } from './process-identity.js';
import {
  handoffDraftPath,
  readCloseManifest,
  readCompletion,
  readHandoff,
  readLaunchRecord,
  readOrchestratedFinalization,
  readPacket,
  reportPath,
  writeCloseManifest,
  writeCompletion,
  writeHandoff,
  writeOrchestratedFinalization,
} from './records.js';
import {
  AgentCompletionReport,
  CommitMessage,
  DEV_SCHEMA_VERSION,
  OrchestratedFinalizationRecord,
  parseHandoffDraft,
  type AgentCompletionReport as AgentCompletionReportType,
  type CompletionRecord,
  type DevelopmentState,
  type HandoffDraft,
  type HandoffRecord,
  type LaunchRecord,
  type OrchestratedFinalizationRecord as OrchestratedFinalizationRecordType,
  type OrchestratorEvidence,
  type TaskPacket,
  type ValidationCommand,
  type ValidationEvidence,
  type ValidationResult,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';
import { runOfficialValidation } from './validation-evidence.js';

export class OrchestratedFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratedFinalizationError';
  }
}

export type OrchestratedValidationRunner = (
  command: ValidationCommand,
  cwd: string,
) => Promise<ValidationResult>;

export interface FinalizeOrchestratedInput {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly taskId: string;
  readonly validationRunner?: OrchestratedValidationRunner;
  readonly now?: () => string;
  readonly afterCommitCreated?: (candidate: string) => Promise<void>;
  readonly afterFinalizationWritten?: (
    record: OrchestratedFinalizationRecordType,
  ) => Promise<void>;
  readonly afterCompletionWritten?: (completion: CompletionRecord) => Promise<void>;
}

interface SourceEvidence {
  readonly packet: TaskPacket;
  readonly launch: LaunchRecord;
  readonly report: AgentCompletionReportType;
  readonly reportSha256: string;
  readonly handoff: HandoffDraft;
  readonly handoffSha256: string;
  readonly files: string[];
}

const HARNESS_GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Agent Strategy Lab Harness',
  GIT_AUTHOR_EMAIL: 'harness@agent-strategy-lab.invalid',
  GIT_COMMITTER_NAME: 'Agent Strategy Lab Harness',
  GIT_COMMITTER_EMAIL: 'harness@agent-strategy-lab.invalid',
};

export function isForbiddenOrchestratedPath(file: string): boolean {
  if (file === 'dev/plan.yaml') return true;
  return ['.dev', '.dev-inbox', '.claude', '.agents', '.codex'].some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`),
  );
}

function exactFiles(files: readonly string[], label: string): string[] {
  const sorted = [...files].sort();
  if (sorted.length === 0) throw new OrchestratedFinalizationError(`${label} está vazio`);
  if (new Set(sorted).size !== sorted.length) {
    throw new OrchestratedFinalizationError(`${label} contém duplicatas`);
  }
  return sorted;
}

function assertExactFiles(actual: readonly string[], expected: readonly string[]): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new OrchestratedFinalizationError(
      `arquivos reais divergem do report: real [${left.join(', ')}], report [${right.join(', ')}]`,
    );
  }
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OrchestratedFinalizationError(`${label} ausente`);
    }
    throw error;
  }
}

function parseJson<T>(file: string, bytes: Buffer, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new OrchestratedFinalizationError(
      `${file} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadSource(input: FinalizeOrchestratedInput): Promise<SourceEvidence> {
  const packet = await readPacket(input.paths, input.taskId);
  if (!packet) throw new OrchestratedFinalizationError('TaskPacket ausente');
  const planTask = input.loaded.byId.get(input.taskId);
  if (!planTask) throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  if (canonicalJson(packet.validation) !== canonicalJson(planTask.validation)) {
    throw new OrchestratedFinalizationError('validações do TaskPacket divergem do plano autoritativo');
  }
  const launch = await readLaunchRecord(input.paths, input.taskId);
  if (!launch) throw new OrchestratedFinalizationError('LaunchRecord ausente');
  if (launch.task_id !== input.taskId) {
    throw new OrchestratedFinalizationError(`LaunchRecord pertence a ${launch.task_id}`);
  }
  if (launch.finished_at === null || launch.duration_ms === null) {
    throw new OrchestratedFinalizationError('LaunchRecord não está finalizado');
  }
  if (launch.survivors_remaining.length > 0 || (await isSameProcessAlive(launch.process))) {
    throw new OrchestratedFinalizationError('processo do worker ainda está vivo');
  }
  if (launch.execution_policy.commit_owner !== 'orchestrator') {
    throw new OrchestratedFinalizationError('LaunchRecord não pertence ao modo orchestrator-owned');
  }

  const reportFile = reportPath(input.paths, input.taskId);
  const handoffFile = handoffDraftPath(input.paths, input.taskId);
  const [reportBytes, handoffBytes] = await Promise.all([
    readRequired(reportFile, 'AgentCompletionReport'),
    readRequired(handoffFile, 'HandoffDraft'),
  ]);
  const report = parseJson(reportFile, reportBytes, (value) => AgentCompletionReport.parse(value));
  const handoff = parseJson(handoffFile, handoffBytes, parseHandoffDraft);
  for (const [label, taskId] of [
    ['TaskPacket', packet.task_id],
    ['AgentCompletionReport', report.task_id],
    ['HandoffDraft', handoff.task_id],
  ] as const) {
    if (taskId !== input.taskId) {
      throw new OrchestratedFinalizationError(`${label} pertence a outra tarefa: ${taskId}`);
    }
  }
  if (report.candidate_commit !== null) {
    throw new OrchestratedFinalizationError('report.candidate_commit deve ser null');
  }
  const expectedDraftResult = report.self_reported_result === 'SUCCESS' ? 'PASS' : 'FAIL';
  if (handoff.result !== expectedDraftResult) {
    throw new OrchestratedFinalizationError('resultado do HandoffDraft diverge do report');
  }
  const files = exactFiles(report.changed_files, 'report.changed_files');
  const forbidden = files.find(isForbiddenOrchestratedPath);
  if (forbidden) throw new OrchestratedFinalizationError(`caminho proibido: ${forbidden}`);
  return {
    packet,
    launch,
    report,
    reportSha256: sha256Hex(reportBytes),
    handoff,
    handoffSha256: sha256Hex(handoffBytes),
    files,
  };
}

function commitMessageFor(input: FinalizeOrchestratedInput): string {
  const task = input.loaded.byId.get(input.taskId);
  if (!task) throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  return CommitMessage.parse(`feat(${task.id}): ${task.title}`);
}

async function runOfficialValidations(
  input: FinalizeOrchestratedInput,
  packet: TaskPacket,
  attempt: number,
): Promise<{ results: ValidationResult[]; evidence: ValidationEvidence[] }> {
  const commands = input.loaded.byId.get(input.taskId)?.validation;
  if (!commands) throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  const results: ValidationResult[] = [];
  const validationEvidence: ValidationEvidence[] = [];
  if (canonicalJson(commands) !== canonicalJson(packet.validation)) {
    throw new OrchestratedFinalizationError('validações do packet não correspondem ao plano');
  }
  for (const command of commands) {
    const execution = input.validationRunner
      ? { result: await input.validationRunner(command, input.paths.repoRoot), evidence: null }
      : await runOfficialValidation({
          paths: input.paths,
          taskId: input.taskId,
          attempt,
          command,
        });
    const result = execution.result;
    if (canonicalJson(result.argv) !== canonicalJson(command.argv)) {
      throw new OrchestratedFinalizationError('validation runner retornou argv divergente');
    }
    results.push(result);
    if (execution.evidence) validationEvidence.push(execution.evidence);
  }
  return { results, evidence: validationEvidence };
}

async function cachedDiffCheck(
  input: FinalizeOrchestratedInput,
  attempt: number,
) {
  return runOfficialValidation({
    paths: input.paths,
    taskId: input.taskId,
    attempt,
    command: { argv: ['git', 'diff', '--cached', '--check'], timeout_seconds: 300 },
  });
}

async function committedDiffCheck(
  input: FinalizeOrchestratedInput,
  attempt: number,
  base: string,
  candidate: string,
){
  const argv = ['git', 'diff', '--check', `${base}..${candidate}`];
  return runOfficialValidation({
    paths: input.paths,
    taskId: input.taskId,
    attempt,
    command: { argv, timeout_seconds: 300 },
  });
}

async function assertCandidate(
  paths: HarnessPaths,
  candidate: string,
  base: string,
  files: readonly string[],
  message: string,
  expectedTree?: string,
): Promise<void> {
  if (!(await commitExists(paths.repoRoot, candidate))) {
    throw new OrchestratedFinalizationError(`candidate não existe: ${candidate}`);
  }
  const parents = await parentShas(paths.repoRoot, candidate);
  if (parents.length !== 1 || parents[0] !== base) {
    throw new OrchestratedFinalizationError('candidate não tem exatamente o base como único parent');
  }
  assertExactFiles(await changedFiles(paths.repoRoot, candidate), files);
  if ((await recordedCommitMessage(paths.repoRoot, candidate)) !== message) {
    throw new OrchestratedFinalizationError('mensagem do candidate diverge da mensagem derivada');
  }
  if (expectedTree !== undefined && (await commitTree(paths.repoRoot, candidate)) !== expectedTree) {
    throw new OrchestratedFinalizationError('tree do candidate diverge do conteúdo validado e staged');
  }
}

function evidence(
  source: SourceEvidence,
  validations: readonly ValidationResult[],
  timestamp: string,
  candidate: string | null,
  accepted: string | null,
  clean: boolean,
  validationEvidence: readonly ValidationEvidence[] = [],
): OrchestratorEvidence {
  return {
    task_id: source.packet.task_id,
    base_sha: source.packet.base_sha,
    candidate_commit: candidate,
    accepted_commit: accepted,
    changed_files: [...source.files],
    working_tree_clean: clean,
    process: source.launch.process,
    duration_ms: source.launch.duration_ms ?? 0,
    exit_code: source.launch.exit_code,
    timed_out: source.launch.timed_out,
    revalidation: [...validations],
    ...(validationEvidence.length === 0
      ? {}
      : { validation_evidence: [...validationEvidence] }),
    observed_at: timestamp,
  };
}

function discrepancies(source: SourceEvidence): string[] {
  const result: string[] = [];
  if (canonicalJson([...source.handoff.changed_files].sort()) !== canonicalJson(source.files)) {
    result.push('changed_files do HandoffDraft diverge dos arquivos reais');
  }
  return result;
}

function closeOutcome(
  kind: 'PASS' | 'FAIL' | 'PENDING',
  taskId: string,
  reason: string,
  completion: CompletionRecord | null,
  handoff: HandoffRecord | null,
  differences: readonly string[] = [],
): CloseOutcome {
  return { kind, taskId, reason, completion, handoff, discrepancies: differences };
}

async function stayPending(
  paths: HarnessPaths,
  state: DevelopmentState,
  taskId: string,
  reason: string,
): Promise<CloseOutcome> {
  await writeState(paths, withTaskState(state, taskId, { diagnostics: reason }));
  return closeOutcome('PENDING', taskId, reason, null, null);
}

async function finishFail(
  input: FinalizeOrchestratedInput,
  state: DevelopmentState,
  source: SourceEvidence,
  reason: string,
  validations: readonly ValidationResult[],
  validationEvidence: readonly ValidationEvidence[] = [],
): Promise<CloseOutcome> {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const differences = discrepancies(source);
  const completion: CompletionRecord = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    status: 'FAIL',
    report: source.report,
    orchestrator_evidence: evidence(
      source,
      validations,
      timestamp,
      null,
      null,
      false,
      validationEvidence,
    ),
    report_matches_evidence: differences.length === 0,
    discrepancies: differences,
    finalization_mode: 'normal',
    closed_at: timestamp,
  };
  await writeCompletion(input.paths, completion);
  await writeState(
    input.paths,
    withTaskState(state, input.taskId, {
      status: 'FAIL',
      phase: null,
      candidate_commit: null,
      accepted_commit: null,
      diagnostics: reason,
      finished_at: timestamp,
    }),
  );
  return closeOutcome('FAIL', input.taskId, reason, completion, null, differences);
}

function deterministicCompletion(
  record: OrchestratedFinalizationRecordType,
  source: SourceEvidence,
): CompletionRecord {
  const differences = discrepancies(source);
  return {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    status: 'PASS',
    report: source.report,
    orchestrator_evidence: evidence(
      source,
      record.validation_results,
      record.finalized_at,
      record.candidate_commit,
      record.candidate_commit,
      true,
      record.validation_evidence ?? [],
    ),
    report_matches_evidence: differences.length === 0,
    discrepancies: differences,
    finalization_mode: 'normal',
    commit_origin: 'orchestrator',
    orchestrated_finalization_attempt: record.attempt,
    orchestrated_finalization_record_sha256: canonicalSha256(record),
    closed_at: record.finalized_at,
  };
}

function deterministicHandoff(
  record: OrchestratedFinalizationRecordType,
  source: SourceEvidence,
): HandoffRecord {
  return {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    result: 'PASS',
    changed_files: [...record.changed_files],
    validations: [...record.validation_results],
    decisions: [...source.handoff.decisions],
    lessons: [...source.handoff.lessons],
    next_relevant_files: [...source.handoff.next_relevant_files],
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
    throw new OrchestratedFinalizationError(`${label} existente diverge do finalization record`);
  }
}

export async function verifyOrchestratedFinalizationRecord(
  input: FinalizeOrchestratedInput,
  record: OrchestratedFinalizationRecordType,
): Promise<SourceEvidence> {
  OrchestratedFinalizationRecord.parse(record);
  const source = await loadSource(input);
  if (
    record.task_id !== input.taskId ||
    record.base_sha !== source.packet.base_sha ||
    record.profile_id !== source.launch.profile_id ||
    canonicalJson(record.execution_policy) !== canonicalJson(source.launch.execution_policy) ||
    record.report_sha256 !== source.reportSha256 ||
    record.handoff_draft_sha256 !== source.handoffSha256
  ) {
    throw new OrchestratedFinalizationError('OrchestratedFinalizationRecord diverge das fontes');
  }
  assertExactFiles(record.changed_files, source.files);
  await assertCandidate(
    input.paths,
    record.candidate_commit,
    record.base_sha,
    record.changed_files,
    record.commit_message,
  );
  if (!(await isWorkingTreeClean(input.paths.repoRoot)) || (await stagedFiles(input.paths.repoRoot)).length > 0) {
    throw new OrchestratedFinalizationError('candidate existe, mas checkout ou index não está limpo');
  }
  return source;
}

export async function sealOrchestratedFinalization(
  input: FinalizeOrchestratedInput,
  record: OrchestratedFinalizationRecordType,
): Promise<{ completion: CompletionRecord; handoff: HandoffRecord }> {
  const source = await verifyOrchestratedFinalizationRecord(input, record);
  const completion = deterministicCompletion(record, source);
  const handoff = deterministicHandoff(record, source);
  await assertOrWrite(
    'CompletionRecord',
    await readCompletion(input.paths, input.taskId),
    completion,
    () => writeCompletion(input.paths, completion),
  );
  await input.afterCompletionWritten?.(completion);
  await assertOrWrite(
    'HandoffRecord',
    await readHandoff(input.paths, input.taskId),
    handoff,
    () => writeHandoff(input.paths, handoff),
  );
  const manifest = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    accepted_commit: record.candidate_commit,
    completion_sha256: canonicalSha256(completion),
    handoff_sha256: canonicalSha256(handoff),
    sealed_at: record.finalized_at,
  } as const;
  await assertOrWrite(
    'CloseManifest',
    await readCloseManifest(input.paths, input.taskId),
    manifest,
    () => writeCloseManifest(input.paths, manifest),
  );
  return { completion, handoff };
}

async function promoteState(
  input: FinalizeOrchestratedInput,
  record: OrchestratedFinalizationRecordType,
): Promise<void> {
  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  if (task.status !== 'RUNNING' && task.status !== 'PASS') {
    throw new OrchestratedFinalizationError(`state ${task.status} não pode ser promovido a PASS`);
  }
  let updated = withTaskState(state, input.taskId, {
    status: 'PASS',
    phase: null,
    candidate_commit: record.candidate_commit,
    accepted_commit: record.candidate_commit,
    diagnostics: null,
    finished_at: record.finalized_at,
  });
  updated = { ...updated, authorized_head_sha: record.candidate_commit };
  await writeState(input.paths, updated);
}

export async function finalizeOrchestratedTask(
  input: FinalizeOrchestratedInput,
): Promise<CloseOutcome> {
  let state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  if (!input.loaded.byId.has(input.taskId)) {
    throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  }
  const existing =
    task.attempts > 0
      ? await readOrchestratedFinalization(input.paths, input.taskId, task.attempts)
      : null;
  if (existing) {
    const sealed = await sealOrchestratedFinalization(input, existing);
    await promoteState(input, existing);
    return closeOutcome(
      'PASS',
      input.taskId,
      task.status === 'PASS' ? 'já fechada anteriormente' : 'selagem retomada',
      sealed.completion,
      sealed.handoff,
      sealed.completion.discrepancies,
    );
  }
  if (task.status === 'PASS') {
    throw new OrchestratedFinalizationError('PASS sem OrchestratedFinalizationRecord correspondente');
  }
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING') {
    return stayPending(
      input.paths,
      state,
      input.taskId,
      `tarefa está ${task.status}/${task.phase ?? 'sem fase'}, não RUNNING/FINALIZING`,
    );
  }
  if (state.tasks.some((candidate) => candidate.id !== input.taskId && candidate.status === 'RUNNING')) {
    return stayPending(input.paths, state, input.taskId, 'outra tarefa está RUNNING');
  }

  let source: SourceEvidence;
  try {
    source = await loadSource(input);
  } catch (error) {
    return stayPending(
      input.paths,
      state,
      input.taskId,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (source.packet.base_sha !== task.base_sha || source.packet.base_sha !== state.authorized_head_sha) {
    return stayPending(input.paths, state, input.taskId, 'base SHA do packet/state não é autorizada');
  }
  if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
    return stayPending(input.paths, state, input.taskId, 'index contém mudanças staged prévias');
  }

  const message = commitMessageFor(input);
  let currentHead = await headSha(input.paths.repoRoot);
  if (currentHead !== source.packet.base_sha) {
    try {
      if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
        throw new OrchestratedFinalizationError('HEAD avançou e working tree não está limpa');
      }
      await assertCandidate(
        input.paths,
        currentHead,
        source.packet.base_sha,
        source.files,
        message,
      );
      const validationBatch = await runOfficialValidations(input, source.packet, task.attempts);
      const validationResults = validationBatch.results;
      const validationEvidence = validationBatch.evidence;
      const diffExecution = await committedDiffCheck(
        input,
        task.attempts,
        source.packet.base_sha,
        currentHead,
      );
      validationResults.push(diffExecution.result);
      validationEvidence.push(diffExecution.evidence);
      const failed = validationResults.find((result) => result.exit_code !== 0 || result.timed_out);
      if (failed) {
        throw new OrchestratedFinalizationError(
          `validação do candidate retomado falhou: ${failed.argv.join(' ')}`,
        );
      }
      const record = OrchestratedFinalizationRecord.parse({
        schema_version: DEV_SCHEMA_VERSION,
        task_id: input.taskId,
        attempt: task.attempts,
        base_sha: source.packet.base_sha,
        profile_id: source.launch.profile_id,
        execution_policy: source.launch.execution_policy,
        report_sha256: source.reportSha256,
        handoff_draft_sha256: source.handoffSha256,
        report_result: 'SUCCESS',
        report_candidate_commit: null,
        commit_message: message,
        changed_files: source.files,
        validation_results: validationResults,
        validation_evidence: validationEvidence,
        patch_fingerprint: sha256Hex(await commitTree(input.paths.repoRoot, currentHead)),
        candidate_commit: currentHead,
        commit_origin: 'orchestrator',
        finalized_at: (input.now ?? (() => new Date().toISOString()))(),
      });
      await writeOrchestratedFinalization(input.paths, record);
      await input.afterFinalizationWritten?.(record);
      const sealed = await sealOrchestratedFinalization(input, record);
      await promoteState(input, record);
      return closeOutcome('PASS', input.taskId, 'candidate retomado e aceito', sealed.completion, sealed.handoff);
    } catch (error) {
      return stayPending(
        input.paths,
        state,
        input.taskId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  let actualFiles: string[];
  try {
    actualFiles = await workingTreeFiles(input.paths.repoRoot);
    assertExactFiles(actualFiles, source.files);
    if (actualFiles.length === 0) throw new OrchestratedFinalizationError('working tree sem alterações');
  } catch (error) {
    return stayPending(
      input.paths,
      state,
      input.taskId,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (source.report.self_reported_result === 'FAILURE') {
    return finishFail(input, state, source, 'worker reportou FAILURE', []);
  }

  const fingerprintBefore = await patchFingerprint(input.paths.repoRoot);
  const validationBatch = await runOfficialValidations(input, source.packet, task.attempts);
  const validationResults = validationBatch.results;
  const validationEvidence = validationBatch.evidence;
  const fingerprintAfter = await patchFingerprint(input.paths.repoRoot);
  const stagedByValidation = await stagedFiles(input.paths.repoRoot);
  if (stagedByValidation.length > 0) {
    await restoreStagedFiles(input.paths.repoRoot, stagedByValidation);
  }
  const failed = validationResults.find((result) => result.exit_code !== 0 || result.timed_out);
  if (failed) {
    return finishFail(
      input,
      state,
      source,
      `validação oficial falhou: ${failed.argv.join(' ')} (exit ${failed.exit_code ?? 'null'})`,
      validationResults,
      validationEvidence,
    );
  }
  if (fingerprintBefore !== fingerprintAfter) {
    return finishFail(
      input,
      state,
      source,
      'patch fingerprint mudou durante as validações oficiais',
      validationResults,
      validationEvidence,
    );
  }
  if (stagedByValidation.length > 0) {
    return finishFail(
      input,
      state,
      source,
      'index mudou durante as validações e foi restaurado',
      validationResults,
      validationEvidence,
    );
  }
  currentHead = await headSha(input.paths.repoRoot);
  if (currentHead !== source.packet.base_sha) {
    return finishFail(
      input,
      state,
      source,
      'HEAD mudou durante as validações',
      validationResults,
      validationEvidence,
    );
  }
  if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
    return finishFail(
      input,
      state,
      source,
      'index mudou durante as validações',
      validationResults,
      validationEvidence,
    );
  }
  try {
    assertExactFiles(await workingTreeFiles(input.paths.repoRoot), source.files);
  } catch (error) {
    return finishFail(
      input,
      state,
      source,
      error instanceof Error ? error.message : String(error),
      validationResults,
      validationEvidence,
    );
  }

  await stageFiles(input.paths.repoRoot, source.files);
  try {
    assertExactFiles(await stagedFiles(input.paths.repoRoot), source.files);
    const diffExecution = await cachedDiffCheck(input, task.attempts);
    const diffCheck = diffExecution.result;
    validationResults.push(diffCheck);
    validationEvidence.push(diffExecution.evidence);
    if (diffCheck.exit_code !== 0 || diffCheck.timed_out) {
      await restoreStagedFiles(input.paths.repoRoot, source.files);
      if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
        throw new OrchestratedFinalizationError('falha ao restaurar index após cached diff-check');
      }
      return finishFail(
        input,
        state,
        source,
        'git diff --cached --check falhou; index restaurado',
        validationResults,
        validationEvidence,
      );
    }
    const stagedTree = await writeTree(input.paths.repoRoot);
    await gitOrThrow(input.paths.repoRoot, ['commit', '-m', message], HARNESS_GIT_IDENTITY);
    currentHead = await headSha(input.paths.repoRoot);
    await input.afterCommitCreated?.(currentHead);
    await assertCandidate(
      input.paths,
      currentHead,
      source.packet.base_sha,
      source.files,
      message,
      stagedTree,
    );
  } catch (error) {
    if ((await headSha(input.paths.repoRoot)) === source.packet.base_sha) {
      await restoreStagedFiles(input.paths.repoRoot, source.files).catch(() => undefined);
    }
    throw error;
  }
  if (!(await isWorkingTreeClean(input.paths.repoRoot)) || (await stagedFiles(input.paths.repoRoot)).length > 0) {
    throw new OrchestratedFinalizationError('candidate não deixou working tree e index limpos');
  }

  const record = OrchestratedFinalizationRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    attempt: task.attempts,
    base_sha: source.packet.base_sha,
    profile_id: source.launch.profile_id,
    execution_policy: source.launch.execution_policy,
    report_sha256: source.reportSha256,
    handoff_draft_sha256: source.handoffSha256,
    report_result: 'SUCCESS',
    report_candidate_commit: null,
    commit_message: message,
    changed_files: source.files,
    validation_results: validationResults,
    validation_evidence: validationEvidence,
    patch_fingerprint: fingerprintBefore,
    candidate_commit: currentHead,
    commit_origin: 'orchestrator',
    finalized_at: (input.now ?? (() => new Date().toISOString()))(),
  });
  await writeOrchestratedFinalization(input.paths, record);
  await input.afterFinalizationWritten?.(record);
  const sealed = await sealOrchestratedFinalization(input, record);
  await promoteState(input, record);
  return closeOutcome('PASS', input.taskId, 'aceita', sealed.completion, sealed.handoff, sealed.completion.discrepancies);
}
