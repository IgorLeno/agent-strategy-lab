import { z } from 'zod';

import { AttemptRole } from '../performance/attempt-facts.js';
import { EvaluationOutcome, ExecutionStatus, QualificationStatus } from '../core/enums.js';
import { InterventionRecord, InterventionType } from './intervention.js';
import { SubScore } from './evaluation-record.js';
import { QuotaUsage } from './quota-usage.js';

const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const strategyName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'nome deve ser alfanumérico com - ou _');
const nonEmpty = z.string().trim().min(1);
const sha256 = (field: string) =>
  z.string().regex(/^[0-9a-f]{64}$/, `${field} deve ser sha256 hexadecimal`);
const unitInterval = z.number().min(0).max(1);
const provenance = z.string().trim().min(1, 'provenance é obrigatória');

const withProvenance = <Schema extends z.ZodTypeAny>(valueSchema: Schema) =>
  z
    .object({
      value: valueSchema,
      provenance,
    })
    .strict();

const tokenMetric = withProvenance(z.number().int().nonnegative().nullable());
const usdMetric = withProvenance(z.number().nonnegative().nullable());

const subScores = z.record(identifier, SubScore).refine(
  (scores) => Object.keys(scores).length > 0,
  'sub_scores deve ter ao menos uma dimensão',
);

/**
 * Identidade de um run: os fatores experimentais que produziram o run, mais
 * as referências PINADAS de EvaluationRecord/ScoreRecord usadas na
 * derivação — nunca os records inteiros, para não duplicar a fonte
 * autoritativa em disco.
 */
const RunIdentity = z
  .object({
    task_id: identifier,
    // Ausente quando a taxonomia da tarefa não foi classificada.
    taxonomy: z
      .object({
        task_class: nonEmpty,
        difficulty: nonEmpty,
      })
      .strict()
      .optional(),
    stack: z.array(nonEmpty).min(1),
    agent_cli: nonEmpty,
    model: nonEmpty,
    reasoning_effort: withProvenance(nonEmpty.nullable()),
    strategy: z
      .object({
        name: strategyName,
        version: z.number().int().positive(),
      })
      .strict(),
    environment_profile: z
      .object({
        id: identifier,
        mode: z.enum(['controlled', 'real-world']),
      })
      .strict(),
    execution_envelope_sha256: sha256('execution_envelope_sha256'),
    evaluation_envelope_sha256: sha256('evaluation_envelope_sha256').nullable(),
    evaluation_id: identifier.nullable(),
    score_id: identifier.nullable(),
  })
  .strict();

/**
 * Evidência de qualidade do run, espelhando ScoreRecord SEM inventar um
 * campo escalar de score agregado: sub_scores/coverage continuam sendo a
 * única fonte de granularidade, e ficam null quando o run não foi
 * pontuado/selecionado para o profile em questão. budgets_used permanece
 * exclusivo do ScoreRecord autoritativo e não é duplicado aqui.
 */
const RunQuality = z
  .object({
    execution_status: z.nativeEnum(ExecutionStatus),
    evaluation_outcome: z.nativeEnum(EvaluationOutcome),
    qualification_status: z.nativeEnum(QualificationStatus),
    score_profile_id: identifier.nullable(),
    score_profile_version: nonEmpty.nullable(),
    sub_scores: subScores.nullable(),
    coverage: unitInterval.nullable(),
  })
  .strict();

/** Fatos ortogonais do attempt (M45) reexportados no contexto do run. */
const RunFacts = z
  .object({
    had_inference: withProvenance(z.boolean().nullable()),
    attempt_role: z.nativeEnum(AttemptRole),
    interventions: z.array(InterventionRecord).nullable(),
  })
  .strict();

