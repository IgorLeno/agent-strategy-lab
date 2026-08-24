import { describe, expect, it } from 'vitest';

import { overlayAuthorization, resolveDirectivePublishGrant } from '../../dev/lib/run-directive-auth.js';
import { loadPolicyPreset, DEFAULT_POLICY_PRESET } from '../../dev/lib/policy-preset.js';
import { parseRunDirective, RunDirectiveError } from '../../src/intake/index.js';

function headerOf(yamlBlock: string) {
  return parseRunDirective(`---agentlab\nversion: 1\n${yamlBlock}---\n# body\n`).header;
}

describe('overlayAuthorization', () => {
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
