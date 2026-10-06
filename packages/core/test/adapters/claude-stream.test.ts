// Portado de test/dev/claude-stream.test.ts (agent-strategy-lab 2052cca): só a
// leitura do stream e a falha terminal. Introspecção de argv, deltas e
// launchWorker ficaram no original congelado, assim como o caso N, que valida
// compatibilidade com o schema de LaunchRecord antigo.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  PROVIDER_FAILURE_MESSAGE_MAX_CHARS,
  providerTerminalFailure,
  readClaudeJsonResult,
  readClaudeStream,
  streamContractViolation,
} from '../../src/adapters/claude-stream.js';

// ---------------------------------------------------------------------------
// Leitura do stream
// ---------------------------------------------------------------------------

describe('leitura do stdout stream-json', () => {
  it('A/B — result final é a fonte autoritativa dos campos do run', () => {
    const reading = readClaudeStream(
      [
        '{"type":"system","subtype":"init","session_id":"s1"}',
        '{"type":"assistant","message":{}}',
        '{"type":"result","subtype":"success","session_id":"s1","total_cost_usd":0.4231,"num_turns":7}',
      ].join('\n'),
    );

    expect(reading.results).toHaveLength(1);
    expect(reading.result).toMatchObject({ subtype: 'success', total_cost_usd: 0.4231 });
    expect(streamContractViolation(reading)).toBeNull();
  });

  it('C — rate_limit_event vira observação normalizada com a mensagem crua junto', () => {
    const raw = {
      type: 'rate_limit_event',
      status: 'allowed',
      rate_limit_type: 'five_hour',
      utilization: 41.5,
      resets_at: '2026-08-09T00:00:00.000Z',
      session_id: 's1',
    };
    const reading = readClaudeStream(
      [JSON.stringify(raw), '{"type":"result","total_cost_usd":0.1}'].join('\n'),
    );

    expect(reading.observations).toHaveLength(1);
    expect(reading.observations[0]).toMatchObject({
      sequence: 1,
      status: 'allowed',
      rate_limit_type: 'five_hour',
      utilization: 41.5,
      utilization_scale: 'percentage',
      utilization_percentage: 41.5,
      resets_at: '2026-08-09T00:00:00.000Z',
      session_id: 's1',
      raw,
    });
  });

  it('C — aceita camelCase e envelope aninhado sem inventar campo ausente', () => {
    const reading = readClaudeStream(
      [
        '{"type":"rate_limit_event","rate_limit":{"rateLimitType":"weekly","utilization":12,"resetsAt":"2026-08-16T00:00:00.000Z"}}',
        '{"type":"result","total_cost_usd":0.1}',
      ].join('\n'),
    );

    expect(reading.observations[0]).toMatchObject({
      rate_limit_type: 'weekly',
      utilization: 12,
      resets_at: '2026-08-16T00:00:00.000Z',
      // Não veio no evento: fica null em vez de virar valor inventado.
      status: null,
      session_id: null,
    });
  });

  it('L — evento REAL da M28 normaliza status, tipo e reset do envelope aninhado', () => {
    // Forma exata capturada em Claude Code 2.1.226 na M28: tudo aninhado em
    // `rate_limit_info`, nada no topo, e `resetsAt` como epoch numérico.
    const raw = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1786236000,
        rateLimitType: 'five_hour',
        overageStatus: 'allowed',
        overageResetsAt: 1788220800,
        isUsingOverage: false,
      },
      uuid: 'c8181b50-30da-427c-96a1-747c33df3b88',
      session_id: 'd9510ebb-3990-4fdb-a859-d8d7e820d917',
    };
    const reading = readClaudeStream(
      [JSON.stringify(raw), '{"type":"result","total_cost_usd":0.1}'].join('\n'),
    );

    expect(reading.observations[0]).toMatchObject({
      status: 'allowed',
      rate_limit_type: 'five_hour',
      // Epoch numérico fica como veio: converter exigiria adivinhar a unidade.
      resets_at: 1786236000,
      session_id: 'd9510ebb-3990-4fdb-a859-d8d7e820d917',
      overage_status: 'allowed',
      overage_resets_at: 1788220800,
      is_using_overage: false,
      // O evento real não traz utilization: nada é inventado no lugar.
      utilization: null,
      utilization_percentage: null,
      raw,
    });
  });

  it('M — a forma snake_case de topo continua suportada junto da nova', () => {
    const reading = readClaudeStream(
      [
        '{"type":"rate_limit_event","status":"allowed","rate_limit_type":"five_hour","resets_at":"2026-08-09T00:00:00.000Z","overage_status":"allowed","is_using_overage":true}',
        '{"type":"result","total_cost_usd":0.1}',
      ].join('\n'),
    );

    expect(reading.observations[0]).toMatchObject({
      status: 'allowed',
      rate_limit_type: 'five_hour',
      resets_at: '2026-08-09T00:00:00.000Z',
      overage_status: 'allowed',
      overage_resets_at: null,
      is_using_overage: true,
    });
  });

  it('C — utilization em fração preserva o raw e deriva o percentual', () => {
    const reading = readClaudeStream(
      [
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":0.42,"resets_at":"w"}',
        '{"type":"result","total_cost_usd":0.1}',
      ].join('\n'),
    );

    expect(reading.observations[0]).toMatchObject({
      utilization: 0.42,
      utilization_scale: 'fraction',
      utilization_percentage: 42,
    });
  });

  it('F — ausência de rate_limit_event é resultado válido, não violação', () => {
    const reading = readClaudeStream('{"type":"result","subtype":"success","total_cost_usd":0.1}');

    expect(reading.observations).toEqual([]);
    expect(streamContractViolation(reading)).toBeNull();
  });

  it('G — stream sem result falha fechado', () => {
    const reading = readClaudeStream('{"type":"system","subtype":"init"}');

    expect(reading.result).toBeNull();
    expect(streamContractViolation(reading)).toMatch(/exatamente uma mensagem type=result/);
  });

  it('G — mais de um result também falha fechado', () => {
    const reading = readClaudeStream(
      ['{"type":"result","total_cost_usd":0.1}', '{"type":"result","total_cost_usd":0.9}'].join(
        '\n',
      ),
    );

    expect(reading.results).toHaveLength(2);
    expect(streamContractViolation(reading)).toMatch(/exatamente uma mensagem type=result/);
  });

  it('H — linha que não é objeto JSON é contada e falha fechado', () => {
    const reading = readClaudeStream(
      ['{"type":"result","total_cost_usd":0.1}', 'isto não é JSON', '"nem isto"'].join('\n'),
    );

    expect(reading.invalid_lines).toBe(2);
    expect(streamContractViolation(reading)).toMatch(/não são objeto JSON/);
  });
});

