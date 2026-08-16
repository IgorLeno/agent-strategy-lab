import { describe, expect, it } from 'vitest';

import {
  buildClaudeInvocation,
  CLAUDE_ADAPTER_IDENTITY,
} from '../../src/adapters/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';

const budgets = {
  duration_ms: { expected: 1_000, maximum: 60_000 },
  tokens: { expected: 100, maximum: 1_000 },
  changed_files: { expected: 1, maximum: 5 },
};

function manifest(
  environmentProfile: Omit<ExecutionEnvelopeManifest, 'adapter'>['environment_profile'],
): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  return {
    task_spec: {
      id: 'claude-task',
      description: 'Tarefa sintética para exercitar somente a montagem da invocation.',
      visible_criteria: ['produz invocation determinística'],
      task_class: 'test',
      difficulty: 'trivial',
      stack: ['typescript'],
      public_graders: ['unit-test'],
      budgets,
    },
    strategy: { name: 'direct', version: 1, prompt: 'Execute a tarefa.' },
    compiled_prompt: 'Implemente sem executar nenhuma inferência real.\n',
    base_sha: 'a'.repeat(40),
    agent_profile: {
      id: 'claude-sonnet-medium',
      cli: 'claude',
      cli_version: '2.1.223',
      model: 'claude-sonnet-5',
      flags: [
        '--effort',
        'medium',
        '--permission-mode',
        'acceptEdits',
        '--no-session-persistence',
      ],
    },
    environment_profile: environmentProfile,
    budgets,
    timeout_ms: 60_000,
  };
}

const realWorldEnvironment = {
  id: 'claude-real-world',
  mode: 'real-world',
  home: 'user',
  env_allowlist: ['PATH', 'HOME', 'LANG', 'UNSET'],
  instruction_files: [],
  plugins: [],
  skills: [],
  mcp_servers: [],
  uncontrolled: ['user home'],
} satisfies Omit<ExecutionEnvelopeManifest, 'adapter'>['environment_profile'];

describe('Claude invocation', () => {
  it('declara a identidade estável do adapter', () => {
    expect(CLAUDE_ADAPTER_IDENTITY).toEqual({ name: 'claude', version: '1.0.0' });
  });

  it('produz argv, env e stdin determinísticos sem executar a CLI', () => {
    const invocation = buildClaudeInvocation({
      manifest: manifest(realWorldEnvironment),
      cwd: '/work/clone',
      sourceEnv: {
        PATH: '/fixture/bin',
        HOME: '/fixture/home',
        LANG: 'pt_BR.UTF-8',
        SECRET_NOT_ALLOWED: 'não deve atravessar',
      },
    });

    expect(invocation).toMatchInlineSnapshot(`
      {
        "argv": [
          "claude",
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--model",
          "claude-sonnet-5",
          "--effort",
          "medium",
          "--permission-mode",
          "acceptEdits",
          "--no-session-persistence",
        ],
        "env": {
          "HOME": "/fixture/home",
          "LANG": "pt_BR.UTF-8",
          "PATH": "/fixture/bin",
        },
        "stdin": "Implemente sem executar nenhuma inferência real.\n",
      }
    `);
  });

  it('substitui HOME por um diretório explícito no ambiente sanitized', () => {
    const invocation = buildClaudeInvocation({
      manifest: manifest({
        id: 'claude-controlled',
        mode: 'controlled',
        home: 'sanitized',
        env_allowlist: ['PATH', 'HOME'],
        instruction_files: [],
        plugins: [],
        skills: [],
        mcp_servers: [],
      }),
      cwd: '/work/clone',
      sourceEnv: { PATH: '/fixture/bin', HOME: '/real/user/home' },
      sanitizedHome: '/isolated/home',
    });

    expect(invocation.env).toEqual({ PATH: '/fixture/bin', HOME: '/isolated/home' });
  });

  it('recusa ambiente sanitized sem HOME explícito em vez de herdar o usuário real', () => {
    expect(() =>
      buildClaudeInvocation({
        manifest: manifest({
          id: 'claude-controlled',
          mode: 'controlled',
          home: 'sanitized',
          env_allowlist: ['PATH'],
          instruction_files: [],
          plugins: [],
          skills: [],
          mcp_servers: [],
        }),
        cwd: '/work/clone',
        sourceEnv: { PATH: '/fixture/bin', HOME: '/real/user/home' },
      }),
    ).toThrow('claude-controlled: HOME sanitizado não foi fornecido');
  });
});
