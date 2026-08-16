import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { executeRun, RUN_INDEX_FILE_NAME } from '../../src/cli/run-execute.js';
import { prepareRun } from '../../src/cli/run-prepare.js';
import { FAKE_ADAPTER_IDENTITY } from '../../src/adapters/index.js';
import { RunIndex, RunIndexSchemaVersionError } from '../../src/storage/index.js';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-run-index-test-'));
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
      id: 'fake-agent-profile',
      cli: 'fake',
      cli_version: '1.0.0',
      model: 'fake-model',
      flags: [],
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

async function preparedFakeRun(source: SourceRepo, labRoot: string) {
  return prepareRun({
    trial: trial(),
    baseSha: source.baseSha,
    budgets,
    timeoutMs: 60_000,
    sourceRepo: source.repoPath,
    adapter: FAKE_ADAPTER_IDENTITY,
    labRoot,
    parentDir: await temporaryRoot(),
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

describe('executeRun — indexação e descarte do clone', () => {
  it('indexa task, trial e run no SQLite após selar execution/', async () => {
    const labRoot = await temporaryRoot();
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source, labRoot);

    const executed = await executeRun({ prepared });

    const dbPath = path.join(prepared.dataDir, RUN_INDEX_FILE_NAME);
    const index = RunIndex.open(dbPath);
    try {
      expect(index.getTask('add-retry-policy')).toEqual({
        id: 'add-retry-policy',
        task_class: 'feature',
        difficulty: 'medium',
        description: 'Adicionar retentativas limitadas ao cliente HTTP.',
      });
      expect(index.getTrial('trial-add-retry')).toEqual({
        id: 'trial-add-retry',
        task_id: 'add-retry-policy',
        agent_id: 'fake-agent-profile',
        strategy_name: 'direct',
        status: 'EXECUTED',
      });
      const runRow = index.getRun(prepared.runId);
      expect(runRow).not.toBeNull();
      expect(runRow?.run_id).toBe(prepared.runId);
      expect(runRow?.trial_id).toBe('trial-add-retry');
      expect(runRow?.run_dir).toBe(prepared.runDir);
      expect(runRow?.status).toBe(executed.record.status);
    } finally {
      index.close();
    }
  });

  it('descarta o clone ao final de um run bem-sucedido', async () => {
    const labRoot = await temporaryRoot();
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source, labRoot);
    const clonePath = prepared.clone.clonePath;

    expect(await pathExists(clonePath)).toBe(true);

    await executeRun({ prepared });

    expect(await pathExists(clonePath)).toBe(false);
  });

  it('falha na indexação ainda assim descarta o clone', async () => {
    const labRoot = await temporaryRoot();
    const source = await sourceRepo();
    const prepared = await preparedFakeRun(source, labRoot);
    const clonePath = prepared.clone.clonePath;

    const dbPath = path.join(prepared.dataDir, RUN_INDEX_FILE_NAME);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const incompatible = RunIndex.open(dbPath);
    incompatible.close();
    // Simula um índice com schema incompatível: `RunIndex.open` recusa a
    // abrir em vez de migrar, exatamente o caminho de erro que a indexação
    // do run precisa sobreviver sem deixar o clone órfão.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec("UPDATE schema_meta SET value = '999' WHERE key = 'schema_version'");
    raw.close();

    await expect(
      executeRun({ prepared }),
    ).rejects.toThrow(RunIndexSchemaVersionError);

    expect(await pathExists(clonePath)).toBe(false);
  });
});
