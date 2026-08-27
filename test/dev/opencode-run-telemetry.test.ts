import { describe, expect, it } from 'vitest';

import { openCodeRunUsageOf } from '../../dev/lib/opencode-scaffold.js';
import { observedWorkerTokens } from '../../dev/lib/worker-token-usage.js';

/**
 * Forma REAL da saida de `opencode run --format json`, capturada no smoke test
 * do launcher (modelo `opencode-go/deepseek-v4-flash`, sessao descartavel).
 * Os identificadores foram trocados por valores de exemplo; a ESTRUTURA e a
 * observada.
 */
const RUN_JSON = [
  JSON.stringify({
    type: 'step_start',
    sessionID: 'ses_EXEMPLO',
    part: { type: 'step-start' },
  }),
  JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_EXEMPLO',
    part: { type: 'tool', tool: 'read', state: { status: 'completed' } },
  }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_EXEMPLO',
    part: {
      type: 'step-finish',
      reason: 'tool-calls',
      tokens: {
        total: 5923,
        input: 4055,
        output: 76,
        reasoning: 0,
        cache: { write: 0, read: 1792 },
      },
      cost: 0.0009548,
    },
  }),
].join('\n');

describe('telemetria por run do OpenCode', () => {
  it('le tokens e custo do evento step_finish', () => {
    const usage = openCodeRunUsageOf(RUN_JSON);
    expect(usage.total_tokens).toBe(5923);
    expect(usage.input_tokens).toBe(4055);
    expect(usage.output_tokens).toBe(76);
    expect(usage.cache_read_tokens).toBe(1792);
    expect(usage.reported_cost_usd).toBe(0.0009548);
  });

  it('soma passos do MESMO run', () => {
    const usage = openCodeRunUsageOf([RUN_JSON, RUN_JSON].join('\n'));
    expect(usage.total_tokens).toBe(5923 * 2);
    expect(usage.reported_cost_usd).toBeCloseTo(0.0019096, 9);
  });

  it('run sem evento de passo permanece UNKNOWN, nao zero', () => {
    const usage = openCodeRunUsageOf('{"type":"text","part":{"text":"oi"}}');
    expect(usage.total_tokens).toBeNull();
    expect(usage.reported_cost_usd).toBeNull();
    // Nao reportar nao e a mesma coisa que nao consumir.
    expect(usage.total_tokens).not.toBe(0);
  });

  it('linha que nao e JSON nao derruba a leitura', () => {
    const usage = openCodeRunUsageOf(`ruido decorativo da CLI\n${RUN_JSON}`);
    expect(usage.total_tokens).toBe(5923);
  });

  it('observedWorkerTokens reconhece o scaffold OpenCode com proveniencia propria', () => {
    const observed = observedWorkerTokens({ agent: 'opencode', stdout: RUN_JSON });
    expect(observed?.total).toBe(5923);
    expect(observed?.cached_input).toBe(1792);
    // A proveniencia nomeia a FONTE: nao e `opencode stats`, que agrega todas
    // as sessoes locais e nao sabe atribuir consumo a uma task.
    expect(observed?.provenance).toContain('step_finish');
    expect(observed?.provenance).not.toContain('stats');
  });

  it('sem contagem reportada o resultado e null, nunca um total inventado', () => {
    expect(observedWorkerTokens({ agent: 'opencode', stdout: '' })).toBeNull();
  });
});
