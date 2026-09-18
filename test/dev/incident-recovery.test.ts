import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_RECOVERY_BUDGET,
  IncidentDiagnosis,
  diagnosticFromTechnicalHalt,
  incidentFingerprint,
  recoveryBudgetStatus,
  recoveryModeForSession,
  technicalHaltFromPayload,
} from '../../dev/lib/incident-recovery.js';
import {
  incidentArtifactPaths,
  investigatorLaunchEvidencePath,
  loadRecoveryUsage,
  persistIncidentDiagnosis,
  persistRecoveryDecision,
  persistRecoveryIncident,
} from '../../dev/lib/lab-runtime.js';
import { coordinateIncidentRecovery } from '../../dev/lib/incident-recovery-coordinator.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

const halt = {
  status: 'BLOCKED' as const,
  blocker: 'AUTOMATED_REMEDIATION_FAILED' as const,
  incident_id: 'project:T1:escalation',
  decision_needed: 'corrigir o defeito técnico',
  why_automation_stopped: 'repair e escalation não resolveram',
  options: ['inspecionar'],
  evidence_paths: ['runtime/attempts/1.json'],
};

const diagnosed = <T>(diagnosis: T) => ({
  outcome: 'DIAGNOSED' as const,
  diagnosis,
  launches: [{ schema_version: 1 as const, profile_id: 'fixture-investigator', outcome: 'DIAGNOSED' as const }],
});

describe('incident recovery contracts', () => {
  it('reconhece somente o halt técnico tipado do lifecycle', () => {
    expect(technicalHaltFromPayload({ project_lifecycle: { halt } })).toEqual(halt);
    expect(technicalHaltFromPayload({ status: 'BLOCKED' })).toBeNull();
    expect(technicalHaltFromPayload({ project_lifecycle: { halt: { ...halt, status: 'HUMAN_REQUIRED' } } })).toBeNull();
  });

  it('fingerprint é estável para a mesma evidência e independente da ordem dos paths', () => {
    const common = { task_id: 'T1', blocker: halt.blocker, reason: halt.why_automation_stopped };
    expect(incidentFingerprint({ ...common, evidence_paths: ['b', 'a'], base_sha: 'base' })).toBe(
      incidentFingerprint({ ...common, evidence_paths: ['a', 'b'], base_sha: 'base' }),
    );
  });

  it('não permite transformar repetição técnica em autorização humana', () => {
    const fingerprint = 'a'.repeat(64);
    expect(recoveryBudgetStatus(DEFAULT_RECOVERY_BUDGET, {
      investigator_launches: 0,
      remediation_cycles: 2,
      previous_fingerprints: [fingerprint],
    }, fingerprint)).toMatchObject({ status: 'EXHAUSTED' });
  });

  it('ask é default apenas em TTY; non-TTY para sem bloquear', () => {
    expect(recoveryModeForSession({ isTTY: true, configured: undefined })).toBe('ask');
    expect(recoveryModeForSession({ isTTY: false, configured: undefined })).toBe('stop');
    expect(recoveryModeForSession({ isTTY: false, configured: 'auto' })).toBe('auto');
  });

  it('o diagnóstico de stop é factual e não inventa autoridade humana', () => {
    expect(diagnosticFromTechnicalHalt(halt, '/runtime/terminal-lifecycle.json')).toMatchObject({
      classification: 'TARGET_PROJECT',
      safe_within_current_authority: false,
      root_cause: halt.why_automation_stopped,
    });
  });

  it('diagnóstico humano exige autoridade concreta e não permite repair autorizado', () => {
    expect(() => IncidentDiagnosis.parse({
      schema_version: 1,
      classification: 'HUMAN_DECISION',
      root_cause: 'requisito de produto ausente',
      evidence: [{ path: 'runtime/incident.json', summary: 'nenhuma definição encontrada' }],
      remediation: [],
      safe_within_current_authority: true,
      resume_strategy: 'esperar',
    })).toThrow(/human_authority|autoridade/);
  });
});

