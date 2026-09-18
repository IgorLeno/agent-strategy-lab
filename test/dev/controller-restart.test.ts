import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CONTROLLER_RESTART_EXIT_CODE,
  dispatchControllerRestart,
  harnessRestartRecordPath,
  loadHarnessRestartRecord,
  loadPendingHarnessRestart,
  persistHarnessRestartRecord,
  transitionHarnessRestart,
} from '../../dev/lib/controller-restart.js';
import { headSha } from '../../dev/lib/git.js';
import { remediateHarnessIncident, resumeHumanInstruction, submitRunDirective } from '../../dev/lib/lab.js';
import { ensureIsolatedSelfTarget, integrateSelfMaintenance } from '../../dev/lib/lab-self.js';
import { runGit } from './helpers.js';

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  return root;
}

async function waitFor(command: string, args: readonly string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: 'pipe', shell: false });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`subprocess exit=${String(code)}: ${stderr}`));
      else resolve(code);
    });
  });
}

describe('controller restart record', () => {
  it('persiste o SHA integrado e recupera crash entre integração e spawn sem repetir integração', async () => {
    const runtime = await temp('agentlab-restart-record-');
    await mkdir(path.join(runtime, 'incidents'), { recursive: true });
    await writeFile(path.join(runtime, 'incidents', 'pending.json'), JSON.stringify({
      schema_version: 1,
      incident_id: 'incident-1',
    }), 'utf8');
    const original = await persistHarnessRestartRecord({
      schema_version: 1,
      parent_runtime_dir: runtime,
      incident_id: 'incident-1',
      harness_recovery_runtime_dir: path.join(runtime, 'incidents', 'incident-1', 'harness-recovery'),
      integrated_sha: 'a'.repeat(40),
      original_entry_intent: 'SUBMIT',
      resume_target: runtime,
      state: 'INTEGRATED_PENDING_RESUME',
    });

    expect(await loadPendingHarnessRestart(runtime)).toEqual(original);
    const started = await transitionHarnessRestart(original, 'RESUME_STARTED');
    expect((await loadPendingHarnessRestart(runtime))?.state).toBe('RESUME_STARTED');
    expect(await transitionHarnessRestart(started, 'RESUME_STARTED')).toEqual(started);
    await transitionHarnessRestart(started, 'RESUMED');
    expect(await loadPendingHarnessRestart(runtime)).toBeNull();
  });

  it('integra um worktree real e preserva esse SHA na relação parent-child', async () => {
    const control = await temp('agentlab-restart-control-');
    await writeFile(path.join(control, 'README.md'), '# control\n', 'utf8');
    await runGit(control, ['init', '-q', '-b', 'main']);
    await runGit(control, ['config', 'user.email', 'harness@example.invalid']);
    await runGit(control, ['config', 'user.name', 'Harness Test']);
    await runGit(control, ['add', '-A']);
    await runGit(control, ['commit', '-q', '-m', 'base']);
    const runtime = await temp('agentlab-restart-runtime-');
    const identity = await ensureIsolatedSelfTarget({
      controlRoot: control,
      runId: 'restart-e2e',
      worktreePath: path.join(runtime, 'worktree'),
      identityFile: path.join(runtime, 'self-target.json'),
    });
    await writeFile(path.join(identity.target_worktree_path, 'FIX.md'), 'controller fix\n', 'utf8');
    await runGit(identity.target_worktree_path, ['add', '-A']);
    await runGit(identity.target_worktree_path, ['commit', '-q', '-m', 'fix controller']);
    const integrated = await integrateSelfMaintenance({ controlRoot: control, identity });
    expect(await headSha(control)).toBe(integrated.integrated_sha);

    const record = await persistHarnessRestartRecord({
      schema_version: 1,
      parent_runtime_dir: runtime,
      incident_id: 'incident-integrated',
      harness_recovery_runtime_dir: path.join(runtime, 'incidents', 'incident-integrated', 'harness-recovery'),
      integrated_sha: integrated.integrated_sha,
      original_entry_intent: 'RESUME',
      resume_target: runtime,
      state: 'INTEGRATED_PENDING_RESUME',
    });
    expect(await loadHarnessRestartRecord(runtime, record.incident_id)).toMatchObject({
      parent_runtime_dir: runtime,
      harness_recovery_runtime_dir: record.harness_recovery_runtime_dir,
      integrated_sha: await headSha(control),
    });
  });

  it('resumeHumanInstruction detecta o contrato pendente e conclui a transição em processo fresco', async () => {
    const target = await temp('agentlab-restart-target-');
    await writeFile(path.join(target, 'README.md'), '# target\n', 'utf8');
    await runGit(target, ['init', '-q', '-b', 'main']);
    await runGit(target, ['config', 'user.email', 'harness@example.invalid']);
    await runGit(target, ['config', 'user.name', 'Harness Test']);
    await runGit(target, ['add', '-A']);
    await runGit(target, ['commit', '-q', '-m', 'base']);
    const runs = await temp('agentlab-restart-runs-');
    const submitted = await submitRunDirective({
      raw_directive: `---agentlab\nversion: 1\ntarget:\n  type: repository\n  path: ${target}\n---\nValidar retomada fresca.`,
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: async () => ({ payload: { stopped_by: 'ALL_DONE' }, exitCode: 0 }),
    });
    const runtime = submitted.payload['runtime_dir'] as string;
    const incidentId = 'incident-fresh-resume';
    await mkdir(path.join(runtime, 'incidents'), { recursive: true });
    await writeFile(path.join(runtime, 'incidents', 'pending.json'), JSON.stringify({
      schema_version: 1,
      incident_id: incidentId,
    }), 'utf8');
    await persistHarnessRestartRecord({
      schema_version: 1,
      parent_runtime_dir: runtime,
      incident_id: incidentId,
      harness_recovery_runtime_dir: path.join(runtime, 'incidents', incidentId, 'harness-recovery'),
      integrated_sha: 'c'.repeat(40),
      original_entry_intent: 'SUBMIT',
      resume_target: runtime,
      state: 'INTEGRATED_PENDING_RESUME',
    });
    let freshRuns = 0;
    const resumed = await resumeHumanInstruction({
      runtime_dir: runtime,
      env: { AGENTLAB_FAKE_MODE: '1' },
      run_project: async () => {
        freshRuns += 1;
        return { payload: { stopped_by: 'ALL_DONE' }, exitCode: 0 };
      },
    });
    expect(freshRuns).toBe(1);
    expect(resumed.exitCode).toBe(0);
    expect(await loadHarnessRestartRecord(runtime, incidentId)).toMatchObject({ state: 'RESUMED' });
  });

  it('replay de incidente com integração pendente não repete self-maintenance concluída', async () => {
    const runtime = await temp('agentlab-restart-replay-');
    const incidentId = 'incident-replay';
    const record = await persistHarnessRestartRecord({
      schema_version: 1,
      parent_runtime_dir: runtime,
      incident_id: incidentId,
      harness_recovery_runtime_dir: path.join(runtime, 'incidents', incidentId, 'harness-recovery'),
      integrated_sha: 'd'.repeat(40),
      original_entry_intent: 'RESUME',
      resume_target: runtime,
      state: 'INTEGRATED_PENDING_RESUME',
    });
    let nestedRuns = 0;
    const result = await remediateHarnessIncident({
      parentRuntimeDir: runtime,
      controlRoot: runtime,
      env: {},
      runProjectImpl: async () => {
        nestedRuns += 1;
        return { payload: { stopped_by: 'ALL_DONE' }, exitCode: 0 };
      },
      incident: {
        schema_version: 1,
        incident_id: incidentId,
        fingerprint: 'e'.repeat(64),
        task_id: 'T1',
        blocker: 'AUTOMATED_REMEDIATION_FAILED',
        reason: 'controller antigo',
        evidence_paths: [],
        runtime_dir: runtime,
        created_at: '2026-09-18T00:00:00.000Z',
        budget: { max_investigator_launches: 3, max_remediation_cycles: 2 },
      },
      diagnosis: {
        schema_version: 1,
        classification: 'HARNESS',
        root_cause: 'controller antigo',
        evidence: [],
        remediation: ['reiniciar'],
        safe_within_current_authority: true,
        resume_strategy: 'processo fresco',
      },
      originalEntryIntent: 'RESUME',
    });
    expect(nestedRuns).toBe(0);
    expect(result).toEqual({ status: 'RESTART_REQUIRED', record });
  });
});

