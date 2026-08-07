import { z } from 'zod';

const privateIdentifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const rubricDescription = z.string().trim().min(1);
const rubric = z.record(privateIdentifier, rubricDescription).refine(
  (entries) => Object.keys(entries).length > 0,
  'rubric deve ter ao menos um critério',
);
const weights = z.record(privateIdentifier, z.number().finite().positive()).refine(
  (entries) => Object.keys(entries).length > 0,
  'weights deve ter ao menos um peso',
);

/**
 * Contrato privado de avaliação. É deliberadamente independente de TaskSpec
 * para que graders e critérios ocultos não atravessem a fronteira de execução.
 */
export const EvaluationPlan = z
  .object({
    hidden_graders: z.array(privateIdentifier).min(1),
    rubric,
    weights,
  })
  .strict()
  .superRefine((plan, context) => {
    const rubricKeys = Object.keys(plan.rubric).sort();
    const weightKeys = Object.keys(plan.weights).sort();

    if (
      rubricKeys.length !== weightKeys.length ||
      rubricKeys.some((key, index) => key !== weightKeys[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'weights deve definir exatamente os critérios de rubric',
        path: ['weights'],
      });
    }
  });
export type EvaluationPlan = z.infer<typeof EvaluationPlan>;
