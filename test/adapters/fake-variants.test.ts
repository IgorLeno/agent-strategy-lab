import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runFakeAgent } from '../../src/adapters/index.js';
import { ExecutionStatus } from '../../src/core/index.js';
import { ProcessGroupSurvivorError } from '../../src/runner/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_AGENT_ENTRY = path.join(REPO_ROOT, 'fixtures', 'fake-agent', 'index.mjs');

function manifest(timeoutMs = 60_000): Omit<ExecutionEnvelopeManifest, 'adapter'> {
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
    timeout_ms: timeoutMs,
  };
}

describe('runFakeAgent — variante failure', () => {
  it('produz ExecutionRecord COMPLETED, não CRASHED, quando o agente relata falha', async () => {
    const run = await runFakeAgent({
      argv: [process.execPath, FAKE_AGENT_ENTRY, 'failure'],
      cwd: REPO_ROOT,
      manifest: manifest(),
    });

    expect(run.record.status).toBe(ExecutionStatus.COMPLETED);
    expect(run.record.exit_code).toBe(0);
    expect(run.record.metrics.tokens).toEqual({ value: 64, provenance: 'fake_agent' });
    expect(run.record.metrics.changed_files).toEqual({ value: 0, provenance: 'fake_agent' });
    expect(run.events.at(-1)).toMatchObject({ type: 'result', outcome: 'failure' });
  });
});

describe('runFakeAgent — variante timeout', () => {
  it('produz ExecutionRecord TIMED_OUT quando o processo nunca termina por conta própria', async () => {
    const run = await runFakeAgent({
      argv: [process.execPath, FAKE_AGENT_ENTRY, 'timeout'],
      cwd: REPO_ROOT,
      manifest: manifest(50),
      gracePeriodMs: 50,
    });

    expect(run.record.status).toBe(ExecutionStatus.TIMED_OUT);
  }, 10_000);
});

describe('runFakeAgent — variante malformed-stream', () => {
  it('não derruba o run: linha sanitizada preservada como evento unknown, resto do stream segue', async () => {
    const run = await runFakeAgent({
      argv: [process.execPath, FAKE_AGENT_ENTRY, 'malformed-stream'],
      cwd: REPO_ROOT,
      manifest: manifest(),
    });

    expect(run.record.status).toBe(ExecutionStatus.COMPLETED);
    const unknownEvents = run.events.filter((event) => event.type === 'unknown');
    expect(unknownEvents).toHaveLength(1);
    expect(unknownEvents[0]).toMatchObject({
      type: 'unknown',
      raw: 'isto não é um evento da interface interna, nem JSON',
    });
    expect(run.events.at(-1)).toMatchObject({ type: 'result', outcome: 'success' });
  });
});

describe('runFakeAgent — variante child-process-leak', () => {
  it('descendente que escapa do process group é detectado pela verificação do M24B', async () => {
    await expect(
      runFakeAgent({
        argv: [process.execPath, FAKE_AGENT_ENTRY, 'child-process-leak'],
        cwd: REPO_ROOT,
        manifest: manifest(1_500),
        gracePeriodMs: 500,
        cleanupConfirmTimeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ProcessGroupSurvivorError);
  }, 15_000);
});
