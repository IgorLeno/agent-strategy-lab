/**
 * OBSERVAÇÃO NORMALIZADA DE CAPACIDADE DE UM POOL DE QUOTA.
 *
 * Quota é um recurso externo real, e por isso observável. Mas observar não é
 * autorizar nem proibir: este contrato existe para REGISTRAR o que o provider
 * disse, com a precisão que ele disse, e nada além.
 *
 * As regras que o formato IMPÕE:
 *
 *   UNKNOWN != 0. Probe que falhou, credencial ausente e provider sem medidor
 *   produzem `UNKNOWN`, nunca zero. Zero é uma medição.
 *
 *   Precisão não é inventada. O endpoint do OpenCode Go devolve inteiro; o
 *   dashboard mostra decimal. O inteiro é gravado como inteiro e ROTULADO como
 *   grosseiro. `percent: 0` significa "o provider reportou o inteiro 0", NÃO
 *   "nenhum token foi consumido" — consumo abaixo da resolução do endpoint
 *   existe e não aparece ali.
 *
 *   Delta não atravessa reset. Se a identidade da janela mudou entre before e
 *   after, não há delta: subtrair produziria consumo negativo inventado.
 *
 *   `remaining` só existe quando é matematicamente derivável do que o provider
 *   reportou. Nada é estimado.
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

/**
 * Estado de capacidade de um pool.
 *
 * `AVAILABLE_WITHOUT_METER` é um estado distinto e necessário: a credencial
 * está provada e o provider aceita trabalho, mas não existe medidor que diga
 * QUANTO resta. Colapsá-lo em `KNOWN` inventaria um número; colapsá-lo em
 * `UNKNOWN` esconderia que a disponibilidade em si foi observada.
 */
export enum CapacityStatus {
  /** Medida numérica observada do provider. */
  KNOWN = 'KNOWN',
  /** Disponível e sem medidor de headroom. Não é 100%, não é zero. */
  AVAILABLE_WITHOUT_METER = 'AVAILABLE_WITHOUT_METER',
  /** O PROVIDER declarou esgotamento (limite atingido, saldo zerado). */
  EXHAUSTED = 'EXHAUSTED',
  /** Não observado. Nunca interpretável como esgotado nem como livre. */
  UNKNOWN = 'UNKNOWN',
}

/** Resolução da medição REPORTADA. Nunca refinada depois. */
export enum CapacityPrecision {
  /** O provider só expõe percentual inteiro (ex.: OpenCode Go `percent`). */
  COARSE_INTEGER_PERCENT = 'COARSE_INTEGER_PERCENT',
  /** O provider expõe percentual fracionário (ex.: Claude `/usage`). */
  FRACTIONAL_PERCENT = 'FRACTIONAL_PERCENT',
  /** Valor monetário. */
  CURRENCY = 'CURRENCY',
}

/**
 * Uma janela de quota com percentual reportado.
 *
 * `window_id` é a identidade SEMÂNTICA da janela dentro do pool (`primary`,
 * `weekly`, `rolling`, `monthly`). `window_instance` é a identidade da
 * INSTÂNCIA corrente — o instante de reset como o provider o escreveu. Duas
 * leituras só são subtraíveis quando as duas identidades coincidem.
 */
export const CapacityWindow = z
  .object({
    window_id: nonEmpty,
    /** Percentual USADO exatamente como reportado. Não arredondado, não refinado. */
    used_percent: z.number().min(0).nullable(),
    /**
     * Percentual restante, SÓ quando derivável de `used_percent`. `null` quando
     * o provider não reportou uso — ausência nunca vira 100.
     */
    remaining_percent: z.number().nullable(),
    precision: z.nativeEnum(CapacityPrecision),
    /** Duração declarada da janela em segundos, quando o provider a informa. */
    window_seconds: z.number().int().positive().nullable(),
    /** Identidade da instância: reset como o provider o escreveu, cru. */
    window_instance: z.string().nullable(),
    /** Reset em ISO-8601 quando datável sem adivinhar unidade; `null` caso contrário. */
    resets_at: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (window.used_percent === null && window.remaining_percent !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'remaining_percent sem used_percent seria folga inventada',
        path: ['remaining_percent'],
      });
    }
  });
export type CapacityWindow = z.infer<typeof CapacityWindow>;

/** Saldo monetário de um pool pré-pago. */
export const CapacityBalance = z
  .object({
    remaining: z.number(),
    currency: nonEmpty,
    precision: z.literal(CapacityPrecision.CURRENCY),
  })
  .strict();
export type CapacityBalance = z.infer<typeof CapacityBalance>;

/**
 * Observação completa de um pool.
 *
 * `source` e `observed_at` são obrigatórios porque uma medição sem
 * proveniência e sem instante não é evidência: ela não pode ser comparada com
 * a próxima nem auditada depois.
 */
