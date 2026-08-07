import { describe, expect, it } from 'vitest';

import { QualificationStatus } from '../../src/core/index.js';
import {
  QualificationRecord,
  ScoreRecord,
} from '../../src/schemas/index.js';

function validScoreRecord(): ScoreRecord {
  return {
    score_profile_id: 'default',
    score_profile_version: '1.0.0',
    sub_scores: {
      outcome: { value: 1, weight: 0.5, required: true },
      duration: { value: 0.8, weight: 0.3, required: true },
      tokens: { value: 0.9, weight: 0.2, required: false },
    },
    budgets_used: {
      duration_ms: { expected: 60_000, maximum: 120_000 },
      tokens: { expected: 10_000, maximum: 20_000 },
      changed_files: { expected: 5, maximum: 10 },
    },
    coverage: 1,
  };
}

describe('ScoreRecord', () => {
  it('parses a complete score record', () => {
    const input = validScoreRecord();

    expect(ScoreRecord.parse(input)).toEqual(input);
  });

  it('keeps an absent optional sub-score null and lowers coverage', () => {
    const input: ScoreRecord = {
      ...validScoreRecord(),
      sub_scores: {
        ...validScoreRecord().sub_scores,
        tokens: { value: null, weight: 0.2, required: false },
      },
      coverage: 0.8,
    };

    expect(ScoreRecord.parse(input)).toEqual(input);
  });

  it('preserves an absent required sub-score for an UNSCORABLE qualification', () => {
    const score: ScoreRecord = {
      ...validScoreRecord(),
      sub_scores: {
        ...validScoreRecord().sub_scores,
        duration: { value: null, weight: 0.3, required: true },
      },
      coverage: 0.7,
    };
    const qualification: QualificationRecord = {
      status: QualificationStatus.UNSCORABLE,
      justification: 'Métrica obrigatória duration_ms ausente',
    };

    expect(ScoreRecord.parse(score)).toEqual(score);
    expect(QualificationRecord.parse(qualification)).toEqual(qualification);
  });

  it('rejects redistributed weight when an optional sub-score is absent', () => {
    const input = {
      ...validScoreRecord(),
      sub_scores: {
        outcome: { value: 1, weight: 0.625, required: true },
        duration: { value: 0.8, weight: 0.375, required: true },
        tokens: { value: null, weight: 0.2, required: false },
      },
      coverage: 1,
    };

    expect(ScoreRecord.safeParse(input).success).toBe(false);
  });

  it('rejects full coverage when an optional sub-score is absent', () => {
    const input = {
      ...validScoreRecord(),
      sub_scores: {
        ...validScoreRecord().sub_scores,
        tokens: { value: null, weight: 0.2, required: false },
      },
    };

    expect(ScoreRecord.safeParse(input).success).toBe(false);
  });

  it.each([
    { ...validScoreRecord(), score_profile_id: 'invalid id' },
    { ...validScoreRecord(), score_profile_version: '   ' },
    { ...validScoreRecord(), sub_scores: {} },
    {
      ...validScoreRecord(),
      sub_scores: {
        ...validScoreRecord().sub_scores,
        tokens: { value: 1.1, weight: 0.2, required: false },
      },
    },
    { ...validScoreRecord(), coverage: -0.1 },
    { ...validScoreRecord(), score: 0.9 },
  ])('rejects an invalid score record', (input) => {
    expect(ScoreRecord.safeParse(input).success).toBe(false);
  });
});

describe('QualificationRecord', () => {
  it('parses QUALIFIED without justification', () => {
    const input: QualificationRecord = {
      status: QualificationStatus.QUALIFIED,
      justification: null,
    };

    expect(QualificationRecord.parse(input)).toEqual(input);
  });

  it('parses UNSCORABLE with the missing required metric justification', () => {
    const input: QualificationRecord = {
      status: QualificationStatus.UNSCORABLE,
      justification: 'Métrica obrigatória duration_ms ausente',
    };

    expect(QualificationRecord.parse(input)).toEqual(input);
  });

  it.each([
    { status: QualificationStatus.UNSCORABLE, justification: null },
    { status: QualificationStatus.MISSCOPED, justification: '   ' },
    { status: 'FAILED', justification: 'status inválido' },
    { status: QualificationStatus.QUALIFIED },
  ])('rejects invalid qualification data', (input) => {
    expect(QualificationRecord.safeParse(input).success).toBe(false);
  });
});
