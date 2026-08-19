import { lstat, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { writeFileOnce, writeJsonOnce } from './atomic.js';
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
} from './git.js';
import { readCurrentInboxArtifacts } from './inbox-artifacts.js';
import type { HarnessPaths } from './paths.js';
import { isSameProcessAlive } from './process-identity.js';
import {
  attemptAbandonmentPath,
  completionPath,
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  infraAttemptEvidencePath,
  infraFailedAttemptPath,
  launchRecordPath,
  preservedBundleManifestPath,
  preservedBundlePatchPath,
  protocolInvalidAttemptPath,
  readAttemptAbandonment,
  readPreservedBundleManifest,
  validationFailedAttemptPath,
} from './records.js';
import {
  AttemptAbandonmentRecord,
  DEV_SCHEMA_VERSION,
  LaunchRecord,
  type ArchivedEvidenceFile,
  type AttemptAbandonmentRecord as AttemptAbandonmentRecordType,
  type DevelopmentState,
  type LaunchRecord as LaunchRecordType,
  type TaskState,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';

/**
 * Recovery para o caso em que o worker TERMINOU, o LaunchRecord está finished,
 * há patch real na working tree, e os completion artifacts estão ausentes.
 *
 * Não inventa AgentCompletionReport nem HandoffDraft. Não produz capability
 * verdict nem official-validation verdict. O patch é evidência objetiva do
 * attempt; depois de preservado, a árvore volta ao base e a task reabre READY.
 */
export class IncompleteWorkerOutputRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncompleteWorkerOutputRecoveryError';
  }
}

export interface IncompleteWorkerOutputRecoveryInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reason: string;
  readonly now?: () => string;
  /** Crash depois do bundle do patch, antes de logs/inbox. */
  readonly afterPatchPreserved?: () => Promise<void>;
  /** Crash depois de patch+logs+inbox, antes do reset. */
  readonly afterEvidencePreserved?: () => Promise<void>;
  /** Crash depois do reset path-scoped, antes do record. */
  readonly afterPatchReset?: () => Promise<void>;
  /** Crash depois do AttemptAbandonmentRecord, antes do state READY. */
  readonly afterRecordWritten?: (record: AttemptAbandonmentRecordType) => Promise<void>;
}

export interface IncompleteWorkerOutputRecoveryResult {
  readonly record: AttemptAbandonmentRecordType;
  readonly recordPath: string;
  readonly state: DevelopmentState;
  readonly bundle: PreservedBundle | null;
  readonly changed_files: readonly string[];
  readonly patch_fingerprint: string;
  readonly report_present: boolean;
  readonly handoff_present: boolean;
  readonly evidence_paths: readonly string[];
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly alreadyArchived: boolean;
  readonly capability_fail_recorded: false;
  readonly official_validation_fail_recorded: false;
}

const LOG_EVIDENCE = [
  {
    name: 'launch.infra.json' as const,
    source: (paths: HarnessPaths, taskId: string) => launchRecordPath(paths, taskId),
  },
  {
    name: 'stdout.log' as const,
    source: (paths: HarnessPaths, taskId: string) => path.join(paths.logsDir, `${taskId}.stdout.log`),
  },
  {
    name: 'stderr.log' as const,
    source: (paths: HarnessPaths, taskId: string) => path.join(paths.logsDir, `${taskId}.stderr.log`),
  },
];

interface IncompleteSource {
  readonly state: DevelopmentState;
  readonly task: TaskState;
  readonly launch: LaunchRecordType;
  readonly files: string[];
  readonly fingerprint: string;
  readonly reportPresent: boolean;
  readonly handoffPresent: boolean;
  readonly reportBytes: Buffer | null;
  readonly handoffBytes: Buffer | null;
}

