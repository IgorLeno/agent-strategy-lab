/**
 * Decoder do TRANSPORTE de `codex exec --json`.
 *
 * Contrato real da CLI instalada (codex-cli 0.149.0, `--json`: "Print events
 * to stdout as JSONL"; evidência gravada em
 * `fixtures/codex-exec-json-success.jsonl` e
 * `fixtures/codex-exec-json-turn-failed.jsonl`):
 *
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"<payload do modelo>"}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * e, em falha terminal do provider:
 *
 *   {"type":"error","message":"..."}
 *   {"type":"turn.failed","error":{"message":"..."}}
 *
 * Transporte != payload do modelo: este módulo só interpreta o envelope JSONL
 * e devolve o TEXTO da última `agent_message`. O JSON do draft continua
 * passando pelo contrato estrito de extração/normalização — nada aqui relaxa
 * schema nem "acha JSON" por regex sobre o stream inteiro.
 */

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `--json` declarado uma única vez no argv do profile Codex. */
export function codexUsesEventStream(argv: readonly string[]): boolean {
  return argv.filter((token) => token === '--json').length === 1;
}

export type CodexEventStreamDecoding =
  | { readonly outcome: 'AGENT_MESSAGE'; readonly text: string }
  | { readonly outcome: 'TURN_FAILED'; readonly message: string }
  | { readonly outcome: 'NO_AGENT_MESSAGE'; readonly message: string }
  | { readonly outcome: 'TRANSPORT_MALFORMED'; readonly message: string };

function failureMessageOf(event: JsonObject): string {
  if (typeof event['message'] === 'string' && event['message'].trim() !== '') return event['message'];
  const error = event['error'];
  if (isObject(error) && typeof error['message'] === 'string' && error['message'].trim() !== '') {
    return error['message'];
  }
  return `evento terminal de falha sem mensagem (${String(event['type'])})`;
}

/**
 * Decodifica o stream de eventos. Sem reparo: linha não-JSON, stream vazio ou
 * stream sem evento terminal são TRANSPORT_MALFORMED — nunca uma tentativa de
 * regex sobre o texto bruto.
 */
export function decodeCodexEventStream(stdout: string): CodexEventStreamDecoding {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      outcome: 'TRANSPORT_MALFORMED',
      message: 'stdout vazio: `codex exec --json` deveria emitir eventos JSONL',
    };
  }

  let lastAgentMessage: string | null = null;
  let turnCompleted = false;
  let failure: string | null = null;

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return {
        outcome: 'TRANSPORT_MALFORMED',
        message: `linha ${index + 1} do stream JSONL não é JSON: ${line.slice(0, 120)}`,
      };
    }
    if (!isObject(parsed) || typeof parsed['type'] !== 'string') {
      return {
        outcome: 'TRANSPORT_MALFORMED',
        message: `linha ${index + 1} do stream JSONL não é um evento com type: ${line.slice(0, 120)}`,
      };
    }

    const type = parsed['type'];
    if (type === 'turn.failed' || type === 'error') {
      failure = failureMessageOf(parsed);
      continue;
    }
    if (type === 'turn.completed') {
      turnCompleted = true;
      continue;
    }
    if (type === 'item.completed') {
      const item = parsed['item'];
      if (isObject(item) && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
        lastAgentMessage = item['text'];
      }
    }
  }

  if (failure !== null) {
    return { outcome: 'TURN_FAILED', message: failure };
  }
  if (!turnCompleted) {
    return {
      outcome: 'TRANSPORT_MALFORMED',
      message: 'stream JSONL terminou sem turn.completed nem falha terminal: transporte truncado',
    };
  }
  if (lastAgentMessage === null) {
    return {
      outcome: 'NO_AGENT_MESSAGE',
      message: 'turn.completed sem nenhuma agent_message: o provider terminou sem payload de modelo',
    };
  }
  return { outcome: 'AGENT_MESSAGE', text: lastAgentMessage };
}
