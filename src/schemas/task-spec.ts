import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');

export const TaskBudget = z
  .object({
    expected: z.number().int().nonnegative(),
    maximum: z.number().int().nonnegative(),
  })
  .strict();
export type TaskBudget = z.infer<typeof TaskBudget>;

const budgetDimensions = ['duration_ms', 'tokens', 'changed_files'] as const;

export const TaskBudgets = z
  .object({
    duration_ms: TaskBudget,
    tokens: TaskBudget,
    changed_files: TaskBudget,
  })
  .strict()
  .superRefine((budgets, context) => {
    for (const dimension of budgetDimensions) {
      const budget = budgets[dimension];
      if (budget.expected > budget.maximum) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected não pode exceder maximum em ${dimension}`,
          path: [dimension, 'expected'],
        });
      }
    }
  });
export type TaskBudgets = z.infer<typeof TaskBudgets>;

/**
 * Contrato público da tarefa. O objeto é estrito para que metadados privados
 * de avaliação não sejam aceitos e depois encaminhados ao workspace do agente.
 */
export const TaskSpec = z
  .object({
    id: identifier,
    description: nonEmpty,
    visible_criteria: z.array(nonEmpty).min(1),
    task_class: nonEmpty,
    difficulty: nonEmpty,
    stack: z.array(nonEmpty).min(1),
    public_graders: z.array(identifier).min(1),
    budgets: TaskBudgets,
  })
  .strict();
export type TaskSpec = z.infer<typeof TaskSpec>;
