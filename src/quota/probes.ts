/**
 * PROBES DE CAPACIDADE — leitura, nunca inferência.
 *
 * Nenhuma função aqui envia prompt, escolhe modelo ou gasta token. Todas
 * consultam um endpoint de USO e traduzem a resposta para
 * `PoolCapacityObservation`, descartando tudo que não é capacidade.
 *
 * O descarte é a parte importante. As respostas reais destes endpoints
 * carregam e-mail, id de usuário, id de conta e rótulo de chave. NADA disso
 * entra na observação: o que é gravado são percentuais, instantes de reset,
 * plano e proveniência textual do endpoint.
 *
 * Falha de qualquer natureza — rede, credencial, corpo inesperado — produz
 * `UNKNOWN` com motivo. Nunca zero, nunca `EXHAUSTED`. Só o PROVIDER declara
 * esgotamento.
 */
import {
  CapacityPrecision,
  CapacityStatus,
  PoolCapacityObservation,
  remainingPercentOf,
  unknownCapacity,
} from './observation.js';
import type { CredentialLookup } from './credentials.js';

/** `fetch` injetável: nenhum teste toca a rede. */
export type ProbeFetch = (
  url: string,
  init: { readonly headers: Record<string, string> },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

export interface ProbeOptions {
  readonly credential: CredentialLookup;
  readonly fetch?: ProbeFetch;
  readonly now?: () => Date;
}

export const OPENAI_USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/wham/usage';
export const OPENCODE_GO_USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
/**
 * `/credits` e não `/key`: a resposta de `/key` inclui um rótulo derivado da
 * própria chave, e um probe de capacidade não tem por que trazer material de
 * credencial de volta para dentro do processo.
 */
export const OPENROUTER_CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';

const defaultFetch: ProbeFetch = (url, init) => fetch(url, { headers: init.headers });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function nested(record: Record<string, unknown> | null, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isRecord(value) ? (value as Record<string, unknown>) : undefined;
}

/** Segundos epoch para ISO. Fora de faixa plausível vira `null` em vez de data absurda. */
function isoFromEpochSeconds(seconds: number | null): string | null {
  if (seconds === null) return null;
  const ms = seconds * 1_000;
  if (!Number.isFinite(ms) || ms <= 0 || ms > 4_102_444_800_000) return null;
  return new Date(ms).toISOString();
}

/** ISO do provider revalidado; texto não datável vira `null`, nunca `Date.now()`. */
function isoFromText(value: string | null): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

interface FetchOutcome {
  readonly body: Record<string, unknown> | null;
  readonly failure: string | null;
}

async function readJsonEndpoint(
  endpoint: string,
  options: ProbeOptions,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<FetchOutcome> {
  if (!options.credential.present) {
    return { body: null, failure: `credencial indisponível: ${options.credential.reason}` };
  }
  const run = options.fetch ?? defaultFetch;
  try {
    const response = await run(endpoint, {
      headers: options.credential.credential.headers({ accept: 'application/json', ...extraHeaders }),
    });
    if (!response.ok) {
      return { body: null, failure: `endpoint respondeu HTTP ${response.status}` };
    }
    const parsed: unknown = JSON.parse(await response.text());
    return isRecord(parsed)
      ? { body: parsed, failure: null }
      : { body: null, failure: 'corpo da resposta não é um objeto JSON' };
  } catch (error) {
    // A mensagem do erro de rede é preservada; ela não contém credencial
    // porque o segredo nunca esteve na URL, só no header.
    return { body: null, failure: `probe falhou: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// OpenAI — franquia da assinatura ChatGPT
// ---------------------------------------------------------------------------

/**
 * Pool `openai_chatgpt_subscription`.
 *
 * Fonte verificada contra o binário Codex instalado (0.149.1), que carrega
 * literalmente `wham/usage`, `ChatGPT-Account-Id`, `plan_type`,
 * `used_percent`, `window_minutes` e `resets_at`. O endpoint não é tratado
 * como API pública estável: se o corpo deixar de ter a forma esperada, o
 * resultado é UNKNOWN.
 *
 * Percentuais aqui são INTEIROS reportados pelo provider. Um "Oi" moveu a
 * janela de 0% para 1% no experimento real — isso NÃO significa que cem "Oi"
 * consomem a franquia inteira. Um ponto percentual é a resolução do medidor,
 * não o custo de uma mensagem.
 */
export async function probeOpenAiSubscriptionQuota(
  options: ProbeOptions,
): Promise<PoolCapacityObservation> {
  const pool = 'openai_chatgpt_subscription';
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const { body, failure } = await readJsonEndpoint(OPENAI_USAGE_ENDPOINT, options);
  if (body === null) {
    return unknownCapacity({
      quota_pool: pool,
      reason: failure ?? 'motivo não informado',
      source: OPENAI_USAGE_ENDPOINT,
      observed_at: observedAt,
    });
  }

  const rateLimit = nested(body, 'rate_limit');
  if (rateLimit === undefined) {
    return unknownCapacity({
      quota_pool: pool,
      reason: 'resposta sem bloco rate_limit: forma do endpoint mudou',
      source: OPENAI_USAGE_ENDPOINT,
      observed_at: observedAt,
    });
  }

  const windows = [
    openAiWindow('primary', nested(rateLimit, 'primary_window')),
    openAiWindow('secondary', nested(rateLimit, 'secondary_window')),
  ].filter((window): window is NonNullable<typeof window> => window !== null);

  // Esgotamento é DECLARAÇÃO DO PROVIDER, não dedução a partir de percentual.
  const limitReached = rateLimit['limit_reached'] === true || rateLimit['allowed'] === false;
  const status =
    limitReached
      ? CapacityStatus.EXHAUSTED
      : windows.length > 0
        ? CapacityStatus.KNOWN
        : CapacityStatus.UNKNOWN;

  if (status === CapacityStatus.UNKNOWN) {
    return unknownCapacity({
      quota_pool: pool,
      reason: 'rate_limit presente mas sem janela interpretável',
      source: OPENAI_USAGE_ENDPOINT,
      observed_at: observedAt,
    });
  }

  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: pool,
    status,
    windows,
    balance: null,
    // `plan_type` é contexto. `email`, `user_id` e `account_id` da mesma
    // resposta são deliberadamente descartados aqui e nunca gravados.
    plan: stringField(body, 'plan_type'),
    reason: limitReached
      ? 'provider declarou limite atingido (limit_reached/allowed): pool esgotado até o reset'
      : 'janelas de uso reportadas pelo provider',
    source: OPENAI_USAGE_ENDPOINT,
    observed_at: observedAt,
  });
}

function openAiWindow(
  windowId: string,
  raw: Record<string, unknown> | undefined,
): PoolCapacityObservation['windows'][number] | null {
  if (raw === undefined) return null;
  const used = numberField(raw, 'used_percent');
  const resetsAt = isoFromEpochSeconds(numberField(raw, 'reset_at'));
  return {
    window_id: windowId,
    used_percent: used,
    remaining_percent: remainingPercentOf(used),
    precision: CapacityPrecision.COARSE_INTEGER_PERCENT,
    window_seconds: numberField(raw, 'limit_window_seconds'),
    // Identidade da INSTÂNCIA: o reset absoluto. Sem ele não há como provar
    // que duas leituras pertencem à mesma janela, e o delta falha fechado.
    window_instance: resetsAt,
    resets_at: resetsAt,
  };
}

// ---------------------------------------------------------------------------
// OpenCode Go — assinatura autenticada por chave
// ---------------------------------------------------------------------------

const GO_WINDOW_IDS = ['rolling', 'weekly', 'monthly'] as const;

/**
 * Pool `opencode_go_subscription`.
 *
 * O endpoint expõe `percent` INTEIRO. O dashboard do navegador mostra
 * fração (3.6% onde a API diz 3). A API é a fonte; a fração do navegador NÃO é
 * raspada e a precisão NÃO é fabricada — o inteiro é gravado como inteiro e
 * rotulado `COARSE_INTEGER_PERCENT`.
 *
 * Consequência que o rótulo torna legível: `percent: 0` significa "o inteiro
 * reportado é 0", e não "nenhum token foi consumido". Consumo real abaixo da
 * resolução do medidor existe e não aparece.
 */
export async function probeOpenCodeGoQuota(
  options: ProbeOptions,
): Promise<PoolCapacityObservation> {
  const pool = 'opencode_go_subscription';
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const { body, failure } = await readJsonEndpoint(OPENCODE_GO_USAGE_ENDPOINT, options);
  if (body === null) {
    return unknownCapacity({
      quota_pool: pool,
      reason: failure ?? 'motivo não informado',
      source: OPENCODE_GO_USAGE_ENDPOINT,
      observed_at: observedAt,
    });
  }

  const usage = nested(body, 'usage');
  if (usage === undefined) {
    return unknownCapacity({
      quota_pool: pool,
      reason: 'resposta sem bloco usage: forma do endpoint mudou',
      source: OPENCODE_GO_USAGE_ENDPOINT,
      observed_at: observedAt,
    });
  }

  const windows: PoolCapacityObservation['windows'][number][] = [];
  let exhausted = false;
  for (const windowId of GO_WINDOW_IDS) {
    const raw = nested(usage, windowId);
    if (raw === undefined) continue;
    const windowStatus = stringField(raw, 'status');
    // Qualquer status que não seja `ok` é declaração do provider sobre a
    // janela. Ele não é reinterpretado: é registrado e trata a janela como
    // esgotada só quando o próprio provider a declara como tal.
    if (windowStatus !== null && /exhaust|limit|exceed|block/i.test(windowStatus)) {
      exhausted = true;
    }
    const used = numberField(raw, 'percent');
    const resetsAt = isoFromText(stringField(raw, 'resetsAt'));
    windows.push({
      window_id: windowId,
      used_percent: used,
      remaining_percent: remainingPercentOf(used),
      precision: CapacityPrecision.COARSE_INTEGER_PERCENT,
      window_seconds: null,
      window_instance: resetsAt ?? stringField(raw, 'resetsAt'),
      resets_at: resetsAt,
    });
  }

  if (windows.length === 0) {
    return unknownCapacity({
      quota_pool: pool,
      reason: 'bloco usage presente mas sem janela interpretável',
      source: OPENCODE_GO_USAGE_ENDPOINT,
      observed_at: observedAt,
    });
  }

  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: pool,
    status: exhausted ? CapacityStatus.EXHAUSTED : CapacityStatus.KNOWN,
    windows,
    balance: null,
    plan: null,
    reason: exhausted
      ? 'provider declarou janela esgotada: pool indisponível até o reset'
      : 'percentuais INTEIROS reportados pelo provider; precisão do medidor é grosseira e 0 não prova consumo zero',
    source: OPENCODE_GO_USAGE_ENDPOINT,
    observed_at: observedAt,
  });
}

// ---------------------------------------------------------------------------
// OpenRouter — saldo pré-pago
// ---------------------------------------------------------------------------

/**
 * Pool `openrouter_balance`.
 *
 * O saldo é DINHEIRO, não percentual. Ele não é convertido em folga percentual
 * porque não existe denominador: sem um teto de gasto autorizado pelo humano,
 * "quantos por cento do saldo restam" é uma pergunta sem resposta.
 *
 * Observar saldo NÃO é autorização para gastá-lo. Um saldo positivo torna o
 * pool tecnicamente disponível; a autorização de cobrança por uso é decidida
 * em outro lugar, e permanece obrigatória.
 */
export async function probeOpenRouterBalance(
  options: ProbeOptions,
): Promise<PoolCapacityObservation> {
  const pool = 'openrouter_balance';
  const observedAt = (options.now ?? (() => new Date()))().toISOString();
  const { body, failure } = await readJsonEndpoint(OPENROUTER_CREDITS_ENDPOINT, options);
  if (body === null) {
    return unknownCapacity({
      quota_pool: pool,
      reason: failure ?? 'motivo não informado',
      source: OPENROUTER_CREDITS_ENDPOINT,
      observed_at: observedAt,
    });
  }

  const data = nested(body, 'data');
  const totalCredits = numberField(data, 'total_credits');
  const totalUsage = numberField(data, 'total_usage');
  if (totalCredits === null || totalUsage === null) {
    return unknownCapacity({
      quota_pool: pool,
      reason: 'resposta sem total_credits/total_usage: saldo não é derivável sem adivinhar',
      source: OPENROUTER_CREDITS_ENDPOINT,
      observed_at: observedAt,
    });
  }

  const remaining = Number((totalCredits - totalUsage).toFixed(6));
  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: pool,
    // Saldo zerado ou negativo é esgotamento REAL de recurso de cobrança.
    status: remaining > 0 ? CapacityStatus.KNOWN : CapacityStatus.EXHAUSTED,
    windows: [],
    balance: { remaining, currency: 'USD', precision: CapacityPrecision.CURRENCY },
    plan: null,
    reason:
      remaining > 0
        ? 'saldo pré-pago observado; observar saldo não autoriza gastá-lo'
        : 'saldo pré-pago esgotado: inferência por uso não tem recurso',
    source: OPENROUTER_CREDITS_ENDPOINT,
    observed_at: observedAt,
  });
}

// ---------------------------------------------------------------------------
// Anthropic — preservado, não substituído
// ---------------------------------------------------------------------------

export interface AnthropicWindowReading {
  readonly window_id: string;
  readonly used_percent: number;
  /** Rótulo de reset EXATAMENTE como a CLI o escreveu: identidade da instância. */
  readonly reset_label: string;
}

/**
 * Traduz a leitura que o probe Claude JÁ produz (`claude -p /usage`) para o
 * contrato normalizado. O mecanismo Claude não é substituído: ele funciona,
 * mede com precisão fracionária e continua sendo a fonte. O que muda é só o
 * FORMATO em que o resto do produto o lê, para que os quatro pools possam ser
 * comparados na mesma projeção.
 */
export function anthropicCapacityOf(input: {
  readonly readings: readonly AnthropicWindowReading[] | null;
  readonly reason: string;
  readonly source: string;
  readonly observed_at: string;
}): PoolCapacityObservation {
  const pool = 'anthropic_subscription';
  if (input.readings === null || input.readings.length === 0) {
    return unknownCapacity({
      quota_pool: pool,
      reason: input.reason,
      source: input.source,
      observed_at: input.observed_at,
    });
  }
  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: pool,
    status: CapacityStatus.KNOWN,
    windows: input.readings.map((reading) => ({
      window_id: reading.window_id,
      used_percent: reading.used_percent,
      remaining_percent: remainingPercentOf(reading.used_percent),
      // A CLI do Claude reporta decimal; o rótulo diz isso, e nenhum consumidor
      // precisa descobrir que a precisão aqui difere da do OpenCode Go.
      precision: CapacityPrecision.FRACTIONAL_PERCENT,
      window_seconds: null,
      window_instance: reading.reset_label,
      resets_at: null,
    })),
    balance: null,
    plan: null,
    reason: input.reason,
    source: input.source,
    observed_at: input.observed_at,
  });
}
