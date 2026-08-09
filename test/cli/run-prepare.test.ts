import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { executionEnvelopeSha256, type ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import { EXECUTION_ENVELOPE_FILE_NAME, prepareRun } from '../../src/cli/run-prepare.js';
import { CLONE_DIRECTORY_PREFIX, disposeClone } from '../../src/workspace/index.js';
import type { Trial } from '../../src/schemas/index.js';

const execFileAsync = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
};

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-run-prepare-test-'));
  temporaryRoots.push(root);
  return root;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, env: GIT_ENV });
  return stdout;
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

const budgets = {
  duration_ms: { expected: 120_000, maximum: 300_000 },
  tokens: { expected: 8_000, maximum: 20_000 },
  changed_files: { expected: 3, maximum: 6 },
};

function trial(): Trial {
  return {
    id: 'trial-add-retry',
    task: {
      id: 'add-retry-policy',
      description: 'Adicionar retentativas limitadas ao cliente HTTP.',
      visible_criteria: ['Retenta somente erros transitórios.'],
      task_class: 'feature',
      difficulty: 'medium',
      stack: ['typescript'],
      public_graders: ['typecheck'],
      budgets,
    },
    agent: {
      id: 'codex-gpt-5-6-sol',
      cli: 'codex',
      cli_version: '0.31.0',
      model: 'gpt-5.6-sol',
      flags: ['--ephemeral'],
    },
    strategy: {
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    },
    environment: {
      id: 'controlled-clean-room',
      mode: 'controlled',
      env_allowlist: ['PATH', 'LANG'],
      home: 'sanitized',
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    status: 'PLANNED',
  };
}

const adapter = { name: 'fake', version: '1.0.0' };

async function listClones(parentDir: string): Promise<string[]> {
  const entries = await readdir(parentDir).catch(() => []);
  return entries.filter((entry) => entry.startsWith(CLONE_DIRECTORY_PREFIX));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('prepareRun', () => {
  it('materializa clone, run dir e envelope sem executar o agente', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const clonesParentDir = await temporaryRoot();

    const prepared = await prepareRun({
      trial: trial(),
      baseSha: source.baseSha,
      budgets,
      timeoutMs: 300_000,
      sourceRepo: source.repoPath,
      adapter,
      labRoot,
      parentDir: clonesParentDir,
    });

    try {
      expect(prepared.executionRequest.base_sha).toBe(source.baseSha);
      expect(prepared.clone.baseSha).toBe(source.baseSha);
      expect(await readFile(path.join(prepared.clone.clonePath, 'README.md'), 'utf8')).toBe('base\n');

      const runsDir = path.join(labRoot, 'data', 'runs');
      expect(await readdir(runsDir)).toEqual([prepared.runId]);
      expect(prepared.envelopePath).toBe(
        path.join(prepared.executionDir, EXECUTION_ENVELOPE_FILE_NAME),
      );

      const writtenEnvelope = JSON.parse(await readFile(prepared.envelopePath, 'utf8')) as unknown;
      expect(writtenEnvelope).toEqual(prepared.envelopeManifest);

      // O clone segue vivo — a preparação não roda nem descarta nada do agente.
      expect(await listClones(clonesParentDir)).toHaveLength(1);
    } finally {
      await disposeClone(prepared.clone);
    }
  });

  it('envelope gravado bate com o recalculado a partir dos componentes', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const clonesParentDir = await temporaryRoot();

    const prepared = await prepareRun({
      trial: trial(),
      baseSha: source.baseSha,
      budgets,
      timeoutMs: 300_000,
      sourceRepo: source.repoPath,
      adapter,
      labRoot,
      parentDir: clonesParentDir,
    });

    try {
      const writtenEnvelope = JSON.parse(
        await readFile(prepared.envelopePath, 'utf8'),
      ) as ExecutionEnvelopeManifest;
      const recalculated = executionEnvelopeSha256(writtenEnvelope);

      expect(recalculated).toBe(prepared.executionEnvelopeSha256);
      expect(prepared.executionEnvelopeSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await disposeClone(prepared.clone);
    }
  });

  it('falha de preparação limpa o run dir e o clone que criou', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const clonesParentDir = await temporaryRoot();
    const bogusBaseSha = 'f'.repeat(40);

    await expect(
      prepareRun({
        trial: trial(),
        baseSha: bogusBaseSha,
        budgets,
        timeoutMs: 300_000,
        sourceRepo: source.repoPath,
        adapter,
        labRoot,
        parentDir: clonesParentDir,
      }),
    ).rejects.toThrow();

    const runsDir = path.join(labRoot, 'data', 'runs');
    expect(await readdir(runsDir).catch(() => [])).toEqual([]);
    expect(await listClones(clonesParentDir)).toEqual([]);
  });

  it('run id repetido falha sem deixar clone órfão', async () => {
    const source = await sourceRepo();
    const labRoot = await temporaryRoot();
    const clonesParentDir = await temporaryRoot();
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    const first = await prepareRun({
      trial: trial(),
      baseSha: source.baseSha,
      budgets,
      timeoutMs: 300_000,
      sourceRepo: source.repoPath,
      adapter,
      labRoot,
      parentDir: clonesParentDir,
      runId,
    });

    try {
      await expect(
        prepareRun({
          trial: trial(),
          baseSha: source.baseSha,
          budgets,
          timeoutMs: 300_000,
          sourceRepo: source.repoPath,
          adapter,
          labRoot,
          parentDir: clonesParentDir,
          runId,
        }),
      ).rejects.toThrow(/já existe/);

      // O primeiro run continua intacto; só a segunda tentativa não deixou clone.
      expect(await listClones(clonesParentDir)).toHaveLength(1);
    } finally {
      await disposeClone(first.clone);
    }
  });
});