/** Custo observado do run, incluindo o breakdown de tokens e quota do provider. */
const RunCost = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    tokens: z
      .object({
        total_tokens: tokenMetric,
        input_tokens: tokenMetric,
        cached_input_tokens: tokenMetric,
        // Derivado (input_tokens - cached_input_tokens) na camada de performance,
        // nunca lido diretamente do ExecutionRecord.
        fresh_input_tokens: tokenMetric,
        output_tokens: tokenMetric,
        reasoning_tokens: tokenMetric,
      })
      .strict(),
    api_equivalent_usd: usdMetric,
    quota_usage: withProvenance(QuotaUsage.nullable()),
  })
  .strict();

/**
 * Evidência derivada e recomputável de um único run. NUNCA é a fonte de
 * verdade: a evidência primária (ExecutionRecord/EvaluationRecord/
 * ScoreRecord em disco) permanece autoritativa, e este record pode ser
 * inteiramente reconstruído a partir dela.
 */
export const RunPerformanceRecord = z
  .object({
    schema_version: z.literal(1),
    identity: RunIdentity,
    quality: RunQuality,
    facts: RunFacts,
    cost: RunCost,
  })
  .strict();
export type RunPerformanceRecord = z.infer<typeof RunPerformanceRecord>;

const attemptCount = z.number().int().nonnegative();

const TaskPerformanceAttempts = z
  .object({
    operational_attempts: attemptCount,
    attempts_with_inference: attemptCount,
    attempts_without_inference: attemptCount,
    attempts_inference_unknown: attemptCount,
    // Contagem por execution_status; PODE intersectar attempts_with_inference
    // (um attempt INFRA_ERROR pode ter had_inference true) — não é subtraído
    // nem somado à partição acima.
    infra_error_attempts: attemptCount,
    repair_attempts: attemptCount,
    escalations: attemptCount,
    attempts_role_unknown: attemptCount,
  })
  .strict()
  .superRefine((attempts, context) => {
    const partitionTotal =
      attempts.attempts_with_inference +
      attempts.attempts_without_inference +
      attempts.attempts_inference_unknown;
    if (partitionTotal !== attempts.operational_attempts) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'attempts_with_inference + attempts_without_inference + attempts_inference_unknown deve igualar operational_attempts',
        path: ['operational_attempts'],
      });
    }
  });

const TaskPerformanceSuccess = z
  .object({
    first_operational_pass: z.boolean().nullable(),
    first_inference_bearing_pass: z.boolean().nullable(),
    autonomous_first_pass: z.boolean().nullable(),
    final_pass: z.boolean().nullable(),
  })
  .strict();

/**
 * human_intervention nunca tem default false: ausência de registro objetivo
 * é null, distinta de uma prova positiva de zero intervenções (false).
 */
const TaskPerformanceIntervention = z
  .object({
    human_intervention: withProvenance(z.boolean().nullable()),
    intervention_types: z.array(z.nativeEnum(InterventionType)),
  })
  .strict();

/**
 * Agregado por trial/task, derivado e recomputável a partir dos
 * RunPerformanceRecord dos attempts do trial. Nunca é a fonte de verdade.
 */
export const TaskPerformanceRecord = z
  .object({
    schema_version: z.literal(1),
    task_id: identifier,
    trial_id: identifier,
    attempts: TaskPerformanceAttempts,
    success: TaskPerformanceSuccess,
    intervention: TaskPerformanceIntervention,
  })
  .strict()
  .superRefine((record, context) => {
    const { autonomous_first_pass } = record.success;
    const humanIntervention = record.intervention.human_intervention.value;

    if (autonomous_first_pass === true && humanIntervention !== false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'autonomous_first_pass true exige human_intervention false comprovado (nunca true nem null)',
        path: ['success', 'autonomous_first_pass'],
      });
    }

    if (humanIntervention === null && autonomous_first_pass !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'human_intervention null torna autonomous_first_pass null',
        path: ['success', 'autonomous_first_pass'],
      });
    }
  });
export type TaskPerformanceRecord = z.infer<typeof TaskPerformanceRecord>;
