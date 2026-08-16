/**
 * Lógica do `agentlab run --experimental`: lê um arquivo de entrada com o
 * `ExecutionRequest` (mais `source_repo` e, opcionalmente, evidência de
 * billing guard) e materializa o run inteiro chamando `prepareRun` e
 * `executeRun` — os mesmos contratos de produto que qualquer outro caminho
 * de execução usa.
 *
 * Fronteira: nenhuma lógica de runner nasce aqui — resolver o adapter,
 * decidir authorization de billing e rodar o processo continuam
 * inteiramente em `runner/` e `billing/`. Este módulo só lê, valida e
 * encaminha. `--experimental` é obrigatório na CLI porque este comando pode
 * clonar, rodar o processo de um agente (fake ou real, conforme
 * `trial.agent.cli`) e gravar em `data/` — nada disso deve acontecer por
 * acidente.
 */
import { readFile } from 'node:fs/promises';
import { z, ZodError } from 'zod';

import { resolveAdapter } from '../adapters/index.js';
import type { RealExecutionAuthorization } from '../billing/index.js';
import type { DataDirectoryConfig } from '../project/index.js';
import { ExecutionRequest, Trial, TaskBudgets } from '../schemas/index.js';
import { executeRun, type ExecutedRun } from './run-execute.js';
import { prepareRun } from './run-prepare.js';

export interface RunExperimentalOptions {
  /** Caminho do arquivo JSON com `source_repo`, `trial`, `base_sha`, `budgets`, `timeout_ms`. */
  readonly input: string;
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Diretório onde o clone descartável é criado; default: `os.tmpdir()`. */
  readonly parentDir?: string;
}

export interface RunExperimentalResult {
  readonly runId: string;
  readonly runDir: string;
  readonly executed: ExecutedRun;
}

const evidence = <Value extends z.ZodTypeAny>(value: Value) =>
  z.object({ value: value.nullable(), provenance: z.string() }).strict();

/**
 * Espelha `RealExecutionAuthorization` (`billing/guard.ts`) só para validar
 * o que o arquivo de entrada declarou — a decisão em si continua
 * inteiramente em `decideExecutionAuthorization`, chamado de dentro de
 * `executeRun`.
 */
const RealExecutionAuthorizationInput: z.ZodType<RealExecutionAuthorization> = z
  .object({
    authorization: evidence(z.enum(['AUTHORIZED', 'DENIED'])),
    billing_mode: evidence(z.enum(['SUBSCRIPTION', 'API', 'NO_CHARGE'])),
    quota: z
      .object({
        availability: evidence(z.enum(['SUFFICIENT', 'INSUFFICIENT'])),
        remaining: evidence(z.number()),
        unit: z.string().nullable(),
      })
      .strict(),
    cost: z
      .object({
        api_equivalent_usd: evidence(z.number()),
        projected_incremental_charge_usd: evidence(z.number()),
        actual_incremental_charge_usd: evidence(z.number()),
        actual_incremental_charge_authoritative: z.boolean(),
      })
      .strict(),
    budget: z
      .object({
        maximum_incremental_charge_usd: evidence(z.number()),
      })
      .strict(),
  })
  .strict();

const RunExperimentalInput = z
  .object({
    source_repo: z.string().min(1),
    trial: Trial,
    base_sha: ExecutionRequest.shape.base_sha,
    budgets: TaskBudgets,
    timeout_ms: ExecutionRequest.shape.timeout_ms,
    real_execution_authorization: RealExecutionAuthorizationInput.optional(),
  })
  .strict();

/**
 * Prepara e executa um run experimental de ponta a ponta a partir de um
 * arquivo de entrada. Qualquer `BillingGuardBlockedError` de `executeRun`
 * (adapter REAL_INFERENCE sem evidência válida) propaga sem spawnar
 * processo — quem chama decide como reportar o bloqueio.
 */
export async function runExperimental(
  options: RunExperimentalOptions,
): Promise<RunExperimentalResult> {
  const raw = await readInputFile(options.input);
  const parsed = parseInput(raw);
  const adapter = resolveAdapter(parsed.trial.agent.cli);

  const prepared = await prepareRun({
    trial: parsed.trial,
    baseSha: parsed.base_sha,
    budgets: parsed.budgets,
    timeoutMs: parsed.timeout_ms,
    sourceRepo: parsed.source_repo,
    adapter: adapter.identity,
    ...(options.labRoot === undefined ? {} : { labRoot: options.labRoot }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.parentDir === undefined ? {} : { parentDir: options.parentDir }),
  });

  const executed = await executeRun({
    prepared,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(parsed.real_execution_authorization === undefined
      ? {}
      : { realExecutionAuthorization: parsed.real_execution_authorization }),
  });

  return { runId: prepared.runId, runDir: prepared.runDir, executed };
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

function parseInput(raw: string): z.infer<typeof RunExperimentalInput> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`entrada não é JSON válido: ${errorMessage(error)}`, { cause: error });
  }

  try {
    return RunExperimentalInput.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
        .join('; ');
      throw new Error(`entrada de run inválida: ${details}`, { cause: error });
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
