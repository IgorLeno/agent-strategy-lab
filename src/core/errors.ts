export const LAB_ERROR_CODES = {
  INVALID_ENUM_VALUE: 'LAB_INVALID_ENUM_VALUE',
} as const;

export type LabErrorCode = (typeof LAB_ERROR_CODES)[keyof typeof LAB_ERROR_CODES];

export class LabError extends Error {
  readonly code: LabErrorCode;

  constructor(code: LabErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class LabValidationError extends LabError {}

export class InvalidEnumValueError extends LabValidationError {
  readonly dimension: string;
  readonly value: unknown;
  readonly expectedValues: readonly string[];

  constructor(dimension: string, value: unknown, expectedValues: readonly string[]) {
    super(
      LAB_ERROR_CODES.INVALID_ENUM_VALUE,
      `Invalid ${dimension}: ${JSON.stringify(value)}. Expected one of: ${expectedValues.join(', ')}`,
    );
    this.dimension = dimension;
    this.value = value;
    this.expectedValues = expectedValues;
  }
}
