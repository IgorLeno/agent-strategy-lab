/**
 * Comparação entre arms de um experimento a partir de `TaskPerformanceRecord`
 * (M46), um por trial. Só observações `QUALIFIED` entram no cálculo: uma
 * observação `UNSCORABLE`/`MISSCOPED`/`CONTAMINATED`/`INVALID_ENVIRONMENT`/
 * `HISTORICAL_ONLY` é contada em `excluded_non_qualified` mas nunca
 * participa de `pass_count`/`pass_rate`.
 *
 * O resultado é sempre por task PRIMEIRO (`per_task`), e só depois agregado
 * por arm (`aggregate`) — nunca o inverso, para que quem lê o resultado veja
 * a granularidade que sustenta o agregado antes do agregado em si.
 *
 * `final_pass` null (trial sem outcome resolvido) nunca vira fail: fica de
 * fora do denominador de `pass_rate`, preservando missing como missing em
 * vez de fabricar um valor. Da mesma forma, `human_intervention` null fica
 * fora do denominador de `human_intervention_rate`.
 *
 * Este módulo NUNCA computa confidence interval, p-value ou qualquer forma
 * de inferência estatística real — `posterior_counts` no agregado é só a
 * contagem bruta (pass/fail) por arm, matéria-prima para uma análise
 * bayesiana futura, não um resultado já inferido. Também não monta uma
 * Capability Matrix completa nem escolhe um arm vencedor automaticamente:
 * a leitura comparativa fica para quem consome este resultado.
 */
import { QualificationStatus } from '../core/enums.js';
import type { TaskPerformanceRecord } from '../schemas/performance.js';

/** Abaixo desta contagem de observações QUALIFIED, a comparação é sinalizada como N insuficiente. */
export const DEFAULT_MIN_QUALIFIED_N = 2;

/**
 * Uma observação de performance de UM trial, rotulada com o arm que a
 * produziu e a qualification_status do run/trial subjacente. A
 * qualification_status é fornecida pelo chamador (nunca inferida aqui):
 * este módulo só compara, não decide o que conta como qualificado.
 */
export interface TaskPerformanceObservation {
  readonly arm_id: string;
  readonly qualification_status: QualificationStatus;
  readonly performance: TaskPerformanceRecord;
}

export interface ArmTaskComparisonResult {
  readonly arm_id: string;
  /** Observações não-QUALIFIED para este arm/task — excluídas do cálculo abaixo, nunca descartadas silenciosamente. */
  readonly excluded_non_qualified: number;
  readonly qualified_n: number;
  /** null quando nenhuma observação QUALIFIED tem final_pass resolvido (missing preservado). */
  readonly pass_count: number | null;
  readonly fail_count: number | null;
  readonly pass_rate: number | null;
  readonly human_intervention_count: number | null;
  readonly human_intervention_rate: number | null;
  /** true quando qualified_n < minQualifiedN — a comparação para este arm/task não tem evidência suficiente. */
  readonly insufficient_n: boolean;
}

export interface TaskComparisonResult {
  readonly task_id: string;
  readonly arms: readonly ArmTaskComparisonResult[];
  /** true quando QUALQUER arm deste task está com insufficient_n. */
  readonly insufficient_n: boolean;
}

/** Contagem bruta pass/fail por arm, agregada por todos os tasks — matéria-prima para inferência futura, não um resultado inferido. */
export interface ArmPosteriorCounts {
  readonly pass: number;
  readonly fail: number;
}

export interface ArmAggregateResult {
  readonly arm_id: string;
  readonly tasks_compared: number;
  readonly tasks_insufficient_n: number;
  readonly total_qualified_n: number;
  readonly total_excluded_non_qualified: number;
  readonly posterior_counts: ArmPosteriorCounts;
}

export interface CompareResult {
  readonly per_task: readonly TaskComparisonResult[];
  readonly aggregate: readonly ArmAggregateResult[];
}

export interface CompareOptions {
  /** @default DEFAULT_MIN_QUALIFIED_N */
  readonly minQualifiedN?: number;
}

