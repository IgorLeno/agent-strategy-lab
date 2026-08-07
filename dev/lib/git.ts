import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './canonical.js';

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

export interface WorkingTreeEntry {
  readonly status: string;
  readonly path: string;
  readonly originalPath: string | null;
}

/** Parser de `git status --porcelain=v1 -z`: status fixo + campos NUL. */
export function parsePorcelainV1Z(output: string): WorkingTreeEntry[] {
  const fields = nulSeparated(output);
  const entries: WorkingTreeEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] as string;
    if (field.length < 4 || field[2] !== ' ') {
      throw new Error(`registro porcelain v1 -z inválido na posição ${index}`);
    }
    const status = field.slice(0, 2);
    const renamedOrCopied = status.includes('R') || status.includes('C');
    const originalPath = renamedOrCopied ? fields[index + 1] : null;
    if (renamedOrCopied && originalPath === undefined) {
      throw new Error(`registro porcelain ${status} sem path original`);
    }
    entries.push({ status, path: field.slice(3), originalPath: originalPath ?? null });
    if (renamedOrCopied) index += 1;
  }
  return entries;
}

/** Paths staged before an orchestrator-owned transaction. */
export async function stagedFiles(repoRoot: string): Promise<string[]> {
  return nulSeparated(
    await gitOrThrow(repoRoot, ['diff', '--cached', '--name-only', '--no-renames', '-z']),
  ).sort();
}

/** Tracked and untracked working-tree paths, including deletions. */
export async function workingTreeSnapshot(repoRoot: string): Promise<WorkingTreeEntry[]> {
  return parsePorcelainV1Z(
    await gitOrThrow(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
}

export async function workingTreeFiles(repoRoot: string): Promise<string[]> {
  const entries = await workingTreeSnapshot(repoRoot);
  const files = new Set<string>();
  for (const entry of entries) {
    files.add(entry.path);
    if (entry.status.includes('R') && entry.originalPath !== null) files.add(entry.originalPath);
  }
  return [...files].sort();
}

async function currentContentSha256(repoRoot: string, relativePath: string): Promise<string | null> {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const metadata = await lstat(absolutePath);
    const content = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolutePath), 'utf8')
      : await readFile(absolutePath);
    return createHash('sha256').update(content).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Binds machine-readable status/path metadata to the current bytes on disk. */
export async function patchFingerprint(repoRoot: string): Promise<string> {
  const snapshot = await workingTreeSnapshot(repoRoot);
  const entries = await Promise.all(
    snapshot.map(async (entry) => ({
      status: entry.status,
      path: entry.path,
      original_path: entry.originalPath,
      current_content_sha256: await currentContentSha256(repoRoot, entry.path),
    })),
  );
  entries.sort((left, right) =>
    `${left.path}\0${left.status}\0${left.original_path ?? ''}`.localeCompare(
      `${right.path}\0${right.status}\0${right.original_path ?? ''}`,
    ),
  );
  return createHash('sha256').update(canonicalJson(entries)).digest('hex');
}

export async function stageFiles(repoRoot: string, files: readonly string[]): Promise<void> {
  const tracked = nulSeparated(await gitOrThrow(repoRoot, ['ls-files', '-z', '--', ...files]));
  const trackedSet = new Set(tracked);
  const newFiles = files.filter((file) => !trackedSet.has(file));
  // `--update` inclui deleções rastreadas; a segunda chamada inclui somente
  // paths novos. Nenhuma delas amplia o pathspec para `git add -A`.
  if (tracked.length > 0) await gitOrThrow(repoRoot, ['add', '--update', '--', ...tracked]);
  if (newFiles.length > 0) await gitOrThrow(repoRoot, ['add', '--', ...newFiles]);
}

/** Restore only index entries; never discard working-tree contents. */
export async function restoreStagedFiles(repoRoot: string, files: readonly string[]): Promise<void> {
  await gitOrThrow(repoRoot, ['restore', '--staged', '--', ...files]);
}

export async function writeTree(repoRoot: string): Promise<string> {
  return (await gitOrThrow(repoRoot, ['write-tree'])).trim();
}

export async function commitTree(repoRoot: string, sha: string): Promise<string> {
  return (await gitOrThrow(repoRoot, ['show', '-s', '--format=%T', sha])).trim();
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
    '--no-renames',
    '-z',
    '-r',
    '-m',
    sha,
  ]);
  return [...new Set(nulSeparated(output))].sort();
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
