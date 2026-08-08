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

  default:
    write(rateLimit(41.5, WINDOW_A));
    write(result());
    break;
}
