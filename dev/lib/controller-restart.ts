import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic, writeJsonOnce } from './atomic.js';
import { INCIDENTS_DIR, RECOVERY_PENDING_FILE, pathExists } from './lab-runtime.js';

export const CONTROLLER_RESTART_EXIT_CODE = 75;

export const HarnessRestartRecord = z.object({
  schema_version: z.literal(1),
  parent_runtime_dir: z.string().min(1),
  incident_id: z.string().regex(/^[A-Za-z0-9._:-]+$/),
  harness_recovery_runtime_dir: z.string().min(1),
  integrated_sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  original_entry_intent: z.enum(['SUBMIT', 'RESUME']),
  resume_target: z.string().min(1),
  state: z.enum(['INTEGRATED_PENDING_RESUME', 'RESUME_STARTED', 'RESUMED']),
}).strict().superRefine((record, context) => {
  const parent = path.resolve(record.parent_runtime_dir);
  if (!path.isAbsolute(record.parent_runtime_dir) || path.resolve(record.resume_target) !== parent) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'resume_target deve ser o parent runtime absoluto' });
  }
  const expectedNested = path.join(parent, INCIDENTS_DIR, record.incident_id, 'harness-recovery');
  if (path.resolve(record.harness_recovery_runtime_dir) !== expectedNested) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'harness recovery runtime não pertence ao incidente pai' });
  }
});
export type HarnessRestartRecord = z.infer<typeof HarnessRestartRecord>;

export function harnessRestartRecordPath(parentRuntimeDir: string, incidentId: string): string {
  return path.join(parentRuntimeDir, INCIDENTS_DIR, incidentId, 'controller-restart.json');
}

export async function persistHarnessRestartRecord(
  record: HarnessRestartRecord,
): Promise<HarnessRestartRecord> {
  const parsed = HarnessRestartRecord.parse(record);
  await writeJsonOnce(
    harnessRestartRecordPath(parsed.parent_runtime_dir, parsed.incident_id),
    parsed,
  );
  return parsed;
}

export async function loadHarnessRestartRecord(
  parentRuntimeDir: string,
  incidentId: string,
): Promise<HarnessRestartRecord | null> {
  const file = harnessRestartRecordPath(parentRuntimeDir, incidentId);
  if (!(await pathExists(file))) return null;
  const record = HarnessRestartRecord.parse(JSON.parse(await readFile(file, 'utf8')));
  if (path.resolve(record.parent_runtime_dir) !== path.resolve(parentRuntimeDir)) {
    throw new Error(`restart record ${file} aponta para outro parent runtime`);
  }
  return record;
}

/** Resolve o incidente corrente sem varrer HOME, outros projetos ou runtimes. */
export async function loadPendingHarnessRestart(
  parentRuntimeDir: string,
): Promise<HarnessRestartRecord | null> {
  const pendingPath = path.join(parentRuntimeDir, RECOVERY_PENDING_FILE);
  if (!(await pathExists(pendingPath))) return null;
  const pending = z.object({ incident_id: z.string().min(1) }).passthrough()
    .parse(JSON.parse(await readFile(pendingPath, 'utf8')));
  const record = await loadHarnessRestartRecord(parentRuntimeDir, pending.incident_id);
  return record?.state === 'RESUMED' ? null : record;
}

export async function transitionHarnessRestart(
  record: HarnessRestartRecord,
  nextState: 'RESUME_STARTED' | 'RESUMED',
): Promise<HarnessRestartRecord> {
  const current = await loadHarnessRestartRecord(record.parent_runtime_dir, record.incident_id);
  if (current === null) throw new Error(`restart record ausente para incidente ${record.incident_id}`);
  if (current.state === nextState || current.state === 'RESUMED') return current;
  const allowed =
    (current.state === 'INTEGRATED_PENDING_RESUME' && nextState === 'RESUME_STARTED') ||
    (current.state === 'RESUME_STARTED' && nextState === 'RESUMED');
  if (!allowed) {
    throw new Error(`transição de restart inválida: ${current.state} -> ${nextState}`);
  }
  const next = HarnessRestartRecord.parse({ ...current, state: nextState });
  await writeJsonAtomic(harnessRestartRecordPath(current.parent_runtime_dir, current.incident_id), next);
  return next;
}

export interface RestartAwareResult {
  readonly payload: Record<string, unknown>;
  readonly exitCode: number;
}

export type FreshControllerLauncher = (runtimeDir: string) => Promise<number>;

function restartRecordFromResult(result: RestartAwareResult): HarnessRestartRecord | null {
  if (result.exitCode !== CONTROLLER_RESTART_EXIT_CODE) return null;
  const recovery = result.payload['recovery'];
  if (typeof recovery !== 'object' || recovery === null || Array.isArray(recovery)) return null;
  if ((recovery as Record<string, unknown>)['status'] !== 'RESTART_REQUIRED') return null;
  return HarnessRestartRecord.parse((recovery as Record<string, unknown>)['restart']);
}

export async function spawnFreshLabController(runtimeDir: string): Promise<number> {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) throw new Error('entrypoint atual do Agent Lab não está disponível');
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...process.execArgv, entrypoint, 'resume', runtimeDir],
      { stdio: 'inherit', shell: false },
    );
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}

export async function dispatchControllerRestart(
  result: RestartAwareResult,
  launch: FreshControllerLauncher = spawnFreshLabController,
): Promise<{ readonly handled: false } | { readonly handled: true; readonly exitCode: number }> {
  const record = restartRecordFromResult(result);
  if (record === null) return { handled: false };
  return { handled: true, exitCode: await launch(record.resume_target) };
}
