import { describe, expect, it } from 'vitest';

import { EvaluationOutcome, ExecutionStatus, QualificationStatus } from '../../src/core/index.js';
import {
  ExecutionRecord,
  QualificationRecord,
  ScoreRecord,
  type EvaluationRecord,
  type TaskBudgets,
} from '../../src/schemas/index.js';
import { SCORE_PROFILE_V1_ID, SCORE_PROFILE_V1_VERSION, scoreRunV1 } from '../../src/scorer/index.js';

const sha256 = 'a'.repeat(64);

function budgets(): TaskBudgets {
  return {
    duration_ms: { expected: 60_000, maximum: 120_000 },
    tokens: { expected: 10_000, maximum: 20_000 },
    changed_files: { expected: 5, maximum: 10 },
  };
}

function executionRecord(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    status: ExecutionStatus.COMPLETED,
    exit_code: 0,
    duration_ms: 60_000,
    execution_envelope_sha256: sha256,
    metrics: {
      tokens: { value: 10_000, provenance: 'agent-cli' },
      changed_files: { value: 5, provenance: 'changes-manifest' },
    },
    ...overrides,
  };
}

function evaluationRecord(outcome: EvaluationOutcome): EvaluationRecord {
  return {
    evaluation_id: 'ev-1',
    outcome,
    grader_results: { typecheck: { outcome: EvaluationOutcome.PASS, required: true } },
    grader_versions: { typecheck: 'v1' },
    evaluation_envelope_sha256: sha256,
  };
}

describe('scoreRunV1', () => {
  it('produz um ScoreRecord válido para um run dentro do budget e outcome PASS', () => {
    const { score, qualification } = scoreRunV1({
      executionRecord: executionRecord(),
      evaluationRecord: evaluationRecord(EvaluationOutcome.PASS),
      budgets: budgets(),
    });

    expect(score.score_profile_id).toBe(SCORE_PROFILE_V1_ID);
    expect(score.score_profile_version).toBe(SCORE_PROFILE_V1_VERSION);
    expect(score.sub_scores.outcome).toEqual({ value: 1, weight: 0.4, required: true });
    expect(score.sub_scores.duration?.value).toBe(1);
    expect(score.sub_scores.tokens?.value).toBe(1);
    expect(score.sub_scores.scope?.value).toBe(1);
    expect(score.coverage).toBe(1);
    expect(score.budgets_used).toEqual(budgets());
    expect(ScoreRecord.parse(score)).toEqual(score);

    expect(qualification).toEqual({ status: QualificationStatus.QUALIFIED, justification: null });
    expect(QualificationRecord.parse(qualification)).toEqual(qualification);
  });

  it('degrada o sub-score linearmente entre expected e maximum do budget', () => {
    const { score } = scoreRunV1({
      executionRecord: executionRecord({ duration_ms: 90_000 }),
      evaluationRecord: evaluationRecord(EvaluationOutcome.PASS),
      budgets: budgets(),
    });

    // 90_000 está a meio caminho entre expected (60_000) e maximum (120_000).
    expect(score.sub_scores.duration?.value).toBeCloseTo(0.5);
  });

  it('zera o sub-score quando a métrica atinge ou passa o maximum do budget', () => {
    const { score } = scoreRunV1({
      executionRecord: executionRecord({ duration_ms: 150_000 }),
      evaluationRecord: evaluationRecord(EvaluationOutcome.PASS),
      budgets: budgets(),
    });

    expect(score.sub_scores.duration?.value).toBe(0);
  });

  it('outcome FAIL impõe teto: zera todo sub-score medido, mesmo dentro do budget', () => {
    const { score, qualification } = scoreRunV1({
      executionRecord: executionRecord(),
      evaluationRecord: evaluationRecord(EvaluationOutcome.FAIL),
      budgets: budgets(),
    });

    expect(score.sub_scores.outcome?.value).toBe(0);
    expect(score.sub_scores.duration?.value).toBe(0);
    expect(score.sub_scores.tokens?.value).toBe(0);
    expect(score.sub_scores.scope?.value).toBe(0);
    expect(qualification.status).toBe(QualificationStatus.QUALIFIED);
  });

  it('métrica obrigatória ausente (tokens) resulta em UNSCORABLE, sem inventar valor', () => {
    const { score, qualification } = scoreRunV1({
      executionRecord: executionRecord({
        metrics: {
          tokens: { value: null, provenance: 'agent-cli' },
          changed_files: { value: 5, provenance: 'changes-manifest' },
        },
      }),
      evaluationRecord: evaluationRecord(EvaluationOutcome.PASS),
      budgets: budgets(),
    });

    expect(score.sub_scores.tokens).toEqual({ value: null, weight: 0.2, required: true });
    expect(score.coverage).toBeCloseTo(0.8);
    expect(ScoreRecord.parse(score)).toEqual(score);

    expect(qualification.status).toBe(QualificationStatus.UNSCORABLE);
    expect(qualification.justification).toContain('tokens');
    expect(QualificationRecord.parse(qualification)).toEqual(qualification);
  });

  it('métrica opcional ausente (changed_files) mantém sub-score null e preserva o peso, sem redistribuir', () => {
    const { score, qualification } = scoreRunV1({
      executionRecord: executionRecord({
        metrics: {
          tokens: { value: 10_000, provenance: 'agent-cli' },
          changed_files: { value: null, provenance: 'changes-manifest' },
        },
      }),
      evaluationRecord: evaluationRecord(EvaluationOutcome.PASS),
      budgets: budgets(),
    });

    expect(score.sub_scores.scope).toEqual({ value: null, weight: 0.2, required: false });
    expect(score.coverage).toBeCloseTo(0.8);
    expect(ScoreRecord.parse(score)).toEqual(score);

    expect(qualification).toEqual({ status: QualificationStatus.QUALIFIED, justification: null });
  });

  it('não calcula variância nem intervalo de confiança — ScoreRecord fica restrito ao schema', () => {
    const { score } = scoreRunV1({
      executionRecord: executionRecord(),
      evaluationRecord: evaluationRecord(EvaluationOutcome.PASS),
      budgets: budgets(),
    });

    expect(Object.keys(score).sort()).toEqual(
      ['budgets_used', 'coverage', 'score_profile_id', 'score_profile_version', 'sub_scores'].sort(),
    );
  });
});
