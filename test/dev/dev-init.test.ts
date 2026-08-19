import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevelopmentState } from '../../dev/lib/schemas.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { makeSandboxRepo, makeTempDevDir, REPO_ROOT, runDevCli } from './helpers.js';

const created: string[] = [];

async function freshDevDir(): Promise<string> {
  const dir = await makeTempDevDir();
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('dev-init', () => {
  it('cria o runtime a partir de dev/plan.yaml', async () => {
    const devDir = await freshDevDir();
    const result = await runDevCli('dev-init.ts', [], { AGENTLAB_DEV_DIR: devDir });

    expect(result.exitCode, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { task_count: number; plan_sha256: string };
    expect(summary.task_count).toBeGreaterThan(30);

    const state = DevelopmentState.parse(
      JSON.parse(await readFile(path.join(devDir, 'state.json'), 'utf8')),
    );
    expect(state.plan_sha256).toBe(summary.plan_sha256);
    expect(state.authorized_head_sha).toBe(await headSha(REPO_ROOT));
    expect(state.tasks.every((task) => task.status === 'READY')).toBe(true);
    expect(state.tasks.every((task) => task.accepted_commit === null)).toBe(true);
  });

  it('não sobrescreve state existente sem --force', async () => {
    const devDir = await freshDevDir();
    await runDevCli('dev-init.ts', [], { AGENTLAB_DEV_DIR: devDir });
    const statePath = path.join(devDir, 'state.json');
    const before = await readFile(statePath, 'utf8');
    const marked = JSON.parse(before) as { tasks: { status: string }[] };
    marked.tasks[0]!.status = 'RUNNING';
    await writeFile(statePath, JSON.stringify(marked));

    const second = await runDevCli('dev-init.ts', [], { AGENTLAB_DEV_DIR: devDir });
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/dev-recover/);
    expect(JSON.parse(await readFile(statePath, 'utf8')).tasks[0].status).toBe('RUNNING');

    const forced = await runDevCli('dev-init.ts', ['--force'], { AGENTLAB_DEV_DIR: devDir });
    expect(forced.exitCode, forced.stderr).toBe(0);
    expect(JSON.parse(await readFile(statePath, 'utf8')).tasks[0].status).toBe('READY');
  });

  it('override aditivo --plan-file/--runtime-dir não altera o default histórico', async () => {
    const extraDir = await freshDevDir();
    const sandbox = await makeSandboxRepo();
    created.push(sandbox.root);

    const historical = resolveHarnessPaths(sandbox.root);
    expect(historical.planFile).toBe(path.join(sandbox.root, 'dev', 'plan.yaml'));
    expect(historical.devDir).toBe(path.join(sandbox.root, '.dev'));
    expect(resolveHarnessPaths(sandbox.root, {})).toEqual(historical);

    const externalPlan = path.join(extraDir, 'outside-plan.yaml');
    await writeFile(
      externalPlan,
      `schema_version: 1
tasks:
  - id: T1
    title: externa
    objective: criar src/t1.txt
    acceptance: ['ok']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`,
      'utf8',
    );
    const runtimeDir = path.join(extraDir, 'runtime');
    const result = await runDevCli('dev-init.ts', [
      '--repo',
      sandbox.root,
      '--plan-file',
      externalPlan,
      '--runtime-dir',
      runtimeDir,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      plan_file: string;
      task_count: number;
      dev_dir: string;
    };
    expect(summary.plan_file).toBe(path.resolve(externalPlan));
    expect(summary.dev_dir).toBe(path.resolve(runtimeDir));
    expect(summary.task_count).toBe(1);
    expect(JSON.parse(await readFile(path.join(runtimeDir, 'state.json'), 'utf8')).tasks).toHaveLength(
      1,
    );

    const defaultInit = await runDevCli('dev-init.ts', ['--repo', sandbox.root]);
    expect(defaultInit.exitCode, defaultInit.stderr).toBe(0);
    const defaultSummary = JSON.parse(defaultInit.stdout) as { plan_file: string; task_count: number };
    expect(defaultSummary.plan_file).toBe(path.join(sandbox.root, 'dev', 'plan.yaml'));
    expect(defaultSummary.task_count).toBe(2);
    expect(await readFile(path.join(sandbox.root, 'dev', 'plan.yaml'), 'utf8')).toContain(
      'primeira tarefa',
    );
  });
});
