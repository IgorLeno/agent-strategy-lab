/**
 * PROJEÇÃO read-only do lifecycle.
 *
 * Um redutor puro de `LabProgressEvent` para um snapshot legível. Ele não
 * conhece filesystem, state, plano, provider nem git: as únicas entradas são
 * os eventos semânticos que o control plane e o loop já emitem, mais um
 * relógio injetável. Nada aqui pode alterar o lifecycle — não há o que
 * alterar a partir daqui, e é essa ausência de acesso, não uma convenção, que
 * torna a TUI incapaz de virar autoridade.
 *
 * Duração de task é OBSERVADA por este relógio, e não copiada de um record
 * autoritativo; quando o emissor conhece a duração medida do worker, ela
 * sobrescreve a observação. Ausência permanece `null`, nunca zero.
 */
import {
  planRuntimeForecast,
  remainingPlanRuntimeMs,
  type PlanRuntimeForecast,
} from '../../src/planner/plan-forecast.js';
import type {
  LabProgressEvent,
  LabProgressListener,
  LabProgressQuota,
  LabProgressStage,
} from './lab-progress.js';

export const LAB_TASK_STATES = [
  'PENDING',
  'RUNNING',
  'VALIDATING',
  'ACCEPTED',
  'REPAIR',
  'ESCALATED',
  'FAILED',
  'HUMAN_REQUIRED',
] as const;
export type LabTaskState = (typeof LAB_TASK_STATES)[number];

export interface LabTaskProjection {
  readonly index: number;
  readonly task_id: string;
  readonly title: string;
  readonly state: LabTaskState;
  /** Estimativa inicial ADVISORY; `null` é UNKNOWN. */
  readonly estimated_duration_ms: number | null;
  readonly attempts: number;
  readonly repairs: number;
  readonly escalations: number;
  /** `null` enquanto a task não concluiu; nunca "assumido first pass". */
  readonly first_pass: boolean | null;
  readonly duration_ms: number | null;
  /** Tempo corrido do attempt em curso; `null` quando nada está rodando. */
  readonly running_elapsed_ms: number | null;
  readonly profile_id: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly reasoning_effort: string | null;
  readonly escalated_from_profile_id: string | null;
  readonly close_kind: string | null;
}

export interface LabProviderProjection {
  readonly provider: string;
  readonly launches: number;
  /** Soma das durações OBSERVADAS dos workers desse provider. */
  readonly worker_time_ms: number;
  readonly quota: LabProgressQuota;
}

/**
 * Capacidade por POOL DE QUOTA. Separado de `LabProviderProjection` porque
 * capacidade e origem do trabalho são perguntas distintas: dois providers
 * podem consumir a mesma franquia, e uma linha por provider descreveria duas
 * reservas onde existe uma.
 */
export interface LabPoolProjection {
  readonly quota_pool: string;
  readonly quota: LabProgressQuota;
  /** Perfis que consumiram deste pool nesta run — a prova do compartilhamento. */
  readonly profiles: readonly string[];
}

export interface LabDeliberationTurnProjection {
  readonly turn: number;
  readonly profile_id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly decision: 'ACCEPT' | 'REVISE';
}

export interface LabDeliberationProjection {
  readonly max_turns: number;
  readonly turns: readonly LabDeliberationTurnProjection[];
  readonly converged: boolean;
  readonly converged_at_turn: number | null;
}

export interface LabRunProjection {
  readonly stage: LabProgressStage;
  readonly detail: string | null;
  readonly elapsed_ms: number;
  readonly plan_origin: 'GENERATED' | 'REUSED' | 'PLAN_FILE' | null;
  readonly tasks: readonly LabTaskProjection[];
  readonly completed_count: number;
  /** ADVISORY sempre; `null` antes de o plano ficar pronto. */
  readonly forecast: PlanRuntimeForecast | null;
  readonly remaining_estimate_ms: number | null;
  readonly providers: readonly LabProviderProjection[];
  readonly pools: readonly LabPoolProjection[];
  readonly deliberation: LabDeliberationProjection | null;
  readonly terminal: 'ALL_DONE' | 'HUMAN_REQUIRED' | 'FAILURE' | null;
}

