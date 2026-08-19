import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { inspectRepository } from '../../src/inspection/index.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const fixtureRoot = fileURLToPath(new URL('../../fixtures/external-project/', import.meta.url));

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-inspection-test-'));
  temporaryRoots.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
}

/** Copia a fixture externa para um repo git novo e commita — o inspetor precisa de git state real. */
async function gitFixtureRepo(): Promise<{ repoPath: string; headSha: string }> {
  const repoPath = await temporaryRoot();
  await cp(fixtureRoot, repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], { env: GIT_ENV });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await git(repoPath, ['add', '--all']);
  await git(repoPath, ['commit', '--quiet', '-m', 'fixture inicial']);
  const headSha = (await git(repoPath, ['rev-parse', 'HEAD'])).trim();
  return { repoPath, headSha };
}

/** Lista recursiva de caminho+mtime — usada para provar que a inspeção não escreve nada. */
async function snapshot(root: string): Promise<Map<string, number>> {
  const entries = new Map<string, number>();

  async function walk(relative: string): Promise<void> {
    const absolute = path.join(root, relative);
    const dirEntries = await readdir(absolute, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name === '.git') continue;
      const entryRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(entryRelative);
      } else {
        const stats = await stat(path.join(root, entryRelative));
        entries.set(entryRelative, stats.mtimeMs);
      }
    }
  }

  await walk('.');
  return entries;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('inspectRepository', () => {
  it('deriva stack, package manager, build system, testes e comandos de validação candidatos do disco', async () => {
    const { repoPath } = await gitFixtureRepo();

    const inspection = await inspectRepository({ repoRoot: repoPath });

    expect(inspection.schema_version).toBe(1);
    expect(inspection.stack).toEqual({
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'fs:markers',
    });
    expect(inspection.package_manager).toEqual({
      known: true,
      value: 'npm',
      provenance: 'fs:package-lock.json',
    });
    expect(inspection.build_system.known).toBe(true);
    expect(inspection.tests).toEqual({
      known: true,
      value: { framework: 'vitest', test_directories: ['test'] },
      provenance: 'fs:directories+package.json',
    });

    const candidateNames = inspection.validation_command_candidates.map((candidate) => candidate.name).sort();
    expect(candidateNames).toEqual(['build', 'lint', 'test', 'typecheck']);
    for (const candidate of inspection.validation_command_candidates) {
      expect(candidate.source).toBe('package.json:scripts');
    }
  });

  it('deriva git state via gitOrThrow existente', async () => {
    const { repoPath, headSha } = await gitFixtureRepo();

    const inspection = await inspectRepository({ repoRoot: repoPath });

    expect(inspection.git).toEqual({
      known: true,
      value: { head_sha: headSha, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git:rev-parse+status+remote',
    });
  });

  it('marca git state como sujo quando há alteração não commitada', async () => {
    const { repoPath } = await gitFixtureRepo();
    await writeFile(path.join(repoPath, 'README.md'), 'alterado\n', 'utf8');

    const inspection = await inspectRepository({ repoRoot: repoPath });

    expect(inspection.git.known).toBe(true);
    if (inspection.git.known) {
      expect(inspection.git.value.dirty).toBe(true);
    }
  });

  it('monta o mapa de instruções do projeto como caminho/escopo/relevância, nunca conteúdo', async () => {
    const { repoPath } = await gitFixtureRepo();

    const inspection = await inspectRepository({ repoRoot: repoPath });

    const claudeRef = inspection.project_instructions.find((ref) => ref.path === 'CLAUDE.md');
    expect(claudeRef).toEqual({ path: 'CLAUDE.md', scope: 'root', relevance: 'general' });

    const architectureRef = inspection.project_instructions.find(
      (ref) => ref.path === 'docs/architecture.md',
    );
    expect(architectureRef).toEqual({
      path: 'docs/architecture.md',
      scope: 'module',
      relevance: 'architecture',
    });

    for (const ref of inspection.project_instructions) {
      expect(JSON.stringify(ref)).not.toMatch(/Regras fictícias|Documento fictício/);
    }
  });

  it('expõe source anchors por área sem ler conteúdo dos arquivos', async () => {
    const { repoPath } = await gitFixtureRepo();

    const inspection = await inspectRepository({ repoRoot: repoPath });

    expect(inspection.source_anchors).toContainEqual({ area: 'index.ts', path: 'src/index.ts' });
  });

  it('deriva estado de dependências, ferramentas e serviços requeridos como fatos', async () => {
    const { repoPath } = await gitFixtureRepo();

    const inspection = await inspectRepository({ repoRoot: repoPath });

    expect(inspection.dependencies_state).toEqual({
      known: true,
      value: { lockfile_path: 'package-lock.json', installed: false },
      provenance: 'fs:lockfile+node_modules',
    });

    const nodeEngineTool = inspection.required_tools.find((tool) => tool.name.startsWith('node'));
    expect(nodeEngineTool).toEqual({
      name: 'node >=20.0.0',
      reason: 'engines.node declarado',
      source: 'package.json:engines',
    });

    const serviceNames = inspection.required_services.map((service) => service.name).sort();
    expect(serviceNames).toEqual(['banco de dados relacional', 'redis']);
  });

  it('representa permissões de filesystem e feedback disponível', async () => {
    const { repoPath } = await gitFixtureRepo();

    const inspection = await inspectRepository({ repoRoot: repoPath });

    expect(inspection.filesystem_permissions).toEqual({
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs:access',
    });

    expect(inspection.feedback_sources).toContainEqual({
      path: '.github/workflows/ci.yml',
      kind: 'ci',
    });
  });

  it('fato indisponível vira null com motivo e proveniência, nunca valor inventado', async () => {
    const emptyRepo = await temporaryRoot();
    await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', emptyRepo], {
      env: GIT_ENV,
    });
    await git(emptyRepo, ['config', 'user.email', 'lab@example.com']);
    await git(emptyRepo, ['config', 'user.name', 'Lab']);
    await writeFile(path.join(emptyRepo, 'placeholder.txt'), 'x\n', 'utf8');
    await git(emptyRepo, ['add', '--all']);
    await git(emptyRepo, ['commit', '--quiet', '-m', 'vazio']);

    const inspection = await inspectRepository({ repoRoot: emptyRepo });

    expect(inspection.stack).toMatchObject({ known: false, value: null });
    expect(inspection.package_manager).toMatchObject({ known: false, value: null });
    expect(inspection.tests).toMatchObject({ known: false, value: null });
    if (!inspection.stack.known) {
      expect(inspection.stack.reason.length).toBeGreaterThan(0);
      expect(inspection.stack.provenance.length).toBeGreaterThan(0);
    }
  });

  it('nunca escreve no repositório-alvo', async () => {
    const { repoPath } = await gitFixtureRepo();
    const before = await snapshot(repoPath);

    await inspectRepository({ repoRoot: repoPath });

    const after = await snapshot(repoPath);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, mtime] of before) {
      expect(after.get(file)).toBe(mtime);
    }
  });

  it('não segue symlink que escapa de repoRoot (contenção via isInside + realpath)', async () => {
    const { repoPath } = await gitFixtureRepo();
    const outsideDir = await temporaryRoot();
    await mkdir(path.join(outsideDir, 'secret'), { recursive: true });
    await writeFile(
      path.join(outsideDir, 'secret', 'marker.txt'),
      'fora-do-repo\n',
      'utf8',
    );

    // Symlink dentro de src/ apontando para fora de repoRoot: não pode virar source anchor
    // nem ser atravessado, porque o alvo real do link está fora da fronteira do repo-alvo.
    const linkPath = path.join(repoPath, 'src', 'escape-link');
    await execFileAsync('ln', ['-s', path.join(outsideDir, 'secret'), linkPath]);

    const inspection = await inspectRepository({ repoRoot: repoPath });

    expect(inspection.source_anchors).not.toContainEqual({
      area: 'escape-link',
      path: 'src/escape-link',
    });
    expect(JSON.stringify(inspection)).not.toContain('fora-do-repo');
  });
});
