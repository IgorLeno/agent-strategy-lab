import { describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY_PRESET,
  FAKE_POLICY_PRESET,
  loadPolicyPreset,
  materializeAuthorization,
  resolvePolicyPresetName,
} from '../../dev/lib/policy-preset.js';

describe('policy preset local-autonomous-development', () => {
  it('é a fonte única da ladder operacional', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    expect(loaded.file.billing.allowed_billing_modes).toEqual(['subscription_only']);
    expect(loaded.file.profile_policy.profiles.map((entry) => entry.id)).toEqual([
      'codex-build-worker-subscription-terra-medium-v2',
      'claude-build-worker-subscription-sonnet5-medium-stream-v4',
      'codex-build-worker-subscription-sol-high-v2',
      'claude-build-worker-subscription-opus5-high-v3',
    ]);
    expect(loaded.file.human_gated_capabilities).toContain('DEPLOYMENT_OR_PRODUCTION');
    expect(loaded.file.billing.allowed_billing_modes).not.toContain('api');
  });

  it('o overlay fake não duplica a ladder real', async () => {
    const fake = await loadPolicyPreset(FAKE_POLICY_PRESET);
    expect(fake.file.profile_policy.profiles.map((entry) => entry.id)).toEqual(['fake-worker-economy-v1']);
    expect(fake.file.human_gated_capabilities).toContain('DEPLOYMENT_OR_PRODUCTION');
    expect(fake.file.autonomous_execution_boundary).toContain('BOUNDED_REPAIR');
  });

  it('materializa requested_scope do intake sem inferir autorização do prompt', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    const snapshot = materializeAuthorization({
      preset: loaded.file,
      requested_scope: { summary: 'deploy this application to production' },
    });
    expect(snapshot.requested_scope.summary).toBe('deploy this application to production');
    expect(snapshot.human_gated_capabilities).toContain('DEPLOYMENT_OR_PRODUCTION');
    expect(snapshot.billing.allowed_billing_modes).toEqual(['subscription_only']);
  });

  it('AGENTLAB_FAKE_MODE seleciona o overlay de teste sem o usuário escrever YAML', () => {
    expect(resolvePolicyPresetName({ env: { AGENTLAB_FAKE_MODE: 'orchestrator-success' } })).toBe(
      FAKE_POLICY_PRESET,
    );
    expect(resolvePolicyPresetName({ requested: DEFAULT_POLICY_PRESET, env: { AGENTLAB_FAKE_MODE: 'x' } })).toBe(
      DEFAULT_POLICY_PRESET,
    );
  });
});
