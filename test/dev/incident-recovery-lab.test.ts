import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { interpretHarnessRecoveryPayload, resumeHumanInstruction, submitRunDirective } from '../../dev/lib/lab.js';
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
      incident_investigator: { investigate: async () => targetProjectDiagnosis },
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
      incident_investigator: { investigate: async () => ({ ...targetProjectDiagnosis, classification: 'HARNESS' as const }) },
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
    const investigator = { investigate: async () => { investigatorCalls += 1; return targetProjectDiagnosis; } };
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
