import { z } from 'zod';

import { EvaluationOutcome, ExecutionStatus } from '../core/enums.js';

const sha256 = (field: string) =>
  z.string().regex(/^[0-9a-f]{64}$/, `${field} deve ser sha256 hexadecimal`);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const nonEmpty = z.string().trim().min(1);
const provenance = z.string().trim().min(1, 'provenance da métrica é obrigatória');

const metricWithProvenance = (numberSchema: z.ZodNumber) =>
  z
    .object({
      // Ausência de medição é null; zero continua reservado a uma medição real.
      value: numberSchema.nullable(),
      provenance,
    })
    .strict();

const executionMetric = metricWithProvenance(z.number().int().nonnegative());
const decimalMetric = metricWithProvenance(z.number().nonnegative());

/** Métricas usadas pelos budgets de score que não são campos do próprio record. */
export const ExecutionMetrics = z
  .object({
    tokens: executionMetric,
    changed_files: executionMetric,
    // Campos opcionais: ausentes em ExecutionRecord de eras anteriores (M1).
    // fresh_input_tokens não é armazenado — é derivado (input - cached) na camada de performance.
    input_tokens: executionMetric.optional(),
    cached_input_tokens: executionMetric.optional(),
    output_tokens: executionMetric.optional(),
    reasoning_tokens: executionMetric.optional(),
    api_equivalent_usd: decimalMetric.optional(),
  })
  .strict();
export type ExecutionMetrics = z.infer<typeof ExecutionMetrics>;

/** Evidência normalizada de uma materialização de ExecutionRequest. */
export const ExecutionRecord = z
  .object({
    status: z.nativeEnum(ExecutionStatus),
    exit_code: z.number().int().nullable(),
    duration_ms: z.number().int().nonnegative(),
    execution_envelope_sha256: sha256('execution_envelope_sha256'),
    metrics: ExecutionMetrics,
  })
  .strict();
export type ExecutionRecord = z.infer<typeof ExecutionRecord>;

/** Resultado auditável de um grader participante de uma avaliação. */
export const GraderResult = z
  .object({
    outcome: z.nativeEnum(EvaluationOutcome),
    required: z.boolean(),
  })
  .strict();
export type GraderResult = z.infer<typeof GraderResult>;

const graderResults = z.record(identifier, GraderResult).refine(
  (results) => Object.keys(results).length > 0,
  'grader_results deve ter ao menos um grader',
);
const graderVersions = z.record(identifier, nonEmpty).refine(
  (versions) => Object.keys(versions).length > 0,
  'grader_versions deve ter ao menos um grader',
);

/** Evidência de uma avaliação específica de um run. */
export const EvaluationRecord = z
  .object({
    evaluation_id: identifier,
    outcome: z.nativeEnum(EvaluationOutcome),
    grader_results: graderResults,
    grader_versions: graderVersions,
    evaluation_envelope_sha256: sha256('evaluation_envelope_sha256'),
  })
  .strict()
  .superRefine((record, context) => {
    const resultIds = Object.keys(record.grader_results).sort();
    const versionIds = Object.keys(record.grader_versions).sort();

    if (
      resultIds.length !== versionIds.length ||
      resultIds.some((graderId, index) => graderId !== versionIds[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'grader_versions deve corresponder exatamente a grader_results',
        path: ['grader_versions'],
      });
    }

    const hasRequiredFailure = Object.values(record.grader_results).some(
      (result) => result.required && result.outcome === EvaluationOutcome.FAIL,
    );
    if (hasRequiredFailure && record.outcome !== EvaluationOutcome.FAIL) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'grader obrigatório com FAIL força outcome FAIL',
        path: ['outcome'],
      });
    }
  });
export type EvaluationRecord = z.infer<typeof EvaluationRecord>;
