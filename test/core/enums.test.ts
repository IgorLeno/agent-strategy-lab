import { describe, expect, it } from 'vitest';

import {
  EvaluationOutcome,
  ExecutionStatus,
  InvalidEnumValueError,
  LAB_ERROR_CODES,
  LabError,
  LabValidationError,
  QualificationStatus,
  parseEvaluationOutcome,
  parseExecutionStatus,
  parseQualificationStatus,
} from '../../src/core/index.js';

describe('core status dimensions', () => {
  const dimensions = [
    Object.values(ExecutionStatus),
    Object.values(EvaluationOutcome),
    Object.values(QualificationStatus),
  ];

  it('keeps every value in exactly one dimension', () => {
    const allValues = dimensions.flat();

    expect(new Set(allValues).size).toBe(allValues.length);
  });

  it.each(Object.values(ExecutionStatus))('parses execution status %s', (value) => {
    expect(parseExecutionStatus(value)).toBe(value);
  });

  it.each(Object.values(EvaluationOutcome))('parses evaluation outcome %s', (value) => {
    expect(parseEvaluationOutcome(value)).toBe(value);
  });

  it.each(Object.values(QualificationStatus))('parses qualification status %s', (value) => {
    expect(parseQualificationStatus(value)).toBe(value);
  });

  it.each([
    ['execution', parseExecutionStatus],
    ['evaluation', parseEvaluationOutcome],
    ['qualification', parseQualificationStatus],
  ] as const)('rejects invalid %s values with a stable lab error', (_dimension, parse) => {
    expect(() => parse('UNKNOWN')).toThrow(InvalidEnumValueError);
    expect(() => parse(undefined)).toThrow(
      expect.objectContaining({ code: LAB_ERROR_CODES.INVALID_ENUM_VALUE }),
    );

    try {
      parse('UNKNOWN');
    } catch (error) {
      expect(error).toBeInstanceOf(LabValidationError);
      expect(error).toBeInstanceOf(LabError);
    }
  });
});
