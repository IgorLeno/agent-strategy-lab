import { describe, expect, it } from 'vitest';

import { deriveQuotaAvailability } from '../../src/experiment/index.js';
import {
  QuotaObservationStatus,
  QuotaReasonCode,
  type ExperimentBillingPolicy,
  type QuotaUsage,
  type QuotaWindow,
} from '../../src/schemas/index.js';

function policy(thresholdPct: number): ExperimentBillingPolicy {
  return {
    billing_mode: 'SUBSCRIPTION',
    max_incremental_charge_usd: null,
    quota_stop_threshold_pct: thresholdPct,
  };
}

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    window_id: 'five_hour',
    before_used_pct: 10,
    after_used_pct: 40,
    consumed_pp: 30,
    same_window: true,
    reason_code: QuotaReasonCode.OK,
    provenance: 'provider_probe',
    ...overrides,
  };
}

function observedUsage(windows: QuotaWindow[]): QuotaUsage {
  return {
    provider: 'anthropic',
    observation: {
      status: QuotaObservationStatus.OBSERVED,
      reason_code: QuotaReasonCode.OK,
      provenance: 'provider_probe',
    },
    windows,
  };
}

function unavailableUsage(): QuotaUsage {
  return {
    provider: 'anthropic',
    observation: {
      status: QuotaObservationStatus.UNAVAILABLE,
      reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
      provenance: 'provider_probe:failed',
    },
    windows: [],
  };
}

describe('deriveQuotaAvailability', () => {
  it('SUFFICIENT quando o uso da janela está abaixo do threshold', () => {
    const usage = observedUsage([window({ after_used_pct: 40 })]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    expect(derived.availability.value).toBe('SUFFICIENT');
    expect(derived.remaining.value).toBe(60);
    expect(derived.unit).toBe('percent');
  });

  it('INSUFFICIENT quando o uso é exatamente igual ao threshold', () => {
    const usage = observedUsage([window({ after_used_pct: 80 })]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    expect(derived.availability.value).toBe('INSUFFICIENT');
  });

  it('INSUFFICIENT quando o uso está acima do threshold', () => {
    const usage = observedUsage([window({ after_used_pct: 95 })]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    expect(derived.availability.value).toBe('INSUFFICIENT');
  });

  it('usa o snapshot da própria janela (after_used_pct), nunca consumed_pp', () => {
    // consumed_pp alto (delta) mas after_used_pct baixo (snapshot real da janela)
    // — a decisão deve seguir o snapshot, não o delta.
    const usage = observedUsage([
      window({ before_used_pct: 5, after_used_pct: 20, consumed_pp: 15 }),
    ]);

    const derived = deriveQuotaAvailability(usage, policy(10));

    expect(derived.availability.value).toBe('INSUFFICIENT'); // 20 >= 10
    expect(derived.remaining.value).toBe(80); // 100 - 20, não 100 - 15
  });

  it('null quando usage é ausente (null/undefined), nunca 0/SUFFICIENT por omissão', () => {
    expect(deriveQuotaAvailability(null, policy(80)).availability.value).toBeNull();
    expect(deriveQuotaAvailability(undefined, policy(80)).availability.value).toBeNull();
  });

  it('null quando observation.status é UNAVAILABLE', () => {
    const derived = deriveQuotaAvailability(unavailableUsage(), policy(80));

    expect(derived.availability.value).toBeNull();
    expect(derived.remaining.value).toBeNull();
    expect(derived.unit).toBeNull();
  });

  it('null quando nenhuma janela é comparável (before/after ausentes)', () => {
    const usage = observedUsage([
      window({ before_used_pct: null, after_used_pct: null, consumed_pp: null }),
    ]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    expect(derived.availability.value).toBeNull();
  });

  it('descarta before_used_pct quando same_window é false (janela trocou de instância)', () => {
    const usage = observedUsage([
      window({ before_used_pct: 95, after_used_pct: null, same_window: false, consumed_pp: null }),
    ]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    expect(derived.availability.value).toBeNull();
  });

  it('usa before_used_pct quando after está ausente e same_window não é false', () => {
    const usage = observedUsage([
      window({ before_used_pct: 85, after_used_pct: null, same_window: null, consumed_pp: null }),
    ]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    expect(derived.availability.value).toBe('INSUFFICIENT');
  });

  it('janelas de window_id diferentes nunca são somadas — decide pela mais crítica isoladamente', () => {
    const usage = observedUsage([
      window({ window_id: 'five_hour', after_used_pct: 30 }),
      window({ window_id: 'seven_day', after_used_pct: 85 }),
    ]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    // 30 + 85 = 115 nunca é o critério; 85 isolado já cruza o threshold.
    expect(derived.availability.value).toBe('INSUFFICIENT');
  });

  it('janelas de window_id diferentes ambas abaixo do threshold permanecem SUFFICIENT', () => {
    const usage = observedUsage([
      window({ window_id: 'five_hour', after_used_pct: 30 }),
      window({ window_id: 'seven_day', after_used_pct: 50 }),
    ]);

    const derived = deriveQuotaAvailability(usage, policy(80));

    expect(derived.availability.value).toBe('SUFFICIENT');
  });

  it('OBSERVED com windows vazio permanece null (nenhuma janela comparável)', () => {
    const derived = deriveQuotaAvailability(observedUsage([]), policy(80));

    expect(derived.availability.value).toBeNull();
  });
});