describe('fresh controller adapter', () => {
  it('usa argv, encaminha o runtime e espelha o exit code do processo filho', async () => {
    const runtime = await temp('agentlab-restart-adapter-');
    const record = {
      schema_version: 1 as const,
      parent_runtime_dir: runtime,
      incident_id: 'incident-adapter',
      harness_recovery_runtime_dir: path.join(runtime, 'incidents', 'incident-adapter', 'harness-recovery'),
      integrated_sha: 'b'.repeat(40),
      original_entry_intent: 'SUBMIT' as const,
      resume_target: runtime,
      state: 'INTEGRATED_PENDING_RESUME' as const,
    };
    const launched: string[] = [];
    const dispatched = await dispatchControllerRestart({
      payload: { recovery: { status: 'RESTART_REQUIRED', restart: record } },
      exitCode: CONTROLLER_RESTART_EXIT_CODE,
    }, async (runtimeDir) => { launched.push(runtimeDir); return 23; });
    expect(launched).toEqual([runtime]);
    expect(dispatched).toEqual({ handled: true, exitCode: 23 });
  });

  it('prova em subprocesso que integration PID e resume PID são distintos', async () => {
    const runtime = await temp('agentlab-restart-subprocess-');
    const fixture = path.resolve('test/dev/fixtures/recovery-restart-controller.ts');
    const tsx = path.resolve('node_modules/.bin/tsx');
    await waitFor(tsx, [fixture, 'old', runtime]);

    const lines = (await readFile(path.join(runtime, 'controller-pids.log'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.split(':')[0]).toBe('integration');
    expect(lines[1]?.split(':')[0]).toBe('resume');
    expect(lines[0]?.split(':')[1]).not.toBe(lines[1]?.split(':')[1]);
    const record = await loadHarnessRestartRecord(runtime, 'incident-subprocess');
    expect(record).toMatchObject({
      parent_runtime_dir: runtime,
      incident_id: 'incident-subprocess',
      integrated_sha: 'f'.repeat(40),
      state: 'RESUMED',
    });
    expect(harnessRestartRecordPath(runtime, 'incident-subprocess')).toContain('incident-subprocess');
  });
});
