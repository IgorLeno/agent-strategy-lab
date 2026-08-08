import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { EvaluationOutcome } from '../../src/core/enums.js';
import { runCommandGrader, GRADER_ARTIFACTS_DIR_NAME } from '../../src/evaluator/index.js';
import {
  createDisposableClone,
  disposeClone,
  type DisposableClone,
} from '../../src/workspace/index.js';
import { redactionPlaceholder } from '../../src/storage/index.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];
const clones: DisposableClone[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-command-grader-test-'));
  temporaryRoots.push(root);
  return realpath(root);
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
}

async function sourceRepo(): Promise<{ repoPath: string; baseSha: string }> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], {
    env: GIT_ENV,
  });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await writeFile(path.join(repoPath, 'README.md'), 'base\n', 'utf8');
  await git(repoPath, ['add', '--', 'README.md']);
  await git(repoPath, ['commit', '--quiet', '-m', 'base']);
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
  return { repoPath, baseSha: stdout.trim() };
}

async function clone(): Promise<DisposableClone> {
  const source = await sourceRepo();
  const created = await createDisposableClone({
    sourceRepo: source.repoPath,
    baseSha: source.baseSha,
    parentDir: await temporaryRoot(),
  });
  clones.push(created);
  return created;
}

/** argv de um node inline — mesmo executável que roda os testes, sem depender de shell. */
function nodeArgv(source: string, ...args: string[]): string[] {
  return [process.execPath, '-e', source, ...args];
}

afterEach(async () => {
  await Promise.all(clones.splice(0).map((created) => disposeClone(created)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('runCommandGrader', () => {
  it('converte exit code 0 em PASS', async () => {
    const run = await runCommandGrader({
      clone: await clone(),
      graderId: 'exit-zero',
      argv: nodeArgv('process.exit(0)'),
      required: true,
    });

    expect(run.exitCode).toBe(0);
    expect(run.result).toEqual({ outcome: EvaluationOutcome.PASS, required: true });
    expect(run.timedOut).toBe(false);
  });

  it('converte exit code não-zero em FAIL', async () => {
    const run = await runCommandGrader({
      clone: await clone(),
      graderId: 'exit-one',
      argv: nodeArgv('process.exit(1)'),
      required: false,
    });

    expect(run.exitCode).toBe(1);
    expect(run.result).toEqual({ outcome: EvaluationOutcome.FAIL, required: false });
    expect(run.timedOut).toBe(false);
  });

  it('timeout produz FAIL com timedOut distinto de uma falha comum', async () => {
    const run = await runCommandGrader({
      clone: await clone(),
      graderId: 'hangs',
      argv: nodeArgv('setInterval(() => {}, 1000)'),
      required: true,
      timeoutMs: 50,
      gracePeriodMs: 50,
    });

    expect(run.result.outcome).toBe(EvaluationOutcome.FAIL);
    expect(run.timedOut).toBe(true);

    const ordinaryFailure = await runCommandGrader({
      clone: await clone(),
      graderId: 'fails-fast',
      argv: nodeArgv('process.exit(1)'),
      required: true,
      timeoutMs: 60_000,
    });

    expect(ordinaryFailure.result.outcome).toBe(EvaluationOutcome.FAIL);
    expect(ordinaryFailure.timedOut).toBe(false);
  });

  it('persiste stdout e stderr redigidos sob grader-artifacts/<graderId>', async () => {
    const target = await clone();
    const secret = 'AKIAFAKE0123456789AB';

    const run = await runCommandGrader({
      clone: target,
      graderId: 'writes-secret',
      argv: nodeArgv(
        `process.stdout.write('token: ${secret}\\n'); process.stderr.write('err: ${secret}\\n'); process.exit(0)`,
      ),
      required: true,
    });

    const expectedDir = path.join(target.gitDir, GRADER_ARTIFACTS_DIR_NAME, 'writes-secret');
    expect(run.artifacts.stdout.path).toBe(path.join(expectedDir, 'stdout.log'));
    expect(run.artifacts.stderr.path).toBe(path.join(expectedDir, 'stderr.log'));

    const stdout = await readFile(run.artifacts.stdout.path, 'utf8');
    const stderr = await readFile(run.artifacts.stderr.path, 'utf8');
    const placeholder = redactionPlaceholder('aws-access-key-id');

    expect(stdout).toBe(`token: ${placeholder}\n`);
    expect(stderr).toBe(`err: ${placeholder}\n`);
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  });

  it('recusa graderId com caminho embutido', async () => {
    await expect(
      runCommandGrader({
        clone: await clone(),
        graderId: '../escape',
        argv: nodeArgv('process.exit(0)'),
        required: true,
      }),
    ).rejects.toThrow(TypeError);
  });
});
