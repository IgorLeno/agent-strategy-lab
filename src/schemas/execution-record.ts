import { z } from 'zod';

import { ExecutionStatus } from '../core/enums.js';

const sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'execution_envelope_sha256 deve ser sha256 hexadecimal');
const provenance = z.string().trim().min(1, 'provenance da métrica é obrigatória');

const executionMetric = z
  .object({
    // Ausência de medição é null; zero continua reservado a uma medição real.
    value: z.number().int().nonnegative().nullable(),
    provenance,
  })
  .strict();

/** Métricas usadas pelos budgets de score que não são campos do próprio record. */
export const ExecutionMetrics = z
  .object({
    tokens: executionMetric,
    changed_files: executionMetric,
  })
  .strict();
export type ExecutionMetrics = z.infer<typeof ExecutionMetrics>;

/** Evidência normalizada de uma materialização de ExecutionRequest. */
export const ExecutionRecord = z
  .object({
    status: z.nativeEnum(ExecutionStatus),
    exit_code: z.number().int().nullable(),
    duration_ms: z.number().int().nonnegative(),
    execution_envelope_sha256: sha256,
    metrics: ExecutionMetrics,
  })
  .strict();
export type ExecutionRecord = z.infer<typeof ExecutionRecord>;
