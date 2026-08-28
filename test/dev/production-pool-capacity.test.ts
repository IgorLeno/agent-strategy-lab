import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CapacityPrecision,
  CapacityStatus,
  OPENAI_USAGE_ENDPOINT,
  OPENCODE_GO_USAGE_ENDPOINT,
  OPENROUTER_CREDITS_ENDPOINT,
  PoolCapacityObservation,
  type ProbeFetch,
} from '../../src/quota/index.js';
import {
  API_BILLING_AUTHORIZATION_VALUE,
  API_BILLING_AUTHORIZATION_VARIABLE,
  type CommandRunner,
} from '../../dev/lib/billing.js';
import { commitAll, makeSandboxRepo, REPO_ROOT } from './helpers.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadProfileFromCatalog, type LauncherProfile } from '../../dev/lib/profile.js';
import { loadProjectRunAuthorization } from '../../dev/lib/project-authorization.js';
import { createProjectControlPlane } from '../../dev/lib/project-run.js';
import { collectProjectLaunchFacts } from '../../dev/lib/project-preflight.js';
import { launchRecordPath, readLaunchRecord } from '../../dev/lib/records.js';
import { LaunchRecord } from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  writeState,
} from '../../dev/lib/state.js';
import {
  createProductionPoolCapacityProbe,
  observeEligiblePoolCapacities,
  type PoolCapacityProbe,
} from '../../dev/lib/pool-capacity-observer.js';
import { launchTask } from '../../dev/lib/steps.js';
import { runOrchestrate } from '../../dev/lib/orchestrate.js';
import type { LabProgressEvent } from '../../dev/lib/lab-progress.js';

const OBSERVED_AT = '2026-08-27T12:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDir(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function response(body: unknown): Awaited<ReturnType<ProbeFetch>> {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function knownCapacity(input: {
  readonly pool: string;
  readonly used: number;
  readonly windowInstance?: string;
  readonly source?: string;
}): PoolCapacityObservation {
  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: input.pool,
    status: CapacityStatus.KNOWN,
    windows: [
      {
        window_id: 'primary',
        used_percent: input.used,
        remaining_percent: 100 - input.used,
        precision: CapacityPrecision.COARSE_INTEGER_PERCENT,
        window_seconds: 18_000,
        window_instance: input.windowInstance ?? '2030-01-01T00:00:00.000Z',
        resets_at: input.windowInstance ?? '2030-01-01T00:00:00.000Z',
      },
    ],
    balance: null,
    plan: null,
    reason: 'provider reportou capacidade atual',
    source: input.source ?? 'fixture:read-only-capacity',
    observed_at: OBSERVED_AT,
  });
}

function exhaustedCapacity(pool: string): PoolCapacityObservation {
  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: pool,
    status: CapacityStatus.EXHAUSTED,
    windows: [],
    balance: null,
    plan: null,
    reason: 'provider declarou limit_reached',
    source: 'fixture:provider-declared-exhaustion',
    observed_at: OBSERVED_AT,
  });
}

function unknownCapacity(pool: string): PoolCapacityObservation {
  return PoolCapacityObservation.parse({
    schema_version: 1,
    quota_pool: pool,
    status: CapacityStatus.UNKNOWN,
    windows: [],
    balance: null,
    plan: null,
    reason: 'falha de rede no probe fresco',
    source: 'fixture:failed-live-probe',
    observed_at: OBSERVED_AT,
  });
}

