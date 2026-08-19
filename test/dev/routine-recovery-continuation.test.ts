import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headSha, workingTreeFiles } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import {
  infraAttemptEvidencePath,
  preservedBundlePatchPath,
  readAttemptAbandonment,
  readCompletion,
  readInfraFailedAttempt,
  readLaunchRecord,
  readValidationFailedAttempt,
} from '../../dev/lib/records.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

const PROFILE = 'fake-orchestrator-incomplete-output-v1';
const REPAIR_PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: primeira tarefa
    objective: criar src/t1.txt
    initial_files: [README.md]
    acceptance: ['arquivo reparado']
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

interface Fixture {
  readonly sandbox: Sandbox;
  readonly paths: HarnessPaths;
  readonly baseline: string;
}

interface OrchestrationOutput {
  readonly stopped_by: string;
  readonly iteration_count: number;
  readonly why_automation_stopped?: string;
  readonly iterations: readonly {
    readonly task_id: string;
    readonly attempt: number;
    readonly attempt_kind: string;
    readonly result: string;
    readonly automatic_repair?: boolean;
    readonly repair_source_attempt?: number;
  }[];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function setup(plan?: string): Promise<Fixture> {
  const sandbox = plan === undefined ? await makeSandboxRepo() : await makeSandboxRepo(plan);
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${PROFILE}.yaml`),
    [
      `id: ${PROFILE}`,
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
  const baseline = await commitAll(sandbox.root, 'fake incomplete-output profile');
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }),
  );
  return { sandbox, paths, baseline };
}

function orchestrate(
  fixture: Fixture,
  mode: string,
  maxIterations: number,
  verbose = false,
) {
  return runDevCli(
    'dev-orchestrate.ts',
    [
      '--repo',
      fixture.sandbox.root,
      '--profile',
      PROFILE,
      '--max-iterations',
      String(maxIterations),
      '--autonomy',
      'routine',
      ...(verbose ? ['--verbose'] : []),
    ],
    {
      AGENTLAB_DEV_DIR: fixture.sandbox.devDir,
      AGENTLAB_FAKE_MODE: mode,
    },
  );
}

async function readPostLaunchRecords(paths: HarnessPaths): Promise<
  readonly {
    readonly attempt: number;
    readonly outcome: string;
    readonly recipe_id: string | null;
    readonly retry_result: string | null;
    readonly human_required: boolean;
  }[]
> {
  const root = path.join(paths.devDir, 'autonomy', 'incidents');
  const entries = await readdir(root, { withFileTypes: true });
  const records = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map(async (entry) => JSON.parse(await readFile(path.join(root, entry.name), 'utf8')) as {
        readonly phase?: string;
        readonly attempt: number;
        readonly outcome: string;
        readonly recipe_id: string | null;
        readonly retry_result: string | null;
        readonly human_required: boolean;
      }),
  );
  return records
    .filter((record) => record.phase === 'POST_LAUNCH')
    .sort((left, right) => left.attempt - right.attempt);
}

async function expectCapabilityNeutralEvidence(paths: HarnessPaths, attempt: number): Promise<void> {
  const abandonment = await readAttemptAbandonment(paths, 'T1', attempt);
  expect(abandonment).toMatchObject({
    task_id: 'T1',
    attempt,
    report_present: false,
    handoff_present: false,
  });
  expect(await readValidationFailedAttempt(paths, 'T1', attempt)).toBeNull();
  expect(await readInfraFailedAttempt(paths, 'T1', attempt)).toBeNull();
  expect(await exists(preservedBundlePatchPath(paths, 'T1', attempt))).toBe(true);
  expect(await readFile(preservedBundlePatchPath(paths, 'T1', attempt), 'utf8')).toContain(
    'src/t1.txt',
  );
  for (const evidence of ['launch.infra.json', 'stdout.log', 'stderr.log'] as const) {
    expect(await exists(infraAttemptEvidencePath(paths, 'T1', attempt, evidence))).toBe(true);
  }
}

describe('dev-orchestrate — continuação após RECOVERED capability-neutral', () => {
  it('preserva incomplete output e repete a mesma task/profile até PASS', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'incomplete-output-then-success', 1);

    expect(result.exitCode, result.stderr).toBe(9);
    const output = JSON.parse(result.stdout) as OrchestrationOutput;
    expect(output.stopped_by, JSON.stringify(output)).toBe('LIMIT_REACHED');
    expect(output.iteration_count).toBe(2);
    expect(output.iterations).toMatchObject([
      { task_id: 'T1', attempt: 1, attempt_kind: 'FIRST_PASS', result: 'PENDING' },
      { task_id: 'T1', attempt: 2, attempt_kind: 'FIRST_PASS', result: 'PASS' },
    ]);
    expect(result.stderr).not.toMatch(/resolver pós-launch declarou RETRIED/);

    await expectCapabilityNeutralEvidence(fixture.paths, 1);
    const records = await readPostLaunchRecords(fixture.paths);
    expect(records).toEqual([
      expect.objectContaining({
        attempt: 1,
        outcome: 'PENDING',
        recipe_id: 'protocol-output-recovery',
        retry_result: null,
        human_required: false,
      }),
    ]);

    const state = await readState(fixture.paths);
    expect(state.tasks).toMatchObject([
      { id: 'T1', status: 'PASS', attempts: 2 },
      { id: 'T2', status: 'READY', attempts: 0 },
    ]);
    expect(await readLaunchRecord(fixture.paths, 'T1')).toMatchObject({ profile_id: PROFILE });
    expect(await readCompletion(fixture.paths, 'T1')).toMatchObject({
      status: 'PASS',
      report_matches_evidence: true,
    });
    expect(state.authorized_head_sha).toBe(await headSha(fixture.sandbox.root));
    expect(state.authorized_head_sha).not.toBe(fixture.baseline);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
  }, 60_000);

  it('--max-iterations 2 permite T2 somente depois do retry operacional de T1', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'incomplete-output-then-success', 2);

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as OrchestrationOutput;
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.iterations.map((iteration) => iteration.task_id)).toEqual(['T1', 'T1', 'T2']);
    expect(output.iterations.map((iteration) => iteration.attempt)).toEqual([1, 2, 1]);
    expect((await readState(fixture.paths)).tasks).toMatchObject([
      { id: 'T1', status: 'PASS', attempts: 2 },
      { id: 'T2', status: 'PASS', attempts: 1 },
    ]);
  }, 60_000);

  it('retry operacional durante REPAIR preserva a lineage sem nova capability escalation', async () => {
    const fixture = await setup(REPAIR_PLAN);
    const result = await orchestrate(fixture, 'repair-incomplete-then-success', 1, true);

    expect(result.exitCode, result.stderr).toBe(9);
    const output = JSON.parse(result.stdout) as OrchestrationOutput;
    expect(output.stopped_by, JSON.stringify(output)).toBe('LIMIT_REACHED');
    expect(output.iterations).toMatchObject([
      {
        task_id: 'T1',
        attempt: 1,
        attempt_kind: 'FIRST_PASS',
        result: 'FAIL',
      },
      {
        task_id: 'T1',
        attempt: 2,
        attempt_kind: 'REPAIR',
        result: 'PENDING',
        automatic_repair: true,
        repair_source_attempt: 1,
      },
      {
        task_id: 'T1',
        attempt: 3,
        attempt_kind: 'REPAIR',
        result: 'PASS',
        automatic_repair: true,
        repair_source_attempt: 1,
      },
    ]);
    expect(await readValidationFailedAttempt(fixture.paths, 'T1', 1)).not.toBeNull();
    await expectCapabilityNeutralEvidence(fixture.paths, 2);
    expect(await readValidationFailedAttempt(fixture.paths, 'T1', 2)).toBeNull();
    expect((await readState(fixture.paths)).tasks).toMatchObject([
      { id: 'T1', status: 'PASS', attempts: 3 },
      { id: 'T2', status: 'READY', attempts: 0 },
    ]);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
  }, 60_000);

  it('incidente repetido esgota o budget operacional sem terceiro launch ou capability FAIL', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'incomplete-output-always', 2);

    expect(result.exitCode, result.stderr).toBe(9);
    const output = JSON.parse(result.stdout) as OrchestrationOutput;
    expect(output.stopped_by).toBe('HUMAN_REQUIRED');
    expect(output.why_automation_stopped).toMatch(/budget operacional.*esgotado/i);
    expect(output.iteration_count).toBe(2);
    expect(output.iterations.map((iteration) => iteration.task_id)).toEqual(['T1', 'T1']);
    expect(output.iterations.map((iteration) => iteration.attempt)).toEqual([1, 2]);
    expect(output.iterations.every((iteration) => iteration.result === 'PENDING')).toBe(true);

    await expectCapabilityNeutralEvidence(fixture.paths, 1);
    await expectCapabilityNeutralEvidence(fixture.paths, 2);
    expect(await readCompletion(fixture.paths, 'T1')).toBeNull();
    expect(await readPostLaunchRecords(fixture.paths)).toEqual([
      expect.objectContaining({
        attempt: 1,
        recipe_id: 'protocol-output-recovery',
        human_required: false,
      }),
      expect.objectContaining({
        attempt: 2,
        recipe_id: 'protocol-output-recovery',
        human_required: true,
      }),
    ]);

    const state = await readState(fixture.paths);
    expect(state.tasks).toMatchObject([
      { id: 'T1', status: 'READY', attempts: 2 },
      { id: 'T2', status: 'READY', attempts: 0 },
    ]);
    expect(state.authorized_head_sha).toBe(fixture.baseline);
    expect(await headSha(fixture.sandbox.root)).toBe(fixture.baseline);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
  }, 60_000);
});
