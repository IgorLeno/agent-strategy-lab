/**
 * PREVISÃO de runtime do PLANO INTEIRO.
 *
 * Mesma regra do `ExecutionRuntimeForecast` de uma work unit, um nível acima:
 * `authority: 'ADVISORY'` está no CONTRATO, não só no comentário. Este objeto
 * existe para ser MOSTRADO a um humano e comparado depois com o tempo
 * observado. Ele não roteia, não encerra, não define timeout, não escala e não
 * rejeita nada — nenhum consumidor pode derivar autorização daqui.
 *
 * Também não existe countdown autoritativo: `remainingPlanRuntimeMs` é a soma
 * das ESTIMATIVAS INICIAIS das tasks ainda não concluídas, e não uma subtração
 * do relógio. Ele nunca chega a zero por passagem de tempo, só por tasks
 * concluídas — que é exatamente a diferença entre uma projeção e um deadline.
 *
 * Task sem estimativa disponível permanece UNKNOWN: ela contribui zero para a
 * soma e é NOMEADA em `tasks_without_estimate`, para que um total menor nunca
 * seja lido como "estimativa completa e otimista".
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');

export const PlanTaskRuntimeEstimate = z
  .object({
    task_id: identifier,
    /** `null` é UNKNOWN observado, nunca zero inventado. */
    estimated_duration_ms: z.number().int().nonnegative().nullable(),
    provenance: nonEmpty,
  })
  .strict();
export type PlanTaskRuntimeEstimate = z.infer<typeof PlanTaskRuntimeEstimate>;

export const PlanRuntimeForecast = z
  .object({
    kind: z.literal('PLAN_RUNTIME_FORECAST'),
    authority: z.literal('ADVISORY'),
    initial_total_ms: z.number().int().nonnegative(),
    task_estimates: z.array(PlanTaskRuntimeEstimate).min(1),
    /** Tasks cuja estimativa é UNKNOWN; o total não as inclui. */
    tasks_without_estimate: z.array(identifier),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type PlanRuntimeForecast = z.infer<typeof PlanRuntimeForecast>;

export interface PlanRuntimeForecastTaskInput {
  readonly task_id: string;
  /** `null`/ausente quando o plano não declara envelope de duração. */
  readonly estimated_duration_ms?: number | null;
  readonly provenance?: string;
}

const UNKNOWN_PROVENANCE = 'plano não declara envelope de duração para esta task (UNKNOWN)';

/**
 * Derivação DETERMINÍSTICA: mesma lista de tasks, mesmo forecast. Nenhuma
 * heurística, nenhum relógio, nenhum histórico — só as estimativas que o plano
 * já carrega, somadas na ordem declarada.
 */
export function planRuntimeForecast(
  tasks: readonly PlanRuntimeForecastTaskInput[],
): PlanRuntimeForecast {
  const estimates = tasks.map((task) => {
    const value = task.estimated_duration_ms;
    const known = typeof value === 'number' && Number.isInteger(value) && value >= 0;
    return PlanTaskRuntimeEstimate.parse({
      task_id: task.task_id,
      estimated_duration_ms: known ? value : null,
      provenance: known ? (task.provenance ?? 'plan task envelope') : UNKNOWN_PROVENANCE,
    });
  });
  return PlanRuntimeForecast.parse({
    kind: 'PLAN_RUNTIME_FORECAST',
    authority: 'ADVISORY',
    initial_total_ms: estimates.reduce((total, entry) => total + (entry.estimated_duration_ms ?? 0), 0),
    task_estimates: estimates,
    tasks_without_estimate: estimates
      .filter((entry) => entry.estimated_duration_ms === null)
      .map((entry) => entry.task_id),
    provenance: [
      'soma determinística das estimativas iniciais declaradas pelo plano',
      'ADVISORY: projeção para leitura humana; não roteia, não encerra, não define timeout e não rejeita nada',
    ],
  });
}

/**
 * Estimativa RESTANTE: soma das estimativas INICIAIS das tasks ainda não
 * concluídas. O tempo já gasto não entra na conta — encolher a previsão porque
 * o relógio andou seria transformá-la em countdown, e countdown é a forma que
 * uma previsão assume quando começa a ter autoridade.
 */
export function remainingPlanRuntimeMs(
  forecast: PlanRuntimeForecast,
  completedTaskIds: ReadonlySet<string>,
): number {
  return forecast.task_estimates
    .filter((entry) => !completedTaskIds.has(entry.task_id))
    .reduce((total, entry) => total + (entry.estimated_duration_ms ?? 0), 0);
}