// ---------------------------------------------------------------------------
// Falha terminal do provider
// ---------------------------------------------------------------------------

describe('leitura da falha terminal declarada no result', () => {
  it('A — result de conclusão normal não declara falha nenhuma', () => {
    expect(
      providerTerminalFailure({
        type: 'result',
        subtype: 'success',
        is_error: false,
        terminal_reason: 'completed',
        total_cost_usd: 1.2,
      }),
    ).toBeNull();
    // Versão de CLI que não emite terminal_reason continua sendo julgada só
    // por is_error — ausência não é falha.
    expect(providerTerminalFailure({ type: 'result', is_error: false })).toBeNull();
    expect(providerTerminalFailure(null)).toBeNull();
  });

  it('B/C — is_error e terminal_reason declaram a falha; o texto vai preservado e com hash', () => {
    const message = 'API Error: Unable to connect to API (ENOTFOUND)';
    const failure = providerTerminalFailure({
      type: 'result',
      subtype: 'success',
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: null,
      result: message,
      num_turns: 1,
      total_cost_usd: 0,
    });

    expect(failure).toMatchObject({
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: null,
      // `subtype: success` no mesmo result é justamente por que a classe não
      // pode depender dele.
      subtype: 'success',
      num_turns: 1,
      message,
      message_sha256: createHash('sha256').update(message, 'utf8').digest('hex'),
    });
    expect(failure?.signals).toEqual(['is_error=true', 'terminal_reason=api_error']);
  });

  it('B — terminal_reason desconhecido cai do lado seguro sem lista de falhas', () => {
    const failure = providerTerminalFailure({
      type: 'result',
      is_error: false,
      terminal_reason: 'motivo_que_ninguem_previu',
    });

    expect(failure?.signals).toEqual(['terminal_reason=motivo_que_ninguem_previu']);
  });

  it('H — status HTTP numérico e consumo real são preservados como vieram', () => {
    const failure = providerTerminalFailure({
      type: 'result',
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 529,
      result: 'API Error: 529 overloaded_error',
      num_turns: 9,
    });

    expect(failure?.api_error_status).toBe(529);
    expect(failure?.num_turns).toBe(9);
  });

  it('preserva o hash do texto INTEIRO mesmo quando a mensagem é truncada', () => {
    const message = 'x'.repeat(PROVIDER_FAILURE_MESSAGE_MAX_CHARS + 100);
    const failure = providerTerminalFailure({ type: 'result', is_error: true, result: message });

    expect(failure?.message).toHaveLength(PROVIDER_FAILURE_MESSAGE_MAX_CHARS);
    expect(failure?.message_sha256).toBe(
      createHash('sha256').update(message, 'utf8').digest('hex'),
    );
  });
});
