import { copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../dev/lib/billing.js';
import {
  CLAUDE_USAGE_PROMPT,
  buildSubscriptionUsage,
  claudeUsageArgv,
  parseClaudeUsageText,
  probeClaudeUsage,
  zeroInferenceViolations,
  type ClaudeUsageProbeOutcome,
  type UsageCommandRunner,
} from '../../dev/lib/claude-usage.js';
import { headSha } from '../../dev/lib/git.js';
import { launchWorker } from '../../dev/lib/launch.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import type { LauncherProfile } from '../../dev/lib/profile.js';
import { readLaunchRecord, writePacket } from '../../dev/lib/records.js';
import { LaunchRecord } from '../../dev/lib/schemas.js';
import { buildInitialState, ensureRuntimeDirs, writeState } from '../../dev/lib/state.js';
import { REPO_ROOT, makeSandboxRepo, type Sandbox } from './helpers.js';

/**
 * Medição da quota da assinatura em volta do run.
 *
 * NENHUM teste deste arquivo chama Claude de verdade: o `/usage` entra por
 * runner injetado, o worker é o mesmo fixture de transporte usado na M28 e a
 * credencial é provada por runner falso. Nada aqui gasta franquia.
 */

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

// ---------------------------------------------------------------------------
// Medição
// ---------------------------------------------------------------------------

function reading(fiveHourPct: number, fiveHourLabel = FIVE_HOUR_LABEL): ClaudeUsageProbeOutcome {
  return {
    probe: {
      available: true,
      zero_inference_verified: true,
      reason_code: 'OK',
      reason: null,
      result_text_sha256: null,
      command: 'claude /usage',
      exit_code: 0,
    },
    reading: {
      five_hour: { used_pct: fiveHourPct, reset_label: fiveHourLabel },
      seven_day_all_models: { used_pct: 63, reset_label: SEVEN_DAY_LABEL },
    },
    unsafe: false,
  };
}

const UNAVAILABLE: ClaudeUsageProbeOutcome = {
  probe: {
    available: false,
    zero_inference_verified: false,
    reason_code: 'PROBE_FAILED',
    reason: 'sem result',
    result_text_sha256: null,
    command: 'claude /usage',
    exit_code: 1,
  },
  reading: null,
  unsafe: false,
};

describe('medição entre os dois probes', () => {
  it('G — mesma janela produz consumed_pp', () => {
    const usage = buildSubscriptionUsage(reading(41), reading(47));

    expect(usage.source).toBe('claude_print_usage');
    expect(usage.five_hour).toEqual({
      before_used_pct: 41,
      after_used_pct: 47,
      before_reset_label: FIVE_HOUR_LABEL,
      after_reset_label: FIVE_HOUR_LABEL,
      same_window: true,
      consumed_pp: 6,
      reason_code: 'OK',
    });
    expect(usage.probe_contract.before.zero_inference_verified).toBe(true);
    expect(usage.probe_contract.after.zero_inference_verified).toBe(true);
  });

  it('H — janela virada entre os probes não produz delta', () => {
    const usage = buildSubscriptionUsage(reading(97), reading(3, 'Aug 9, 2:39am (America/Sao_Paulo)'));

    expect(usage.five_hour).toMatchObject({
      same_window: false,
      consumed_pp: null,
      reason_code: 'RATE_LIMIT_WINDOW_RESET',
    });
    // A semana continua na mesma janela e é medida normalmente.
    expect(usage.seven_day_all_models.consumed_pp).toBe(0);
  });

  it('I — percentual igual é medição VÁLIDA de consumo 0, não indisponibilidade', () => {
    const usage = buildSubscriptionUsage(reading(41), reading(41));

    expect(usage.five_hour.consumed_pp).toBe(0);
    expect(usage.five_hour.reason_code).toBe('OK');
  });

  it('probe indisponível dos dois lados deixa a medição explícita, sem inventar 0', () => {
    const usage = buildSubscriptionUsage(reading(41), UNAVAILABLE);

    expect(usage.five_hour).toMatchObject({
      before_used_pct: 41,
      after_used_pct: null,
      same_window: false,
      consumed_pp: null,
      reason_code: 'MEASUREMENT_UNAVAILABLE',
    });
    expect(usage.probe_contract.after.reason_code).toBe('PROBE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Launcher: ordem, segurança e perfis que não medem
// ---------------------------------------------------------------------------

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
  await copyFile(
    path.join(REPO_ROOT, 'fixtures', 'fake-claude-stream.mjs'),
    path.join(sandbox.root, 'fixtures', 'fake-claude-stream.mjs'),
  );
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', 'stream.settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(true)'], deny: [] } }),
    'utf8',
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

const subscriptionRunner: CommandRunner = async () => ({
  code: 0,
  output: JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'pro',
  }),
});

const chatgptRunner: CommandRunner = async () => ({ code: 0, output: 'Logged in using ChatGPT' });

/** Perfil `agent: claude` cujo argv aponta para o fixture — nenhuma CLI real. */
function fixtureProfile(agent: 'claude' | 'codex'): LauncherProfile {
  return {
    id: `${agent}-usage-fixture-v1`,
    agent,
    billing_mode: 'subscription_only',
    environment_mode: 'real-world',
    instruction_environment: 'real_world_user_home',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    argv: ['node', 'fixtures/fake-claude-stream.mjs', '--print', '--output-format', 'stream-json', '--verbose'],
    prompt_delivery: 'argv',
    timeout_seconds: 30,
    kill_after_seconds: 2,
    forbidden_flags: [],
    env_allowlist: ['PATH', 'HOME'],
    env_extra: { AGENTLAB_FAKE_STREAM: 'no-events' },
    maximum_instruction_bytes: 8192,
    control_markers: {},
    notes: [],
  };
}

async function launch(profile: LauncherProfile, usageRunner: UsageCommandRunner) {
  const packet = buildTaskPacket({
    task: loaded.byId.get('T1')!,
    baseSha: await headSha(paths.repoRoot),
    previousHandoff: null,
  });
  await writePacket(paths, packet);
  return launchWorker({
    paths,
    profile,
    packet,
    credentialRunner: profile.agent === 'claude' ? subscriptionRunner : chatgptRunner,
    usageRunner,
  });
}

describe('launchWorker mede a quota em volta do run', () => {
  it('G — BEFORE e AFTER são processos distintos e viram consumo medido', async () => {
    const cli = fakeUsageCli(
      {},
      { stdout: JSON.stringify(usageResult({ result: USAGE_TEXT.replace('41%', '47%') })) },
    );

    const outcome = await launch(fixtureProfile('claude'), cli.runner);

    expect(outcome.classification).toBe('FINISHED');
    expect(cli.calls).toHaveLength(2);
    // Um processo NOVO por probe, e nenhum deles reaproveita sessão do worker.
    for (const call of cli.calls) {
      expect(call).toContain('--no-session-persistence');
      expect(call.at(-1)).toBe(CLAUDE_USAGE_PROMPT);
    }
    expect(outcome.record.subscription_usage?.five_hour).toMatchObject({
      before_used_pct: 41,
      after_used_pct: 47,
      same_window: true,
      consumed_pp: 6,
      reason_code: 'OK',
    });
    // Métricas separadas: quota da assinatura não se mistura com dólar estimado.
    expect(outcome.record.billing?.provider_estimated_api_equivalent_usd).toBe(0.4231);
    expect(outcome.record.rate_limit_observations?.source).toBe('claude_stream_json');

    const persisted = await readLaunchRecord(paths, 'T1');
    expect(persisted?.subscription_usage?.five_hour.consumed_pp).toBe(6);
  });

  it('BEFORE que não prova inferência zero NÃO lança o worker', async () => {
    const cli = fakeUsageCli({ stdout: JSON.stringify(usageResult({ total_cost_usd: 0.5 })) });

    await expect(launch(fixtureProfile('claude'), cli.runner)).rejects.toThrow(
      /medição de quota recusou o lançamento.*total_cost_usd=0\.5/s,
    );
    // Nenhum AFTER, porque nenhum worker nasceu.
    expect(cli.calls).toHaveLength(1);
    expect(await readLaunchRecord(paths, 'T1')).toBeNull();
  });

  it('J — AFTER indisponível preserva o resultado do provider', async () => {
    const cli = fakeUsageCli({}, { code: 1, stdout: '', stderr: 'boom' });

    const outcome = await launch(fixtureProfile('claude'), cli.runner);

    expect(outcome.classification).toBe('FINISHED');
    expect(outcome.record.exit_code).toBe(0);
    expect(cli.calls).toHaveLength(2);
    expect(outcome.record.subscription_usage?.probe_contract.before.reason_code).toBe('OK');
    expect(outcome.record.subscription_usage?.probe_contract.after.reason_code).toBe('PROBE_FAILED');
    expect(outcome.record.subscription_usage?.five_hour).toMatchObject({
      before_used_pct: 41,
      after_used_pct: null,
      consumed_pp: null,
      reason_code: 'MEASUREMENT_UNAVAILABLE',
    });
  });

  it('K — perfil Codex não recebe chamada de /usage nenhuma', async () => {
    const cli = fakeUsageCli();

    const outcome = await launch(fixtureProfile('codex'), cli.runner);

    expect(outcome.classification).toBe('FINISHED');
    expect(cli.calls).toEqual([]);
    expect(outcome.record.subscription_usage).toBeNull();
    expect(await readLaunchRecord(paths, 'T1').then((record) => record?.subscription_usage)).toBeNull();
  });

  it('LaunchRecord anterior à medição continua válido sem o campo', () => {
    const legacy = {
      schema_version: 1,
      task_id: 'M28',
      profile_id: 'claude-build-worker-subscription-sonnet5-medium-stream-v4',
      argv: ['timeout', 'claude'],
      process: {
        pid: 1,
        pgid: 1,
        started_at: '2026-08-08T00:00:00.000Z',
        proc_start_ticks: 1,
        command_sha256: 'a'.repeat(64),
      },
      launch_id: '11111111-2222-3333-4444-555555555555',
      started_at: '2026-08-08T00:00:00.000Z',
      finished_at: '2026-08-08T00:10:00.000Z',
      duration_ms: 600_000,
      exit_code: 0,
      timed_out: false,
      controlled: {},
    };

    const parsed = LaunchRecord.parse(legacy);
    // Ausência NÃO é medição zerada: o campo fica null e ninguém preenche nada.
    expect(parsed.subscription_usage).toBeNull();
  });
});