describe('observer de capacidade de produção', () => {
  it('mapeia pools reais, prefere Codex para OpenAI e deduplica por pool no assessment', async () => {
    const authRoot = await temporaryDir('agentlab-capacity-auth-');
    const codexAuthFile = path.join(authRoot, 'codex-auth.json');
    const opencodeAuthFile = path.join(authRoot, 'opencode-auth.json');
    const fakeToken = 'oauth-token-never-persist';
    const fakeAccount = 'acct-never-persist';
    const fakeGoKey = 'go-key-never-persist';
    const fakeRouterKey = 'router-key-never-persist';
    await writeFile(
      codexAuthFile,
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: fakeToken, account_id: fakeAccount },
      }),
      'utf8',
    );
    await writeFile(
      opencodeAuthFile,
      JSON.stringify({
        openai: { type: 'oauth', access: 'fallback-token', accountId: fakeAccount },
        'opencode-go': { type: 'api', key: fakeGoKey },
        openrouter: { type: 'api', key: fakeRouterKey },
      }),
      'utf8',
    );

    const requests: { readonly url: string; readonly authorization: string | undefined }[] = [];
    const fetch: ProbeFetch = async (url, init) => {
      requests.push({ url, authorization: init.headers['authorization'] });
      if (url === OPENAI_USAGE_ENDPOINT) {
        return response({
          plan_type: 'plus',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {
              used_percent: 3,
              limit_window_seconds: 18_000,
              reset_at: 1_893_456_000,
            },
            secondary_window: {
              used_percent: 0,
              limit_window_seconds: 604_800,
              reset_at: 1_893_974_400,
            },
          },
        });
      }
      if (url === OPENCODE_GO_USAGE_ENDPOINT) {
        return response({
          usage: {
            rolling: { status: 'ok', percent: 1, resetsAt: '2030-01-01T00:00:00.000Z' },
            weekly: { status: 'ok', percent: 0, resetsAt: '2030-01-07T00:00:00.000Z' },
            monthly: { status: 'ok', percent: 0, resetsAt: '2030-02-01T00:00:00.000Z' },
          },
        });
      }
      if (url === OPENROUTER_CREDITS_ENDPOINT) {
        return response({ data: { total_credits: 13, total_usage: 3.39 } });
      }
      throw new Error(`endpoint inesperado ${url}`);
    };
    const probe = createProductionPoolCapacityProbe({
      paths: resolveHarnessPaths(REPO_ROOT),
      credentialPaths: { codexAuthFile, opencodeAuthFile },
      fetch,
      now: () => new Date(OBSERVED_AT),
    });
    const profiles = await Promise.all(
      [
        'codex-build-worker-subscription-sol-medium-v2',
        'opencode-openai-gpt-5.6-sol-v1',
        'opencode-go-glm-5.3-v1',
        'opencode-openrouter-qwen3-coder-api-v1',
      ].map((id) => loadProfileFromCatalog(REPO_ROOT, id)),
    );

    const observed = await observeEligiblePoolCapacities(profiles, probe);

    expect([...observed.keys()].sort()).toEqual([
      'openai_chatgpt_subscription',
      'opencode_go_subscription',
      'openrouter_balance',
    ]);
    expect(requests.filter((entry) => entry.url === OPENAI_USAGE_ENDPOINT)).toHaveLength(1);
    expect(requests.find((entry) => entry.url === OPENAI_USAGE_ENDPOINT)?.authorization).toBe(
      `Bearer ${fakeToken}`,
    );
    expect(observed.get('opencode_go_subscription')?.windows.map((window) => window.used_percent)).toEqual([
      1,
      0,
      0,
    ]);
    expect(observed.get('openrouter_balance')?.balance?.remaining).toBeCloseTo(9.61, 6);
    const serialized = JSON.stringify([...observed.values()]);
    for (const secret of [fakeToken, fakeAccount, fakeGoKey, fakeRouterKey, 'fallback-token']) {
      expect(serialized).not.toContain(secret);
    }
    const failed = await observeEligiblePoolCapacities([profiles[0] as LauncherProfile], async () => {
      throw new Error(`network failed with ${fakeToken}`);
    });
    expect(JSON.stringify([...failed.values()])).not.toContain(fakeToken);
    expect(failed.get('openai_chatgpt_subscription')?.status).toBe('UNKNOWN');
  });
});

const PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: capacidade atual
    objective: criar um arquivo local
    initial_files: [README.md]
    acceptance: ['mudança validada']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;

const PROFILES = {
  codex: 'codex-build-worker-subscription-sol-medium-v2',
  openai: 'opencode-openai-gpt-5.6-sol-v1',
  go: 'opencode-go-glm-5.3-v1',
} as const;

function authorizationYaml(profileIds: readonly string[]): string {
  return [
    'schema_version: 1',
    'requested_scope:',
    '  summary: executar uma work unit local',
    'constraints: []',
    'exclusions: []',
    'autonomous_execution_boundary:',
    '  - CONFIGURED_SUBSCRIPTION_WORKER',
    '  - DETERMINISTIC_VALIDATION',
    'human_gated_capabilities:',
    '  - UNAUTHORIZED_API_BILLING',
    '  - NEW_CREDENTIAL_BOUNDARY',
    'billing:',
    '  allowed_billing_modes: [subscription_only]',
    'profile_policy:',
    '  id: live-capacity-test',
    '  allowed_providers: [codex, opencode]',
    '  selection_policy: evidence_balanced',
    '  profiles:',
    ...profileIds.flatMap((id, index) => [
      `    - id: ${id}`,
      `      capability_rank: ${index}`,
      '      rationale: profile autorizado pelo teste',
    ]),
    'review: {}',
    'work_units:',
    '  default:',
    '    task_class: feature',
    '    difficulty_declared: easy',
    '    risk: low',
    '    complexity: local',
    '    ambiguity: low',
    '    verification: deterministic',
    '    resource_envelope:',
    '      duration_ms: {expected: 20000, maximum: 60000}',
    '      tokens: {expected: 30000, maximum: 90000}',
    '      changed_files: {expected: 3, maximum: 8}',
    '',
  ].join('\n');
}

function credentialRunner(): CommandRunner {
  return async (_command, args) => ({
    code: 0,
    output:
      args[0] === 'login'
        ? 'Logged in using ChatGPT'
        : ['OpenAI oauth', 'OpenCode Go api', 'OpenRouter api'].join('\n'),
  });
}

interface RoutingFixture {
  readonly paths: HarnessPaths;
  readonly loaded: Awaited<ReturnType<typeof loadPlan>>;
  readonly authorizationFile: string;
}

async function routingFixture(profileIds: readonly string[]): Promise<RoutingFixture> {
  const sandbox = await makeSandboxRepo(PLAN);
  roots.push(sandbox.root);
  await writeFile(
    path.join(sandbox.root, 'package.json'),
    `${JSON.stringify({ name: 'capacity-target', private: true }, null, 2)}\n`,
    'utf8',
  );
  const baseline = await commitAll(sandbox.root, 'add target metadata');
  const paths = resolveHarnessPaths(sandbox.root, { profileCatalogRoot: REPO_ROOT });
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }));
  const outside = await temporaryDir('agentlab-capacity-policy-');
  const authorizationFile = path.join(outside, 'agentlab-run.yaml');
  await writeFile(authorizationFile, authorizationYaml(profileIds), 'utf8');
  return { paths, loaded, authorizationFile };
}

let launchOrdinal = 0;

async function writeHistoricalCapacity(
  paths: HarnessPaths,
  profileId: string,
  observation: PoolCapacityObservation,
): Promise<void> {
  launchOrdinal += 1;
  await mkdir(paths.logsDir, { recursive: true });
  const record = LaunchRecord.parse({
    schema_version: 1,
    task_id: `H${launchOrdinal}`,
    profile_id: profileId,
    argv: ['fixture-worker'],
    process: {
      pid: launchOrdinal,
      pgid: launchOrdinal,
      started_at: `2026-08-2${launchOrdinal}T00:00:00.000Z`,
      proc_start_ticks: 0,
      command_sha256: String(launchOrdinal).repeat(64),
    },
    launch_id: `00000000-0000-4000-8000-${String(launchOrdinal).padStart(12, '0')}`,
    started_at: `2026-08-2${launchOrdinal}T00:00:00.000Z`,
    finished_at: `2026-08-2${launchOrdinal}T00:01:00.000Z`,
    duration_ms: 60_000,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    pool_capacity: {
      quota_pool: observation.quota_pool,
      before: observation,
      after: observation,
      deltas: [],
    },
  });
  await writeFile(launchRecordPath(paths, record.task_id), `${JSON.stringify(record)}\n`, 'utf8');
}

