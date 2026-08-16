import { z } from 'zod';

import { AgentProfile, EnvironmentProfile } from './profiles.js';
import { StrategyDef } from './strategy.js';
import { TaskSpec } from './task-spec.js';

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');

const uniqueBy = <Item>(items: readonly Item[], key: (item: Item) => string): string[] => {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) duplicates.push(value);
    seen.add(value);
  }
  return duplicates;
};

/**
 * Um braço do experimento: só o `AgentProfile` varia entre braços. Task,
 * strategy, environment e budgets/billing são compartilhados por todo o
 * `ExperimentSpec` — é isso que torna a comparação entre braços válida.
 */
export const ExperimentArm = z
  .object({
    id: identifier,
    agent_profile: AgentProfile,
  })
  .strict();
export type ExperimentArm = z.infer<typeof ExperimentArm>;

/**
 * Política de billing/quota relevante ao experimento inteiro. `billing_mode`
 * espelha `BillingMode` de `billing/guard.ts` sem importar o tipo diretamente
 * — schemas não dependem de módulos fora de `schemas/`.
 */
export const ExperimentBillingPolicy = z
  .object({
    billing_mode: z.enum(['SUBSCRIPTION', 'API', 'NO_CHARGE']),
    max_incremental_charge_usd: z.number().nonnegative().nullable(),
    quota_stop_threshold_pct: z.number().min(0).max(100),
  })
  .strict();
export type ExperimentBillingPolicy = z.infer<typeof ExperimentBillingPolicy>;

/**
 * Esquema de ordenação dos slots planejados. A materialização da ordem em
 * si (a lista concreta de slots) é responsabilidade do runner (M65); aqui
 * só o esquema determinístico e a seed que o alimentam ficam congelados.
 */
export const ExperimentOrdering = z
  .object({
    scheme: z.literal('seeded_interleaved_counterbalanced'),
    seed: z.union([z.string().trim().min(1), z.number().int()]),
  })
  .strict();
export type ExperimentOrdering = z.infer<typeof ExperimentOrdering>;

/**
 * Contrato imutável/versionado de um experimento. Congela tudo que pode
 * alterar o resultado comparativo entre braços ANTES de qualquer execução
 * real: braços (incluindo `AgentProfile`/model/effort de cada um), corpus de
 * tasks, repetições, seed, esquema de ordenação/counterbalancing, strategy
 * compartilhada, environment compartilhado e a política de budget/billing
 * relevante. `planned_slot_count` é redundante com
 * `arms.length * tasks.length * repetitions_per_arm_task` de propósito: torna
 * o número de slots planejados uma afirmação explícita e verificada, não algo
 * que só existe implicitamente na multiplicação.
 *
 * Qualquer mudança de conteúdo produz um `ExperimentSpec` diferente — nunca
 * mutação silenciosa do já congelado. Ver `experiment/index.ts` para o
 * congelamento em si (deep-freeze + hash canônico determinístico).
 */
export const ExperimentSpec = z
  .object({
    schema_version: z.literal(1),
    id: identifier,
    arms: z.array(ExperimentArm).min(2),
    tasks: z.array(TaskSpec).min(1),
    repetitions_per_arm_task: z.number().int().positive(),
    ordering: ExperimentOrdering,
    strategy: StrategyDef,
    environment_profile: EnvironmentProfile,
    billing_policy: ExperimentBillingPolicy,
    planned_slot_count: z.number().int().positive(),
  })
  .strict()
  .superRefine((spec, context) => {
    const duplicateArms = uniqueBy(spec.arms, (arm) => arm.id);
    if (duplicateArms.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `arm id duplicado: ${duplicateArms.join(', ')}`,
        path: ['arms'],
      });
    }

    const duplicateTasks = uniqueBy(spec.tasks, (task) => task.id);
    if (duplicateTasks.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `task id duplicado: ${duplicateTasks.join(', ')}`,
        path: ['tasks'],
      });
    }

    const expectedSlots = spec.arms.length * spec.tasks.length * spec.repetitions_per_arm_task;
    if (spec.planned_slot_count !== expectedSlots) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `planned_slot_count deve ser arms × tasks × repetitions_per_arm_task (${expectedSlots})`,
        path: ['planned_slot_count'],
      });
    }
  });
export type ExperimentSpec = z.infer<typeof ExperimentSpec>;
