import { describe, expect, it } from 'vitest';

import { EvaluationOutcome } from '../../src/core/index.js';
import { EvaluationRecord } from '../../src/schemas/index.js';

function validEvaluationRecord(): EvaluationRecord {
  return {
    evaluation_id: 'evaluation-001',
    outcome: EvaluationOutcome.PASS,
    grader_results: {
      'unit-tests': { outcome: EvaluationOutcome.PASS, required: true },
      'quality-review': { outcome: EvaluationOutcome.PASS, required: false },
    },
    grader_versions: {
      'unit-tests': 'vitest@2.1.8',
      'quality-review': 'rubric-2026-08-07',
    },
    evaluation_envelope_sha256: 'a'.repeat(64),
  };
}

describe('EvaluationRecord', () => {
  it('parses a complete evaluation record', () => {
    const input = validEvaluationRecord();

    expect(EvaluationRecord.parse(input)).toEqual(input);
  });

  it('allows a run to retain independent evaluation records', () => {
    const first = validEvaluationRecord();
    const second: EvaluationRecord = {
      ...validEvaluationRecord(),
      evaluation_id: 'evaluation-002',
      evaluation_envelope_sha256: 'b'.repeat(64),
    };

    expect([first, second].map((record) => EvaluationRecord.parse(record))).toEqual([
      first,
      second,
    ]);
  });

  it('requires FAIL when a required grader fails', () => {
    const requiredFailure = {
      ...validEvaluationRecord(),
      outcome: EvaluationOutcome.PARTIAL,
      grader_results: {
        ...validEvaluationRecord().grader_results,
        'unit-tests': { outcome: EvaluationOutcome.FAIL, required: true },
      },
    };

    expect(EvaluationRecord.safeParse(requiredFailure).success).toBe(false);
    expect(
      EvaluationRecord.parse({ ...requiredFailure, outcome: EvaluationOutcome.FAIL }).outcome,
    ).toBe(EvaluationOutcome.FAIL);
  });

  it('allows PARTIAL when only an optional grader fails', () => {
    const input: EvaluationRecord = {
      ...validEvaluationRecord(),
      outcome: EvaluationOutcome.PARTIAL,
      grader_results: {
        ...validEvaluationRecord().grader_results,
        'quality-review': { outcome: EvaluationOutcome.FAIL, required: false },
      },
    };

    expect(EvaluationRecord.parse(input)).toEqual(input);
  });

  it.each([
    { ...validEvaluationRecord(), evaluation_id: 'invalid id' },
    { ...validEvaluationRecord(), outcome: 'COMPLETED' },
    { ...validEvaluationRecord(), grader_results: {} },
    { ...validEvaluationRecord(), grader_versions: {} },
    {
      ...validEvaluationRecord(),
      grader_versions: { 'unit-tests': 'vitest@2.1.8' },
    },
    {
      ...validEvaluationRecord(),
      grader_versions: {
        ...validEvaluationRecord().grader_versions,
        'quality-review': '   ',
      },
    },
    { ...validEvaluationRecord(), evaluation_envelope_sha256: 'not-a-sha256' },
    { ...validEvaluationRecord(), run_outcome: EvaluationOutcome.PASS },
  ])('rejects an invalid evaluation record', (input) => {
    expect(EvaluationRecord.safeParse(input).success).toBe(false);
  });
});
