import { describe, expect, it } from 'vitest';

import { TaskSpec } from '../../src/schemas/index.js';

function validTaskSpec(): TaskSpec {
  return {
    id: 'add-retry-policy',
    description: 'Adicionar retentativas limitadas ao cliente HTTP.',
    visible_criteria: [
      'Retenta somente erros transitórios.',
      'Preserva o erro da última tentativa.',
    ],
    task_class: 'feature',
    difficulty: 'medium',
    stack: ['typescript', 'vitest'],
    public_graders: ['typecheck', 'unit-tests'],
    budgets: {
      duration_ms: { expected: 120_000, maximum: 300_000 },
      tokens: { expected: 8_000, maximum: 20_000 },
      changed_files: { expected: 3, maximum: 6 },
    },
  };
}

describe('TaskSpec', () => {
  it('parses a complete public task specification', () => {
    const input = validTaskSpec();

    expect(TaskSpec.parse(input)).toEqual(input);
  });

  it.each(['duration_ms', 'tokens', 'changed_files'] as const)(
    'rejects an incoherent %s budget',
    (dimension) => {
      const input = validTaskSpec();
      input.budgets[dimension] = { expected: 11, maximum: 10 };

      const result = TaskSpec.safeParse(input);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: ['budgets', dimension, 'expected'] }),
          ]),
        );
      }
    },
  );

  it('rejects malformed or incomplete public fields', () => {
    expect(TaskSpec.safeParse({ ...validTaskSpec(), id: 'invalid id' }).success).toBe(false);
    expect(TaskSpec.safeParse({ ...validTaskSpec(), visible_criteria: [] }).success).toBe(false);
    expect(
      TaskSpec.safeParse({
        ...validTaskSpec(),
        budgets: {
          ...validTaskSpec().budgets,
          tokens: { expected: -1, maximum: 10 },
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['hidden_graders', ['private-integration-tests']],
    ['rubric', { correctness: 0.8, quality: 0.2 }],
  ])('rejects private evaluation field %s', (field, value) => {
    expect(TaskSpec.safeParse({ ...validTaskSpec(), [field]: value }).success).toBe(false);
  });

  it('parses a historical M1-era spec without a taxonomy block and with free-form strings', () => {
    const input = {
      ...validTaskSpec(),
      task_class: 'some-legacy-class-string',
      difficulty: 'super-hard-ish',
    };

    expect(TaskSpec.parse(input)).toEqual(input);
  });

  it('accepts a taxonomy block with only required fields', () => {
    const input = {
      ...validTaskSpec(),
      taxonomy: {
        version: 1 as const,
        task_class: 'feature' as const,
        difficulty_declared: 'medium' as const,
      },
    };

    expect(TaskSpec.parse(input)).toEqual(input);
  });

  it('accepts a taxonomy block with all optional fields set', () => {
    const input = {
      ...validTaskSpec(),
      taxonomy: {
        version: 1 as const,
        task_class: 'refactor' as const,
        difficulty_declared: 'hard' as const,
        complexity: 'cross_cutting' as const,
        ambiguity: 'high' as const,
        verification: 'subjective' as const,
      },
    };

    expect(TaskSpec.parse(input)).toEqual(input);
  });

  it('rejects a taxonomy block with a version other than 1', () => {
    const input = {
      ...validTaskSpec(),
      taxonomy: {
        version: 2,
        task_class: 'feature',
        difficulty_declared: 'medium',
      },
    };

    expect(TaskSpec.safeParse(input).success).toBe(false);
  });

  it.each([
    ['task_class', 'not-a-real-class'],
    ['difficulty_declared', 'impossible'],
    ['complexity', 'entire_universe'],
    ['ambiguity', 'extreme'],
    ['verification', 'vibes'],
  ])('rejects an invalid taxonomy.%s value', (field, value) => {
    const input = {
      ...validTaskSpec(),
      taxonomy: {
        version: 1,
        task_class: 'feature',
        difficulty_declared: 'medium',
        [field]: value,
      },
    };

    expect(TaskSpec.safeParse(input).success).toBe(false);
  });

  it('rejects unknown fields inside the taxonomy block', () => {
    const input = {
      ...validTaskSpec(),
      taxonomy: {
        version: 1,
        task_class: 'feature',
        difficulty_declared: 'medium',
        extra_field: 'nope',
      },
    };

    expect(TaskSpec.safeParse(input).success).toBe(false);
  });
});
