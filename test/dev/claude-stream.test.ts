import { copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandRunner } from '../../dev/lib/billing.js';
import {
  OUTPUT_FORMAT_NOT_DECLARED,
  OUTPUT_FORMAT_UNKNOWN,
  claudeOutputFormat,
  rateLimitWindowDeltas,
  readClaudeStream,
  streamContractViolation,
  usesClaudeStreamJson,
} from '../../dev/lib/claude-stream.js';
import { diagnose, type Check } from '../../dev/lib/doctor.js';
import { headSha } from '../../dev/lib/git.js';
import { launchWorker } from '../../dev/lib/launch.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { loadProfile, type LauncherProfile } from '../../dev/lib/profile.js';
import {
  handoffDraftPath,
  readLaunchRecord,
  readReport,
  writePacket,
} from '../../dev/lib/records.js';
import { LaunchRecord } from '../../dev/lib/schemas.js';
import { buildInitialState, ensureRuntimeDirs, writeState } from '../../dev/lib/state.js';
import { REPO_ROOT, makeSandboxRepo, type Sandbox } from './helpers.js';

/**
 * Observabilidade de limite pelo protocolo documentado do print mode.
 *
 * NENHUM teste deste arquivo chama Claude de verdade: o worker é um fixture que
 * imita só o TRANSPORTE (`stream-json`), e a prova de credencial entra por
 * runner injetado. Nada aqui gasta franquia nem toca a rede.
 */

const STREAM_PROFILE_ID = 'claude-build-worker-subscription-sonnet5-medium-stream-v4';
const JSON_PROFILE_ID = 'claude-build-worker-subscription-sonnet5-medium-v3';
const FAKE_CLI_DIR = path.join(REPO_ROOT, 'fixtures', 'fake-clis');

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

function find(checks: readonly Check[], name: string): Check {
  const found = checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`check ausente: ${name}`);
  return found;
}

function fakeClaudeEnv(): NodeJS.ProcessEnv {
  return { PATH: `${FAKE_CLI_DIR}:${process.env['PATH'] ?? ''}`, HOME: '/home/test-user' };
}

/** Prova de assinatura injetada: nenhum binário real é consultado. */
const subscriptionRunner: CommandRunner = async () => ({
  code: 0,
  output: JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    subscriptionType: 'pro',
  }),
});

/**
 * Perfil `agent: claude` cujo argv aponta para o fixture de transporte. O que
 * está sob teste é a leitura do stdout, não o binário — por isso a credencial
 * entra por runner injetado e nenhuma CLI real é lançada.
 */
function streamFixtureProfile(scenario: string): LauncherProfile {
  return {
    id: 'claude-stream-fixture-v1',
    agent: 'claude',
    billing_mode: 'subscription_only',
    environment_mode: 'real-world',
    instruction_environment: 'real_world_user_home',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    argv: [
      'node',
      'fixtures/fake-claude-stream.mjs',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--settings',
      'dev/profiles/stream.settings.json',
      '--setting-sources',
      'project',
    ],
    prompt_delivery: 'argv',
    timeout_seconds: 30,
    kill_after_seconds: 2,
    forbidden_flags: [],
    env_allowlist: ['PATH', 'HOME'],
    env_extra: { AGENTLAB_FAKE_STREAM: scenario },
    maximum_instruction_bytes: 8192,
    control_markers: {},
    notes: [],
  };
}

async function launchStream(scenario: string) {
  const packet = buildTaskPacket({
    task: loaded.byId.get('T1')!,
    baseSha: await headSha(paths.repoRoot),
    previousHandoff: null,
  });
  await writePacket(paths, packet);
  return launchWorker({
    paths,
    profile: streamFixtureProfile(scenario),
    packet,
    credentialRunner: subscriptionRunner,
  });
}

// ---------------------------------------------------------------------------
// Transporte declarado no argv
// ---------------------------------------------------------------------------

