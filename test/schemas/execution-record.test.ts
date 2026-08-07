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
