import { describe, expect, it } from 'vitest';

import { ExecutionStatus } from '../../src/core/index.js';
import { ExecutionRecord } from '../../src/schemas/index.js';

function validExecutionRecord(): ExecutionRecord {
  return {
    status: ExecutionStatus.COMPLETED,
    exit_code: 0,
    duration_ms: 42_000,
    execution_envelope_sha256: 'a'.repeat(64),
    metrics: {
      tokens: { value: 1_250, provenance: 'agent_adapter' },
      changed_files: { value: null, provenance: 'git_diff_unavailable' },
    },
  };
}

describe('ExecutionRecord', () => {
  it.each(Object.values(ExecutionStatus))('parses execution status %s', (status) => {
    const input: ExecutionRecord = {
      ...validExecutionRecord(),
      status,
      exit_code: status === ExecutionStatus.COMPLETED ? 0 : null,
    };

    expect(ExecutionRecord.parse(input)).toEqual(input);
  });

  it('preserves an unavailable metric as null with field-level provenance', () => {
    const parsed = ExecutionRecord.parse(validExecutionRecord());

    expect(parsed.metrics.changed_files).toEqual({
      value: null,
      provenance: 'git_diff_unavailable',
    });
  });

  it('preserves zero as a measured value instead of treating it as missing', () => {
    const input: ExecutionRecord = {
      ...validExecutionRecord(),
      metrics: {
        ...validExecutionRecord().metrics,
        changed_files: { value: 0, provenance: 'git_diff' },
      },
    };

    expect(ExecutionRecord.parse(input).metrics.changed_files.value).toBe(0);
  });

  it.each(['PASS', 'FAIL', 'PLANNED'])('rejects %s as an execution status', (status) => {
    expect(ExecutionRecord.safeParse({ ...validExecutionRecord(), status }).success).toBe(false);
  });

  it('parses an M1-era execution record without the newer optional metrics', () => {
    const input: ExecutionRecord = validExecutionRecord();

    const parsed = ExecutionRecord.parse(input);

    expect(parsed.metrics.input_tokens).toBeUndefined();
    expect(parsed.metrics.api_equivalent_usd).toBeUndefined();
  });

  it('accepts the new optional metrics as null with provenance', () => {
    const input: ExecutionRecord = {
      ...validExecutionRecord(),
      metrics: {
        ...validExecutionRecord().metrics,
        input_tokens: { value: null, provenance: 'agent_adapter_unavailable' },
        cached_input_tokens: { value: null, provenance: 'agent_adapter_unavailable' },
        output_tokens: { value: null, provenance: 'agent_adapter_unavailable' },
        reasoning_tokens: { value: null, provenance: 'agent_adapter_unavailable' },
        api_equivalent_usd: { value: null, provenance: 'pricing_unavailable' },
      },
    };

    const parsed = ExecutionRecord.parse(input);

    expect(parsed.metrics.input_tokens).toEqual({
      value: null,
      provenance: 'agent_adapter_unavailable',
    });
    expect(parsed.metrics.api_equivalent_usd).toEqual({
      value: null,
      provenance: 'pricing_unavailable',
    });
  });

  it('accepts a decimal value for api_equivalent_usd', () => {
    const input: ExecutionRecord = {
      ...validExecutionRecord(),
      metrics: {
        ...validExecutionRecord().metrics,
        api_equivalent_usd: { value: 0.0123, provenance: 'pricing_table' },
      },
    };

    expect(ExecutionRecord.parse(input).metrics.api_equivalent_usd?.value).toBe(0.0123);
  });

  it.each(['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens'] as const)(
    'rejects a non-integer value for %s',
    (field) => {
      const input = {
        ...validExecutionRecord(),
        metrics: {
          ...validExecutionRecord().metrics,
          [field]: { value: 1.5, provenance: 'agent_adapter' },
        },
      };

      expect(ExecutionRecord.safeParse(input).success).toBe(false);
    },
  );

  it.each([
    { input_tokens: { value: -1, provenance: 'agent_adapter' } },
    { api_equivalent_usd: { value: -0.01, provenance: 'pricing_table' } },
    { input_tokens: { value: 100 } },
    { api_equivalent_usd: { value: 1.5 } },
  ])('rejects a new metric that is numeric without provenance or negative', (metricField) => {
    const input = {
      ...validExecutionRecord(),
      metrics: {
        ...validExecutionRecord().metrics,
        ...metricField,
      },
    };

    expect(ExecutionRecord.safeParse(input).success).toBe(false);
  });

  it.each([
    { metrics: { ...validExecutionRecord().metrics, tokens: { provenance: 'agent_adapter' } } },
    { metrics: { ...validExecutionRecord().metrics, tokens: { value: null } } },
    {
      metrics: {
        ...validExecutionRecord().metrics,
        tokens: { value: null, provenance: '   ' },
      },
    },
    { execution_envelope_sha256: 'not-a-sha256' },
    { exit_code: 1.5 },
    { duration_ms: -1 },
  ])('rejects an invalid execution record', (invalidFields) => {
    expect(
      ExecutionRecord.safeParse({ ...validExecutionRecord(), ...invalidFields }).success,
    ).toBe(false);
  });
});
