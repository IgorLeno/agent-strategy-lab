import { describe, expect, it } from 'vitest';

import {
  QuotaObservationStatus,
  QuotaReasonCode,
  QuotaUsage,
  QuotaWindow,
} from '../../src/schemas/index.js';

function validWindow(): QuotaWindow {
  return {
    window_id: 'five_hour',
    before_used_pct: 10,
    after_used_pct: 25,
    consumed_pp: 15,
    same_window: true,
    reason_code: QuotaReasonCode.OK,
    provenance: 'provider_probe',
  };
}

function validUsage(): QuotaUsage {
  return {
    provider: 'anthropic',
    observation: {
      status: QuotaObservationStatus.OBSERVED,
      reason_code: QuotaReasonCode.OK,
      provenance: 'provider_probe',
    },
    windows: [validWindow()],
  };
}

describe('QuotaWindow', () => {
  it.each(Object.values(QuotaReasonCode))('parses window reason_code %s', (reason_code) => {
    const input: QuotaWindow = { ...validWindow(), reason_code };

    expect(QuotaWindow.parse(input)).toEqual(input);
  });

  it.each(['five_hour', 'seven_day', 'weekly-burst', 'PROVIDER_SPECIFIC_42'])(
    'accepts an arbitrary non-empty provider-defined window_id %s',
    (window_id) => {
      const input: QuotaWindow = { ...validWindow(), window_id };

      expect(QuotaWindow.parse(input)).toEqual(input);
    },
  );

  it('rejects an empty window_id', () => {
    expect(QuotaWindow.safeParse({ ...validWindow(), window_id: '' }).success).toBe(false);
    expect(QuotaWindow.safeParse({ ...validWindow(), window_id: '   ' }).success).toBe(false);
  });

  it('accepts null before/after/consumed_pp with a reason_code documenting unavailability', () => {
    const input: QuotaWindow = {
      ...validWindow(),
      before_used_pct: null,
      after_used_pct: null,
      consumed_pp: null,
      same_window: null,
      reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
    };

    expect(QuotaWindow.parse(input)).toEqual(input);
  });

  it('rejects a numeric consumed_pp when same_window is false', () => {
    const input = { ...validWindow(), consumed_pp: 5, same_window: false };

    expect(QuotaWindow.safeParse(input).success).toBe(false);
  });

  it('accepts a numeric consumed_pp when same_window is true or null', () => {
    expect(
      QuotaWindow.safeParse({ ...validWindow(), consumed_pp: 5, same_window: true }).success,
    ).toBe(true);
    expect(
      QuotaWindow.safeParse({ ...validWindow(), consumed_pp: 5, same_window: null }).success,
    ).toBe(true);
  });

  it('accepts a null consumed_pp regardless of same_window', () => {
    expect(
      QuotaWindow.safeParse({ ...validWindow(), consumed_pp: null, same_window: false }).success,
    ).toBe(true);
  });

  it('rejects an unknown reason_code', () => {
    expect(
      QuotaWindow.safeParse({ ...validWindow(), reason_code: 'UNKNOWN' }).success,
    ).toBe(false);
  });

  it('rejects a window missing provenance', () => {
    const { provenance, ...rest } = validWindow();

    expect(QuotaWindow.safeParse(rest).success).toBe(false);
  });
});

describe('QuotaUsage', () => {
  it('accepts observation OBSERVED with an empty windows list', () => {
    const input: QuotaUsage = {
      ...validUsage(),
      observation: { ...validUsage().observation, status: QuotaObservationStatus.OBSERVED },
      windows: [],
    };

    expect(QuotaUsage.parse(input)).toEqual(input);
  });

  it('accepts observation UNAVAILABLE with an empty windows list', () => {
    const input: QuotaUsage = {
      ...validUsage(),
      observation: {
        status: QuotaObservationStatus.UNAVAILABLE,
        reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
        provenance: 'provider_probe',
      },
      windows: [],
    };

    expect(QuotaUsage.parse(input)).toEqual(input);
  });

  it('rejects observation UNAVAILABLE with a non-empty windows list', () => {
    const input = {
      ...validUsage(),
      observation: {
        status: QuotaObservationStatus.UNAVAILABLE,
        reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
        provenance: 'provider_probe',
      },
      windows: [validWindow()],
    };

    expect(QuotaUsage.safeParse(input).success).toBe(false);
  });

  it('rejects an empty provider', () => {
    expect(QuotaUsage.safeParse({ ...validUsage(), provider: '' }).success).toBe(false);
  });

  it('rejects an unknown observation status', () => {
    const input = {
      ...validUsage(),
      observation: { ...validUsage().observation, status: 'PENDING' },
    };

    expect(QuotaUsage.safeParse(input).success).toBe(false);
  });

  it('rejects extra fields (strict schema)', () => {
    expect(QuotaUsage.safeParse({ ...validUsage(), extra: true }).success).toBe(false);
  });
});
