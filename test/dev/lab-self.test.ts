import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureIsolatedSelfTarget,
  integrateSelfMaintenance,
  SelfMaintenanceError,
} from '../../dev/lib/lab-self.js';
import { headSha } from '../../dev/lib/git.js';
import { runGit } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function controlRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-self-unit-'));
  created.push(root);
  await writeFile(path.join(root, 'README.md'), '# control\n', 'utf8');
  await runGit(root, ['init', '-q', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'harness@example.invalid']);
  await runGit(root, ['config', 'user.name', 'Harness Test']);
  await runGit(root, ['add', '-A']);
  await runGit(root, ['commit', '-q', '-m', 'base']);
  return root;
}

describe('self-maintenance isolation', () => {
  it('cria worktree/branch e recusa FF se main divergiu', async () => {
    const control = await controlRepo();
    const runtime = path.join(control, '..', path.basename(control) + '-runtime');
    created.push(runtime);
    const identity = await ensureIsolatedSelfTarget({
      controlRoot: control,
      runId: 'run1',
      worktreePath: path.join(runtime, 'worktree'),
      identityFile: path.join(runtime, 'self-target.json'),
    });
    expect(identity.target_worktree_path).not.toBe(path.resolve(control));
    expect(await headSha(control)).toBe(identity.original_main_sha);

    await writeFile(path.join(identity.target_worktree_path, 'NOTE.md'), 'from worktree\n', 'utf8');
    await runGit(identity.target_worktree_path, ['add', '-A']);
    await runGit(identity.target_worktree_path, ['commit', '-q', '-m', 'self work']);

    await writeFile(path.join(control, 'EXTERNAL.md'), 'external\n', 'utf8');
    await runGit(control, ['add', '-A']);
    await runGit(control, ['commit', '-q', '-m', 'external']);

    await expect(integrateSelfMaintenance({ controlRoot: control, identity })).rejects.toBeInstanceOf(
      SelfMaintenanceError,
    );
    await expect(integrateSelfMaintenance({ controlRoot: control, identity })).rejects.toMatchObject({
      code: 'EXTERNAL_STATE_DIVERGENCE',
    });
    expect(await headSha(identity.target_worktree_path)).not.toBe(await headSha(control));
  });

  it('resume reencontra o mesmo worktree', async () => {
    const control = await controlRepo();
    const runtime = await mkdtemp(path.join(os.tmpdir(), 'agentlab-self-rt-'));
    created.push(runtime);
    const first = await ensureIsolatedSelfTarget({
      controlRoot: control,
      runId: 'run2',
      worktreePath: path.join(runtime, 'worktree'),
      identityFile: path.join(runtime, 'self-target.json'),
    });
    const second = await ensureIsolatedSelfTarget({
      controlRoot: control,
      runId: 'run2',
      worktreePath: path.join(runtime, 'other-worktree'),
      identityFile: path.join(runtime, 'self-target.json'),
    });
    expect(second.target_worktree_path).toBe(first.target_worktree_path);
    expect(second.self_maintenance_branch).toBe(first.self_maintenance_branch);
  });
});