function relativeToDev(paths: HarnessPaths, file: string): string {
  return path.relative(paths.devDir, file).split(path.sep).join('/');
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

async function pruneEmptyParentDirectories(
  repoRoot: string,
  files: readonly string[],
): Promise<void> {
  const starts = [...new Set(files.map((file) => path.dirname(file)))]
    .filter((dir) => dir !== '.' && dir !== '')
    .sort((a, b) => b.length - a.length);
  for (const start of starts) {
    let current = start;
    while (current !== '.' && current !== '') {
      try {
        await rmdir(path.join(repoRoot, current));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          current = path.dirname(current);
          continue;
        }
        break;
      }
      current = path.dirname(current);
    }
  }
}

function classifyLaunch(launch: LaunchRecordType): AttemptAbandonmentRecordType['launch_classification'] {
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

function sameRecord(
  existing: AttemptAbandonmentRecordType,
  expected: AttemptAbandonmentRecordType,
): boolean {
  return canonicalJson(existing) === canonicalJson(expected);
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
    throw new IncompleteWorkerOutputRecoveryError(`outra tarefa RUNNING: ${otherRunning.id}`);
  }
  if (task.attempts < 1) throw new IncompleteWorkerOutputRecoveryError('attempt ausente');
  if (task.candidate_commit !== null) {
    throw new IncompleteWorkerOutputRecoveryError('candidate_commit precisa ser null');
  }
  if (task.accepted_commit !== null) {
    throw new IncompleteWorkerOutputRecoveryError('accepted_commit precisa ser null');
  }
  if (task.base_sha === null) throw new IncompleteWorkerOutputRecoveryError('base_sha ausente');
  if (state.authorized_head_sha === null) {
    throw new IncompleteWorkerOutputRecoveryError('authorized_head_sha ausente');
  }
  const head = await headSha(paths.repoRoot);
  if (head !== task.base_sha || head !== state.authorized_head_sha) {
    throw new IncompleteWorkerOutputRecoveryError(
      `HEAD ${head} diverge de base_sha ${task.base_sha} ou authorized_head_sha ${state.authorized_head_sha}`,
    );
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new IncompleteWorkerOutputRecoveryError('index contém mudanças staged');
  }
  return head;
}

