import { describe, expect, it } from 'vitest';

import { openCodeRunUsageOf } from '../../dev/lib/opencode-scaffold.js';
import { observedWorkerTokens } from '../../dev/lib/worker-token-usage.js';
import { extractRoleModelJson } from '../../dev/lib/project-orchestrate.js';

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

/**
 * `opencode run --format json` emite eventos JSONL; o payload do modelo é o
 * TEXTO da mensagem final, não o stdout inteiro. A forma abaixo é a observada
 * em review real (identificadores trocados por exemplos).
 */
describe('extractRoleModelJson — OpenCode run stream', () => {
  const OPENCODE_ARGV = [
    'opencode',
    'run',
    '--format',
    'json',
    '--model',
    'opencode-go/deepseek-v4-flash',
  ] as const;
  const verdict = { decision: 'ACCEPT', reason: 'candidate satisfaz o acceptance' };

  function runStream(finalText: string): string {
    return [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_EXEMPLO', part: { type: 'step-start' } }),
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_EXEMPLO',
        part: { type: 'tool', tool: 'read', state: { status: 'completed' } },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_EXEMPLO',
        part: { type: 'text', text: 'comentário intermediário durante o audit' },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_EXEMPLO',
        part: { type: 'step-finish', reason: 'tool-calls' },
      }),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_EXEMPLO',
        part: { type: 'text', text: finalText },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_EXEMPLO',
        part: { type: 'step-finish', reason: 'stop' },
      }),
    ].join('\n');
  }

  it('TRANSPORT VALID + MODEL PAYLOAD VALID: extrai o JSON do último texto do modelo', () => {
    const extracted = extractRoleModelJson({
      agent: 'opencode',
      argv: [...OPENCODE_ARGV],
      stdout: runStream(JSON.stringify(verdict)),
    });
    expect(extracted).toEqual({ outcome: 'EXTRACTED', value: verdict });
  });

  it('TRANSPORT VALID + MODEL PAYLOAD INVALID: NOT_PARSEABLE, não transporte', () => {
    const extracted = extractRoleModelJson({
      agent: 'opencode',
      argv: [...OPENCODE_ARGV],
      stdout: runStream('desculpe, não consigo gerar o veredito'),
    });
    expect(extracted.outcome).toBe('NOT_PARSEABLE');
  });

  it('TRANSPORT MALFORMED é diagnóstico distinto de payload inválido', () => {
    const extracted = extractRoleModelJson({
      agent: 'opencode',
      argv: [...OPENCODE_ARGV],
      stdout: 'not a jsonl stream at all',
    });
    expect(extracted.outcome).toBe('TRANSPORT_MALFORMED');
  });

  it('stdout vazio é transporte malformado', () => {
    const extracted = extractRoleModelJson({
      agent: 'opencode',
      argv: [...OPENCODE_ARGV],
      stdout: '',
    });
    expect(extracted.outcome).toBe('TRANSPORT_MALFORMED');
  });

  it('run sem nenhum texto de modelo é NOT_PARSEABLE, não EXTRACTED', () => {
    const stdout = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_EXEMPLO', part: { type: 'step-start' } }),
      JSON.stringify({
        type: 'tool_use',
        sessionID: 'ses_EXEMPLO',
        part: { type: 'tool', tool: 'read', state: { status: 'completed' } },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_EXEMPLO',
        part: { type: 'step-finish', reason: 'stop' },
      }),
    ].join('\n');
    const extracted = extractRoleModelJson({
      agent: 'opencode',
      argv: [...OPENCODE_ARGV],
      stdout,
    });
    expect(extracted.outcome).toBe('NOT_PARSEABLE');
  });

  it('OpenCode SEM --format json continua no fallback de payload textual direto', () => {
    const extracted = extractRoleModelJson({
      agent: 'opencode',
      argv: ['opencode', 'run', '--model', 'opencode-go/deepseek-v4-flash'],
      stdout: JSON.stringify(verdict),
    });
    expect(extracted).toEqual({ outcome: 'EXTRACTED', value: verdict });
  });
});
