import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gitOrThrow, headSha } from './git.js';

/**
 * Materializa um commit em worktree detachado e roda `run` a partir dele, sem
 * tocar no HEAD nem no working tree principal. `node_modules` entra por symlink
 * porque os gates são comandos do projeto (`pnpm typecheck/build/test`) e
 * reinstalar dependências por commit tornaria a validação impraticável — sem o
 * link, os gates falham de forma auditável em vez de silenciosa.
 *
 * A limpeza tenta `worktree remove --force` primeiro (o `build` suja a árvore
 * de propósito) e só então cai para remoção do diretório mais `prune`.
 */
export async function withDetachedWorktree<T>(
  repoRoot: string,
  commit: string,
  run: (cwd: string) => Promise<T>,
): Promise<T> {
  const worktreeDir = await mkdtemp(path.join(tmpdir(), 'agentlab-worktree-'));
  try {
    await gitOrThrow(repoRoot, ['worktree', 'add', '--detach', worktreeDir, commit]);
    const nodeModules = path.join(repoRoot, 'node_modules');
    try {
      await access(nodeModules);
      await symlink(nodeModules, path.join(worktreeDir, 'node_modules'), 'dir');
    } catch {
      // Sem dependências compartilhadas, os gates falham de forma auditável.
    }
    return await run(worktreeDir);
  } finally {
    try {
      await gitOrThrow(repoRoot, ['worktree', 'remove', '--force', worktreeDir]);
    } catch {
      await rm(worktreeDir, { recursive: true, force: true });
      await gitOrThrow(repoRoot, ['worktree', 'prune']).catch(() => undefined);
    }
  }
}

/**
 * Igual a `withDetachedWorktree`, exceto quando o commit JÁ é o HEAD: aí o
 * próprio repositório contém exatamente aqueles bytes e criar um worktree só
 * duplicaria a compilação.
 */
export async function withCommitValidationCwd<T>(
  repoRoot: string,
  commit: string,
  run: (cwd: string) => Promise<T>,
): Promise<T> {
  if ((await headSha(repoRoot)) === commit) return run(repoRoot);
  return withDetachedWorktree(repoRoot, commit, run);
}
