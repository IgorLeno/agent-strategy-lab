import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { parseOpenCodeLine } from '../../src/adapters/opencode/parser.js';

const lines = readFileSync(new URL('../fixtures/real/opencode-1.18.23-edit.jsonl', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '');

describe('parseOpenCodeLine (opencode 1.18.23 real)', () => {
  const events = lines.map((line) => parseOpenCodeLine(line).event);

  it('texto do agente vira mensagem assistant', () => {
    expect(events.filter((event) => event.type === 'message')).toEqual([
      { type: 'message', role: 'assistant', text: '1. allowed\n2. allowed\n3. denied\n4. denied' },
    ]);
  });

  it('ferramenta resolvida vira tool_result com entrada e desfecho, inclusive negação', () => {
    const tools = events.filter((event) => event.type === 'tool_result');
    expect(tools.map((event) => (event.type === 'tool_result' ? event.name : null))).toEqual([
      'read',
      'edit',
      'bash',
      'bash',
      'bash',
    ]);
    expect(tools[3]).toMatchObject({
      output: { input: { command: 'git commit -am probe' }, status: 'error' },
    });
  });

  it('step_start/step_finish e lixo ficam unknown, sem lançar', () => {
    expect(events.filter((event) => event.type === 'unknown')).toHaveLength(12);
    expect(parseOpenCodeLine('ruído').event.type).toBe('unknown');
  });
});
