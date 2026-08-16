/**
 * Congelamento de `ExperimentSpec` (M64). Um experimento real só pode ser
 * lançado a partir de um spec já congelado — arms, corpus/tasks, repetitions,
 * seed, ordering/counterbalancing, strategy, environment profile e billing
 * policy fixados antes de qualquer slot executar.
 *
 * `freezeExperimentSpec` valida contra o schema estrito, deep-freeze o valor
 * (mutação em runtime lança `TypeError` em modo estrito ESM) e calcula a
 * identidade/hash canônico determinístico via `canonicalSha256`
 * (`envelope/index.ts`). Qualquer alteração de conteúdo — mesmo um único
 * campo — produz um hash diferente, ou seja, um `ExperimentSpec` diferente:
 * nunca existe mutação silenciosa do spec já congelado, só um novo spec.
 *
 * Este módulo nunca executa slot nenhum: materializar a ordem concreta de
 * execução a partir de um `FrozenExperimentSpec` é responsabilidade do
 * runner (M65).
 */
import { canonicalSha256 } from '../envelope/index.js';
import { ExperimentSpec } from '../schemas/index.js';

export { ExperimentArm, ExperimentBillingPolicy, ExperimentOrdering, ExperimentSpec } from '../schemas/index.js';
export {
  materializeSlotOrder,
  runExperimentSchedule,
  type PlannedSlot,
  type RunExperimentScheduleOptions,
  type RunExperimentScheduleResult,
  type SlotLaunchRecord,
} from './runner.js';

export interface FrozenExperimentSpec {
  readonly spec: ExperimentSpec;
  /** sha256 hex determinístico da serialização canônica de `spec`. */
  readonly hash: string;
}

/**
 * Valida `input` contra `ExperimentSpec` e devolve a versão congelada com
 * sua identidade/hash. Lança `ZodError` quando `input` não é um
 * `ExperimentSpec` válido.
 */
export function freezeExperimentSpec(input: unknown): FrozenExperimentSpec {
  const spec = ExperimentSpec.parse(input);
  return {
    spec: deepFreeze(spec),
    hash: canonicalSha256(spec),
  };
}

function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}
