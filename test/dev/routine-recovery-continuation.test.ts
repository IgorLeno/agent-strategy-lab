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
  // Sem incidente nenhum o diretório pode nem existir — que é exatamente o
  // desfecho esperado quando a nota ausente deixa de ser incidente.
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
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
  /**
   * Onda 1: o worker fez o trabalho e saiu 0, apenas sem escrever a nota. Isso
   * deixou de custar um relaunch — o candidate é derivado do Git, validado
   * oficialmente e aceito no PRIMEIRO attempt. Nenhum incidente pós-launch é
   * aberto, porque não houve incidente.
   */
  it('nota ausente do worker não custa relaunch: PASS no primeiro attempt', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'incomplete-output-then-success', 1);

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as OrchestrationOutput;
    expect(output.iteration_count).toBe(1);
    expect(output.iterations).toMatchObject([
      { task_id: 'T1', attempt: 1, attempt_kind: 'FIRST_PASS', result: 'PASS' },
    ]);
    expect(await readPostLaunchRecords(fixture.paths)).toEqual([]);

    const state = await readState(fixture.paths);
    expect(state.tasks).toMatchObject([
      { id: 'T1', status: 'PASS', attempts: 1 },
      { id: 'T2', status: 'READY', attempts: 0 },
    ]);
    expect(await readLaunchRecord(fixture.paths, 'T1')).toMatchObject({ profile_id: PROFILE });
    // A nota ausente sobrevive como DISCREPÂNCIA, não como bloqueio.
    expect(await readCompletion(fixture.paths, 'T1')).toMatchObject({
      status: 'PASS',
      report_matches_evidence: false,
    });
    expect(state.authorized_head_sha).toBe(await headSha(fixture.sandbox.root));
    expect(state.authorized_head_sha).not.toBe(fixture.baseline);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
  }, 60_000);

  it('sem o relaunch desperdiçado, T1 e T2 concluem dentro de --max-iterations 2', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'incomplete-output-then-success', 2);

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as OrchestrationOutput;
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.iterations.map((iteration) => iteration.task_id)).toEqual(['T1', 'T2']);
    expect(output.iterations.map((iteration) => iteration.attempt)).toEqual([1, 1]);
    expect((await readState(fixture.paths)).tasks).toMatchObject([
      { id: 'T1', status: 'PASS', attempts: 1 },
      { id: 'T2', status: 'PASS', attempts: 1 },
    ]);
  }, 60_000);

  it('retry operacional durante REPAIR preserva a lineage sem nova capability escalation', async () => {
    const fixture = await setup(REPAIR_PLAN);
    const result = await orchestrate(fixture, 'repair-incomplete-then-success', 1, true);

    expect(result.exitCode, result.stderr).toBe(0);
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
        result: 'PASS',
        automatic_repair: true,
        repair_source_attempt: 1,
      },
    ]);
    // A lineage do repair continua intacta: o FAIL oficial do attempt 1 é a
    // autorização, e o repair conclui sem consumir um attempt extra só porque
    // o worker não escreveu a nota.
    expect(await readValidationFailedAttempt(fixture.paths, 'T1', 1)).not.toBeNull();
    expect(await readValidationFailedAttempt(fixture.paths, 'T1', 2)).toBeNull();
    expect((await readState(fixture.paths)).tasks).toMatchObject([
      { id: 'T1', status: 'PASS', attempts: 2 },
      { id: 'T2', status: 'READY', attempts: 0 },
    ]);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
  }, 60_000);

  /**
   * A regressão que a Onda 1 fecha, na forma mais crua: um worker que NUNCA
   * escreve a nota entregava trabalho válido a cada launch, queimava o budget
   * operacional inteiro e terminava em HUMAN_REQUIRED — sem que houvesse
   * decisão humana nenhuma a tomar. Agora o trabalho é aceito no primeiro
   * attempt e o plano inteiro conclui.
   */
  it('worker que nunca escreve a nota conclui o plano sem gate humano', async () => {
    const fixture = await setup();
    const result = await orchestrate(fixture, 'incomplete-output-always', 2);

    expect(result.exitCode, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as OrchestrationOutput;
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.why_automation_stopped ?? null).toBeNull();
    expect(output.iterations.map((iteration) => iteration.task_id)).toEqual(['T1', 'T2']);
    expect(output.iterations.every((iteration) => iteration.result === 'PASS')).toBe(true);
    expect(await readPostLaunchRecords(fixture.paths)).toEqual([]);

    expect(await readCompletion(fixture.paths, 'T1')).toMatchObject({
      status: 'PASS',
      report_matches_evidence: false,
    });

    const state = await readState(fixture.paths);
    expect(state.tasks).toMatchObject([
      { id: 'T1', status: 'PASS', attempts: 1 },
      { id: 'T2', status: 'PASS', attempts: 1 },
    ]);
    expect(state.authorized_head_sha).toBe(await headSha(fixture.sandbox.root));
    expect(state.authorized_head_sha).not.toBe(fixture.baseline);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
  }, 60_000);
});
