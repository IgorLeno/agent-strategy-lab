import { BLOCKING_STATUSES, type DevelopmentState, type PlanTask, type TaskState } from './schemas.js';
import type { LoadedPlan } from './plan.js';

export type SelectionStatus = 'SELECTED' | 'ALL_DONE' | 'BUSY' | 'BLOCKED' | 'HALTED';

export interface Selection {
  readonly status: SelectionStatus;
  readonly reason: string;
  readonly task: PlanTask | null;
  /** Dependência PASS mais recente — origem do handoff anterior, quando pedido. */
  readonly handoffSourceTaskId: string | null;
}

function stateOf(state: DevelopmentState, id: string): TaskState | undefined {
  return state.tasks.find((task) => task.id === id);
}

/**
 * Seleção pura: mesmo plano + mesmo estado sempre produzem a mesma escolha.
 * Não toca em disco — a decisão precisa ser inspecionável e testável isolada.
 */
export function selectNextTask(loaded: LoadedPlan, state: DevelopmentState): Selection {
  const halted = state.tasks.find((task) => BLOCKING_STATUSES.includes(task.status));
  if (halted) {
    return {
      status: 'HALTED',
      reason: `${halted.id} está ${halted.status} — o fluxo para até intervenção humana`,
      task: null,
      handoffSourceTaskId: null,
    };
  }

  const running = state.tasks.find((task) => task.status === 'RUNNING');
  if (running) {
    return {
      status: 'BUSY',
      reason: `${running.id} está RUNNING/${running.phase} — feche-a antes de selecionar a próxima`,
      task: null,
      handoffSourceTaskId: null,
    };
  }

  const pending = loaded.plan.tasks.filter((task) => stateOf(state, task.id)?.status === 'READY');
  if (pending.length === 0) {
    return { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente', task: null, handoffSourceTaskId: null };
  }

  const eligible = pending.find((task) =>
    task.blocked_by.every((dependency) => stateOf(state, dependency)?.status === 'PASS'),
  );
  if (!eligible) {
    return {
      status: 'BLOCKED',
      reason: `nenhuma pendente com dependências PASS (${pending.map((task) => task.id).join(', ')})`,
      task: null,
      handoffSourceTaskId: null,
    };
  }

  // Handoff anterior = última dependência declarada que passou; sem dependência,
  // a última tarefa PASS na ordem do plano.
  const passedInPlanOrder = loaded.plan.tasks
    .map((task) => task.id)
    .filter((id) => stateOf(state, id)?.status === 'PASS');
  const handoffSourceTaskId =
    eligible.blocked_by.length > 0
      ? (eligible.blocked_by[eligible.blocked_by.length - 1] as string)
      : (passedInPlanOrder[passedInPlanOrder.length - 1] ?? null);

  return {
    status: 'SELECTED',
    reason: `${eligible.id} pronta`,
    task: eligible,
    handoffSourceTaskId,
  };
}
