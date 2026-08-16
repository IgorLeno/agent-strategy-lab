import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseClaudeLine } from '../../src/adapters/index.js';

const FIXTURE = path.resolve(
  import.meta.dirname,
  '../../fixtures/provider-streams/claude-success.jsonl',
);

describe('Claude stream parser', () => {
  it('traduz fixture representativo sem chamar a CLI ou o provider', () => {
    const parsed = fs
      .readFileSync(FIXTURE, 'utf8')
      .trim()
      .split('\n')
      .map(parseClaudeLine);

    expect(parsed[0]?.event).toMatchObject({ type: 'unknown' });
    expect(parsed[0]?.event.type === 'unknown' ? parsed[0].event.raw : '').not.toContain(
      'fixture-session',
    );
    expect(parsed.slice(1).map((line) => line.event)).toEqual([
      { type: 'message', role: 'assistant', text: 'Patch concluído.' },
      { type: 'tool_call', name: 'Read', input: { file_path: 'src/index.ts' } },
      { type: 'tool_result', name: 'toolu_fixture', output: 'export {};' },
      { type: 'result', outcome: 'success', tokens: 1570, changed_files: null },
    ]);
    expect(parsed.at(-1)?.observation).toEqual({
      usage: { tokens: 1570 },
      cost: { amount: 0.4231, currency: 'USD' },
      terminal: 'success',
    });
  });

  it('preserva classificação terminal failure como observation, sem produzir ExecutionStatus', () => {
    const parsed = parseClaudeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: { input_tokens: 12, output_tokens: 3 },
      }),
    );

    expect(parsed.event).toEqual({
      type: 'result',
      outcome: 'failure',
      tokens: 15,
      changed_files: null,
    });
    expect(parsed.observation).toEqual({ usage: { tokens: 15 }, terminal: 'failure' });
    expect(parsed).not.toHaveProperty('status');
  });

  it('trata indicador terminal de falha de forma conservadora quando os campos conflitam', () => {
    const parsed = parseClaudeLine(
      '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"api_error"}',
    );

    expect(parsed.event).toMatchObject({ type: 'result', outcome: 'failure' });
    expect(parsed.observation?.terminal).toBe('failure');
  });

  it('mantém usage nulo e cost ausente quando o result não os informa', () => {
    const parsed = parseClaudeLine('{"type":"result","subtype":"success"}');

    expect(parsed.event).toMatchObject({ type: 'result', tokens: null });
    expect(parsed.observation).toEqual({ usage: { tokens: null }, terminal: 'success' });
  });

  it('preserva cost inválido como amount null, sem inventar zero', () => {
    const parsed = parseClaudeLine(
      '{"type":"result","is_error":false,"total_cost_usd":"0.42","usage":{}}',
    );

    expect(parsed.observation?.cost).toEqual({ amount: null, currency: 'USD' });
    expect(parsed.observation?.usage).toEqual({ tokens: null });
  });

  it.each([
    ['JSON truncado', '{"type":"result"'],
    ['JSON escalar', '42'],
    ['result sem classificação terminal', '{"type":"result","usage":{"input_tokens":1}}'],
    ['assistant com múltiplos eventos irredutíveis', '{"type":"assistant","message":{"content":[{"type":"text","text":"x"},{"type":"tool_use","name":"Read","input":{}}]}}'],
  ])('trata %s deterministicamente como unknown', (_label, raw) => {
    const first = parseClaudeLine(raw);
    expect(first).toEqual(parseClaudeLine(raw));
    expect(first.event.type).toBe('unknown');
  });

  it('sanitiza segredo em input malformado antes de preservá-lo', () => {
    const parsed = parseClaudeLine('authorization: Bearer secret-value');

    expect(parsed.event).toMatchObject({ type: 'unknown' });
    expect(parsed.event.type === 'unknown' ? parsed.event.raw : '').not.toContain('secret-value');
  });
});
