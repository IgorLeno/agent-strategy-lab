import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GitError,
  commitAll,
  currentBranch,
  diffSince,
  git,
  headSha,
  isClean,
  planSlug,
  prepareWorkspace,
} from '../../src/git/git.js';

const PLAN_REL = '.asl/plan.md';
let root: string;
let repo: string;

async function makeRepo(): Promise<string> {
  const dir = path.join(root, 'repo');
  await mkdir(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'teste@example.com']);
  await git(dir, ['config', 'user.name', 'Teste']);
  await writeFile(path.join(dir, 'README.md'), 'oi\n');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'inicial']);
  return dir;
}

async function writePlan(dir: string, text = '# Plano: X\n- [ ] 1 passo\n'): Promise<void> {
  await mkdir(path.join(dir, '.asl'), { recursive: true });
  await writeFile(path.join(dir, PLAN_REL), text);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'asl-git-'));
  repo = await makeRepo();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('git do loop', () => {
  it('slug de branch é estável e sem acento', () => {
    expect(planSlug('Exportação de Relatório!')).toBe('exportacao-de-relatorio');
    expect(planSlug('***')).toBe('plano');
  });

  it('modo branch: plano não commitado é tolerado, vai para asl/<slug> e vira o primeiro commit', async () => {
    await writePlan(repo);
    const workspace = await prepareWorkspace({ repo, mode: 'branch', slug: 'x', planRelPath: PLAN_REL });
    expect(workspace.dir).toBe(repo);
    expect(await currentBranch(repo)).toBe('asl/x');
    expect(workspace.baseSha).toBe(await headSha(repo));
    expect(await isClean(repo)).toBe(true);
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('asl: plano x');
    expect((await git(repo, ['log', 'main', '--format=%s'])).trim()).toBe('inicial');
  });

  it('recusa árvore suja fora do plano', async () => {
    await writePlan(repo);
    await writeFile(path.join(repo, 'README.md'), 'mudou\n');
    await expect(prepareWorkspace({ repo, mode: 'branch', slug: 'x', planRelPath: PLAN_REL })).rejects.toThrow(
      GitError,
    );
  });

  it('retomar no modo branch reaproveita a branch e a base registrada', async () => {
    await writePlan(repo);
    const first = await prepareWorkspace({ repo, mode: 'branch', slug: 'x', planRelPath: PLAN_REL });
    await git(repo, ['switch', '-q', 'main']);
    const again = await prepareWorkspace({
      repo,
      mode: 'branch',
      slug: 'x',
      planRelPath: PLAN_REL,
      knownBaseSha: first.baseSha,
    });
    expect(await currentBranch(repo)).toBe('asl/x');
    expect(again.baseSha).toBe(first.baseSha);
  });

  it('modo direct commita o plano na branch atual', async () => {
    await writePlan(repo);
    const workspace = await prepareWorkspace({ repo, mode: 'direct', slug: 'x', planRelPath: PLAN_REL });
    expect(workspace.branch).toBe('main');
    expect((await git(repo, ['log', '-1', '--format=%s'])).trim()).toBe('asl: plano x');
  });

  it('modo worktree: plano copiado e commitado na worktree; repositório principal intocado', async () => {
    await writePlan(repo);
    const workspace = await prepareWorkspace({ repo, mode: 'worktree', slug: 'x', planRelPath: PLAN_REL });
    expect(workspace.dir).toBe(path.join(root, 'repo-asl-x'));
    expect(workspace.planPath).toBe(path.join(workspace.dir, PLAN_REL));
    expect(await readFile(workspace.planPath, 'utf8')).toContain('1 passo');
    expect(await currentBranch(repo)).toBe('main');
    expect(await currentBranch(workspace.dir)).toBe('asl/x');
    expect(await isClean(workspace.dir)).toBe(true);
    const again = await prepareWorkspace({ repo, mode: 'worktree', slug: 'x', planRelPath: PLAN_REL });
    expect(again.dir).toBe(workspace.dir);
  });

  it('commitAll devolve null sem mudança e sha com mudança', async () => {
    expect(await commitAll(repo, 'nada')).toBeNull();
    await writeFile(path.join(repo, 'novo.txt'), 'x\n');
    const sha = await commitAll(repo, '1: passo');
    expect(sha).toBe(await headSha(repo));
    expect(await isClean(repo)).toBe(true);
  });

  it('diffSince inclui arquivo novo, exclui o plano e devolve o índice ao HEAD', async () => {
    await writePlan(repo);
    const workspace = await prepareWorkspace({ repo, mode: 'branch', slug: 'x', planRelPath: PLAN_REL });
    await writeFile(path.join(repo, 'novo.txt'), 'conteúdo novo\n');
    await writePlan(repo, '# Plano: X\n- [x] 1 passo\n');
    const diff = await diffSince(repo, workspace.baseSha, [PLAN_REL]);
    expect(diff.patch).toContain('conteúdo novo');
    expect(diff.patch).not.toContain('plan.md');
    expect(diff.stat).toContain('novo.txt');
    expect((await git(repo, ['diff', '--cached', '--name-only'])).trim()).toBe('');
  });
});