function poolForProfile(profile: LauncherProfile): string {
  if (profile.agent === 'codex' || profile.provider === 'openai') {
    return 'openai_chatgpt_subscription';
  }
  if (profile.provider === 'opencode_go') return 'opencode_go_subscription';
  throw new Error(`profile inesperado ${profile.id}`);
}

async function previewWith(
  fixture: RoutingFixture,
  probe: PoolCapacityProbe,
) {
  const authorization = await loadProjectRunAuthorization(fixture.authorizationFile);
  const controlPlane = await createProjectControlPlane({
    paths: fixture.paths,
    loaded: fixture.loaded,
    authorization: authorization.file,
    authorizationFile: authorization.source_file,
    historyLabRoot: await temporaryDir('agentlab-capacity-history-'),
    credentialRunner: credentialRunner(),
    poolCapacityProbe: probe,
  });
  return controlPlane.previewNextAction({ taskId: 'T1' });
}

describe('capacidade fresca no routing de produção', () => {
  it('quota consumida fora do Lab substitui LaunchRecord histórico stale', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.go]);
    await writeHistoricalCapacity(
      fixture.paths,
      PROFILES.codex,
      knownCapacity({ pool: 'openai_chatgpt_subscription', used: 5, source: 'history:openai-high' }),
    );
    await writeHistoricalCapacity(
      fixture.paths,
      PROFILES.go,
      knownCapacity({ pool: 'opencode_go_subscription', used: 80, source: 'history:go-low' }),
    );
    const preview = await previewWith(fixture, async (profile) =>
      poolForProfile(profile) === 'openai_chatgpt_subscription'
        ? knownCapacity({ pool: 'openai_chatgpt_subscription', used: 99, source: 'fresh:openai-low' })
        : knownCapacity({ pool: 'opencode_go_subscription', used: 13, source: 'fresh:go-current' }),
    );

    expect(preview.status, JSON.stringify(preview, null, 2)).toBe('READY');
    expect(preview.work_unit?.routing.selected_profile_id).toBe(PROFILES.go);
    const candidates = preview.work_unit?.routing.selection?.balanced_candidates ?? [];
    expect(candidates.find((entry) => entry.profile_id === PROFILES.codex)?.quota_headroom).toMatchObject({
      status: 'OBSERVED',
      remaining_pct: 1,
      provenance: expect.stringContaining('fresh:openai-low'),
    });
  });

  it('Codex e OpenCode/OpenAI compartilham um probe e um EXHAUSTED', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.openai, PROFILES.go]);
    const calls = new Map<string, number>();
    const preview = await previewWith(fixture, async (profile) => {
      const pool = poolForProfile(profile);
      calls.set(pool, (calls.get(pool) ?? 0) + 1);
      return pool === 'openai_chatgpt_subscription'
        ? exhaustedCapacity(pool)
        : knownCapacity({ pool, used: 40 });
    });

    expect(preview.status, JSON.stringify(preview, null, 2)).toBe('READY');
    expect(preview.work_unit?.routing.selected_profile_id).toBe(PROFILES.go);
    expect(calls.get('openai_chatgpt_subscription')).toBe(1);
    expect(preview.work_unit?.routing.rationale.join('\n')).toContain('QUOTA_POOL_EXHAUSTED');
    expect(preview.status).not.toBe('HUMAN_REQUIRED');
  });

  it('UNKNOWN fresco não fabrica zero e não apaga histórico válido', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.go]);
    await writeHistoricalCapacity(
      fixture.paths,
      PROFILES.codex,
      knownCapacity({ pool: 'openai_chatgpt_subscription', used: 10, source: 'history:valid-openai' }),
    );
    await writeHistoricalCapacity(
      fixture.paths,
      PROFILES.go,
      knownCapacity({ pool: 'opencode_go_subscription', used: 90, source: 'history:valid-go' }),
    );
    const preview = await previewWith(fixture, async (profile) => {
      const pool = poolForProfile(profile);
      return pool === 'openai_chatgpt_subscription'
        ? unknownCapacity(pool)
        : knownCapacity({ pool, used: 90, source: 'fresh:go-low' });
    });

    expect(preview.status, JSON.stringify(preview, null, 2)).toBe('READY');
    expect(preview.work_unit?.routing.selected_profile_id).toBe(PROFILES.codex);
    const openai = preview.work_unit?.routing.selection?.balanced_candidates.find(
      (entry) => entry.profile_id === PROFILES.codex,
    );
    expect(openai?.quota_headroom).toMatchObject({
      status: 'OBSERVED',
      remaining_pct: 90,
      provenance: expect.stringContaining('fallback histórico'),
    });
    expect(JSON.stringify(preview)).not.toMatch(/"remaining_pct":0\b/);
    expect(JSON.stringify(preview)).toContain('falha de rede no probe fresco');
  });

  it('1% restante continua elegível quando o provider não declarou esgotamento', async () => {
    const fixture = await routingFixture([PROFILES.codex]);
    let probes = 0;
    const preview = await previewWith(fixture, async () => {
      probes += 1;
      return knownCapacity({ pool: 'openai_chatgpt_subscription', used: 99 });
    });

    expect(preview.status).toBe('READY');
    expect(probes).toBe(1);
    expect(preview.work_unit?.routing.selected_profile_id).toBe(PROFILES.codex);
    expect(preview.work_unit?.routing.rationale.join('\n')).not.toContain('QUOTA_POOL_EXHAUSTED');
  });
});

