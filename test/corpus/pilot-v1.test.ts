import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { TaskSpec } from '../../src/schemas/index.js';

const corpusRoot = path.resolve('corpus/pilot-v1');
const expectedTaskIds = [
  'add-bounded-retry',
  'add-jsonl-summary-cli',
  'fix-stable-tag-normalization',
];
const privateEvaluationFields = ['hidden_graders', 'rubric', 'weights'];

async function taskDirectories(): Promise<string[]> {
  const entries = await readdir(corpusRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('corpus piloto v1', () => {
  it('contém exatamente as três tasks aprovadas', async () => {
    expect(await taskDirectories()).toEqual(expectedTaskIds);

    const entries = await readdir(corpusRoot, { recursive: true });
    expect(entries.filter((entry) => path.basename(entry) === 'task-spec.json')).toHaveLength(3);
  });

  it('mantém TaskSpecs públicos válidos e workspaces reproduzíveis', async () => {
    for (const taskId of await taskDirectories()) {
      const taskRoot = path.join(corpusRoot, taskId);
      const raw = JSON.parse(await readFile(path.join(taskRoot, 'task-spec.json'), 'utf8')) as unknown;
      const taskSpec = TaskSpec.parse(raw);

      expect(taskSpec.id).toBe(taskId);
      expect(taskSpec.taxonomy?.verification).toBe('deterministic');
      expect(taskSpec.taxonomy?.ambiguity).toBe('low');
      expect(await readFile(path.join(taskRoot, 'workspace', 'public-tests.mjs'), 'utf8')).not.toBe('');

      for (const field of privateEvaluationFields) {
        expect(raw).not.toHaveProperty(field);
      }
    }
  });

  it('não versiona EvaluationPlan privado dentro do corpus', async () => {
    for (const taskId of await taskDirectories()) {
      const entries = await readdir(path.join(corpusRoot, taskId), { recursive: true });
      expect(entries.some((entry) => path.basename(entry) === 'evaluation-plan.json')).toBe(false);
    }
  });
});
