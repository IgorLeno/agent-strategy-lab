// Worker FALSO que imita o transporte `--output-format stream-json` do Claude
// Code: uma mensagem JSON por linha no stdout. Não fala com provider nenhum e
// não roda modelo nenhum — existe só para que os testes exercitem o caminho
// real de spawn, leitura de stdout e classificação do launcher.
//
// O cenário vem de AGENTLAB_FAKE_STREAM.
const scenario = process.env.AGENTLAB_FAKE_STREAM ?? 'success';

const SESSION = '11111111-2222-3333-4444-555555555555';
const WINDOW_A = '2026-08-09T00:00:00.000Z';
const WINDOW_B = '2026-08-16T00:00:00.000Z';

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const rateLimit = (utilization, resetsAt, type = 'five_hour') => ({
  type: 'rate_limit_event',
  status: 'allowed',
  rate_limit_type: type,
  utilization,
  resets_at: resetsAt,
  session_id: SESSION,
});

const result = (overrides = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: SESSION,
  num_turns: 7,
  total_cost_usd: 0.4231,
  usage: { input_tokens: 1200, output_tokens: 340 },
  ...overrides,
});

if (scenario === 'json-api-error') {
  write(
    result({
      is_error: true,
      terminal_reason: 'api_error',
      api_error_status: 429,
      result: "You've hit your session limit · resets 6:30pm (America/Sao_Paulo)",
      num_turns: 75,
      total_cost_usd: 6.7753535,
      usage: { input_tokens: 128, output_tokens: 98390 },
    }),
  );
  process.exitCode = 1;
} else {
  write({ type: 'system', subtype: 'init', session_id: SESSION });
  write({ type: 'assistant', message: { role: 'assistant', content: [] } });

  switch (scenario) {
  case 'no-events':
    write(result());
    break;

  case 'same-window':
    write(rateLimit(41.5, WINDOW_A));
    write(rateLimit(44, WINDOW_A));
    write(rateLimit(47.25, WINDOW_A));
    write(result());
    break;

  case 'other-windows':
    write(rateLimit(88, WINDOW_A));
    write(rateLimit(3, WINDOW_B));
    write(result());
    break;

  case 'fraction-scale':
    write(rateLimit(0.42, WINDOW_A));
    write(rateLimit(0.455, WINDOW_A));
    write(result());
    break;

  case 'no-result':
    write(rateLimit(41.5, WINDOW_A));
    break;

  case 'two-results':
    write(result());
    write(result({ total_cost_usd: 0.9 }));
    break;

  case 'invalid-line':
    process.stdout.write('isto não é JSON\n');
    write(result());
    break;

  // Incidente REAL da M33: dez `api_retry`, nenhum turno, e um result final que
  // declara término por erro de API. Zero token, zero custo — o transporte
  // nunca chegou ao provider. O texto do erro é reproduzido como veio.
  case 'api-error':
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      write({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, error_status: null });
    }
    write(
      result({
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: null,
        result: 'API Error: Unable to connect to API (ENOTFOUND)',
        num_turns: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
      }),
    );
    process.exitCode = 1;
    break;

  // Mesma CLASSE de falha, com consumo real antes de a API cair: o consumo
  // observado precisa sobreviver à classificação.
  case 'api-error-with-usage':
    write(rateLimit(52, WINDOW_A));
    write(
      result({
        is_error: true,
        terminal_reason: 'api_error',
        api_error_status: 529,
        result: 'API Error: 529 overloaded_error',
        num_turns: 9,
        total_cost_usd: 1.2345,
        usage: { input_tokens: 4200, output_tokens: 900 },
      }),
    );
    process.exitCode = 1;
    break;

  // Falha terminal SEM `is_error`: motivo terminal desconhecido cai do lado
  // seguro sem que ninguém precise acrescentá-lo a uma lista.
  case 'terminal-reason-only':
    write(result({ terminal_reason: 'motivo_novo_da_cli' }));
    process.exitCode = 1;
    break;

  default:
    write(rateLimit(41.5, WINDOW_A));
    write(result());
    break;
  }
}
