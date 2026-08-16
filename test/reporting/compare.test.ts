import { describe, expect, it } from 'vitest';

import { QualificationStatus } from '../../src/core/index.js';
import {
  DEFAULT_MIN_QUALIFIED_N,
  compareTaskPerformance,
  type TaskPerformanceObservation,
} from '../../src/reporting/index.js';
import type { TaskPerformanceRecord } from '../../src/schemas/index.js';

function taskRecord(overrides: {
  task_id: string;
  trial_id: string;
  final_pass: boolean | null;
  human_intervention: boolean | null;
}): TaskPerformanceRecord {
  return {
    schema_version: 1,
    task_id: overrides.task_id,
    trial_id: overrides.trial_id,
    attempts: {
      operational_attempts: 1,
      attempts_with_inference: 1,
      attempts_without_inference: 0,
      attempts_inference_unknown: 0,
      infra_error_attempts: 0,
      repair_attempts: 0,
      escalations: 0,
      attempts_role_unknown: 0,
    },
    success: {
      first_operational_pass: overrides.final_pass,
      first_inference_bearing_pass: overrides.final_pass,
      autonomous_first_pass:
        overrides.human_intervention === false ? overrides.final_pass : null,
      final_pass: overrides.final_pass,
    },
    intervention: {
      human_intervention: {
        value: overrides.human_intervention,
        provenance: overrides.human_intervention === null ? 'not_recorded' : 'intervention_log',
      },
      intervention_types: [],
    },
  };
}

function observation(
  armId: string,
  taskId: string,
  trialId: string,
  finalPass: boolean | null,
  qualification: QualificationStatus = QualificationStatus.QUALIFIED,
  humanIntervention: boolean | null = false,
): TaskPerformanceObservation {
  return {
    arm_id: armId,
    qualification_status: qualification,
    performance: taskRecord({
      task_id: taskId,
      trial_id: trialId,
      final_pass: finalPass,
      human_intervention: humanIntervention,
    }),
  };
}

