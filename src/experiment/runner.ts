/**
 * Runner de scheduling do experimento (M65): materializa a ORDEM concreta de
 * execução a partir de um `FrozenExperimentSpec` e conduz o launch
 * sequencial dos slots planejados. Não faz spawn de processo nem fala com
 * nenhum provider — quem executa de fato um slot é o `executeSlot` que o
 * chamador injeta (fake nesta tarefa; adapter real fica para uma tarefa
 * futura que também prove o scheduling contra os 12 slots reais do piloto).
 *
 * Ordem determinística por seed: `spec.ordering.seed` alimenta um PRNG
 * (mulberry32) que embaralha os blocos task×repetition. Dentro de cada
 * bloco, os arms aparecem uma vez cada, e a direção alterna a cada bloco
 * (counterbalancing) — isso garante que, em qualquer ordem materializada,
 * nunca todos os slots de um arm rodam antes dos slots de outro arm: cada
 * bloco intercala os arms antes de avançar para o próximo bloco. A mesma
 * seed produz sempre a mesma ordem; uma seed diferente pode embaralhar os
 * blocos de forma diferente (ainda válida — mesmos slots, ainda intercalados).
 *
 * `INFRA_ERROR` nunca vira capability FAIL silenciosamente: o runner enfileira
 * um retry slot separado (`kind: 'RETRY'`) em vez de registrar o slot original
 * como resultado de capability. A billing/quota guard (`billing/guard.ts`) é
 * consultada antes de CADA launch, incluindo retries. Quando `observeQuota`
 * está presente, a política congelada do spec deriva `quota.availability`
 * antes dessa guarda — uma decisão `BLOCK` interrompe o launch imediatamente,
 * sem descartar o que já rodou nem os slots que ainda restam.
 */
import { ExecutionStatus } from '../core/enums.js';
import type { BillingGuardDecision } from '../billing/index.js';
import type { QuotaUsage } from '../schemas/index.js';
import type { FrozenExperimentSpec } from './index.js';
import { decideExperimentSlotAuthorization } from './quota-availability.js';

export interface PlannedSlot {
  /** Determinístico: `${task_id}:${arm_id}:${repetition_index}`, com sufixo `:retry:N` para retries. */
  readonly slot_id: string;
  readonly arm_id: string;
  readonly task_id: string;
  /** 0-based, dentro de `[0, repetitions_per_arm_task)`. */
  readonly repetition_index: number;
  /** Posição do slot na ordem materializada (0-based). Retries não reindexam os slots já materializados. */
  readonly order_index: number;
  readonly kind: 'PLANNED' | 'RETRY';
  /** `slot_id` do slot original que este slot reexecuta. Presente somente em retries. */
  readonly retry_of?: string;
}

/** PRNG determinístico (mulberry32) a partir de uma seed inteira de 32 bits. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reduz uma seed string ou number a um inteiro de 32 bits, deterministicamente (djb2 para strings). */
function seedToUint32(seed: string | number): number {
  if (typeof seed === 'number') return seed >>> 0;
  let hash = 5381;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 33) ^ seed.charCodeAt(index);
  }
  return hash >>> 0;
}

/** Fisher-Yates com o PRNG fornecido — nunca `Math.random`, para permanecer reproduzível pela seed. */
function seededShuffle<Item>(items: readonly Item[], rng: () => number): Item[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex] as Item, shuffled[index] as Item];
  }
  return shuffled;
}

/**
 * Materializa a ordem de execução planejada a partir de `frozen`. Determinística
 * pela seed do `ExperimentSpec` congelado: mesma seed produz sempre a mesma
 * ordem, exatamente na mesma quantidade de `spec.planned_slot_count` slots.
 */
export function materializeSlotOrder(frozen: FrozenExperimentSpec): PlannedSlot[] {
  const { spec } = frozen;

  const units: Array<{ readonly taskId: string; readonly repetition: number }> = [];
  for (const task of spec.tasks) {
    for (let repetition = 0; repetition < spec.repetitions_per_arm_task; repetition++) {
      units.push({ taskId: task.id, repetition });
    }
  }

  const rng = mulberry32(seedToUint32(spec.ordering.seed));
  const shuffledUnits = seededShuffle(units, rng);

  const slots: PlannedSlot[] = [];
  shuffledUnits.forEach((unit, unitIndex) => {
    const arms = unitIndex % 2 === 0 ? spec.arms : [...spec.arms].reverse();
    for (const arm of arms) {
      slots.push({
        slot_id: `${unit.taskId}:${arm.id}:${unit.repetition}`,
        arm_id: arm.id,
        task_id: unit.taskId,
        repetition_index: unit.repetition,
        order_index: slots.length,
        kind: 'PLANNED',
      });
    }
  });

  return slots;
}

export interface SlotLaunchRecord {
  readonly slot: PlannedSlot;
  readonly status: ExecutionStatus;
}

