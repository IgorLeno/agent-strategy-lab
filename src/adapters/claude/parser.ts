import { redactString } from '../../storage/index.js';
import type { ParsedProviderLine, ProviderObservation } from '../contract.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownLine(raw: string): ParsedProviderLine {
  return { event: { type: 'unknown', raw: redactString(raw) } };
}

function finiteNonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
] as const;

/** Soma somente os contadores de tokens documentados que a CLI efetivamente enviou. */
function tokensFrom(message: JsonObject): number | null {
  const usage = message['usage'];
  if (!isObject(usage)) return null;

  let sawTokenField = false;
  let total = 0;
  for (const field of TOKEN_FIELDS) {
    const value = usage[field];
    if (value === undefined) continue;
    sawTokenField = true;
    const tokens = finiteNonnegativeInteger(value);
    if (tokens === null) return null;
    total += tokens;
    if (!Number.isSafeInteger(total)) return null;
  }
  return sawTokenField ? total : null;
}

function terminalFrom(message: JsonObject): 'success' | 'failure' | null {
  if (message['is_error'] === true) return 'failure';
  if (typeof message['terminal_reason'] === 'string' && message['terminal_reason'] !== '') {
    return 'failure';
  }
  if (
    typeof message['subtype'] === 'string' &&
    message['subtype'] !== '' &&
    message['subtype'] !== 'success'
  ) {
    return 'failure';
  }
  if (message['is_error'] === false || message['subtype'] === 'success') return 'success';
  return null;
}

function observationFrom(message: JsonObject, terminal: 'success' | 'failure'): ProviderObservation {
  const observation: {
    usage: { tokens: number | null };
    terminal: 'success' | 'failure';
    cost?: { amount: number | null; currency: string };
  } = {
    usage: { tokens: tokensFrom(message) },
    terminal,
  };

  if (Object.hasOwn(message, 'total_cost_usd')) {
    const amount = message['total_cost_usd'];
    observation.cost = {
      amount:
        typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null,
      // `total_cost_usd` é a estimativa API-equivalent emitida pela própria CLI.
      currency: 'USD',
    };
  }
  return observation;
}

function parseResult(message: JsonObject): ParsedProviderLine | null {
  const terminal = terminalFrom(message);
  if (terminal === null) return null;

  return {
    event: {
      type: 'result',
      outcome: terminal,
      tokens: tokensFrom(message),
      // O stream Claude não relata arquivos alterados; ausência não vira zero.
      changed_files: null,
    },
    observation: observationFrom(message, terminal),
  };
}

function contentBlocks(message: JsonObject): unknown[] | null {
  const envelope = message['message'];
  if (!isObject(envelope)) return null;
  const content = envelope['content'];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : null;
}

function parseAssistant(message: JsonObject): ParsedProviderLine | null {
  const blocks = contentBlocks(message);
  if (blocks === null) return null;

  const meaningful = blocks.filter(
    (block): block is JsonObject => isObject(block) && block['type'] !== 'thinking',
  );
  const texts = meaningful.filter(
    (block) => block['type'] === 'text' && typeof block['text'] === 'string',
  );
  if (texts.length === meaningful.length) {
    return {
      event: {
        type: 'message',
        role: 'assistant',
        text: texts.map((block) => block['text'] as string).join(''),
      },
    };
  }

  if (meaningful.length === 1) {
    const block = meaningful[0];
    if (block?.['type'] === 'tool_use' && typeof block['name'] === 'string' && block['name'] !== '') {
      return { event: { type: 'tool_call', name: block['name'], input: block['input'] } };
    }
  }
  return null;
}

function parseUser(message: JsonObject): ParsedProviderLine | null {
  const blocks = contentBlocks(message);
  if (blocks === null) return null;
  if (blocks.every((block) => isObject(block) && block['type'] === 'text' && typeof block['text'] === 'string')) {
    return {
      event: {
        type: 'message',
        role: 'user',
        text: blocks.map((block) => (block as JsonObject)['text'] as string).join(''),
      },
    };
  }
  if (blocks.length === 1) {
    const block = blocks[0];
    if (isObject(block) && block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string' && block['tool_use_id'] !== '') {
      return {
        event: {
          type: 'tool_result',
          name: block['tool_use_id'],
          output: block['content'],
        },
      };
    }
  }
  return null;
}

/** Traduz uma linha do `--output-format stream-json` sem decidir estado do processo. */
export function parseClaudeLine(raw: string): ParsedProviderLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownLine(raw);
  }
  if (!isObject(parsed)) return unknownLine(raw);

  const normalized =
    parsed['type'] === 'result'
      ? parseResult(parsed)
      : parsed['type'] === 'assistant'
        ? parseAssistant(parsed)
        : parsed['type'] === 'user'
          ? parseUser(parsed)
          : null;
  return normalized ?? unknownLine(raw);
}
