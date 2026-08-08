import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureChangeBundle,
  createDisposableClone,
  type ChangedFile,
  type ChangesManifest,
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-bundle-test-'));
  temporaryRoots.push(root);
  return root;
}

interface SourceRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

/** Repo-alvo com um arquivo de texto, um binário, um executável e um `.gitignore`. */
async function sourceRepo(): Promise<SourceRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await mkdir(path.join(repoPath, 'src'), { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], {
    env: GIT_ENV,
  });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);

  await writeFile(path.join(repoPath, 'README.md'), 'base\n', 'utf8');
  await writeFile(path.join(repoPath, 'src', 'antigo.txt'), 'conteúdo que será movido\n', 'utf8');
  await writeFile(path.join(repoPath, 'src', 'some.txt'), 'sumirá\n', 'utf8');
  await writeFile(path.join(repoPath, 'logo.bin'), Buffer.from([0, 1, 2, 250, 251, 0]));
  await writeFile(path.join(repoPath, 'script.sh'), '#!/bin/sh\necho base\n', 'utf8');
  await writeFile(path.join(repoPath, '.gitignore'), 'ignorado/\n', 'utf8');
  await git(repoPath, ['add', '--all', '--', '.']);
  await git(repoPath, ['commit', '--quiet', '-m', 'base']);

  return { repoPath, baseSha: (await git(repoPath, ['rev-parse', 'HEAD'])).trim() };
}

async function cloneOf(source: SourceRepo): Promise<DisposableClone> {
  return createDisposableClone({
    sourceRepo: source.repoPath,
    baseSha: source.baseSha,
    parentDir: await temporaryRoot(),
  });
}

async function outputDir(): Promise<string> {
  return path.join(await temporaryRoot(), 'execution', 'changes');
}

/**
 * O que um agente deixou no workspace: arquivo novo, modificado, removido,
 * renomeado, binário trocado, bit de execução mexido e lixo ignorado.
 */
async function agentWork(clone: DisposableClone): Promise<void> {
  const at = (relative: string): string => path.join(clone.clonePath, relative);

  await writeFile(at('README.md'), 'base\nlinha do agente\n', 'utf8');
  await writeFile(at('novo.txt'), 'arquivo novo\n', 'utf8');
  await rm(at(path.join('src', 'some.txt')));
  await git(clone.clonePath, ['mv', 'src/antigo.txt', 'src/renomeado.txt']);
  await writeFile(at('logo.bin'), Buffer.from([0, 9, 9, 250, 0, 7, 7]));
  await chmod(at('script.sh'), 0o755);
  await mkdir(at('ignorado'), { recursive: true });
  await writeFile(at(path.join('ignorado', 'lixo.log')), 'lixo\n', 'utf8');
}

function fileNamed(manifest: ChangesManifest, filePath: string): ChangedFile | undefined {
  return manifest.files.find((file) => file.path === filePath);
}

