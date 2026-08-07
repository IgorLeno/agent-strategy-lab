import { InvalidEnumValueError } from './errors.js';

export enum ExecutionStatus {
  COMPLETED = 'COMPLETED',
  TIMED_OUT = 'TIMED_OUT',
  CRASHED = 'CRASHED',
  CANCELLED = 'CANCELLED',
  INFRA_ERROR = 'INFRA_ERROR',
}

export enum EvaluationOutcome {
  PASS = 'PASS',
  FAIL = 'FAIL',
  PARTIAL = 'PARTIAL',
  NOT_EVALUATED = 'NOT_EVALUATED',
}

export enum QualificationStatus {
  QUALIFIED = 'QUALIFIED',
  UNSCORABLE = 'UNSCORABLE',
  MISSCOPED = 'MISSCOPED',
  CONTAMINATED = 'CONTAMINATED',
  INVALID_ENVIRONMENT = 'INVALID_ENVIRONMENT',
  HISTORICAL_ONLY = 'HISTORICAL_ONLY',
}

type StringEnumValue<T extends Record<string, string>> = T[keyof T];

function parseEnum<T extends Record<string, string>>(
  dimension: string,
  definition: T,
  value: unknown,
): StringEnumValue<T> {
  if (typeof value === 'string' && Object.values(definition).includes(value)) {
    return value as StringEnumValue<T>;
  }

  throw new InvalidEnumValueError(dimension, value, Object.values(definition));
}

export function parseExecutionStatus(value: unknown): ExecutionStatus {
  return parseEnum('execution status', ExecutionStatus, value);
}

export function parseEvaluationOutcome(value: unknown): EvaluationOutcome {
  return parseEnum('evaluation outcome', EvaluationOutcome, value);
}

export function parseQualificationStatus(value: unknown): QualificationStatus {
  return parseEnum('qualification status', QualificationStatus, value);
}
