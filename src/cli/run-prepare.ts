/**
 * Preparação do `agentlab run`: materializa em disco tudo que o run precisa
 * ANTES de o agente rodar — `ExecutionRequest` validado, run dir, clone
 * descartável e `execution-envelope.json` com o `execution_envelope_sha256`.
 *
 * Fronteira: nenhum spawn de agente acontece aqui. Isso pertence a M35B, que
 * recebe o clone e o run dir já prontos e só então executa.
 */
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  executionEnvelopeSha256,
  type AdapterIdentity,
  type ExecutionEnvelopeManifest,
} from '../envelope/index.js';
import { createRunDirectory, type RunDirectory } from '../storage/index.js';
import type { DataDirectoryConfig } from '../project/index.js';
import { ExecutionRequest, type Trial, type TaskBudgets } from '../schemas/index.js';
import {
  createDisposableClone,
  disposeClone,
  type DisposableClone,
} from '../workspace/index.js';

export const EXECUTION_ENVELOPE_FILE_NAME = 'execution-envelope.json';

export interface PrepareRunOptions {
  readonly trial: Trial;
  readonly baseSha: string;
  readonly budgets: TaskBudgets;
  readonly timeoutMs: number;
  /** Repo-alvo do clone descartável — só é lido. */
  readonly sourceRepo: string;
  readonly adapter: AdapterIdentity;
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly now?: Date;
  /** Diretório onde o clone é criado; default: `os.tmpdir()`. */
  readonly parentDir?: string;
}

export interface PreparedRun {
  readonly runId: string;
  readonly dataDir: string;
  readonly runDir: string;
  readonly executionDir: string;
  readonly envelopePath: string;
  readonly executionRequest: ExecutionRequest;
  readonly envelopeManifest: ExecutionEnvelopeManifest;
  readonly executionEnvelopeSha256: string;
  readonly clone: DisposableClone;
}

/**
 * Valida o `ExecutionRequest`, cria o run dir e o clone descartável, calcula
 * o `execution_envelope_sha256` e grava o envelope em
 * `execution/execution-envelope.json`.
 *
 * Qualquer falha depois que o run dir existe desfaz tudo que já foi criado —
 * run dir e clone, nessa ordem — antes de propagar o erro. Não existe
 * preparação parcial sobrevivendo ao erro.
 */
export async function prepareRun(options: PrepareRunOptions): Promise<PreparedRun> {
  const executionRequest = ExecutionRequest.parse({
    trial: options.trial,
    base_sha: options.baseSha,
    budgets: options.budgets,
    timeout_ms: options.timeoutMs,
  });

  const runDirectory = await createRunDirectory({
    ...(options.labRoot === undefined ? {} : { labRoot: options.labRoot }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  try {
    return await prepareInRunDirectory(options, executionRequest, runDirectory);
  } catch (error) {
    await rm(runDirectory.runDir, { recursive: true, force: true });
    throw error;
  }
}

async function prepareInRunDirectory(
  options: PrepareRunOptions,
  executionRequest: ExecutionRequest,
  runDirectory: RunDirectory,
): Promise<PreparedRun> {
  const clone = await createDisposableClone({
    sourceRepo: options.sourceRepo,
    baseSha: executionRequest.base_sha,
    ...(options.parentDir === undefined ? {} : { parentDir: options.parentDir }),
  });

  try {
    const envelopeManifest: ExecutionEnvelopeManifest = {
      task_spec: executionRequest.trial.task,
      strategy: executionRequest.trial.strategy,
      compiled_prompt: compilePrompt(executionRequest.trial),
      base_sha: executionRequest.base_sha,
      agent_profile: executionRequest.trial.agent,
      environment_profile: executionRequest.trial.environment,
      adapter: options.adapter,
      budgets: executionRequest.budgets,
      timeout_ms: executionRequest.timeout_ms,
    };
    const envelopeSha256 = executionEnvelopeSha256(envelopeManifest);
    const envelopePath = path.join(runDirectory.executionDir, EXECUTION_ENVELOPE_FILE_NAME);
    await writeFile(envelopePath, `${JSON.stringify(envelopeManifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });

    return {
      runId: runDirectory.runId,
      dataDir: runDirectory.dataDir,
      runDir: runDirectory.runDir,
      executionDir: runDirectory.executionDir,
      envelopePath,
      executionRequest,
      envelopeManifest,
      executionEnvelopeSha256: envelopeSha256,
      clone,
    };
  } catch (error) {
    await disposeClone(clone);
    throw error;
  }
}

/**
 * Composição determinística do prompt entregue ao agente: o prompt da
 * estratégia seguido da tarefa e dos critérios visíveis. Sem sintaxe de
 * template — nenhum contrato do lab define placeholders em `strategy.prompt`.
 */
function compilePrompt(trial: Trial): string {
  return [
    trial.strategy.prompt,
    '',
    `Tarefa: ${trial.task.description}`,
    '',
    'Critérios visíveis:',
    ...trial.task.visible_criteria.map((criterion) => `- ${criterion}`),
  ].join('\n');
}