function sha256Of(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('changes.patch reaplica sobre o base SHA', () => {
  it('reproduz a árvore do agente em um clone limpo do mesmo base SHA', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    await agentWork(clone);
    const captured = await captureChangeBundle({ clone, outputDir: await outputDir() });

    // O evaluator: outro clone do mesmo base SHA, com o patch aplicado.
    const evaluator = await cloneOf(source);
    await git(evaluator.clonePath, ['apply', '--binary', captured.patchPath]);
    const reapplied = await captureChangeBundle({
      clone: evaluator,
      outputDir: await outputDir(),
    });

    expect(reapplied.manifest.material_tree_sha256).toBe(
      captured.manifest.material_tree_sha256,
    );
    expect(await readFile(path.join(evaluator.clonePath, 'novo.txt'), 'utf8')).toBe(
      'arquivo novo\n',
    );
    expect(await readFile(path.join(evaluator.clonePath, 'logo.bin'))).toEqual(
      Buffer.from([0, 9, 9, 250, 0, 7, 7]),
    );
  });

  it('captura o material mesmo com o agente commitando parte do trabalho', async () => {
    const source = await sourceRepo();
    const committed = await cloneOf(source);
    await agentWork(committed);
    await git(committed.clonePath, ['config', 'user.email', 'agent@example.com']);
    await git(committed.clonePath, ['config', 'user.name', 'Agent']);
    await git(committed.clonePath, ['add', '--all', '--', '.']);
    await git(committed.clonePath, ['commit', '--quiet', '-m', 'trabalho do agente']);

    const dirty = await cloneOf(source);
    await agentWork(dirty);

    // Mesmo material, histórias de git diferentes: o bundle não pode divergir.
    const fromCommitted = await captureChangeBundle({
      clone: committed,
      outputDir: await outputDir(),
    });
    const fromDirty = await captureChangeBundle({ clone: dirty, outputDir: await outputDir() });

    expect(fromCommitted.manifest.material_tree_sha256).toBe(
      fromDirty.manifest.material_tree_sha256,
    );
    expect(fromCommitted.manifest.patch_sha256).toBe(fromDirty.manifest.patch_sha256);
  });

  it('não deixa o índice do agente esconder material do bundle', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    await writeFile(path.join(clone.clonePath, 'README.md'), 'escondido\n', 'utf8');
    // Index dizendo "esse arquivo não mudou" — a captura lê o disco, não o índice.
    await git(clone.clonePath, ['update-index', '--assume-unchanged', '--', 'README.md']);

    const captured = await captureChangeBundle({ clone, outputDir: await outputDir() });

    expect(fileNamed(captured.manifest, 'README.md')?.status).toBe('modified');
    expect(fileNamed(captured.manifest, 'README.md')?.sha256).toBe(sha256Of('escondido\n'));
  });

  it('escreve um patch vazio quando o agente não mudou nada', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);

    const captured = await captureChangeBundle({ clone, outputDir: await outputDir() });

    expect(captured.manifest.files).toEqual([]);
    expect(captured.manifest.patch_size_bytes).toBe(0);
    expect(await readFile(captured.patchPath, 'utf8')).toBe('');
  });
});

describe('material_tree_sha256', () => {
  it('é o mesmo para a mesma árvore e muda quando um byte muda', async () => {
    const source = await sourceRepo();
    const first = await cloneOf(source);
    await agentWork(first);
    const second = await cloneOf(source);
    await agentWork(second);
    const third = await cloneOf(source);
    await agentWork(third);
    await writeFile(path.join(third.clonePath, 'novo.txt'), 'arquivo novo!\n', 'utf8');

    const a = await captureChangeBundle({ clone: first, outputDir: await outputDir() });
    const b = await captureChangeBundle({ clone: second, outputDir: await outputDir() });
    const c = await captureChangeBundle({ clone: third, outputDir: await outputDir() });

    expect(b.manifest.material_tree_sha256).toBe(a.manifest.material_tree_sha256);
    expect(c.manifest.material_tree_sha256).not.toBe(a.manifest.material_tree_sha256);
    expect(a.manifest.material_tree_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('muda quando só o modo do arquivo muda', async () => {
    const source = await sourceRepo();
    const semBit = await cloneOf(source);
    const comBit = await cloneOf(source);
    await chmod(path.join(comBit.clonePath, 'script.sh'), 0o755);

    const a = await captureChangeBundle({ clone: semBit, outputDir: await outputDir() });
    const b = await captureChangeBundle({ clone: comBit, outputDir: await outputDir() });

    expect(b.manifest.material_tree_sha256).not.toBe(a.manifest.material_tree_sha256);
    expect(fileNamed(b.manifest, 'script.sh')?.mode).toBe('100755');
  });

  it('descreve a árvore inteira, não só o que mudou', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    // Duas árvores com o mesmo diff só coincidem se o hash cobrir só o diff.
    await writeFile(path.join(clone.clonePath, 'novo.txt'), 'igual\n', 'utf8');
    const outro = await cloneOf(source);
    await writeFile(path.join(outro.clonePath, 'novo.txt'), 'igual\n', 'utf8');
    await rm(path.join(outro.clonePath, 'README.md'));

    const a = await captureChangeBundle({ clone, outputDir: await outputDir() });
    const b = await captureChangeBundle({ clone: outro, outputDir: await outputDir() });

    expect(b.manifest.material_tree_sha256).not.toBe(a.manifest.material_tree_sha256);
  });
});

describe('changes-manifest.json', () => {
  it('registra arquivo novo, removido e renomeado', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    await agentWork(clone);

    const { manifest } = await captureChangeBundle({ clone, outputDir: await outputDir() });

    expect(fileNamed(manifest, 'novo.txt')).toEqual({
      path: 'novo.txt',
      status: 'added',
      old_path: null,
      mode: '100644',
      size_bytes: 13,
      sha256: sha256Of('arquivo novo\n'),
    });
    expect(fileNamed(manifest, 'src/some.txt')).toEqual({
      path: 'src/some.txt',
      status: 'deleted',
      old_path: null,
      mode: null,
      size_bytes: null,
      sha256: null,
    });
    expect(fileNamed(manifest, 'src/renomeado.txt')).toMatchObject({
      status: 'renamed',
      old_path: 'src/antigo.txt',
      sha256: sha256Of('conteúdo que será movido\n'),
    });
    expect(fileNamed(manifest, 'README.md')?.status).toBe('modified');
  });

  it('hasheia o alvo do symlink, não o arquivo apontado', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    await symlink('README.md', path.join(clone.clonePath, 'atalho'));

    const { manifest } = await captureChangeBundle({ clone, outputDir: await outputDir() });

    expect(fileNamed(manifest, 'atalho')).toMatchObject({
      status: 'added',
      mode: '120000',
      sha256: sha256Of('README.md'),
    });
  });

  it('não captura o que o .gitignore exclui', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    await agentWork(clone);

    const captured = await captureChangeBundle({ clone, outputDir: await outputDir() });

    expect(fileNamed(captured.manifest, 'ignorado/lixo.log')).toBeUndefined();
    expect(await readFile(captured.patchPath, 'utf8')).not.toContain('ignorado/lixo.log');
  });

  it('grava no disco o mesmo manifest que devolve, com o hash do patch', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    await agentWork(clone);

    const captured = await captureChangeBundle({ clone, outputDir: await outputDir() });

    const onDisk = JSON.parse(await readFile(captured.manifestPath, 'utf8')) as ChangesManifest;
    expect(onDisk).toEqual(captured.manifest);
    expect(onDisk.base_sha).toBe(source.baseSha);
    expect(onDisk.patch_sha256).toBe(sha256Of(await readFile(captured.patchPath)));
    expect(onDisk.files.map((file) => file.path)).toEqual(
      [...onDisk.files.map((file) => file.path)].sort(),
    );
  });
});

