import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultIncidentRemediationPort } from '../../dev/lib/incident-remediation.js';
import { DEFAULT_RECOVERY_BUDGET, type IncidentDiagnosis, type RecoveryIncident } from '../../dev/lib/incident-recovery.js';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-recovery-authority-'));
  created.push(root);
  const runtime = path.join(root, 'runtime');
  return { root, runtime, paths: resolveHarnessPaths(root, { devDir: runtime }) };
}

function incident(runtime: string): RecoveryIncident {
  return {
    schema_version: 1,
    incident_id: 'incident-authority',
    fingerprint: 'a'.repeat(64),
    task_id: 'T1',
    blocker: 'PROVIDER_OR_INFRA_FAILURE',
    reason: 'falha técnica terminal',
    evidence_paths: [],
    runtime_dir: runtime,
    created_at: '2026-09-18T00:00:00.000Z',
    budget: DEFAULT_RECOVERY_BUDGET,
  };
}

function diagnosis(classification: 'ENVIRONMENT' | 'PROVIDER'): IncidentDiagnosis {
  return {
    schema_version: 1,
    classification,
    root_cause: 'causa técnica sem primitive autônoma comprovada',
    evidence: [],
    remediation: ['reinspecionar sem ampliar autoridade'],
    safe_within_current_authority: true,
    resume_strategy: 'parar tecnicamente',
  };
}

async function expectAbsent(file: string): Promise<void> {
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('ENVIRONMENT/PROVIDER recovery authority', () => {
  it('ENVIRONMENT permanece BLOCKED porque não há refresh canônico com pré-condições provadas', async () => {
    const f = await fixture();
    let harnessCalls = 0;
    const port = createDefaultIncidentRemediationPort({
      paths: f.paths,
      harness: async () => { harnessCalls += 1; return { status: 'REMEDIATED' as const }; },
    });
    const result = await port.remediate({ incident: incident(f.runtime), diagnosis: diagnosis('ENVIRONMENT') });
    expect(result).toMatchObject({
      status: 'FAILED',
      reason: expect.stringContaining('preflight/reinspection'),
    });
    expect(harnessCalls).toBe(0);
  });

  it('PROVIDER permanece BLOCKED porque retry/failover só existe dentro da policy do lifecycle', async () => {
    const f = await fixture();
    let harnessCalls = 0;
    const port = createDefaultIncidentRemediationPort({
      paths: f.paths,
      harness: async () => { harnessCalls += 1; return { status: 'REMEDIATED' as const }; },
    });
    const result = await port.remediate({ incident: incident(f.runtime), diagnosis: diagnosis('PROVIDER') });
    expect(result).toMatchObject({
      status: 'FAILED',
      reason: expect.stringContaining('retry/failover'),
    });
    expect(harnessCalls).toBe(0);

    await expectAbsent(f.paths.providerExpansionAuthorizationsDir);
    await expectAbsent(f.paths.additionalRepairAuthorizationsDir);
    await expectAbsent(path.join(f.runtime, 'lab', 'publish-grant.json'));
    await expectAbsent(path.join(f.runtime, 'lab', 'authorization.yaml'));
    await expectAbsent(path.join(f.runtime, 'billing'));
    await expectAbsent(path.join(f.runtime, 'credentials'));
  });
});
