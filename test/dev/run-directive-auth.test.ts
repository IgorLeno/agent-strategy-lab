import { describe, expect, it } from 'vitest';

import { dependencyNetworkRestrictionDiagnostic, overlayAuthorization, resolveDirectivePublishGrant } from '../../dev/lib/run-directive-auth.js';
import { loadPolicyPreset, DEFAULT_POLICY_PRESET } from '../../dev/lib/policy-preset.js';
import { hasAutonomousCapability, LOCAL_WORKSPACE_CAPABILITIES, parseRunDirective, RunDirectiveError } from '../../src/intake/index.js';

function headerOf(yamlBlock: string) {
  return parseRunDirective(`---agentlab\nversion: 1\n${yamlBlock}---\n# body\n`).header;
}

describe('overlayAuthorization', () => {
  it.each([
    ['local_repository_write', 'LOCAL_REPOSITORY_WRITE'],
    ['dependency_network', 'DEPENDENCY_NETWORK'],
    ['local_git_commits', 'LOCAL_GIT_COMMITS'],
  ] as const)('denying %s preserves every independent local permission', async (permission, capability) => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    const overlaid = overlayAuthorization({
      preset: loaded.file,
      header: headerOf(`authorization:\n  deny:\n    ${permission}: true\n`),
    });
    expect(overlaid.autonomous_execution_boundary).not.toContain('DISPOSABLE_LOCAL_WORKSPACE');
    expect(hasAutonomousCapability(overlaid.autonomous_execution_boundary, capability)).toBe(false);
    for (const sibling of LOCAL_WORKSPACE_CAPABILITIES.filter((entry) => entry !== capability)) {
      expect(hasAutonomousCapability(overlaid.autonomous_execution_boundary, sibling)).toBe(true);
    }
    // Reapplying or serializing the snapshot cannot recover the denied umbrella.
    expect(overlayAuthorization({ preset: overlaid, header: null })).toEqual(overlaid);
  });

  it('a narrow local grant never grants its siblings', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    const overlaid = overlayAuthorization({
      preset: {
        ...loaded.file,
        autonomous_execution_boundary: ['CONFIGURED_SUBSCRIPTION_WORKER'],
      },
      header: headerOf('authorization:\n  allow:\n    local_repository_write: true\n'),
    });
    expect(hasAutonomousCapability(overlaid.autonomous_execution_boundary, 'LOCAL_REPOSITORY_WRITE')).toBe(true);
    expect(hasAutonomousCapability(overlaid.autonomous_execution_boundary, 'DEPENDENCY_NETWORK')).toBe(false);
    expect(hasAutonomousCapability(overlaid.autonomous_execution_boundary, 'LOCAL_GIT_COMMITS')).toBe(false);
  });

  it('legacy workspace grants retain their local capabilities without broadening worker authority', () => {
    for (const capability of LOCAL_WORKSPACE_CAPABILITIES) {
      expect(hasAutonomousCapability(['DISPOSABLE_LOCAL_WORKSPACE'], capability)).toBe(true);
      expect(hasAutonomousCapability([], capability)).toBe(false);
    }
    expect(hasAutonomousCapability(['DISPOSABLE_LOCAL_WORKSPACE'], 'CONFIGURED_SUBSCRIPTION_WORKER')).toBe(false);
  });

  it('requires a real network sandbox when network is denied, while preserving legacy grants', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    expect(dependencyNetworkRestrictionDiagnostic(loaded.file.autonomous_execution_boundary)).toBeNull();
    const denied = overlayAuthorization({
      preset: loaded.file,
      header: headerOf('authorization:\n  deny:\n    dependency_network: true\n'),
    });
    expect(dependencyNetworkRestrictionDiagnostic(denied.autonomous_execution_boundary)).toMatch(/^DEPENDENCY_NETWORK_DENIAL_UNSUPPORTED:/);
    expect(dependencyNetworkRestrictionDiagnostic(['DEPENDENCY_NETWORK'])).toBeNull();
  });

  it('allow estruturado acrescenta capability grantable; texto livre não entra', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    const reduced = {
      ...loaded.file,
      autonomous_execution_boundary: loaded.file.autonomous_execution_boundary.filter(
        (capability) => capability !== 'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
      ),
    };
    const withGrant = overlayAuthorization({
      preset: reduced,
      header: headerOf('authorization:\n  allow:\n    cross_provider: true\n'),
    });
    expect(withGrant.autonomous_execution_boundary).toContain(
      'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
    );

    const fromBodyOnly = overlayAuthorization({
      preset: reduced,
      header: headerOf('authorization:\n  preset: local-autonomous-development\n'),
    });
    expect(fromBodyOnly.autonomous_execution_boundary).not.toContain(
      'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
    );
  });

  it('deny remove capability do snapshot', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    const overlaid = overlayAuthorization({
      preset: loaded.file,
      header: headerOf('authorization:\n  deny:\n    bounded_repair: true\n'),
    });
    expect(overlaid.autonomous_execution_boundary).not.toContain('BOUNDED_REPAIR');
    expect(overlaid.autonomous_execution_boundary).toContain('DETERMINISTIC_VALIDATION');
  });

  it('allow de categoria never-grantable falha fechado', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    expect(() =>
      overlayAuthorization({
        preset: loaded.file,
        header: headerOf('authorization:\n  allow:\n    deployment: true\n'),
      }),
    ).toThrow(/não permite conceder deployment/);
  });

  it('allow+deny no mesmo nome falha fechado', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    expect(() =>
      overlayAuthorization({
        preset: loaded.file,
        header: headerOf('authorization:\n  allow:\n    bounded_repair: true\n  deny:\n    bounded_repair: true\n'),
      }),
    ).toThrow(RunDirectiveError);
  });
});

