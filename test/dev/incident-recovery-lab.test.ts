import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { interpretHarnessRecoveryPayload, resumeHumanInstruction, submitRunDirective } from '../../dev/lib/lab.js';
import { headSha } from '../../dev/lib/git.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { writeCompletion } from '../../dev/lib/records.js';
import { ensureRuntimeDirs, buildInitialState, withTaskState, writeState } from '../../dev/lib/state.js';
import { runGit } from './helpers.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(root);
  await writeFile(path.join(root, 'README.md'), '# target\n', 'utf8');
  await runGit(root, ['init', '-q', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'harness@example.invalid']);
  await runGit(root, ['config', 'user.name', 'Harness Test']);
  await runGit(root, ['add', '-A']);
  await runGit(root, ['commit', '-q', '-m', 'base']);
  return root;
}

function directive(input: { readonly header: string; readonly body: string }): string {
  return `---agentlab\nversion: 1\n${input.header}---\n${input.body}`;
}

const blockedHalt = {
  status: 'BLOCKED' as const,
  blocker: 'AUTOMATED_REMEDIATION_FAILED' as const,
  incident_id: 'task:T1',
  decision_needed: 'corrigir',
  why_automation_stopped: 'repair esgotado',
  options: [],
  evidence_paths: ['attempts/T1.json'],
};

const targetProjectDiagnosis = {
  schema_version: 1 as const,
  classification: 'TARGET_PROJECT' as const,
  root_cause: 'defeito localizável e corrigível',
  evidence: [{ path: 'attempts/T1.json', summary: 'falha reproduzível' }],
  remediation: ['aplicar repair oficial'],
  safe_within_current_authority: true,
  resume_strategy: 'retomar T1',
};

const diagnosed = <T>(diagnosis: T) => ({
  outcome: 'DIAGNOSED' as const,
  diagnosis,
  launches: [{ schema_version: 1 as const, profile_id: 'fixture-investigator', outcome: 'DIAGNOSED' as const }],
});

describe('interpretHarnessRecoveryPayload', () => {
  const base = { incidentId: 'incident-1', nestedRuntimeDir: '/tmp/nested' };

  it('REMEDIATED quando a self-maintenance isolada termina ALL_DONE', () => {
    expect(
      interpretHarnessRecoveryPayload({ ...base, payload: { stopped_by: 'ALL_DONE' } }),
    ).toEqual({ status: 'REMEDIATED' });
  });

  it('propaga HUMAN_REQUIRED estrutural, com a autoridade real vinda do payload aninhado', () => {
    const result = interpretHarnessRecoveryPayload({
      ...base,
      payload: {
        status: 'HUMAN_REQUIRED',
        human_authority: 'DESTRUCTIVE_ACTION',
        decision_needed: 'confirmar exclusão',
        why_automation_stopped: 'exige decisão humana',
        options: ['revisar manualmente'],
      },
    });
    expect(result.status).toBe('HUMAN_REQUIRED');
    if (result.status === 'HUMAN_REQUIRED') {
      expect(result.halt.human_authority).toBe('DESTRUCTIVE_ACTION');
      expect(result.halt.incident_id).toBe('incident-1');
    }
  });

  it('FAILED (nunca HUMAN_REQUIRED fabricado) quando o payload diz HUMAN_REQUIRED sem autoridade válida', () => {
    const result = interpretHarnessRecoveryPayload({
      ...base,
      payload: { status: 'HUMAN_REQUIRED' },
    });
    expect(result.status).toBe('FAILED');
  });

  it('FAILED, preservando o runtime aninhado, quando não é nem ALL_DONE nem HUMAN_REQUIRED', () => {
    const result = interpretHarnessRecoveryPayload({
      ...base,
      payload: { stopped_by: 'AUTOMATIC_REPAIR_EXHAUSTED' },
    });
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') expect(result.reason).toContain('/tmp/nested');
  });
});

