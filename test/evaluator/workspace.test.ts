import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createEvaluatorWorkspace,
  withEvaluatorWorkspace,
  EVALUATION_PLAN_FILE_NAME,
} from '../../src/evaluator/index.js';
import {
  captureChangeBundle,
  createDisposableClone,
  disposeClone,
  type DisposableClone,
} from '../../src/workspace/index.js';
import type { EvaluationPlan } from '../../src/schemas/index.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-evaluator-workspace-test-'));
  temporaryRoots.push(root);
  return root;
}

interface SourceRepo {
  readonly repoPath: string;
  readonly baseSha: string;
}

async function sourceRepo(): Promise<SourceRepo> {
  const repoPath = path.join(await temporaryRoot(), 'target');
  await mkdir(repoPath, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', '--initial-branch=main', repoPath], {
    env: GIT_ENV,
  });
  await git(repoPath, ['config', 'user.email', 'lab@example.com']);
  await git(repoPath, ['config', 'user.name', 'Lab']);
  await writeFile(path.join(repoPath, 'README.md'), 'base\n', 'utf8');
  await git(repoPath, ['add', '--', 'README.md']);
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

/** `changes.patch` de um workspace de agente com trabalho nele. */
async function agentPatch(source: SourceRepo): Promise<string> {
  const agentClone = await cloneOf(source);
  await writeFile(path.join(agentClone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');
  await writeFile(path.join(agentClone.clonePath, 'novo.txt'), 'arquivo novo\n', 'utf8');
  const captured = await captureChangeBundle({ clone: agentClone, outputDir: await outputDir() });
  return captured.patchPath;
}

const evaluationPlan: EvaluationPlan = {
  hidden_graders: ['grader-principal'],
  rubric: { 'grader-principal': 'passa quando o objetivo do task foi cumprido' },
  weights: { 'grader-principal': 1 },
};

async function exists(target: string): Promise<boolean> {
  try {
    await readFile(target);
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

describe('workspace do evaluator', () => {
  it('reaplica o changes.patch sobre o mesmo base SHA e reproduz a árvore avaliada', async () => {
    const source = await sourceRepo();
    const patchPath = await agentPatch(source);

    const workspace = await createEvaluatorWorkspace({
      sourceRepo: source.repoPath,
      baseSha: source.baseSha,
      parentDir: await temporaryRoot(),
      patchPath,
      evaluationPlan,
    });
    try {
      expect(await readFile(path.join(workspace.clone.clonePath, 'README.md'), 'utf8')).toBe(
        'base\nlinha do agente\n',
      );
      expect(await readFile(path.join(workspace.clone.clonePath, 'novo.txt'), 'utf8')).toBe(
        'arquivo novo\n',
      );
    } finally {
      await disposeClone(workspace.clone);
    }
  });

  it('grava o EvaluationPlan só dentro de .git/ do clone do evaluator, nunca na working tree', async () => {
    const source = await sourceRepo();
    const patchPath = await agentPatch(source);

    await withEvaluatorWorkspace(
      {
        sourceRepo: source.repoPath,
        baseSha: source.baseSha,
        parentDir: await temporaryRoot(),
        patchPath,
        evaluationPlan,
      },
      async (workspace) => {
        expect(workspace.evaluationPlanPath).toBe(
          path.join(workspace.clone.gitDir, EVALUATION_PLAN_FILE_NAME),
        );
        expect(JSON.parse(await readFile(workspace.evaluationPlanPath, 'utf8'))).toEqual(
          evaluationPlan,
        );

        // Só o material do patch aparece na working tree — o plano, não.
        const status = (await git(workspace.clone.clonePath, ['status', '--porcelain'])).trim();
        expect(status.split('\n').sort()).toEqual(['?? novo.txt', 'M README.md']);
        expect(
          await exists(path.join(workspace.clone.clonePath, EVALUATION_PLAN_FILE_NAME)),
        ).toBe(false);
      },
    );
  });

  it('nunca escreve o EvaluationPlan no workspace do agente', async () => {
    const source = await sourceRepo();
    const agentClone = await cloneOf(source);
    await writeFile(path.join(agentClone.clonePath, 'README.md'), 'base\nlinha do agente\n', 'utf8');
    const captured = await captureChangeBundle({ clone: agentClone, outputDir: await outputDir() });

    await withEvaluatorWorkspace(
      {
        sourceRepo: source.repoPath,
        baseSha: source.baseSha,
        parentDir: await temporaryRoot(),
        patchPath: captured.patchPath,
        evaluationPlan,
      },
      async () => undefined,
    );

    expect(await exists(path.join(agentClone.clonePath, EVALUATION_PLAN_FILE_NAME))).toBe(false);
    expect(
      await exists(path.join(agentClone.gitDir, EVALUATION_PLAN_FILE_NAME)),
    ).toBe(false);
  });

  it('descarta o workspace do evaluator quando o run termina bem', async () => {
    const source = await sourceRepo();
    const patchPath = await agentPatch(source);
    let clonePath = '';

    await withEvaluatorWorkspace(
      {
        sourceRepo: source.repoPath,
        baseSha: source.baseSha,
        parentDir: await temporaryRoot(),
        patchPath,
        evaluationPlan,
      },
      async (workspace) => {
        clonePath = workspace.clone.clonePath;
      },
    );

    expect(clonePath).not.toBe('');
    expect(await exists(path.join(clonePath, 'README.md'))).toBe(false);
  });

  it('descarta o workspace do evaluator quando o run falha, e preserva o erro', async () => {
    const source = await sourceRepo();
    const patchPath = await agentPatch(source);
    let clonePath = '';

    await expect(
      withEvaluatorWorkspace(
        {
          sourceRepo: source.repoPath,
          baseSha: source.baseSha,
          parentDir: await temporaryRoot(),
          patchPath,
          evaluationPlan,
        },
        async (workspace) => {
          clonePath = workspace.clone.clonePath;
          throw new Error('grader explodiu');
        },
      ),
    ).rejects.toThrow('grader explodiu');

    expect(clonePath).not.toBe('');
    expect(await exists(path.join(clonePath, 'README.md'))).toBe(false);
  });

  it('descarta o clone quando o patch não aplica sobre o base SHA', async () => {
    const source = await sourceRepo();
    const badPatchPath = path.join(await temporaryRoot(), 'changes.patch');
    await writeFile(badPatchPath, 'isto não é um patch válido\n', 'utf8');
    const parentDir = await temporaryRoot();

    await expect(
      createEvaluatorWorkspace({
        sourceRepo: source.repoPath,
        baseSha: source.baseSha,
        parentDir,
        patchPath: badPatchPath,
        evaluationPlan,
      }),
    ).rejects.toThrow();

    expect(await readdir(parentDir)).toEqual([]);
  });
});
