import { spawn } from 'node:child_process';

export interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly argv: readonly string[],
    readonly result: GitResult,
  ) {
    super(`git ${argv.join(' ')} falhou (exit ${result.exitCode}): ${result.stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** Sempre argv, nunca shell — nenhum caminho do harness interpola string em shell. */
export function git(
  repoRoot: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoRoot, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

export async function gitOrThrow(
  repoRoot: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await git(repoRoot, args, env);
  if (result.exitCode !== 0) throw new GitError(args, result);
  return result.stdout;
}

function nulSeparated(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** Paths staged before an orchestrator-owned transaction. */
export async function stagedFiles(repoRoot: string): Promise<string[]> {
  return nulSeparated(await gitOrThrow(repoRoot, ['diff', '--cached', '--name-only', '-z'])).sort();
}

/** Tracked and untracked working-tree paths, including deletions. */
export async function workingTreeFiles(repoRoot: string): Promise<string[]> {
  const entries = nulSeparated(
    await gitOrThrow(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
  const files = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as string;
    const status = entry.slice(0, 2);
    files.add(entry.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const original = entries[index + 1];
      if (original !== undefined) files.add(original);
      index += 1;
    }
  }
  return [...files].sort();
}

export async function stageFiles(repoRoot: string, files: readonly string[]): Promise<void> {
  await gitOrThrow(repoRoot, ['add', '--', ...files]);
}

/** Restore only index entries; never discard working-tree contents. */
export async function restoreStagedFiles(repoRoot: string, files: readonly string[]): Promise<void> {
  await gitOrThrow(repoRoot, ['restore', '--staged', '--', ...files]);
}

export async function recordedCommitMessage(repoRoot: string, sha: string): Promise<string> {
  const output = await gitOrThrow(repoRoot, ['log', '-1', '--format=%B', sha]);
  return output.replace(/\n+$/, '');
}

export async function headSha(repoRoot: string): Promise<string> {
  return (await gitOrThrow(repoRoot, ['rev-parse', 'HEAD'])).trim();
}

export async function commitExists(repoRoot: string, sha: string): Promise<boolean> {
  const result = await git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
  return result.exitCode === 0;
}

/** Working tree limpa = sem modificações rastreadas E sem arquivos não rastreados. */
export async function isWorkingTreeClean(repoRoot: string): Promise<boolean> {
  const status = await gitOrThrow(repoRoot, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return status.trim() === '';
}

export async function parentSha(repoRoot: string, sha: string): Promise<string | null> {
  const result = await git(repoRoot, ['rev-parse', '--verify', `${sha}^`]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Todos os parents do commit, preservando a ordem gravada pelo Git. */
export async function parentShas(repoRoot: string, sha: string): Promise<string[]> {
  const output = await gitOrThrow(repoRoot, ['show', '-s', '--format=%P', sha]);
  return output.trim() === '' ? [] : output.trim().split(/\s+/);
}

export async function changedFiles(repoRoot: string, sha: string): Promise<string[]> {
  const output = await gitOrThrow(repoRoot, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-m',
    sha,
  ]);
  return [...new Set(output.split('\n').map((line) => line.trim()).filter((line) => line !== ''))].sort();
}

/** true quando `ancestor` é ancestral de `descendant` (ou o próprio commit). */
export async function isAncestor(
  repoRoot: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await git(repoRoot, ['merge-base', '--is-ancestor', ancestor, descendant]);
  return result.exitCode === 0;
}
