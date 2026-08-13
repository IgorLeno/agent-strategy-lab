import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fakeAdapter, resolveAdapter, runFakeAgent } from '../../src/adapters/index.js';
import type { ProviderAdapter } from '../../src/adapters/index.js';
import { ExecutionStatus } from '../../src/core/index.js';
import { executionEnvelopeSha256 } from '../../src/envelope/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import { executeWithAdapter, ProcessGroupSurvivorError } from '../../src/runner/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_AGENT_ENTRY = path.join(REPO_ROOT, 'fixtures', 'fake-agent', 'index.mjs');

function manifest(timeoutMs = 60_000): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  return {
    task_spec: {
      id: 'fake-task',
      description: 'Tarefa fake para exercitar executeWithAdapter.',
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
    timeout_ms: timeoutMs,
  };
}

/** `duration_ms` varia entre as duas execuções — comparado à parte, o resto do record não deveria. */
function withoutDuration<T extends { duration_ms: number }>(record: T): Omit<T, 'duration_ms'> {
  const { duration_ms: _duration_ms, ...rest } = record;
  return rest;
}

describe('executeWithAdapter — equivalência observável com runFakeAgent', () => {
  it('resolveAdapter("fake") + executeWithAdapter reproduz o record e os eventos da variante success', async () => {
    const options = {
      argv: [process.execPath, FAKE_AGENT_ENTRY],
      cwd: REPO_ROOT,
      manifest: manifest(),
      gracePeriodMs: 200,
    };

    const viaRunFakeAgent = await runFakeAgent(options);
    const viaExecuteWithAdapter = await executeWithAdapter(resolveAdapter('fake'), options);

    expect(withoutDuration(viaExecuteWithAdapter.record)).toEqual(
      withoutDuration(viaRunFakeAgent.record),
    );
    expect(viaExecuteWithAdapter.events).toEqual(viaRunFakeAgent.events);
  });

  it('resolveAdapter("fake") + executeWithAdapter reproduz o record da variante failure', async () => {
    const options = {
      argv: [process.execPath, FAKE_AGENT_ENTRY, 'failure'],
      cwd: REPO_ROOT,
      manifest: manifest(),
      gracePeriodMs: 200,
    };

    const viaRunFakeAgent = await runFakeAgent(options);
    const viaExecuteWithAdapter = await executeWithAdapter(resolveAdapter('fake'), options);

    expect(withoutDuration(viaExecuteWithAdapter.record)).toEqual(
      withoutDuration(viaRunFakeAgent.record),
    );
    expect(viaExecuteWithAdapter.events).toEqual(viaRunFakeAgent.events);
  });

  it('resolveAdapter("fake") + executeWithAdapter reproduz o record da variante malformed-stream', async () => {
    const options = {
      argv: [process.execPath, FAKE_AGENT_ENTRY, 'malformed-stream'],
      cwd: REPO_ROOT,
      manifest: manifest(),
      gracePeriodMs: 200,
    };

    const viaRunFakeAgent = await runFakeAgent(options);
    const viaExecuteWithAdapter = await executeWithAdapter(resolveAdapter('fake'), options);

    expect(withoutDuration(viaExecuteWithAdapter.record)).toEqual(
      withoutDuration(viaRunFakeAgent.record),
    );
    expect(viaExecuteWithAdapter.events).toEqual(viaRunFakeAgent.events);
  });

  it('resolveAdapter("fake") + executeWithAdapter reproduz TIMED_OUT da variante timeout', async () => {
    const options = {
      argv: [process.execPath, FAKE_AGENT_ENTRY, 'timeout'],
      cwd: REPO_ROOT,
      manifest: manifest(50),
      gracePeriodMs: 50,
    };

    const viaExecuteWithAdapter = await executeWithAdapter(resolveAdapter('fake'), options);

    expect(viaExecuteWithAdapter.record.status).toBe(ExecutionStatus.TIMED_OUT);
  }, 10_000);

  it('resolveAdapter("fake") + executeWithAdapter propaga ProcessGroupSurvivorError da variante child-process-leak', async () => {
    await expect(
      executeWithAdapter(resolveAdapter('fake'), {
        argv: [process.execPath, FAKE_AGENT_ENTRY, 'child-process-leak'],
        cwd: REPO_ROOT,
        manifest: manifest(1_500),
        gracePeriodMs: 500,
        cleanupConfirmTimeoutMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(ProcessGroupSurvivorError);
  }, 15_000);
});

describe('executeWithAdapter — montagem do ExecutionRecord é do runtime comum, não do adapter', () => {
  it('produz um ExecutionRecord com identidade e provenance de qualquer ProviderAdapter conforme, reusando só buildInvocation/parseLine', async () => {
    const customAdapter: ProviderAdapter = {
      identity: { name: 'test-custom-adapter', version: '9.9.9' },
      metricsProvenance: 'custom_provenance',
      buildInvocation: fakeAdapter.buildInvocation,
      parseLine: fakeAdapter.parseLine,
    };

    const options = {
      argv: [process.execPath, FAKE_AGENT_ENTRY],
      cwd: REPO_ROOT,
      manifest: manifest(),
      gracePeriodMs: 200,
    };

    const run = await executeWithAdapter(customAdapter, options);

    expect(run.record.status).toBe(ExecutionStatus.COMPLETED);
    expect(run.record.exit_code).toBe(0);
    expect(run.record.metrics.tokens).toEqual({ value: 128, provenance: 'custom_provenance' });
    expect(run.record.metrics.changed_files).toEqual({ value: 1, provenance: 'custom_provenance' });
    expect(run.record.execution_envelope_sha256).toBe(
      executionEnvelopeSha256({ ...options.manifest, adapter: customAdapter.identity }),
    );
  });

  it('adapter sem metricsProvenance cai para identity.name — o default é decidido pelo runtime, não pelo adapter', async () => {
    const customAdapter: ProviderAdapter = {
      identity: { name: 'no-provenance-adapter', version: '1.0.0' },
      buildInvocation: fakeAdapter.buildInvocation,
      parseLine: fakeAdapter.parseLine,
    };

    const run = await executeWithAdapter(customAdapter, {
      argv: [process.execPath, FAKE_AGENT_ENTRY],
      cwd: REPO_ROOT,
      manifest: manifest(),
      gracePeriodMs: 200,
    });

    expect(run.record.metrics.tokens.provenance).toBe('no-provenance-adapter');
  });
});
