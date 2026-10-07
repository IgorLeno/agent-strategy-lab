/**
 * Linha de `opencode run --format json` → evento do transcript ao vivo.
 *
 * Formato verificado no opencode 1.18.23 (fixture `test/fixtures/real/`):
 * `text` traz a mensagem do agente; `tool_use` só chega com a ferramenta já
 * resolvida (`state.status` completed/error), então vira `tool_result` com
 * entrada e desfecho juntos. Tokens não saem daqui: a soma por run é de
 * `openCodeRunUsageOf`.
 */
import { redactString } from '../redaction.js';
import type { ParsedProviderLine } from '../contract.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownLine(raw: string): ParsedProviderLine {
  return { event: { type: 'unknown', raw: redactString(raw) } };
}

export function parseOpenCodeLine(raw: string): ParsedProviderLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownLine(raw);
  }
  if (!isObject(parsed) || !isObject(parsed['part'])) return unknownLine(raw);
  const part = parsed['part'];

  if (parsed['type'] === 'text' && typeof part['text'] === 'string') {
    return { event: { type: 'message', role: 'assistant', text: part['text'] } };
  }

  if (parsed['type'] === 'tool_use' && typeof part['tool'] === 'string' && part['tool'] !== '') {
    const state = isObject(part['state']) ? part['state'] : {};
    return {
      event: {
        type: 'tool_result',
        name: part['tool'],
        output: {
          input: state['input'] ?? null,
          status: state['status'] ?? null,
          output: state['output'] ?? state['error'] ?? null,
        },
      },
    };
  }
  return unknownLine(raw);
}
