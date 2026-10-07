import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Teste usa os parsers do core direto (não fazem parte da API pública) para
// rodar o mapeador sobre os streams reais gravados na verificação 1.2.
import { parseClaudeLine } from '../../../packages/core/src/adapters/claude/parser.js';
import { parseCodexLine } from '../../../packages/core/src/adapters/codex/parser.js';
import { parseOpenCodeLine } from '../../../packages/core/src/adapters/opencode/parser.js';
import type { ParsedProviderLine } from '../../../packages/core/src/adapters/contract.js';
import { summarizeInput, TranscriptMapper } from '../src/daemon/transcript.js';
import type { TranscriptItem } from '../src/shared/ipc.js';

const REAL = path.resolve(import.meta.dirname, '../../../packages/core/test/fixtures/real');

function mapFixture(file: string, parse: (line: string) => ParsedProviderLine): TranscriptItem[] {
  const mapper = new TranscriptMapper();
  return readFileSync(path.join(REAL, file), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => mapper.map(parse(line).event))
    .filter((item): item is TranscriptItem => item !== null);
}

const toolResults = (items: TranscriptItem[]) =>
  items.flatMap((item) => (item.kind === 'tool_result' ? [{ status: item.status, summary: item.summary }] : []));

describe('transcript a partir de streams reais (probe edit: append, ls, git commit, curl)', () => {
  it('Claude 2.1.281: commit e curl negados, resto ok', () => {
    const items = mapFixture('claude-2.1.281-edit.jsonl', parseClaudeLine);
    const results = toolResults(items);
    expect(results.filter((result) => result.status === 'denied')).toHaveLength(2);
    expect(results.find((result) => result.status === 'denied')?.summary).toMatch(/git commit -am probe/);
    expect(items.some((item) => item.kind === 'tool_call' && item.name === 'Bash')).toBe(true);
    expect(items.at(-1)).toMatchObject({ kind: 'message', role: 'assistant' });
  });

  it('OpenCode 1.18.23: comando e entrada no mesmo item; commit e curl negados', () => {
    const results = toolResults(mapFixture('opencode-1.18.23-edit.jsonl', parseOpenCodeLine));
    const denied = results.filter((result) => result.status === 'denied').map((result) => result.summary);
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatch(/^git commit -am probe — /);
    expect(denied[1]).toMatch(/^curl -sI https:\/\/example\.com — /);
  });

  it('Codex 0.158.0: sem sinal de negação; curl bloqueado pelo sandbox aparece como erro', () => {
    const items = mapFixture('codex-0.158.0-edit.jsonl', parseCodexLine);
    const results = toolResults(items);
    expect(results.some((result) => result.status === 'denied')).toBe(false);
    expect(results.some((result) => result.status === 'error')).toBe(true);
    const calls = items.flatMap((item) => (item.kind === 'tool_call' ? [item.summary] : []));
    expect(calls.some((summary) => summary.includes('curl -sI https://example.com'))).toBe(true);
  });
});

describe('resumo da entrada', () => {
  it('prefere comando, arquivo, padrão; corta em uma linha', () => {
    expect(summarizeInput({ command: 'npm test\nmais' })).toBe('npm test');
    expect(summarizeInput({ file_path: '/a/b.ts', content: 'x' })).toBe('/a/b.ts');
    expect(summarizeInput({ foo: 1 })).toBe('{"foo":1}');
    expect(summarizeInput('x'.repeat(300))).toHaveLength(201);
  });
});
