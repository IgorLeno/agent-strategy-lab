/**
 * Evento de provider (já normalizado pelo core) → item compacto do transcript.
 *
 * Negação de ferramenta é reconhecida pelo texto que cada CLI devolve
 * (formatos dos fixtures reais em packages/core/test/fixtures/real/):
 *   Claude 2.1.281:   tool_result "Permission to use Bash ... has been denied." /
 *                     "Permission for this tool use was denied ..."
 *   OpenCode 1.18.23: tool_use com status "error" e "...rule which prevents you..."
 *   Codex 0.158.0:    não sinaliza negação; o sandbox faz o comando falhar
 *                     (aparece como `error`, não `denied`).
 */
import type { ProviderEvent } from '@asl/core';

import type { TranscriptItem } from '../shared/ipc.js';

const DENIAL = /permission\b.*\bdenied|was denied|denied automatically|rule which prevents you/i;
const SUMMARY_MAX = 200;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX)}…` : line;
}

/** Texto legível de um `output` de ferramenta em qualquer dos três formatos. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => (isObject(block) && typeof block['text'] === 'string' ? block['text'] : ''))
      .join('\n');
  }
  if (isObject(value)) {
    for (const key of ['aggregated_output', 'output', 'error']) {
      const inner = value[key];
      if (inner !== undefined && inner !== null) return textOf(inner);
    }
    return JSON.stringify(value);
  }
  return value === null || value === undefined ? '' : String(value);
}

/** Argumento que identifica a chamada: comando, arquivo, padrão ou consulta. */
export function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return oneLine(input);
  if (!isObject(input)) return '';
  for (const key of ['command', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') return oneLine(value);
  }
  return oneLine(JSON.stringify(input));
}

function resultStatus(output: unknown, text: string): 'ok' | 'error' | 'denied' {
  if (DENIAL.test(text)) return 'denied';
  if (isObject(output)) {
    const status = output['status'];
    if (status === 'error' || status === 'failed') return 'error';
    const exitCode = output['exit_code'];
    if (typeof exitCode === 'number' && exitCode !== 0) return 'error';
  }
  return 'ok';
}

/**
 * Um por tentativa. Claude e Codex identificam o resultado por id, não por
 * nome; o nome vem da última chamada vista.
 */
export class TranscriptMapper {
  private lastCall = '';

  map(event: ProviderEvent | null): TranscriptItem | null {
    if (event === null) return null;
    switch (event.type) {
      case 'message':
        return event.text.trim() === '' ? null : { kind: 'message', role: event.role, text: event.text };
      case 'tool_call':
        this.lastCall = event.name;
        return { kind: 'tool_call', name: event.name, summary: summarizeInput(event.input) };
      case 'tool_result': {
        const output = event.output;
        const text = textOf(output);
        // OpenCode só emite o resultado, com a entrada junto.
        const input = isObject(output) && 'input' in output ? summarizeInput(output['input']) : '';
        const name = isObject(output) && 'input' in output ? event.name : this.lastCall || event.name;
        const status = resultStatus(output, text);
        const summary = input !== '' ? (status === 'ok' ? input : `${input} — ${oneLine(text)}`) : oneLine(text);
        return { kind: 'tool_result', name, status, summary };
      }
      case 'result':
      case 'unknown':
        return null;
    }
  }
}
