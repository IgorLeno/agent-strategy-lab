import { describe, expect, it } from 'vitest';

import { AgentProfile, EnvironmentProfile } from '../../src/schemas/index.js';

function validAgentProfile(): AgentProfile {
  return {
    id: 'codex-gpt-5-6-sol',
    cli: 'codex',
    cli_version: '0.31.0',
    model: 'gpt-5.6-sol',
    flags: ['--ephemeral', '--sandbox=workspace-write'],
  };
}

function controlledEnvironment(): Extract<EnvironmentProfile, { mode: 'controlled' }> {
  return {
    id: 'controlled-clean-room',
    mode: 'controlled',
    env_allowlist: ['PATH', 'LANG'],
    home: 'sanitized',
    instruction_files: [{ path: 'AGENTS.md', sha256: 'a'.repeat(64) }],
    plugins: [],
    skills: [],
    mcp_servers: [],
  };
}

function realWorldEnvironment(): Extract<EnvironmentProfile, { mode: 'real-world' }> {
  return {
    id: 'real-world-subscription',
    mode: 'real-world',
    env_allowlist: ['PATH', 'CODEX_HOME'],
    home: 'sanitized',
    instruction_files: [{ path: 'AGENTS.md', sha256: 'b'.repeat(64) }],
    plugins: ['github@0.1.8'],
    skills: ['github:github'],
    mcp_servers: ['codebase-memory-mcp'],
    uncontrolled: ['user configuration in CODEX_HOME', 'network availability'],
  };
}

describe('AgentProfile', () => {
  it('parses CLI identity, version, model and flags', () => {
    const input = validAgentProfile();

    expect(AgentProfile.parse(input)).toEqual(input);
  });

  it.each([
    { ...validAgentProfile(), id: 'invalid id' },
    { ...validAgentProfile(), cli_version: '' },
    { ...validAgentProfile(), model: '   ' },
    { ...validAgentProfile(), flags: [''] },
    { ...validAgentProfile(), billing_mode: 'subscription' },
  ])('rejects malformed, empty or unknown fields', (input) => {
    expect(AgentProfile.safeParse(input).success).toBe(false);
  });
});

describe('EnvironmentProfile', () => {
  it.each([controlledEnvironment(), realWorldEnvironment()])(
    'parses an explicit $mode environment inventory',
    (input) => {
      expect(EnvironmentProfile.parse(input)).toEqual(input);
    },
  );

  it('requires an explicit env allowlist and sanitized HOME in controlled mode', () => {
    const controlled = controlledEnvironment();
    const { env_allowlist: _envAllowlist, ...withoutAllowlist } = controlled;

    expect(EnvironmentProfile.safeParse(withoutAllowlist).success).toBe(false);
    expect(
      EnvironmentProfile.safeParse({ ...controlled, home: 'user' }).success,
    ).toBe(false);
  });

  it('requires real-world profiles to state what was not controlled', () => {
    const realWorld = realWorldEnvironment();
    const { uncontrolled: _uncontrolled, ...withoutUncontrolled } = realWorld;

    expect(EnvironmentProfile.safeParse(withoutUncontrolled).success).toBe(false);
    expect(
      EnvironmentProfile.safeParse({ ...realWorld, uncontrolled: [] }).success,
    ).toBe(false);
  });

  it('rejects incomplete inventories, invalid fingerprints and duplicates', () => {
    const controlled = controlledEnvironment();
    const { plugins: _plugins, ...withoutPlugins } = controlled;

    expect(EnvironmentProfile.safeParse(withoutPlugins).success).toBe(false);
    expect(
      EnvironmentProfile.safeParse({
        ...controlled,
        instruction_files: [{ path: 'AGENTS.md', sha256: 'not-a-sha256' }],
      }).success,
    ).toBe(false);
    expect(
      EnvironmentProfile.safeParse({ ...controlled, env_allowlist: ['PATH', 'PATH'] })
        .success,
    ).toBe(false);
  });

  it('keeps environment mode as an explicit result dimension', () => {
    const controlled = EnvironmentProfile.parse(controlledEnvironment());
    const realWorld = EnvironmentProfile.parse(realWorldEnvironment());

    expect(controlled.mode).toBe('controlled');
    expect(realWorld.mode).toBe('real-world');
    expect(EnvironmentProfile.safeParse({ ...realWorld, mode: undefined }).success).toBe(false);
  });
});