function compareArmStats(
  observations: readonly TaskPerformanceObservation[],
  minQualifiedN: number,
): ArmTaskComparisonResult {
  const armId = observations[0]!.arm_id;
  const qualified = observations.filter(
    (observation) => observation.qualification_status === QualificationStatus.QUALIFIED,
  );
  const excludedNonQualified = observations.length - qualified.length;

  let passCount = 0;
  let passKnown = 0;
  let interventionCount = 0;
  let interventionKnown = 0;

  for (const observation of qualified) {
    const finalPass = observation.performance.success.final_pass;
    if (finalPass !== null) {
      passKnown += 1;
      if (finalPass) passCount += 1;
    }

    const humanIntervention = observation.performance.intervention.human_intervention.value;
    if (humanIntervention !== null) {
      interventionKnown += 1;
      if (humanIntervention) interventionCount += 1;
    }
  }

  return {
    arm_id: armId,
    excluded_non_qualified: excludedNonQualified,
    qualified_n: qualified.length,
    pass_count: passKnown === 0 ? null : passCount,
    fail_count: passKnown === 0 ? null : passKnown - passCount,
    pass_rate: passKnown === 0 ? null : passCount / passKnown,
    human_intervention_count: interventionKnown === 0 ? null : interventionCount,
    human_intervention_rate: interventionKnown === 0 ? null : interventionCount / interventionKnown,
    insufficient_n: qualified.length < minQualifiedN,
  };
}

/**
 * Compara `TaskPerformanceRecord`s entre arms, produzindo o resultado por
 * task antes do agregado por arm. Função pura e determinística: mesma
 * entrada (mesma ordem ou não — `per_task`/`arms` saem sempre ordenados por
 * id) produz sempre a mesma saída.
 */
export function compareTaskPerformance(
  observations: readonly TaskPerformanceObservation[],
  options: CompareOptions = {},
): CompareResult {
  const minQualifiedN = options.minQualifiedN ?? DEFAULT_MIN_QUALIFIED_N;

  const byTask = new Map<string, TaskPerformanceObservation[]>();
  const armIds = new Set<string>();
  for (const observation of observations) {
    const taskId = observation.performance.task_id;
    armIds.add(observation.arm_id);
    const bucket = byTask.get(taskId);
    if (bucket) {
      bucket.push(observation);
    } else {
      byTask.set(taskId, [observation]);
    }
  }

  const sortedArmIds = Array.from(armIds).sort();
  const sortedTaskIds = Array.from(byTask.keys()).sort();

  const perTask: TaskComparisonResult[] = sortedTaskIds.map((taskId) => {
    const taskObservations = byTask.get(taskId)!;
    const byArm = new Map<string, TaskPerformanceObservation[]>();
    for (const observation of taskObservations) {
      const bucket = byArm.get(observation.arm_id);
      if (bucket) {
        bucket.push(observation);
      } else {
        byArm.set(observation.arm_id, [observation]);
      }
    }

    const arms = sortedArmIds
      .filter((armId) => byArm.has(armId))
      .map((armId) => compareArmStats(byArm.get(armId)!, minQualifiedN));

    return {
      task_id: taskId,
      arms,
      insufficient_n: arms.some((arm) => arm.insufficient_n),
    };
  });

  const aggregate: ArmAggregateResult[] = sortedArmIds.map((armId) => {
    let tasksCompared = 0;
    let tasksInsufficientN = 0;
    let totalQualifiedN = 0;
    let totalExcludedNonQualified = 0;
    let posteriorPass = 0;
    let posteriorFail = 0;

    for (const task of perTask) {
      const arm = task.arms.find((entry) => entry.arm_id === armId);
      if (!arm) continue;

      tasksCompared += 1;
      if (arm.insufficient_n) tasksInsufficientN += 1;
      totalQualifiedN += arm.qualified_n;
      totalExcludedNonQualified += arm.excluded_non_qualified;
      if (arm.pass_count !== null && arm.fail_count !== null) {
        posteriorPass += arm.pass_count;
        posteriorFail += arm.fail_count;
      }
    }

    return {
      arm_id: armId,
      tasks_compared: tasksCompared,
      tasks_insufficient_n: tasksInsufficientN,
      total_qualified_n: totalQualifiedN,
      total_excluded_non_qualified: totalExcludedNonQualified,
      posterior_counts: { pass: posteriorPass, fail: posteriorFail },
    };
  });

  return { per_task: perTask, aggregate };
}
