import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, writeJsonOnce } from './atomic.js';
import type { HarnessPaths } from './paths.js';
import {
  AgentCompletionReport,
  AttemptAbandonmentRecord,
  CloseManifest,
  CompletionRecord,
  LaunchRecord,
  MaintenanceRecord,
  OrchestratedRevalidationRecord,
  OrchestratedFinalizationRecord,
  PreservedChangeBundleManifest,
  RevalidationCheckpoint,
  RevalidationSourceBinding,
  RecoveredFinalizationRecord,
  ValidationFailedAttemptRecord,
  type HandoffDraft,
  type HandoffRecord,
  type LaunchRecordInput,
  type TaskPacket,
  parseHandoffDraft,
  parseHandoffRecord,
  parseTaskPacket,
} from './schemas.js';

export function packetPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.packetsDir, `${taskId}.json`);
}

export function handoffPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.handoffsDir, `${taskId}.json`);
}

/** Inbox da tarefa: o único diretório que o worker recebe para escrita. */
export function taskInboxDir(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.inboxDir, taskId);
}

export function handoffDraftPath(paths: HarnessPaths, taskId: string): string {
  return path.join(taskInboxDir(paths, taskId), 'handoff-draft.json');
}

/** O worker escreve nesses caminhos, então eles precisam existir antes do launch. */
export async function ensureTaskInbox(paths: HarnessPaths, taskId: string): Promise<void> {
  await mkdir(taskInboxDir(paths, taskId), { recursive: true });
}

export function launchRecordPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.logsDir, `${taskId}.launch.json`);
}

export function reportPath(paths: HarnessPaths, taskId: string): string {
  return path.join(taskInboxDir(paths, taskId), 'report.json');
}

export function completionPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.completionsDir, `${taskId}.completion.json`);
}

/** Escrito por último num fechamento aceito: existir = o bundle está completo. */
export function closeManifestPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.completionsDir, `${taskId}.close-manifest.json`);
}

export function maintenanceRecordPath(paths: HarnessPaths, adoptedHeadSha: string): string {
  return path.join(paths.maintenanceDir, `${adoptedHeadSha}.json`);
}

export function attemptAbandonmentPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(paths.attemptsDir, taskId, `${attempt}-abandoned.json`);
}

export function recoveryRecordPath(
  paths: HarnessPaths,
  taskId: string,
  sourceAttempt: number,
): string {
  return path.join(paths.recoveriesDir, taskId, `attempt-${sourceAttempt}.json`);
}

export function orchestratedFinalizationPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(paths.finalizationsDir, taskId, `attempt-${attempt}.json`);
}

export function revalidationAttemptDir(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(paths.revalidationsDir, taskId, `attempt-${attempt}`);
}

export function sourceBindingPath(paths: HarnessPaths, taskId: string, attempt: number): string {
  return path.join(revalidationAttemptDir(paths, taskId, attempt), 'source-binding.json');
}

export function originalCompletionEvidencePath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(revalidationAttemptDir(paths, taskId, attempt), 'original-completion.fail.json');
}

export function revalidationRecordPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): string {
  return path.join(
    revalidationAttemptDir(paths, taskId, attempt),
    `revalidation-${sequence}.json`,
  );
}

export function revalidationCheckpointPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): string {
  return path.join(
    revalidationAttemptDir(paths, taskId, attempt),
    `revalidation-${sequence}.checkpoint.json`,
  );
}

export function failedAttemptDir(paths: HarnessPaths, taskId: string, attempt: number): string {
  return path.join(paths.failedAttemptsDir, taskId, `attempt-${attempt}`);
}

export function validationFailedAttemptPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'validation-failed-attempt.json');
}

export function preservedBundleManifestPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'changes-manifest.json');
}

export function preservedBundlePatchPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'changes.patch');
}

