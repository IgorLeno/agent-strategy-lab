import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fakeAdapter, resolveAdapter } from '../../src/adapters/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

function manifest(): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  return {
    task_spec: {
      id: 'fake-task',
      description: 'Tarefa fake para exercitar o contrato de adapter.',
      visible_criteria: ['produz um arquivo'],
      task_class: 'fake',
      difficulty: 'trivial',
      stack: ['node'],
      public_graders: ['fake-grader'],
      budgets: {
        duration_ms: { expected: 1_000, maximum: 60_000 },
        tokens: { expected: 100, maximum: 1_000 },
        changed_files: { expected: 1, maximum: 5 },
      },
    },
    strategy: { name: 'fake-strategy', version: 1, prompt: 'faça a tarefa fake' },
    compiled_prompt: 'faça a tarefa fake',
    base_sha: 'a'.repeat(40),
    agent_profile: {
      id: 'fake-agent-profile',
      cli: 'fake',
      cli_version: '1.0.0',
      model: 'fake-model',
      flags: [],
    },
    environment_profile: {
      mode: 'controlled',
      id: 'fake-environment',
      home: 'sanitized',
      env_allowlist: [],
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    budgets: {
      duration_ms: { expected: 1_000, maximum: 60_000 },
      tokens: { expected: 100, maximum: 1_000 },
      changed_files: { expected: 1, maximum: 5 },
    },
    timeout_ms: 60_000,
  };
}

describe('resolveAdapter', () => {
  it("retorna o ProviderAdapter fake registrado para 'fake'", () => {
    expect(resolveAdapter('fake')).toBe(fakeAdapter);
  });

  it('falha com erro acionável nomeando os adapters/clis registrados para cli desconhecida', () => {
    expect(() => resolveAdapter('nao-existe')).toThrow(/nao-existe/);
    expect(() => resolveAdapter('nao-existe')).toThrow(/fake/);
  });
});

describe('fakeAdapter — forma ProviderAdapter', () => {
  it('expõe a identidade fake', () => {
    expect(fakeAdapter.identity).toEqual({ name: 'fake', version: '1.0.0' });
  });

  it('buildInvocation monta argv apontando para o fake agent, com o prompt compilado como stdin', () => {
    const invocation = fakeAdapter.buildInvocation({
      manifest: manifest(),
      cwd: REPO_ROOT,
      sourceEnv: {},
    });

    expect(invocation.argv[0]).toBe(process.execPath);
    expect(invocation.argv[1]).toBe(
      path.join(REPO_ROOT, 'fixtures', 'fake-agent', 'index.mjs'),
    );
    expect(invocation.stdin).toBe('faça a tarefa fake');
  });

  it('parseLine interpreta uma linha da interface interna como evento normalizado, com observações do result', () => {
    const parsed = fakeAdapter.parseLine(
      JSON.stringify({ type: 'result', outcome: 'success', tokens: 128, changed_files: 1 }),
    );

    expect(parsed.event).toEqual({
      type: 'result',
      outcome: 'success',
      tokens: 128,
      changed_files: 1,
    });
    expect(parsed.observation).toEqual({ usage: { tokens: 128 }, terminal: 'success' });
  });

  it('parseLine preserva uma linha malformada como evento unknown, sem observação', () => {
    const parsed = fakeAdapter.parseLine('isto não é a interface interna, nem JSON');

    expect(parsed.event).toEqual({
      type: 'unknown',
      raw: 'isto não é a interface interna, nem JSON',
    });
    expect(parsed.observation).toBeUndefined();
  });

  it('parseLine não gera observação para eventos que não são result', () => {
    const parsed = fakeAdapter.parseLine(
      JSON.stringify({ type: 'message', role: 'assistant', text: 'oi' }),
    );

    expect(parsed.event).toEqual({ type: 'message', role: 'assistant', text: 'oi' });
    expect(parsed.observation).toBeUndefined();
  });
});