async function assertNoIncompatibleRecords(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<void> {
  if (await exists(completionPath(paths, taskId))) {
    throw new IncompleteWorkerOutputRecoveryError('CompletionRecord presente; recovery recusado');
  }
  if (await exists(validationFailedAttemptPath(paths, taskId, attempt))) {
    throw new IncompleteWorkerOutputRecoveryError(
      'ValidationFailedAttemptRecord presente; recovery recusado',
    );
  }
  if (await exists(infraFailedAttemptPath(paths, taskId, attempt))) {
    throw new IncompleteWorkerOutputRecoveryError(
      'InfraFailedAttemptRecord presente; recovery recusado',
    );
  }
  if (await exists(protocolInvalidAttemptPath(paths, taskId, attempt))) {
    throw new IncompleteWorkerOutputRecoveryError(
      'ProtocolInvalidAttemptRecord presente; recovery recusado',
    );
  }
}

async function loadLaunch(
  paths: HarnessPaths,
  taskId: string,
  task: TaskState,
): Promise<LaunchRecordType> {
  if (task.process === null) {
    throw new IncompleteWorkerOutputRecoveryError('processo registrado ausente');
  }
  if (await isSameProcessAlive(task.process)) {
    throw new IncompleteWorkerOutputRecoveryError('processo registrado ainda está vivo');
  }
  const launchFile = launchRecordPath(paths, taskId);
  let launchBytes: Buffer;
  try {
    launchBytes = await readFile(launchFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IncompleteWorkerOutputRecoveryError('LaunchRecord ausente');
    }
    throw error;
  }
  let launch: LaunchRecordType;
  try {
    launch = LaunchRecord.parse(JSON.parse(launchBytes.toString('utf8')));
  } catch (error) {
    throw new IncompleteWorkerOutputRecoveryError(
      `LaunchRecord inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (launch.task_id !== taskId) {
    throw new IncompleteWorkerOutputRecoveryError(`LaunchRecord pertence a ${launch.task_id}`);
  }
  if (launch.finished_at === null) {
    throw new IncompleteWorkerOutputRecoveryError('LaunchRecord ainda não foi finalizado');
  }
  if (canonicalJson(launch.process) !== canonicalJson(task.process)) {
    throw new IncompleteWorkerOutputRecoveryError('processo do LaunchRecord diverge do state');
  }
  if (
    launch.execution_policy.commit_owner !== 'orchestrator' ||
    launch.execution_policy.official_validation_owner !== 'orchestrator'
  ) {
    throw new IncompleteWorkerOutputRecoveryError('execution_policy não pertence ao orquestrador');
  }
  return launch;
}

async function loadIncompleteSource(
  input: IncompleteWorkerOutputRecoveryInput,
): Promise<IncompleteSource> {
  const { paths, taskId } = input;
  const state = await readState(paths);
  const task = getTaskState(state, taskId);
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING') {
    throw new IncompleteWorkerOutputRecoveryError(
      `recovery de output incompleto exige RUNNING/FINALIZING, encontrada ${task.status}${
        task.phase === null ? '' : `/${task.phase}`
      }`,
    );
  }
  await assertCommonPreconditions(state, task, paths, taskId);
  await assertNoIncompatibleRecords(paths, taskId, task.attempts);
  const launch = await loadLaunch(paths, taskId, task);

  const inbox = await readCurrentInboxArtifacts(paths, taskId);
  if (inbox.report !== null && inbox.handoff !== null) {
    throw new IncompleteWorkerOutputRecoveryError(
      'completion artifacts presentes; recovery de output incompleto recusado',
    );
  }

  const files = await workingTreeFiles(paths.repoRoot);
  const existingBundle = await readPreservedBundleManifest(paths, taskId, task.attempts);
  if (files.length === 0) {
    if (existingBundle === null) {
      throw new IncompleteWorkerOutputRecoveryError('patch real ausente');
    }
    return {
      state,
      task,
      launch,
      files: [...existingBundle.changed_files],
      fingerprint: existingBundle.patch_fingerprint,
      reportPresent: inbox.report !== null || (await exists(failedAttemptReportPath(paths, taskId, task.attempts))),
      handoffPresent:
        inbox.handoff !== null || (await exists(failedAttemptHandoffDraftPath(paths, taskId, task.attempts))),
      reportBytes: inbox.report,
      handoffBytes: inbox.handoff,
    };
  }

  const forbidden = files.filter(isForbiddenOrchestratedPath).sort();
  if (forbidden.length > 0) {
    throw new IncompleteWorkerOutputRecoveryError(
      `path proibida no patch: ${forbidden.join(', ')}`,
    );
  }
  for (const file of files) assertRepoRelativePath(file);
  const fingerprint = await patchFingerprint(paths.repoRoot);
  if (existingBundle !== null && existingBundle.patch_fingerprint !== fingerprint) {
    throw new IncompleteWorkerOutputRecoveryError(
      'bundle preservado diverge do patch atual — a solução arquivada não é esta',
    );
  }
  if (
    existingBundle !== null &&
    canonicalJson(existingBundle.changed_files) !== canonicalJson(files)
  ) {
    throw new IncompleteWorkerOutputRecoveryError(
      'changed_files do bundle divergem da working tree atual',
    );
  }

  return {
    state,
    task,
    launch,
    files,
    fingerprint,
    reportPresent: inbox.report !== null,
    handoffPresent: inbox.handoff !== null,
    reportBytes: inbox.report,
    handoffBytes: inbox.handoff,
  };
}

async function archiveLogEvidence(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<ArchivedEvidenceFile[]> {
  const archived: ArchivedEvidenceFile[] = [];
  for (const entry of LOG_EVIDENCE) {
    const source = entry.source(paths, taskId);
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new IncompleteWorkerOutputRecoveryError(
        `evidência do attempt ausente: ${relativeToDev(paths, source)}`,
      );
    }
    const destination = infraAttemptEvidencePath(paths, taskId, attempt, entry.name);
    try {
      await writeFileOnce(destination, bytes);
    } catch (error) {
      throw new IncompleteWorkerOutputRecoveryError(
        `evidência arquivada diverge da atual (${entry.name}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    archived.push({
      path: relativeToDev(paths, destination),
      source_path: relativeToDev(paths, source),
      sha256: sha256Hex(bytes),
      size_bytes: bytes.byteLength,
    });
  }
  return archived;
}

async function archivePartialInbox(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  source: IncompleteSource,
): Promise<void> {
  if (source.reportBytes !== null) {
    await writeFileOnce(failedAttemptReportPath(paths, taskId, attempt), source.reportBytes);
  }
  if (source.handoffBytes !== null) {
    await writeFileOnce(failedAttemptHandoffDraftPath(paths, taskId, attempt), source.handoffBytes);
  }
}

async function releasePartialInbox(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  source: IncompleteSource,
): Promise<void> {
  if (source.reportBytes !== null) {
    const archived = await readFile(failedAttemptReportPath(paths, taskId, attempt));
    if (!archived.equals(source.reportBytes)) {
      throw new IncompleteWorkerOutputRecoveryError('report parcial arquivado diverge do inbox');
    }
  }
  if (source.handoffBytes !== null) {
    const archived = await readFile(failedAttemptHandoffDraftPath(paths, taskId, attempt));
    if (!archived.equals(source.handoffBytes)) {
      throw new IncompleteWorkerOutputRecoveryError('handoff parcial arquivado diverge do inbox');
    }
  }
  const inbox = await readCurrentInboxArtifacts(paths, taskId);
  if (source.reportBytes !== null && inbox.report !== null && inbox.report.equals(source.reportBytes)) {
    await rm(path.join(paths.inboxDir, taskId, 'report.json'), { force: true });
  }
  if (
    source.handoffBytes !== null &&
    inbox.handoff !== null &&
    inbox.handoff.equals(source.handoffBytes)
  ) {
    await rm(path.join(paths.inboxDir, taskId, 'handoff-draft.json'), { force: true });
  }
}

async function evidencePathsFor(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  presence: { readonly reportPresent: boolean; readonly handoffPresent: boolean },
): Promise<string[]> {
  const listed = [
    relativeToDev(paths, attemptAbandonmentPath(paths, taskId, attempt)),
    relativeToDev(paths, preservedBundleManifestPath(paths, taskId, attempt)),
    relativeToDev(paths, preservedBundlePatchPath(paths, taskId, attempt)),
    ...LOG_EVIDENCE.map((entry) =>
      relativeToDev(paths, infraAttemptEvidencePath(paths, taskId, attempt, entry.name)),
    ),
  ];
  if (presence.reportPresent || (await exists(failedAttemptReportPath(paths, taskId, attempt)))) {
    listed.push(relativeToDev(paths, failedAttemptReportPath(paths, taskId, attempt)));
  }
  if (presence.handoffPresent || (await exists(failedAttemptHandoffDraftPath(paths, taskId, attempt)))) {
    listed.push(relativeToDev(paths, failedAttemptHandoffDraftPath(paths, taskId, attempt)));
  }
  return listed;
}

function buildRecord(
  input: IncompleteWorkerOutputRecoveryInput,
  source: IncompleteSource,
  head: string,
  existing: AttemptAbandonmentRecordType | null,
): AttemptAbandonmentRecordType {
  if (source.task.process === null) {
    throw new IncompleteWorkerOutputRecoveryError('processo registrado ausente');
  }
  const abandonedAt = existing?.abandoned_at ?? (input.now ?? (() => new Date().toISOString()))();
  return AttemptAbandonmentRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    attempt: source.task.attempts,
    base_sha: source.task.base_sha as string,
    process: source.task.process,
    launch_classification: classifyLaunch(source.launch),
    exit_code: source.launch.exit_code,
    started_at: source.launch.started_at,
    finished_at: source.launch.finished_at,
    reason: input.reason.trim(),
    previous_diagnostics: source.task.diagnostics,
    candidate_commit: null,
    working_tree_clean: true,
    head_sha: head,
    report_present: false,
    handoff_present: false,
    abandoned_at: abandonedAt,
  });
}

async function reopenTask(
  paths: HarnessPaths,
  record: AttemptAbandonmentRecordType,
  source: IncompleteSource,
): Promise<DevelopmentState> {
  const state = await readState(paths);
  const task = getTaskState(state, record.task_id);
  if (task.status === 'READY') return state;
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING') {
    throw new IncompleteWorkerOutputRecoveryError(`tarefa mudou para ${task.status} durante recovery`);
  }
  const reportNote = source.reportPresent ? 'presente' : 'ausente';
  const handoffNote = source.handoffPresent ? 'presente' : 'ausente';
  const next = withTaskState(state, record.task_id, {
    status: 'READY',
    phase: null,
    process: null,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics:
      `attempt ${record.attempt} abandonado: worker output protocol incomplete ` +
      `(report ${reportNote}, handoff ${handoffNote}); nenhum verdict de capability foi produzido`,
    started_at: null,
    finished_at: null,
  });
  await writeState(paths, next);
  return readState(paths);
}

