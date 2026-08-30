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
import {
  collectCurrentLaunchFacts,
  collectProjectLaunchFacts,
} from '../../dev/lib/project-preflight.js';
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
  /**
   * Instante da LEITURA. Importa para a identidade da janela: uma janela só
   * pode ter virado se a leitura posterior aconteceu depois do reset que a
   * anterior declarou — timestamp futuro reprevisto não é janela nova.
   */
  readonly observedAt?: string;
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
    observed_at: input.observedAt ?? OBSERVED_AT,
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

function authorizationYaml(
  profileIds: readonly string[],
  selectionPolicy: 'evidence_balanced' | 'static_cost' = 'evidence_balanced',
): string {
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
    `  selection_policy: ${selectionPolicy}`,
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

async function routingFixture(
  profileIds: readonly string[],
  selectionPolicy: 'evidence_balanced' | 'static_cost' = 'evidence_balanced',
): Promise<RoutingFixture> {
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
  await writeFile(authorizationFile, authorizationYaml(profileIds, selectionPolicy), 'utf8');
  return { paths, loaded, authorizationFile };
}

/** Mesma fixture, `selection_policy: static_cost` — a folga não desempata lá. */
async function staticCostFixture(profileIds: readonly string[]): Promise<RoutingFixture> {
  return routingFixture(profileIds, 'static_cost');
}

let launchOrdinal = 0;

async function writeHistoricalCapacity(
  paths: HarnessPaths,
  profileId: string,
  observation: PoolCapacityObservation,
): Promise<string> {
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
  const file = launchRecordPath(paths, record.task_id);
  await writeFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
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

  it('pin de repair num pool EXHAUSTED faz failover na policy — não HUMAN_REQUIRED', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.go]);
    const authorization = await loadProjectRunAuthorization(fixture.authorizationFile);
    const controlPlane = await createProjectControlPlane({
      paths: fixture.paths,
      loaded: fixture.loaded,
      authorization: authorization.file,
      authorizationFile: authorization.source_file,
      historyLabRoot: await temporaryDir('agentlab-capacity-history-'),
      credentialRunner: credentialRunner(),
      poolCapacityProbe: async (profile) => {
        const pool = poolForProfile(profile);
        return pool === 'openai_chatgpt_subscription'
          ? exhaustedCapacity(pool)
          : knownCapacity({ pool, used: 20, source: 'fresh:go-available' });
      },
    });

    const decision = await controlPlane.beforeWorkUnit({
      taskId: 'T1',
      attemptKind: 'FIRST_PASS',
      pinnedProfileId: PROFILES.codex,
    });

    expect(decision.outcome, JSON.stringify(decision, null, 2)).toBe('LAUNCH');
    if (decision.outcome !== 'LAUNCH') return;
    expect(decision.profile_id).toBe(PROFILES.go);
  });

  it('UNKNOWN fresco permanece UNKNOWN: folga histórica OBSERVED não o preenche', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.go]);
    // Histórico rico e recente: 90% de folga OpenAI gravada por um launch
    // anterior. Sob a política antiga ele virava a folga "atual" do Codex.
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
    const openai = preview.work_unit?.routing.selection?.balanced_candidates.find(
      (entry) => entry.profile_id === PROFILES.codex,
    );
    expect(openai?.quota_headroom).toMatchObject({
      status: 'UNKNOWN',
      reason: expect.stringContaining('falha de rede no probe fresco'),
    });
    const serialized = JSON.stringify(preview);
    expect(serialized).not.toContain('history:valid-openai');
    expect(serialized).not.toContain('fallback histórico');
    // UNKNOWN também nunca vira zero, e nunca remove o profile do routing.
    expect(serialized).not.toMatch(/"remaining_pct":0\b/);
    expect(preview.work_unit?.routing.rationale.join('\n')).not.toContain('QUOTA_POOL_EXHAUSTED');
  });

  it('EXHAUSTED histórico não bloqueia a atividade atual quando o probe fresco é UNKNOWN', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.go]);
    await writeHistoricalCapacity(
      fixture.paths,
      PROFILES.codex,
      exhaustedCapacity('openai_chatgpt_subscription'),
    );
    const preview = await previewWith(fixture, async (profile) => {
      const pool = poolForProfile(profile);
      return pool === 'openai_chatgpt_subscription'
        ? unknownCapacity(pool)
        : knownCapacity({ pool, used: 50, source: 'fresh:go' });
    });

    expect(preview.status, JSON.stringify(preview, null, 2)).toBe('READY');
    const openai = preview.work_unit?.routing.selection?.balanced_candidates.find(
      (entry) => entry.profile_id === PROFILES.codex,
    );
    // O Codex continua ELEGÍVEL: o esgotamento antigo já pode ter resetado, e
    // só evidência atual tem autoridade sobre a execução de agora.
    expect(openai?.quota_headroom).toMatchObject({ status: 'UNKNOWN' });
    expect(preview.work_unit?.routing.rationale.join('\n')).not.toContain('QUOTA_POOL_EXHAUSTED');
  });

  it('cada work unit reobserva o pool: o snapshot anterior nunca é reaproveitado', async () => {
    const fixture = await routingFixture([PROFILES.codex]);
    const readings: string[] = [];
    const probe: PoolCapacityProbe = async (profile) => {
      const source = `fresh:reading-${readings.length + 1}`;
      readings.push(source);
      return knownCapacity({ pool: poolForProfile(profile), used: readings.length, source });
    };

    const first = await previewWith(fixture, probe);
    const second = await previewWith(fixture, probe);

    expect(first.status).toBe('READY');
    expect(second.status).toBe('READY');
    // Dois assessments, duas leituras. Não há cache nem TTL entre atividades.
    expect(readings).toEqual(['fresh:reading-1', 'fresh:reading-2']);
    expect(
      second.work_unit?.routing.selection?.balanced_candidates[0]?.quota_headroom,
    ).toMatchObject({ provenance: expect.stringContaining('fresh:reading-2') });
    expect(JSON.stringify(second)).not.toContain('fresh:reading-1');
  });

  it('LaunchRecord com before/after de outra atividade não vira quota atual', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.go]);
    // before/after persistidos permanecem no disco como analytics do launch
    // concluído; a decisão de agora não os lê.
    const historicalFile = await writeHistoricalCapacity(
      fixture.paths,
      PROFILES.codex,
      knownCapacity({ pool: 'openai_chatgpt_subscription', used: 2, source: 'history:before-after' }),
    );
    let probes = 0;
    const preview = await previewWith(fixture, async (profile) => {
      probes += 1;
      return knownCapacity({
        pool: poolForProfile(profile),
        used: 60,
        source: 'fresh:this-activity',
      });
    });

    expect(preview.status, JSON.stringify(preview, null, 2)).toBe('READY');
    expect(probes).toBe(2);
    for (const candidate of preview.work_unit?.routing.selection?.balanced_candidates ?? []) {
      expect(candidate.quota_headroom).toMatchObject({
        status: 'OBSERVED',
        remaining_pct: 40,
        provenance: expect.stringContaining('fresh:this-activity'),
      });
    }
    expect(JSON.stringify(preview)).not.toContain('history:before-after');
    // A evidência histórica continua GRAVADA — ela só perdeu autoridade.
    const persisted = await readFile(historicalFile, 'utf8');
    expect(persisted).toContain('history:before-after');
    expect(JSON.parse(persisted).pool_capacity).toMatchObject({
      before: { source: 'history:before-after' },
      after: { source: 'history:before-after' },
    });
  });

  it('static_cost: esgotamento fresco recusa, folga não-esgotada não desempata', async () => {
    const exhausted = await staticCostFixture([PROFILES.codex, PROFILES.go]);
    const withExhaustion = await previewWith(exhausted, async (profile) => {
      const pool = poolForProfile(profile);
      return pool === 'openai_chatgpt_subscription'
        ? exhaustedCapacity(pool)
        : knownCapacity({ pool, used: 40 });
    });

    expect(withExhaustion.status, JSON.stringify(withExhaustion, null, 2)).toBe('READY');
    expect(withExhaustion.work_unit?.routing.selected_profile_id).toBe(PROFILES.go);
    expect(withExhaustion.work_unit?.routing.rationale.join('\n')).toContain('QUOTA_POOL_EXHAUSTED');

    // Mesma policy, mesmas capabilities: só a folga muda de lado. Sob
    // static_cost a escolha NÃO pode acompanhar a folga.
    const generous = await staticCostFixture([PROFILES.codex, PROFILES.go]);
    const codexRoomy = await previewWith(generous, async (profile) =>
      knownCapacity({
        pool: poolForProfile(profile),
        used: poolForProfile(profile) === 'openai_chatgpt_subscription' ? 20 : 80,
      }),
    );
    const tight = await staticCostFixture([PROFILES.codex, PROFILES.go]);
    const codexTight = await previewWith(tight, async (profile) =>
      knownCapacity({
        pool: poolForProfile(profile),
        used: poolForProfile(profile) === 'openai_chatgpt_subscription' ? 80 : 20,
      }),
    );

    expect(codexRoomy.work_unit?.routing.selected_profile_id).toBe(
      codexTight.work_unit?.routing.selected_profile_id,
    );
    // A folga não é sequer considerada sob static_cost — e a evidência diz isso.
    expect(codexRoomy.work_unit?.routing.selection?.quota_considered).toBe(false);
    expect(codexTight.work_unit?.routing.selection?.quota_considered).toBe(false);
    expect(codexRoomy.work_unit?.routing.selection?.balanced_candidates).toEqual([]);
  });

  it('evidence_balanced desempata pela folga FRESCA, nunca pela histórica', async () => {
    const fixture = await routingFixture([PROFILES.codex, PROFILES.go]);
    // Histórico diz que o Go está apertado; a leitura de agora diz o contrário.
    await writeHistoricalCapacity(
      fixture.paths,
      PROFILES.go,
      knownCapacity({ pool: 'opencode_go_subscription', used: 95, source: 'history:go-tight' }),
    );
    const preview = await previewWith(fixture, async (profile) =>
      knownCapacity({
        pool: poolForProfile(profile),
        used: poolForProfile(profile) === 'openai_chatgpt_subscription' ? 95 : 20,
        source: 'fresh:balanced',
      }),
    );

    expect(preview.status, JSON.stringify(preview, null, 2)).toBe('READY');
    expect(preview.work_unit?.routing.selected_profile_id).toBe(PROFILES.go);
    expect(preview.work_unit?.routing.selection?.quota_considered).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('history:go-tight');
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

/**
 * Planner, deliberador, reviewer e degrau de escalation não têm um regime de
 * quota próprio: todos passam por `collectCurrentLaunchFacts`, que observa o
 * pool DA ATIVIDADE. Estes testes exercem esse caminho compartilhado
 * diretamente, que é exatamente o que `run-project.ts` e `project-run.ts`
 * chamam para os roles não-implementer.
 */
describe('roles não-implementer observam quota da própria atividade', () => {
  const PLANNER_PROFILE = 'codex-build-worker-subscription-sol-medium-v2';

  it('cada atividade de role faz uma NOVA leitura, sem herdar a anterior', async () => {
    const profile = await loadProfileFromCatalog(REPO_ROOT, PLANNER_PROFILE);
    const paths = resolveHarnessPaths(REPO_ROOT);
    // LaunchRecord anterior existe e é irrelevante: o role nem o abre.
    const readings: string[] = [];
    const probe: PoolCapacityProbe = async () => {
      const source = `fresh:role-reading-${readings.length + 1}`;
      readings.push(source);
      return knownCapacity({ pool: 'openai_chatgpt_subscription', used: 30, source });
    };

    const planner = await collectCurrentLaunchFacts({
      paths,
      profile,
      probe,
      homeNamespace: 'planner-homes',
      runner: credentialRunner(),
    });
    const reviewer = await collectCurrentLaunchFacts({
      paths,
      profile,
      probe,
      homeNamespace: 'reviewer-homes',
      runner: credentialRunner(),
    });

    expect(readings).toEqual(['fresh:role-reading-1', 'fresh:role-reading-2']);
    expect(planner.quota.provenance).toContain('fresh:role-reading-1');
    expect(reviewer.quota.provenance).toContain('fresh:role-reading-2');
    expect(planner.quota.availability).toBe(true);
    expect(reviewer.quota.availability).toBe(true);
  });

  it('esgotamento FRESCO do pool reprova o role; probe UNKNOWN permanece UNKNOWN', async () => {
    const profile = await loadProfileFromCatalog(REPO_ROOT, PLANNER_PROFILE);
    const paths = resolveHarnessPaths(REPO_ROOT);

    const exhausted = await collectCurrentLaunchFacts({
      paths,
      profile,
      probe: async () => exhaustedCapacity('openai_chatgpt_subscription'),
      homeNamespace: 'planner-homes',
      runner: credentialRunner(),
    });
    const unknown = await collectCurrentLaunchFacts({
      paths,
      profile,
      probe: async () => unknownCapacity('openai_chatgpt_subscription'),
      homeNamespace: 'planner-homes',
      runner: credentialRunner(),
    });

    expect(exhausted.quota.availability).toBe(false);
    expect(unknown.quota.availability).toBeNull();
    expect(unknown.quota.provenance).toContain('não recorre a histórico');
  });

  it('dois profiles do MESMO pool na mesma decisão compartilham uma leitura', async () => {
    const profiles = await Promise.all(
      [PROFILES.codex, PROFILES.openai].map((id) => loadProfileFromCatalog(REPO_ROOT, id)),
    );
    const paths = resolveHarnessPaths(REPO_ROOT);
    let probes = 0;
    const probe: PoolCapacityProbe = async () => {
      probes += 1;
      return knownCapacity({ pool: 'openai_chatgpt_subscription', used: 7, source: 'fresh:shared' });
    };

    const observed = await observeEligiblePoolCapacities(profiles, probe);
    const facts = await Promise.all(
      profiles.map((profile) =>
        collectCurrentLaunchFacts({
          paths,
          profile,
          probe,
          observed,
          homeNamespace: 'deliberator-homes',
          runner: credentialRunner(),
        }),
      ),
    );

    expect(probes).toBe(1);
    for (const fact of facts) {
      expect(fact.quota.availability).toBe(true);
      expect(fact.quota.provenance).toContain('openai_chatgpt_subscription');
    }
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
    // A leitura posterior acontece DEPOIS do reset que a anterior declarou:
    // é assim que uma virada de janela real se parece.
    const launched = await launchWithSnapshots(
      fixture,
      knownCapacity({
        pool: 'scaffold:fake',
        used: 99,
        windowInstance: '2030-01-01T00:00:00.000Z',
        observedAt: '2029-12-31T23:50:00.000Z',
      }),
      knownCapacity({
        pool: 'scaffold:fake',
        used: 1,
        windowInstance: '2030-01-02T00:00:00.000Z',
        observedAt: '2030-01-01T00:05:00.000Z',
      }),
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
    paths: HarnessPaths = resolveHarnessPaths(REPO_ROOT),
  ) {
    const previous = process.env[API_BILLING_AUTHORIZATION_VARIABLE];
    if (authorized) {
      process.env[API_BILLING_AUTHORIZATION_VARIABLE] = API_BILLING_AUTHORIZATION_VALUE;
    } else {
      delete process.env[API_BILLING_AUTHORIZATION_VARIABLE];
    }
    try {
      return await collectProjectLaunchFacts({
        paths,
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

  it('recarga: saldo histórico ZERO não sobrevive a uma leitura fresca de 9,61', async () => {
    // Runtime isolado: o registro anterior existe em disco de verdade, mas
    // fora do runtime real do repositório.
    const paths = resolveHarnessPaths(await temporaryDir('agentlab-router-history-'), {
      profileCatalogRoot: REPO_ROOT,
    });
    // Registro anterior real: saldo zerado, esgotamento declarado.
    await writeHistoricalCapacity(paths, ROUTER_PROFILE, balanceCapacity(0));

    const facts = await routerFacts(balanceCapacity(9.61), true, paths);

    expect(facts.quota.availability).toBe(true);
    expect(facts.quota.provenance).toContain('saldo pré-pago observado');
    expect(facts.quota.provenance).not.toContain('esgotad');
  });

  it('recarga com probe fresco UNKNOWN: nem 9,61 nem zero histórico — UNKNOWN', async () => {
    const paths = resolveHarnessPaths(await temporaryDir('agentlab-router-history-'), {
      profileCatalogRoot: REPO_ROOT,
    });
    await writeHistoricalCapacity(paths, ROUTER_PROFILE, balanceCapacity(0));

    const facts = await routerFacts(unknownCapacity('openrouter_balance'), true, paths);

    expect(facts.quota.availability).toBeNull();
    expect(facts.quota.provenance).toContain('UNKNOWN não é zero');
  });

  it('saldo UNKNOWN não vira zero nem esgotamento', async () => {
    const facts = await routerFacts(unknownCapacity('openrouter_balance'), true);

    expect(facts.quota.availability).toBeNull();
    expect(facts.quota.provenance).toContain('UNKNOWN');
    expect(JSON.stringify(facts)).not.toContain('esgotad');
  });
});
