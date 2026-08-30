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

export interface FileContent {
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * Conteúdo atual de um caminho, na mesma leitura que o git usaria para gravar o
 * blob: symlink vira o alvo do link, e não o que está do outro lado dele.
 * `null` quando o caminho não existe (removido pelo worker).
 */
export async function currentFileContent(
  repoRoot: string,
  relativePath: string,
): Promise<FileContent | null> {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    const metadata = await lstat(absolutePath);
    const content = metadata.isSymbolicLink()
      ? Buffer.from(await readlink(absolutePath), 'utf8')
      : await readFile(absolutePath);
    return {
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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

export interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

/** Entradas de blob de uma árvore, opcionalmente restritas a um pathspec. */
export async function treeEntries(
  repoRoot: string,
  tree: string,
  files?: readonly string[],
): Promise<TreeEntry[]> {
  const pathspec = files === undefined || files.length === 0 ? [] : ['--', ...files];
  const output = await gitOrThrow(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    tree,
    ...pathspec,
  ]);
  return nulSeparated(output).map((record) => {
    const separator = record.indexOf('\t');
    const header = separator === -1 ? [] : record.slice(0, separator).split(' ');
    const [mode, , oid] = header;
    if (mode === undefined || oid === undefined || header.length !== 3) {
      throw new Error(`entrada de git ls-tree em formato inesperado: ${record}`);
    }
    return { mode, oid, path: record.slice(separator + 1) };
  });
}

export interface NameStatusEntry {
  readonly code: string;
  readonly path: string;
  readonly oldPath: string | null;
}

/** `git diff --name-status` entre dois tree-ish, com detecção de rename. */
export async function treeNameStatus(
  repoRoot: string,
  from: string,
  to: string,
  files: readonly string[],
): Promise<NameStatusEntry[]> {
  const output = await gitOrThrow(repoRoot, [
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    from,
    to,
    '--',
    ...files,
  ]);
  const tokens = nulSeparated(output);
  const entries: NameStatusEntry[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const code = tokens[index] as string;
    const renamedOrCopied = code.startsWith('R') || code.startsWith('C');
    const first = tokens[index + 1];
    if (first === undefined) throw new Error(`git diff --name-status terminou em ${code}`);
    if (renamedOrCopied) {
      const second = tokens[index + 2];
      if (second === undefined) throw new Error(`git diff --name-status ${code} sem destino`);
      entries.push({ code, path: second, oldPath: first });
      index += 2;
      continue;
    }
    entries.push({ code, path: first, oldPath: null });
    index += 1;
  }
  return entries;
}

/**
 * Monta uma árvore com o conteúdo ATUAL de `files` sobre `baseSha`, sem tocar no
 * index do repositório: o índice é próprio (`GIT_INDEX_FILE`) e nasce do base.
 *
 * `add --all` restrito ao pathspec é o que faz a árvore descrever também os
 * arquivos removidos e os que ainda não estavam rastreados — um `write-tree` do
 * index real veria só o que o worker tivesse staged, que não é o material.
 */
export async function writeScopedTree(
  repoRoot: string,
  baseSha: string,
  files: readonly string[],
  indexFile: string,
): Promise<string> {
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexFile };
  await gitOrThrow(repoRoot, ['read-tree', baseSha], env);
  await gitOrThrow(repoRoot, ['add', '--all', '--', ...files], env);
  return (await gitOrThrow(repoRoot, ['write-tree'], env)).trim();
}

/**
 * Argumentos que fixam o formato do patch: o repositório pode ter `diff.noprefix`
 * ou um `textconv` configurado, que produziriam um patch legível mas que não
 * reaplica — falha que só apareceria quando a árvore original não existe mais.
 */
const PRESERVED_PATCH_ARGS = [
  '-c',
  'diff.noprefix=false',
  '-c',
  'diff.mnemonicPrefix=false',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--no-relative',
  '--binary',
  '--full-index',
  '--find-renames',
  '--unified=3',
] as const;

export async function scopedPatch(
  repoRoot: string,
  from: string,
  to: string,
  files: readonly string[],
): Promise<string> {
  return gitOrThrow(repoRoot, [...PRESERVED_PATCH_ARGS, from, to, '--', ...files]);
}

/**
 * Reaplica um patch preservado sobre a árvore atual.
 *
 * `--check` primeiro: aplicar meio patch deixaria o alvo num estado que não é
 * nem o base nem o attempt anterior, e nenhum record poderia descrevê-lo.
 * Só working tree, nunca o índice — o worker recebe o alvo como um worker o
 * deixaria, com as mudanças por commitar.
 */
export async function applyPreservedPatch(repoRoot: string, patchFile: string): Promise<void> {
  const args = ['apply', '--whitespace=nowarn', '--', patchFile];
  await gitOrThrow(repoRoot, ['apply', '--check', '--whitespace=nowarn', '--', patchFile]);
  await gitOrThrow(repoRoot, args);
}

/** Caminhos de `files` que existem em `treeish`. */
export async function pathsPresentIn(
  repoRoot: string,
  treeish: string,
  files: readonly string[],
): Promise<Set<string>> {
  const output = await gitOrThrow(repoRoot, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    '--name-only',
    treeish,
    '--',
    ...files,
  ]);
  return new Set(nulSeparated(output));
}

/** Devolve index e working tree de `files` ao conteúdo de `treeish`. */
export async function restoreFilesFrom(
  repoRoot: string,
  treeish: string,
  files: readonly string[],
): Promise<void> {
  await gitOrThrow(repoRoot, ['restore', '--source', treeish, '--staged', '--worktree', '--', ...files]);
}

/** Remove somente os pathspecs indicados do índice; não toca o worktree. */
export async function removeFilesFromIndex(
  repoRoot: string,
  files: readonly string[],
): Promise<void> {
  if (files.length === 0) return;
  await gitOrThrow(repoRoot, ['update-index', '--force-remove', '--', ...files]);
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

export async function currentBranch(repoRoot: string): Promise<string | null> {
  const name = (await gitOrThrow(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return name === 'HEAD' ? null : name;
}

export async function repoTopLevel(repoRoot: string): Promise<string> {
  return (await gitOrThrow(repoRoot, ['rev-parse', '--show-toplevel'])).trim();
}

export async function resolveBranchSha(repoRoot: string, ref: string): Promise<string | null> {
  const result = await git(repoRoot, ['rev-parse', '--verify', `refs/heads/${ref}`]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function worktreePaths(repoRoot: string): Promise<readonly string[]> {
  const output = await gitOrThrow(repoRoot, ['worktree', 'list', '--porcelain']);
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
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
