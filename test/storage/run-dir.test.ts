import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveDataDir } from '../../src/project/index.js';
import { createRunDirectory, generateRunId } from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-run-dir-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('run directory', () => {
  it('cria a estrutura inicial com metadata e ULID ordenável', async () => {
    const labRoot = await temporaryRoot();
    const firstTimestamp = Date.UTC(2026, 7, 7, 12, 0, 0);
    const secondTimestamp = firstTimestamp + 1;

    const firstId = generateRunId(firstTimestamp);
    const secondId = generateRunId(secondTimestamp);
    expect(firstId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(firstId < secondId).toBe(true);

    const createdAt = new Date(firstTimestamp);
    const created = await createRunDirectory({ labRoot, runId: firstId, now: createdAt });

    expect(created.runDir).toBe(path.join(labRoot, 'data', 'runs', firstId));
    await expect(stat(created.executionDir)).resolves.toMatchObject({});
    await expect(readFile(created.metadataPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(
        { schema_version: 1, run_id: firstId, created_at: createdAt.toISOString() },
        null,
        2,
      )}\n`,
    );
  });

  it('prioriza AGENTLAB_DATA_DIR sobre config e default', async () => {
    const labRoot = await temporaryRoot();
    const envDataDir = path.join(labRoot, 'env-data');

    expect(
      resolveDataDir({
        labRoot,
        config: { data_dir: 'configured-data' },
        env: { AGENTLAB_DATA_DIR: envDataDir },
      }),
    ).toBe(envDataDir);

    const created = await createRunDirectory({
      labRoot,
      config: { data_dir: 'configured-data' },
      env: { AGENTLAB_DATA_DIR: envDataDir },
    });
    expect(created.runDir.startsWith(path.join(envDataDir, 'runs'))).toBe(true);
  });

  it('falha sem alterar um run existente', async () => {
    const labRoot = await temporaryRoot();
    const runId = generateRunId();
    const first = await createRunDirectory({ labRoot, runId });
    const originalMetadata = await readFile(first.metadataPath, 'utf8');

    await expect(createRunDirectory({ labRoot, runId })).rejects.toThrow(
      `run directory já existe: ${runId}`,
    );
    await expect(readFile(first.metadataPath, 'utf8')).resolves.toBe(originalMetadata);
  });
});
