import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CONTROLLER_RESTART_EXIT_CODE,
  dispatchControllerRestart,
  loadPendingHarnessRestart,
  persistHarnessRestartRecord,
  transitionHarnessRestart,
} from '../../../dev/lib/controller-restart.js';

const mode = process.argv[2];
const runtimeDir = process.argv[3];
if (runtimeDir === undefined) throw new Error('runtime ausente');
const incidentId = 'incident-subprocess';
const pidLog = path.join(runtimeDir, 'controller-pids.log');

if (mode === 'old') {
  await mkdir(path.join(runtimeDir, 'incidents'), { recursive: true });
  await writeFile(path.join(runtimeDir, 'incidents', 'pending.json'), JSON.stringify({
    schema_version: 1,
    incident_id: incidentId,
  }), 'utf8');
  const record = await persistHarnessRestartRecord({
    schema_version: 1,
    parent_runtime_dir: runtimeDir,
    incident_id: incidentId,
    harness_recovery_runtime_dir: path.join(runtimeDir, 'incidents', incidentId, 'harness-recovery'),
    integrated_sha: 'f'.repeat(40),
    original_entry_intent: 'SUBMIT',
    resume_target: runtimeDir,
    state: 'INTEGRATED_PENDING_RESUME',
  });
  await appendFile(pidLog, `integration:${process.pid}\n`, 'utf8');
  const dispatched = await dispatchControllerRestart({
    payload: { recovery: { status: 'RESTART_REQUIRED', restart: record } },
    exitCode: CONTROLLER_RESTART_EXIT_CODE,
  });
  if (!dispatched.handled) throw new Error('restart não foi despachado');
  process.exitCode = dispatched.exitCode;
} else if (mode === 'resume') {
  const pending = await loadPendingHarnessRestart(runtimeDir);
  if (pending === null) throw new Error('restart pendente não encontrado');
  const started = await transitionHarnessRestart(pending, 'RESUME_STARTED');
  await appendFile(pidLog, `resume:${process.pid}\n`, 'utf8');
  await transitionHarnessRestart(started, 'RESUMED');
} else {
  throw new Error(`modo desconhecido: ${String(mode)}`);
}