describe('providers.policy no header da Run Directive', () => {
  it('evidence_balanced troca só o desempate do routing, sem tocar em autorização', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    expect(loaded.file.profile_policy.selection_policy).toBe('static_cost');

    const overlaid = overlayAuthorization({
      preset: loaded.file,
      header: headerOf('providers:\n  policy: evidence_balanced\n'),
    });

    expect(overlaid.profile_policy.selection_policy).toBe('evidence_balanced');
    // Nada além do desempate mudou: boundary, gates, billing e a lista de
    // profiles elegíveis continuam idênticos ao preset.
    expect(overlaid.autonomous_execution_boundary).toEqual(loaded.file.autonomous_execution_boundary);
    expect(overlaid.human_gated_capabilities).toEqual(loaded.file.human_gated_capabilities);
    expect(overlaid.billing).toEqual(loaded.file.billing);
    expect(overlaid.profile_policy.profiles).toEqual(loaded.file.profile_policy.profiles);
    expect(overlaid.profile_policy.allowed_providers).toEqual(
      loaded.file.profile_policy.allowed_providers,
    );
  });

  it('directive antiga sem providers preserva o desempate histórico', async () => {
    const loaded = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
    expect(
      overlayAuthorization({ preset: loaded.file, header: headerOf('') }).profile_policy
        .selection_policy,
    ).toBe('static_cost');
    expect(
      overlayAuthorization({ preset: loaded.file, header: null }).profile_policy.selection_policy,
    ).toBe('static_cost');
    expect(
      overlayAuthorization({
        preset: loaded.file,
        header: headerOf('providers:\n  policy: default\n'),
      }).profile_policy.selection_policy,
    ).toBe('static_cost');
  });
});

describe('resolveDirectivePublishGrant', () => {
  it('concede publish estreito a origin/main', () => {
    const grant = resolveDirectivePublishGrant({
      header: headerOf('authorization:\n  publish:\n    allowed: true\n    remote: origin\n    ref: main\n'),
    });
    expect(grant).toEqual({ allowed: true, remote: 'origin', ref: 'main' });
  });

  it('CLI --publish + deny da directive falha fechado', () => {
    expect(() =>
      resolveDirectivePublishGrant({
        header: headerOf('authorization:\n  deny:\n    publish_origin: true\n'),
        cliPublish: true,
      }),
    ).toThrow(/--publish/);
  });

  it('sem grant, publish permanece negado', () => {
    const grant = resolveDirectivePublishGrant({
      header: headerOf('authorization:\n  preset: local-autonomous-development\n'),
    });
    expect(grant.allowed).toBe(false);
  });
});
