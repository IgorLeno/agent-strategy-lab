import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DevelopmentState } from '../../dev/lib/schemas.js';
import { headSha } from '../../dev/lib/git.js';
import { makeTempDevDir, REPO_ROOT, runDevCli } from './helpers.js';

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
});
