// Portado de test/dev/codex-transport.test.ts (agent-strategy-lab 2052cca), sem classifyTermination nem extractRoleModelJson.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  codexProviderTerminalFailure,
  codexUsesEventStream,
  decodeCodexEventStream,
} from '../../src/adapters/codex-transport.js';

const SUCCESS_FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'codex-exec-json-success.jsonl');
const FAILURE_FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'codex-exec-json-turn-failed.jsonl');

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
