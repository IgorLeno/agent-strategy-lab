/**
 * Git do loop: onde o plano roda e como cada step aceito vira commit.
 *
 *   direct   — commit na branch atual. Push nunca é automático aqui.
 *   branch   — padrão. Branch `asl/<slug>` criada a partir do HEAD.
 *   worktree — worktree isolada por plano, com a mesma branch `asl/<slug>`.
 *
 * O agente nunca commita (os modos de permissão negam). Quem commita é o loop,
 * depois do gate verde, com tudo que mudou — inclusive o checkbox do plano.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitMode = 'direct' | 'branch' | 'worktree';

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch (error) {
    const detail = error as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(' ')}: ${(detail.stderr ?? detail.message).trim()}`);
  }
}

/** Árvore limpa, ignorando opcionalmente alguns caminhos (relativos à raiz). */
export async function isClean(cwd: string, ignore: readonly string[] = []): Promise<boolean> {
  const status = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  return status
    .split('\n')
    .filter((line) => line.trim() !== '')
    .every((line) => ignore.includes(line.slice(3)));
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
}

/** Slug estável para nome de branch: minúsculas, `-` no lugar do resto. */
export function planSlug(title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug === '' ? 'plano' : slug;
}

export interface Workspace {
  /** Diretório onde o agente roda e o loop commita. */
  readonly dir: string;
  readonly branch: string;
  /** HEAD depois do commit do plano: base do diff do handoff. */
  readonly baseSha: string;
  /** Caminho absoluto do `plan.md` que o loop executa (dentro de `dir`). */
  readonly planPath: string;
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function sameContent(left: string, right: string): Promise<boolean> {
  try {
    return (await readFile(left, 'utf8')) === (await readFile(right, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Prepara o workspace do plano e commita o `plan.md` aprovado (decisão Q7).
 *
 * O plano costuma chegar não commitado — o usuário acabou de aprová-lo — então
 * ele é o único caminho tolerado sujo num INÍCIO. Qualquer outra mudança
 * recusa: o commit do step levaria junto trabalho que não é do agente.
 *
 * Numa RETOMADA (`knownBaseSha` presente) a árvore suja é aceita: é o trabalho
 * do step que falhou ou foi interrompido, e a próxima tentativa continua dele.
 *
 * Retomar o mesmo plano reaproveita branch ou worktree. Na worktree, a cópia
 * do plano que vale é a dela.
 */
export async function prepareWorkspace(input: {
  readonly repo: string;
  readonly mode: GitMode;
  readonly slug: string;
  /** `plan.md` relativo à raiz do repositório (padrão do produto: `.asl/plan.md`). */
  readonly planRelPath: string;
  /** Onde criar worktrees; padrão: irmão do repositório. */
  readonly worktreeRoot?: string;
  /** Base já registrada de uma execução anterior do mesmo plano. */
  readonly knownBaseSha?: string;
}): Promise<Workspace> {
  const { repo, mode, slug, planRelPath } = input;
  const resuming = input.knownBaseSha !== undefined;
  if (!resuming && !(await isClean(repo, [planRelPath]))) {
    throw new GitError(`árvore suja em ${repo}: commite ou descarte as mudanças antes de iniciar`);
  }
  const branch = `asl/${slug}`;
  let dir = repo;
  let activeBranch = branch;

  if (mode === 'direct') {
    activeBranch = await currentBranch(repo);
  } else if (mode === 'branch') {
    // `switch` carrega a mudança não commitada do plano para a branch.
    if (await branchExists(repo, branch)) await git(repo, ['switch', branch]);
    else await git(repo, ['switch', '-c', branch]);
  } else {
    const root = input.worktreeRoot ?? path.dirname(repo);
    dir = path.join(root, `${path.basename(repo)}-asl-${slug}`);
    const listed = await git(repo, ['worktree', 'list', '--porcelain']);
    const exists = listed.split('\n').some((line) => line === `worktree ${dir}`);
    if (!exists) {
      if (await branchExists(repo, branch)) await git(repo, ['worktree', 'add', dir, branch]);
      else await git(repo, ['worktree', 'add', '-b', branch, dir]);
      const source = path.join(repo, planRelPath);
      const target = path.join(dir, planRelPath);
      if (!(await sameContent(source, target))) {
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(source, target);
      }
    } else if (!resuming && !(await isClean(dir, [planRelPath]))) {
      throw new GitError(`árvore suja na worktree ${dir}`);
    }
  }

  await commitAll(dir, `asl: plano ${slug}`, [planRelPath]);
  return {
    dir,
    branch: activeBranch,
    baseSha: input.knownBaseSha ?? (await headSha(dir)),
    planPath: path.join(dir, planRelPath),
  };
}

/**
 * Commita tudo que mudou no workspace. Devolve o sha novo, ou `null` quando
 * não havia nada para commitar. Hooks do repositório rodam: hook que recusa é
 * falha do step, como gate vermelho.
 */
export async function commitAll(
  dir: string,
  message: string,
  only?: readonly string[],
): Promise<string | null> {
  await git(dir, only === undefined ? ['add', '-A'] : ['add', '--', ...only]);
  if ((await git(dir, ['diff', '--cached', '--name-only'])).trim() === '') return null;
  await git(dir, ['commit', '-q', '-m', message]);
  return headSha(dir);
}

/**
 * Diff da árvore de trabalho (incluindo arquivos novos) contra `baseSha`,
 * sem os caminhos de `exclude` (o próprio plano, cujo checkbox muda a cada step).
 */
export async function diffSince(
  dir: string,
  baseSha: string,
  exclude: readonly string[] = [],
): Promise<{ stat: string; patch: string }> {
  const pathspec = ['--', '.', ...exclude.map((entry) => `:(exclude)${entry}`)];
  // `add -N` torna arquivos novos visíveis ao diff; o `reset` devolve o índice
  // ao HEAD, que é onde o loop o mantém entre commits.
  await git(dir, ['add', '-N', '.']);
  try {
    const stat = await git(dir, ['diff', '--stat', baseSha, ...pathspec]);
    const patch = await git(dir, ['diff', baseSha, ...pathspec]);
    return { stat, patch };
  } finally {
    await git(dir, ['reset', '-q']);
  }
}
