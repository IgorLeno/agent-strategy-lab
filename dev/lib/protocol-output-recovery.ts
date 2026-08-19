import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { writeFileOnce } from './atomic.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  assertRepoRelativePath,
  preserveFailedAttemptBundle,
  resetFilesToBase,
  type PreservedBundle,
} from './failed-attempt-bundle.js';
import { isForbiddenOrchestratedPath } from './finalize-orchestrated.js';
import {
  headSha,
  isWorkingTreeClean,
  patchFingerprint,
  stagedFiles,
  workingTreeFiles,
  workingTreeSnapshot,
} from './git.js';
import {
  InboxArtifactError,
  archiveInboxArtifacts,
  releaseCurrentInboxArtifacts,
  type InboxReleaseHooks,
} from './inbox-artifacts.js';
import type { HarnessPaths } from './paths.js';
import { isSameProcessAlive } from './process-identity.js';
import {
  completionPath,
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  handoffDraftPath,
  infraFailedAttemptPath,
  launchRecordPath,
  protocolInvalidAttemptPath,
  protocolInvalidEvidencePath,
  protocolInvalidPatchFilePath,
  readProtocolInvalidAttempt,
  reportPath,
  validationFailedAttemptPath,
  writeProtocolInvalidAttempt,
} from './records.js';
import {
  AgentCompletionReport,
  DEV_SCHEMA_VERSION,
  LaunchRecord,
  ProtocolInvalidAttemptRecord,
  parseHandoffDraft,
  type ArchivedEvidenceFile,
  type DevelopmentState,
  type HandoffDraft,
  type ProtocolInvalidAttemptRecord as ProtocolInvalidAttemptRecordType,
  type ProtocolInvalidPatchFile,
  type TaskState,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';

/** Recovery específico para output SUCCESS/PASS com metadata de protocolo inválida. */
export class ProtocolOutputRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolOutputRecoveryError';
  }
}

export interface ProtocolOutputRecoveryInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reason: string;
  readonly now?: () => string;
  /** Crash antes do manifesto terminal: nada pode ter sido limpo. */
  readonly afterPatchFilesArchived?: () => Promise<void>;
  /** Crash depois de toda a evidência e antes de qualquer cleanup. */
  readonly afterRecordWritten?: (record: ProtocolInvalidAttemptRecordType) => Promise<void>;
  /** Crash depois do reset path-scoped e antes do state READY. */
  readonly afterPatchReset?: (record: ProtocolInvalidAttemptRecordType) => Promise<void>;
  readonly inboxReleaseHooks?: InboxReleaseHooks;
}

export interface ProtocolOutputRecoveryResult {
  readonly record: ProtocolInvalidAttemptRecordType;
  readonly recordPath: string;
  readonly state: DevelopmentState;
  readonly bundle: PreservedBundle | null;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly alreadyArchived: boolean;
  readonly releasedCurrentInbox: boolean;
}

interface NewSource {
  readonly state: DevelopmentState;
  readonly task: TaskState;
  readonly launch: LaunchRecord;
  readonly launchBytes: Buffer;
  readonly reportBytes: Buffer;
  readonly handoffBytes: Buffer;
  readonly report: AgentCompletionReport;
  readonly handoff: HandoffDraft;
  readonly protocolInvalidPaths: string[];
  readonly files: string[];
  readonly fingerprint: string;
}

function relativeToDev(paths: HarnessPaths, file: string): string {
  return path.relative(paths.devDir, file).split(path.sep).join('/');
}

function relativeToRepo(paths: HarnessPaths, file: string): string {
  const relative = path.relative(paths.repoRoot, file).split(path.sep).join('/');
  assertRepoRelativePath(relative);
  return relative;
}

