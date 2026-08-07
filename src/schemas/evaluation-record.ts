import { z } from 'zod';

import { QualificationStatus } from '../core/enums.js';
import { TaskBudgets } from './task-spec.js';

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const nonEmpty = z.string().trim().min(1);
const unitInterval = z.number().min(0).max(1);
const tolerance = 1e-9;

/** Parcela fixa de um perfil de score, mesmo quando sua métrica está ausente. */
export const SubScore = z
  .object({
    value: unitInterval.nullable(),
    weight: unitInterval.refine((weight) => weight > 0, 'weight deve ser maior que zero'),
    required: z.boolean(),
  })
  .strict();
export type SubScore = z.infer<typeof SubScore>;

const subScores = z.record(identifier, SubScore).refine(
  (scores) => Object.keys(scores).length > 0,
  'sub_scores deve ter ao menos uma dimensão',
);

/** Evidência versionada da pontuação de uma avaliação individual. */
export const ScoreRecord = z
  .object({
    score_profile_id: identifier,
    score_profile_version: nonEmpty,
    sub_scores: subScores,
    budgets_used: TaskBudgets,
    coverage: unitInterval,
  })
  .strict()
  .superRefine((record, context) => {
    const scores = Object.values(record.sub_scores);
    const totalWeight = scores.reduce((total, score) => total + score.weight, 0);
    if (Math.abs(totalWeight - 1) > tolerance) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a soma dos weights de sub_scores deve ser 1',
        path: ['sub_scores'],
      });
    }

    const measuredWeight = scores.reduce(
      (total, score) => total + (score.value === null ? 0 : score.weight),
      0,
    );
    if (Math.abs(record.coverage - measuredWeight) > tolerance) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'coverage deve preservar o peso de sub-scores ausentes',
        path: ['coverage'],
      });
    }
  });
export type ScoreRecord = z.infer<typeof ScoreRecord>;

/** Decisão independente sobre se um score pode participar de comparações. */
export const QualificationRecord = z
  .object({
    status: z.nativeEnum(QualificationStatus),
    justification: nonEmpty.nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status !== QualificationStatus.QUALIFIED && record.justification === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'justification é obrigatória quando status não é QUALIFIED',
        path: ['justification'],
      });
    }
  });
export type QualificationRecord = z.infer<typeof QualificationRecord>;