describe('formato de saída declarado no argv', () => {
  it('lê stream-json, json, ausência e duplicidade sem adivinhar', () => {
    expect(claudeOutputFormat(['claude', '--output-format', 'stream-json'])).toBe('stream-json');
    expect(claudeOutputFormat(['claude', '--output-format=json'])).toBe('json');
    expect(claudeOutputFormat(['claude', '--print'])).toBe(OUTPUT_FORMAT_NOT_DECLARED);
    expect(
      claudeOutputFormat(['claude', '--output-format', 'json', '--output-format', 'stream-json']),
    ).toBe(OUTPUT_FORMAT_UNKNOWN);
    expect(claudeOutputFormat(['claude', '--output-format', '--print'])).toBe(
      OUTPUT_FORMAT_UNKNOWN,
    );
  });

  it('só trata como stream o perfil Claude que declarou stream-json', () => {
    const argv = ['claude', '--output-format', 'stream-json'];
    expect(usesClaudeStreamJson('claude', argv)).toBe(true);
    expect(usesClaudeStreamJson('codex', argv)).toBe(false);
    expect(usesClaudeStreamJson('claude', ['claude', '--output-format', 'json'])).toBe(false);
  });
});

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
// Delta observado
// ---------------------------------------------------------------------------

describe('delta observado entre observações', () => {
  it('D — >=2 observações do mesmo tipo na MESMA janela produzem observed_delta_pp', () => {
    const reading = readClaudeStream(
      [
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":41.5,"resets_at":"W"}',
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":44,"resets_at":"W"}',
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":47.25,"resets_at":"W"}',
        '{"type":"result","total_cost_usd":0.1}',
      ].join('\n'),
    );

    expect(rateLimitWindowDeltas(reading.observations)).toEqual([
      {
        rate_limit_type: 'five_hour',
        resets_at: 'W',
        first_utilization_percentage: 41.5,
        last_utilization_percentage: 47.25,
        observed_delta_pp: 5.75,
        observation_count: 3,
      },
    ]);
  });

  it('E — janelas diferentes não geram delta, e uma observação só também não', () => {
    const reading = readClaudeStream(
      [
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":88,"resets_at":"W1"}',
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":3,"resets_at":"W2"}',
        '{"type":"rate_limit_event","rate_limit_type":"weekly","utilization":10,"resets_at":"W3"}',
        '{"type":"result","total_cost_usd":0.1}',
      ].join('\n'),
    );

    expect(rateLimitWindowDeltas(reading.observations)).toEqual([]);
  });

  it('E — tipos distintos são contabilizados separadamente', () => {
    const reading = readClaudeStream(
      [
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":10,"resets_at":"W1"}',
        '{"type":"rate_limit_event","rate_limit_type":"weekly","utilization":2,"resets_at":"W2"}',
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":30,"resets_at":"W1"}',
        '{"type":"rate_limit_event","rate_limit_type":"weekly","utilization":9,"resets_at":"W2"}',
        '{"type":"result","total_cost_usd":0.1}',
      ].join('\n'),
    );

    expect(rateLimitWindowDeltas(reading.observations)).toEqual([
      {
        rate_limit_type: 'five_hour',
        resets_at: 'W1',
        first_utilization_percentage: 10,
        last_utilization_percentage: 30,
        observed_delta_pp: 20,
        observation_count: 2,
      },
      {
        rate_limit_type: 'weekly',
        resets_at: 'W2',
        first_utilization_percentage: 2,
        last_utilization_percentage: 9,
        observed_delta_pp: 7,
        observation_count: 2,
      },
    ]);
  });

  it('D — delta em escala de fração não carrega ruído de ponto flutuante', () => {
    const reading = readClaudeStream(
      [
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":0.42,"resets_at":"W"}',
        '{"type":"rate_limit_event","rate_limit_type":"five_hour","utilization":0.455,"resets_at":"W"}',
        '{"type":"result","total_cost_usd":0.1}',
      ].join('\n'),
    );

    expect(rateLimitWindowDeltas(reading.observations)[0]?.observed_delta_pp).toBe(3.5);
  });
});

// ---------------------------------------------------------------------------
// Launcher: evidência e falha fechada
// ---------------------------------------------------------------------------

