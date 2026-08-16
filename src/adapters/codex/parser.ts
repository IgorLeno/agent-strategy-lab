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

/** Soma somente os contadores não sobrepostos do `turn.completed`. */
function tokensFrom(message: JsonObject): number | null {
  const usage = message['usage'];
  if (!isObject(usage)) return null;

  const input = finiteNonnegativeInteger(usage['input_tokens']);
  const output = finiteNonnegativeInteger(usage['output_tokens']);
  if (input === null || output === null) return null;

  const total = input + output;
  return Number.isSafeInteger(total) ? total : null;
}

function terminalLine(
  message: JsonObject,
  terminal: 'success' | 'failure',
): ParsedProviderLine {
  const tokens = terminal === 'success' ? tokensFrom(message) : null;
  const observation: ProviderObservation = {
    usage: { tokens },
    terminal,
  };

  return {
    event: {
      type: 'result',
      outcome: terminal,
      tokens,
      // O stream Codex não relata um total terminal de arquivos distintos.
      changed_files: null,
    },
    observation,
  };
}

function itemFrom(message: JsonObject): JsonObject | null {
  const item = message['item'];
  return isObject(item) && typeof item['id'] === 'string' && item['id'] !== ''
    ? item
    : null;
}

function parseStartedItem(message: JsonObject): ParsedProviderLine | null {
  const item = itemFrom(message);
  if (item === null) return null;

  if (item['type'] === 'command_execution' && typeof item['command'] === 'string') {
    return {
      event: {
        type: 'tool_call',
        name: 'command_execution',
        input: { command: item['command'] },
      },
    };
  }

  if (
    item['type'] === 'mcp_tool_call' &&
    typeof item['server'] === 'string' &&
    item['server'] !== '' &&
    typeof item['tool'] === 'string' &&
    item['tool'] !== ''
  ) {
    return {
      event: {
        type: 'tool_call',
        name: `${item['server']}/${item['tool']}`,
        input: item['arguments'],
      },
    };
  }

  if (item['type'] === 'web_search' && typeof item['query'] === 'string') {
    return {
      event: { type: 'tool_call', name: 'web_search', input: { query: item['query'] } },
    };
  }
  return null;
}

function parseCompletedItem(message: JsonObject): ParsedProviderLine | null {
  const item = itemFrom(message);
  if (item === null) return null;

  if (item['type'] === 'agent_message' && typeof item['text'] === 'string') {
    return { event: { type: 'message', role: 'assistant', text: item['text'] } };
  }

  if (item['type'] === 'command_execution' && typeof item['aggregated_output'] === 'string') {
    return {
      event: {
        type: 'tool_result',
        name: item['id'] as string,
        output: {
          aggregated_output: item['aggregated_output'],
          exit_code: item['exit_code'] ?? null,
          status: item['status'],
        },
      },
    };
  }

  if (item['type'] === 'file_change' && Array.isArray(item['changes'])) {
    return {
      event: {
        type: 'tool_result',
        name: item['id'] as string,
        output: { changes: item['changes'], status: item['status'] },
      },
    };
  }

  if (item['type'] === 'mcp_tool_call') {
    return {
      event: {
        type: 'tool_result',
        name: item['id'] as string,
        output: item['result'] ?? item['error'] ?? null,
      },
    };
  }

  if (item['type'] === 'web_search' && typeof item['query'] === 'string') {
    return {
      event: {
        type: 'tool_result',
        name: item['id'] as string,
        output: { query: item['query'] },
      },
    };
  }

  if (item['type'] === 'error' && typeof item['message'] === 'string') {
    return { event: { type: 'message', role: 'system', text: item['message'] } };
  }
  return null;
}

/** Traduz uma linha de `codex exec --json` sem decidir estado do processo. */
export function parseCodexLine(raw: string): ParsedProviderLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unknownLine(raw);
  }
  if (!isObject(parsed)) return unknownLine(raw);

  const normalized =
    parsed['type'] === 'turn.completed'
      ? terminalLine(parsed, 'success')
      : parsed['type'] === 'turn.failed' || parsed['type'] === 'error'
        ? terminalLine(parsed, 'failure')
        : parsed['type'] === 'item.started'
          ? parseStartedItem(parsed)
          : parsed['type'] === 'item.completed'
            ? parseCompletedItem(parsed)
            : null;
  return normalized ?? unknownLine(raw);
}
