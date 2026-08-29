import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  codexProviderTerminalFailure,
  codexUsesEventStream,
  decodeCodexEventStream,
} from '../../dev/lib/codex-transport.js';
import { classifyTermination } from '../../dev/lib/launch.js';
import { extractRoleModelJson } from '../../dev/lib/project-orchestrate.js';
import { REPO_ROOT } from './helpers.js';

const SUCCESS_FIXTURE = path.join(REPO_ROOT, 'fixtures', 'codex-exec-json-success.jsonl');
const FAILURE_FIXTURE = path.join(REPO_ROOT, 'fixtures', 'codex-exec-json-turn-failed.jsonl');

const CODEX_JSON_ARGV = ['codex', 'exec', '--json', '--sandbox', 'read-only', '-'] as const;

describe('decodeCodexEventStream — contrato REAL de codex exec --json (JSONL)', () => {
  it('fixture real de sucesso: extrai o texto da agent_message', async () => {
    const stdout = await readFile(SUCCESS_FIXTURE, 'utf8');
    const decoded = decodeCodexEventStream(stdout);
    expect(decoded).toEqual({ outcome: 'AGENT_MESSAGE', text: '{"probe":true}' });
  });

  it('fixture real de falha: turn.failed é falha terminal do provider, com mensagem', async () => {
    const stdout = await readFile(FAILURE_FIXTURE, 'utf8');
    const decoded = decodeCodexEventStream(stdout);
    expect(decoded.outcome).toBe('TURN_FAILED');
    if (decoded.outcome !== 'TURN_FAILED') return;
    expect(decoded.message).toContain('not supported');
  });

  it('turn.failed de quota vira falha terminal tipada — não FINISHED', async () => {
    const message =
      "You've hit your usage limit. Upgrade to Pro or try again at 4:45 AM.";
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      JSON.stringify({ type: 'error', message }),
      JSON.stringify({ type: 'turn.failed', error: { message } }),
    ].join('\n');
    const failure = codexProviderTerminalFailure(stdout);
    expect(failure).toMatchObject({
      is_error: true,
      terminal_reason: 'turn.failed',
      message,
      signals: ['turn.failed'],
    });
    expect(
      classifyTermination({
        terminationCause: null,
        terminationDetail: null,
        exitCode: 1,
        signal: null,
        survivorsRemaining: [],
        streamViolation: null,
        providerFailure: failure,
      }),
    ).toMatchObject({ classification: 'INFRA_ERROR' });
  });

  it('turn.completed sem falha não inventa provider failure', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join('\n');
    expect(codexProviderTerminalFailure(stdout)).toBeNull();
  });

  it('várias agent_message: a última é o payload', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"draft parcial"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"schema_version\\":1}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join('\n');
    expect(decodeCodexEventStream(stdout)).toEqual({
      outcome: 'AGENT_MESSAGE',
      text: '{"schema_version":1}',
    });
  });

  it('linha não-JSON é transporte malformado, não tentativa de regex', () => {
    const stdout = ['{"type":"turn.started"}', 'garbage not json'].join('\n');
    const decoded = decodeCodexEventStream(stdout);
    expect(decoded.outcome).toBe('TRANSPORT_MALFORMED');
  });

  it('stream truncado (sem terminal) é transporte malformado', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{}"}}',
    ].join('\n');
    expect(decodeCodexEventStream(stdout).outcome).toBe('TRANSPORT_MALFORMED');
  });

  it('stdout vazio é transporte malformado', () => {
    expect(decodeCodexEventStream('').outcome).toBe('TRANSPORT_MALFORMED');
  });

  it('turn.completed sem agent_message: transporte válido sem payload do modelo', () => {
    const stdout = [
      '{"type":"turn.started"}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":0}}',
    ].join('\n');
    expect(decodeCodexEventStream(stdout).outcome).toBe('NO_AGENT_MESSAGE');
  });

  it('codexUsesEventStream exige exatamente um --json', () => {
    expect(codexUsesEventStream(CODEX_JSON_ARGV)).toBe(true);
    expect(codexUsesEventStream(['codex', 'exec'])).toBe(false);
    expect(codexUsesEventStream(['codex', '--json', 'exec', '--json'])).toBe(false);
  });
});