describe('launchWorker com transporte stream-json', () => {
  it('A/B/C — run normal registra billing do result e as observações de limite', async () => {
    const outcome = await launchStream('same-window');

    expect(outcome.classification).toBe('FINISHED');
    const record = await readLaunchRecord(paths, 'T1');
    expect(record?.billing?.provider_estimated_api_equivalent_usd).toBe(0.4231);
    expect(record?.rate_limit_observations?.source).toBe('claude_stream_json');
    expect(record?.rate_limit_observations?.observed).toHaveLength(3);
    expect(record?.rate_limit_observations?.window_deltas).toEqual([
      {
        rate_limit_type: 'five_hour',
        resets_at: '2026-08-09T00:00:00.000Z',
        first_utilization_percentage: 41.5,
        last_utilization_percentage: 47.25,
        observed_delta_pp: 5.75,
        observation_count: 3,
      },
    ]);
  });

  it('F — run sem rate_limit_event continua FINISHED com lista vazia', async () => {
    const outcome = await launchStream('no-events');

    expect(outcome.classification).toBe('FINISHED');
    const record = await readLaunchRecord(paths, 'T1');
    expect(record?.rate_limit_observations).toMatchObject({ observed: [], window_deltas: [] });
    expect(record?.billing?.provider_estimated_api_equivalent_usd).toBe(0.4231);
  });

  it('E — observações de janelas diferentes ficam registradas sem virar delta', async () => {
    await launchStream('other-windows');

    const record = await readLaunchRecord(paths, 'T1');
    expect(record?.rate_limit_observations?.observed).toHaveLength(2);
    expect(record?.rate_limit_observations?.window_deltas).toEqual([]);
  });

  it('G — stream sem result vira INFRA_ERROR, não FINISHED', async () => {
    const outcome = await launchStream('no-result');

    expect(outcome.classification).toBe('INFRA_ERROR');
    expect(outcome.reason).toMatch(/contrato do transporte stream-json violado/);
    // A observação que chegou antes da violação continua registrada.
    expect(outcome.record.rate_limit_observations?.observed).toHaveLength(1);
  });

  it('G — dois results também violam o contrato', async () => {
    const outcome = await launchStream('two-results');

    expect(outcome.classification).toBe('INFRA_ERROR');
    expect(outcome.reason).toMatch(/exatamente uma mensagem type=result/);
  });

  it('H — linha inválida no stdout falha fechado', async () => {
    const outcome = await launchStream('invalid-line');

    expect(outcome.classification).toBe('INFRA_ERROR');
    expect(outcome.reason).toMatch(/não são objeto JSON/);
  });

  it('preserva o stdout bruto como evidência, sem reescrever o log', async () => {
    await launchStream('same-window');

    const stdout = await import('node:fs/promises').then((fs) =>
      fs.readFile(path.join(paths.logsDir, 'T1.stdout.log'), 'utf8'),
    );
    const lines = stdout.trim().split('\n');
    expect(lines.filter((line) => line.includes('"rate_limit_event"'))).toHaveLength(3);
    expect(JSON.parse(lines.at(-1) as string)).toMatchObject({ type: 'result' });
  });

  it('J — transporte não mexe em ownership, report nem handoff', async () => {
    const outcome = await launchStream('same-window');

    expect(outcome.record.execution_policy).toEqual({
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    });
    // O launcher continua sem escrever no lugar do worker: o inbox fica vazio.
    expect(await readReport(paths, 'T1')).toBeNull();
    await expect(
      import('node:fs/promises').then((fs) => fs.readFile(handoffDraftPath(paths, 'T1'), 'utf8')),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Compatibilidade: o perfil json histórico não muda
// ---------------------------------------------------------------------------

describe('perfis --output-format json continuam intactos', () => {
  it('I — medium-v3 permanece com json e sem --verbose', async () => {
    const profile = await loadProfile(REPO_ROOT, JSON_PROFILE_ID);

    expect(claudeOutputFormat(profile.argv)).toBe('json');
    expect(profile.argv).not.toContain('--verbose');
    expect(usesClaudeStreamJson(profile.agent, profile.argv)).toBe(false);
  });

  it('I — LaunchRecord legado sem rate_limit_observations continua válido', () => {
    const legacy = {
      schema_version: 1,
      task_id: 'T1',
      profile_id: JSON_PROFILE_ID,
      argv: ['claude', '--print'],
      process: {
        pid: 10,
        pgid: 10,
        started_at: '2026-08-08T00:00:00.000Z',
        proc_start_ticks: 1,
        command_sha256: 'a'.repeat(64),
      },
      launch_id: '11111111-2222-3333-4444-555555555555',
      started_at: '2026-08-08T00:00:00.000Z',
      finished_at: '2026-08-08T00:01:00.000Z',
      duration_ms: 60_000,
      exit_code: 0,
      timed_out: false,
      controlled: {},
    };

    expect(LaunchRecord.parse(legacy).rate_limit_observations).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

describe('doctor reconhece o perfil stream sem relaxar os demais', () => {
  it('stream-v4 é sonnet-5 / medium / stream-json / --verbose, subscription e sem chave', async () => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: STREAM_PROFILE_ID,
      loaded: await loadPlan(resolveHarnessPaths(REPO_ROOT).planFile),
      env: fakeClaudeEnv(),
    });

    expect(report).toMatchObject({
      model: 'claude-sonnet-5',
      output_format: 'stream-json',
      reasoning_effort: 'medium',
      reasoning_effort_source: 'claude_effort_flag',
      billing_mode: 'subscription_only',
      credential_source: 'claude_subscription_oauth',
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
      ok: true,
    });
    expect(find(report.checks, 'formato de saída')).toMatchObject({
      status: 'PASS',
      detail: expect.stringContaining('--verbose'),
    });
    expect(find(report.checks, 'reasoning effort').status).toBe('PASS');
    expect(find(report.checks, 'política de permissões').status).toBe('PASS');
    expect(find(report.checks, 'settings pessoais').status).toBe('PASS');
    expect(find(report.checks, 'validações do plano').status).toBe('PASS');
    expect(find(report.checks, 'variáveis de API').status).toBe('PASS');
    expect(find(report.checks, 'flags proibidas').status).toBe('PASS');
  });

  it('perfil json histórico é reportado como json e continua PASS', async () => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: JSON_PROFILE_ID,
      loaded: await loadPlan(resolveHarnessPaths(REPO_ROOT).planFile),
      env: fakeClaudeEnv(),
    });

    expect(report.output_format).toBe('json');
    expect(find(report.checks, 'formato de saída').status).toBe('PASS');
    expect(report.ok).toBe(true);
  });

  it('stream-json sem --verbose reprova: a CLI recusaria o formato', async () => {
    const id = 'claude-stream-sem-verbose-v1';
    await writeFile(
      path.join(sandbox.root, 'dev', 'profiles', `${id}.yaml`),
      [
        `id: ${id}`,
        'agent: claude',
        'billing_mode: subscription_only',
        'environment_mode: real-world',
        "argv: [claude, '--print', '--output-format', 'stream-json', '--model', 'claude-sonnet-5', '--effort', 'medium', '--settings', 'dev/profiles/stream.settings.json', '--setting-sources', 'project']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH, HOME]',
      ].join('\n'),
      'utf8',
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeClaudeEnv(),
    });

    expect(report.ok).toBe(false);
    expect(find(report.checks, 'formato de saída')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('--verbose'),
    });
  });

  it('--output-format duplicado reprova: transporte não é único', async () => {
    const id = 'claude-stream-duplicado-v1';
    await writeFile(
      path.join(sandbox.root, 'dev', 'profiles', `${id}.yaml`),
      [
        `id: ${id}`,
        'agent: claude',
        'billing_mode: subscription_only',
        'environment_mode: real-world',
        "argv: [claude, '--print', '--output-format', 'json', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5', '--settings', 'dev/profiles/stream.settings.json', '--setting-sources', 'project']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH, HOME]',
      ].join('\n'),
      'utf8',
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeClaudeEnv(),
    });

    expect(report.ok).toBe(false);
    expect(find(report.checks, 'formato de saída').status).toBe('FAIL');
  });
});

