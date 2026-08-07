import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { StrategyDef } from '../../src/schemas/index.js';
import { loadStrategy } from '../../src/strategies/index.js';

const temporaryRoots: string[] = [];

async function temporaryStrategy(source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-strategy-'));
  temporaryRoots.push(root);
  const directory = path.join(root, 'strategies', 'direct', '1');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'strategy.yaml'), source, 'utf8');
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe('StrategyDef', () => {
  it('loads and validates the versioned direct@1 recipe', async () => {
    const strategy = await loadStrategy(process.cwd(), 'direct', 1);

    expect(strategy).toEqual({
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    });
  });

  it('parses a valid single-prompt strategy', () => {
    const input: StrategyDef = {
      name: 'review_then_fix',
      version: 2,
      prompt: 'Revise a tarefa e implemente a correção solicitada.',
    };

    expect(StrategyDef.parse(input)).toEqual(input);
  });

  it.each([
    { name: 'invalid name', version: 1, prompt: 'Faça a tarefa.' },
    { name: 'direct', version: 0, prompt: 'Faça a tarefa.' },
    { name: 'direct', version: 1, prompt: '   ' },
    { name: 'direct', version: 1, prompt: 'Faça a tarefa.', steps: [] },
  ])('rejects an invalid declarative recipe', (input) => {
    expect(StrategyDef.safeParse(input).success).toBe(false);
  });

  it('rejects a recipe whose declared identity differs from its path', async () => {
    const root = await temporaryStrategy('name: other\nversion: 1\nprompt: Faça a tarefa.\n');

    await expect(loadStrategy(root, 'direct', 1)).rejects.toThrow(
      /declara other@1, esperado direct@1/,
    );
  });
});