describe('capacidade antes/depois no launch de produção', () => {
  async function launchFixture(): Promise<RoutingFixture> {
    return routingFixture(['fake-worker-v1']);
  }

  async function launchWithSnapshots(
    fixture: RoutingFixture,
    before: PoolCapacityObservation,
    after: PoolCapacityObservation,
  ) {
    const task = fixture.loaded.byId.get('T1');
    if (task === undefined) throw new Error('fixture sem T1');
    const packet = buildTaskPacket({
      task,
      baseSha: await headSha(fixture.paths.repoRoot),
      previousHandoff: null,
    });
    let calls = 0;
    const result = await launchTask(
      fixture.paths,
      packet,
      'fake-worker-v1',
      undefined,
      {
        before,
        probe: async () => {
          calls += 1;
          return after;
        },
      },
    );
    return { result, calls, record: await readLaunchRecord(fixture.paths, 'T1') };
  }

  it('launchTask normal reutiliza o snapshot de routing e persiste delta comparável', async () => {
    const fixture = await launchFixture();
    const launched = await launchWithSnapshots(
      fixture,
      knownCapacity({ pool: 'scaffold:fake', used: 10, windowInstance: '2030-01-01T00:00:00.000Z' }),
      knownCapacity({ pool: 'scaffold:fake', used: 15, windowInstance: '2030-01-01T00:00:00.000Z' }),
    );

    expect(launched.result.classification).toBe('FINISHED');
    expect(launched.calls).toBe(1);
    expect(launched.record?.pool_capacity).toMatchObject({
      quota_pool: 'scaffold:fake',
      before: { windows: [{ used_percent: 10 }] },
      after: { windows: [{ used_percent: 15 }] },
      deltas: [{ consumed_pp: 5, same_window: true, window_reset: false }],
    });
  });

  it('virada de janela persiste reset e nunca subtrai snapshots incomparáveis', async () => {
    const fixture = await launchFixture();
    const launched = await launchWithSnapshots(
      fixture,
      knownCapacity({ pool: 'scaffold:fake', used: 99, windowInstance: '2030-01-01T00:00:00.000Z' }),
      knownCapacity({ pool: 'scaffold:fake', used: 1, windowInstance: '2030-01-02T00:00:00.000Z' }),
    );

    expect(launched.record?.pool_capacity?.deltas).toMatchObject([
      { consumed_pp: null, same_window: false, window_reset: true },
    ]);
  });

  it('runOrchestrate recebe do control plane o baseline fresco e só reproba depois do worker', async () => {
    const fixture = await launchFixture();
    const fakeAuthorization = [
      'schema_version: 1',
      'requested_scope: {summary: executar worker falso sem provider}',
      'constraints: []',
      'exclusions: []',
      'autonomous_execution_boundary: [CONFIGURED_SUBSCRIPTION_WORKER, DETERMINISTIC_VALIDATION]',
      'human_gated_capabilities: [UNAUTHORIZED_API_BILLING]',
      'billing: {allowed_billing_modes: [not_applicable]}',
      'profile_policy:',
      '  id: fake-production-capacity',
      '  allowed_providers: [fake]',
      '  selection_policy: evidence_balanced',
      '  profiles:',
      '    - id: fake-worker-economy-v1',
      '      capability_rank: 0',
      '      rationale: test double sem inferência',
      'review: {}',
      'work_units:',
      '  default:',
      '    task_class: feature',
      '    difficulty_declared: easy',
      '    risk: low',
      '    complexity: local',
      '    ambiguity: low',
      '    verification: deterministic',
      '    resource_envelope:',
      '      duration_ms: {expected: 20000, maximum: 60000}',
      '      tokens: {expected: 30000, maximum: 90000}',
      '      changed_files: {expected: 3, maximum: 8}',
      '',
    ].join('\n');
    await writeFile(fixture.authorizationFile, fakeAuthorization, 'utf8');
    const authorization = await loadProjectRunAuthorization(fixture.authorizationFile);
    const observations = [
      knownCapacity({ pool: 'scaffold:codex', used: 10, source: 'fresh:routing-baseline' }),
      knownCapacity({ pool: 'scaffold:codex', used: 14, source: 'fresh:after-worker' }),
    ];
    let probes = 0;
    const progress: LabProgressEvent[] = [];
    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded: fixture.loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: await temporaryDir('agentlab-capacity-history-'),
      credentialRunner: credentialRunner(),
      poolCapacityProbe: async () => observations[probes++] ?? unknownCapacity('scaffold:codex'),
      onProgress: (event) => progress.push(event),
    });

    const result = await runOrchestrate({
      paths: fixture.paths,
      loaded: fixture.loaded,
      profileId: 'fake-worker-economy-v1',
      maxIterations: 1,
      skipPreflight: true,
      controlPlane,
      onProgress: (event) => progress.push(event),
    });
    const record = await readLaunchRecord(fixture.paths, 'T1');

    expect(result.iterationCount).toBe(1);
    expect(probes).toBe(2);
    expect(record?.pool_capacity).toMatchObject({
      quota_pool: 'scaffold:codex',
      before: { source: 'fresh:routing-baseline' },
      after: { source: 'fresh:after-worker' },
      deltas: [{ consumed_pp: 4, window_reset: false }],
    });
    expect(progress.find((event) => event.stage === 'ROUTED')?.task).toMatchObject({
      quota_pool: 'scaffold:codex',
      quota: { status: 'OBSERVED' },
    });
    expect(progress.find((event) => event.stage === 'VALIDATING')?.task?.quota).toMatchObject({
      status: 'OBSERVED',
      windows: [{ consumed_pp: 4 }],
    });
  });
});