export const PoolCapacityObservation = z
  .object({
    schema_version: z.literal(1),
    /** Chave de deduplicação: perfis do mesmo pool nunca são somados. */
    quota_pool: nonEmpty,
    status: z.nativeEnum(CapacityStatus),
    windows: z.array(CapacityWindow),
    balance: CapacityBalance.nullable(),
    /**
     * Plano contratado quando o provider o reporta (`plus`, `pro`). Não é
     * capacidade — é contexto que torna a leitura interpretável.
     */
    plan: z.string().nullable(),
    /** Motivo, sempre. Em UNKNOWN diz POR QUE não foi observado. */
    reason: nonEmpty,
    /** Endpoint/comando consultado. NUNCA credencial, token, conta ou e-mail. */
    source: nonEmpty,
    observed_at: z.string().datetime(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const reject = (message: string, path: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] });

    if (observation.status === CapacityStatus.UNKNOWN) {
      if (observation.windows.length > 0) {
        reject('UNKNOWN não reporta janelas: ausência de medição não inventa janela', 'windows');
      }
      if (observation.balance !== null) {
        reject('UNKNOWN não reporta saldo: ausência de medição não inventa saldo', 'balance');
      }
    }
    if (
      observation.status === CapacityStatus.KNOWN &&
      observation.windows.length === 0 &&
      observation.balance === null
    ) {
      reject('KNOWN exige ao menos uma janela ou um saldo observado', 'status');
    }
    if (
      observation.status === CapacityStatus.AVAILABLE_WITHOUT_METER &&
      (observation.windows.length > 0 || observation.balance !== null)
    ) {
      reject(
        'AVAILABLE_WITHOUT_METER significa ausência de medidor: reportar medida aqui é contradição',
        'status',
      );
    }
  });
export type PoolCapacityObservation = z.infer<typeof PoolCapacityObservation>;

/** Derivação de `remaining_percent` — só quando `used_percent` existe. */
export function remainingPercentOf(usedPercent: number | null): number | null {
  if (usedPercent === null || !Number.isFinite(usedPercent)) return null;
  return Number(Math.min(100, Math.max(0, 100 - usedPercent)).toFixed(6));
}

/** Observação UNKNOWN canônica: o único jeito de dizer "não sei" neste contrato. */
export function unknownCapacity(input: {
  readonly quota_pool: string;
  readonly reason: string;
  readonly source: string;
  readonly observed_at: string;
}): PoolCapacityObservation {
  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: input.quota_pool,
    status: CapacityStatus.UNKNOWN,
    windows: [],
    balance: null,
    plan: null,
    reason: input.reason,
    source: input.source,
    observed_at: input.observed_at,
  });
}

/**
 * Delta entre duas observações da MESMA janela do MESMO pool.
 *
 * Reset entre before e after não produz delta negativo: produz `null` com
 * `window_reset: true`. Este é o mesmo princípio científico que a medição da
 * assinatura Claude já seguia — generalizado, não reinventado.
 */
export interface WindowDelta {
  readonly window_id: string;
  readonly before_used_percent: number | null;
  readonly after_used_percent: number | null;
  /** Pontos percentuais consumidos; `null` sempre que não comparável. */
  readonly consumed_pp: number | null;
  readonly same_window: boolean | null;
  readonly window_reset: boolean;
  readonly reason: string;
}

export function windowDeltas(
  before: PoolCapacityObservation,
  after: PoolCapacityObservation,
): readonly WindowDelta[] {
  if (before.quota_pool !== after.quota_pool) {
    throw new Error(
      `delta exige o mesmo pool: ${before.quota_pool} != ${after.quota_pool}`,
    );
  }
  const afterById = new Map(after.windows.map((window) => [window.window_id, window]));
  return before.windows.map((beforeWindow) => {
    const afterWindow = afterById.get(beforeWindow.window_id);
    if (afterWindow === undefined) {
      return {
        window_id: beforeWindow.window_id,
        before_used_percent: beforeWindow.used_percent,
        after_used_percent: null,
        consumed_pp: null,
        same_window: null,
        window_reset: false,
        reason: 'janela ausente na observação posterior',
      };
    }
    const sameWindow =
      beforeWindow.window_instance === null || afterWindow.window_instance === null
        ? null
        : beforeWindow.window_instance === afterWindow.window_instance;
    if (sameWindow === false) {
      // A janela virou. Subtrair aqui produziria consumo negativo que nunca
      // aconteceu — a medição falha fechada em vez de mentir.
      return {
        window_id: beforeWindow.window_id,
        before_used_percent: beforeWindow.used_percent,
        after_used_percent: afterWindow.used_percent,
        consumed_pp: null,
        same_window: false,
        window_reset: true,
        reason: 'a janela resetou entre as duas observações: não há delta a subtrair',
      };
    }
    if (beforeWindow.used_percent === null || afterWindow.used_percent === null) {
      return {
        window_id: beforeWindow.window_id,
        before_used_percent: beforeWindow.used_percent,
        after_used_percent: afterWindow.used_percent,
        consumed_pp: null,
        same_window: sameWindow,
        window_reset: false,
        reason: 'uma das leituras não reportou percentual',
      };
    }
    const consumed = Number((afterWindow.used_percent - beforeWindow.used_percent).toFixed(6));
    return {
      window_id: beforeWindow.window_id,
      before_used_percent: beforeWindow.used_percent,
      after_used_percent: afterWindow.used_percent,
      consumed_pp: consumed,
      same_window: sameWindow,
      window_reset: false,
      reason:
        consumed < 0
          ? 'delta observado NEGATIVO na mesma janela: preservado como veio, não clampado'
          : `delta observado em pontos percentuais de ${beforeWindow.window_id}`,
    };
  });
}

/**
 * Um pool está indisponível SOMENTE quando o provider declarou esgotamento.
 *
 * Folga baixa NÃO entra aqui. O Lab é orquestrador, não governador de recurso:
 * headroom pequeno é preferência de routing, e transformá-lo em proibição
 * inventaria um limite que o provider não impôs.
 */
export function poolUnavailable(observation: PoolCapacityObservation): boolean {
  return observation.status === CapacityStatus.EXHAUSTED;
}
