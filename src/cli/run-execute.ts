/**
 * Execução do `agentlab run`: roda o adapter fake dentro do clone que M35A já
 * preparou, materializa `execution/` inteiro (prompt compilado, eventos
 * normalizados, stream do provider redigido e change bundle), sela a seção,
 * indexa o run no SQLite e descarta o clone efêmero.
 *
 * Fronteira: recebe o `PreparedRun` já pronto — nenhum clone, run dir ou
 * envelope nasce aqui. O clone é descartado assim que deixa de ser
 * necessário (logo após capturar o change bundle), em `finally`, para que
 * nenhuma falha depois disso — inclusive na indexação — deixe o clone órfão.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ParsedProviderLine, ProviderAdapter, ProviderEvent } from '../adapters/contract.js';
import { resolveAdapter } from '../adapters/index.js';
import type { RealExecutionAuthorization } from '../billing/index.js';
import type { JsonValue } from '../core/index.js';
import type { ExecutionEnvelopeManifest } from '../envelope/index.js';
import { executeWithAdapter } from '../runner/index.js';
import type { ExecutionRecord } from '../schemas/index.js';
import {
  finalizeExecution,
  redactJsonValue,
  RunIndex,
  type RunRecord,
  type SealedSection,
} from '../storage/index.js';
import { captureChangeBundle, disposeClone, type ChangeBundle } from '../workspace/index.js';
import type { PreparedRun } from './run-prepare.js';

export const RUN_INDEX_FILE_NAME = 'index.sqlite';

export const EXECUTION_RECORD_FILE_NAME = 'execution-record.json';
export const EVENTS_FILE_NAME = 'events.jsonl';
export const PROVIDER_SANITIZED_FILE_NAME = 'provider-sanitized.jsonl';
export const PROMPT_DIR_NAME = 'prompt';
export const PROMPT_FILE_NAME = 'prompt.txt';
export const CHANGES_DIR_NAME = 'changes';

/**
 * Prazo padrão entre o SIGTERM do timeout e o SIGKILL da escalada, preservado
 * aqui desde que `executeRun` delegava em `runFakeAgent` (M25/M26): nenhuma
 * CLI de produção resolveu um valor próprio ainda, então o default continua
 * o de um run rápido em vez do de 10s de `runner/capture.ts`.
 */
const DEFAULT_GRACE_PERIOD_MS = 200;

export interface ExecuteRunOptions {
  readonly prepared: PreparedRun;
  /**
   * Override do `ProviderAdapter` resolvido por `trial.agent.cli`. Produção
   * nunca passa isto — existe para testes que precisam de uma invocation que
   * nenhum adapter registrado produziria (ex.: stream contaminado de
   * propósito). Fora isso, `executeRun` sempre resolve pelo registry.
   */
  readonly adapter?: ProviderAdapter;
  readonly env?: NodeJS.ProcessEnv;
  /** HOME isolado repassado ao `buildInvocation` do adapter quando o `EnvironmentProfile` exige. */
  readonly sanitizedHome?: string;
  readonly gracePeriodMs?: number;
  readonly cleanupConfirmTimeoutMs?: number;
  /** Evidência obrigatória para adapter REAL_INFERENCE; fixtures não a consultam. */
  readonly realExecutionAuthorization?: RealExecutionAuthorization;
  readonly now?: Date;
}

export interface ExecutedRun {
  readonly record: ExecutionRecord;
  /**
   * Uma entrada por linha do stream, correlacionada por índice com os eventos
   * gravados em `events.jsonl` — a `ProviderObservation` de cada linha (usage,
   * cost, terminal) sobrevive aqui em vez de ser descartada depois que
   * `record.metrics` já extraiu dela o que é fato de execução.
   */
  readonly parsedLines: readonly ParsedProviderLine[];
  readonly changeBundle: ChangeBundle;
  readonly sealed: SealedSection;
}