/** Recusa estreita: o worker morreu sem o par de completion artifacts. */
export function isMissingWorkerCompletionArtifact(error: unknown): boolean {
  if (!(error instanceof ProtocolOutputRecoveryError)) return false;
  return (
    error.message === 'AgentCompletionReport ausente' || error.message === 'HandoffDraft ausente'
  );
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProtocolOutputRecoveryError(`${label} ausente`);
    }
    throw error;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseJson<T>(label: string, bytes: Buffer, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new ProtocolOutputRecoveryError(
      `${label} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function exactUniqueFiles(files: readonly string[], label: string): string[] {
  if (files.length === 0) throw new ProtocolOutputRecoveryError(`${label} vazio`);
  const unique = [...new Set(files)];
  if (unique.length !== files.length) {
    throw new ProtocolOutputRecoveryError(`${label} contém paths duplicados`);
  }
  for (const file of unique) assertRepoRelativePath(file);
  return unique;
}

function expectedProtocolPaths(paths: HarnessPaths, taskId: string): string[] {
  return [
    relativeToRepo(paths, handoffDraftPath(paths, taskId)),
    relativeToRepo(paths, reportPath(paths, taskId)),
  ].sort();
}

async function assertCommonPreconditions(
  state: DevelopmentState,
  task: TaskState,
  paths: HarnessPaths,
  taskId: string,
): Promise<string> {
  const otherRunning = state.tasks.find(
    (candidate) => candidate.id !== taskId && candidate.status === 'RUNNING',
  );
  if (otherRunning) {
    throw new ProtocolOutputRecoveryError(`outra tarefa RUNNING: ${otherRunning.id}`);
  }
  if (task.attempts < 1) throw new ProtocolOutputRecoveryError('attempt ausente');
  if (task.candidate_commit !== null) {
    throw new ProtocolOutputRecoveryError('candidate_commit precisa ser null');
  }
  if (task.accepted_commit !== null) {
    throw new ProtocolOutputRecoveryError('accepted_commit precisa ser null');
  }
  if (task.base_sha === null) throw new ProtocolOutputRecoveryError('base_sha ausente');
  if (state.authorized_head_sha === null) {
    throw new ProtocolOutputRecoveryError('authorized_head_sha ausente');
  }
  const head = await headSha(paths.repoRoot);
  if (head !== task.base_sha || head !== state.authorized_head_sha) {
    throw new ProtocolOutputRecoveryError(
      `HEAD ${head} diverge de base_sha ${task.base_sha} ou authorized_head_sha ${state.authorized_head_sha}`,
    );
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new ProtocolOutputRecoveryError('index contém mudanças staged');
  }
  return head;
}

async function loadNewSource(input: ProtocolOutputRecoveryInput): Promise<NewSource> {
  const { paths, taskId } = input;
  const state = await readState(paths);
  const task = getTaskState(state, taskId);
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING') {
    throw new ProtocolOutputRecoveryError(
      `dev-recover-protocol-output exige RUNNING/FINALIZING, encontrada ${task.status}${
        task.phase === null ? '' : `/${task.phase}`
      }`,
    );
  }
  if (task.process === null) throw new ProtocolOutputRecoveryError('processo registrado ausente');
  if (await isSameProcessAlive(task.process)) {
    throw new ProtocolOutputRecoveryError('processo registrado ainda está vivo');
  }
  await assertCommonPreconditions(state, task, paths, taskId);

  if (await exists(completionPath(paths, taskId))) {
    throw new ProtocolOutputRecoveryError('CompletionRecord presente; recovery recusado');
  }
  if (await exists(validationFailedAttemptPath(paths, taskId, task.attempts))) {
    throw new ProtocolOutputRecoveryError('ValidationFailedAttemptRecord presente; recovery recusado');
  }
  if (await exists(infraFailedAttemptPath(paths, taskId, task.attempts))) {
    throw new ProtocolOutputRecoveryError('InfraFailedAttemptRecord presente; recovery recusado');
  }

  const launchFile = launchRecordPath(paths, taskId);
  const launchBytes = await readRequired(launchFile, 'LaunchRecord');
  const launch = parseJson('LaunchRecord', launchBytes, (value) => LaunchRecord.parse(value));
  if (launch.task_id !== taskId) {
    throw new ProtocolOutputRecoveryError(`LaunchRecord pertence a ${launch.task_id}`);
  }
  if (launch.finished_at === null) {
    throw new ProtocolOutputRecoveryError('LaunchRecord ainda não foi finalizado');
  }
  if (canonicalJson(launch.process) !== canonicalJson(task.process)) {
    throw new ProtocolOutputRecoveryError('processo do LaunchRecord diverge do state');
  }
  if (
    launch.execution_policy.commit_owner !== 'orchestrator' ||
    launch.execution_policy.official_validation_owner !== 'orchestrator'
  ) {
    throw new ProtocolOutputRecoveryError('execution_policy não pertence ao orquestrador');
  }

  const reportBytes = await readRequired(reportPath(paths, taskId), 'AgentCompletionReport');
  const handoffBytes = await readRequired(handoffDraftPath(paths, taskId), 'HandoffDraft');
  const report = parseJson('AgentCompletionReport', reportBytes, (value) =>
    AgentCompletionReport.parse(value),
  );
  const handoff = parseJson('HandoffDraft', handoffBytes, parseHandoffDraft);
  if (report.task_id !== taskId || handoff.task_id !== taskId) {
    throw new ProtocolOutputRecoveryError('output do worker pertence a outra tarefa');
  }
  if (report.self_reported_result !== 'SUCCESS') {
    throw new ProtocolOutputRecoveryError('recovery exige report SUCCESS');
  }
  if (report.candidate_commit !== null) {
    throw new ProtocolOutputRecoveryError('report.candidate_commit deve ser null');
  }
  if (handoff.result !== 'PASS') {
    throw new ProtocolOutputRecoveryError('recovery exige handoff PASS');
  }
  if (canonicalJson(report.changed_files) !== canonicalJson(handoff.changed_files)) {
    throw new ProtocolOutputRecoveryError('changed_files do report e handoff divergem');
  }

  const declared = exactUniqueFiles(report.changed_files, 'changed_files');
  const protocolInvalidPaths = declared.filter(isForbiddenOrchestratedPath).sort();
  const expected = expectedProtocolPaths(paths, taskId);
  if (canonicalJson(protocolInvalidPaths) !== canonicalJson(expected)) {
    throw new ProtocolOutputRecoveryError(
      `paths de protocolo/proibidos devem ser exatamente [${expected.join(', ')}], encontrados [${protocolInvalidPaths.join(', ')}]`,
    );
  }
  const files = declared.filter((file) => !isForbiddenOrchestratedPath(file)).sort();
  if (files.length === 0) throw new ProtocolOutputRecoveryError('patch normalizado vazio');
  const actual = await workingTreeFiles(paths.repoRoot);
  if (canonicalJson(actual) !== canonicalJson(files)) {
    throw new ProtocolOutputRecoveryError(
      `working tree diverge do patch real normalizado: real [${actual.join(', ')}], report [${files.join(', ')}]`,
    );
  }
  const fingerprint = await patchFingerprint(paths.repoRoot);
  return {
    state,
    task,
    launch,
    launchBytes,
    reportBytes,
    handoffBytes,
    report,
    handoff,
    protocolInvalidPaths,
    files,
    fingerprint,
  };
}

async function currentGitBytes(repoRoot: string, file: string): Promise<Buffer | null> {
  const absolute = path.join(repoRoot, file);
  try {
    const metadata = await lstat(absolute);
    return metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolute), 'utf8')
      : await readFile(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function evidenceRef(paths: HarnessPaths, source: string, destination: string, bytes: Buffer): ArchivedEvidenceFile {
  return {
    path: relativeToDev(paths, destination),
    source_path: relativeToDev(paths, source),
    sha256: sha256Hex(bytes),
    size_bytes: bytes.byteLength,
  };
}

async function archivePatchFiles(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  files: readonly string[],
): Promise<ProtocolInvalidPatchFile[]> {
  const snapshot = await workingTreeSnapshot(paths.repoRoot);
  const statuses = new Map<string, string>();
  for (const entry of snapshot) {
    statuses.set(entry.path, entry.status);
    if (entry.originalPath !== null) statuses.set(entry.originalPath, entry.status);
  }
  const archived: ProtocolInvalidPatchFile[] = [];
  for (const file of files) {
    const gitStatus = statuses.get(file);
    if (gitStatus === undefined) {
      throw new ProtocolOutputRecoveryError(`status Git ausente para ${file}`);
    }
    const bytes = await currentGitBytes(paths.repoRoot, file);
    if (bytes === null) {
      archived.push({
        path: file,
        git_status: gitStatus,
        content_state: 'ABSENT',
        archive_path: null,
        size_bytes: null,
        sha256: null,
      });
      continue;
    }
    const destination = protocolInvalidPatchFilePath(paths, taskId, attempt, file);
    await writeFileOnce(destination, bytes);
    archived.push({
      path: file,
      git_status: gitStatus,
      content_state: 'ARCHIVED',
      archive_path: relativeToDev(paths, destination),
      size_bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
    });
  }
  return archived;
}

async function archiveNewSource(
  input: ProtocolOutputRecoveryInput,
  source: NewSource,
): Promise<{ record: ProtocolInvalidAttemptRecordType; bundle: PreservedBundle }> {
  const { paths, taskId } = input;
  const attempt = source.task.attempts;
  let inboxArchive;
  try {
    inboxArchive = await archiveInboxArtifacts({
      paths,
      taskId,
      attempt,
      bytes: { report: source.reportBytes, handoff: source.handoffBytes },
      expected: {
        reportSha256: sha256Hex(source.reportBytes),
        handoffDraftSha256: sha256Hex(source.handoffBytes),
      },
    });
  } catch (error) {
    if (error instanceof InboxArtifactError) throw new ProtocolOutputRecoveryError(error.message);
    throw error;
  }

  const launchDestination = protocolInvalidEvidencePath(paths, taskId, attempt, 'launch.json');
  await writeFileOnce(launchDestination, source.launchBytes);
  const patchFiles = await archivePatchFiles(paths, taskId, attempt, source.files);
  await input.afterPatchFilesArchived?.();

  const bundle = await preserveFailedAttemptBundle({
    paths,
    taskId,
    attempt,
    baseSha: source.task.base_sha as string,
    files: source.files,
    patchFingerprint: source.fingerprint,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  const record = ProtocolInvalidAttemptRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: taskId,
    attempt,
    classification: 'PROTOCOL_OUTPUT_INVALID',
    reason_code: 'PROTOCOL_OUTPUT_INVALID',
    reason: input.reason.trim(),
    source_base_sha: source.task.base_sha,
    head_sha: source.task.base_sha,
    authorized_head_sha: source.state.authorized_head_sha,
    profile_id: source.launch.profile_id,
    execution_policy: source.launch.execution_policy,
    process: source.launch.process,
    launch_id: source.launch.launch_id,
    launch_record: evidenceRef(
      paths,
      launchRecordPath(paths, taskId),
      launchDestination,
      source.launchBytes,
    ),
    worker_self_reported_result: 'SUCCESS',
    handoff_result: 'PASS',
    report_candidate_commit: null,
    state_candidate_commit: null,
    state_accepted_commit: null,
    protocol_invalid_paths: source.protocolInvalidPaths,
    changed_files: source.files,
    actual_patch_matches_normalized_report: true,
    patch_fingerprint: source.fingerprint,
    patch_files: patchFiles,
    change_bundle: bundle.ref,
    report: evidenceRef(
      paths,
      reportPath(paths, taskId),
      inboxArchive.reportPath,
      source.reportBytes,
    ),
    handoff_draft: evidenceRef(
      paths,
      handoffDraftPath(paths, taskId),
      inboxArchive.handoffPath,
      source.handoffBytes,
    ),
    capability_verdict: null,
    official_validation_verdict: null,
    attempts_preserved: attempt,
    archived_at: (input.now ?? (() => new Date().toISOString()))(),
  });
  await writeProtocolInvalidAttempt(paths, record);
  return { record, bundle };
}

async function assertEvidenceFile(paths: HarnessPaths, file: ArchivedEvidenceFile): Promise<void> {
  const bytes = await readRequired(path.join(paths.devDir, file.path), `evidência arquivada ${file.path}`);
  if (sha256Hex(bytes) !== file.sha256 || bytes.byteLength !== file.size_bytes) {
    throw new ProtocolOutputRecoveryError(`evidência arquivada foi alterada: ${file.path}`);
  }
}

async function assertArchivedRecord(
  paths: HarnessPaths,
  record: ProtocolInvalidAttemptRecordType,
  task: TaskState,
  authorizedHead: string | null,
  reason: string,
): Promise<void> {
  if (
    record.task_id !== task.id ||
    record.attempt !== task.attempts ||
    record.source_base_sha !== task.base_sha ||
    record.authorized_head_sha !== authorizedHead
  ) {
    throw new ProtocolOutputRecoveryError('ProtocolInvalidAttemptRecord diverge do state');
  }
  if (record.reason !== reason) {
    throw new ProtocolOutputRecoveryError('ProtocolInvalidAttemptRecord diverge do reason solicitado');
  }
  await Promise.all([
    assertEvidenceFile(paths, record.report),
    assertEvidenceFile(paths, record.handoff_draft),
    assertEvidenceFile(paths, record.launch_record),
  ]);
  for (const file of record.patch_files) {
    if (file.content_state === 'ABSENT') continue;
    await assertEvidenceFile(paths, {
      path: file.archive_path as string,
      source_path: file.path,
      sha256: file.sha256 as string,
      size_bytes: file.size_bytes as number,
    });
  }
  await Promise.all([
    assertEvidenceFile(paths, {
      path: record.change_bundle.manifest_path,
      source_path: record.change_bundle.manifest_path,
      sha256: record.change_bundle.manifest_sha256,
      size_bytes: (await readRequired(
        path.join(paths.devDir, record.change_bundle.manifest_path),
        'manifesto do patch',
      )).byteLength,
    }),
    assertEvidenceFile(paths, {
      path: record.change_bundle.patch_path,
      source_path: record.change_bundle.patch_path,
      sha256: record.change_bundle.patch_sha256,
      size_bytes: record.change_bundle.patch_size_bytes,
    }),
  ]);
}

async function assertResumePatchSafe(
  paths: HarnessPaths,
  record: ProtocolInvalidAttemptRecordType,
): Promise<void> {
  const actual = await workingTreeFiles(paths.repoRoot);
  const allowed = new Set(record.changed_files);
  const extra = actual.find((file) => !allowed.has(file));
  if (extra) throw new ProtocolOutputRecoveryError(`arquivo real extra após archival: ${extra}`);
  const snapshot = await workingTreeSnapshot(paths.repoRoot);
  const statuses = new Map<string, string>();
  for (const entry of snapshot) {
    statuses.set(entry.path, entry.status);
    if (entry.originalPath !== null) statuses.set(entry.originalPath, entry.status);
  }
  for (const file of record.patch_files) {
    if (!actual.includes(file.path)) continue;
    if (statuses.get(file.path) !== file.git_status) {
      throw new ProtocolOutputRecoveryError(`status Git mudou após archival: ${file.path}`);
    }
    const bytes = await currentGitBytes(paths.repoRoot, file.path);
    if (file.content_state === 'ABSENT') {
      if (bytes !== null) throw new ProtocolOutputRecoveryError(`conteúdo reapareceu após archival: ${file.path}`);
      continue;
    }
    if (
      bytes === null ||
      bytes.byteLength !== file.size_bytes ||
      sha256Hex(bytes) !== file.sha256
    ) {
      throw new ProtocolOutputRecoveryError(`patch mudou após archival: ${file.path}`);
    }
  }
}

async function reopenTask(
  paths: HarnessPaths,
  record: ProtocolInvalidAttemptRecordType,
): Promise<DevelopmentState> {
  const state = await readState(paths);
  const task = getTaskState(state, record.task_id);
  if (task.status === 'READY') return state;
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING') {
    throw new ProtocolOutputRecoveryError(`tarefa mudou para ${task.status} durante recovery`);
  }
  const next = withTaskState(state, record.task_id, {
    status: 'READY',
    phase: null,
    process: null,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics:
      `attempt ${record.attempt} abandonado por output de protocolo inválido ` +
      '(PROTOCOL_OUTPUT_INVALID); nenhum verdict de capability foi produzido',
    started_at: null,
    finished_at: null,
  });
  await writeState(paths, next);
  return readState(paths);
}

async function convergeCleanup(
  input: ProtocolOutputRecoveryInput,
  record: ProtocolInvalidAttemptRecordType,
): Promise<{
  state: DevelopmentState;
  restored: readonly string[];
  removed: readonly string[];
  releasedCurrentInbox: boolean;
}> {
  const { paths, taskId } = input;
  await assertResumePatchSafe(paths, record);
  const reset = await resetFilesToBase({
    repoRoot: paths.repoRoot,
    baseSha: record.source_base_sha,
    files: record.changed_files,
  });
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    throw new ProtocolOutputRecoveryError('working tree não ficou limpa após cleanup path-scoped');
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new ProtocolOutputRecoveryError('index não ficou limpo após cleanup path-scoped');
  }
  if ((await headSha(paths.repoRoot)) !== record.source_base_sha) {
    throw new ProtocolOutputRecoveryError('HEAD mudou durante cleanup path-scoped');
  }
  await input.afterPatchReset?.(record);

  let released;
  try {
    released = await releaseCurrentInboxArtifacts(
      paths,
      taskId,
      {
        attempt: record.attempt,
        hashes: {
          reportSha256: record.report.sha256,
          handoffDraftSha256: record.handoff_draft.sha256,
        },
      },
      input.inboxReleaseHooks,
    );
  } catch (error) {
    if (error instanceof InboxArtifactError) throw new ProtocolOutputRecoveryError(error.message);
    throw error;
  }
  return {
    state: await reopenTask(paths, record),
    restored: reset.restored,
    removed: reset.removed,
    releasedCurrentInbox: released.report || released.handoff,
  };
}

export async function recoverProtocolOutput(
  input: ProtocolOutputRecoveryInput,
): Promise<ProtocolOutputRecoveryResult> {
  const reason = input.reason.trim();
  if (reason === '') throw new ProtocolOutputRecoveryError('--reason é obrigatório');
  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  const archived =
    task.attempts < 1
      ? null
      : await readProtocolInvalidAttempt(input.paths, input.taskId, task.attempts);

  if (archived !== null) {
    if (task.status !== 'RUNNING' && task.status !== 'READY') {
      throw new ProtocolOutputRecoveryError(
        `ProtocolInvalidAttemptRecord existe, mas tarefa está ${task.status}`,
      );
    }
    await assertCommonPreconditions(state, task, input.paths, input.taskId);
    await assertArchivedRecord(input.paths, archived, task, state.authorized_head_sha, reason);
    if (task.status === 'READY') {
      if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
        throw new ProtocolOutputRecoveryError('tarefa READY recuperada exige working tree limpa');
      }
      return {
        record: archived,
        recordPath: protocolInvalidAttemptPath(input.paths, input.taskId, archived.attempt),
        state,
        bundle: null,
        restored: [],
        removed: [],
        alreadyArchived: true,
        releasedCurrentInbox: false,
      };
    }
    if (task.phase !== 'FINALIZING') {
      throw new ProtocolOutputRecoveryError('retomada exige RUNNING/FINALIZING');
    }
    if (task.process === null || (await isSameProcessAlive(task.process))) {
      throw new ProtocolOutputRecoveryError('retomada exige processo registrado morto');
    }
    const cleanup = await convergeCleanup(input, archived);
    return {
      record: archived,
      recordPath: protocolInvalidAttemptPath(input.paths, input.taskId, archived.attempt),
      state: cleanup.state,
      bundle: null,
      restored: cleanup.restored,
      removed: cleanup.removed,
      alreadyArchived: true,
      releasedCurrentInbox: cleanup.releasedCurrentInbox,
    };
  }

  const source = await loadNewSource(input);
  const archivedSource = await archiveNewSource({ ...input, reason }, source);
  await input.afterRecordWritten?.(archivedSource.record);
  await assertArchivedRecord(
    input.paths,
    archivedSource.record,
    source.task,
    source.state.authorized_head_sha,
    reason,
  );
  const cleanup = await convergeCleanup(input, archivedSource.record);
  return {
    record: archivedSource.record,
    recordPath: protocolInvalidAttemptPath(input.paths, input.taskId, archivedSource.record.attempt),
    state: cleanup.state,
    bundle: archivedSource.bundle,
    restored: cleanup.restored,
    removed: cleanup.removed,
    alreadyArchived: false,
    releasedCurrentInbox: cleanup.releasedCurrentInbox,
  };
}
