import { describe, expect, it } from 'vitest';

import {
  EMITTED_DECOMPOSITION_SIGNALS,
  evaluateDecomposition,
  PlannedTask,
} from '../../src/planner/index.js';
import { TaskTaxonomy } from '../../src/schemas/index.js';

function validTaxonomy(overrides: Partial<TaskTaxonomy> = {}): TaskTaxonomy {
  return {
    version: 1,
    task_class: 'feature',
    difficulty_declared: 'medium',
    ...overrides,
  };
}

function coherentTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'M74',
    objective: 'Implementar o motor de decomposição AVC',
    blocked_by: [],
    taxonomy: validTaxonomy(),
    risk: 'medium',
    acceptance: ['Função pura, determinística'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/planner/decomposition.ts'],
    probable_files: ['src/planner/index.ts'],
    context_scope: { areas: ['planner'] },
    context_requirements: [
      { description: 'entender PlannedTask', source_anchor: 'src/planner/task.ts' },
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

function signalIds(verdict: ReturnType<typeof evaluateDecomposition>): string[] {
  return verdict.outcome === 'DECOMPOSITION_REQUIRED' ? verdict.signals.map((s) => s.signal) : [];
}

describe('evaluateDecomposition', () => {
  it('é pura e determinística: a mesma task produz sempre o mesmo veredito', () => {
    const task = coherentTask();
    const first = evaluateDecomposition(task);
    const second = evaluateDecomposition(task);
    expect(first).toEqual(second);
  });

  it('task coerente e delimitada é ATOMIC', () => {
    const verdict = evaluateDecomposition(coherentTask());
    expect(verdict.outcome).toBe('ATOMIC');
  });

  it('não existe regra de duração absoluta: durações e timeouts arbitrariamente grandes não forçam decomposição', () => {
    const hugeMs = Number.MAX_SAFE_INTEGER;
    const task = coherentTask({
      estimated_duration: { expected: hugeMs, maximum: hugeMs },
      validation_budget: { expected: hugeMs, maximum: hugeMs },
      resource_envelope: {
        duration_ms: { expected: hugeMs, maximum: hugeMs },
        tokens: { expected: 1, maximum: 2 },
        changed_files: { expected: 1, maximum: 2 },
      },
      validation: [{ argv: ['pnpm', 'test'], timeout_seconds: 86_400 }],
    });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('task longa mas coerente e verificável isoladamente não é decomposta só por duração', () => {
    const task = coherentTask({
      estimated_duration: { expected: 8 * 60 * 60 * 1000, maximum: 24 * 60 * 60 * 1000 },
      resource_envelope: {
        duration_ms: { expected: 8 * 60 * 60 * 1000, maximum: 24 * 60 * 60 * 1000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 3, maximum: 10 },
      },
    });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('blast radius esperado alto, com risco médio, não é hard block: alimenta routing, não recusa a task', () => {
    const task = coherentTask({
      estimated_duration: { expected: 60_000, maximum: 120_000 },
      resource_envelope: {
        duration_ms: { expected: 60_000, maximum: 120_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 40, maximum: 60 },
      },
    });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('ambiguidade alta sozinha não é hard block', () => {
    const task = coherentTask({ taxonomy: validTaxonomy({ ambiguity: 'high' }) });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('verificação subjetiva sozinha não é hard block', () => {
    const task = coherentTask({ taxonomy: validTaxonomy({ verification: 'subjective' }) });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('context_scope acima de 3 áreas sozinho não é hard block', () => {
    const task = coherentTask({
      context_scope: { areas: ['planner', 'harness', 'inspection', 'schemas', 'cli'] },
    });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('complexidade cross_cutting sozinha não é hard block', () => {
    const task = coherentTask({ taxonomy: validTaxonomy({ complexity: 'cross_cutting' }) });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('mais de duas dependências sozinhas não são hard block', () => {
    const task = coherentTask({ blocked_by: ['M71', 'M72', 'M73'] });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('risco crítico com dependências não tem isolamento de retry', () => {
    const task = coherentTask({ risk: 'critical', blocked_by: ['M73'] });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('retry_not_isolated');
  });

  it('risco alto/crítico com superfície máxima de arquivos ampla não tem fronteira de rollback delimitada', () => {
    const task = coherentTask({
      risk: 'high',
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 5, maximum: 40 },
      },
    });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('unbounded_rollback_boundary');
  });

  it('risco médio com a mesma superfície máxima de arquivos não dispara a fronteira de rollback', () => {
    const task = coherentTask({
      risk: 'medium',
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 5, maximum: 40 },
      },
    });
    const verdict = evaluateDecomposition(task);
    expect(signalIds(verdict)).not.toContain('unbounded_rollback_boundary');
  });

  it('estimativa alta de tokens sozinha não é hard block', () => {
    const task = coherentTask({
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 200_000, maximum: 400_000 },
        changed_files: { expected: 3, maximum: 10 },
      },
    });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('muitos comandos de validação sozinhos não são hard block', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      argv: ['pnpm', 'run', `check-${i}`],
      timeout_seconds: 60,
    }));
    const task = coherentTask({ validation: many });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('vários sinais de complexidade ordinária somados continuam sem hard block', () => {
    const task = coherentTask({
      taxonomy: validTaxonomy({ complexity: 'cross_cutting', ambiguity: 'high', verification: 'subjective' }),
      blocked_by: ['M71', 'M72', 'M73'],
      context_scope: { areas: ['planner', 'harness', 'inspection', 'schemas', 'cli'] },
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 400_000, maximum: 900_000 },
        changed_files: { expected: 40, maximum: 60 },
      },
    });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('DECOMPOSITION_REQUIRED nomeia os sinais disparados com provenance rastreável', () => {
    const task = coherentTask({ risk: 'critical', blocked_by: ['M73'] });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    if (verdict.outcome !== 'DECOMPOSITION_REQUIRED') throw new Error('unreachable');
    const signal = verdict.signals.find((s) => s.signal === 'retry_not_isolated');
    expect(signal).toBeDefined();
    expect(signal?.reason).toBeTruthy();
    expect(signal?.provenance.field).toBe('risk,blocked_by');
  });

  it('só os sinais de fronteira de execução/rollback são emitidos', () => {
    expect([...EMITTED_DECOMPOSITION_SIGNALS].sort()).toEqual([
      'retry_not_isolated',
      'unbounded_rollback_boundary',
    ]);
  });

  it('taxonomy com campos opcionais ausentes, sem nenhum outro sinal, permanece ATOMIC (ausência não é decomposta por si só)', () => {
    const task = coherentTask({ taxonomy: validTaxonomy() });
    expect(task.taxonomy.complexity).toBeUndefined();
    expect(task.taxonomy.ambiguity).toBeUndefined();
    expect(task.taxonomy.verification).toBeUndefined();
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('não fragmenta artificialmente uma task pequena e coerente só por ter budget de tempo generoso', () => {
    const task = coherentTask({
      estimated_duration: { expected: 600_000, maximum: 48 * 60 * 60 * 1000 },
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 48 * 60 * 60 * 1000 },
        tokens: { expected: 1, maximum: 200_000 },
        changed_files: { expected: 1, maximum: 10 },
      },
    });
    expect(evaluateDecomposition(task).outcome).toBe('ATOMIC');
  });

  it('múltiplos sinais disparados aparecem todos no veredito', () => {
    const task = coherentTask({
      risk: 'critical',
      blocked_by: ['M73'],
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 5, maximum: 60 },
      },
    });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    const ids = signalIds(verdict);
    expect(ids).toContain('retry_not_isolated');
    expect(ids).toContain('unbounded_rollback_boundary');
  });
});
