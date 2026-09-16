import { access, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_POLICY_PRESET,
  authorizationYaml,
  loadPolicyPreset,
  materializeAuthorization,
} from '../../dev/lib/policy-preset.js';
import {
  inspectWizardProject,
  listRecentRuntimes,
  prepareNewProject,
} from '../../dev/lib/lab-project-selection.js';
import { runGit } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agentlab-wizard-'));
  created.push(root);
  return root;
}

async function gitOk(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

async function makeRepository(parent: string, name: string): Promise<string> {
  const root = path.join(parent, name);
  await mkdir(root, { recursive: true });
  await gitOk(root, ['init', '-q', '-b', 'main']);
  await gitOk(root, ['config', 'user.name', 'Wizard Test']);
  await gitOk(root, ['config', 'user.email', 'wizard@example.invalid']);
  await writeFile(path.join(root, 'README.md'), '# test\n');
  await gitOk(root, ['add', '--all']);
  await gitOk(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

async function writeRuntime(runtimeDir: string, target: { readonly type: 'external'; readonly identity: string } | { readonly type: 'self'; readonly identity: string }): Promise<void> {
  await mkdir(path.join(runtimeDir, 'lab'), { recursive: true });
  await writeFile(
    path.join(runtimeDir, 'lab', 'human-instruction.json'),
    JSON.stringify({
      schema_version: 1,
      raw_instruction: 'Validate the project.',
      source: 'stdin',
      source_path: null,
      target,
      base_sha: '0'.repeat(40),
      instruction_hash: '1'.repeat(64),
    }),
  );
}

async function writeResumableRuntime(
  runtimeDir: string,
  target: { readonly type: 'external'; readonly identity: string } | { readonly type: 'self'; readonly identity: string },
  selfControlRoot?: string,
): Promise<void> {
  await writeRuntime(runtimeDir, target);
  const requested_scope = { summary: 'desenvolvimento local' };
  await writeFile(
    path.join(runtimeDir, 'lab', 'project-intake.yaml'),
    JSON.stringify({
      schema_version: 1,
      target_repo: { url: target.identity },
      base_revision: { sha: '0'.repeat(40) },
      user_request: 'Validate the project.',
      objectives: ['Validate the project.'],
      constraints: [],
      exclusions: [],
      requested_scope,
    }),
  );
  const preset = await loadPolicyPreset(DEFAULT_POLICY_PRESET);
  await writeFile(
    path.join(runtimeDir, 'lab', 'authorization.yaml'),
    authorizationYaml(materializeAuthorization({ preset: preset.file, requested_scope })),
  );
  if (target.type === 'self') {
    const controllerSha = selfControlRoot === undefined
      ? '0'.repeat(40)
      : (await gitOk(selfControlRoot, ['rev-parse', 'HEAD'])).trim();
    await writeFile(
      path.join(runtimeDir, 'lab', 'self-target.json'),
      JSON.stringify({
        schema_version: 1,
        controller_sha: controllerSha,
        original_ref: 'main',
        original_main_sha: controllerSha,
        target_worktree_path: path.join(runtimeDir, 'worktree'),
        self_maintenance_branch: 'agentlab/self/test',
        recorded_base_sha: controllerSha,
      }),
    );
  }
}

describe('lab project selection', () => {
  it('expands a leading home marker and reports a clean Git root', async () => {
    const parent = await temporaryDirectory();
    const controlRoot = await makeRepository(parent, 'control');
    const root = await makeRepository(parent, 'app');
    await gitOk(root, ['remote', 'add', 'origin', 'https://github.com/owner/app.git']);
    const nestedPath = path.join(root, 'nested');
    await mkdir(nestedPath);
    const previousHome = process.env['HOME'];
    process.env['HOME'] = parent;
    try {
      await expect(inspectWizardProject({ requestedPath: '~/app/nested', controlRoot })).resolves.toMatchObject({
        root,
        branch: 'main',
        clean: true,
        remote: 'owner/app',
      });
    } finally {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
    }
  });

  it('rejects missing, non-Git, dirty, and control-repository paths', async () => {
    const parent = await temporaryDirectory();
    const controlRoot = await makeRepository(parent, 'control');
    const dirty = await makeRepository(parent, 'dirty');
    await writeFile(path.join(dirty, 'dirty.txt'), 'dirty\n');
    const nonGit = path.join(parent, 'not-a-repository');
    await mkdir(nonGit);

    await expect(inspectWizardProject({ requestedPath: path.join(parent, 'missing'), controlRoot })).rejects.toThrow(/não encontrei/i);
    await expect(inspectWizardProject({ requestedPath: nonGit, controlRoot })).rejects.toThrow(/Git/i);
    await expect(inspectWizardProject({ requestedPath: dirty, controlRoot })).rejects.toThrow(/alterações/i);
    await expect(inspectWizardProject({ requestedPath: controlRoot, controlRoot })).rejects.toThrow(/próprio Agent Lab/i);
  });

  it('ignores malformed runtime artifacts and sorts valid recent runtimes', async () => {
    const parent = await temporaryDirectory();
    const controlRoot = await makeRepository(parent, 'control');
    const repository = await makeRepository(parent, 'external');
    const runs = path.join(parent, 'runs');
    const older = path.join(runs, 'external', 'older');
    const newest = path.join(runs, 'self', 'newest');
    await writeResumableRuntime(older, { type: 'external', identity: repository });
    await writeResumableRuntime(newest, { type: 'self', identity: 'self' }, controlRoot);
    await mkdir(path.join(runs, 'broken', 'ignored', 'lab'), { recursive: true });
    await writeFile(path.join(runs, 'broken', 'ignored', 'lab', 'human-instruction.json'), '{not json');
    const now = Date.now();
    await utimes(older, now / 1000 - 10, now / 1000 - 10);
    await utimes(newest, now / 1000, now / 1000);

    expect((await listRecentRuntimes({ controlRoot, env: { AGENTLAB_RUNS_DIR: runs } })).map(({ runtimeDir }) => runtimeDir)).toEqual([newest, older]);
  });

  it('ignores a HumanInstruction without the coherent resume artifacts', async () => {
    const parent = await temporaryDirectory();
    const controlRoot = await makeRepository(parent, 'control');
    const repository = await makeRepository(parent, 'external');
    const runs = path.join(parent, 'runs');
    const incomplete = path.join(runs, 'external', 'instruction-only');
    await writeRuntime(incomplete, { type: 'external', identity: repository });

    await expect(listRecentRuntimes({ controlRoot, env: { AGENTLAB_RUNS_DIR: runs } })).resolves.toEqual([]);
  });

  it('ignores a self runtime whose persisted control revision diverged', async () => {
    const parent = await temporaryDirectory();
    const controlRoot = await makeRepository(parent, 'control');
    const runs = path.join(parent, 'runs');
    const staleSelf = path.join(runs, 'self', 'stale');
    await writeResumableRuntime(staleSelf, { type: 'self', identity: 'self' });

    await expect(listRecentRuntimes({ controlRoot, env: { AGENTLAB_RUNS_DIR: runs } })).resolves.toEqual([]);
  });

  it('refuses missing Git identity before creating a project directory', async () => {
    const parentDirectory = await temporaryDirectory();
    const noIdentityGit = async (_cwd: string, args: readonly string[]) => ({
      exitCode: args.at(-1) === 'user.name' ? 1 : 1,
      stdout: '',
      stderr: '',
    });
    const target = path.join(parentDirectory, 'no-identity');

    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(prepareNewProject({ parentDirectory, name: 'no-identity', git: noIdentityGit })).rejects.toThrow(/user.name/i);
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not mistake a parent repository local identity for inherited identity', async () => {
    const parentDirectory = await temporaryDirectory();
    await gitOk(parentDirectory, ['init', '-q', '-b', 'main']);
    await gitOk(parentDirectory, ['config', 'user.name', 'Parent only']);
    await gitOk(parentDirectory, ['config', 'user.email', 'parent@example.invalid']);
    const calls: string[][] = [];
    const noInheritedIdentityGit = async (_cwd: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes('--global') || args.includes('--system')) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      return { exitCode: 0, stdout: 'Parent only\n', stderr: '' };
    };
    const target = path.join(parentDirectory, 'no-inherited-identity');

    await expect(prepareNewProject({
      parentDirectory,
      name: 'no-inherited-identity',
      git: noInheritedIdentityGit,
    })).rejects.toThrow(/user.name/i);
    expect(calls).toEqual([
      ['config', '--global', '--get', 'user.name'],
      ['config', '--global', '--get', 'user.email'],
      ['config', '--system', '--get', 'user.name'],
      ['config', '--system', '--get', 'user.email'],
    ]);
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a clean main repository and optional local origin only on request', async () => {
    const parentDirectory = await temporaryDirectory();
    const target = path.join(parentDirectory, 'demo');
    await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(prepareNewProject({
      parentDirectory,
      name: 'demo',
      remoteUrl: 'https://github.com/org/demo.git',
    })).resolves.toMatchObject({ root: target, branch: 'main', clean: true, remote: 'org/demo' });
    await expect(stat(target)).resolves.toBeDefined();
  });
});
