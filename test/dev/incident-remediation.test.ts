import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import {
  createDefaultIncidentRemediationPort,
  remediateMissingContext,
  remediateTargetProject,
} from '../../dev/lib/incident-remediation.js';
import { DEFAULT_RECOVERY_BUDGET, type IncidentDiagnosis, type RecoveryIncident } from '../../dev/lib/incident-recovery.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

async function newDevDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlab-remediation-'));
  created.push(dir);
  return dir;
}

function incidentWith(overrides: Partial<RecoveryIncident>): RecoveryIncident {
  return {
    schema_version: 1,
    incident_id: 'incident-fixture',
    fingerprint: 'a'.repeat(64),
    task_id: 'T1',
    blocker: 'AUTOMATED_REMEDIATION_FAILED',
    reason: 'repair e escalation não resolveram',
    evidence_paths: [],
    runtime_dir: '/tmp/does-not-matter',
    created_at: '2026-09-17T00:00:00.000Z',
    budget: DEFAULT_RECOVERY_BUDGET,
    ...overrides,
  };
}

const diagnosis: IncidentDiagnosis = {
  schema_version: 1,
  classification: 'TARGET_PROJECT',
  root_cause: 'defeito localizável no repositório alvo',
  evidence: [{ path: 'attempt.json', summary: 'falha reproduzível' }],
  remediation: ['aplicar o repair oficial'],
  safe_within_current_authority: true,
  resume_strategy: 'retomar T1',
};

describe('remediateTargetProject', () => {
  it('recusa sem task_id, sem tentar nenhum grant', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(devDir, { devDir });
    const result = await remediateTargetProject({
      paths,
      incident: incidentWith({ task_id: null }),
      diagnosis,
    });
    expect(result).toEqual({
      status: 'FAILED',
      reason: 'remediação TARGET_PROJECT exige um task_id e o incidente não registrou nenhum',
    });
  });

  it('propaga como FAILED (não lança) quando a primitive oficial de grant recusa', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(devDir, { devDir });
    // Runtime vazio: a task nunca foi tentada, então `decideAutomaticRepair`
    // não reporta REPAIR_EXHAUSTED e a primitive oficial recusa o grant. Isso
    // prova que a falha da primitive vira BLOCKED via FAILED, nunca uma
    // exceção não tratada subindo até o coordinator.
    const result = await remediateTargetProject({
      paths,
      incident: incidentWith({ task_id: 'T1' }),
      diagnosis,
    });
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toContain('grant de repair adicional falhou');
    }
  });
});

describe('remediateMissingContext', () => {
  it('REMEDIATED quando toda a evidência listada existe', async () => {
    const devDir = await newDevDir();
    const file = path.join(devDir, 'evidence.txt');
    await writeFile(file, 'conteúdo', 'utf8');
    const result = await remediateMissingContext({ incident: incidentWith({ evidence_paths: [file] }) });
    expect(result).toEqual({ status: 'REMEDIATED' });
  });

  it('FAILED listando os paths ainda ausentes, sem inventar HUMAN_REQUIRED', async () => {
    const devDir = await newDevDir();
    const missing = path.join(devDir, 'nao-existe.txt');
    const result = await remediateMissingContext({ incident: incidentWith({ evidence_paths: [missing] }) });
    expect(result.status).toBe('FAILED');
    if (result.status === 'FAILED') {
      expect(result.reason).toContain(missing);
    }
  });
});

describe('createDefaultIncidentRemediationPort', () => {
  it('roteia HARNESS para a dependência injetada, sem tocar TARGET_PROJECT/MISSING_CONTEXT', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(devDir, { devDir });
    let harnessCalls = 0;
    const port = createDefaultIncidentRemediationPort({
      paths,
      harness: async () => {
        harnessCalls += 1;
        return { status: 'REMEDIATED' as const };
      },
    });
    const result = await port.remediate({
      incident: incidentWith({}),
      diagnosis: { ...diagnosis, classification: 'HARNESS' },
    });
    expect(harnessCalls).toBe(1);
    expect(result).toEqual({ status: 'REMEDIATED' });
  });

  it('roteia MISSING_CONTEXT para a checagem read-only de evidência', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(devDir, { devDir });
    const port = createDefaultIncidentRemediationPort({
      paths,
      harness: async () => ({ status: 'FAILED' as const, reason: 'não deveria ser chamado' }),
    });
    const result = await port.remediate({
      incident: incidentWith({ evidence_paths: [] }),
      diagnosis: { ...diagnosis, classification: 'MISSING_CONTEXT' },
    });
    expect(result).toEqual({ status: 'REMEDIATED' });
  });

  it('FAILED honesto para classification sem estratégia implementada (ENVIRONMENT/PROVIDER)', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(devDir, { devDir });
    const port = createDefaultIncidentRemediationPort({
      paths,
      harness: async () => ({ status: 'FAILED' as const, reason: 'não deveria ser chamado' }),
    });
    const result = await port.remediate({
      incident: incidentWith({}),
      diagnosis: { ...diagnosis, classification: 'PROVIDER' },
    });
    expect(result.status).toBe('FAILED');
  });
});
