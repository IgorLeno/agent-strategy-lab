import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  assertWithinClone,
  createDisposableClone,
  disposeClone,
  withDisposableClone,
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

/** Root só consegue remover diretório dentro de pai sem escrita — o teste de falha não vale lá. */
const asRoot = process.getuid?.() === 0;

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-cleanup-test-'));
  temporaryRoots.push(root);
  return root;
}

interface SourceRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

async function sourceRepo(): Promise<SourceRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], {
    env: GIT_ENV,
  });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await writeFile(path.join(repoPath, 'base.txt'), 'base\n', 'utf8');
  await git(repoPath, ['add', '--', 'base.txt']);
  await git(repoPath, ['commit', '--quiet', '-m', 'base']);

  return { repoPath, baseSha: (await git(repoPath, ['rev-parse', 'HEAD'])).trim() };
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
    temporaryRoots.splice(0).map(async (root) => {
      // Um teste deixa o pai sem escrita de propósito; sem isto a limpeza falha.
      await chmod(root, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe('descarte do clone', () => {
  it('remove o clone do disco quando o run termina bem', async () => {
    const source = await sourceRepo();
    let clonePath = '';

    const result = await withDisposableClone(
      { sourceRepo: source.repoPath, baseSha: source.baseSha, parentDir: await temporaryRoot() },
      async (clone) => {
        clonePath = clone.clonePath;
        expect(await exists(path.join(clone.clonePath, 'base.txt'))).toBe(true);
        return 'resultado do run';
      },
    );

    expect(result).toBe('resultado do run');
    expect(await exists(clonePath)).toBe(false);
  });

  it('remove o clone mesmo quando o run falha, e preserva o erro do run', async () => {
    const source = await sourceRepo();
    let clonePath = '';

    await expect(
      withDisposableClone(
        { sourceRepo: source.repoPath, baseSha: source.baseSha, parentDir: await temporaryRoot() },
        async (clone) => {
          clonePath = clone.clonePath;
          // Lixo do agente: o descarte não pode depender de a árvore estar limpa.
          await writeFile(path.join(clone.clonePath, 'grande.bin'), 'x'.repeat(1024), 'utf8');
          await mkdir(path.join(clone.clonePath, 'sub', 'dir'), { recursive: true });
          throw new Error('run explodiu');
        },
      ),
    ).rejects.toThrow('run explodiu');

    expect(clonePath).not.toBe('');
    expect(await exists(clonePath)).toBe(false);
  });

  it('descartar duas vezes não é erro', async () => {
    const source = await sourceRepo();
    const clone = await createDisposableClone({
      sourceRepo: source.repoPath,
      baseSha: source.baseSha,
      parentDir: await temporaryRoot(),
    });

    await disposeClone(clone);
    await expect(disposeClone(clone)).resolves.toBeUndefined();
  });

  it.skipIf(asRoot)('reporta erro quando o clone continua no disco', async () => {
    const source = await sourceRepo();
    const parentDir = await temporaryRoot();
    const clone = await createDisposableClone({
      sourceRepo: source.repoPath,
      baseSha: source.baseSha,
      parentDir,
    });

    await chmod(parentDir, 0o500);
    try {
      await expect(disposeClone(clone)).rejects.toThrow(/continua no disco/);
      expect(await exists(clone.clonePath)).toBe(true);
    } finally {
      await chmod(parentDir, 0o700);
    }
  });

  it.skipIf(asRoot)('reporta run e descarte juntos quando os dois falham', async () => {
    const source = await sourceRepo();
    const parentDir = await temporaryRoot();

    const failure = await withDisposableClone(
      { sourceRepo: source.repoPath, baseSha: source.baseSha, parentDir },
      async () => {
        await chmod(parentDir, 0o500);
        throw new Error('run explodiu');
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await chmod(parentDir, 0o700);

    expect(failure).toBeInstanceOf(AggregateError);
    const messages = (failure as AggregateError).errors.map((error: unknown) => String(error));
    expect(messages.some((message) => message.includes('run explodiu'))).toBe(true);
    expect(messages.some((message) => message.includes('continua no disco'))).toBe(true);
  });
});

describe('proteção do repo-alvo no descarte', () => {
  it('recusa descartar caminho dentro do repo-alvo', async () => {
    const source = await sourceRepo();
    const inside = path.join(source.repoPath, 'agentlab-clone-forjado');
    await mkdir(inside);
    const forged: DisposableClone = {
      clonePath: inside,
      gitDir: path.join(inside, '.git'),
      sourceRepo: source.repoPath,
      baseSha: source.baseSha,
      branch: 'agent-workspace',
    };

    await expect(disposeClone(forged)).rejects.toThrow(/dentro do repo-alvo/);
    expect(await exists(inside)).toBe(true);
    expect(await exists(path.join(source.repoPath, 'base.txt'))).toBe(true);
  });

  it('recusa descartar diretório que não tem o prefixo do clone', async () => {
    const source = await sourceRepo();
    const outside = path.join(await temporaryRoot(), 'documentos');
    await mkdir(outside);
    const forged: DisposableClone = {
      clonePath: outside,
      gitDir: path.join(outside, '.git'),
      sourceRepo: source.repoPath,
      baseSha: source.baseSha,
      branch: 'agent-workspace',
    };

    await expect(disposeClone(forged)).rejects.toThrow(/não é um clone descartável/);
    expect(await exists(outside)).toBe(true);
  });

  it('recusa descartar caminho que deixou de ser diretório', async () => {
    const source = await sourceRepo();
    const clone = await createDisposableClone({
      sourceRepo: source.repoPath,
      baseSha: source.baseSha,
      parentDir: await temporaryRoot(),
    });

    await rm(clone.clonePath, { recursive: true, force: true });
    await symlink(source.repoPath, clone.clonePath);

    await expect(disposeClone(clone)).rejects.toThrow(/não é mais um diretório/);
    expect(await exists(path.join(source.repoPath, 'base.txt'))).toBe(true);
  });
});

describe('guarda de escrita', () => {
  async function cloneOf(source: SourceRepo): Promise<DisposableClone> {
    return createDisposableClone({
      sourceRepo: source.repoPath,
      baseSha: source.baseSha,
      parentDir: await temporaryRoot(),
    });
  }

  it('aceita caminho dentro do clone, inclusive um que ainda não existe', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);

    expect(await assertWithinClone(clone, path.join(clone.clonePath, 'base.txt'))).toBe(
      path.join(clone.clonePath, 'base.txt'),
    );
    expect(await assertWithinClone(clone, path.join(clone.clonePath, 'novo', 'arquivo.txt'))).toBe(
      path.join(clone.clonePath, 'novo', 'arquivo.txt'),
    );
  });

  it('recusa escrita no repo-alvo', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);

    await expect(assertWithinClone(clone, path.join(source.repoPath, 'base.txt'))).rejects.toThrow(
      /escrita no repo-alvo recusada/,
    );
    await expect(
      assertWithinClone(clone, path.join(source.repoPath, '.git', 'config')),
    ).rejects.toThrow(/escrita no repo-alvo recusada/);
    await expect(assertWithinClone(clone, source.repoPath)).rejects.toThrow(
      /escrita no repo-alvo recusada/,
    );
  });

  it('recusa sair do clone por caminho relativo', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);

    await expect(
      assertWithinClone(clone, path.join(clone.clonePath, '..', 'vizinho.txt')),
    ).rejects.toThrow(/fora do clone descartável/);
    // Sem `path.join`, para o `..` chegar literal na guarda em vez de já
    // normalizado — é assim que ele chega vindo do agente.
    const escape = `${clone.clonePath}/${path.relative(clone.clonePath, source.repoPath)}/novo.txt`;
    expect(escape).toContain('..');
    await expect(assertWithinClone(clone, escape)).rejects.toThrow(
      /escrita no repo-alvo recusada/,
    );
  });

  it('recusa symlink do clone que aponta para o repo-alvo', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    const atalho = path.join(clone.clonePath, 'atalho');
    await symlink(source.repoPath, atalho);

    await expect(assertWithinClone(clone, atalho)).rejects.toThrow(/escrita no repo-alvo recusada/);
    await expect(assertWithinClone(clone, path.join(atalho, 'base.txt'))).rejects.toThrow(
      /escrita no repo-alvo recusada/,
    );
  });

  it('recusa symlink quebrado do clone que aponta para o repo-alvo', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    const quebrado = path.join(clone.clonePath, 'quebrado');
    // O alvo não existe: para `access` é arquivo novo, mas a escrita cairia
    // dentro do repositório do usuário.
    await symlink(path.join(source.repoPath, 'ainda-nao-existe.txt'), quebrado);

    await expect(assertWithinClone(clone, quebrado)).rejects.toThrow(
      /escrita no repo-alvo recusada/,
    );
  });

  it('recusa cadeia de symlinks sem fim', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    const a = path.join(clone.clonePath, 'a');
    const b = path.join(clone.clonePath, 'b');
    await symlink(b, a);
    await symlink(a, b);

    await expect(assertWithinClone(clone, a)).rejects.toThrow(/cadeia de symlinks/);
  });
});
