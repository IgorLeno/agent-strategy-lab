import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessPaths } from './paths.js';
import {
  AgentCompletionReport,
  CompletionRecord,
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

export function handoffDraftPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.handoffsDir, `${taskId}.draft.json`);
}

export function reportPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.completionsDir, `${taskId}.report.json`);
}

export function completionPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.completionsDir, `${taskId}.completion.json`);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

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

export const readCompletion = (
  paths: HarnessPaths,
  taskId: string,
): Promise<CompletionRecord | null> =>
  readOptional(completionPath(paths, taskId), (input) => CompletionRecord.parse(input));
