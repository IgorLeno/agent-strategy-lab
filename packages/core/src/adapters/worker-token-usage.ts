// Portado de dev/lib/worker-token-usage.ts (agent-strategy-lab 2052cca). O original fica congelado.
/**
 * Consumo de tokens OBSERVADO no stream de eventos do próprio provider.
 *
 * Isto não é billing e não é quota: é a contagem que o provider reporta sobre a
 * inferência que ele mesmo acabou de executar. Ela é a evidência mais direta
 * que o harness tem de que houve inferência — mais direta, inclusive, que
 * qualquer medidor de assinatura, que é uma leitura EXTERNA e provider-específica
 * do saldo de uma conta.
 *
 * O que este módulo NÃO faz: não estima, não converte token em dólar, não
 * infere de exit code e não completa campo ausente. Stream sem contagem
 * devolve `null`, e `null` continua sendo UNKNOWN em todo consumidor.
 */

import { openCodeRunUsageOf } from './opencode-scaffold.js';

/**
 * Semântica ÚNICA entre scaffolds (normalizada em 2026-10-07 contra streams
 * reais): `input` inclui o que veio de/foi para cache e `cached_input` é
 * subconjunto dele; `output` inclui reasoning e `reasoning` é subconjunto dele;
 * `total = input + output`. Cada provider reporta essas partes de um jeito —
 * a tradução fica aqui, não no consumidor.
 */
export interface ObservedWorkerTokens {
  /** `input + output`; sempre > 0 quando o objeto existe. */
  readonly total: number;
  readonly input: number | null;
  readonly cached_input: number | null;
  readonly output: number | null;
  readonly reasoning: number | null;
  readonly provenance: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function assemble(
  parts: {
    readonly input: number | null;
    readonly cached_input: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
  },
  provenance: string,
): ObservedWorkerTokens | null {
  // `cached_input` ⊂ `input` e `reasoning` ⊂ `output`: somá-los contaria o
  // mesmo token duas vezes.
  const total = (parts.input ?? 0) + (parts.output ?? 0);
  if (total <= 0) return null;
  return { total, ...parts, provenance };
}

/**
 * Codex `exec --json`: o evento `turn.completed` carrega `usage`, com
 * `cached_input_tokens` ⊂ `input_tokens` e `reasoning_output_tokens` ⊂
 * `output_tokens` (codex 0.158.0: reasoning < output em todos os streams reais,
 * e `output − reasoning` estável para o mesmo prompt). Um turno
 * pode aparecer mais de uma vez num stream retomado; o ÚLTIMO é o que descreve
 * o estado final do turno.
 */
export function codexObservedTokens(stdout: string): ObservedWorkerTokens | null {
  let usage: Record<string, unknown> | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.includes('"turn.completed"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed['type'] !== 'turn.completed') continue;
    if (isRecord(parsed['usage'])) usage = parsed['usage'];
  }
  if (usage === null) return null;
  return assemble(
    {
      input: count(usage['input_tokens']),
      cached_input: count(usage['cached_input_tokens']),
      output: count(usage['output_tokens']),
      reasoning: count(usage['reasoning_output_tokens']),
    },
    'codex exec --json: evento turn.completed.usage',
  );
}

/**
 * Claude: a mensagem `type=result` do stream-json (e o objeto único de
 * `--output-format json`) trazem `usage` com o mesmo formato da API.
 */
export function claudeObservedTokens(result: unknown): ObservedWorkerTokens | null {
  if (!isRecord(result) || !isRecord(result['usage'])) return null;
  const usage = result['usage'];
  const cacheRead = count(usage['cache_read_input_tokens']);
  const cacheCreation = count(usage['cache_creation_input_tokens']);
  const cached =
    cacheRead === null && cacheCreation === null ? null : (cacheRead ?? 0) + (cacheCreation ?? 0);
  return assemble(
    {
      // O `input_tokens` do Claude exclui o que veio de cache; o total honesto
      // do run inclui os dois, e `cached_input` continua nomeado à parte.
      input: count(usage['input_tokens']) === null && cached === null
        ? null
        : (count(usage['input_tokens']) ?? 0) + (cached ?? 0),
      cached_input: cached,
      output: count(usage['output_tokens']),
      reasoning: null,
    },
    'claude stream-json: mensagem type=result usage',
  );
}

export interface ObservedWorkerTokensInput {
  readonly agent: string;
  readonly stdout: string;
  /** Mensagem `type=result` já lida por `readClaudeStream`, quando existir. */
  readonly streamResult?: unknown;
}

/**
 * Tokens que o OpenCode reportou sobre ESTE run, do evento `step_finish` do
 * `--format json`. Ausência permanece `null` — `opencode stats` agrega todas as
 * sessões locais e não serve para atribuir consumo a uma task.
 */
function openCodeObservedTokens(stdout: string): ObservedWorkerTokens | null {
  const usage = openCodeRunUsageOf(stdout);
  if (usage.total_tokens === null || usage.total_tokens <= 0) return null;
  // O OpenCode reporta input fresco, cache read/write, output e reasoning como
  // partes DISJUNTAS (`total` é a soma; opencode 1.18.23 teve reasoning >
  // output). Normaliza para cache ⊂ input e reasoning ⊂ output.
  const cached = sumKnown(usage.cache_read_tokens, usage.cache_write_tokens);
  const input = sumKnown(usage.input_tokens, cached);
  const output = sumKnown(usage.output_tokens, usage.reasoning_tokens);
  return {
    total: usage.total_tokens,
    input,
    cached_input: cached,
    output,
    reasoning: usage.reasoning_tokens,
    provenance: 'opencode_run_json:step_finish.part.tokens',
  };
}

/** Soma o que foi reportado; `null` só quando nenhuma parte foi. */
function sumKnown(...parts: readonly (number | null)[]): number | null {
  return parts.every((part) => part === null) ? null : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
}

export function observedWorkerTokens(input: ObservedWorkerTokensInput): ObservedWorkerTokens | null {
  if (input.agent === 'codex') return codexObservedTokens(input.stdout);
  if (input.agent === 'opencode') return openCodeObservedTokens(input.stdout);
  if (input.agent === 'claude') {
    const fromStream = claudeObservedTokens(input.streamResult ?? null);
    if (fromStream !== null) return fromStream;
    const text = input.stdout.trim();
    if (text === '') return null;
    try {
      return claudeObservedTokens(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return null;
}
