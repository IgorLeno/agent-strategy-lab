import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.js';
import type { HarnessPaths } from './paths.js';
import {
  AgentCompletionReport,
  CloseManifest,
  CompletionRecord,
  LaunchRecord,
  MaintenanceRecord,
  type HandoffDraft,
  type HandoffRecord,
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

export const writeLaunchRecord = (paths: HarnessPaths, record: LaunchRecord): Promise<void> =>
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