describe('compareTaskPerformance', () => {
  it('produz resultado por task antes do agregado, ordenado por task_id e arm_id', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-b', 'trial-1', true),
      observation('high', 'task-b', 'trial-2', true),
      observation('medium', 'task-b', 'trial-3', false),
      observation('medium', 'task-b', 'trial-4', false),
      observation('high', 'task-a', 'trial-5', true),
      observation('high', 'task-a', 'trial-6', false),
      observation('medium', 'task-a', 'trial-7', true),
      observation('medium', 'task-a', 'trial-8', true),
    ];

    const result = compareTaskPerformance(observations);

    expect(result.per_task.map((task) => task.task_id)).toEqual(['task-a', 'task-b']);
    expect(result.per_task[0]!.arms.map((arm) => arm.arm_id)).toEqual(['high', 'medium']);

    const taskA = result.per_task[0]!;
    const highOnA = taskA.arms.find((arm) => arm.arm_id === 'high')!;
    expect(highOnA.qualified_n).toBe(2);
    expect(highOnA.pass_count).toBe(1);
    expect(highOnA.fail_count).toBe(1);
    expect(highOnA.pass_rate).toBe(0.5);
    expect(highOnA.insufficient_n).toBe(false);

    const mediumOnA = taskA.arms.find((arm) => arm.arm_id === 'medium')!;
    expect(mediumOnA.pass_count).toBe(2);
    expect(mediumOnA.pass_rate).toBe(1);

    expect(result.aggregate.map((arm) => arm.arm_id)).toEqual(['high', 'medium']);
  });

  it('exclui observações não-QUALIFIED do cálculo, mas registra a exclusão', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-a', 'trial-1', true, QualificationStatus.QUALIFIED),
      observation('high', 'task-a', 'trial-2', true, QualificationStatus.UNSCORABLE),
      observation('high', 'task-a', 'trial-3', false, QualificationStatus.CONTAMINATED),
    ];

    const result = compareTaskPerformance(observations);
    const highOnA = result.per_task[0]!.arms[0]!;

    expect(highOnA.qualified_n).toBe(1);
    expect(highOnA.excluded_non_qualified).toBe(2);
    expect(highOnA.pass_count).toBe(1);
    expect(highOnA.pass_rate).toBe(1);
  });

  it('preserva final_pass ausente como null em vez de contar como fail', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-a', 'trial-1', null),
      observation('high', 'task-a', 'trial-2', null),
    ];

    const result = compareTaskPerformance(observations);
    const highOnA = result.per_task[0]!.arms[0]!;

    expect(highOnA.qualified_n).toBe(2);
    expect(highOnA.pass_count).toBeNull();
    expect(highOnA.fail_count).toBeNull();
    expect(highOnA.pass_rate).toBeNull();
  });

  it('preserva human_intervention ausente como null', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-a', 'trial-1', true, QualificationStatus.QUALIFIED, null),
      observation('high', 'task-a', 'trial-2', true, QualificationStatus.QUALIFIED, null),
    ];

    const result = compareTaskPerformance(observations);
    const highOnA = result.per_task[0]!.arms[0]!;

    expect(highOnA.human_intervention_count).toBeNull();
    expect(highOnA.human_intervention_rate).toBeNull();
  });

  it('sinaliza N insuficiente explicitamente quando qualified_n fica abaixo do mínimo', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-a', 'trial-1', true),
      observation('medium', 'task-a', 'trial-2', true),
      observation('medium', 'task-a', 'trial-3', true),
    ];

    const result = compareTaskPerformance(observations);
    const taskA = result.per_task[0]!;
    const highOnA = taskA.arms.find((arm) => arm.arm_id === 'high')!;
    const mediumOnA = taskA.arms.find((arm) => arm.arm_id === 'medium')!;

    expect(highOnA.qualified_n).toBe(1);
    expect(highOnA.insufficient_n).toBe(true);
    expect(mediumOnA.insufficient_n).toBe(false);
    expect(taskA.insufficient_n).toBe(true);

    const highAggregate = result.aggregate.find((arm) => arm.arm_id === 'high')!;
    expect(highAggregate.tasks_insufficient_n).toBe(1);
  });

  it('respeita minQualifiedN customizado', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-a', 'trial-1', true),
      observation('high', 'task-a', 'trial-2', true),
      observation('high', 'task-a', 'trial-3', true),
    ];

    const strict = compareTaskPerformance(observations, { minQualifiedN: 5 });
    expect(strict.per_task[0]!.arms[0]!.insufficient_n).toBe(true);

    const lenient = compareTaskPerformance(observations, { minQualifiedN: 1 });
    expect(lenient.per_task[0]!.arms[0]!.insufficient_n).toBe(false);
  });

  it('usa DEFAULT_MIN_QUALIFIED_N quando nenhuma opção é fornecida', () => {
    expect(DEFAULT_MIN_QUALIFIED_N).toBeGreaterThan(0);

    const observations: TaskPerformanceObservation[] = Array.from(
      { length: DEFAULT_MIN_QUALIFIED_N },
      (_unused, index) => observation('high', 'task-a', `trial-${index}`, true),
    );

    const result = compareTaskPerformance(observations);
    expect(result.per_task[0]!.arms[0]!.insufficient_n).toBe(false);
  });

  it('agrega posterior_counts (pass/fail bruto) somando todos os tasks de um arm', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-a', 'trial-1', true),
      observation('high', 'task-a', 'trial-2', false),
      observation('high', 'task-b', 'trial-3', true),
      observation('high', 'task-b', 'trial-4', true),
    ];

    const result = compareTaskPerformance(observations);
    const highAggregate = result.aggregate.find((arm) => arm.arm_id === 'high')!;

    expect(highAggregate.posterior_counts).toEqual({ pass: 3, fail: 1 });
    expect(highAggregate.tasks_compared).toBe(2);
    expect(highAggregate.total_qualified_n).toBe(4);
  });

  it('não fabrica confidence interval, matriz de capability nem vencedor automático', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('high', 'task-a', 'trial-1', true),
      observation('high', 'task-a', 'trial-2', true),
      observation('medium', 'task-a', 'trial-3', false),
      observation('medium', 'task-a', 'trial-4', false),
    ];

    const result = compareTaskPerformance(observations);

    for (const arm of result.aggregate) {
      expect(arm).not.toHaveProperty('confidence_interval');
      expect(arm).not.toHaveProperty('winner');
      expect(arm).not.toHaveProperty('capability_matrix');
    }
    expect(result).not.toHaveProperty('winner');
    expect(result).not.toHaveProperty('capability_matrix');
  });

  it('é determinístico: mesma entrada produz sempre a mesma saída, independente da ordem de entrada', () => {
    const observations: TaskPerformanceObservation[] = [
      observation('medium', 'task-b', 'trial-4', false),
      observation('high', 'task-a', 'trial-1', true),
      observation('high', 'task-b', 'trial-3', true),
      observation('medium', 'task-a', 'trial-2', true),
    ];
    const shuffled = [...observations].reverse();

    expect(compareTaskPerformance(observations)).toEqual(compareTaskPerformance(shuffled));
  });

  it('retorna listas vazias para entrada vazia', () => {
    const result = compareTaskPerformance([]);
    expect(result.per_task).toEqual([]);
    expect(result.aggregate).toEqual([]);
  });
});
