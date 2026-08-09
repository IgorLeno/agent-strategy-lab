/**
 * Lógica do `agentlab task create`: lê um arquivo de entrada não interativo
 * e grava TaskSpec (público) e EvaluationPlan (privado) em arquivos
 * SEPARADOS. Nunca escreve os dois contratos no mesmo arquivo — é assim que
 * critério oculto vaza para o workspace do agente.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ZodError } from 'zod';

import { EvaluationPlan, TaskSpec } from '../schemas/index.js';
import { resolveDataDir, type DataDirectoryConfig } from '../project/index.js';

export interface RunTaskCreateOptions {
  /** Caminho do arquivo JSON com os campos combinados de task e avaliação. */
  readonly input: string;
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Sobrescreve task existente com mesmo id; sem isso, falha se já existir. */
  readonly force?: boolean;
}

export interface TaskCreateResult {
  readonly taskId: string;
  readonly taskSpecPath: string;
  readonly evaluationPlanPath: string;
}

const EVALUATION_PLAN_KEYS = ['hidden_graders', 'rubric', 'weights'] as const;

export async function runTaskCreate(options: RunTaskCreateOptions): Promise<TaskCreateResult> {
  const raw = await readInputFile(options.input);
  const parsed = parseInput(raw);

  const taskSpec = parseSchema(TaskSpec, parsed.taskFields, 'task');
  const evaluationPlan = parseSchema(EvaluationPlan, parsed.evaluationFields, 'evaluation');

  const dataDir = resolveDataDir({
    ...(options.labRoot === undefined ? {} : { labRoot: options.labRoot }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const taskDir = path.join(dataDir, 'tasks', taskSpec.id);
  const taskSpecPath = path.join(taskDir, 'task-spec.json');
  const evaluationPlanPath = path.join(taskDir, 'evaluation-plan.json');

  await mkdir(path.dirname(taskDir), { recursive: true });

  const force = options.force ?? false;
  try {
    await mkdir(taskDir, { recursive: force });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`task já existe: ${taskSpec.id} (use --force para sobrescrever)`, { cause: error });
    }
    throw error;
  }

  try {
    const writeFlag = force ? 'w' : 'wx';
    await writeFile(taskSpecPath, `${JSON.stringify(taskSpec, null, 2)}\n`, { encoding: 'utf8', flag: writeFlag });
    await writeFile(evaluationPlanPath, `${JSON.stringify(evaluationPlan, null, 2)}\n`, {
      encoding: 'utf8',
      flag: writeFlag,
    });
  } catch (error) {
    await rm(taskDir, { recursive: true, force: true });
    throw error;
  }

  return { taskId: taskSpec.id, taskSpecPath, evaluationPlanPath };
}

async function readInputFile(inputPath: string): Promise<string> {
  try {
    return await readFile(inputPath, 'utf8');
  } catch (error) {
    throw new Error(`não foi possível ler o arquivo de entrada (${inputPath}): ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function parseInput(raw: string): {
  taskFields: Record<string, unknown>;
  evaluationFields: Record<string, unknown>;
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`entrada não é JSON válido: ${errorMessage(error)}`, { cause: error });
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('entrada deve ser um objeto JSON com os campos de task e avaliação');
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const taskFields: Record<string, unknown> = {};
  const evaluationFields: Record<string, unknown> = {};

  for (const [key, fieldValue] of entries) {
    if ((EVALUATION_PLAN_KEYS as readonly string[]).includes(key)) {
      evaluationFields[key] = fieldValue;
    } else {
      taskFields[key] = fieldValue;
    }
  }

  return { taskFields, evaluationFields };
}

function parseSchema<T>(schema: { parse: (value: unknown) => T }, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`entrada de ${label} inválida: ${details}`, { cause: error });
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