export async function nextRevalidationSequence(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(revalidationAttemptDir(paths, taskId, attempt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 1;
    throw error;
  }
  let maximum = 0;
  for (const name of names) {
    const match = /^revalidation-(\d+)\.json$/.exec(name);
    if (match?.[1]) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

const writeJson = writeJsonAtomic;

export async function readOptional<T>(
  file: string,
  parse: (input: unknown) => T,
): Promise<T | null> {
  try {
    return parse(await readJson(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const readPacket = (paths: HarnessPaths, taskId: string): Promise<TaskPacket | null> =>
  readOptional(packetPath(paths, taskId), parseTaskPacket);

export const writePacket = (paths: HarnessPaths, packet: TaskPacket): Promise<void> =>
  writeJson(packetPath(paths, packet.task_id), parseTaskPacket(packet));

export const readHandoff = (paths: HarnessPaths, taskId: string): Promise<HandoffRecord | null> =>
  readOptional(handoffPath(paths, taskId), parseHandoffRecord);

export const writeHandoff = (paths: HarnessPaths, record: HandoffRecord): Promise<void> =>
  writeJson(handoffPath(paths, record.task_id), parseHandoffRecord(record));

export const readHandoffDraft = (
  paths: HarnessPaths,
  taskId: string,
): Promise<HandoffDraft | null> => readOptional(handoffDraftPath(paths, taskId), parseHandoffDraft);

export const readReport = (
  paths: HarnessPaths,
  taskId: string,
): Promise<AgentCompletionReport | null> =>
  readOptional(reportPath(paths, taskId), (input) => AgentCompletionReport.parse(input));

export const writeCompletion = (
  paths: HarnessPaths,
  record: CompletionRecord,
): Promise<void> =>
  writeJson(completionPath(paths, record.task_id), CompletionRecord.parse(record));

export const readLaunchRecord = (
  paths: HarnessPaths,
  taskId: string,
): Promise<LaunchRecord | null> =>
  readOptional(launchRecordPath(paths, taskId), (input) => LaunchRecord.parse(input));

export const writeLaunchRecord = (paths: HarnessPaths, record: LaunchRecordInput): Promise<void> =>
  writeJson(launchRecordPath(paths, record.task_id), LaunchRecord.parse(record));

export const readCompletion = (
  paths: HarnessPaths,
  taskId: string,
): Promise<CompletionRecord | null> =>
  readOptional(completionPath(paths, taskId), (input) => CompletionRecord.parse(input));

export const readCloseManifest = (
  paths: HarnessPaths,
  taskId: string,
): Promise<CloseManifest | null> =>
  readOptional(closeManifestPath(paths, taskId), (input) => CloseManifest.parse(input));

export const writeCloseManifest = (
  paths: HarnessPaths,
  manifest: CloseManifest,
): Promise<void> =>
  writeJson(closeManifestPath(paths, manifest.task_id), CloseManifest.parse(manifest));

export const readMaintenanceRecord = (
  paths: HarnessPaths,
  adoptedHeadSha: string,
): Promise<MaintenanceRecord | null> =>
  readOptional(maintenanceRecordPath(paths, adoptedHeadSha), (input) =>
    MaintenanceRecord.parse(input),
  );

export const writeMaintenanceRecord = (
  paths: HarnessPaths,
  record: MaintenanceRecord,
): Promise<void> =>
  writeJson(maintenanceRecordPath(paths, record.adopted_head_sha), MaintenanceRecord.parse(record));

export const readAttemptAbandonment = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<AttemptAbandonmentRecord | null> =>
  readOptional(attemptAbandonmentPath(paths, taskId, attempt), (input) =>
    AttemptAbandonmentRecord.parse(input),
  );

export const writeAttemptAbandonment = (
  paths: HarnessPaths,
  record: AttemptAbandonmentRecord,
): Promise<void> =>
  writeJson(
    attemptAbandonmentPath(paths, record.task_id, record.attempt),
    AttemptAbandonmentRecord.parse(record),
  );

export const readRecoveredFinalization = (
  paths: HarnessPaths,
  taskId: string,
  sourceAttempt: number,
): Promise<RecoveredFinalizationRecord | null> =>
  readOptional(recoveryRecordPath(paths, taskId, sourceAttempt), (input) =>
    RecoveredFinalizationRecord.parse(input),
  );

export const writeRecoveredFinalization = (
  paths: HarnessPaths,
  record: RecoveredFinalizationRecord,
): Promise<void> =>
  writeJson(
    recoveryRecordPath(paths, record.task_id, record.source_attempt),
    RecoveredFinalizationRecord.parse(record),
  );

export const readOrchestratedFinalization = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<OrchestratedFinalizationRecord | null> =>
  readOptional(orchestratedFinalizationPath(paths, taskId, attempt), (input) =>
    OrchestratedFinalizationRecord.parse(input),
  );

export const writeOrchestratedFinalization = (
  paths: HarnessPaths,
  record: OrchestratedFinalizationRecord,
): Promise<void> =>
  writeJson(
    orchestratedFinalizationPath(paths, record.task_id, record.attempt),
    OrchestratedFinalizationRecord.parse(record),
  );

export const readRevalidationSourceBinding = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<RevalidationSourceBinding | null> =>
  readOptional(sourceBindingPath(paths, taskId, attempt), (input) =>
    RevalidationSourceBinding.parse(input),
  );

export const writeRevalidationSourceBinding = (
  paths: HarnessPaths,
  binding: RevalidationSourceBinding,
): Promise<void> =>
  writeJsonOnce(
    sourceBindingPath(paths, binding.task_id, binding.attempt),
    RevalidationSourceBinding.parse(binding),
  );

export const readOrchestratedRevalidation = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): Promise<OrchestratedRevalidationRecord | null> =>
  readOptional(revalidationRecordPath(paths, taskId, attempt, sequence), (input) =>
    OrchestratedRevalidationRecord.parse(input),
  );

export const writeOrchestratedRevalidation = (
  paths: HarnessPaths,
  record: OrchestratedRevalidationRecord,
): Promise<void> =>
  writeJsonOnce(
    revalidationRecordPath(paths, record.task_id, record.attempt, record.sequence),
    OrchestratedRevalidationRecord.parse(record),
  );

export const readRevalidationCheckpoint = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): Promise<RevalidationCheckpoint | null> =>
  readOptional(revalidationCheckpointPath(paths, taskId, attempt, sequence), (input) =>
    RevalidationCheckpoint.parse(input),
  );

export const writeRevalidationCheckpoint = (
  paths: HarnessPaths,
  checkpoint: RevalidationCheckpoint,
): Promise<void> =>
  writeJsonOnce(
    revalidationCheckpointPath(
      paths,
      checkpoint.task_id,
      checkpoint.attempt,
      checkpoint.sequence,
    ),
    RevalidationCheckpoint.parse(checkpoint),
  );

export const readValidationFailedAttempt = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<ValidationFailedAttemptRecord | null> =>
  readOptional(validationFailedAttemptPath(paths, taskId, attempt), (input) =>
    ValidationFailedAttemptRecord.parse(input),
  );

export const writeValidationFailedAttempt = (
  paths: HarnessPaths,
  record: ValidationFailedAttemptRecord,
): Promise<void> =>
  writeJsonOnce(
    validationFailedAttemptPath(paths, record.task_id, record.attempt),
    ValidationFailedAttemptRecord.parse(record),
  );

export const readPreservedBundleManifest = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<PreservedChangeBundleManifest | null> =>
  readOptional(preservedBundleManifestPath(paths, taskId, attempt), (input) =>
    PreservedChangeBundleManifest.parse(input),
  );

export const writePreservedBundleManifest = (
  paths: HarnessPaths,
  manifest: PreservedChangeBundleManifest,
): Promise<void> =>
  writeJsonOnce(
    preservedBundleManifestPath(paths, manifest.task_id, manifest.attempt),
    PreservedChangeBundleManifest.parse(manifest),
  );

export async function listOrchestratedRevalidations(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<OrchestratedRevalidationRecord[]> {
  let names: string[];
  try {
    names = await readdir(revalidationAttemptDir(paths, taskId, attempt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const sequences = names
    .map((name) => /^revalidation-(\d+)\.json$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right);
  return Promise.all(
    sequences.map(async (sequence) => {
      const record = await readOrchestratedRevalidation(paths, taskId, attempt, sequence);
      if (!record) throw new Error(`revalidation-${sequence}.json desapareceu durante leitura`);
      return record;
    }),
  );
}
