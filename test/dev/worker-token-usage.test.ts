import { describe, expect, it } from 'vitest';

import {
  claudeObservedTokens,
  codexObservedTokens,
  observedWorkerTokens,
} from '../../dev/lib/worker-token-usage.js';

/**
 * Linha REAL do piloto Augmented Chess
 * (runtime/logs/chess_domain_and_perspective.stdout.log). Ela é a evidência
 * que já existia no stream e que o harness descartava — enquanto o attempt
 * inteiro era classificado como `had_inference UNKNOWN` por falta de medidor
 * de assinatura.
 */
const PILOT_TURN_COMPLETED =
  '{"type":"turn.completed","usage":{"input_tokens":748537,"cached_input_tokens":678912,' +
  '"cache_write_input_tokens":0,"output_tokens":7786,"reasoning_output_tokens":2659}}';

const PILOT_STREAM = [
  '{"type":"thread.started","thread_id":"01a030e8-835c-7a52-af9e-e5f147f47041"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  PILOT_TURN_COMPLETED,
  '',
].join('\n');

describe('contagem de tokens observada no stream do provider', () => {
  it('lê o turn.completed real do Codex e soma sem contar cache duas vezes', () => {
    const tokens = codexObservedTokens(PILOT_STREAM);
    expect(tokens).not.toBeNull();
    // input + output + reasoning; `cached_input_tokens` é subconjunto de input.
    expect(tokens?.total).toBe(748_537 + 7_786 + 2_659);
    expect(tokens?.input).toBe(748_537);
    expect(tokens?.cached_input).toBe(678_912);
    expect(tokens?.output).toBe(7_786);
    expect(tokens?.reasoning).toBe(2_659);
    expect(tokens?.provenance).toContain('turn.completed');
  });

  it('um stream retomado usa o último turn.completed, não o primeiro', () => {
    const resumed = [
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":1}}',
      '{"type":"turn.completed","usage":{"input_tokens":90,"output_tokens":9}}',
    ].join('\n');
    expect(codexObservedTokens(resumed)?.total).toBe(99);
  });

  it('stream sem contagem permanece UNKNOWN, nunca zero', () => {
    expect(codexObservedTokens('')).toBeNull();
    expect(codexObservedTokens('{"type":"turn.started"}')).toBeNull();
    expect(codexObservedTokens('{"type":"turn.completed"}')).toBeNull();
    expect(codexObservedTokens('{"type":"turn.completed","usage":{}}')).toBeNull();
    expect(
      codexObservedTokens('{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}'),
    ).toBeNull();
    expect(codexObservedTokens('não é json')).toBeNull();
  });

  it('lê a mensagem result do Claude somando o input que veio de cache', () => {
    const tokens = claudeObservedTokens({
      type: 'result',
      usage: {
        input_tokens: 1_200,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 200,
        output_tokens: 340,
      },
    });
    expect(tokens?.total).toBe(1_200 + 800 + 200 + 340);
    expect(tokens?.cached_input).toBe(1_000);
    expect(tokens?.output).toBe(340);
    expect(tokens?.provenance).toContain('type=result');
  });

  it('despacha por agent e nunca inventa contagem para um agent desconhecido', () => {
    expect(observedWorkerTokens({ agent: 'codex', stdout: PILOT_STREAM })?.total).toBeGreaterThan(0);
    expect(
      observedWorkerTokens({
        agent: 'claude',
        stdout: '',
        streamResult: { type: 'result', usage: { input_tokens: 5, output_tokens: 5 } },
      })?.total,
    ).toBe(10);
    // Claude sem stream-json: o objeto único de --output-format json serve.
    expect(
      observedWorkerTokens({
        agent: 'claude',
        stdout: '{"type":"result","usage":{"input_tokens":7,"output_tokens":3}}',
      })?.total,
    ).toBe(10);
    expect(observedWorkerTokens({ agent: 'fake', stdout: PILOT_STREAM })).toBeNull();
  });
});
