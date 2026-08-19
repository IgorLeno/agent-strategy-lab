import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { readLaunchRecord, readValidationFailedAttempt } from '../../dev/lib/records.js';
import { readState } from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, REPO_ROOT, runDevCli, type Sandbox } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function trackSandbox(plan?: string): Promise<Sandbox> {
  const sandbox = await makeSandboxRepo(plan);
  created.push(sandbox.root);
  return sandbox;
}

async function writeExternalPlan(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'agentlab-plan-'));
  created.push(dir);
  const file = path.join(dir, 'agentlab-plan.yaml');
  await writeFile(file, contents, 'utf8');
  return file;
}

function taskPlan(ids: readonly string[], extra: { repair?: boolean } = {}): string {
  const tasks = ids.map((id, index) => {
    const previous = index === 0 ? [] : [ids[index - 1]!];
    const validation = extra.repair
      ? `      - argv: ['grep', '-qx', 'repaired', 'src/${id.toLowerCase()}.txt']\n        timeout_seconds: 30`
      : `      - argv: ['true']\n        timeout_seconds: 30`;
    return [
      `  - id: ${id}`,
      `    title: tarefa ${id}`,
      ...(previous.length > 0 ? [`    blocked_by: [${previous.join(', ')}]`] : []),
      `    objective: criar src/${id.toLowerCase()}.txt`,
      ...(index === 0 ? ['    initial_files: [README.md]'] : []),
      `    acceptance: ['arquivo criado']`,
      `    validation:`,
      validation,
    ].join('\n');
  });
  return `schema_version: 1\ntasks:\n${tasks.join('\n')}\n`;
}

const ORCHESTRATOR_PROFILE = [
  'id: fake-orchestrator-v2',
  'agent: fake',
  'commit_owner: orchestrator',
  'official_validation_owner: orchestrator',
  'worker_validation_policy: targeted',
  'argv: [node, fixtures/fake-worker.mjs]',
  'prompt_delivery: argv',
  'timeout_seconds: 60',
  'forbidden_flags: []',
  'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE]',
].join('\n');

async function installOrchestratorProfile(sandbox: Sandbox): Promise<void> {
  await mkdir(path.join(sandbox.root, 'dev', 'profiles'), { recursive: true });
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', 'fake-orchestrator-v2.yaml'),
    ORCHESTRATOR_PROFILE,
    'utf8',
  );
}

function runPlan(
  sandbox: Sandbox,
  extra: readonly string[],
  env: Record<string, string> = {},
) {
  return runDevCli('dev-run-plan.ts', ['--repo', sandbox.root, ...extra], {
    AGENTLAB_FAKE_MODE: 'success',
    ...env,
  });
}