// ---------------------------------------------------------------------------
// O perfil stream só difere do medium-v3 no transporte
// ---------------------------------------------------------------------------

describe('perfil stream-v4 versus medium-v3', () => {
  it('difere apenas em --output-format, --verbose e nos marcadores do transporte', async () => {
    const stream = await loadProfile(REPO_ROOT, STREAM_PROFILE_ID);
    const json = await loadProfile(REPO_ROOT, JSON_PROFILE_ID);

    const withoutTransport = (argv: readonly string[]): string[] => {
      const remaining: string[] = [];
      for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index] as string;
        if (token === '--output-format') {
          index += 1;
          continue;
        }
        if (token === '--verbose') continue;
        remaining.push(token);
      }
      return remaining;
    };

    expect(withoutTransport(stream.argv)).toEqual(withoutTransport(json.argv));
    expect(stream.control_markers).toEqual({
      ...json.control_markers,
      output_transport: '--output-format',
      stream_verbosity: '--verbose',
    });

    const comparable = (profile: LauncherProfile): Record<string, unknown> => {
      const { id, argv, notes, control_markers, ...rest } = profile;
      void id;
      void argv;
      void notes;
      void control_markers;
      return rest;
    };
    expect(comparable(stream)).toEqual(comparable(json));
    expect(stream.argv).not.toContain('--include-partial-messages');
  });
});
