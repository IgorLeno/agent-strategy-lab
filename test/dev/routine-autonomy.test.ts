import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyRoutineIncident,
  resolveRoutinePreflight,
  validateRoutineCandidate,
  writeRoutineIncidentEvent,
  type RoutineAutonomyDriver,
  type RoutineCandidate,
  type RoutineIncidentContext,
  type RoutineReview,
} from '../../dev/lib/routine-autonomy.js';
import {
  buildRoutineAgentArgv,
  createRoutineAutonomyRuntime,
  parseRoutineReview,
  type RoutineRuntimeAgentInput,
  type RoutineRuntimeClone,
  type RoutineRuntimePort,
} from '../../dev/lib/routine-autonomy-runtime.js';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { headSha } from '../../dev/lib/git.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { loadProfile } from '../../dev/lib/profile.js';
import {
  readInfraFailedAttempt,
  readProtocolInvalidAttempt,
} from '../../dev/lib/records.js';
import { buildInitialState, ensureRuntimeDirs, readState, writeState } from '../../dev/lib/state.js';
import type { PreflightBlocker, PreflightResult } from '../../dev/lib/orchestrate-preflight.js';
import { commitAll, makeSandboxRepo, runDevCli } from './helpers.js';

const BASE = '4'.repeat(40);
const CANDIDATE = '5'.repeat(40);
const NOW = '2026-08-15T20:00:00.000Z';
const REPAIR_PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: primeira tarefa
    objective: criar src/t1.txt
    initial_files: [README.md]
    acceptance: ['arquivo criado']
    validation:
      - argv: ['grep', '-qx', 'repaired', 'src/t1.txt']
        timeout_seconds: 30
  - id: T2
    title: segunda tarefa
    blocked_by: [T1]
    include_previous_handoff: true
    objective: criar src/t2.txt
    acceptance: ['arquivo criado']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function blockedPreflight(
  blocker: PreflightBlocker,
  reason = `${blocker}: fixture`,
  taskId = 'M56',
  attempt = 2,
): PreflightResult {
  return {
    status: 'BLOCKED',
    maintenance: {
      status: 'NOOP',
      previous_authorized_head_sha: BASE,
      authorized_head_sha: BASE,
      commit_count: 0,
      adoption_kind: null,
      commits: [],
      validation_results: [],
      reason: null,
    },
    recover: {
      status: blocker === 'RECOVERY_ATTENTION' ? 'ATTENTION' : 'CLEAN',
      reconciliation_count: blocker === 'RECOVERY_ATTENTION' ? 1 : 0,
      reconciliations: [],
      plan_changed: false,
      state_was_missing: false,
      head_matches_authorized: true,
      authorized_head_sha: BASE,
      reason: blocker === 'RECOVERY_ATTENTION' ? reason : null,
    },
    next: {
      status: 'SELECTED',
      reason: 'M56 selecionada',
      task_id: taskId,
      title: 'fixture',
      attempt,
      attempt_kind: null,
      base_sha: BASE,
      authorized_head_sha: BASE,
      ready_to_launch: false,
      blocker: null,
      blocker_reason: reason,
    },
    blocker,
    reason,
  };
}

function readyPreflight(): PreflightResult {
  const result = blockedPreflight('HISTORICAL_GAP');
  return {
    ...result,
    status: 'READY',
    next: result.next && { ...result.next, attempt_kind: 'FIRST_PASS', ready_to_launch: true },
    blocker: null,
    reason: null,
  };
}

function context(overrides: Partial<RoutineIncidentContext> = {}): RoutineIncidentContext {
  return {
    preflight: blockedPreflight('HISTORICAL_GAP'),
    authorized_head_before: BASE,
    task_id: 'M56',
    attempt: 1,
    lifecycle_records: ['ProtocolInvalidAttemptRecord'],
    ...overrides,
  };
}

function gate(argv: readonly string[]) {
  return { argv: [...argv], exit_code: 0, timed_out: false, duration_ms: 1 };
}

function candidate(overrides: Partial<RoutineCandidate> = {}): RoutineCandidate {
  return {
    sha: CANDIDATE,
    parent_sha: BASE,
    commit_count: 1,
    changed_files: ['dev/lib/automatic-repair.ts', 'test/dev/automatic-repair-policy.test.ts'],
    diff: '+ readProtocolInvalidAttempt\n',
    targeted_results: [gate(['pnpm', 'vitest', 'run', 'test/dev/automatic-repair-policy.test.ts'])],
    full_gate_results: [
      gate(['pnpm', 'typecheck']),
      gate(['pnpm', 'build']),
      gate(['pnpm', 'test']),
      gate(['git', 'diff', '--check', `${BASE}..${CANDIDATE}`]),
    ],
    working_tree_clean: true,
    diff_check_clean: true,
    task_provider_launches: 0,
    task_attempts_delta: 0,
    ...overrides,
  };
}

class FakeDriver implements RoutineAutonomyDriver {
  readonly calls: string[] = [];
  readonly completed = new Map<string, unknown>();
  candidates: RoutineCandidate[] = [candidate(), candidate({ sha: '6'.repeat(40) })];
  reviews: RoutineReview[] = [{ decision: 'ACCEPT', reason: 'correção mínima e coberta' }];
  retries: PreflightResult[] = [readyPreflight()];
  crashAfterAction: string | null = null;

  private async once<T>(actionId: string, value: T): Promise<T> {
    if (this.completed.has(actionId)) return this.completed.get(actionId) as T;
    this.calls.push(actionId);
    this.completed.set(actionId, value);
    if (this.crashAfterAction === actionId) {
      this.crashAfterAction = null;
      throw new Error(`crash after ${actionId}`);
    }
    return value;
  }

  recover(actionId: string): Promise<{ readonly action: string }> {
    return this.once(actionId, { action: 'deterministic recovery' });
  }

  maintain(actionId: string, _incident: RoutineIncidentContext, cycle: number) {
    return this.once(actionId, this.candidates[cycle] ?? candidate());
  }

  review(actionId: string, _incident: RoutineIncidentContext, _candidate: RoutineCandidate, cycle: number) {
    return this.once(actionId, this.reviews[cycle] ?? this.reviews.at(-1) as RoutineReview);
  }

