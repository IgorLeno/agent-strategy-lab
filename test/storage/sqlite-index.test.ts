import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RunIndex,
  RunIndexSchemaVersionError,
  RUN_INDEX_SCHEMA_VERSION,
} from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

async function temporaryDbPath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-sqlite-index-'));
  temporaryRoots.push(root);
  return path.join(root, 'index.sqlite');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('RunIndex', () => {
  it('insere e consulta task, trial e run', async () => {
    const dbPath = await temporaryDbPath();
    const index = RunIndex.open(dbPath);

    try {
      index.insertTask({
        id: 'task-1',
        task_class: 'bugfix',
        difficulty: 'medium',
        description: 'Corrige X',
      });
      index.insertTrial({
        id: 'trial-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        strategy_name: 'baseline',
        status: 'PLANNED',
      });
      index.insertRun({
        run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        trial_id: 'trial-1',
        run_dir: '/data/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV',
        created_at: '2026-08-08T00:00:00.000Z',
        status: 'COMPLETED',
      });

      expect(index.getTask('task-1')).toEqual({
        id: 'task-1',
        task_class: 'bugfix',
        difficulty: 'medium',
        description: 'Corrige X',
      });
      expect(index.getTrial('trial-1')).toEqual({
        id: 'trial-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        strategy_name: 'baseline',
        status: 'PLANNED',
      });
      expect(index.getRun('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({
        run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        trial_id: 'trial-1',
        run_dir: '/data/runs/01ARZ3NDEKTSV4RRFFQ69G5FAV',
        created_at: '2026-08-08T00:00:00.000Z',
        status: 'COMPLETED',
      });

      expect(index.listTrialsForTask('task-1')).toHaveLength(1);
      expect(index.listRunsForTrial('trial-1')).toHaveLength(1);
    } finally {
      index.close();
    }
  });

  it('retorna null para ids inexistentes', async () => {
    const index = RunIndex.open(await temporaryDbPath());
    try {
      expect(index.getTask('missing')).toBeNull();
      expect(index.getTrial('missing')).toBeNull();
      expect(index.getRun('missing')).toBeNull();
    } finally {
      index.close();
    }
  });

  it('insert é idempotente: reindexar a mesma task/trial/run substitui em vez de duplicar', async () => {
    const dbPath = await temporaryDbPath();
    const index = RunIndex.open(dbPath);
    try {
      index.insertTask({ id: 'task-1', task_class: 'bugfix', difficulty: 'easy', description: 'A' });
      index.insertTask({ id: 'task-1', task_class: 'bugfix', difficulty: 'hard', description: 'B' });

      expect(index.getTask('task-1')?.difficulty).toBe('hard');
      expect(index.getTask('task-1')?.description).toBe('B');
    } finally {
      index.close();
    }
  });

  it('persiste entre aberturas: reabrir o mesmo arquivo enxerga os dados gravados', async () => {
    const dbPath = await temporaryDbPath();
    const first = RunIndex.open(dbPath);
    first.insertTask({ id: 'task-1', task_class: 'bugfix', difficulty: 'easy', description: 'A' });
    first.close();

    const second = RunIndex.open(dbPath);
    try {
      expect(second.getTask('task-1')).not.toBeNull();
    } finally {
      second.close();
    }
  });

  it('grava a própria versão do schema e a valida ao reabrir', async () => {
    const dbPath = await temporaryDbPath();
    const index = RunIndex.open(dbPath);
    index.close();

    // Reabrir com o schema atual funciona normalmente.
    const reopened = RunIndex.open(dbPath);
    reopened.close();

    expect(RUN_INDEX_SCHEMA_VERSION).toBe(1);
  });

  it('recusa abrir um índice com schema_version incompatível', async () => {
    const dbPath = await temporaryDbPath();
    const index = RunIndex.open(dbPath);
    index.close();

    // Simula um índice de uma versão futura, escrevendo diretamente via node:sqlite.
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE schema_meta SET value = ? WHERE key = ?').run('999', 'schema_version');
    raw.close();

    expect(() => RunIndex.open(dbPath)).toThrow(RunIndexSchemaVersionError);
  });
});