/**
 * Saldo e autorização são perguntas independentes. O observador read-only diz
 * quanto dinheiro existe; ele nunca diz que gastá-lo está autorizado. A
 * autorização continua sendo a variável manual do ORQUESTRADOR, e saldo zero
 * continua sendo esgotamento REAL de recurso — não uma preferência de routing.
 */
describe('OpenRouter: saldo observado não é autorização de cobrança', () => {
  const ROUTER_PROFILE = 'opencode-openrouter-qwen3-coder-api-v1';

  function balanceCapacity(remaining: number): PoolCapacityObservation {
    return PoolCapacityObservation.parse({
      schema_version: 1,
      quota_pool: 'openrouter_balance',
      status: remaining > 0 ? CapacityStatus.KNOWN : CapacityStatus.EXHAUSTED,
      windows: [],
      balance: { remaining, currency: 'USD', precision: CapacityPrecision.CURRENCY },
      plan: null,
      reason:
        remaining > 0
          ? 'saldo pré-pago observado; observar saldo não autoriza gastá-lo'
          : 'saldo pré-pago esgotado: inferência por uso não tem recurso',
      source: OPENROUTER_CREDITS_ENDPOINT,
      observed_at: OBSERVED_AT,
    });
  }

  async function routerFacts(
    capacity: PoolCapacityObservation,
    authorized: boolean,
  ) {
    const previous = process.env[API_BILLING_AUTHORIZATION_VARIABLE];
    if (authorized) {
      process.env[API_BILLING_AUTHORIZATION_VARIABLE] = API_BILLING_AUTHORIZATION_VALUE;
    } else {
      delete process.env[API_BILLING_AUTHORIZATION_VARIABLE];
    }
    try {
      return await collectProjectLaunchFacts({
        paths: resolveHarnessPaths(REPO_ROOT),
        profile: await loadProfileFromCatalog(REPO_ROOT, ROUTER_PROFILE),
        homeNamespace: 'openrouter-capacity-homes',
        runner: credentialRunner(),
        capacityObservation: capacity,
      });
    } finally {
      if (previous === undefined) delete process.env[API_BILLING_AUTHORIZATION_VARIABLE];
      else process.env[API_BILLING_AUTHORIZATION_VARIABLE] = previous;
    }
  }

  it('saldo positivo SEM autorização explícita não torna o profile elegível', async () => {
    const facts = await routerFacts(balanceCapacity(9.61), false);

    expect(facts.provider.availability).toBe(false);
    expect(facts.billing_refusal).toContain(API_BILLING_AUTHORIZATION_VARIABLE);
    // A recusa é de COBRANÇA, não de capacidade: o saldo continua observado.
    expect(facts.quota.availability).toBe(true);
    expect(facts.quota.provenance).toContain('openrouter_balance');
  });

  it('saldo positivo COM autorização explícita é elegível', async () => {
    const facts = await routerFacts(balanceCapacity(9.61), true);

    expect(facts.provider.availability).toBe(true);
    expect(facts.billing_refusal).toBeNull();
    expect(facts.quota.availability).toBe(true);
  });

  it('saldo zerado COM autorização é esgotamento monetário real', async () => {
    const facts = await routerFacts(balanceCapacity(0), true);

    expect(facts.quota.availability).toBe(false);
    expect(facts.quota.provenance).toContain('saldo pré-pago esgotado');
  });

  it('saldo UNKNOWN não vira zero nem esgotamento', async () => {
    const facts = await routerFacts(unknownCapacity('openrouter_balance'), true);

    expect(facts.quota.availability).toBeNull();
    expect(facts.quota.provenance).toContain('UNKNOWN');
    expect(JSON.stringify(facts)).not.toContain('esgotad');
  });
});