describe('fronteiras da captura', () => {
  it('recusa escrever o bundle dentro do repo-alvo', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);

    await expect(
      captureChangeBundle({ clone, outputDir: path.join(source.repoPath, 'changes') }),
    ).rejects.toThrow(/dentro do repo-alvo/);
    expect(
      (await git(source.repoPath, ['status', '--porcelain=v1', '--untracked-files=all'])).trim(),
    ).toBe('');
  });

  it('recusa escrever o bundle dentro do clone descartável', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);

    // Seria apagado junto com o clone: evidência perdida sem nenhum erro.
    await expect(
      captureChangeBundle({ clone, outputDir: path.join(clone.clonePath, 'changes') }),
    ).rejects.toThrow(/dentro do clone descartável/);
  });

  it('recusa sobrescrever um bundle já capturado', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    const dir = await outputDir();
    await captureChangeBundle({ clone, outputDir: dir });

    await expect(captureChangeBundle({ clone, outputDir: dir })).rejects.toThrow(/já existe/);
  });

  it('recusa capturar repositório git aninhado em vez de perder o material dele', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    const nested = path.join(clone.clonePath, 'aninhado');
    await mkdir(nested);
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', nested], {
      env: GIT_ENV,
    });
    await git(nested, ['config', 'user.email', 'lab@example.com']);
    await git(nested, ['config', 'user.name', 'Lab']);
    await writeFile(path.join(nested, 'dentro.txt'), 'material invisível\n', 'utf8');
    await git(nested, ['add', '--all', '--', '.']);
    await git(nested, ['commit', '--quiet', '-m', 'aninhado']);

    await expect(captureChangeBundle({ clone, outputDir: await outputDir() })).rejects.toThrow(
      /repositório git aninhado/,
    );
  });

  it('não escreve no repo-alvo durante a captura', async () => {
    const source = await sourceRepo();
    const clone = await cloneOf(source);
    await agentWork(clone);
    const refsBefore = await git(source.repoPath, ['for-each-ref']);

    await captureChangeBundle({ clone, outputDir: await outputDir() });

    expect(await git(source.repoPath, ['for-each-ref'])).toBe(refsBefore);
    expect(
      (await git(source.repoPath, ['status', '--porcelain=v1', '--untracked-files=all'])).trim(),
    ).toBe('');
  });
});