async function resetAndSeal(
  input: IncompleteWorkerOutputRecoveryInput,
  source: IncompleteSource,
  existing: AttemptAbandonmentRecordType | null,
): Promise<{
  record: AttemptAbandonmentRecordType;
  restored: readonly string[];
  removed: readonly string[];
  state: DevelopmentState;
}> {
  const { paths } = input;
  const dirty = await workingTreeFiles(paths.repoRoot);
  let restored: readonly string[] = [];
  let removed: readonly string[] = [];
  if (dirty.length > 0) {
    if (canonicalJson(dirty) !== canonicalJson(source.files)) {
      throw new IncompleteWorkerOutputRecoveryError(
        `working tree diverge do patch preservado: real [${dirty.join(', ')}], preservado [${source.files.join(', ')}]`,
      );
    }
    const reset = await resetFilesToBase({
      repoRoot: paths.repoRoot,
      baseSha: source.task.base_sha as string,
      files: source.files,
    });
    restored = reset.restored;
    removed = reset.removed;
  }
  // Arquivos ADDED somem; o diretório pai vazio não é um path git e sobrevive
  // ao reset path-scoped. `readdir(src)` ainda o vê e testes de scaffold
  // falham mesmo com working tree git-clean.
  await pruneEmptyParentDirectories(paths.repoRoot, source.files);
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    throw new IncompleteWorkerOutputRecoveryError('working tree não ficou limpa após cleanup path-scoped');
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new IncompleteWorkerOutputRecoveryError('index não ficou limpo após cleanup path-scoped');
  }
  if ((await headSha(paths.repoRoot)) !== source.task.base_sha) {
    throw new IncompleteWorkerOutputRecoveryError('HEAD mudou durante cleanup path-scoped');
  }
  await input.afterPatchReset?.();

  const record = buildRecord(input, source, source.task.base_sha as string, existing);
  if (existing) {
    if (!sameRecord(existing, record)) {
      throw new IncompleteWorkerOutputRecoveryError(
        'AttemptAbandonmentRecord existente diverge da solicitação',
      );
    }
  } else {
    await writeJsonOnce(attemptAbandonmentPath(paths, record.task_id, record.attempt), record);
  }
  await input.afterRecordWritten?.(record);
  return {
    record,
    restored,
    removed,
    state: await reopenTask(paths, record, source),
  };
}

