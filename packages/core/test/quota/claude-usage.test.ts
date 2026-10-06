// Portado de test/dev/claude-usage.test.ts (agent-strategy-lab 2052cca): só os
// blocos puros (comando, parser, inferência zero). Medição antes/depois e
// launchWorker ficaram no original congelado.
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_USAGE_PROMPT,
  claudeUsageArgv,
  parseClaudeUsageText,
  probeClaudeUsage,
  zeroInferenceViolations,
  type ClaudeUsageProbeOutcome,
  type UsageCommandRunner,
} from '../../src/quota/claude-usage.js';

const REPO_ROOT = process.cwd();

const USAGE_TEXT =
  'Current session: 41% used · resets Aug 8, 9:39pm (America/Sao_Paulo)\n' +
  'Current week (all models): 63% used · resets Aug 11, 2:59am (America/Sao_Paulo)\n';

const FIVE_HOUR_LABEL = 'Aug 8, 9:39pm (America/Sao_Paulo)';
const SEVEN_DAY_LABEL = 'Aug 11, 2:59am (America/Sao_Paulo)';

/**
 * Result do `/usage` como a CLI 2.1.226 devolve: probe local, sem inferência —
 * `duration_api_ms=0`, `num_turns=0`, custo e tokens zerados, `modelUsage` vazio.
 */
function usageResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 812,
    duration_api_ms: 0,
    num_turns: 0,
    result: USAGE_TEXT,
    session_id: '11111111-2222-3333-4444-555555555555',
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    modelUsage: {},
    ...overrides,
  };
}

interface FakeUsageCli {
  readonly runner: UsageCommandRunner;
  /** argv de cada invocação — prova quantas chamadas houve e com que forma. */
  readonly calls: string[][];
}

type FakeResponse = { code?: number | null; stdout?: string; stderr?: string };

/**
 * CLI `/usage` FALSA. Cada resposta vale para uma invocação, na ordem; esgotada
 * a fila, a última se repete — o probe BEFORE e o AFTER são chamadas distintas.
 */
function fakeUsageCli(...responses: readonly FakeResponse[]): FakeUsageCli {
  const calls: string[][] = [];
  const runner: UsageCommandRunner = async (command, args) => {
    const response = responses[Math.min(calls.length, responses.length - 1)] ?? {};
    calls.push([command, ...args]);
    return {
      code: response.code === undefined ? 0 : response.code,
      stdout: response.stdout ?? JSON.stringify(usageResult()),
      stderr: response.stderr ?? '',
    };
  };
  return { runner, calls };
}

function probe(response: FakeResponse = {}): Promise<ClaudeUsageProbeOutcome> {
  return probeClaudeUsage({
    binary: 'claude',
    env: { HOME: '/home/test-user' },
    cwd: REPO_ROOT,
    runner: fakeUsageCli(response).runner,
  });
}

// ---------------------------------------------------------------------------
// Comando do probe
// ---------------------------------------------------------------------------

