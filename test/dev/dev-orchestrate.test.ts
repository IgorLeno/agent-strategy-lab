import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { readState } from '../../dev/lib/state.js';
import { makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function trackSandbox(): Promise<Sandbox> {
  const sandbox = await makeSandboxRepo();
  created.push(sandbox.root);
  return sandbox;
}

describe('dev-orchestrate — compatibilidade histórica e overrides aditivos', () => {
  it('K — sem --plan-file/--runtime-dir usa <repo>/dev/plan.yaml e <repo>/.dev', async () => {
    const sandbox = await trackSandbox();
    const defaults = resolveHarnessPaths(sandbox.root);
    expect(defaults.planFile).toBe(path.join(sandbox.root, 'dev', 'plan.yaml'));
    expect(defaults.devDir).toBe(path.join(sandbox.root, '.dev'));
    expect(resolveHarnessPaths(sandbox.root, {})).toEqual(defaults);

    const init = await runDevCli('dev-init.ts', ['--repo', sandbox.root]);
    expect(init.exitCode, init.stderr).toBe(0);
    expect(JSON.parse(init.stdout).plan_file).toBe(defaults.planFile);

    const result = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', 'fake-worker-v1'],
      { AGENTLAB_FAKE_MODE: 'success' },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iterations: { task_id: string }[];
    };
    expect(summary.stopped_by).toBe('ALL_DONE');
    expect(summary.iterations.map((item) => item.task_id)).toEqual(['T1', 'T2']);
    const state = await readState(defaults);
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS', 'PASS']);
  }, 60_000);

  it('aceita --plan-file e --runtime-dir aditivos sem copiar o plan', async () => {
    const sandbox = await trackSandbox();
    const extra = await mkdtemp(path.join(tmpdir(), 'agentlab-orch-'));
    created.push(extra);
    const planFile = path.join(extra, 'external.yaml');
    await writeFile(
      planFile,
      `schema_version: 1
tasks:
  - id: T1
    title: externa
    objective: criar src/t1.txt
    initial_files: [README.md]
    acceptance: ['arquivo criado']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`,
      'utf8',
    );
    const runtimeDir = path.join(extra, 'runtime');
    const bundled = await readFile(path.join(sandbox.root, 'dev', 'plan.yaml'), 'utf8');

    const init = await runDevCli('dev-init.ts', [
      '--repo',
      sandbox.root,
      '--plan-file',
      planFile,
      '--runtime-dir',
      runtimeDir,
    ]);
    expect(init.exitCode, init.stderr).toBe(0);

    const result = await runDevCli(
      'dev-orchestrate.ts',
      [
        '--repo',
        sandbox.root,
        '--profile',
        'fake-worker-v1',
        '--plan-file',
        planFile,
        '--runtime-dir',
        runtimeDir,
      ],
      { AGENTLAB_FAKE_MODE: 'success' },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).stopped_by).toBe('ALL_DONE');
    expect(await readFile(planFile, 'utf8')).toContain('title: externa');
    expect(await readFile(path.join(sandbox.root, 'dev', 'plan.yaml'), 'utf8')).toBe(bundled);
    const state = await readState(resolveHarnessPaths(sandbox.root, { planFile, devDir: runtimeDir }));
    expect(state.tasks.map((task) => task.id)).toEqual(['T1']);
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS']);
  }, 60_000);
});