interface MutableTask {
  index: number;
  task_id: string;
  title: string;
  state: LabTaskState;
  estimated_duration_ms: number | null;
  attempts: number;
  repairs: number;
  escalations: number;
  first_pass: boolean | null;
  duration_ms: number | null;
  observed_started_at: number | null;
  profile_id: string | null;
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
  escalated_from_profile_id: string | null;
  close_kind: string | null;
  /**
   * Papel anunciado para o PRÓXIMO launch desta task. Repair e escalation são
   * anunciados por dois emissores independentes (o loop e o control plane);
   * contar no anúncio contaria duas vezes o mesmo attempt. Contar no launch
   * conta exatamente uma vez, com ou sem control plane presente.
   */
  pending_role: 'repair' | 'escalation' | null;
}

interface MutablePool {
  quota_pool: string;
  quota: LabProgressQuota;
  profiles: string[];
}

interface MutableProvider {
  provider: string;
  launches: number;
  worker_time_ms: number;
  quota: LabProgressQuota;
}

const TERMINAL_STATES: ReadonlySet<LabTaskState> = new Set<LabTaskState>(['ACCEPTED']);

function emptyTask(index: number, task_id: string, title: string, estimate: number | null): MutableTask {
  return {
    index,
    task_id,
    title,
    state: 'PENDING',
    estimated_duration_ms: estimate,
    attempts: 0,
    repairs: 0,
    escalations: 0,
    first_pass: null,
    duration_ms: null,
    observed_started_at: null,
    profile_id: null,
    provider: null,
    model: null,
    reasoning_effort: null,
    escalated_from_profile_id: null,
    close_kind: null,
    pending_role: null,
  };
}

export interface LabProjectionPort {
  readonly listener: LabProgressListener;
  snapshot(): LabRunProjection;
}

/**
 * Cria a projeção e o listener que a alimenta. O listener devolvido é a ÚNICA
 * superfície de escrita: ele aceita evento e não devolve nada.
 */