describe('recuperação de incidente através de submitRunDirective/resumeHumanInstruction', () => {
  it('persists real terminal evidence when stop mode receives zero evidence_paths', async () => {
    const target = await gitRepo('agentlab-recovery-empty-evidence-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-recovery-empty-evidence-runs-'));
    created.push(runs);
    const result = await submitRunDirective({
      raw_directive: directive({
        header: `target:\n  type: repository\n  path: ${target}\nexecution:\n  recovery_mode: stop\n`,
        body: 'Diagnosticar blocker sem paths.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: async () => ({
        payload: {
          stopped_by: 'BLOCKED',
          project_lifecycle: { halt: { ...blockedHalt, evidence_paths: [] } },
        },
        exitCode: 9,
      }),
    });
    const runtimeDir = result.payload['runtime_dir'] as string;
    const pending = JSON.parse(await readFile(path.join(runtimeDir, 'incidents/pending.json'), 'utf8')) as {
      incident_id: string;
    };
    const diagnosis = JSON.parse(await readFile(
      path.join(runtimeDir, 'incidents', pending.incident_id, 'diagnosis.json'), 'utf8',
    )) as { evidence: { path: string }[] };
    expect(diagnosis.evidence).toHaveLength(1);
    await expect(readFile(diagnosis.evidence[0]!.path, 'utf8')).resolves.toContain('BLOCKED');
  });

  it('offers ask recovery for verification_only official FAIL without project_lifecycle.halt', async () => {
    const target = await gitRepo('agentlab-recovery-verification-only-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-recovery-verification-only-runs-'));
    created.push(runs);
    const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    let calls = 0;
    let promptCalls = 0;
    let investigatorCalls = 0;
    try {
      const result = await submitRunDirective({
        raw_directive: directive({
          header: `target:\n  type: repository\n  path: ${target}\n`,
          body: 'Verificar se docs/WP0.md existe.\n',
        }),
        instruction_source: 'stdin',
        env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
        recovery_decide: async () => { promptCalls += 1; return 'investigate'; },
        run_project: async ({ paths }) => {
          calls += 1;
          if (calls > 1) {
            return { payload: { stopped_by: 'ALL_DONE', generated_plan: { origin: 'MOCK' } }, exitCode: 0 };
          }
          await ensureRuntimeDirs(paths);
          const taskId = 'T1';
          const plan = {
            schema_version: 1 as const,
            tasks: [{
              id: taskId,
              title: 'Verificar WP0',
              blocked_by: [],
              objective: 'Verificar se docs/WP0.md existe.',
              initial_files: ['docs/WP0.md'],
              acceptance: ['WP0 existe'],
              validation: [{ argv: ['test', '-f', 'docs/WP0.md'], timeout_seconds: 30 }],
              planner_metadata: {
                taxonomy: { version: 1, task_class: 'chore', difficulty_declared: 'easy' },
                risk: 'low', probable_files: [], context_scope: { areas: ['docs'] },
                context_requirements: [], environment_requirements: [],
                estimated_duration: { expected: 100, maximum: 1_000 },
                validation_budget: { expected: 100, maximum: 1_000 },
                resource_envelope: {
                  duration_ms: { expected: 100, maximum: 1_000 },
                  tokens: { expected: 100, maximum: 1_000 },
                  changed_files: { expected: 0, maximum: 0 },
                },
              },
            }],
          };
          await mkdir(path.dirname(paths.planFile), { recursive: true });
          await writeFile(paths.planFile, JSON.stringify(plan), 'utf8');
          const loaded = await loadPlan(paths.planFile);
          const task = loaded.plan.tasks[0]!;
          const base = await headSha(target);
          const now = '2026-09-18T00:00:00.000Z';
          await writeState(paths, withTaskState(
            buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: base, now }),
            task.id,
            {
              status: 'FAIL', attempts: 1, base_sha: base,
              diagnostics: 'validação oficial de verification_only falhou', finished_at: now,
            },
          ));
          await writeCompletion(paths, {
            schema_version: 1,
            task_id: task.id,
            status: 'FAIL',
            report: null,
            orchestrator_evidence: {
              task_id: task.id, base_sha: base, candidate_commit: null, accepted_commit: null,
              changed_files: [], working_tree_clean: true, process: null,
              duration_ms: 1, exit_code: 0, timed_out: false,
              revalidation: [{ argv: ['test', '-f', 'docs/WP0.md'], exit_code: 1, timed_out: false, duration_ms: 1 }],
              observed_at: now,
            },
            report_matches_evidence: true,
            discrepancies: [],
            finalization_mode: 'normal',
            closed_at: now,
          });
          return {
            payload: {
              stopped_by: 'FAIL', reason: 'validação oficial de verification_only falhou',
              project_lifecycle: { halt: null },
            },
            exitCode: 9,
          };
        },
        incident_investigator: {
          investigate: async () => { investigatorCalls += 1; return diagnosed(targetProjectDiagnosis); },
        },
        incident_remediation: { remediate: async () => ({ status: 'REMEDIATED' as const }) },
      });
      expect(promptCalls).toBe(1);
      expect(investigatorCalls).toBe(1);
      expect(calls).toBe(2);
      expect(result.payload['stopped_by']).toBe('ALL_DONE');
    } finally {
      if (tty === undefined) delete (process.stderr as { isTTY?: boolean }).isTTY;
      else Object.defineProperty(process.stderr, 'isTTY', tty);
      vi.restoreAllMocks();
    }
  });

  it('recovery_mode=auto remedia e retoma automaticamente o MESMO runtime até ALL_DONE', async () => {
    const target = await gitRepo('agentlab-recovery-auto-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-recovery-auto-runs-'));
    created.push(runs);
    let calls = 0;
    let remediated = false;
    const result = await submitRunDirective({
      raw_directive: directive({
        header: `target:\n  type: repository\n  path: ${target}\nexecution:\n  recovery_mode: auto\n`,
        body: 'Corrigir o parser.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: async () => {
        calls += 1;
        if (calls === 1) {
          return { payload: { stopped_by: 'BLOCKED', project_lifecycle: { halt: blockedHalt } }, exitCode: 9 };
        }
        return { payload: { stopped_by: 'ALL_DONE', generated_plan: { origin: 'MOCK' } }, exitCode: 0 };
      },
      incident_investigator: { investigate: async () => diagnosed(targetProjectDiagnosis) },
      incident_remediation: {
        remediate: async () => {
          remediated = true;
          return { status: 'REMEDIATED' as const };
        },
      },
    });
    expect(calls).toBe(2);
    expect(remediated).toBe(true);
    expect(result.payload['stopped_by']).toBe('ALL_DONE');
    expect(result.payload['recovery']).toMatchObject({ status: 'RECOVERY_SUCCEEDED' });
    expect(result.exitCode).toBe(0);
  });

  it('HUMAN_REQUIRED vindo da remediação vira o mesmo halt estrutural, sem resumir a execução', async () => {
    const target = await gitRepo('agentlab-recovery-human-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-recovery-human-runs-'));
    created.push(runs);
    let calls = 0;
    const result = await submitRunDirective({
      raw_directive: directive({
        header: `target:\n  type: repository\n  path: ${target}\nexecution:\n  recovery_mode: auto\n`,
        body: 'Corrigir o parser.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: async () => {
        calls += 1;
        return { payload: { stopped_by: 'BLOCKED', project_lifecycle: { halt: blockedHalt } }, exitCode: 9 };
      },
      incident_investigator: {
        investigate: async () => diagnosed({ ...targetProjectDiagnosis, classification: 'HARNESS' as const }),
      },
      incident_remediation: {
        remediate: async () => ({
          status: 'HUMAN_REQUIRED' as const,
          halt: {
            status: 'HUMAN_REQUIRED' as const,
            human_authority: 'DESTRUCTIVE_ACTION' as const,
            incident_id: 'incident-nested',
            decision_needed: 'confirmar',
            why_automation_stopped: 'self-maintenance isolada exige decisão',
            options: [],
            evidence_paths: [],
          },
        }),
      },
    });
    expect(calls).toBe(1);
    const recovery = result.payload['recovery'] as { status: string; human_authority: string };
    expect(recovery.status).toBe('HUMAN_REQUIRED');
    expect(recovery.human_authority).toBe('DESTRUCTIVE_ACTION');
  });

  it('HARNESS integrado exige restart e o controller antigo não retoma executeProject', async () => {
    const target = await gitRepo('agentlab-recovery-restart-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-recovery-restart-runs-'));
    created.push(runs);
    let calls = 0;
    const result = await submitRunDirective({
      raw_directive: directive({
        header: `target:\n  type: repository\n  path: ${target}\nexecution:\n  recovery_mode: auto\n`,
        body: 'Corrigir o controller do Agent Lab.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: async () => {
        calls += 1;
        return { payload: { stopped_by: 'BLOCKED', project_lifecycle: { halt: blockedHalt } }, exitCode: 9 };
      },
      incident_investigator: {
        investigate: async () => diagnosed({ ...targetProjectDiagnosis, classification: 'HARNESS' as const }),
      },
      incident_remediation: {
        remediate: async ({ incident }) => ({
          status: 'RESTART_REQUIRED' as const,
          record: {
            schema_version: 1 as const,
            parent_runtime_dir: incident.runtime_dir,
            incident_id: incident.incident_id,
            harness_recovery_runtime_dir: path.join(incident.runtime_dir, 'incidents', incident.incident_id, 'harness-recovery'),
            integrated_sha: 'e'.repeat(40),
            original_entry_intent: 'SUBMIT' as const,
            resume_target: incident.runtime_dir,
            state: 'INTEGRATED_PENDING_RESUME' as const,
          },
        }),
      },
    });

    expect(calls).toBe(1);
    expect(result.exitCode).toBe(75);
    expect(result.payload['recovery']).toMatchObject({
      status: 'RESTART_REQUIRED',
      restart: { integrated_sha: 'e'.repeat(40), state: 'INTEGRATED_PENDING_RESUME' },
    });
  });

  it('orçamento real: fingerprint que persiste através de resumes sucessivos esgota e para sem invocar o investigator de novo', async () => {
    const target = await gitRepo('agentlab-recovery-budget-');
    const runs = await mkdtemp(path.join(os.tmpdir(), 'agentlab-recovery-budget-runs-'));
    created.push(runs);
    let investigatorCalls = 0;
    let remediationCalls = 0;
    const runProject = async () => ({
      payload: { stopped_by: 'BLOCKED', project_lifecycle: { halt: blockedHalt } },
      exitCode: 9,
    });
    const investigator = {
      investigate: async () => { investigatorCalls += 1; return diagnosed(targetProjectDiagnosis); },
    };
    const remediation = {
      remediate: async () => {
        remediationCalls += 1;
        return { status: 'REMEDIATED' as const };
      },
    };

    const first = await submitRunDirective({
      raw_directive: directive({
        header: `target:\n  type: repository\n  path: ${target}\nexecution:\n  recovery_mode: auto\n`,
        body: 'Corrigir o parser.\n',
      }),
      instruction_source: 'stdin',
      env: { AGENTLAB_FAKE_MODE: '1', AGENTLAB_RUNS_DIR: runs },
      run_project: runProject,
      incident_investigator: investigator,
      incident_remediation: remediation,
    });
    const runtimeDir = first.payload['runtime_dir'] as string;
    expect(investigatorCalls).toBe(1);
    expect(remediationCalls).toBe(1);

    // Mesmo defeito, mesma task, mesma evidência: o SEGUNDO resume vê a
    // MESMA fingerprint e consome o segundo ciclo de remediação disponível.
    const second = await resumeHumanInstruction({
      runtime_dir: runtimeDir,
      env: { AGENTLAB_FAKE_MODE: '1' },
      run_project: runProject,
      incident_investigator: investigator,
      incident_remediation: remediation,
      recovery_decide: async () => 'investigate' as const,
    });
    expect(investigatorCalls).toBe(2);
    expect(remediationCalls).toBe(2);
    expect(second.payload['stopped_by']).toBe('BLOCKED');
    const secondRecovery = second.payload['recovery'] as { status: string; next_incident?: { status: string } };
    expect(secondRecovery.status).toBe('RECOVERY_SUCCEEDED');
    expect(secondRecovery.next_incident?.status).toBe('RECOVERY_REQUIRED');

    // Terceiro resume: orçamento de remediação (2) já esgotado para esta
    // fingerprint — bloqueia SEM lançar o investigator de novo.
    const third = await resumeHumanInstruction({
      runtime_dir: runtimeDir,
      env: { AGENTLAB_FAKE_MODE: '1' },
      run_project: runProject,
      incident_investigator: investigator,
      incident_remediation: remediation,
      recovery_decide: async () => 'investigate' as const,
    });
    expect(investigatorCalls).toBe(2);
    expect(remediationCalls).toBe(2);
    const thirdRecovery = third.payload['recovery'] as { status: string; reason?: string };
    expect(thirdRecovery.status).toBe('BLOCKED');
    expect(thirdRecovery.reason).toMatch(/orçamento|fingerprint/);
  });
});
