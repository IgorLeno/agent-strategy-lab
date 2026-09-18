import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { coordinateIncidentRecovery } from '../../dev/lib/incident-recovery-coordinator.js';
import { remediateMissingContext } from '../../dev/lib/incident-remediation.js';
import { DEFAULT_RECOVERY_BUDGET } from '../../dev/lib/incident-recovery.js';
import { reconcileMissingContext } from '../../dev/lib/missing-context-reconciliation.js';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { runGit } from './helpers.js';

const created: string[] = [];
afterEach(async () => Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-missing-context-'));
  created.push(root);
  const repo = path.join(root, 'target');
  const group = path.join(root, 'runs', 'target-id');
  const current = path.join(group, 'current');
  const previous = path.join(group, 'previous');
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'README.md'), '# target\n');
  await runGit(repo, ['init', '-q', '-b', 'main']);
  await runGit(repo, ['config', 'user.email', 'test@example.invalid']);
  await runGit(repo, ['config', 'user.name', 'Test']);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-q', '-m', 'base']);
  await mkdir(path.join(previous, 'artifacts', 'docs'), { recursive: true });
  await mkdir(current, { recursive: true });
  return { repo, current, previous, paths: resolveHarnessPaths(repo, { devDir: current }) };
}

describe('reconcileMissingContext', () => {
  it('finds WP0 in an authorized sibling runtime and persists a content-addressed manifest', async () => {
    const f = await fixture();
    await writeFile(path.join(f.previous, 'artifacts', 'docs', 'WP0.md'), '# WP0 recuperado\n');

    const result = await reconcileMissingContext({
      paths: f.paths,
      runtimeDir: f.current,
      incidentId: 'incident-wp0',
      requestedPaths: [path.join(f.repo, 'docs', 'WP0.md')],
    });

    expect(result.status).toBe('FOUND_RECOVERABLE');
    if (result.status === 'FOUND_RECOVERABLE') {
      const artifact = result.evidence_paths.find((candidate) => candidate.endsWith('-WP0.md'))!;
      expect(await readFile(artifact, 'utf8')).toContain('WP0 recuperado');
      const manifest = JSON.parse(await readFile(result.manifest_path, 'utf8')) as { matches: unknown[] };
      expect(manifest.matches).toHaveLength(1);
      expect(result.manifest_path).toMatch(/[a-f0-9]{64}\.json$/);
    }
  });

  it('returns an honest technical absence without fabricating human authority', async () => {
    const f = await fixture();
    const result = await reconcileMissingContext({
      paths: f.paths,
      runtimeDir: f.current,
      incidentId: 'incident-absent',
      requestedPaths: [path.join(f.repo, 'docs', 'WP0.md')],
    });
    expect(result).toMatchObject({ status: 'NOT_FOUND_TECHNICAL' });
    expect(result).not.toHaveProperty('human_authority');
  });
});

describe('MISSING_CONTEXT recovery flow', () => {
  it('recupera WP0 de runtime anterior, reinvestiga uma vez e continua pela classificação nova', async () => {
    const f = await fixture();
    const requested = path.join(f.repo, 'docs', 'WP0.md');
    await writeFile(path.join(f.previous, 'artifacts', 'docs', 'WP0.md'), '# WP0 recuperado\n');
    const incident = {
      schema_version: 1 as const,
      incident_id: 'incident-wp0-flow',
      fingerprint: 'd'.repeat(64),
      task_id: 'T1',
      blocker: 'AUTOMATED_REMEDIATION_FAILED' as const,
      reason: 'WP0 ausente no checkout atual',
      evidence_paths: [requested],
      runtime_dir: f.current,
      created_at: '2026-09-18T00:00:00.000Z',
      budget: DEFAULT_RECOVERY_BUDGET,
    };
    let investigations = 0;
    let remediations = 0;

    const result = await coordinateIncidentRecovery({
      runtimeDir: f.current,
      incident,
      usage: { investigator_launches: 0, remediation_cycles: 0, previous_fingerprints: [] },
      investigator: {
        investigate: async ({ incident: currentIncident, maximumLaunches }) => {
          investigations += 1;
          expect(maximumLaunches).toBe(4 - investigations);
          if (investigations === 1) {
            return {
              outcome: 'DIAGNOSED' as const,
              diagnosis: {
                schema_version: 1 as const,
                classification: 'MISSING_CONTEXT' as const,
                root_cause: 'WP0 não está presente no checkout atual',
                evidence: [{ path: requested, summary: 'referência ausente preservada' }],
                remediation: ['buscar somente em fontes locais autorizadas'],
                safe_within_current_authority: true,
                resume_strategy: 'reinvestigar com o WP0 recuperado',
              },
              launches: [{ schema_version: 1 as const, profile_id: 'investigator-a', outcome: 'DIAGNOSED' as const }],
            };
          }
          expect(currentIncident.evidence_paths.some((candidate) => candidate.endsWith('-WP0.md'))).toBe(true);
          return {
            outcome: 'DIAGNOSED' as const,
            diagnosis: {
              schema_version: 1 as const,
              classification: 'TARGET_PROJECT' as const,
              root_cause: 'o WP0 recuperado permite continuar no projeto alvo',
              evidence: currentIncident.evidence_paths.map((evidencePath) => ({
                path: evidencePath,
                summary: 'evidência reconciliada',
              })),
              remediation: ['continuar pelo lifecycle oficial'],
              safe_within_current_authority: true,
              resume_strategy: 'retomar T1',
            },
            launches: [{ schema_version: 1 as const, profile_id: 'investigator-b', outcome: 'DIAGNOSED' as const }],
          };
        },
      },
      remediation: {
        remediate: async ({ incident: currentIncident, diagnosis }) => {
          remediations += 1;
          if (diagnosis.classification === 'MISSING_CONTEXT') {
            return remediateMissingContext({ paths: f.paths, incident: currentIncident, diagnosis });
          }
          expect(currentIncident.evidence_paths.some((candidate) => candidate.endsWith('-WP0.md'))).toBe(true);
          return { status: 'REMEDIATED' as const };
        },
      },
    });

    expect(result).toMatchObject({ status: 'RESUME', diagnosis: { classification: 'TARGET_PROJECT' } });
    expect(investigations).toBe(2);
    expect(remediations).toBe(2);
    await expect(readFile(
      path.join(f.current, 'incidents', incident.incident_id, 'attempts', '1', 'reinvestigation-diagnosis.json'),
      'utf8',
    )).resolves.toContain('TARGET_PROJECT');
  });
});
