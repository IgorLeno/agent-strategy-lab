/**
 * Runtime comum de execução de um `ProviderAdapter` (M51B): spawn, timeout,
 * cleanup de process group e montagem do `ExecutionRecord` autoritativo vivem
 * aqui — uma vez só — e não em cada adapter.
 *
 * `ExecutionRecord` mistura duas origens deliberadamente separadas na
 * montagem: fatos OBJETIVOS do processo (`exit_code`, `duration_ms`, e o
 * `status` derivado de timeout/exit/último evento) vêm inteiramente deste
 * runtime, que é o único que observa o processo; a leitura de métricas
 * (`tokens`, `changed_files`) vem do último evento `result` que o
 * `parseLine` do adapter devolveu, com a provenance que o próprio adapter
 * declara (`metricsProvenance`, default `identity.name`) — o runtime nunca
 * inventa de onde um número saiu.
 *
 * Mesma leitura de stdout, mesma escalada de sinal e mesma confirmação de
 * cleanup que `adapters/fake/index.ts#runFakeAgent` usava antes desta tarefa
 * — `runFakeAgent` agora delega para cá em vez de replicar a lógica.
 */
import type { Readable } from 'node:stream';

import type { ProviderAdapter, ProviderEvent } from '../adapters/contract.js';
import { ExecutionStatus } from '../core/enums.js';
import { executionEnvelopeSha256, type ExecutionEnvelopeManifest } from '../envelope/index.js';
import type { ExecutionRecord } from '../schemas/index.js';
import { scheduleTimeoutEscalation } from './timeout.js';
import { startProcess, type SpawnProcessOptions } from './spawn.js';

export interface ExecuteWithAdapterOptions extends SpawnProcessOptions {
  /** Tudo que compõe o envelope de execução, exceto o adapter — este runtime é quem o preenche. */
  readonly manifest: Omit<ExecutionEnvelopeManifest, 'adapter'>;
  /** Prazo entre o SIGTERM do timeout e o SIGKILL da escalada. Sem default aqui: quem chama decide. */
  readonly gracePeriodMs: number;
  /** Teto de `confirmCleanup` depois do kill do group. Default: o de `runner/process-group.ts`. */
  readonly cleanupConfirmTimeoutMs?: number;
}

export interface AdapterExecutionRun {
  readonly record: ExecutionRecord;
  readonly events: ProviderEvent[];
}

/**
 * Executa `adapter` até o fim e devolve o `ExecutionRecord` autoritativo mais
 * os eventos normalizados que o stream produziu.
 *
 * `TIMED_OUT` tem precedência sobre qualquer outra leitura do stream: se o
 * timeout venceu, o que o processo chegou a emitir antes do sinal não muda a
 * dimensão de execução. Sem timeout, `COMPLETED` exige as duas coisas: o
 * processo saiu com exit code 0 *e* o último evento é um `result` — de
 * outcome `success` ou `failure`, os dois igualmente completos. Um exit 0
 * sem esse evento, ou qualquer exit code diferente de 0, não é evidência de
 * execução completa — vira `CRASHED`.
 */
export async function executeWithAdapter(
  adapter: ProviderAdapter,
  options: ExecuteWithAdapterOptions,
): Promise<AdapterExecutionRun> {
  const manifest: ExecutionEnvelopeManifest = { ...options.manifest, adapter: adapter.identity };
  const envelopeSha256 = executionEnvelopeSha256(manifest);

  const startedAt = Date.now();
  const started = await startProcess({
    argv: options.argv,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const escalation = scheduleTimeoutEscalation(
    started.child,
    started.pgid,
    options.manifest.timeout_ms,
    options.gracePeriodMs,
    options.cleanupConfirmTimeoutMs,
  );
  const [stdout, , outcome] = await Promise.all([
    readAll(started.stdout),
    readAll(started.stderr),
    started.result,
  ]);
  const durationMs = Date.now() - startedAt;

  // Depois do desfecho do alvo, nunca antes — ver `runner/capture.ts`. Rejeita
  // com `ProcessGroupSurvivorError` quando um descendente sobrevive fora do
  // process group; propaga para quem chama, do mesmo jeito que
  // `ProcessSpawnError` propaga.
  await escalation.confirmCleanup();

  const timedOut = escalation.timedOut();
  const events = parseProviderLines(adapter, stdout);
  const result = events.at(-1);
  const succeeded = !timedOut && outcome.exitCode === 0 && result?.type === 'result';
  const provenance = adapter.metricsProvenance ?? adapter.identity.name;

  const record: ExecutionRecord = {
    status: timedOut
      ? ExecutionStatus.TIMED_OUT
      : succeeded
        ? ExecutionStatus.COMPLETED
        : ExecutionStatus.CRASHED,
    exit_code: outcome.exitCode,
    duration_ms: durationMs,
    execution_envelope_sha256: envelopeSha256,
    metrics: {
      tokens: {
        value: result?.type === 'result' ? result.tokens : null,
        provenance,
      },
      changed_files: {
        value: result?.type === 'result' ? result.changed_files : null,
        provenance,
      },
    },
  };

  return { record, events };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Interpreta cada linha não vazia de stdout pelo `parseLine` do adapter — nunca por conta própria. */
function parseProviderLines(adapter: ProviderAdapter, ndjson: string): ProviderEvent[] {
  return ndjson
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => adapter.parseLine(line).event);
}