describe('extractRoleModelJson — Codex event stream', () => {
  const draft = { schema_version: 1, tasks: [{ task_id: 'T1' }] };

  function stream(text: string): string {
    return [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"turn.started"}',
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }),
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join('\n');
  }

  it('TRANSPORT VALID + MODEL PAYLOAD VALID: extrai o JSON do draft', () => {
    const extracted = extractRoleModelJson({
      agent: 'codex',
      argv: [...CODEX_JSON_ARGV],
      stdout: stream(JSON.stringify(draft)),
    });
    expect(extracted).toEqual({ outcome: 'EXTRACTED', value: draft });
  });

  it('payload em fence markdown continua legível', () => {
    const extracted = extractRoleModelJson({
      agent: 'codex',
      argv: [...CODEX_JSON_ARGV],
      stdout: stream('```json\n' + JSON.stringify(draft) + '\n```'),
    });
    expect(extracted).toEqual({ outcome: 'EXTRACTED', value: draft });
  });

  it('TRANSPORT VALID + MODEL PAYLOAD INVALID: NOT_PARSEABLE, não transporte', () => {
    const extracted = extractRoleModelJson({
      agent: 'codex',
      argv: [...CODEX_JSON_ARGV],
      stdout: stream('desculpe, não consigo gerar o plano'),
    });
    expect(extracted.outcome).toBe('NOT_PARSEABLE');
  });

  it('TRANSPORT MALFORMED é diagnóstico distinto de payload inválido', () => {
    const extracted = extractRoleModelJson({
      agent: 'codex',
      argv: [...CODEX_JSON_ARGV],
      stdout: 'not a jsonl stream at all',
    });
    expect(extracted.outcome).toBe('TRANSPORT_MALFORMED');
  });

  it('PROVIDER TERMINAL FAILURE vem do turn.failed real', async () => {
    const extracted = extractRoleModelJson({
      agent: 'codex',
      argv: [...CODEX_JSON_ARGV],
      stdout: await readFile(FAILURE_FIXTURE, 'utf8'),
    });
    expect(extracted.outcome).toBe('PROVIDER_TERMINAL_FAILURE');
  });

  it('Codex SEM --json continua no fallback de payload textual direto', () => {
    const extracted = extractRoleModelJson({
      agent: 'codex',
      argv: ['codex', 'exec'],
      stdout: JSON.stringify(draft),
    });
    expect(extracted).toEqual({ outcome: 'EXTRACTED', value: draft });
  });
});

describe('extractRoleModelJson — Claude stream-json', () => {
  const draft = { schema_version: 1, tasks: [{ task_id: 'T1' }] };
  const STREAM_ARGV = ['claude', '--print', '--output-format', 'stream-json', '--verbose'] as const;

  it('mensagem type=result carrega o payload do modelo', () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({
        type: 'result',
        is_error: false,
        terminal_reason: 'completed',
        result: JSON.stringify(draft),
      }),
    ].join('\n');
    const extracted = extractRoleModelJson({ agent: 'claude', argv: [...STREAM_ARGV], stdout });
    expect(extracted).toEqual({ outcome: 'EXTRACTED', value: draft });
  });

  it('stream sem result é transporte malformado', () => {
    const stdout = JSON.stringify({ type: 'system', subtype: 'init' });
    const extracted = extractRoleModelJson({ agent: 'claude', argv: [...STREAM_ARGV], stdout });
    expect(extracted.outcome).toBe('TRANSPORT_MALFORMED');
  });

  it('is_error no result do stream é falha terminal do provider', () => {
    const stdout = JSON.stringify({
      type: 'result',
      is_error: true,
      terminal_reason: 'api_error',
      result: 'API Error: overloaded',
    });
    const extracted = extractRoleModelJson({ agent: 'claude', argv: [...STREAM_ARGV], stdout });
    expect(extracted.outcome).toBe('PROVIDER_TERMINAL_FAILURE');
  });
});
