import { describe, expect, it } from 'vitest';

import { evaluateDecomposition, PlannedTask } from '../../src/planner/index.js';
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

  it('task curta com blast radius amplo é decomposta mesmo com duração pequena', () => {
    const task = coherentTask({
      estimated_duration: { expected: 60_000, maximum: 120_000 },
      resource_envelope: {
        duration_ms: { expected: 60_000, maximum: 120_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 40, maximum: 60 },
      },
    });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('wide_blast_radius_expected');
  });

  it('ambiguidade alta dispara decomposição', () => {
    const task = coherentTask({ taxonomy: validTaxonomy({ ambiguity: 'high' }) });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('high_ambiguity');
  });

  it('verificação subjetiva (impossibilidade de validação isolada objetiva) dispara decomposição', () => {
    const task = coherentTask({ taxonomy: validTaxonomy({ verification: 'subjective' }) });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('non_deterministic_verification');
  });

  it('contexto excessivo (áreas demais) dispara decomposição', () => {
    const task = coherentTask({
      context_scope: { areas: ['planner', 'harness', 'inspection', 'schemas', 'cli'] },
    });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('context_scope_too_broad');
  });

  it('complexidade cross_cutting cruza fronteiras de responsabilidade e dispara decomposição', () => {
    const task = coherentTask({ taxonomy: validTaxonomy({ complexity: 'cross_cutting' }) });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('cross_cutting_complexity');
  });

  it('dependências demais quebram isolamento de retry/rollback e disparam decomposição', () => {
    const task = coherentTask({ blocked_by: ['M71', 'M72', 'M73'] });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('excessive_dependencies');
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

  it('pressão de contexto/tokens excessiva dispara decomposição', () => {
    const task = coherentTask({
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 200_000, maximum: 400_000 },
        changed_files: { expected: 3, maximum: 10 },
      },
    });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('excessive_context_pressure');
  });

  it('custo de validação excessivo (comandos demais) dispara decomposição', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      argv: ['pnpm', 'run', `check-${i}`],
      timeout_seconds: 60,
    }));
    const task = coherentTask({ validation: many });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('excessive_validation_surface');
  });

  it('DECOMPOSITION_REQUIRED nomeia os sinais disparados com provenance rastreável', () => {
    const task = coherentTask({ taxonomy: validTaxonomy({ ambiguity: 'high' }) });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    if (verdict.outcome !== 'DECOMPOSITION_REQUIRED') throw new Error('unreachable');
    const signal = verdict.signals.find((s) => s.signal === 'high_ambiguity');
    expect(signal).toBeDefined();
    expect(signal?.reason).toBeTruthy();
    expect(signal?.provenance.field).toBe('taxonomy.ambiguity');
    expect(signal?.provenance.observed).toBe('high');
  });

  it('sinal ausente (campos opcionais de taxonomy não preenchidos) não é tratado como sinal favorável: não suprime outros sinais disparados', () => {
    const task = coherentTask({
      taxonomy: validTaxonomy(),
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 40, maximum: 60 },
      },
    });
    expect(task.taxonomy.complexity).toBeUndefined();
    expect(task.taxonomy.ambiguity).toBeUndefined();
    expect(task.taxonomy.verification).toBeUndefined();
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    expect(signalIds(verdict)).toContain('wide_blast_radius_expected');
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
      taxonomy: validTaxonomy({ ambiguity: 'high', verification: 'subjective' }),
    });
    const verdict = evaluateDecomposition(task);
    expect(verdict.outcome).toBe('DECOMPOSITION_REQUIRED');
    const ids = signalIds(verdict);
    expect(ids).toContain('high_ambiguity');
    expect(ids).toContain('non_deterministic_verification');
  });
});
