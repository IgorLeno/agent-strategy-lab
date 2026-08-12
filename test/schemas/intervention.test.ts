import { describe, expect, it } from 'vitest';

import { InterventionRecord, InterventionType } from '../../src/schemas/index.js';

function validIntervention(): InterventionRecord {
  return {
    intervention_id: 'intervention-001',
    type: InterventionType.MANUAL_FIX,
    description: 'Corrigido manualmente o lockfile corrompido.',
    occurred_at: '2026-08-11T12:00:00.000Z',
    affects_autonomy: true,
  };
}

describe('InterventionRecord', () => {
  it.each(Object.values(InterventionType))('parses a valid intervention of type %s', (type) => {
    const input: InterventionRecord = { ...validIntervention(), type };

    expect(InterventionRecord.parse(input)).toEqual(input);
  });

  it('rejects an empty description', () => {
    expect(
      InterventionRecord.safeParse({ ...validIntervention(), description: '' }).success,
    ).toBe(false);
    expect(
      InterventionRecord.safeParse({ ...validIntervention(), description: '   ' }).success,
    ).toBe(false);
  });

  it('rejects a type outside the enum', () => {
    expect(
      InterventionRecord.safeParse({ ...validIntervention(), type: 'undocumented' }).success,
    ).toBe(false);
  });

  it('rejects a non-ISO occurred_at', () => {
    expect(
      InterventionRecord.safeParse({ ...validIntervention(), occurred_at: 'yesterday' }).success,
    ).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(
      InterventionRecord.safeParse({ ...validIntervention(), extra: 'nope' }).success,
    ).toBe(false);
  });
});
