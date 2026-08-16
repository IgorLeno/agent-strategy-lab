import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseCodexLine } from '../../src/adapters/index.js';

const FIXTURE = path.resolve(
  import.meta.dirname,
  '../../fixtures/provider-streams/codex-success.jsonl',
);

describe('Codex stream parser', () => {
  it('traduz fixture representativo sem chamar a CLI ou o provider', () => {
    const parsed = fs
      .readFileSync(FIXTURE, 'utf8')
      .trim()
      .split('\n')
      .map(parseCodexLine);

    expect(parsed.slice(0, 2).every((line) => line.event.type === 'unknown')).toBe(true);
    expect(parsed.slice(2).map((line) => line.event)).toEqual([
      { type: 'message', role: 'assistant', text: 'Patch concluído.' },
      {
        type: 'tool_call',
        name: 'command_execution',
        input: { command: 'pnpm test -- codex' },
      },
      {
        type: 'tool_result',
        name: 'item_1',
        output: { aggregated_output: '1 passed', exit_code: 0, status: 'completed' },
      },
      {
        type: 'tool_result',
        name: 'item_2',
        output: {
          changes: [{ path: 'src/index.ts', kind: 'update' }],
          status: 'completed',
        },
      },
      { type: 'result', outcome: 'success', tokens: 1540, changed_files: null },
    ]);
    expect(parsed.at(-1)?.observation).toEqual({
      usage: { tokens: 1540 },
      terminal: 'success',
    });
  });

  it('preserva terminal failure como observation sem produzir ExecutionStatus', () => {
    const parsed = parseCodexLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'provider unavailable' } }),
    );

    expect(parsed.event).toEqual({
      type: 'result',
      outcome: 'failure',
      tokens: null,
      changed_files: null,
    });
    expect(parsed.observation).toEqual({ usage: { tokens: null }, terminal: 'failure' });
    expect(parsed).not.toHaveProperty('status');
  });

  it('não soma cached/reasoning novamente e preserva usage inválido como null', () => {
    expect(
      parseCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":4,"output_tokens":3,"reasoning_output_tokens":2}}',
      ).observation?.usage,
    ).toEqual({ tokens: 13 });
    expect(
      parseCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":-1}}',
      ).observation?.usage,
    ).toEqual({ tokens: null });
  });

  it.each([
    ['JSON truncado', '{"type":"turn.completed"'],
    ['JSON escalar', '42'],
    ['item sem id', '{"type":"item.completed","item":{"type":"agent_message","text":"x"}}'],
    ['evento de transporte', '{"type":"turn.started"}'],
  ])('trata %s deterministicamente como unknown', (_label, raw) => {
    const first = parseCodexLine(raw);
    expect(first).toEqual(parseCodexLine(raw));
    expect(first.event.type).toBe('unknown');
  });

  it('sanitiza segredo em input desconhecido antes de preservá-lo', () => {
    const parsed = parseCodexLine('authorization: Bearer secret-value');

    expect(parsed.event.type).toBe('unknown');
    expect(parsed.event.type === 'unknown' ? parsed.event.raw : '').not.toContain('secret-value');
  });
});