describe('incident artifacts', () => {
  it('persiste incident, decisão e diagnóstico no runtime, sem reescrever o incidente', async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'agentlab-incident-'));
    created.push(runtimeDir);
    const fingerprint = incidentFingerprint({
      task_id: 'T1', blocker: halt.blocker, reason: halt.why_automation_stopped, evidence_paths: halt.evidence_paths,
    });
    const incident = {
      schema_version: 1 as const,
      incident_id: 'incident-1',
      fingerprint,
      task_id: 'T1',
      blocker: halt.blocker,
      reason: halt.why_automation_stopped,
      evidence_paths: halt.evidence_paths,
      runtime_dir: runtimeDir,
      created_at: '2026-09-17T00:00:00.000Z',
      budget: DEFAULT_RECOVERY_BUDGET,
    };
    await persistRecoveryIncident({ runtimeDir, incident, mode: 'stop' });
    await persistRecoveryDecision(runtimeDir, incident.incident_id, 'stop');
    await persistIncidentDiagnosis(runtimeDir, incident.incident_id, {
      schema_version: 1,
      classification: 'MISSING_CONTEXT',
      root_cause: 'artifact ausente',
      evidence: [{ path: 'runtime/attempts/1.json', summary: 'referência preservada' }],
      remediation: ['procurar no histórico local'],
      safe_within_current_authority: true,
      resume_strategy: 'reconciliar artifact',
    });
    const paths = incidentArtifactPaths(runtimeDir, incident.incident_id);
    expect(JSON.parse(await readFile(paths.incident, 'utf8'))).toMatchObject({ fingerprint, blocker: halt.blocker });
    expect(JSON.parse(await readFile(paths.decision, 'utf8'))).toMatchObject({ decision: 'stop' });
    expect(JSON.parse(await readFile(paths.diagnosis, 'utf8'))).toMatchObject({ classification: 'MISSING_CONTEXT' });
    expect(JSON.parse(await readFile(path.join(runtimeDir, 'incidents/pending.json'), 'utf8'))).toMatchObject({ mode: 'stop' });
  });
});

describe('incident recovery coordinator', () => {
  it('converte somente um diagnóstico HUMAN_DECISION validado no halt humano existente', async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'agentlab-coordinator-'));
    created.push(runtimeDir);
    const incident = {
      schema_version: 1 as const, incident_id: 'incident-human', fingerprint: 'b'.repeat(64), task_id: 'T1',
      blocker: halt.blocker, reason: halt.why_automation_stopped, evidence_paths: halt.evidence_paths,
      runtime_dir: runtimeDir, created_at: '2026-09-17T00:00:00.000Z', budget: DEFAULT_RECOVERY_BUDGET,
    };
    const result = await coordinateIncidentRecovery({
      runtimeDir, incident, usage: { investigator_launches: 0, remediation_cycles: 0, previous_fingerprints: [] },
      investigator: { investigate: async () => diagnosed({
        schema_version: 1, classification: 'HUMAN_DECISION', root_cause: 'decisão de produto ausente',
        evidence: [{ path: 'instruction.md', summary: 'não define a decisão' }], remediation: ['definir o comportamento'],
        safe_within_current_authority: false, resume_strategy: 'aguardar decisão',
        human_authority: 'UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION',
      }) },
      remediation: { remediate: async () => { throw new Error('não deve remediar HUMAN_DECISION'); } },
    });
    expect(result).toMatchObject({ status: 'HUMAN_REQUIRED' });
    if (result.status === 'HUMAN_REQUIRED') {
      expect(result.halt.human_authority).toBe('UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION');
    }
  });

  it('só libera resume depois de remediação oficial', async () => {
    const runtimeDir = await mkdtemp(path.join(os.tmpdir(), 'agentlab-remediate-'));
    created.push(runtimeDir);
    const incident = {
      schema_version: 1 as const, incident_id: 'incident-repair', fingerprint: 'c'.repeat(64), task_id: 'T1',
      blocker: halt.blocker, reason: halt.why_automation_stopped, evidence_paths: halt.evidence_paths,
      runtime_dir: runtimeDir, created_at: '2026-09-17T00:00:00.000Z',
      budget: { ...DEFAULT_RECOVERY_BUDGET, max_investigator_launches: 2 },
    };
    let remediated = false;
    const result = await coordinateIncidentRecovery({
      runtimeDir, incident, usage: { investigator_launches: 0, remediation_cycles: 0, previous_fingerprints: [] },
      investigator: { investigate: async ({ maximumLaunches }) => {
        expect(maximumLaunches).toBe(2);
        return {
          outcome: 'DIAGNOSED' as const,
          diagnosis: {
            schema_version: 1 as const, classification: 'TARGET_PROJECT' as const,
            root_cause: 'defeito localizado',
            evidence: [{ path: 'attempt.json', summary: 'falha reproduzível' }],
            remediation: ['rodar retry oficial'], safe_within_current_authority: true,
            resume_strategy: 'retomar T1',
          },
          launches: [
            { schema_version: 1 as const, profile_id: 'profile-a', outcome: 'INVALID_OUTPUT' as const },
            { schema_version: 1 as const, profile_id: 'profile-b', outcome: 'DIAGNOSED' as const },
          ],
        };
      } },
      remediation: { remediate: async () => { remediated = true; return { status: 'REMEDIATED' as const }; } },
    });
    expect(remediated).toBe(true);
    expect(result.status).toBe('RESUME');
    expect(await loadRecoveryUsage(runtimeDir, incident.incident_id)).toMatchObject({
      investigator_launches: 2,
      remediation_cycles: 1,
    });
    await expect(readFile(
      investigatorLaunchEvidencePath(runtimeDir, incident.incident_id, 1), 'utf8',
    )).resolves.toContain('profile-a');
    await expect(readFile(
      investigatorLaunchEvidencePath(runtimeDir, incident.incident_id, 2), 'utf8',
    )).resolves.toContain('profile-b');
  });
});
