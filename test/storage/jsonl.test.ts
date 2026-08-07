import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { appendJsonLine } from '../../src/storage/index.js';

const temporaryRoots: string[] = [];

async function temporaryFile(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-jsonl-'));
  temporaryRoots.push(root);
  return path.join(root, 'events.jsonl');
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('JSONL append', () => {
  it('preserva linhas íntegras em appends concorrentes', async () => {
    const filePath = await temporaryFile();
    const events = Array.from({ length: 100 }, (_, index) => ({ index, payload: `event-${index}` }));

    await Promise.all(events.map((event) => appendJsonLine(filePath, event)));

    const content = await readFile(filePath, 'utf8');
    const persisted = content.trimEnd().split('\n').map((line) => JSON.parse(line) as unknown);
    expect(persisted).toEqual(events);
  });

  it('escapa newline embutida e sempre termina o arquivo com newline', async () => {
    const filePath = await temporaryFile();
    const event = { message: 'primeira linha\nsegunda linha' };

    await appendJsonLine(filePath, event);

    const content = await readFile(filePath, 'utf8');
    expect(content).toBe(`${JSON.stringify(event)}\n`);
    expect(content.endsWith('\n')).toBe(true);
    expect(JSON.parse(content) as unknown).toEqual(event);
  });
});