  adopt(actionId: string, _incident: RoutineIncidentContext, selected: RoutineCandidate) {
    return this.once(actionId, { authorized_head_after: selected.sha, official_primitive: true as const });
  }

  retryPreflight(actionId: string) {
    const index = this.calls.filter((call) => call.endsWith(':retry')).length;
    return this.once(actionId, this.retries[index] ?? this.retries.at(-1) as PreflightResult);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'routine-autonomy-'));
  roots.push(root);
  return { root, paths: resolveHarnessPaths(root) };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function initializedSandbox(plan?: string) {
  const sandbox = plan === undefined ? await makeSandboxRepo() : await makeSandboxRepo(plan);
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: await headSha(sandbox.root) }),
  );
  return { sandbox, paths, loaded };
}

async function installFakeOrchestratorProfile(
  sandbox: Awaited<ReturnType<typeof makeSandboxRepo>>,
  paths: ReturnType<typeof resolveHarnessPaths>,
  loaded: Awaited<ReturnType<typeof loadPlan>>,
): Promise<string> {
  const profileId = 'fake-orchestrator-routine-v1';
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${profileId}.yaml`),
    [
      `id: ${profileId}`,
      'agent: fake',
      'commit_owner: orchestrator',
      'official_validation_owner: orchestrator',
      'worker_validation_policy: targeted',
      'argv: [node, fixtures/fake-worker.mjs]',
      'prompt_delivery: argv',
      'timeout_seconds: 60',
      'forbidden_flags: []',
      'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE]',
    ].join('\n'),
    'utf8',
  );
  const baseline = await commitAll(sandbox.root, 'fake orchestrator routine profile');
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }));
  return profileId;
}

describe('routine autonomy classification', () => {
  it('expõe somente as cinco recipes aprovadas com phase, action, boundary, tests e budget', async () => {
    const module = await import('../../dev/lib/routine-autonomy.js') as unknown as {
      ROUTINE_RECIPES: ReadonlyArray<{
        id: string;
        incident_phase: string;
        classification: string;
        action: string;
        boundary: string;
        targeted_tests: readonly string[];
        retry_budget: number;
      }>;
    };

    expect(module.ROUTINE_RECIPES.map((recipe) => recipe.id)).toEqual([
      'deterministic-recover',
      'protocol-invalid-history-integration',
      'protocol-output-recovery',
      'provider-infra-retry',
      'official-validation-repair',
    ]);
    expect(module.ROUTINE_RECIPES).toSatisfy((recipes: typeof module.ROUTINE_RECIPES) =>
      recipes.every(
        (recipe) =>
          ['PRE_FLIGHT', 'POST_LAUNCH'].includes(recipe.incident_phase) &&
          recipe.boundary.length > 0 &&
          recipe.targeted_tests.length > 0 &&
          recipe.retry_budget === 1,
      ),
    );
  });

  it('blocker determinístico de recovery é AUTO_RECOVER e não chega ao humano', () => {
    const preflight = blockedPreflight('RECOVERY_ATTENTION');
    expect(
      classifyRoutineIncident(context({ preflight, lifecycle_records: [] })),
    ).toMatchObject({ classification: 'AUTO_RECOVER', recipe_id: 'deterministic-recover' });
  });

  it('gap mecânico com somente ProtocolInvalidAttemptRecord é AUTO_MAINTENANCE', () => {
    expect(classifyRoutineIncident(context())).toMatchObject({
      classification: 'AUTO_MAINTENANCE',
      action: 'INTEGRATE_PROTOCOL_INVALID_HISTORY',
      recipe_id: 'protocol-invalid-history-integration',
    });
  });

  it('repair capability-bearing permanece TASK_REPAIR, fora da maintenance', () => {
    expect(
      classifyRoutineIncident(
        context({ preflight: blockedPreflight('AUTOMATIC_REPAIR_PROFILE_MISMATCH') }),
      ),
    ).toMatchObject({ classification: 'TASK_REPAIR', recipe_id: null });
  });

  it('evidência inconsistente nunca é normalizada automaticamente', () => {
    expect(
      classifyRoutineIncident(
        context({ lifecycle_records: ['ProtocolInvalidAttemptRecord', 'ValidationFailedAttemptRecord'] }),
      ),
    ).toMatchObject({ classification: 'HUMAN_REQUIRED' });
    expect(
      classifyRoutineIncident(context({ preflight: blockedPreflight('INCONSISTENT_EVIDENCE') })),
    ).toMatchObject({ classification: 'HUMAN_REQUIRED' });
  });

  it('erro textual aparentemente simples sem recipe permanece HUMAN_REQUIRED', () => {
    expect(
      classifyRoutineIncident(
        context({
          preflight: blockedPreflight('MAINTENANCE_BLOCKED', 'ajuste simples de uma linha'),
          lifecycle_records: [],
        }),
      ),
    ).toMatchObject({ classification: 'HUMAN_REQUIRED', recipe_id: null });
  });
});

describe('routine maintenance boundaries', () => {
  it.each([
    ['src/**', candidate({ changed_files: ['src/core/types.ts'] })],
    ['dev/plan.yaml', candidate({ changed_files: ['dev/plan.yaml'] })],
    ['billing policy', candidate({ changed_files: ['dev/lib/billing.ts'] })],
    ['profile billing/model policy', candidate({ changed_files: ['dev/profiles/worker.yaml'] })],
    ['record IO policy', candidate({ changed_files: ['dev/lib/records.ts'] })],
    ['schema policy', candidate({ changed_files: ['dev/lib/schemas.ts'] })],
    ['official adoption policy', candidate({ changed_files: ['dev/lib/maintenance.ts'] })],
    ['runtime state policy', candidate({ changed_files: ['dev/lib/state.ts'] })],
    ['autonomy recipe policy', candidate({ changed_files: ['dev/lib/routine-autonomy.ts'] })],
    ['autonomy runtime policy', candidate({ changed_files: ['dev/lib/routine-autonomy-runtime.ts'] })],
    ['autonomy orchestration policy', candidate({ changed_files: ['dev/cli/dev-orchestrate.ts'] })],
    ['historical evidence', candidate({ changed_files: ['.dev/failed-attempts/M56/record.json'] })],
    ['historical handoff', candidate({ changed_files: ['docs/M56-handoff.md'] })],
    ['schema version', candidate({ diff: '+ schema_version: 2\n' })],
    ['force push', candidate({ diff: '+ git push --force origin main\n' })],
    ['more than eight implementation/test files', candidate({ changed_files: Array.from({ length: 9 }, (_, index) => `dev/lib/f${index}.ts`) })],
  ])('%s exige humano', (_label, input) => {
    expect(validateRoutineCandidate(input, BASE)).toMatchObject({ ok: false });
  });

  it('recusa commit não filho direto, gates incompletos, provider de task e capability attempt', () => {
    for (const input of [
      candidate({ parent_sha: '7'.repeat(40) }),
      candidate({ commit_count: 2 }),
      candidate({ full_gate_results: [gate(['pnpm', 'test'])] }),
      candidate({ task_provider_launches: 1 }),
      candidate({ task_attempts_delta: 1 }),
    ]) {
      expect(validateRoutineCandidate(input, BASE)).toMatchObject({ ok: false });
    }
  });

  it('aceita a correção mínima com targeted tests, full gates e diff-check verdes', () => {
    expect(validateRoutineCandidate(candidate(), BASE)).toEqual({ ok: true });
  });
});

describe('routine autonomy state machine', () => {
  it('AUTO_RECOVER executa primitive idempotente e repete somente o preflight', async () => {
    const { paths } = await fixture();
    const driver = new FakeDriver();
    const initial = context({
      preflight: blockedPreflight('RECOVERY_ATTENTION'),
      lifecycle_records: [],
    });

    const result = await resolveRoutinePreflight({ paths, incident: initial, driver, now: () => NOW });

    expect(result.status).toBe('RECOVERED');
    expect(result.preflight.status).toBe('READY');
    expect(driver.calls.filter((call) => call.endsWith(':recover'))).toHaveLength(1);
    expect(driver.calls.filter((call) => call.endsWith(':retry'))).toHaveLength(1);
    expect(driver.calls.some((call) => call.includes('maintain'))).toBe(false);
  });

  it('reviewer REJECT permite uma correção e ACCEPT usa adoption oficial', async () => {
    const { paths } = await fixture();
    const driver = new FakeDriver();
    driver.reviews = [
      { decision: 'REJECT', reason: 'teste de regressão incompleto' },
      { decision: 'ACCEPT', reason: 'lacuna coberta' },
    ];

    const result = await resolveRoutinePreflight({ paths, incident: context(), driver, now: () => NOW });

    expect(result.status).toBe('RECOVERED');
    expect(driver.calls.filter((call) => call.includes(':maintain:'))).toHaveLength(2);
    expect(driver.calls.filter((call) => call.includes(':review:'))).toHaveLength(2);
    expect(driver.calls.filter((call) => call.endsWith(':adopt'))).toHaveLength(1);
    expect(result.record.maintenance_commit).toBe('6'.repeat(40));
  });

  it('segundo reviewer REJECT vira HUMAN_REQUIRED sem adoption nem retry', async () => {
    const { paths } = await fixture();
    const driver = new FakeDriver();
    driver.reviews = [
      { decision: 'REJECT', reason: 'primeira rejeição' },
      { decision: 'REJECT', reason: 'segunda rejeição' },
    ];

    const result = await resolveRoutinePreflight({ paths, incident: context(), driver, now: () => NOW });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.human_required?.decision_needed).toMatch(/segunda revisão/i);
    expect(driver.calls.some((call) => call.endsWith(':adopt'))).toBe(false);
    expect(driver.calls.some((call) => call.endsWith(':retry'))).toBe(false);
  });

  it('mesmo blocker após adoption vira HUMAN_REQUIRED e o retry ocorre uma vez', async () => {
    const { paths } = await fixture();
    const driver = new FakeDriver();
    driver.retries = [blockedPreflight('HISTORICAL_GAP')];

    const result = await resolveRoutinePreflight({ paths, incident: context(), driver, now: () => NOW });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.human_required?.why_automation_stopped).toMatch(/reapareceu/i);
    expect(driver.calls.filter((call) => call.endsWith(':retry'))).toHaveLength(1);
  });

  it('candidate fora da fronteira escala antes do reviewer', async () => {
    const { paths } = await fixture();
    const driver = new FakeDriver();
    driver.candidates = [candidate({ changed_files: ['src/forbidden.ts'] })];

    const result = await resolveRoutinePreflight({ paths, incident: context(), driver, now: () => NOW });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(driver.calls.some((call) => call.includes(':review:'))).toBe(false);
  });

  it('recusa da primitive oficial vira HUMAN_REQUIRED específico', async () => {
    const { paths } = await fixture();
    const driver = new FakeDriver();
    driver.adopt = async () => {
      throw new Error('dev-adopt-maintenance recusou working tree');
    };

    const result = await resolveRoutinePreflight({ paths, incident: context(), driver, now: () => NOW });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.human_required?.why_automation_stopped).toMatch(/dev-adopt-maintenance recusou/);
  });

  it('recusas de recovery, maintainer, reviewer e retry sempre viram HUMAN_REQUIRED terminal', async () => {
    const scenarios: Array<{
      readonly label: string;
      readonly incident: RoutineIncidentContext;
      readonly breakDriver: (driver: FakeDriver) => void;
    }> = [
      {
        label: 'recovery',
        incident: context({ preflight: blockedPreflight('RECOVERY_ATTENTION'), lifecycle_records: [] }),
        breakDriver: (driver) => {
          driver.recover = async () => { throw new Error('recovery recusado'); };
        },
      },
      {
        label: 'maintainer',
        incident: context(),
        breakDriver: (driver) => {
          driver.maintain = async () => { throw new Error('maintainer indisponível'); };
        },
      },
      {
        label: 'reviewer',
        incident: context(),
        breakDriver: (driver) => {
          driver.review = async () => { throw new Error('review ambíguo'); };
        },
      },
      {
        label: 'retry',
        incident: context(),
        breakDriver: (driver) => {
          driver.retryPreflight = async () => { throw new Error('preflight recusou'); };
        },
      },
    ];

    for (const scenario of scenarios) {
      const { paths } = await fixture();
      const driver = new FakeDriver();
      scenario.breakDriver(driver);
      const result = await resolveRoutinePreflight({
        paths,
        incident: scenario.incident,
        driver,
        now: () => NOW,
      });
      expect(result.status, scenario.label).toBe('HUMAN_REQUIRED');
      expect(result.human_required?.why_automation_stopped, scenario.label).toMatch(/recus|indisponível|ambíguo/);
      expect(
        await exists(path.join(paths.devDir, 'autonomy', 'incidents', `${result.record.incident_id}.json`)),
        scenario.label,
      ).toBe(true);
    }
  });

  it('record terminal e eventos são append-only', async () => {
    const { paths } = await fixture();
    const driver = new FakeDriver();
    const result = await resolveRoutinePreflight({ paths, incident: context(), driver, now: () => NOW });
    const recordPath = path.join(paths.devDir, 'autonomy', 'incidents', `${result.record.incident_id}.json`);
    const original = await readFile(recordPath);

    await expect(
      writeRoutineIncidentEvent(paths, result.record.incident_id, 'detected', { divergent: true }),
    ).rejects.toThrow(/diverge|append-only/i);
    expect(await readFile(recordPath)).toEqual(original);
    expect(await exists(path.join(paths.devDir, 'autonomy', 'incidents', result.record.incident_id, 'detected.json'))).toBe(true);
  });

  it('crash/restart reutiliza eventos persistidos e não duplica maintenance', async () => {
    const { paths } = await fixture();
    const incidentId = 'M56-1-444444444444-historical-gap';
    await writeRoutineIncidentEvent(paths, incidentId, 'maintain-1-completed', candidate());
    const restartedDriver = new FakeDriver();
    const result = await resolveRoutinePreflight({
      paths,
      incident: context(),
      driver: restartedDriver,
      now: () => NOW,
    });

    expect(result.status).toBe('RECOVERED');
    expect(restartedDriver.calls.filter((call) => call.includes(':maintain:'))).toHaveLength(0);
    expect(restartedDriver.calls.filter((call) => call.endsWith(':retry'))).toHaveLength(1);
  });

  it('restart depois do retry persistido não duplica adoption nem retry', async () => {
    const { paths } = await fixture();
    const incidentId = 'M56-1-444444444444-historical-gap';
    const accepted = candidate();
    await writeRoutineIncidentEvent(paths, incidentId, 'maintain-1-completed', accepted);
    await writeRoutineIncidentEvent(paths, incidentId, 'review-1-completed', {
      decision: 'ACCEPT',
      reason: 'ok',
    });
    await writeRoutineIncidentEvent(paths, incidentId, 'adopt-completed', {
      authorized_head_after: CANDIDATE,
      official_primitive: true,
    });
    await writeRoutineIncidentEvent(paths, incidentId, 'retry-completed', readyPreflight());
    const driver = new FakeDriver();

    const result = await resolveRoutinePreflight({ paths, incident: context(), driver, now: () => NOW });

    expect(result.status).toBe('RECOVERED');
    expect(driver.calls).toEqual([]);
  });
});

type PostIncident = {
  readonly phase: 'POST_LAUNCH';
  readonly authorized_head_before: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly profile_id: string;
  readonly launch: string;
  readonly close: string | null;
  readonly outcome: string;
  readonly reason: string;
  readonly task_status: string;
  readonly task_phase: string | null;
  readonly commit_owner: 'worker' | 'orchestrator' | null;
  readonly capability_verdict: boolean;
  readonly official_validation_failure: boolean;
  readonly evidence_paths: readonly string[];
};

function postIncident(overrides: Partial<PostIncident> = {}): PostIncident {
  return {
    phase: 'POST_LAUNCH',
    authorized_head_before: BASE,
    task_id: 'M56',
    attempt: 1,
    profile_id: 'fake-worker-v1',
    launch: 'FINISHED',
    close: 'PENDING',
    outcome: 'PENDING',
    reason: 'close operacional pendente',
    task_status: 'RUNNING',
    task_phase: 'FINALIZING',
    commit_owner: 'orchestrator',
    capability_verdict: false,
    official_validation_failure: false,
    evidence_paths: [],
    ...overrides,
  };
}

async function postAutonomyModule() {
  return await import('../../dev/lib/routine-autonomy.js') as unknown as {
    classifyRoutinePostLaunchIncident(incident: PostIncident): {
      classification: string;
      action: string;
      recipe_id: string | null;
    };
    routinePostLaunchIncidentId(incident: PostIncident): string;
    resolveRoutinePostLaunch<T>(input: {
      paths: ReturnType<typeof resolveHarnessPaths>;
      incident: PostIncident;
      driver: {
        recoverProtocolOutput(actionId: string, incident: PostIncident): Promise<{
          action: string;
          skip_retry?: boolean;
        }>;
        recoverInfra(actionId: string, incident: PostIncident): Promise<{
          action: string;
          skip_retry?: boolean;
        }>;
      };
      retrySameTask(actionId: string, incident: PostIncident): Promise<{
        incident: PostIncident;
        value: T;
      }>;
      now?: () => string;
    }): Promise<{
      status: 'RETRIED' | 'RECOVERED' | 'HUMAN_REQUIRED';
      retry: T | null;
      record: { phase?: string; outcome?: string; recipe_id?: string | null };
      human_required: { why_automation_stopped: string } | null;
    }>;
  };
}

describe('post-launch known incident autonomy', () => {
  it('reconhece somente facts estruturados da recipe de protocol output', async () => {
    const module = await postAutonomyModule();
    expect(module.classifyRoutinePostLaunchIncident(postIncident())).toMatchObject({
      classification: 'AUTO_RECOVER',
      action: 'RECOVER_PROTOCOL_OUTPUT',
      recipe_id: 'protocol-output-recovery',
    });
    expect(
      module.classifyRoutinePostLaunchIncident(
        postIncident({ reason: 'parece simples', commit_owner: 'worker' }),
      ),
    ).toMatchObject({ classification: 'HUMAN_REQUIRED', recipe_id: null });
  });

  it('protocol output usa primitive oficial e volta à mesma task sem maintainer', async () => {
    const module = await postAutonomyModule();
    const { paths } = await fixture();
    const calls: string[] = [];
    const result = await module.resolveRoutinePostLaunch({
      paths,
      incident: postIncident(),
      driver: {
        async recoverProtocolOutput(actionId) {
          calls.push(`protocol:${actionId}`);
          return { action: 'dev-recover-protocol-output' };
        },
        async recoverInfra(actionId) {
          calls.push(`infra:${actionId}`);
          return { action: 'dev-recover-infra' };
        },
      },
      async retrySameTask(actionId) {
        calls.push(`retry:${actionId}`);
        return {
          incident: postIncident({ attempt: 2, close: 'PASS', outcome: 'PASS', task_status: 'PASS', task_phase: null }),
          value: 'same-task-retry',
        };
      },
      now: () => NOW,
    });

    expect(result.status).toBe('RETRIED');
    expect(result.retry).toBe('same-task-retry');
    expect(calls.filter((call) => call.startsWith('protocol:'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('infra:'))).toHaveLength(0);
    expect(calls.filter((call) => call.startsWith('retry:'))).toHaveLength(1);
    expect(result.record).toMatchObject({
      phase: 'POST_LAUNCH',
      outcome: 'PENDING',
      recipe_id: 'protocol-output-recovery',
    });
  });

  it('recusa da primitive protocol vira HUMAN_REQUIRED sem retry', async () => {
    const module = await postAutonomyModule();
    const { paths } = await fixture();
    let retries = 0;
    const result = await module.resolveRoutinePostLaunch({
      paths,
      incident: postIncident(),
      driver: {
        async recoverProtocolOutput() {
          throw new Error('contrato estreito recusado');
        },
        async recoverInfra() {
          throw new Error('não deveria executar');
        },
      },
      async retrySameTask() {
        retries += 1;
        throw new Error('não deveria executar');
      },
    });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.human_required?.why_automation_stopped).toMatch(/contrato estreito recusado/);
    expect(retries).toBe(0);
  });

  it('output incompleto reabre READY sem retry de provider', async () => {
    const module = await postAutonomyModule();
    const { paths } = await fixture();
    const calls: string[] = [];
    const result = await module.resolveRoutinePostLaunch({
      paths,
      incident: postIncident(),
      driver: {
        async recoverProtocolOutput(actionId) {
          calls.push(`protocol:${actionId}`);
          return { action: 'dev-recover-incomplete-worker-output', skip_retry: true };
        },
        async recoverInfra() {
          throw new Error('não deveria executar');
        },
      },
      async retrySameTask() {
        calls.push('retry');
        throw new Error('não deveria executar');
      },
      now: () => NOW,
    });

    expect(result.status).toBe('RECOVERED');
    expect(result.retry).toBeNull();
    expect(calls.filter((call) => call.startsWith('protocol:'))).toHaveLength(1);
    expect(calls).not.toContain('retry');
    expect(result.record).toMatchObject({
      phase: 'POST_LAUNCH',
      outcome: 'PENDING',
      recipe_id: 'protocol-output-recovery',
    });
  });

  it('INFRA_ERROR recuperável usa a primitive oficial e repete uma vez o mesmo slot/profile', async () => {
    const module = await postAutonomyModule();
    const { paths } = await fixture();
    const calls: string[] = [];
    const initial = postIncident({
      launch: 'INFRA_ERROR',
      close: null,
      outcome: 'INFRA_ERROR',
      task_status: 'INFRA_ERROR',
      task_phase: null,
      commit_owner: 'worker',
    });
    const result = await module.resolveRoutinePostLaunch({
      paths,
      incident: initial,
      driver: {
        async recoverProtocolOutput() {
          throw new Error('não deveria executar');
        },
        async recoverInfra(actionId) {
          calls.push(`infra:${actionId}`);
          return { action: 'dev-recover-infra' };
        },
      },
      async retrySameTask(actionId) {
        calls.push(`retry:${actionId}`);
        return {
          incident: {
            ...initial,
            attempt: 2,
            launch: 'FINISHED',
            close: 'PASS',
            outcome: 'PASS',
            task_status: 'PASS',
          },
          value: 'infra-retry-pass',
        };
      },
    });

    expect(result.status).toBe('RETRIED');
    expect(result.retry).toBe('infra-retry-pass');
    expect(calls.filter((call) => call.startsWith('infra:'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('retry:'))).toHaveLength(1);
  });

  it('INFRA_ERROR capability-neutral recebe um retry e o segundo mesmo infra exige humano', async () => {
    const module = await postAutonomyModule();
    const { paths } = await fixture();
    const calls: string[] = [];
    const initial = postIncident({
      launch: 'INFRA_ERROR',
      close: null,
      outcome: 'INFRA_ERROR',
      task_status: 'INFRA_ERROR',
      task_phase: null,
      commit_owner: 'worker',
    });
    const result = await module.resolveRoutinePostLaunch({
      paths,
      incident: initial,
      driver: {
        async recoverProtocolOutput() {
          throw new Error('não deveria executar');
        },
        async recoverInfra(actionId) {
          calls.push(`infra:${actionId}`);
          return { action: 'dev-recover-infra' };
        },
      },
      async retrySameTask(actionId) {
        calls.push(`retry:${actionId}`);
        return { incident: { ...initial, attempt: 2 }, value: 'second-infra' };
      },
    });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.human_required?.why_automation_stopped).toMatch(/retry|reapareceu|budget/i);
    expect(calls.filter((call) => call.startsWith('infra:'))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('retry:'))).toHaveLength(1);
  });

  it('retry-started persistido impede replay cego e segundo provider', async () => {
    const module = await postAutonomyModule();
    const { paths } = await fixture();
    const incident = postIncident({
      launch: 'INFRA_ERROR',
      close: null,
      outcome: 'INFRA_ERROR',
      task_status: 'INFRA_ERROR',
      task_phase: null,
      commit_owner: 'worker',
    });
    const incidentId = module.routinePostLaunchIncidentId(incident);
    await writeRoutineIncidentEvent(paths, incidentId, 'retry-started', { action_id: `${incidentId}:retry` });
    let retries = 0;

    const result = await module.resolveRoutinePostLaunch({
      paths,
      incident,
      driver: {
        async recoverProtocolOutput() {
          throw new Error('não deveria executar');
        },
        async recoverInfra() {
          throw new Error('não deve repetir recovery após retry-started');
        },
      },
      async retrySameTask() {
        retries += 1;
        throw new Error('provider duplicado');
      },
    });

    expect(result.status).toBe('HUMAN_REQUIRED');
    expect(result.human_required?.why_automation_stopped).toMatch(/restart|replay|retry/i);
    expect(retries).toBe(0);
  });

  it('FAIL oficial continua classificado para automatic-repair existente', async () => {
    const module = await postAutonomyModule();
    expect(
      module.classifyRoutinePostLaunchIncident(
        postIncident({
          close: 'FAIL',
          outcome: 'FAIL',
          task_status: 'FAIL',
          task_phase: null,
          official_validation_failure: true,
        }),
      ),
    ).toMatchObject({
      classification: 'TASK_REPAIR',
      action: 'USE_EXISTING_TASK_REPAIR_POLICY',
      recipe_id: 'official-validation-repair',
    });
  });
});

class FakeRuntimePort implements RoutineRuntimePort {
  readonly calls: string[] = [];
  readonly agents: RoutineRuntimeAgentInput[] = [];
  cloneSequence = 0;
  reviewOutput = JSON.stringify({ decision: 'ACCEPT', reason: 'root cause corrigida' });
  activities: Array<{ attempts: number; launch_evidence: string }> = [];

  async createClone(sourceRepo: string, baseSha: string, actionId: string): Promise<RoutineRuntimeClone> {
    this.cloneSequence += 1;
    const clone = {
      clonePath: `/tmp/fake-routine-clone-${this.cloneSequence}`,
      sourceRepo,
      baseSha,
      branch: 'agent-workspace',
    };
    this.calls.push(`clone:${actionId}:${baseSha}`);
    return clone;
  }

  async disposeClone(clone: RoutineRuntimeClone): Promise<void> {
    this.calls.push(`dispose:${clone.clonePath}`);
  }

  async prepareClone(clone: RoutineRuntimeClone): Promise<void> {
    this.calls.push(`prepare:${clone.clonePath}`);
  }

  async observeTaskActivity(clone: RoutineRuntimeClone) {
    this.calls.push(`observe:${clone.clonePath}`);
    return this.activities.shift() ?? { attempts: 0, launch_evidence: 'unchanged' };
  }

  async runAgent(input: RoutineRuntimeAgentInput): Promise<string> {
    this.agents.push(input);
    this.calls.push(`agent:${input.role}:${input.profileId}:${input.clone.clonePath}`);
    return input.role === 'reviewer' ? this.reviewOutput : 'maintenance candidate committed';
  }

  async inspectCandidate(_clone: RoutineRuntimeClone, baseSha: string) {
    return {
      sha: CANDIDATE,
      parent_sha: baseSha,
      commit_count: 1,
      changed_files: ['dev/lib/automatic-repair.ts', 'test/dev/automatic-repair-policy.test.ts'],
      diff: '+ readProtocolInvalidAttempt\n',
      working_tree_clean: true,
      diff_check_clean: true,
    };
  }

  async assertReviewerReadOnly(clone: RoutineRuntimeClone, candidateSha: string): Promise<void> {
    this.calls.push(`readonly:${clone.clonePath}:${candidateSha}`);
  }

  async runValidation(argv: readonly string[], _cwd: string) {
    this.calls.push(`gate:${argv.join(' ')}`);
    return gate(argv);
  }

  async publishAndFastForward(_clone: RoutineRuntimeClone, baseSha: string, candidateSha: string) {
    this.calls.push(`publish:${baseSha}:${candidateSha}`);
  }

  async adoptOfficial(candidateSha: string) {
    this.calls.push(`adopt-official:${candidateSha}`);
    return candidateSha;
  }

  async applyRecovery() {
    this.calls.push('apply-recovery');
  }

  async runPreflight() {
    this.calls.push('preflight');
    return readyPreflight();
  }
}

describe('routine autonomy runtime', () => {
  it('runtime pós-launch delega protocol e infra somente às primitives oficiais', async () => {
    const module = await import('../../dev/lib/routine-autonomy-runtime.js') as unknown as {
      createRoutinePostLaunchRuntime(input: {
        paths: ReturnType<typeof resolveHarnessPaths>;
        port: {
          recoverProtocolOutput(input: Record<string, unknown>): Promise<unknown>;
          recoverInfraAttempt(input: Record<string, unknown>): Promise<unknown>;
        };
      }): {
        recoverProtocolOutput(actionId: string, incident: PostIncident): Promise<{ action: string }>;
        recoverInfra(actionId: string, incident: PostIncident): Promise<{ action: string }>;
      };
    };
    const { paths } = await fixture();
    const calls: Array<{ kind: string; input: Record<string, unknown> }> = [];
    const runtime = module.createRoutinePostLaunchRuntime({
      paths,
      port: {
        async recoverProtocolOutput(input) {
          calls.push({ kind: 'protocol', input });
          return {};
        },
        async recoverInfraAttempt(input) {
          calls.push({ kind: 'infra', input });
          return {};
        },
      },
    });
    const protocol = postIncident();
    const infra = postIncident({
      launch: 'INFRA_ERROR',
      close: null,
      outcome: 'INFRA_ERROR',
      task_status: 'INFRA_ERROR',
      task_phase: null,
      commit_owner: 'worker',
    });

    await runtime.recoverProtocolOutput('protocol-action', protocol);
    await runtime.recoverInfra('infra-action', infra);

    expect(calls.map((call) => call.kind)).toEqual(['protocol', 'infra']);
    expect(calls[0]?.input).toMatchObject({ paths, taskId: 'M56' });
    expect(calls[1]?.input).toMatchObject({ paths, taskId: 'M56' });
    expect(calls.some((call) => JSON.stringify(call).includes('maintainer'))).toBe(false);
  });

  it('usa clones e profiles separados; reviewer não edita e adoption é oficial', async () => {
    const { paths } = await fixture();
    const port = new FakeRuntimePort();
    const driver = createRoutineAutonomyRuntime({
      paths,
      loaded: {} as never,
      requestedProfileId: 'fake-worker-v1',
      maintainerProfile: 'maintainer-subscription',
      reviewerProfile: 'reviewer-subscription',
      port,
    });
    const incident = context();
    const maintained = await driver.maintain('maintain-action', incident, 0);
    const review = await driver.review('review-action', incident, maintained, 0);
    const adoption = await driver.adopt('adopt-action', incident, maintained);

    expect(review).toEqual({ decision: 'ACCEPT', reason: 'root cause corrigida' });
    expect(adoption).toEqual({ authorized_head_after: CANDIDATE, official_primitive: true });
    expect(port.agents.map((agent) => [agent.role, agent.profileId])).toEqual([
      ['maintainer', 'maintainer-subscription'],
      ['reviewer', 'reviewer-subscription'],
    ]);
    expect(port.agents[0]?.clone.clonePath).not.toBe(port.agents[1]?.clone.clonePath);
    expect(port.agents[0]?.prompt).toContain('no máximo 8 arquivos');
    expect(port.agents[1]?.prompt).toContain('NÃO edite');
    expect(port.calls).toContain(`readonly:/tmp/fake-routine-clone-2:${CANDIDATE}`);
    expect(port.calls).toContain(`adopt-official:${CANDIDATE}`);
    expect(port.calls.filter((call) => call.startsWith('observe:'))).toHaveLength(4);
    expect(port.calls.some((call) => call.includes('launchTask'))).toBe(false);
  });

  it('executa targeted tests antes dos quatro full gates', async () => {
    const { paths } = await fixture();
    const port = new FakeRuntimePort();
    const driver = createRoutineAutonomyRuntime({
      paths,
      loaded: {} as never,
      requestedProfileId: 'fake-worker-v1',
      port,
    });

    const result = await driver.maintain('maintain-gates', context(), 0);
    expect(result.targeted_results).toHaveLength(1);
    expect(result.full_gate_results.map((entry) => entry.argv.slice(0, 2))).toEqual([
      ['pnpm', 'typecheck'],
      ['pnpm', 'build'],
      ['pnpm', 'test'],
      ['git', 'diff'],
    ]);
    const gateCalls = port.calls.filter((call) => call.startsWith('gate:'));
    expect(gateCalls[0]).toContain('vitest run');
  });

  it('mede launch/attempt antes e depois do maintainer em vez de declarar zero', async () => {
    const { paths } = await fixture();
    const port = new FakeRuntimePort();
    port.activities = [
      { attempts: 1, launch_evidence: 'before' },
      { attempts: 2, launch_evidence: 'after' },
    ];
    const driver = createRoutineAutonomyRuntime({
      paths,
      loaded: {} as never,
      requestedProfileId: 'fake-worker-v1',
      port,
    });

    const result = await driver.maintain('maintain-with-task-launch', context(), 0);

    expect(result.task_provider_launches).toBe(1);
    expect(result.task_attempts_delta).toBe(1);
    expect(validateRoutineCandidate(result, BASE)).toMatchObject({ ok: false });
  });

  it('recusa reviewer que altera task activity mesmo com decisão ACCEPT', async () => {
    const { paths } = await fixture();
    const port = new FakeRuntimePort();
    port.activities = [
      { attempts: 0, launch_evidence: 'steady' },
      { attempts: 0, launch_evidence: 'steady' },
      { attempts: 0, launch_evidence: 'before-review' },
      { attempts: 1, launch_evidence: 'after-review' },
    ];
    const driver = createRoutineAutonomyRuntime({
      paths,
      loaded: {} as never,
      requestedProfileId: 'fake-worker-v1',
      port,
    });
    const maintained = await driver.maintain('maintain-safe', context(), 0);

    await expect(driver.review('review-unsafe', context(), maintained, 0)).rejects.toThrow(
      /provider de task|attempts/,
    );
  });

  it('retoma review e adoption em novo runtime usando o workspace persistido do candidate', async () => {
    const { paths } = await fixture();
    const port = new FakeRuntimePort();
    const first = createRoutineAutonomyRuntime({
      paths,
      loaded: {} as never,
      requestedProfileId: 'fake-worker-v1',
      port,
    });
    const maintained = await first.maintain('maintain-before-restart', context(), 0);
    const restarted = createRoutineAutonomyRuntime({
      paths,
      loaded: {} as never,
      requestedProfileId: 'fake-worker-v1',
      port,
    });

    const review = await restarted.review('review-after-restart', context(), maintained, 0);
    const adoption = await restarted.adopt('adopt-after-restart', context(), maintained);

    expect(review.decision).toBe('ACCEPT');
    expect(adoption.authorized_head_after).toBe(CANDIDATE);
    expect(maintained.workspace?.clone_path).toBe('/tmp/fake-routine-clone-1');
  });

  it('parser aceita wrappers Claude/Codex e recusa decisão ambígua', () => {
    expect(parseRoutineReview(JSON.stringify({ result: '{"decision":"ACCEPT","reason":"ok"}' }))).toEqual({
      decision: 'ACCEPT',
      reason: 'ok',
    });
    expect(
      parseRoutineReview(
        `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"decision":"REJECT","reason":"gap"}' } })}\n`,
      ),
    ).toEqual({ decision: 'REJECT', reason: 'gap' });
    expect(() => parseRoutineReview('ACCEPT ou REJECT, depende')).toThrow(/reviewer/i);
  });

  it('produção converte o reviewer aprovado para sandbox read-only e recusa troca de role/profile', async () => {
    const reviewer = await loadProfile(process.cwd(), 'codex-build-worker-subscription-terra-high-v2');
    const argv = buildRoutineAgentArgv(reviewer, {
      role: 'reviewer',
      prompt: 'review',
      readOnly: true,
    });
    const sandboxIndex = argv.indexOf('--sandbox');

    expect(argv[sandboxIndex + 1]).toBe('read-only');
    expect(argv).not.toContain('workspace-write');
    expect(() => buildRoutineAgentArgv(reviewer, {
      role: 'maintainer',
      prompt: 'maintain',
      readOnly: false,
    })).toThrow(/profile subscription-only aprovado/);
  });
});