export function createLabProjection(now: () => number = Date.now): LabProjectionPort {
  const startedAt = now();
  const tasks: MutableTask[] = [];
  const byId = new Map<string, MutableTask>();
  const providers = new Map<string, MutableProvider>();
  const pools = new Map<string, MutablePool>();
  let forecast: PlanRuntimeForecast | null = null;
  let planOrigin: LabRunProjection['plan_origin'] = null;
  let stage: LabProgressStage = 'PREFLIGHT';
  let detail: string | null = null;
  let terminal: LabRunProjection['terminal'] = null;
  let deliberationMaxTurns = 0;
  const deliberationTurns: LabDeliberationTurnProjection[] = [];
  let convergedAtTurn: number | null = null;

  /**
   * Task fora do plano declarado ainda é projetada: a alternativa seria a
   * interface esconder trabalho que está realmente acontecendo.
   */
  function taskOf(taskId: string): MutableTask {
    const existing = byId.get(taskId);
    if (existing !== undefined) return existing;
    const created = emptyTask(tasks.length + 1, taskId, taskId, null);
    tasks.push(created);
    byId.set(taskId, created);
    return created;
  }

  function poolOf(name: string): MutablePool {
    const existing = pools.get(name);
    if (existing !== undefined) return existing;
    const created: MutablePool = {
      quota_pool: name,
      quota: { status: 'UNKNOWN', reason: 'nenhuma observação de capacidade deste pool nesta run' },
      profiles: [],
    };
    pools.set(name, created);
    return created;
  }

  function providerOf(name: string): MutableProvider {
    const existing = providers.get(name);
    if (existing !== undefined) return existing;
    const created: MutableProvider = {
      provider: name,
      launches: 0,
      worker_time_ms: 0,
      quota: { status: 'UNKNOWN', reason: 'nenhuma observação de quota deste provider nesta run' },
    };
    providers.set(name, created);
    return created;
  }

  function finish(task: MutableTask, state: LabTaskState, observedNow: number): void {
    task.state = state;
    if (task.duration_ms === null && task.observed_started_at !== null) {
      task.duration_ms = Math.max(0, observedNow - task.observed_started_at);
    }
    if (state === 'ACCEPTED') task.first_pass = task.repairs === 0 && task.escalations === 0;
  }

  const listener: LabProgressListener = (event: LabProgressEvent) => {
    const observedNow = now();
    stage = event.stage;
    detail = event.detail ?? null;

    if (event.plan !== undefined) {
      planOrigin = event.plan.origin;
      for (const declared of event.plan.tasks) {
        const existing = byId.get(declared.task_id);
        if (existing === undefined) {
          const created = emptyTask(
            tasks.length + 1,
            declared.task_id,
            declared.title,
            declared.estimated_duration_ms,
          );
          tasks.push(created);
          byId.set(declared.task_id, created);
          continue;
        }
        existing.title = declared.title;
        existing.estimated_duration_ms = declared.estimated_duration_ms;
      }
      forecast = planRuntimeForecast(
        event.plan.tasks.map((declared) => ({
          task_id: declared.task_id,
          estimated_duration_ms: declared.estimated_duration_ms,
          provenance: 'plan task planner_metadata.resource_envelope.duration_ms.expected',
        })),
      );
    }

    if (event.deliberation !== undefined) {
      const turn = event.deliberation;
      deliberationMaxTurns = Math.max(deliberationMaxTurns, turn.max_turns);
      deliberationTurns.push({
        turn: turn.turn,
        profile_id: turn.profile_id,
        provider: turn.provider,
        model: turn.model,
        decision: turn.decision,
      });
      if (turn.converged) convergedAtTurn = turn.turn;
    }

    const observed = event.task;
    if (observed !== undefined) {
      const task = taskOf(observed.task_id);
      if (observed.profile_id !== undefined) task.profile_id = observed.profile_id;
      if (observed.provider !== undefined) task.provider = observed.provider;
      if (observed.model !== undefined) task.model = observed.model;
      if (observed.reasoning_effort !== undefined) task.reasoning_effort = observed.reasoning_effort;
      if (observed.escalated_from_profile_id !== undefined) {
        task.escalated_from_profile_id = observed.escalated_from_profile_id;
      }
      if (observed.close_kind !== undefined) task.close_kind = observed.close_kind;

      switch (event.stage) {
        case 'ROUTED': {
          if (observed.attempt_role === 'repair' || observed.attempt_role === 'escalation') {
            task.pending_role = observed.attempt_role;
          }
          if (observed.attempt_role === 'escalation') task.state = 'ESCALATED';
          break;
        }
        case 'WORKER_RUNNING': {
          if (observed.attempt_role === 'repair' || observed.attempt_role === 'escalation') {
            task.pending_role = observed.attempt_role;
          }
          if (task.pending_role === 'repair') task.repairs += 1;
          if (task.pending_role === 'escalation') task.escalations += 1;
          task.pending_role = null;
          task.attempts = observed.attempt ?? task.attempts + 1;
          task.state = 'RUNNING';
          task.observed_started_at = observedNow;
          task.duration_ms = null;
          if (task.provider !== null) providerOf(task.provider).launches += 1;
          break;
        }
        case 'VALIDATING': {
          if (task.duration_ms === null && task.observed_started_at !== null) {
            task.duration_ms = Math.max(0, observedNow - task.observed_started_at);
          }
          task.state = 'VALIDATING';
          break;
        }
        case 'REPAIR': {
          task.pending_role = 'repair';
          task.state = 'REPAIR';
          break;
        }
        case 'TASK_ACCEPTED': {
          finish(task, 'ACCEPTED', observedNow);
          break;
        }
        case 'TASK_FAILED': {
          finish(task, 'FAILED', observedNow);
          break;
        }
        case 'HUMAN_REQUIRED': {
          finish(task, 'HUMAN_REQUIRED', observedNow);
          break;
        }
        default:
          break;
      }

      // Duração MEDIDA pelo emissor tem precedência sobre a observada aqui.
      if (observed.duration_ms !== undefined && observed.duration_ms !== null) {
        task.duration_ms = observed.duration_ms;
      }
      // A capacidade é atribuída ao POOL, não ao provider: é o pool que tem
      // franquia. Quando o emissor não informa o pool, o provider é usado como
      // chave — degradação honesta, que nunca funde dois providers distintos.
      if (observed.quota !== undefined) {
        const poolKey = observed.quota_pool ?? task.provider;
        if (poolKey !== null && poolKey !== undefined) {
          const pool = poolOf(poolKey);
          pool.quota = observed.quota;
          if (task.profile_id !== null && !pool.profiles.includes(task.profile_id)) {
            pool.profiles.push(task.profile_id);
          }
        }
      }
      if (task.provider !== null) {
        const provider = providerOf(task.provider);
        if (observed.quota !== undefined) provider.quota = observed.quota;
        if (
          (event.stage === 'TASK_ACCEPTED' || event.stage === 'TASK_FAILED') &&
          task.duration_ms !== null
        ) {
          provider.worker_time_ms += task.duration_ms;
        }
      }
    }

    if (event.stage === 'ALL_DONE') terminal = 'ALL_DONE';
    if (event.stage === 'HUMAN_REQUIRED') terminal = 'HUMAN_REQUIRED';
    if (event.stage === 'FAILURE') terminal = 'FAILURE';
  };

  function snapshot(): LabRunProjection {
    const completed = tasks.filter((task) => TERMINAL_STATES.has(task.state));
    const completedIds = new Set(completed.map((task) => task.task_id));
    return {
      stage,
      detail,
      elapsed_ms: Math.max(0, now() - startedAt),
      plan_origin: planOrigin,
      tasks: tasks.map((task) => ({
        index: task.index,
        task_id: task.task_id,
        title: task.title,
        state: task.state,
        estimated_duration_ms: task.estimated_duration_ms,
        attempts: task.attempts,
        repairs: task.repairs,
        escalations: task.escalations,
        first_pass: task.first_pass,
        duration_ms: task.duration_ms,
        running_elapsed_ms:
          (task.state === 'RUNNING' || task.state === 'VALIDATING') && task.observed_started_at !== null
            ? Math.max(0, now() - task.observed_started_at)
            : null,
        profile_id: task.profile_id,
        provider: task.provider,
        model: task.model,
        reasoning_effort: task.reasoning_effort,
        escalated_from_profile_id: task.escalated_from_profile_id,
        close_kind: task.close_kind,
      })),
      completed_count: completed.length,
      forecast,
      remaining_estimate_ms: forecast === null ? null : remainingPlanRuntimeMs(forecast, completedIds),
      providers: [...providers.values()]
        .sort((left, right) => left.provider.localeCompare(right.provider))
        .map((provider) => ({ ...provider })),
      pools: [...pools.values()]
        .sort((left, right) => left.quota_pool.localeCompare(right.quota_pool))
        .map((pool) => ({ ...pool, profiles: [...pool.profiles].sort() })),
      deliberation:
        deliberationTurns.length === 0
          ? null
          : {
              max_turns: deliberationMaxTurns,
              turns: [...deliberationTurns],
              converged: convergedAtTurn !== null,
              converged_at_turn: convergedAtTurn,
            },
      terminal,
    };
  }

  return { listener, snapshot };
}
