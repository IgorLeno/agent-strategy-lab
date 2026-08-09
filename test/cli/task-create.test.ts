import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runTaskCreate } from '../../src/cli/task-create.js';
import { runAgentlabCli } from './helpers.js';

const temporaryRoots: string[] = [];

async function temporaryLabRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-task-create-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function validCombinedInput(): Record<string, unknown> {
  return {
    id: 'add-retry-policy',
    description: 'Adicionar retentativas limitadas ao cliente HTTP.',
    visible_criteria: ['Retenta somente erros transitórios.'],
    task_class: 'feature',
    difficulty: 'medium',
    stack: ['typescript'],
    public_graders: ['typecheck'],
    budgets: {
      duration_ms: { expected: 120_000, maximum: 300_000 },
      tokens: { expected: 8_000, maximum: 20_000 },
      changed_files: { expected: 3, maximum: 6 },
    },
    hidden_graders: ['private-integration-tests'],
    rubric: { correctness: 'O retry preserva o erro da última tentativa.' },
    weights: { correctness: 1 },
  };
}

async function writeInputFile(root: string, content: unknown): Promise<string> {
  const inputPath = path.join(root, 'input.json');
  await writeFile(inputPath, JSON.stringify(content), 'utf8');
  return inputPath;
}

describe('runTaskCreate', () => {
  it('grava TaskSpec e EvaluationPlan em arquivos separados', async () => {
    const labRoot = await temporaryLabRoot();
    const inputPath = await writeInputFile(labRoot, validCombinedInput());

    const result = await runTaskCreate({ input: inputPath, labRoot });

    expect(result.taskSpecPath).not.toBe(result.evaluationPlanPath);

    const taskSpec = JSON.parse(await readFile(result.taskSpecPath, 'utf8')) as Record<string, unknown>;
    const evaluationPlan = JSON.parse(await readFile(result.evaluationPlanPath, 'utf8')) as Record<
      string,
      unknown
    >;

    expect(taskSpec['id']).toBe('add-retry-policy');
    expect(taskSpec).not.toHaveProperty('hidden_graders');
    expect(taskSpec).not.toHaveProperty('rubric');
    expect(taskSpec).not.toHaveProperty('weights');

    expect(evaluationPlan['hidden_graders']).toEqual(['private-integration-tests']);
    expect(evaluationPlan).not.toHaveProperty('description');
    expect(evaluationPlan).not.toHaveProperty('visible_criteria');
  });

  it('entrada inválida falha sem criar arquivo parcial', async () => {
    const labRoot = await temporaryLabRoot();
    const invalid = { ...validCombinedInput(), visible_criteria: [] };
    const inputPath = await writeInputFile(labRoot, invalid);

    await expect(runTaskCreate({ input: inputPath, labRoot })).rejects.toThrow();

    const dataDir = path.join(labRoot, 'data');
    const exists = await readdir(dataDir).catch(() => []);
    expect(exists).toEqual([]);
  });

  it('JSON malformado falha com mensagem acionável e sem criar arquivo', async () => {
    const labRoot = await temporaryLabRoot();
    const inputPath = path.join(labRoot, 'input.json');
    await writeFile(inputPath, '{ not valid json', 'utf8');

    await expect(runTaskCreate({ input: inputPath, labRoot })).rejects.toThrow(/JSON/);

    const dataDir = path.join(labRoot, 'data');
    const exists = await readdir(dataDir).catch(() => []);
    expect(exists).toEqual([]);
  });

  it('task já existente falha sem --force e não sobrescreve', async () => {
    const labRoot = await temporaryLabRoot();
    const inputPath = await writeInputFile(labRoot, validCombinedInput());

    await runTaskCreate({ input: inputPath, labRoot });

    await expect(runTaskCreate({ input: inputPath, labRoot })).rejects.toThrow(/já existe/);
  });

  it('com --force, sobrescreve task existente', async () => {
    const labRoot = await temporaryLabRoot();
    const inputPath = await writeInputFile(labRoot, validCombinedInput());

    await runTaskCreate({ input: inputPath, labRoot });

    const updated = { ...validCombinedInput(), description: 'Descrição atualizada.' };
    const updatedInputPath = await writeInputFile(labRoot, updated);
    const result = await runTaskCreate({ input: updatedInputPath, labRoot, force: true });

    const taskSpec = JSON.parse(await readFile(result.taskSpecPath, 'utf8')) as Record<string, unknown>;
    expect(taskSpec['description']).toBe('Descrição atualizada.');
  });
});

describe('agentlab task create (processo)', () => {
  it('smoke: cria os dois arquivos e sai com exit code 0', async () => {
    const labRoot = await temporaryLabRoot();
    const inputPath = await writeInputFile(labRoot, validCombinedInput());

    const result = await runAgentlabCli(['task', 'create', '--input', inputPath], {
      AGENTLAB_DATA_DIR: path.join(labRoot, 'data'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('task-spec.json');
    expect(result.stdout).toContain('evaluation-plan.json');
  });

  it('sem --input, falha com exit code 1 e mensagem acionável, sem prompt', async () => {
    const result = await runAgentlabCli(['task', 'create']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--input');
  });
});
