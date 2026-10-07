/**
 * Streams REAIS gravados em 2026-10-07 contra as CLIs instaladas (claude
 * 2.1.281, codex 0.158.0, opencode 1.18.23), modo `edit`, num repo temporário.
 * O prompt mandava editar notes.txt, rodar `ls` (allowlist), `git commit` e
 * `curl` (fora da allowlist) e responder allowed/denied por passo.
 *
 * Se uma CLI mudar o formato, regrave com uma execução curta e confira que os
 * números abaixo continuam vindo dos campos crus do stream.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { decodeStepOutput } from '../../src/adapters/step-output.js';
import { parseClaudeUsageText } from '../../src/quota/claude-usage.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/real/${name}`, import.meta.url), 'utf8');
}

describe('streams reais das CLIs instaladas', () => {
  it('claude 2.1.281: resultado final, tokens do result.usage e negações sem travar', () => {
    const stdout = fixture('claude-2.1.281-edit.jsonl');
    const output = decodeStepOutput('claude_code', stdout);
    expect(output.providerFailure).toBeNull();
    expect(output.finalText).toContain('git commit -am probe` — denied');
    expect(output.finalText).toContain('curl -sI https://example.com` — denied');
    // input 12 + cache_read 142549 + cache_creation 29083; output 556.
    expect(output.tokens).toMatchObject({ total: 172_200, input: 171_644, cached_input: 171_632, output: 556 });
    // A negação vem da CLI (sem humano), não da boa vontade do modelo.
    expect(stdout).toContain('"subtype":"permission_denied"');
  });

  it('codex 0.158.0: última agent_message e usage do turn.completed', () => {
    const output = decodeStepOutput('codex_cli', fixture('codex-0.158.0-edit.jsonl'));
    expect(output.providerFailure).toBeNull();
    expect(output.finalText).toBe('1. allowed\n2. allowed\n3. denied\n4. denied');
    expect(output.tokens).toMatchObject({ total: 107_206 + 475, input: 107_206, cached_input: 96_000, output: 475, reasoning: 142 });
  });

  it('opencode 1.18.23: último texto e soma dos step_finish', () => {
    const output = decodeStepOutput('opencode', fixture('opencode-1.18.23-edit.jsonl'));
    expect(output.providerFailure).toBeNull();
    expect(output.finalText).toBe('1. allowed\n2. allowed\n3. denied\n4. denied');
    // input fresco 5844 + cache read 42336; reasoning 0 neste run.
    expect(output.tokens).toMatchObject({ total: 48_492, input: 48_180, cached_input: 42_336, output: 312 });
  });

  it('claude 2.1.281: /usage sem inferência ainda tem os dois cabeçalhos', () => {
    const result = JSON.parse(fixture('claude-2.1.281-usage.json')) as Record<string, unknown>;
    expect(result['num_turns']).toBe(0);
    expect(parseClaudeUsageText(result['result'] as string)).toEqual({
      five_hour: { used_pct: 33, reset_label: 'Oct 7, 4:49am (America/Sao_Paulo)' },
      seven_day_all_models: { used_pct: 17, reset_label: 'Oct 13, 2:59am (America/Sao_Paulo)' },
    });
  });
});
