/**
 * Leitura do stdout de `claude --print --output-format stream-json --verbose`.
 *
 * O transporte é JSONL: uma mensagem JSON por linha. Duas coisas interessam ao
 * harness — a mensagem `type=result`, que carrega os MESMOS campos que o objeto
 * único de `--output-format json`, e as mensagens `type=rate_limit_event`, que
 * são a única observação de limite que a CLI emite pelo protocolo documentado.
 *
 * O que este módulo NÃO faz, de propósito: não consulta endpoint de OAuth, não
 * raspa TUI, não roda `/usage` e não inventa valor ausente. Campo que não veio
 * fica `null`, e a mensagem crua é preservada junto da versão normalizada.
 */

import { sha256Hex } from './canonical.js';

// ---------------------------------------------------------------------------
// Transporte declarado no argv
// ---------------------------------------------------------------------------

export const STREAM_JSON_OUTPUT_FORMAT = 'stream-json';

/** Objeto único emitido por `claude --print --output-format json`. */
export const JSON_OUTPUT_FORMAT = 'json';

/** `--output-format` ausente: a CLI cai no default `text`, ilegível aqui. */
export const OUTPUT_FORMAT_NOT_DECLARED = 'not_declared';

/** `--output-format` duplicado ou sem valor: transporte não é único. */
export const OUTPUT_FORMAT_UNKNOWN = 'unknown';

const OUTPUT_FORMAT_FLAG = '--output-format';

/**
 * Formato de saída derivado EXCLUSIVAMENTE do argv do perfil. Como no effort,
 * o que não está versionado no perfil não é evidência: settings pessoais e
 * variáveis de ambiente não entram na conta.
 */
export function claudeOutputFormat(argv: readonly string[]): string {
  const occurrences = argv.filter(
    (token) => token === OUTPUT_FORMAT_FLAG || token.startsWith(`${OUTPUT_FORMAT_FLAG}=`),
  ).length;
  if (occurrences === 0) return OUTPUT_FORMAT_NOT_DECLARED;

  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === OUTPUT_FORMAT_FLAG) {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) values.push(value);
      continue;
    }
    if (token.startsWith(`${OUTPUT_FORMAT_FLAG}=`)) {
      values.push(token.slice(OUTPUT_FORMAT_FLAG.length + 1));
    }
  }
  return occurrences === 1 && values.length === 1 ? (values[0] as string) : OUTPUT_FORMAT_UNKNOWN;
}

/** `true` só quando o perfil é Claude E declarou stream-json de forma única. */
export function usesClaudeStreamJson(agent: string, argv: readonly string[]): boolean {
  return agent === 'claude' && claudeOutputFormat(argv) === STREAM_JSON_OUTPUT_FORMAT;
}

/**
 * Lê somente o objeto único declarado pelo transporte `json`.
 *
 * Falha de parse ou qualquer valor que não seja objeto fica `null`: o caller
 * não pode transformar stdout arbitrário em evidência de falha do provider.
 */