describe('dev-orchestrate --autonomy routine', () => {
  it('intercepta protocol-invalid pós-launch, usa recovery oficial e repete a mesma task', async () => {
    const { sandbox, paths, loaded } = await initializedSandbox();
    const profileId = await installFakeOrchestratorProfile(sandbox, paths, loaded);
    const result = await runDevCli(
      'dev-orchestrate.ts',
      [
        '--repo',
        sandbox.root,
        '--profile',
        profileId,
        '--max-iterations',
        '1',
        '--autonomy',
        'routine',
      ],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'protocol-invalid-then-success' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      iteration_count: number;
      iterations: Array<{ task_id: string; result: string }>;
    };
    expect(output.stopped_by, JSON.stringify(output)).toBe('LIMIT_REACHED');
    expect(output.iteration_count).toBe(2);
    expect(output.iterations.map((iteration) => iteration.task_id)).toEqual(['T1', 'T1']);
    expect((await readState(paths)).tasks[0]).toMatchObject({ status: 'PASS', attempts: 2 });
    expect(await readProtocolInvalidAttempt(paths, 'T1', 1)).not.toBeNull();
  }, 60_000);

  it('primitive protocol que recusa escala sem maintainer nem retry', async () => {
    const { sandbox, paths, loaded } = await initializedSandbox();
    const profileId = await installFakeOrchestratorProfile(sandbox, paths, loaded);
    const result = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', profileId, '--max-iterations', '1', '--autonomy', 'routine'],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'no-commit' },
    );

    expect(result.exitCode).toBe(9);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output['stopped_by']).toBe('HUMAN_REQUIRED');
    expect(output['iteration_count']).toBe(1);
    expect(output['why_automation_stopped']).toMatch(/protocol-output-recovery|patch normalizado|recus/i);
    expect((await readState(paths)).tasks[0]).toMatchObject({ status: 'RUNNING', attempts: 1 });
    expect(await readProtocolInvalidAttempt(paths, 'T1', 1)).toBeNull();
  }, 60_000);

  it('INFRA_ERROR de launcher sem prova de provider é recusado sem retry genérico', async () => {
    const { sandbox, paths } = await initializedSandbox();
    const result = await runDevCli(
      'dev-orchestrate.ts',
      [
        '--repo',
        sandbox.root,
        '--profile',
        'fake-worker-v1',
        '--max-iterations',
        '1',
        '--autonomy',
        'routine',
      ],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'infra-error' },
    );

    expect(result.exitCode, result.stderr).toBe(9);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output['stopped_by']).toBe('HUMAN_REQUIRED');
    expect(output['iteration_count']).toBe(1);
    expect(output['why_automation_stopped']).toMatch(/LaunchRecord|provider|stream-json/);
    expect((await readState(paths)).tasks[0]).toMatchObject({ attempts: 1 });
    expect(await readInfraFailedAttempt(paths, 'T1', 1)).toBeNull();
  }, 60_000);

  it('FAIL oficial com autonomy continua na automatic-repair policy existente', async () => {
    const { sandbox, paths, loaded } = await initializedSandbox(REPAIR_PLAN);
    const profileId = await installFakeOrchestratorProfile(sandbox, paths, loaded);
    const result = await runDevCli(
      'dev-orchestrate.ts',
      [
        '--repo',
        sandbox.root,
        '--profile',
        profileId,
        '--max-iterations',
        '1',
        '--autonomy',
        'routine',
        '--verbose',
      ],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'official-fail-then-repair' },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      iterations: Array<{ automatic_repair?: boolean }>;
    };
    expect(output.stopped_by, JSON.stringify(output)).toBe('LIMIT_REACHED');
    expect(output.iterations).toHaveLength(2);
    expect(output.iterations[1]?.automatic_repair).toBe(true);
    expect((await readState(paths)).tasks[0]?.status).toBe('PASS');
  }, 60_000);

  it('sem --autonomy routine o PENDING pós-launch mantém o comportamento legado', async () => {
    const { sandbox, paths, loaded } = await initializedSandbox();
    const profileId = await installFakeOrchestratorProfile(sandbox, paths, loaded);
    const result = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', profileId, '--max-iterations', '1'],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'protocol-invalid-then-success' },
    );

    expect(result.exitCode).toBe(9);
    expect(JSON.parse(result.stdout)).toMatchObject({ stopped_by: 'PENDING', iteration_count: 1 });
    expect((await readState(paths)).tasks[0]).toMatchObject({ status: 'RUNNING', attempts: 1 });
    expect(await readProtocolInvalidAttempt(paths, 'T1', 1)).toBeNull();
  }, 60_000);

  it('blocker fora da allowlist emite HUMAN_REQUIRED estruturado sem lançar provider', async () => {
    const sandbox = await makeSandboxRepo();
    roots.push(sandbox.root);
    const paths = resolveHarnessPaths(sandbox.root);
    const loaded = await loadPlan(paths.planFile);
    const base = await headSha(sandbox.root);
    await ensureRuntimeDirs(paths);
    await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: base }));
    await writeFile(path.join(sandbox.root, 'dirty.txt'), 'fora da maintenance autorizada\n', 'utf8');

    const result = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', 'fake-worker-v1', '--max-iterations', '1', '--autonomy', 'routine'],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'success' },
    );

    expect(result.exitCode).toBe(9);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(output['status']).toBe('HUMAN_REQUIRED');
    expect(output).toMatchObject({
      incident_id: expect.any(String),
      decision_needed: expect.any(String),
      why_automation_stopped: expect.any(String),
      options: expect.any(Array),
      evidence_paths: expect.any(Array),
      iteration_count: 0,
    });
    expect(await exists(path.join(paths.logsDir, 'T1.launch.json'))).toBe(false);
  });

  it('recusa valor desconhecido de --autonomy antes do preflight', async () => {
    const sandbox = await makeSandboxRepo();
    roots.push(sandbox.root);
    const result = await runDevCli('dev-orchestrate.ts', [
      '--repo',
      sandbox.root,
      '--profile',
      'fake-worker-v1',
      '--autonomy',
      'unbounded',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/--autonomy aceita somente routine/);
  });
});
