import { describe, expect, it } from 'vitest';

import { EvaluationPlan, TaskSpec } from '../../src/schemas/index.js';

function validEvaluationPlan(): EvaluationPlan {
  return {
    hidden_graders: ['private-integration-tests', 'architecture-review'],
    rubric: {
      correctness: 'A implementação satisfaz todos os critérios funcionais.',
      quality: 'A solução é legível e preserva as fronteiras arquiteturais.',
    },
    weights: {
      correctness: 0.8,
      quality: 0.2,
    },
  };
}

function validTaskSpec(): TaskSpec {
  return {
    id: 'add-retry-policy',
    description: 'Adicionar retentativas limitadas ao cliente HTTP.',
    visible_criteria: ['Retenta somente erros transitórios.'],
    task_class: 'feature',
    difficulty: 'medium',
    stack: ['typescript'],
    public_graders: ['typecheck'],
    budgets: {
      duration_ms: { expected: 120_000, maximum: 300_000 },
      tokens: { expected: 8_000, maximum: 20_000 },
      changed_files: { expected: 3, maximum: 6 },
    },
  };
}

describe('EvaluationPlan', () => {
  it('parses a complete private evaluation plan', () => {
    const input = validEvaluationPlan();

    expect(EvaluationPlan.parse(input)).toEqual(input);
  });

  it.each([
    { ...validEvaluationPlan(), hidden_graders: [] },
    { ...validEvaluationPlan(), rubric: {} },
    { ...validEvaluationPlan(), weights: { correctness: -1, quality: 2 } },
    { ...validEvaluationPlan(), weights: { correctness: 1 } },
    { ...validEvaluationPlan(), task_id: 'must-not-be-shared' },
  ])('rejects an invalid private evaluation plan', (input) => {
    expect(EvaluationPlan.safeParse(input).success).toBe(false);
  });

  it('keeps private evaluation fields out of serialized TaskSpec values', () => {
    const serialized = JSON.stringify(TaskSpec.parse(validTaskSpec()));

    expect(serialized).not.toContain('hidden_graders');
    expect(serialized).not.toContain('rubric');
    expect(serialized).not.toContain('weights');
  });
});
