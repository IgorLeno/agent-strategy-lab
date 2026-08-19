import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PlannedTask } from '../../src/planner/index.js';
import { TaskTaxonomy } from '../../src/schemas/index.js';

function validTaxonomy(): TaskTaxonomy {
  return {
    version: 1,
    task_class: 'feature',
    difficulty_declared: 'medium',
  };
}

function validPlannedTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'M73',
    objective: 'Criar o contrato formal de PlannedTask',
    blocked_by: [],
    taxonomy: validTaxonomy(),
    risk: 'medium',
    acceptance: ['PlannedTask strict e versionado'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/planner/task.ts'],
    probable_files: ['src/planner/index.ts'],
    context_scope: { areas: ['planner'] },
    context_requirements: [
      { description: 'entender TaskBudgets existente', source_anchor: 'src/schemas/task-spec.ts' },
    ],
    environment_requirements: [{ kind: 'tool', name: 'node', reason: 'runtime do worker' }],
    estimated_duration: { expected: 600_000, maximum: 1_800_000 },
    validation_budget: { expected: 60_000, maximum: 300_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 50_000, maximum: 200_000 },
      changed_files: { expected: 3, maximum: 10 },
    },
    ...overrides,
  };
}

describe('PlannedTask', () => {
  it('aceita um envelope válido', () => {
    expect(() => PlannedTask.parse(validPlannedTask())).not.toThrow();
  });

  it('é strict: rejeita campos desconhecidos', () => {
    const withExtra = { ...validPlannedTask(), unexpected: true };
    expect(() => PlannedTask.parse(withExtra)).toThrow();
  });

  it('exige schema_version 1', () => {
    const invalid = { ...validPlannedTask(), schema_version: 2 };
    expect(() => PlannedTask.parse(invalid)).toThrow();
  });

  it('objetivo é uma string única, não uma lista', () => {
    const shape = PlannedTask._def.schema.shape as { objective: z.ZodTypeAny };
    expect(shape.objective).toBeInstanceOf(z.ZodString);
  });

  it('compõe TaskTaxonomy v1 verbatim, sem redeclarar os enums', () => {
    const invalidTaxonomy = { ...validPlannedTask(), taxonomy: { version: 1, task_class: 'nope' } };
    const result = PlannedTask.safeParse(invalidTaxonomy);
    expect(result.success).toBe(false);
  });

  it('reusa TaskBudgets como resource_envelope: expected não pode exceder maximum em nenhuma dimensão', () => {
    const invalid = validPlannedTask({
      resource_envelope: {
        duration_ms: { expected: 2_000_000, maximum: 1_000_000 },
        tokens: { expected: 1, maximum: 10 },
        changed_files: { expected: 1, maximum: 10 },
      },
    });
    expect(PlannedTask.safeParse(invalid).success).toBe(false);
  });

  it('risk aceita somente low/medium/high/critical', () => {
    const invalid = { ...validPlannedTask(), risk: 'severe' };
    expect(PlannedTask.safeParse(invalid).success).toBe(false);
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      expect(PlannedTask.safeParse(validPlannedTask({ risk })).success).toBe(true);
    }
  });

  it('acceptance não pode ser vazio', () => {
    const invalid = validPlannedTask({ acceptance: [] });
    expect(PlannedTask.safeParse(invalid).success).toBe(false);
  });

  it('validation não pode ser vazio', () => {
    const invalid = validPlannedTask({ validation: [] });
    expect(PlannedTask.safeParse(invalid).success).toBe(false);
  });

  it('context_requirements carrega source_anchor por item', () => {
    const invalid = {
      ...validPlannedTask(),
      context_requirements: [{ description: 'sem âncora' }],
    };
    expect(PlannedTask.safeParse(invalid).success).toBe(false);
  });

  it('estimated_duration exige expected <= maximum', () => {
    const invalid = validPlannedTask({
      estimated_duration: { expected: 2_000_000, maximum: 1_000_000 },
    });
    expect(PlannedTask.safeParse(invalid).success).toBe(false);
  });

  it('validation_budget exige expected <= maximum', () => {
    const invalid = validPlannedTask({
      validation_budget: { expected: 500_000, maximum: 100_000 },
    });
    expect(PlannedTask.safeParse(invalid).success).toBe(false);
  });

  it('validation[].timeout_seconds é um conceito de tempo separado de estimated_duration e resource_envelope', () => {
    const task = validPlannedTask({
      validation: [{ argv: ['pnpm', 'test'], timeout_seconds: 900 }],
      estimated_duration: { expected: 100, maximum: 200 },
      resource_envelope: {
        duration_ms: { expected: 100, maximum: 200 },
        tokens: { expected: 1, maximum: 2 },
        changed_files: { expected: 1, maximum: 2 },
      },
    });
    const result = PlannedTask.parse(task);
    expect(result.validation[0]?.timeout_seconds).toBe(900);
    expect(result.estimated_duration.maximum).toBe(200);
    expect(result.resource_envelope.duration_ms.maximum).toBe(200);
  });

  it('não existe teto universal de duração: valores arbitrariamente grandes são aceitos em qualquer dos três conceitos de tempo', () => {
    const hugeMs = Number.MAX_SAFE_INTEGER;
    const task = validPlannedTask({
      estimated_duration: { expected: hugeMs, maximum: hugeMs },
      validation_budget: { expected: hugeMs, maximum: hugeMs },
      resource_envelope: {
        duration_ms: { expected: hugeMs, maximum: hugeMs },
        tokens: { expected: hugeMs, maximum: hugeMs },
        changed_files: { expected: 1_000_000, maximum: 1_000_000 },
      },
      validation: [{ argv: ['pnpm', 'test'], timeout_seconds: 86_400 }],
    });
    expect(PlannedTask.safeParse(task).success).toBe(true);
  });

  it('blocked_by aceita lista vazia (task sem dependências) e lista de ids', () => {
    expect(PlannedTask.safeParse(validPlannedTask({ blocked_by: [] })).success).toBe(true);
    expect(PlannedTask.safeParse(validPlannedTask({ blocked_by: ['M72'] })).success).toBe(true);
  });
});
