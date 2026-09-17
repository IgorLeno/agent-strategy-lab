import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { ProjectRunAuthorizationFile, type LoadedProjectRunAuthorization } from '../../dev/lib/project-authorization.js';
import {
  createDefaultIncidentInvestigatorPort,
  launchIncidentInvestigator,
} from '../../dev/lib/incident-investigator.js';
import type { RecoveryIncident } from '../../dev/lib/incident-recovery.js';
import { DEFAULT_RECOVERY_BUDGET } from '../../dev/lib/incident-recovery.js';
import { REPO_ROOT } from './helpers.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

function minimalAuthorizationObject(profileIds: readonly string[]): unknown {
  return {
    schema_version: 1,
    requested_scope: { summary: 'investigar incidente técnico' },
    constraints: [],
    exclusions: [],
    autonomous_execution_boundary: ['CONFIGURED_SUBSCRIPTION_WORKER'],
    human_gated_capabilities: ['UNAUTHORIZED_API_BILLING'],
    billing: { allowed_billing_modes: ['not_applicable'] },
    profile_policy: {
      id: 'fake-policy',
      allowed_providers: ['fake'],
      profiles: profileIds.map((id, index) => ({ id, capability_rank: index, rationale: 'fixture' })),
    },
    work_units: {
      default: {
        task_class: 'feature',
        difficulty_declared: 'easy',
        risk: 'low',
        complexity: 'local',
        ambiguity: 'low',
        verification: 'deterministic',
        resource_envelope: {
          duration_ms: { expected: 20000, maximum: 60000 },
          tokens: { expected: 30000, maximum: 90000 },
          changed_files: { expected: 3, maximum: 8 },
        },
      },
      overrides: {},
    },
  };
}

async function authorizationWith(profileIds: readonly string[]): Promise<LoadedProjectRunAuthorization> {
  return {
    file: ProjectRunAuthorizationFile.parse(minimalAuthorizationObject(profileIds)),
    source_file: '(fixture)',
  };
}

async function newDevDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentlab-investigator-'));
  created.push(dir);
  return dir;
}

const incident: RecoveryIncident = {
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
};

const validDiagnosis = {
  schema_version: 1,
  classification: 'TARGET_PROJECT',
  root_cause: 'a task falhou por um defeito localizável no repositório alvo',
  evidence: [{ path: 'attempt.json', summary: 'falha reproduzível' }],
  remediation: ['aplicar o repair oficial'],
  safe_within_current_authority: true,
  resume_strategy: 'retomar T1 após o repair',
};

describe('launchIncidentInvestigator', () => {
  it('reusa o mecanismo read-only do reviewer e devolve um diagnóstico validado', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(REPO_ROOT, { devDir });
    const authorization = await authorizationWith(['fake-worker-economy-v1']);
    let calls = 0;
    const result = await launchIncidentInvestigator({
      paths,
      authorization,
      incident,
      port: {
        run: async (input) => {
          calls += 1;
          expect(input.role).toBe('reviewer');
          return JSON.stringify(validDiagnosis);
        },
      },
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ outcome: 'DIAGNOSED', profile_id: 'fake-worker-economy-v1' });
    if (result.outcome === 'DIAGNOSED') {
      expect(result.diagnosis.classification).toBe('TARGET_PROJECT');
    }
  });

  it('faz failover para o próximo profile elegível quando o primeiro não produz JSON válido', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(REPO_ROOT, { devDir });
    const authorization = await authorizationWith(['fake-worker-economy-v1', 'fake-worker-advanced-v1']);
    const attempted: string[] = [];
    const result = await launchIncidentInvestigator({
      paths,
      authorization,
      incident,
      port: {
        run: async (input) => {
          attempted.push(input.profile.id);
          if (input.profile.id === 'fake-worker-economy-v1') return 'isto não é JSON';
          return JSON.stringify(validDiagnosis);
        },
      },
    });
    expect(attempted).toEqual(['fake-worker-economy-v1', 'fake-worker-advanced-v1']);
    expect(result).toMatchObject({ outcome: 'DIAGNOSED', profile_id: 'fake-worker-advanced-v1' });
  });

  it('devolve UNAVAILABLE quando nenhum profile produz diagnóstico', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(REPO_ROOT, { devDir });
    const authorization = await authorizationWith(['fake-worker-economy-v1']);
    const result = await launchIncidentInvestigator({
      paths,
      authorization,
      incident,
      port: { run: async () => 'não é JSON' },
    });
    expect(result.outcome).toBe('UNAVAILABLE');
  });

  it('a porta padrão lança quando indisponível, e devolve o diagnóstico quando disponível', async () => {
    const devDir = await newDevDir();
    const paths = resolveHarnessPaths(REPO_ROOT, { devDir });
    const authorization = await authorizationWith(['fake-worker-economy-v1']);
    const port = createDefaultIncidentInvestigatorPort({
      paths,
      authorization,
      port: { run: async () => JSON.stringify(validDiagnosis) },
    });
    const diagnosis = await port.investigate({ incident });
    expect(diagnosis).toMatchObject({ classification: 'TARGET_PROJECT' });

    const failingPort = createDefaultIncidentInvestigatorPort({
      paths,
      authorization,
      port: { run: async () => 'não é JSON' },
    });
    await expect(failingPort.investigate({ incident })).rejects.toThrow();
  });
});
