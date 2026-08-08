import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createRunDirectory,
  finalizeExecution,
  RunIndex,
  type RunDirectory,
  type RunRecord,
} from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-sqlite-rebuild-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function recordFor(run: RunDirectory): RunRecord {
  return {
    task: {
      id: 'task-1',
      task_class: 'bugfix',
      difficulty: 'medium',
      description: 'Corrige X',
    },
    trial: {
      id: 'trial-1',
      task_id: 'task-1',
      agent_id: 'agent-1',
      strategy_name: 'baseline',
      status: 'EXECUTED',
    },
    run: {
      run_id: run.runId,
      trial_id: 'trial-1',
      run_dir: run.runDir,
      created_at: run.metadata.created_at,
      status: 'COMPLETED',
    },
  };
}

/**
 * Cria um run sob `labRoot/data/runs`, sela `execution/` e indexa. `runsDir`
 * (o `data/runs` derivado do mesmo `labRoot`) é o que `RunIndex.rebuild` varre.
 */
async function indexedRun(
  dbPath: string,
  labRoot: string,
): Promise<{ run: RunDirectory; runsDir: string; index: RunIndex }> {
  const run = await createRunDirectory({ labRoot });
  await writeFile(path.join(run.executionDir, 'execution-record.json'), '{"status":"COMPLETED"}', 'utf8');
  await finalizeExecution(run.runDir);

  const index = RunIndex.open(dbPath);
  await index.indexRun(run.runDir, recordFor(run));
  return { run, runsDir: path.join(run.dataDir, 'runs'), index };
}

describe('RunIndex.rebuild', () => {
  it('apagar o db e reconstruir produz o mesmo conteúdo lógico', async () => {
    const labRoot = await temporaryRoot();
    const dbPath = path.join(labRoot, 'index.sqlite');

    const { run, runsDir, index: original } = await indexedRun(dbPath, labRoot);
    const before = {
      task: original.getTask('task-1'),
      trial: original.getTrial('trial-1'),
      run: original.getRun(run.runId),
    };
    original.close();

    await rm(dbPath, { force: true });

    const { index: rebuilt, report } = await RunIndex.rebuild(dbPath, runsDir);
    try {
      expect(report.runsScanned).toBe(1);
      expect(report.runsIndexed).toBe(1);
      expect(report.results[0]?.integrityOk).toBe(true);
      expect(report.results[0]?.violations).toEqual([]);

      expect(rebuilt.getTask('task-1')).toEqual(before.task);
      expect(rebuilt.getTrial('trial-1')).toEqual(before.trial);
      expect(rebuilt.getRun(run.runId)).toEqual(before.run);
    } finally {
      rebuilt.close();
    }
  });

  it('run com integridade quebrada é reportado no rebuild, não ignorado', async () => {
    const labRoot = await temporaryRoot();
    const dbPath = path.join(labRoot, 'index.sqlite');

    const { run, runsDir, index } = await indexedRun(dbPath, labRoot);
    index.close();

    // Corrompe a evidência selada depois de indexada: artifact trocado por outro conteúdo.
    await writeFile(
      path.join(run.executionDir, 'execution-record.json'),
      '{"status":"CRASHED"}',
      'utf8',
    );

    await rm(dbPath, { force: true });
    const { index: rebuilt, report } = await RunIndex.rebuild(dbPath, runsDir);
    try {
      expect(report.runsScanned).toBe(1);
      // A run continua indexada: o rebuild reporta a violação, não a descarta.
      expect(report.runsIndexed).toBe(1);
      expect(report.results[0]?.integrityOk).toBe(false);
      expect(report.results[0]?.violations.length).toBeGreaterThan(0);
      expect(rebuilt.getRun(run.runId)).not.toBeNull();
    } finally {
      rebuilt.close();
    }
  });

  it('rebuild é idempotente: rodar duas vezes seguidas produz o mesmo conteúdo', async () => {
    const labRoot = await temporaryRoot();
    const dbPath = path.join(labRoot, 'index.sqlite');

    const { run, runsDir, index } = await indexedRun(dbPath, labRoot);
    index.close();

    const { index: first } = await RunIndex.rebuild(dbPath, runsDir);
    const firstSnapshot = {
      task: first.getTask('task-1'),
      trial: first.getTrial('trial-1'),
      run: first.getRun(run.runId),
    };
    first.close();

    const { index: second, report } = await RunIndex.rebuild(dbPath, runsDir);
    try {
      expect(report.runsScanned).toBe(1);
      expect(report.runsIndexed).toBe(1);
      expect(second.getTask('task-1')).toEqual(firstSnapshot.task);
      expect(second.getTrial('trial-1')).toEqual(firstSnapshot.trial);
      expect(second.getRun(run.runId)).toEqual(firstSnapshot.run);
    } finally {
      second.close();
    }
  });

  it('run sem index-record.json é reportado como não indexado, sem derrubar o rebuild', async () => {
    const labRoot = await temporaryRoot();
    const dbPath = path.join(labRoot, 'index.sqlite');

    const bareRun = await createRunDirectory({ labRoot });
    await writeFile(path.join(bareRun.executionDir, 'execution-record.json'), '{"status":"COMPLETED"}', 'utf8');
    await finalizeExecution(bareRun.runDir);
    const runsDir = path.join(bareRun.dataDir, 'runs');

    const { index, report } = await RunIndex.rebuild(dbPath, runsDir);
    try {
      expect(report.runsScanned).toBe(1);
      expect(report.runsIndexed).toBe(0);
      expect(report.results[0]?.indexed).toBe(false);
      expect(report.results[0]?.detail).toContain('index-record.json');
      expect(index.getRun(bareRun.runId)).toBeNull();
    } finally {
      index.close();
    }
  });
});