/**
 * Resolve o `ProviderAdapter` do `trial.agent.cli`, monta a invocation dele e
 * roda através do runtime comum (`executeWithAdapter`) no clone já preparado
 * — grava todo artifact de `execution/` e sela a seção por último — falha em
 * qualquer etapa anterior propaga sem selar, então uma execução incompleta
 * nunca aparenta selada.
 *
 * `resolveAdapter → adapter.buildInvocation → executeWithAdapter` é a mesma
 * trajetória para fake, claude e codex: nenhum deles ganha um caminho
 * especial aqui.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<ExecutedRun> {
  const { prepared } = options;
  const { adapter: _adapter, ...manifestWithoutAdapter } = prepared.envelopeManifest;
  const now = options.now ?? new Date();
  const adapter = options.adapter ?? resolveAdapter(prepared.executionRequest.trial.agent.cli);
  const sourceEnv = options.env ?? process.env;
  const invocation = adapter.buildInvocation({
    manifest: manifestWithoutAdapter,
    cwd: prepared.clone.clonePath,
    sourceEnv,
    ...(options.sanitizedHome === undefined ? {} : { sanitizedHome: options.sanitizedHome }),
  });

  let record: ExecutionRecord;
  let parsedLines: readonly ParsedProviderLine[];
  let changeBundle: ChangeBundle;
  try {
    const agentRun = await executeWithAdapter(adapter, {
      argv: invocation.argv,
      cwd: prepared.clone.clonePath,
      ...(invocation.env === undefined ? {} : { env: invocation.env }),
      manifest: manifestWithoutAdapter,
      gracePeriodMs: options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS,
      ...(options.cleanupConfirmTimeoutMs === undefined
        ? {}
        : { cleanupConfirmTimeoutMs: options.cleanupConfirmTimeoutMs }),
      ...(options.realExecutionAuthorization === undefined
        ? {}
        : { realExecutionAuthorization: options.realExecutionAuthorization }),
    });
    record = agentRun.record;
    parsedLines = agentRun.parsedLines;

    await writePrompt(prepared.executionDir, manifestWithoutAdapter);
    await writeEventStreams(prepared.executionDir, agentRun.events);
    await writeExecutionRecord(prepared.executionDir, agentRun.record);

    changeBundle = await captureChangeBundle({
      clone: prepared.clone,
      outputDir: path.join(prepared.executionDir, CHANGES_DIR_NAME),
      now,
    });
  } finally {
    // O clone só serve para o adapter rodar e para o change bundle diffar
    // contra ele — nenhum dos dois precisa dele depois deste ponto. Descartar
    // aqui, em vez de no fim da função, garante que uma falha na selagem ou
    // na indexação (abaixo) não deixe o clone parado no disco.
    await disposeClone(prepared.clone);
  }

  const sealed = await finalizeExecution(prepared.runDir, { now });

  await indexExecutedRun(prepared, record, now);

  return { record, parsedLines, changeBundle, sealed };
}

/**
 * Indexa o run recém-selado no SQLite de `data/index.sqlite`. `trial.status`
 * vira `EXECUTED` aqui — a intenção experimental foi materializada — enquanto
 * `run.status` carrega o outcome da execução (`ExecutionRecord.status`), que é
 * um dado à parte.
 */
async function indexExecutedRun(
  prepared: PreparedRun,
  record: ExecutionRecord,
  now: Date,
): Promise<void> {
  const { trial } = prepared.executionRequest;
  const runRecord: RunRecord = {
    task: {
      id: trial.task.id,
      task_class: trial.task.task_class,
      difficulty: trial.task.difficulty,
      description: trial.task.description,
    },
    trial: {
      id: trial.id,
      task_id: trial.task.id,
      agent_id: trial.agent.id,
      strategy_name: trial.strategy.name,
      status: 'EXECUTED',
    },
    run: {
      run_id: prepared.runId,
      trial_id: trial.id,
      run_dir: prepared.runDir,
      created_at: now.toISOString(),
      status: record.status,
    },
  };

  const index = RunIndex.open(path.join(prepared.dataDir, RUN_INDEX_FILE_NAME));
  try {
    await index.indexRun(prepared.runDir, runRecord);
  } finally {
    index.close();
  }
}

async function writePrompt(
  executionDir: string,
  manifest: Omit<ExecutionEnvelopeManifest, 'adapter'>,
): Promise<void> {
  const promptDir = path.join(executionDir, PROMPT_DIR_NAME);
  await mkdir(promptDir);
  await writeFile(path.join(promptDir, PROMPT_FILE_NAME), manifest.compiled_prompt, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

/**
 * `events.jsonl` é a interface interna tal como o adapter devolveu.
 * `provider-sanitized.jsonl` é o mesmo stream depois de redaction estrutural
 * — a mesma proteção que o stream de um provider real exigiria, aplicada
 * aqui porque nenhuma seção sela sem já ter passado por ela. Os dois arquivos
 * são criados mesmo quando o agente não emite nenhum evento: a ausência de
 * eventos é uma medição, não a ausência do artifact.
 */
async function writeEventStreams(
  executionDir: string,
  events: readonly ProviderEvent[],
): Promise<void> {
  const eventsContent = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  const sanitizedContent = events
    .map((event) => `${JSON.stringify(redactJsonValue(event as unknown as JsonValue))}\n`)
    .join('');

  await writeFile(path.join(executionDir, EVENTS_FILE_NAME), eventsContent, {
    encoding: 'utf8',
    flag: 'wx',
  });
  await writeFile(path.join(executionDir, PROVIDER_SANITIZED_FILE_NAME), sanitizedContent, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

async function writeExecutionRecord(
  executionDir: string,
  record: ExecutionRecord,
): Promise<void> {
  const recordPath = path.join(executionDir, EXECUTION_RECORD_FILE_NAME);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}
