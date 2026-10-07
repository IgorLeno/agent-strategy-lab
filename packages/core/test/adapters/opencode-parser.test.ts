import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { openCodeUsageLimitFromLog, parseOpenCodeLine } from '../../src/adapters/opencode/parser.js';

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

describe('openCodeUsageLimitFromLog', () => {
  it('reconhece a linha real de limite do Go', () => {
    // Linha de ~/.local/share/opencode/log/opencode.log em 2026-10-07 (opencode 1.18.23).
    const line =
      'timestamp=2026-10-07T04:45:26.693Z level=ERROR run=8a58592b message="stream error" providerID=opencode-go ' +
      'modelID=glm-5.3 session.id=ses_X small=false agent=build mode=primary error.error="AI_APICallError: Go usage limit exceeded"';
    expect(openCodeUsageLimitFromLog(line)).toBe('opencode: AI_APICallError: Go usage limit exceeded');
  });

  it('ignora outros erros e avisos', () => {
    expect(openCodeUsageLimitFromLog('level=WARN message="duplicate skill name"')).toBeNull();
    expect(
      openCodeUsageLimitFromLog('level=ERROR message="stream error" error.error="AI_APICallError: Provider is overloaded"'),
    ).toBeNull();
  });
});
