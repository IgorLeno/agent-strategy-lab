import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createDisposableClone,
  WORKSPACE_BRANCH,
  type DisposableClone,
} from '../../src/workspace/index.js';

const execFileAsync = promisify(execFile);

const temporaryRoots: string[] = [];

/** Ambiente fixo: o teste não pode depender da config git de quem o roda. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-clone-test-'));
  temporaryRoots.push(root);
  return root;
}

interface SourceRepo {
  readonly repoPath: string;
  /** Commit com `base.txt`, deliberadamente atrás da ponta da branch. */
  readonly baseSha: string;
  /** Ponta de `main`, com `tip.txt` além do base. */
  readonly tipSha: string;
  /** Commit que não é apontado por ref nenhuma. */
  readonly danglingSha: string;
}

async function commit(repoPath: string, file: string, message: string): Promise<string> {
  await writeFile(path.join(repoPath, file), `${message}\n`, 'utf8');
  await git(repoPath, ['add', '--', file]);
  await git(repoPath, ['commit', '--quiet', '-m', message]);
  return (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
}

/** Repo-alvo com histórico, um commit solto e um remote com credencial na URL. */
async function sourceRepo(): Promise<SourceRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], {
    env: GIT_ENV,
  });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);

  const baseSha = await commit(repoPath, 'base.txt', 'base');
  const tipSha = await commit(repoPath, 'tip.txt', 'tip');

  await git(repoPath, ['checkout', '--quiet', '--detach', baseSha]);
  const danglingSha = await commit(repoPath, 'dangling.txt', 'dangling');
  await git(repoPath, ['checkout', '--quiet', 'main']);

  await git(repoPath, ['remote', 'add', 'origin', 'https://user:s3cr3t-token@example.com/x.git']);
  return { repoPath, baseSha, tipSha, danglingSha };
}

async function cloneOf(source: SourceRepo, baseSha?: string): Promise<DisposableClone> {
  return createDisposableClone({
    sourceRepo: source.repoPath,
    baseSha: baseSha ?? source.baseSha,
    parentDir: await temporaryRoot(),
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('clone descartável no base SHA', () => {
  it('põe o clone no base SHA pedido, não na ponta da branch', async () => {
    const source = await sourceRepo();

    const clone = await cloneOf(source);

    expect((await git(clone.clonePath, ['rev-parse', 'HEAD'])).trim()).toBe(source.baseSha);
    expect(clone.baseSha).toBe(source.baseSha);
    expect(await exists(path.join(clone.clonePath, 'base.txt'))).toBe(true);
    // A ponta da branch não pode ter vindo junto: o run é atribuído ao base SHA.
    expect(await exists(path.join(clone.clonePath, 'tip.txt'))).toBe(false);
  });

  it('trabalha em uma branch posicionada no base SHA', async () => {
    const source = await sourceRepo();

    const clone = await cloneOf(source);

    expect(clone.branch).toBe(WORKSPACE_BRANCH);
    expect((await git(clone.clonePath, ['symbolic-ref', '--short', 'HEAD'])).trim()).toBe(
      WORKSPACE_BRANCH,
    );
  });

  it('alcança um base SHA que não é ponta de ref nenhuma', async () => {
    const source = await sourceRepo();

    const clone = await cloneOf(source, source.danglingSha);

    expect((await git(clone.clonePath, ['rev-parse', 'HEAD'])).trim()).toBe(source.danglingSha);
    expect(await exists(path.join(clone.clonePath, 'dangling.txt'))).toBe(true);
  });
});

describe('independência do repo-alvo', () => {
  it('não empresta objects: nenhum alternates aponta para o repo-alvo', async () => {
    const source = await sourceRepo();

    const clone = await cloneOf(source);

    expect(await exists(path.join(clone.gitDir, 'objects', 'info', 'alternates'))).toBe(false);
  });

  it('continua íntegro depois de o repo-alvo sumir', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);

    await rm(source.repoPath, { recursive: true, force: true });

    // Objects emprestados morreriam junto com o repo-alvo; os próprios não.
    expect((await git(clone.clonePath, ['cat-file', '-p', `${source.baseSha}^{tree}`])).trim())
      .toContain('base.txt');
    expect((await git(clone.clonePath, ['rev-parse', 'HEAD'])).trim()).toBe(source.baseSha);
  });

  it('não é linked worktree: git dir própria dentro do clone', async () => {
    const source = await sourceRepo();

    const clone = await cloneOf(source);

    expect(clone.gitDir).toBe(path.join(clone.clonePath, '.git'));
    // Em linked worktree e em submódulo, `.git` é arquivo apontando para fora.
    expect((await lstat(clone.gitDir)).isDirectory()).toBe(true);
  });

  it('não herda remote nem a credencial da URL do repo-alvo', async () => {
    const source = await sourceRepo();

    const clone = await cloneOf(source);

    expect((await git(clone.clonePath, ['remote'])).trim()).toBe('');
    const config = await readFile(path.join(clone.gitDir, 'config'), 'utf8');
    expect(config).not.toContain('s3cr3t-token');
    expect(config).not.toContain('example.com');
  });

  it('não escreve no repo-alvo', async () => {
    const source = await sourceRepo();
    const refsBefore = await git(source.repoPath, ['for-each-ref']);

    await cloneOf(source);

    expect((await git(source.repoPath, ['rev-parse', 'HEAD'])).trim()).toBe(source.tipSha);
    expect(await git(source.repoPath, ['for-each-ref'])).toBe(refsBefore);
    expect(
      (await git(source.repoPath, ['status', '--porcelain=v1', '--untracked-files=all'])).trim(),
    ).toBe('');
  });

  it('ignora GIT_DIR herdado do ambiente em vez de operar no repo-alvo', async () => {
    const source = await sourceRepo();
    const previous = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(source.repoPath, '.git');

    try {
      const clone = await cloneOf(source);

      expect(clone.gitDir).toBe(path.join(clone.clonePath, '.git'));
      expect((await git(clone.clonePath, ['rev-parse', 'HEAD'])).trim()).toBe(source.baseSha);
    } finally {
      if (previous === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previous;
    }
  });
});

describe('entradas recusadas', () => {
  it('recusa SHA abreviado', async () => {
    const source = await sourceRepo();

    await expect(cloneOf(source, source.baseSha.slice(0, 12))).rejects.toThrow(TypeError);
  });

  it('recusa commit que não existe no repo-alvo', async () => {
    const source = await sourceRepo();

    await expect(cloneOf(source, 'f'.repeat(40))).rejects.toThrow(/base SHA/);
  });

  it('recusa diretório que não é repositório git', async () => {
    const parentDir = await temporaryRoot();

    await expect(
      createDisposableClone({ sourceRepo: parentDir, baseSha: 'a'.repeat(40), parentDir }),
    ).rejects.toThrow(/não é um repositório git/);
  });

  it('recusa caminho inexistente como repo-alvo', async () => {
    const parentDir = await temporaryRoot();

    await expect(
      createDisposableClone({
        sourceRepo: path.join(parentDir, 'ausente'),
        baseSha: 'a'.repeat(40),
        parentDir,
      }),
    ).rejects.toThrow(/não existe/);
  });

  it('recusa criar o clone dentro do repo-alvo', async () => {
    const source = await sourceRepo();

    await expect(
      createDisposableClone({
        sourceRepo: source.repoPath,
        baseSha: source.baseSha,
        parentDir: path.join(source.repoPath, 'workspace'),
      }),
    ).rejects.toThrow(/dentro do repo-alvo/);
  });
});
