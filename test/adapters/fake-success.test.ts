import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runFakeAgent } from '../../src/adapters/index.js';
import { ExecutionStatus } from '../../src/core/index.js';
import { executionEnvelopeSha256 } from '../../src/envelope/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_AGENT_ENTRY = path.join(REPO_ROOT, 'fixtures', 'fake-agent', 'index.mjs');

function manifest(): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  return {
    task_spec: {
      id: 'fake-task',
      description: 'Tarefa fake para exercitar o adapter fake.',
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
      cli: 'fake-agent',
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

describe('runFakeAgent — variante success', () => {
  it('produz ExecutionRecord COMPLETED a partir de eventos normalizados', async () => {
    const run = await runFakeAgent({
      argv: [process.execPath, FAKE_AGENT_ENTRY],
      cwd: REPO_ROOT,
      manifest: manifest(),
    });

    expect(run.record.status).toBe(ExecutionStatus.COMPLETED);
    expect(run.record.exit_code).toBe(0);
    expect(run.record.metrics.tokens).toEqual({ value: 128, provenance: 'fake_agent' });
    expect(run.record.metrics.changed_files).toEqual({ value: 1, provenance: 'fake_agent' });
  });

  it('emite eventos normalizados pela interface interna, não formato de provider', async () => {
    const run = await runFakeAgent({
      argv: [process.execPath, FAKE_AGENT_ENTRY],
      cwd: REPO_ROOT,
      manifest: manifest(),
    });

    expect(run.events.map((event) => event.type)).toEqual([
      'message',
      'tool_call',
      'tool_result',
      'result',
    ]);
    for (const event of run.events) {
      expect(event).not.toHaveProperty('provider');
    }
  });

  it('o execution_envelope_sha256 é o hash canônico do manifest completo, com a identidade do adapter fake', async () => {
    const fullManifest = manifest();

    const run = await runFakeAgent({
      argv: [process.execPath, FAKE_AGENT_ENTRY],
      cwd: REPO_ROOT,
      manifest: fullManifest,
    });

    const expected = executionEnvelopeSha256({
      ...fullManifest,
      adapter: { name: 'fake', version: '1.0.0' },
    });
    expect(run.record.execution_envelope_sha256).toBe(expected);
  });
});