export async function recoverIncompleteWorkerOutput(
  input: IncompleteWorkerOutputRecoveryInput,
): Promise<IncompleteWorkerOutputRecoveryResult> {
  const reason = input.reason.trim();
  if (reason === '') throw new IncompleteWorkerOutputRecoveryError('--reason é obrigatório');

  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  const existing =
    task.attempts < 1
      ? null
      : await readAttemptAbandonment(input.paths, input.taskId, task.attempts);

  if (existing !== null && task.status === 'READY') {
    await assertCommonPreconditions(state, task, input.paths, input.taskId);
    if (existing.reason !== reason) {
      throw new IncompleteWorkerOutputRecoveryError(
        'AttemptAbandonmentRecord diverge do reason solicitado',
      );
    }
    if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
      throw new IncompleteWorkerOutputRecoveryError('tarefa READY recuperada exige working tree limpa');
    }
    const manifest = await readPreservedBundleManifest(input.paths, input.taskId, existing.attempt);
    if (manifest === null) {
      throw new IncompleteWorkerOutputRecoveryError('bundle preservado ausente na retomada READY');
    }
    const reportPresent = await exists(
      failedAttemptReportPath(input.paths, input.taskId, existing.attempt),
    );
    const handoffPresent = await exists(
      failedAttemptHandoffDraftPath(input.paths, input.taskId, existing.attempt),
    );
    return {
      record: existing,
      recordPath: attemptAbandonmentPath(input.paths, input.taskId, existing.attempt),
      state,
      bundle: null,
      changed_files: manifest.changed_files,
      patch_fingerprint: manifest.patch_fingerprint,
      report_present: reportPresent,
      handoff_present: handoffPresent,
      evidence_paths: await evidencePathsFor(input.paths, input.taskId, existing.attempt, {
        reportPresent,
        handoffPresent,
      }),
      restored: [],
      removed: [],
      alreadyArchived: true,
      capability_fail_recorded: false,
      official_validation_fail_recorded: false,
    };
  }

  const source = await loadIncompleteSource({ ...input, reason });
  const treeDirty = (await workingTreeFiles(input.paths.repoRoot)).length > 0;
  const existingBundle = await readPreservedBundleManifest(
    input.paths,
    input.taskId,
    source.task.attempts,
  );
  // Depois do reset o bundle já é a evidência; remontá-lo da árvore limpa
  // perderia o patch. Só (re)preserva enquanto a working tree ainda o contém.
  let bundle: PreservedBundle | null = null;
  if (treeDirty) {
    bundle = await preserveFailedAttemptBundle({
      paths: input.paths,
      taskId: input.taskId,
      attempt: source.task.attempts,
      baseSha: source.task.base_sha as string,
      files: source.files,
      patchFingerprint: source.fingerprint,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } else if (existingBundle === null) {
    throw new IncompleteWorkerOutputRecoveryError('bundle preservado ausente após reset');
  }
  await input.afterPatchPreserved?.();

  await archiveLogEvidence(input.paths, input.taskId, source.task.attempts);
  await archivePartialInbox(input.paths, input.taskId, source.task.attempts, source);
  await input.afterEvidencePreserved?.();
  await releasePartialInbox(input.paths, input.taskId, source.task.attempts, source);

  const sealed = await resetAndSeal(input, source, existing);
  return {
    record: sealed.record,
    recordPath: attemptAbandonmentPath(input.paths, input.taskId, sealed.record.attempt),
    state: sealed.state,
    bundle,
    changed_files: source.files,
    patch_fingerprint: source.fingerprint,
    report_present: source.reportPresent,
    handoff_present: source.handoffPresent,
    evidence_paths: await evidencePathsFor(input.paths, input.taskId, source.task.attempts, source),
    restored: sealed.restored,
    removed: sealed.removed,
    alreadyArchived: existing !== null,
    capability_fail_recorded: false,
    official_validation_fail_recorded: false,
  };
}
