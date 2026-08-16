import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCodexInvocation,
  CODEX_ADAPTER_IDENTITY,
} from '../../src/adapters/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';

interface CodexInvocationFixture {
  readonly agent_profile: Omit<ExecutionEnvelopeManifest, 'adapter'>['agent_profile'];
  readonly source_env: Readonly<Record<string, string>>;
  readonly expected: {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly stdin: string;
  };
}

const fixture = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, '../../fixtures/provider-invocations/codex.json'),
    'utf8',
  ),
) as CodexInvocationFixture;

const budgets = {
  duration_ms: { expected: 1_000, maximum: 60_000 },
  tokens: { expected: 100, maximum: 1_000 },
  changed_files: { expected: 1, maximum: 5 },
};

function manifest(): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  return {
    task_spec: {
      id: 'codex-task',
      description: 'Tarefa sintética para exercitar somente a montagem da invocation.',
      visible_criteria: ['produz invocation determinística'],
      task_class: 'test',
      difficulty: 'trivial',
      stack: ['typescript'],
      public_graders: ['unit-test'],
      budgets,
    },
    strategy: { name: 'direct', version: 1, prompt: 'Execute a tarefa.' },
    compiled_prompt: fixture.expected.stdin,
    base_sha: 'a'.repeat(40),
    agent_profile: fixture.agent_profile,
    environment_profile: {
      id: 'codex-real-world',
      mode: 'real-world',
      home: 'sanitized',
      env_allowlist: ['PATH', 'LANG', 'CODEX_HOME'],
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
      uncontrolled: ['Codex CLI installation'],
    },
    budgets,
    timeout_ms: 60_000,
  };
}

describe('Codex invocation', () => {
  it('declara a identidade estável do adapter', () => {
    expect(CODEX_ADAPTER_IDENTITY).toEqual({ name: 'codex', version: '1.0.0' });
  });

  it('produz a fixture determinística a partir do modelo e profile explícitos', () => {
    const options = {
      manifest: manifest(),
      cwd: '/work/clone',
      sourceEnv: fixture.source_env,
      sanitizedHome: '/isolated/home',
    };

    expect(buildCodexInvocation(options)).toEqual(fixture.expected);
    expect(buildCodexInvocation(options)).toEqual(buildCodexInvocation(options));
  });

  it('usa somente a configuração recebida, sem consultar ou executar a CLI', () => {
    const configured = manifest();
    configured.agent_profile.model = 'gpt-fixture-explicit';
    configured.agent_profile.flags = ['--config', 'model_reasoning_effort="high"'];

    const invocation = buildCodexInvocation({
      manifest: configured,
      cwd: '/work/clone',
      sourceEnv: fixture.source_env,
      sanitizedHome: '/isolated/home',
    });

    expect(invocation.argv).toEqual([
      'codex-fixture',
      'exec',
      '--json',
      '--strict-config',
      '--model',
      'gpt-fixture-explicit',
      '--config',
      'model_reasoning_effort="high"',
      '-',
    ]);
  });

  it('recusa ambiente sanitized sem HOME explícito', () => {
    expect(() =>
      buildCodexInvocation({
        manifest: manifest(),
        cwd: '/work/clone',
        sourceEnv: fixture.source_env,
      }),
    ).toThrow('codex-real-world: HOME sanitizado não foi fornecido');
  });
});
