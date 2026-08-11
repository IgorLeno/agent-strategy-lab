import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const providerId = z.string().trim().min(1, 'provider deve ser não vazio');
const windowId = z
  .string()
  .trim()
  .min(1, 'window_id deve ser não vazio')
  .describe(
    'Identificador de janela definido pelo provider (ex.: five_hour, seven_day). ' +
      'Nunca um campo fixo do stable kernel — o conjunto de window_id possíveis varia por provider.',
  );
const provenance = nonEmpty;

/**
 * Motivo estruturado de uma medição de quota. OK indica leitura normal.
 * RATE_LIMIT_WINDOW_RESET sinaliza que a janela reiniciou entre before/after
 * (invalidando o delta). MEASUREMENT_UNAVAILABLE cobre falha de probe ou
 * provider sem mecanismo verificável. WINDOW_LABEL_UNPARSEABLE indica que o
 * rótulo da janela reportado pelo provider não pôde ser interpretado.
 * OBSERVED_DELTA_NEGATIVE documenta uma queda de uso observada (before >
 * after) em vez de descartá-la silenciosamente.
 */
export enum QuotaReasonCode {
  OK = 'OK',
  RATE_LIMIT_WINDOW_RESET = 'RATE_LIMIT_WINDOW_RESET',
  MEASUREMENT_UNAVAILABLE = 'MEASUREMENT_UNAVAILABLE',
  WINDOW_LABEL_UNPARSEABLE = 'WINDOW_LABEL_UNPARSEABLE',
  OBSERVED_DELTA_NEGATIVE = 'OBSERVED_DELTA_NEGATIVE',
}

/** Status do probe de quota do provider, distinto de "zero janelas observadas". */
export enum QuotaObservationStatus {
  OBSERVED = 'OBSERVED',
  UNAVAILABLE = 'UNAVAILABLE',
}

/**
 * Medição de uma janela de quota de um provider.
 *
 * consumed_pp é pontos percentuais observados nesta janela — não é token,
 * não é dinheiro, e NUNCA deve ser somado entre janelas incompatíveis
 * (window_id ou provider diferentes). É comparável apenas entre registros
 * de mesmo window_id e mesmo provider.
 *
 * Medição indisponível de UMA janela é representada por before/after/
 * consumed_pp = null com reason_code explicando o motivo — nunca por zero.
 */
export const QuotaWindow = z
  .object({
    window_id: windowId,
    before_used_pct: z.number().nullable(),
    after_used_pct: z.number().nullable(),
    // Delta em pontos percentuais entre before e after; null quando não computável.
    consumed_pp: z.number().nullable(),
    // true = before/after vêm da mesma instância de janela; false = janelas
    // distintas (delta não existe); null = desconhecido.
    same_window: z.boolean().nullable(),
    reason_code: z.nativeEnum(QuotaReasonCode),
    provenance,
  })
  .strict()
  .superRefine((window, context) => {
    if (window.consumed_pp !== null && window.same_window === false) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'consumed_pp exige same_window !== false: delta entre janelas incompatíveis não existe',
        path: ['consumed_pp'],
      });
    }
  });
export type QuotaWindow = z.infer<typeof QuotaWindow>;

const quotaObservation = z
  .object({
    status: z.nativeEnum(QuotaObservationStatus),
    reason_code: z.nativeEnum(QuotaReasonCode),
    provenance,
  })
  .strict();

/**
 * Uso de quota de um provider, agregando o status do probe (observation) e
 * as janelas medidas (windows).
 *
 * observation.status distingue OBSERVED com windows [] (probe executado,
 * resultado interpretável, mas nenhuma janela reportada) de UNAVAILABLE
 * (sem fonte observável, probe falhou, ou provider sem mecanismo
 * verificável). windows=[] sozinho é ambíguo — o status resolve a ambiguidade.
 * UNAVAILABLE nunca inventa QuotaWindow para representar indisponibilidade:
 * windows DEVE ser [] nesse caso.
 */
export const QuotaUsage = z
  .object({
    provider: providerId,
    observation: quotaObservation,
    windows: z.array(QuotaWindow),
  })
  .strict()
  .superRefine((usage, context) => {
    if (usage.observation.status === QuotaObservationStatus.UNAVAILABLE && usage.windows.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'observation UNAVAILABLE não pode reportar windows: indisponibilidade do conjunto não inventa janelas',
        path: ['windows'],
      });
    }
  });
export type QuotaUsage = z.infer<typeof QuotaUsage>;