export function readClaudeJsonResult(stdout: string): Record<string, unknown> | null {
  const bytes = stdout.trim();
  if (bytes === '') return null;
  try {
    const parsed: unknown = JSON.parse(bytes);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Observação de rate limit — terminologia deliberada
// ---------------------------------------------------------------------------

/**
 * Isto NÃO é "quota consumida pela tarefa". É o que a CLI observou e reportou
 * durante o run: a primeira observação pode chegar depois da primeira chamada,
 * e a janela pode ter sido movida por qualquer outra sessão da mesma conta.
 */
export interface ClaudeRateLimitObservation {
  /** Ordem de chegada no stream, 1-based. */
  readonly sequence: number;
  readonly status: string | null;
  /** Normalizado a partir de `rate_limit_type` ou `rateLimitType`. */
  readonly rate_limit_type: string | null;
  /** Valor RAW, exatamente como veio — sem reescala. */
  readonly utilization: number | null;
  readonly utilization_scale: 'fraction' | 'percentage' | null;
  /** Derivado: `fraction` vira `utilization * 100`; `percentage` passa direto. */
  readonly utilization_percentage: number | null;
  /**
   * FORMA CRUA do reset, preservada como veio: a CLI já emitiu string ISO e
   * epoch numérico. Converter um no outro exigiria adivinhar a unidade do
   * número (segundos? milissegundos?), então a identidade da janela é
   * comparação exata deste valor, e nada é reescrito.
   */
  readonly resets_at: string | number | null;
  readonly session_id: string | null;
  /** Overage: campos separados porque limite normal e overage são janelas distintas. */
  readonly overage_status: string | null;
  readonly overage_resets_at: string | number | null;
  readonly is_using_overage: boolean | null;
  /** Mensagem crua da CLI, preservada como evidência. */
  readonly raw: Record<string, unknown>;
}

export interface ClaudeStreamReading {
  readonly lines: number;
  /** Linhas não vazias que não são objeto JSON. */
  readonly invalid_lines: number;
  readonly results: readonly Record<string, unknown>[];
  /** Última mensagem `type=result`; `null` se o stream não trouxe nenhuma. */
  readonly result: Record<string, unknown> | null;
  readonly observations: readonly ClaudeRateLimitObservation[];
}

/**
 * Chaves onde a CLI pode aninhar os campos do evento. O protocolo já mudou de
 * forma antes; procurar um nível abaixo custa nada e evita perder a observação
 * inteira por causa de um envelope novo. Nada além disso é vasculhado: busca
 * profunda acharia campo homônimo de outro contexto e viraria invenção.
 */
const RATE_LIMIT_CONTAINER_KEYS = [
  // Envelope REAL observado em Claude Code 2.1.226 (evidência da M28): todos os
  // campos do evento chegam aninhados aqui, e nenhum deles no topo.
  'rate_limit_info',
  'rateLimitInfo',
  'rate_limit',
  'rateLimit',
  'rate_limits',
  'rateLimits',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Primeiro nome presente, no topo ou um nível abaixo num envelope conhecido. */
function pick(message: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (message[name] !== undefined) return message[name];
  }
  for (const key of RATE_LIMIT_CONTAINER_KEYS) {
    const nested = message[key];
    if (!isRecord(nested)) continue;
    for (const name of names) {
      if (nested[name] !== undefined) return nested[name];
    }
  }
  return undefined;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Instante de reset na forma em que chegou — string ISO ou epoch numérico. */
function asInstant(value: unknown): string | number | null {
  return asString(value) ?? asNumber(value);
}

/**
 * A CLI já emitiu `utilization` nas duas escalas ao longo das versões. O valor
 * raw fica intacto; o derivado assume fração em `[0, 1]` e percentual acima
 * disso. O limite exato (`1`) é lido como fração — 1 = 100%, conforme o
 * contrato desta manutenção — e por isso a escala assumida vai registrada.
 */
function utilizationScaleOf(utilization: number): 'fraction' | 'percentage' {
  return utilization <= 1 ? 'fraction' : 'percentage';
}

/** Ponto flutuante em pp acumula ruído (0.5000000000000004); 6 casas bastam. */
function round(value: number): number {
  return Number(value.toFixed(6));
}

function observationOf(
  message: Record<string, unknown>,
  sequence: number,
): ClaudeRateLimitObservation {
  const utilization = asNumber(pick(message, ['utilization']));
  const scale = utilization === null ? null : utilizationScaleOf(utilization);
  return {
    sequence,
    status: asString(pick(message, ['status'])),
    rate_limit_type: asString(pick(message, ['rate_limit_type', 'rateLimitType'])),
    utilization,
    utilization_scale: scale,
    utilization_percentage:
      utilization === null ? null : round(scale === 'fraction' ? utilization * 100 : utilization),
    resets_at: asInstant(pick(message, ['resets_at', 'resetsAt'])),
    session_id: asString(pick(message, ['session_id', 'sessionId'])),
    overage_status: asString(pick(message, ['overage_status', 'overageStatus'])),
    overage_resets_at: asInstant(pick(message, ['overage_resets_at', 'overageResetsAt'])),
    is_using_overage: asBoolean(pick(message, ['is_using_overage', 'isUsingOverage'])),
    raw: message,
  };
}

export function readClaudeStream(stdout: string): ClaudeStreamReading {
  const results: Record<string, unknown>[] = [];
  const observations: ClaudeRateLimitObservation[] = [];
  let lines = 0;
  let invalidLines = 0;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    lines += 1;

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      invalidLines += 1;
      continue;
    }
    if (!isRecord(message)) {
      invalidLines += 1;
      continue;
    }

    if (message['type'] === 'result') results.push(message);
    if (message['type'] === 'rate_limit_event') {
      observations.push(observationOf(message, observations.length + 1));
    }
  }

  return {
    lines,
    invalid_lines: invalidLines,
    results,
    result: results.at(-1) ?? null,
    observations,
  };
}

// ---------------------------------------------------------------------------
// Contrato do transporte — falha fechada
// ---------------------------------------------------------------------------

/**
 * Um perfil stream-json que termina sem exatamente um `result` legível não pode
 * ser tratado como run normal: o custo estimado, o status final e a sessão sairiam
 * `null` sem que ninguém soubesse por quê. Ausência de `rate_limit_event`, ao
 * contrário, NÃO é violação — a CLI não promete emitir evento em todo run.
 */
export function streamContractViolation(reading: ClaudeStreamReading): string | null {
  if (reading.results.length !== 1) {
    return `stream-json exige exatamente uma mensagem type=result; o stdout trouxe ${reading.results.length}`;
  }
  if (reading.invalid_lines > 0) {
    return `stdout de stream-json trouxe ${reading.invalid_lines} linha(s) que não são objeto JSON: o stream está incompleto ou corrompido`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Falha terminal declarada pelo provider
// ---------------------------------------------------------------------------

/** Único `terminal_reason` que a CLI usa para término normal da sessão. */
export const CLAUDE_TERMINAL_REASON_COMPLETED = 'completed';

/** O texto do erro vai preservado, mas limitado: o record não é um log. */
export const PROVIDER_FAILURE_MESSAGE_MAX_CHARS = 512;

/**
 * O que a mensagem `result` declara quando a SESSÃO terminou por falha do
 * provider ou do transporte até ele, e não por conclusão do trabalho.
 *
 * `signals` guarda quais campos motivaram a classificação — a decisão fica
 * auditável sem depender de reler o stdout.
 */
export interface ClaudeProviderFailure {
  readonly is_error: boolean;
  readonly terminal_reason: string | null;
  /** Status HTTP quando a CLI conseguiu um; `null` em falha de transporte. */
  readonly api_error_status: string | number | null;
  readonly subtype: string | null;
  readonly num_turns: number | null;
  /** Texto do erro, truncado; a íntegra continua no stdout preservado. */
  readonly message: string | null;
  /** Hash do texto INTEIRO — o truncamento não apaga a identidade da mensagem. */
  readonly message_sha256: string | null;
  readonly signals: readonly string[];
}

/**
 * Falha terminal do provider lida do `result` — NUNCA de texto de erro
 * específico. `ENOTFOUND` é o diagnóstico de um incidente; o contrato são os
 * campos que a CLI emite para declarar como a sessão terminou.
 *
 * A regra enumera o SUCESSO, não as falhas: `is_error=true` é falha, e
 * `terminal_reason` diferente de `completed` é falha. Um motivo terminal novo
 * cai automaticamente do lado seguro, em vez de passar por conclusão normal
 * porque ninguém o acrescentou a uma lista. `terminal_reason` ausente não
 * classifica nada sozinho: versão de CLI que não emite o campo continua sendo
 * julgada só por `is_error`.
 *
 * Consumo de tokens NÃO entra na regra. Uma API pode falhar depois de gastar
 * franquia; o que a classe descreve é o término da sessão, e o consumo real
 * observado segue registrado como veio.
 */
export function providerTerminalFailure(
  result: Record<string, unknown> | null,
): ClaudeProviderFailure | null {
  if (result === null) return null;

  const isError = result['is_error'] === true;
  const terminalReason = asString(result['terminal_reason']);
  const signals: string[] = [];
  if (isError) signals.push('is_error=true');
  if (terminalReason !== null && terminalReason !== CLAUDE_TERMINAL_REASON_COMPLETED) {
    signals.push(`terminal_reason=${terminalReason}`);
  }
  if (signals.length === 0) return null;

  const message = typeof result['result'] === 'string' ? (result['result'] as string) : null;
  return {
    is_error: isError,
    terminal_reason: terminalReason,
    api_error_status: asInstant(result['api_error_status']),
    subtype: asString(result['subtype']),
    num_turns: asNumber(result['num_turns']),
    message: message === null ? null : message.slice(0, PROVIDER_FAILURE_MESSAGE_MAX_CHARS),
    message_sha256: message === null ? null : sha256Hex(message),
    signals,
  };
}

// ---------------------------------------------------------------------------
// Delta observado — nunca "quota da tarefa"
// ---------------------------------------------------------------------------

export interface ClaudeRateLimitWindowDelta {
  readonly rate_limit_type: string;
  /** Mesma janela na primeira e na última observação; senão não há delta. */
  readonly resets_at: string | number;
  readonly first_utilization_percentage: number;
  readonly last_utilization_percentage: number;
  /**
   * Diferença em pontos percentuais ENTRE OBSERVAÇÕES, não consumo da tarefa:
   * a primeira observação pode ter chegado depois da primeira chamada, e outra
   * sessão da mesma conta pode ter mexido na mesma janela.
   */
  readonly observed_delta_pp: number;
  readonly observation_count: number;
}

export function rateLimitWindowDeltas(
  observations: readonly ClaudeRateLimitObservation[],
): ClaudeRateLimitWindowDelta[] {
  const byType = new Map<string, ClaudeRateLimitObservation[]>();
  for (const observation of observations) {
    const type = observation.rate_limit_type;
    if (type === null || observation.utilization_percentage === null) continue;
    const group = byType.get(type);
    if (group) group.push(observation);
    else byType.set(type, [observation]);
  }

  const deltas: ClaudeRateLimitWindowDelta[] = [];
  for (const [type, group] of byType) {
    if (group.length < 2) continue;
    const first = group[0] as ClaudeRateLimitObservation;
    const last = group.at(-1) as ClaudeRateLimitObservation;
    // Janela diferente entre a primeira e a última observação significa que o
    // limite virou no meio do run: subtrair ali compararia coisas distintas.
    if (first.resets_at === null || first.resets_at !== last.resets_at) continue;
    const firstPercentage = first.utilization_percentage as number;
    const lastPercentage = last.utilization_percentage as number;
    deltas.push({
      rate_limit_type: type,
      resets_at: first.resets_at,
      first_utilization_percentage: firstPercentage,
      last_utilization_percentage: lastPercentage,
      observed_delta_pp: round(lastPercentage - firstPercentage),
      observation_count: group.length,
    });
  }
  return deltas;
}
