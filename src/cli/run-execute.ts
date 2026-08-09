/**
 * Execução do `agentlab run`: roda o adapter fake dentro do clone que M35A já
 * preparou, materializa `execution/` inteiro (prompt compilado, eventos
 * normalizados, stream do provider redigido e change bundle) e sela a seção.
 *
 * Fronteira: recebe o `PreparedRun` já pronto — nenhum clone, run dir ou
 * envelope nasce aqui. Indexação no SQLite e descarte do clone são M35C.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { JsonValue } from '../core/index.js';
import { runFakeAgent, type FakeAgentEvent } from '../adapters/index.js';
import type { ExecutionEnvelopeManifest } from '../envelope/index.js';
import type { ExecutionRecord } from '../schemas/index.js';
import { finalizeExecution, redactJsonValue, type SealedSection } from '../storage/index.js';
import { captureChangeBundle, type ChangeBundle } from '../workspace/index.js';
import type { PreparedRun } from './run-prepare.js';

export const EXECUTION_RECORD_FILE_NAME = 'execution-record.json';
export const EVENTS_FILE_NAME = 'events.jsonl';
export const PROVIDER_SANITIZED_FILE_NAME = 'provider-sanitized.jsonl';
export const PROMPT_DIR_NAME = 'prompt';
export const PROMPT_FILE_NAME = 'prompt.txt';
export const CHANGES_DIR_NAME = 'changes';

export interface ExecuteRunOptions {
  readonly prepared: PreparedRun;
  /** argv do adapter — ex. `[process.execPath, fakeAgentEntry, variant]`. */
  readonly argv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly gracePeriodMs?: number;
  readonly cleanupConfirmTimeoutMs?: number;
  readonly now?: Date;
}

export interface ExecutedRun {
  readonly record: ExecutionRecord;
  readonly changeBundle: ChangeBundle;
  readonly sealed: SealedSection;
}

/**
 * Roda o fake agent no clone já preparado, grava todo artifact de
 * `execution/` e sela a seção por último — falha em qualquer etapa anterior
 * propaga sem selar, então uma execução incompleta nunca aparenta selada.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<ExecutedRun> {
  const { prepared } = options;
  const { adapter: _adapter, ...manifestWithoutAdapter } = prepared.envelopeManifest;

  const agentRun = await runFakeAgent({
    argv: options.argv,
    cwd: prepared.clone.clonePath,
    ...(options.env === undefined ? {} : { env: options.env }),
    manifest: manifestWithoutAdapter,
    ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
    ...(options.cleanupConfirmTimeoutMs === undefined
      ? {}
      : { cleanupConfirmTimeoutMs: options.cleanupConfirmTimeoutMs }),
  });

  await writePrompt(prepared.executionDir, manifestWithoutAdapter);
  await writeEventStreams(prepared.executionDir, agentRun.events);
  await writeExecutionRecord(prepared.executionDir, agentRun.record);

  const changeBundle = await captureChangeBundle({
    clone: prepared.clone,
    outputDir: path.join(prepared.executionDir, CHANGES_DIR_NAME),
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const sealed = await finalizeExecution(prepared.runDir, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return { record: agentRun.record, changeBundle, sealed };
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
  events: readonly FakeAgentEvent[],
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