export interface RunExperimentScheduleOptions {
  readonly frozen: FrozenExperimentSpec;
  /** Executa um slot já autorizado e devolve seu `ExecutionStatus`. Fake nesta tarefa. */
  readonly executeSlot: (slot: PlannedSlot) => Promise<ExecutionStatus> | ExecutionStatus;
  /** Consultada antes de CADA launch, incluindo retries. Nunca pulada. */
  readonly authorizeSlot: (slot: PlannedSlot) => BillingGuardDecision;
  /**
   * Snapshot de `QuotaUsage` imediatamente antes de cada launch, inclusive
   * retries. Quando presente, a política congelada em
   * `frozen.spec.billing_policy` deriva `quota.availability` e a guarda é
   * reconsultada com essa evidência — `INSUFFICIENT` bloqueia antes de
   * `executeSlot`. Omitir preserva o comportamento anterior: quota
   * desconhecida permanece `null` e não vira BLOCK por omissão.
   */
  readonly observeQuota?: (
    slot: PlannedSlot,
  ) => QuotaUsage | null | Promise<QuotaUsage | null>;
  /** Tentativas de retry por slot original antes de desistir. Default 1: uma tentativa extra por INFRA_ERROR. */
  readonly maxRetriesPerSlot?: number;
}

export interface RunExperimentScheduleResult {
  /** Um registro por slot que efetivamente lançou, na ordem em que lançou. */
  readonly launches: readonly SlotLaunchRecord[];
  readonly stoppedByBillingGuard: boolean;
  /** Decisão `BLOCK` que interrompeu o launch, quando `stoppedByBillingGuard`. */
  readonly blockedDecision?: BillingGuardDecision;
  /** Slots ainda não lançados quando o launch parou (vazio se o schedule terminou por completo). */
  readonly remainingSlots: readonly PlannedSlot[];
}

/**
 * Conduz o launch sequencial dos slots materializados de `options.frozen`.
 *
 * Antes de cada launch — incluindo o de um retry — `authorizeSlot` é
 * consultada. Quando `observeQuota` está presente, a política de quota do
 * spec deriva `quota.availability` e a guarda é reconsultada com essa
 * evidência antes de qualquer `executeSlot`. Uma decisão `BLOCK` interrompe
 * o launch imediatamente e devolve os slots restantes sem lançá-los.
 * `INFRA_ERROR` nunca vira capability FAIL: gera um retry slot
 * (`kind: 'RETRY'`, `retry_of` apontando pro slot original) enfileirado para
 * launch, até `maxRetriesPerSlot` tentativas por slot original.
 */
export async function runExperimentSchedule(
  options: RunExperimentScheduleOptions,
): Promise<RunExperimentScheduleResult> {
  const maxRetries = options.maxRetriesPerSlot ?? 1;

  const queue: PlannedSlot[] = [...materializeSlotOrder(options.frozen)];
  const launches: SlotLaunchRecord[] = [];
  const retryAttempts = new Map<string, number>();

  while (queue.length > 0) {
    const slot = queue.shift() as PlannedSlot;
    const decision = await authorizeLaunch(options, slot);
    if (decision.decision === 'BLOCK') {
      return {
        launches,
        stoppedByBillingGuard: true,
        blockedDecision: decision,
        remainingSlots: [slot, ...queue],
      };
    }

    const status = await options.executeSlot(slot);
    launches.push({ slot, status });

    if (status === ExecutionStatus.INFRA_ERROR) {
      const originId = slot.retry_of ?? slot.slot_id;
      const attempts = retryAttempts.get(originId) ?? 0;
      if (attempts < maxRetries) {
        retryAttempts.set(originId, attempts + 1);
        queue.push({
          ...slot,
          slot_id: `${originId}:retry:${attempts + 1}`,
          kind: 'RETRY',
          retry_of: originId,
        });
      }
    }
  }

  return { launches, stoppedByBillingGuard: false, remainingSlots: [] };
}

/**
 * Autorização do slot +, quando há observação de quota, derivação da política
 * experimental antes do spawn. FIXTURE não é reescrito; REAL_INFERENCE com
 * evidência tem `quota.availability` substituída pela derivação.
 */
async function authorizeLaunch(
  options: RunExperimentScheduleOptions,
  slot: PlannedSlot,
): Promise<BillingGuardDecision> {
  const decision = options.authorizeSlot(slot);
  if (options.observeQuota === undefined) return decision;
  if (decision.decision === 'BLOCK') return decision;
  if (decision.execution_kind !== 'REAL_INFERENCE' || decision.evidence === null) {
    return decision;
  }

  const usage = await options.observeQuota(slot);
  return decideExperimentSlotAuthorization(
    decision.execution_kind,
    decision.evidence,
    usage,
    options.frozen.spec.billing_policy,
  );
}