describe('comando do probe de quota', () => {
  it('é print + json + orçamento mínimo, sem API key e sem --bare', () => {
    const argv = claudeUsageArgv('claude');

    expect(argv[0]).toBe('claude');
    expect(argv).toContain('--print');
    expect(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 2)).toEqual(
      ['--output-format', 'json'],
    );
    expect(argv).toContain('--no-session-persistence');
    expect(argv).toContain('--max-budget-usd');
    expect(argv).toContain('--strict-mcp-config');
    expect(argv.at(-1)).toBe(CLAUDE_USAGE_PROMPT);
    expect(argv).not.toContain('--bare');
    expect(argv.join(' ')).not.toMatch(/api[-_]?key/i);
  });

  it('nunca deixa a opção variádica --tools imediatamente antes do prompt', () => {
    const argv = claudeUsageArgv('claude');
    const tools = argv.indexOf('--tools');

    expect(tools).toBeGreaterThan(0);
    // `--tools '' "/usage"` faria a CLI ler o prompt como nome de ferramenta.
    expect(argv[tools + 1]).toBe('');
    expect(argv[tools + 2]).not.toBe(CLAUDE_USAGE_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// Parser do texto
// ---------------------------------------------------------------------------

describe('parser do /usage', () => {
  it('A — extrai percentual e rótulo de reset das duas janelas', () => {
    expect(parseClaudeUsageText(USAGE_TEXT)).toEqual({
      five_hour: { used_pct: 41, reset_label: FIVE_HOUR_LABEL },
      seven_day_all_models: { used_pct: 63, reset_label: SEVEN_DAY_LABEL },
    });
  });

  it('A — ignora o bloco de contribuição, que é telemetria local aproximada', () => {
    const text = `${USAGE_TEXT}\nWhat's contributing to your limits usage?\n  Claude Code: 88%\n`;

    expect(parseClaudeUsageText(text)?.five_hour.used_pct).toBe(41);
  });

  it('F — falha fechada quando um dos cabeçalhos não está lá', () => {
    expect(parseClaudeUsageText('Current session: 41% used · resets Aug 8')).toBeNull();
    expect(parseClaudeUsageText('saída completamente diferente')).toBeNull();
    expect(parseClaudeUsageText('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contrato de inferência zero
// ---------------------------------------------------------------------------

describe('contrato de inferência zero', () => {
  it('B — result do /usage local não tem violação nenhuma', async () => {
    expect(zeroInferenceViolations(usageResult(), 0)).toEqual([]);

    const outcome = await probe();
    expect(outcome.probe).toMatchObject({
      available: true,
      zero_inference_verified: true,
      reason_code: 'OK',
      exit_code: 0,
    });
    expect(outcome.probe.result_text_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outcome.unsafe).toBe(false);
    expect(outcome.reading?.five_hour.used_pct).toBe(41);
  });

  it('C — total_cost_usd > 0 reprova', async () => {
    const outcome = await probe({ stdout: JSON.stringify(usageResult({ total_cost_usd: 0.02 })) });

    expect(outcome.probe.reason_code).toBe('ZERO_INFERENCE_UNVERIFIED');
    expect(outcome.probe.reason).toMatch(/total_cost_usd=0\.02/);
    expect(outcome.unsafe).toBe(true);
    expect(outcome.reading).toBeNull();
  });

  it('D — qualquer contador de token > 0 reprova, inclusive aninhado', async () => {
    const output = await probe({
      stdout: JSON.stringify(usageResult({ usage: { input_tokens: 0, output_tokens: 12 } })),
    });
    expect(output.probe.reason).toMatch(/usage\.output_tokens=12/);
    expect(output.unsafe).toBe(true);

    const nested = await probe({
      stdout: JSON.stringify(
        usageResult({ usage: { input_tokens: 0, server_tool_use: { web_search_requests: 1 } } }),
      ),
    });
    expect(nested.probe.reason).toMatch(/usage\.server_tool_use\.web_search_requests=1/);
    expect(nested.unsafe).toBe(true);
  });

  it('E — modelUsage não vazio reprova', async () => {
    const outcome = await probe({
      stdout: JSON.stringify(
        usageResult({ modelUsage: { 'claude-sonnet-5': { inputTokens: 10 } } }),
      ),
    });

    expect(outcome.probe.reason_code).toBe('ZERO_INFERENCE_UNVERIFIED');
    expect(outcome.probe.reason).toMatch(/modelUsage com 1 modelo/);
    expect(outcome.unsafe).toBe(true);
  });

  it('campo ausente NÃO conta como zero: ausência não prova nada', () => {
    expect(zeroInferenceViolations({ is_error: false, usage: {}, modelUsage: {} }, 0)).toEqual([
      'total_cost_usd ausente',
    ]);
    expect(zeroInferenceViolations({ total_cost_usd: 0, modelUsage: {} }, 0)).toEqual([
      'usage ausente',
    ]);
    expect(zeroInferenceViolations({ total_cost_usd: 0, usage: {} }, 0)).toEqual([
      'modelUsage ausente',
    ]);
    expect(zeroInferenceViolations(usageResult(), 1)).toEqual(['exit_code=1']);
    expect(zeroInferenceViolations(usageResult({ num_turns: 3 }), 0)).toEqual(['num_turns=3']);
  });

  it('F — stdout sem result legível fica indisponível, sem acusar inferência', async () => {
    const outcome = await probe({ code: 127, stdout: '', stderr: 'command not found\n' });

    expect(outcome.probe).toMatchObject({
      available: false,
      zero_inference_verified: false,
      reason_code: 'PROBE_FAILED',
      exit_code: 127,
    });
    expect(outcome.probe.reason).toMatch(/command not found/);
    // Sem result não há evidência de inferência — o run não é bloqueado por isso.
    expect(outcome.unsafe).toBe(false);
  });

  it('F — texto ilegível com contrato cumprido vira PARSE_ERROR, não inferência', async () => {
    const outcome = await probe({
      stdout: JSON.stringify(usageResult({ result: 'formato novo que o parser não conhece' })),
    });

    expect(outcome.probe).toMatchObject({
      available: false,
      zero_inference_verified: true,
      reason_code: 'PARSE_ERROR',
    });
    expect(outcome.unsafe).toBe(false);
    expect(outcome.reading).toBeNull();
  });
});
