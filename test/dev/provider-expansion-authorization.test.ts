import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProviderExpansionAuthorizationError,
  applyProviderExpansionAuthorization,
  grantProviderExpansionAuthorization,
} from '../../dev/lib/provider-expansion.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import {
  loadProjectRunAuthorization,
  type ProjectRunAuthorizationFile,
} from '../../dev/lib/project-authorization.js';
import { ensureRuntimeDirs } from '../../dev/lib/state.js';
import { REPO_ROOT, makeSandboxRepo, type Sandbox } from './helpers.js';

const NOW = '2026-08-28T19:54:29.693Z';

const ORIGINAL_YAML = [
  'schema_version: 1',
  'requested_scope:',
  '  summary: Transform the current Grimperium repository',
  'autonomous_execution_boundary:',
  '  - DISPOSABLE_LOCAL_WORKSPACE',
  '  - CONFIGURED_SUBSCRIPTION_WORKER',
  '  - DETERMINISTIC_VALIDATION',
  '  - BOUNDED_REPAIR',
  '  - CAPABILITY_ESCALATION_WITHIN_LADDER',
  '  - CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
  'human_gated_capabilities:',
  '  - UNAUTHORIZED_API_BILLING',
  '  - BILLING_MODE_CHANGE',
  '  - PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
  '  - SCOPE_EXPANSION',
  'billing:',
  '  allowed_billing_modes: [subscription_only]',
  'profile_policy:',
  '  id: local-autonomous-development-ladder-v1',
  '  allowed_providers: [codex, claude]',
  '  selection_policy: evidence_balanced',
  '  profiles:',
  '    - id: codex-build-worker-subscription-terra-medium-v2',
  '      capability_rank: 0',
  '      rationale: degrau baseline',
  '    - id: claude-build-worker-subscription-sonnet5-medium-stream-v4',
  '      capability_rank: 1',
  '      rationale: degrau seguinte',
  '    - id: codex-build-worker-subscription-sol-high-v2',
  '      capability_rank: 2',
  '      rationale: degrau alto Codex',
  '    - id: claude-build-worker-subscription-opus5-high-v3',
  '      capability_rank: 3',
  '      rationale: degrau alto Claude',
  'work_units:',
  '  default:',
  '    task_class: feature',
  '    difficulty_declared: medium',
  '    risk: low',
  '    complexity: local',
  '    ambiguity: low',
  '    verification: deterministic',
  '    resource_envelope:',
  '      duration_ms: {expected: 900000, maximum: 1800000}',
  '      tokens: {expected: 80000, maximum: 200000}',
  '      changed_files: {expected: 4, maximum: 12}',
  '',
].join('\n');

let sandbox: Sandbox;
let paths: HarnessPaths;
let authorizationFile: string;
let original: { file: ProjectRunAuthorizationFile; source_file: string };

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root, {
    devDir: sandbox.devDir,
    profileCatalogRoot: REPO_ROOT,
  });
  await ensureRuntimeDirs(paths);
  authorizationFile = path.join(sandbox.devDir, 'lab', 'authorization.yaml');
  await mkdir(path.dirname(authorizationFile), { recursive: true });
  await writeFile(authorizationFile, ORIGINAL_YAML, 'utf8');
  original = await loadProjectRunAuthorization(authorizationFile);
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

describe('autorização humana append-only de expansão OpenCode Go', () => {
  it('não edita o snapshot original e adiciona só profiles OpenCode Go subscription', async () => {
    const granted = await grantProviderExpansionAuthorization({
      paths,
      catalogRoot: REPO_ROOT,
      original,
      reason:
        'Codex EXHAUSTED e Claude five_hour remaining 0; habilitar OpenCode Go subscription-only',
      exhaustedPools: ['openai_chatgpt_subscription', 'anthropic_subscription'],
      now: () => NOW,
    });

    expect(await readFile(authorizationFile, 'utf8')).toBe(ORIGINAL_YAML);
    expect(granted.record.kind).toBe('PROVIDER_EXPANSION_AUTHORIZATION');
    expect(granted.record.provenance).toBe('human_explicit');
    expect(granted.record.added_providers).toEqual(['opencode']);
    expect(granted.record.exhausted_pools).toEqual([
      'openai_chatgpt_subscription',
      'anthropic_subscription',
    ]);
    expect(granted.record.original_allowed_providers).toEqual(['codex', 'claude']);
    expect(granted.record.added_profiles.every((entry) => entry.id.startsWith('opencode-go-'))).toBe(
      true,
    );
    expect(granted.record.added_profiles.some((entry) => entry.id.includes('openrouter'))).toBe(
      false,
    );
    expect(granted.record.added_profiles.some((entry) => entry.id.includes('openai'))).toBe(false);

    const effective = await applyProviderExpansionAuthorization({
      paths,
      original,
    });
    expect(effective.file.profile_policy.allowed_providers).toEqual(
      expect.arrayContaining(['codex', 'claude', 'opencode']),
    );
    expect(effective.file.profile_policy.profiles.slice(0, 4).map((entry) => entry.id)).toEqual(
      original.file.profile_policy.profiles.map((entry) => entry.id),
    );
    expect(
      effective.file.profile_policy.profiles.filter((entry) => entry.id.startsWith('opencode-go-'))
        .length,
    ).toBeGreaterThan(0);
    expect(effective.source_file).toBe(authorizationFile);
    expect(await readFile(authorizationFile, 'utf8')).toBe(ORIGINAL_YAML);
  });

  it('recusa reason vazio e recusa segundo grant no mesmo runtime', async () => {
    await expect(
      grantProviderExpansionAuthorization({
        paths,
        catalogRoot: REPO_ROOT,
        original,
        reason: '   ',
        exhaustedPools: ['openai_chatgpt_subscription'],
      }),
    ).rejects.toThrow(ProviderExpansionAuthorizationError);

    await grantProviderExpansionAuthorization({
      paths,
      catalogRoot: REPO_ROOT,
      original,
      reason: 'expansão após exaustão Codex/Claude',
      exhaustedPools: ['openai_chatgpt_subscription', 'anthropic_subscription'],
    });

    await expect(
      grantProviderExpansionAuthorization({
        paths,
        catalogRoot: REPO_ROOT,
        original,
        reason: 'segunda expansão',
        exhaustedPools: ['openai_chatgpt_subscription'],
      }),
    ).rejects.toThrow(/já existe autorização de expansão/);
  });

  it('sem grant devolve a autorização original intacta', async () => {
    const effective = await applyProviderExpansionAuthorization({ paths, original });
    expect(effective.file).toEqual(original.file);
    expect(effective.source_file).toBe(original.source_file);
  });
});
