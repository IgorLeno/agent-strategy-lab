import { mkdir, readFile } from 'node:fs/promises';
import { writeJsonAtomic } from './atomic.js';
import {
  DEV_SCHEMA_VERSION,
  DevelopmentState,
  type PlanFile,
  type TaskState,
} from './schemas.js';
import type { HarnessPaths } from './paths.js';

export function initialTaskState(id: string): TaskState {
  return {
    id,
    status: 'READY',
    phase: null,
    attempts: 0,
    process: null,
    base_sha: null,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics: null,
    started_at: null,
    finished_at: null,
  };
}

export function buildInitialState(
  plan: PlanFile,
  planSha256: string,
  now: string = new Date().toISOString(),
): DevelopmentState {
  return DevelopmentState.parse({
    schema_version: DEV_SCHEMA_VERSION,
    plan_sha256: planSha256,
    created_at: now,
    updated_at: now,
    tasks: plan.tasks.map((task) => initialTaskState(task.id)),
  });
}

export async function readState(paths: HarnessPaths): Promise<DevelopmentState> {
  return DevelopmentState.parse(JSON.parse(await readFile(paths.stateFile, 'utf8')));
}

export async function writeState(paths: HarnessPaths, state: DevelopmentState): Promise<void> {
  const validated = DevelopmentState.parse({ ...state, updated_at: new Date().toISOString() });
  await writeJsonAtomic(paths.stateFile, validated);
}

export function getTaskState(state: DevelopmentState, id: string): TaskState {
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`tarefa ausente no state: ${id}`);
  return task;
}

export function withTaskState(
  state: DevelopmentState,
  id: string,
  patch: Partial<TaskState>,
): DevelopmentState {
  let found = false;
  const tasks = state.tasks.map((task) => {
    if (task.id !== id) return task;
    found = true;
    return { ...task, ...patch };
  });
  if (!found) throw new Error(`tarefa ausente no state: ${id}`);
  return { ...state, tasks };
}

export async function ensureRuntimeDirs(paths: HarnessPaths): Promise<void> {
  for (const dir of [
    paths.devDir,
    paths.packetsDir,
    paths.completionsDir,
    paths.handoffsDir,
    paths.logsDir,
  ]) {
    await mkdir(dir, { recursive: true });
  }
}
