import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fakeAdapter, resolveAdapter } from '../../src/adapters/index.js';
import type { ParsedProviderLine, ProviderAdapter } from '../../src/adapters/index.js';
import { ExecutionStatus } from '../../src/core/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import { executeWithAdapter } from '../../src/runner/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_AGENT_ENTRY = path.join(REPO_ROOT, 'fixtures', 'fake-agent', 'index.mjs');

function manifest(): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  return {
    task_spec: {
      id: 'fake-task',
      description: 'Tarefa fake para exercitar observations preservadas.',
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

/**
 * Adapter customizado que anota `parseLine` com `cost` explícito — a única
 * forma de provar que uma observation no resultado veio do adapter, e não foi
 * inventada pelo runtime comum, é usar um adapter que o runtime nunca viu.
 */
function customAdapterWithCost(currency: string): ProviderAdapter {
  return {
    identity: { name: 'test-observation-adapter', version: '1.0.0' },
    executionKind: 'FIXTURE',
    metricsProvenance: 'custom_observation_provenance',
    buildInvocation: fakeAdapter.buildInvocation,
    parseLine(raw: string): ParsedProviderLine {
      const parsed = fakeAdapter.parseLine(raw);
      if (parsed.observation === undefined) {
        return parsed;
      }
      return {
        event: parsed.event,
        observation: { ...parsed.observation, cost: { amount: 0.42, currency } },
      };
    },
  };
}

const runOptions = (adapter: ProviderAdapter, variant?: string) => ({
  argv: variant === undefined ? [process.execPath, FAKE_AGENT_ENTRY] : [process.execPath, FAKE_AGENT_ENTRY, variant],
  cwd: REPO_ROOT,
  manifest: manifest(),
  gracePeriodMs: 200,
});

describe('executeWithAdapter — ProviderObservation preservada', () => {
  it('parsedLines correlaciona 1:1 com events por índice, sem ambiguidade sobre a origem de cada observation', async () => {
    const run = await executeWithAdapter(fakeAdapter, runOptions(fakeAdapter));

    expect(run.parsedLines).toHaveLength(run.events.length);
    run.parsedLines.forEach((parsedLine, index) => {
      expect(parsedLine.event).toEqual(run.events[index]);
    });

    const resultIndex = run.events.findIndex((event) => event.type === 'result');
    expect(run.parsedLines[resultIndex]?.observation).toEqual({
      usage: { tokens: 128 },
      terminal: 'success',
    });
    run.parsedLines
      .filter((_, index) => index !== resultIndex)
      .forEach((parsedLine) => expect(parsedLine.observation).toBeUndefined());
  });

  it('usage.tokens de uma observation explícita do adapter alimenta metrics.tokens com a provenance do adapter', async () => {
    const adapter = customAdapterWithCost('USD');
    const run = await executeWithAdapter(adapter, runOptions(adapter));

    expect(run.record.metrics.tokens).toEqual({
      value: 128,
      provenance: 'custom_observation_provenance',
    });
  });

  it('cost explicitamente USD alimenta api_equivalent_usd com a mesma provenance, sem conversão', async () => {
    const adapter = customAdapterWithCost('USD');
    const run = await executeWithAdapter(adapter, runOptions(adapter));

    expect(run.record.metrics.api_equivalent_usd).toEqual({
      value: 0.42,
      provenance: 'custom_observation_provenance',
    });
  });

  it('cost em moeda que não é USD/API-equivalent não vira api_equivalent_usd — permanece só na observation', async () => {
    const adapter = customAdapterWithCost('BRL');
    const run = await executeWithAdapter(adapter, runOptions(adapter));

    expect(run.record.metrics.api_equivalent_usd).toBeUndefined();
    const resultIndex = run.events.findIndex((event) => event.type === 'result');
    expect(run.parsedLines[resultIndex]?.observation?.cost).toEqual({
      amount: 0.42,
      currency: 'BRL',
    });
  });

  it('ausência de usage.tokens na observation vira null + provenance, nunca zero', async () => {
    const adapter: ProviderAdapter = {
      identity: { name: 'test-no-usage-adapter', version: '1.0.0' },
      executionKind: 'FIXTURE',
      metricsProvenance: 'no_usage_provenance',
      buildInvocation: fakeAdapter.buildInvocation,
      parseLine(raw: string): ParsedProviderLine {
        const parsed = fakeAdapter.parseLine(raw);
        return { event: parsed.event };
      },
    };
    const run = await executeWithAdapter(adapter, runOptions(adapter));

    expect(run.record.metrics.tokens).toEqual({ value: null, provenance: 'no_usage_provenance' });
  });

  it('terminal do provider é observation e não altera ExecutionStatus — failure relatado coexiste com COMPLETED', async () => {
    const adapter = customAdapterWithCost('USD');
    const run = await executeWithAdapter(adapter, runOptions(adapter, 'failure'));

    expect(run.record.status).toBe(ExecutionStatus.COMPLETED);
    const resultIndex = run.events.findIndex((event) => event.type === 'result');
    expect(run.parsedLines[resultIndex]?.observation?.terminal).toBe('failure');
  });

  it('resolveAdapter("fake") também preserva parsedLines através do runtime comum', async () => {
    const adapter = resolveAdapter('fake');
    const run = await executeWithAdapter(adapter, runOptions(adapter));

    expect(run.parsedLines.some((parsedLine) => parsedLine.observation !== undefined)).toBe(true);
  });
});