function parseOutput(result: { stdout: string; stderr: string; exitCode: number | null }) {
  expect(result.stdout, result.stderr).toMatch(/\{/);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function fileExists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

describe('dev-run-plan', () => {
  it('A — plan externo fora de <repo>/dev/plan.yaml, original intacto', async () => {
    const sandbox = await trackSandbox();
    const bundled = await readFile(path.join(sandbox.root, 'dev', 'plan.yaml'), 'utf8');
    const external = await writeExternalPlan(taskPlan(['T1']));
    const before = await readFile(external);

    const result = await runPlan(sandbox, ['--plan', external, '--profile', 'fake-worker-v1']);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parseOutput(result);
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.plan_file).toBe(path.resolve(external));
    expect(output.runtime_state).toBe('NEW');
    expect(output.initialized).toBe(true);

    expect(await readFile(external)).toEqual(before);
    expect(await readFile(path.join(sandbox.root, 'dev', 'plan.yaml'), 'utf8')).toBe(bundled);

    const paths = resolveHarnessPaths(sandbox.root, { planFile: external });
    const state = await readState(paths);
    expect(state.tasks.map((task) => task.id)).toEqual(['T1']);
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS']);
    expect(state.plan_sha256).toBe((await loadPlan(external)).planSha256);
  }, 60_000);

  it('B — uma task chega a ALL_DONE com um único comando', async () => {
    const sandbox = await trackSandbox(taskPlan(['T1']));
    const result = await runPlan(sandbox, [
      '--plan',
      path.join(sandbox.root, 'dev', 'plan.yaml'),
      '--profile',
      'fake-worker-v1',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parseOutput(result);
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.iteration_count).toBe(1);
    expect((output.iterations as { task_id: string }[])[0]?.task_id).toBe('T1');
    const state = await readState(resolveHarnessPaths(sandbox.root));
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS']);
  }, 60_000);

  it('C — DAG T1 -> T2 -> T3 em um único comando', async () => {
    const sandbox = await trackSandbox(taskPlan(['T1', 'T2', 'T3']));
    const result = await runPlan(sandbox, [
      '--plan',
      path.join(sandbox.root, 'dev', 'plan.yaml'),
      '--profile',
      'fake-worker-v1',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parseOutput(result);
    expect(output.stopped_by).toBe('ALL_DONE');
    expect((output.iterations as { task_id: string }[]).map((item) => item.task_id)).toEqual([
      'T1',
      'T2',
      'T3',
    ]);
    const state = await readState(resolveHarnessPaths(sandbox.root));
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS', 'PASS', 'PASS']);
  }, 90_000);

  it('D — repair bounded é o existente, não lógica nova do wrapper', async () => {
    const wrapper = await readFile(path.join(REPO_ROOT, 'dev/lib/run-plan.ts'), 'utf8');
    expect(wrapper).toMatch(/runOrchestrate/);
    expect(wrapper).toMatch(/initializeHarnessRuntime/);
    expect(wrapper).not.toMatch(/automatic-repair/);
    expect(wrapper).not.toMatch(/decideAutomaticRepair/);
    expect(wrapper).not.toMatch(/launchTask/);
    expect(wrapper).not.toMatch(/prepareNextTask/);

    const sandbox = await trackSandbox(taskPlan(['T1'], { repair: true }));
    await installOrchestratorProfile(sandbox);
    await commitAll(sandbox.root, 'perfil orchestrator-owned');
    const result = await runPlan(
      sandbox,
      ['--plan', path.join(sandbox.root, 'dev', 'plan.yaml'), '--profile', 'fake-orchestrator-v2'],
      { AGENTLAB_FAKE_MODE: 'official-fail-then-repair' },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parseOutput(result);
    const iterations = output.iterations as {
      task_id: string;
      attempt_kind: string;
      result: string;
    }[];
    expect(iterations.map((item) => item.task_id)).toEqual(['T1', 'T1']);
    expect(iterations.map((item) => item.attempt_kind)).toEqual(['FIRST_PASS', 'REPAIR']);
    expect(iterations.map((item) => item.result)).toEqual(['FAIL', 'PASS']);

    const paths = resolveHarnessPaths(sandbox.root);
    expect(await readValidationFailedAttempt(paths, 'T1', 1)).not.toBeNull();
    expect((await readState(paths)).tasks[0]?.status).toBe('PASS');
  }, 60_000);

  it('E — resume preserva T1 e seleciona T2 sem reinicializar', async () => {
    const sandbox = await trackSandbox(taskPlan(['T1', 'T2']));
    const plan = path.join(sandbox.root, 'dev', 'plan.yaml');
    const first = await runPlan(sandbox, [
      '--plan',
      plan,
      '--profile',
      'fake-worker-v1',
      '--max-iterations',
      '1',
    ]);
    expect(first.exitCode, first.stderr).toBe(0);
    const firstOut = parseOutput(first);
    expect(firstOut.stopped_by).toBe('LIMIT_REACHED');
    expect(firstOut.initialized).toBe(true);
    const paths = resolveHarnessPaths(sandbox.root);
    const afterFirst = await readState(paths);
    expect(afterFirst.tasks.map((task) => task.status)).toEqual(['PASS', 'READY']);
    const t1Commit = afterFirst.tasks[0]?.accepted_commit;
    expect(t1Commit).toEqual(expect.any(String));

    const second = await runPlan(sandbox, ['--plan', plan, '--profile', 'fake-worker-v1']);
    expect(second.exitCode, second.stderr).toBe(0);
    const secondOut = parseOutput(second);
    expect(secondOut.runtime_state).toBe('RESUMABLE');
    expect(secondOut.initialized).toBe(false);
    expect(secondOut.run_kind).toBe('RESUMED');
    expect((secondOut.iterations as { task_id: string }[]).map((item) => item.task_id)).toEqual(['T2']);
    const afterSecond = await readState(paths);
    expect(afterSecond.tasks.map((task) => task.status)).toEqual(['PASS', 'PASS']);
    expect(afterSecond.tasks[0]?.accepted_commit).toBe(t1Commit);
    expect(afterSecond.created_at).toBe(afterFirst.created_at);
  }, 90_000);

  it('F — ALL_DONE é idempotente e não lança worker novo', async () => {
    const sandbox = await trackSandbox(taskPlan(['T1']));
    const plan = path.join(sandbox.root, 'dev', 'plan.yaml');
    const first = await runPlan(sandbox, ['--plan', plan, '--profile', 'fake-worker-v1']);
    expect(first.exitCode, first.stderr).toBe(0);
    const paths = resolveHarnessPaths(sandbox.root);
    const launch = await readLaunchRecord(paths, 'T1');
    expect(launch).not.toBeNull();

    const second = await runPlan(sandbox, ['--plan', plan, '--profile', 'fake-worker-v1']);
    expect(second.exitCode, second.stderr).toBe(0);
    const output = parseOutput(second);
    expect(output.stopped_by).toBe('ALL_DONE');
    expect(output.runtime_state).toBe('ALL_DONE');
    expect(output.iteration_count).toBe(0);
    expect(output.provider_called).toBe(false);
    expect(output.initialized).toBe(false);
    expect(await readLaunchRecord(paths, 'T1')).toEqual(launch);
  }, 60_000);

  it('G — plan inválido falha antes de state/attempt/provider', async () => {
    const sandbox = await trackSandbox();
    const invalid = await writeExternalPlan('isto não é um PlanFile\n');
    const result = await runPlan(sandbox, ['--plan', invalid, '--profile', 'fake-worker-v1']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/PlanFile inválido/);
    expect(result.stderr).toMatch(/Nenhum state autoritativo foi criado/);
    expect(await fileExists(path.join(sandbox.root, '.dev', 'state.json'))).toBe(false);
    expect(await fileExists(path.join(sandbox.root, '.dev', 'logs'))).toBe(false);
  });

  it('H — runtime de outro plan falha fechado sem reset nem provider', async () => {
    const sandbox = await trackSandbox();
    const planA = await writeExternalPlan(taskPlan(['T1']));
    const planB = await writeExternalPlan(taskPlan(['Z1']));
    const first = await runPlan(sandbox, ['--plan', planA, '--profile', 'fake-worker-v1']);
    expect(first.exitCode, first.stderr).toBe(0);
    const paths = resolveHarnessPaths(sandbox.root, { planFile: planA });
    const before = await readFile(paths.stateFile, 'utf8');
    const launch = await readLaunchRecord(paths, 'T1');
    expect(launch).not.toBeNull();

    const second = await runPlan(sandbox, ['--plan', planB, '--profile', 'fake-worker-v1']);
    expect(second.exitCode).toBe(9);
    const output = parseOutput(second);
    expect(output.status).toBe('RUNTIME_PLAN_MISMATCH');
    expect(output.provider_called).toBe(false);
    expect(output.runtime_state).toBe('INCOMPATIBLE');
    expect(output.preserved).toEqual(['runtime', 'state', 'history', 'evidence']);
    expect(await readFile(paths.stateFile, 'utf8')).toBe(before);
    expect(await readLaunchRecord(paths, 'T1')).toEqual(launch);
    expect(await fileExists(path.join(paths.completionsDir, 'Z1.completion.json'))).toBe(false);
  }, 60_000);

  it('I — dry-run de runtime novo é READY sem mutação autoritativa', async () => {
    const sandbox = await trackSandbox(taskPlan(['T1']));
    const result = await runPlan(sandbox, [
      '--plan',
      path.join(sandbox.root, 'dev', 'plan.yaml'),
      '--profile',
      'fake-worker-v1',
      '--dry-run',
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const output = parseOutput(result);
    expect(output.status).toBe('READY');
    expect(output.dry_run).toBe(true);
    expect(output.provider_called).toBe(false);
    expect(output.runtime_state).toBe('NEW');
    expect(output.next_task).toBe('T1');
    expect(output.authoritative_mutation).toBe(false);
    expect(await fileExists(path.join(sandbox.root, '.dev', 'state.json'))).toBe(false);
    expect(await fileExists(path.join(sandbox.root, '.dev'))).toBe(false);
  });

  it('J — dry-run de runtime existente é RESUMABLE ou ALL_DONE', async () => {
    const sandbox = await trackSandbox(taskPlan(['T1', 'T2']));
    const plan = path.join(sandbox.root, 'dev', 'plan.yaml');
    const first = await runPlan(sandbox, [
      '--plan',
      plan,
      '--profile',
      'fake-worker-v1',
      '--max-iterations',
      '1',
    ]);
    expect(first.exitCode, first.stderr).toBe(0);

    const resumable = await runPlan(sandbox, [
      '--plan',
      plan,
      '--profile',
      'fake-worker-v1',
      '--dry-run',
    ]);
    expect(resumable.exitCode, resumable.stderr).toBe(0);
    const resumableOut = parseOutput(resumable);
    expect(resumableOut.status).toBe('READY');
    expect(resumableOut.runtime_state).toBe('RESUMABLE');
    expect(resumableOut.next_task).toBe('T2');
    expect(resumableOut.provider_called).toBe(false);

    const finish = await runPlan(sandbox, ['--plan', plan, '--profile', 'fake-worker-v1']);
    expect(finish.exitCode, finish.stderr).toBe(0);

    const done = await runPlan(sandbox, [
      '--plan',
      plan,
      '--profile',
      'fake-worker-v1',
      '--dry-run',
    ]);
    expect(done.exitCode, done.stderr).toBe(0);
    const doneOut = parseOutput(done);
    expect(doneOut.status).toBe('ALL_DONE');
    expect(doneOut.runtime_state).toBe('ALL_DONE');
    expect(doneOut.next_task).toBeNull();
    expect(doneOut.provider_called).toBe(false);
  }, 90_000);

  it('L — profile inexistente falha antes de provider spawn', async () => {
    const sandbox = await trackSandbox(taskPlan(['T1']));
    const result = await runPlan(sandbox, [
      '--plan',
      path.join(sandbox.root, 'dev', 'plan.yaml'),
      '--profile',
      'perfil-que-nao-existe',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/perfil-que-nao-existe/);
    expect(result.stderr).toMatch(/antes de qualquer provider spawn/);
    expect(await fileExists(path.join(sandbox.root, '.dev', 'state.json'))).toBe(false);
  });
});
