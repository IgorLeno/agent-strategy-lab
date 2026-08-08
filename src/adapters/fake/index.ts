/**
 * Adapter fake: roda `fixtures/fake-agent/` e traduz o resultado para
 * `ExecutionRecord` — sem depender de nenhum formato de provider real, porque
 * o fake agent já fala a interface interna (eventos normalizados) por conta
 * própria. Existe para exercitar o runner e o resto do pipeline sem custo de
 * API.
 *
 * Lê o stdout bruto do processo (`startProcess`), não o `stdout.log` de
 * `captureProcess`: a redaction de `runner/capture.ts` existe para o stream de
 * um provider real, onde texto arbitrário do agente pode conter segredo, e
 * redige por nome de chave — inclusive `tokens`, que aqui não é segredo, é a
 * métrica. `events.jsonl` é a interface interna já tipada pelo adapter, e não
 * atravessa essa redaction textual.
 *
 * Variante success (M25): o processo termina com exit code 0 e um evento
 * `result` de outcome `success` vira `ExecutionRecord` `COMPLETED`. Demais
 * variantes (failure, timeout, malformed-stream, child-process-leak) são
 * M26.
 */
import type { Readable } from 'node:stream';

import { ExecutionStatus } from '../../core/enums.js';
import {
  executionEnvelopeSha256,
  type ExecutionEnvelopeManifest,
} from '../../envelope/index.js';
import type { ExecutionRecord } from '../../schemas/index.js';
import { startProcess, type SpawnProcessOptions } from '../../runner/index.js';
import { AgentEvent, parseAgentEvents } from '../events.js';

/** Identidade deste adapter — entra no envelope de execução, nunca inventada por quem chama. */
export const FAKE_ADAPTER_IDENTITY = { name: 'fake', version: '1.0.0' } as const;

export interface RunFakeAgentOptions extends SpawnProcessOptions {
  /** Tudo que compõe o envelope de execução, exceto o adapter — este módulo é quem o preenche. */
  readonly manifest: Omit<ExecutionEnvelopeManifest, 'adapter'>;
}

export interface FakeAgentRun {
  readonly record: ExecutionRecord;
  readonly events: AgentEvent[];
}

/** Provenance registrada nas métricas lidas do evento `result` do fake agent. */
const FAKE_AGENT_PROVENANCE = 'fake_agent';

/**
 * Executa o fake agent até o fim e devolve `ExecutionRecord` + os eventos
 * normalizados que ele emitiu.
 *
 * `COMPLETED` exige as duas coisas: o processo saiu com exit code 0 *e* o
 * último evento é um `result` de outcome `success`. Um exit 0 sem esse evento
 * não é evidência de execução completa — é só um processo que voltou.
 */
export async function runFakeAgent(options: RunFakeAgentOptions): Promise<FakeAgentRun> {
  const manifest: ExecutionEnvelopeManifest = {
    ...options.manifest,
    adapter: FAKE_ADAPTER_IDENTITY,
  };
  const envelopeSha256 = executionEnvelopeSha256(manifest);

  const startedAt = Date.now();
  const started = await startProcess({
    argv: options.argv,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const [stdout, , outcome] = await Promise.all([
    readAll(started.stdout),
    readAll(started.stderr),
    started.result,
  ]);
  const durationMs = Date.now() - startedAt;

  const events = parseAgentEvents(stdout);
  const result = events.at(-1);
  const succeeded =
    outcome.exitCode === 0 &&
    result !== undefined &&
    result.type === 'result' &&
    result.outcome === 'success';

  const record: ExecutionRecord = {
    status: succeeded ? ExecutionStatus.COMPLETED : ExecutionStatus.CRASHED,
    exit_code: outcome.exitCode,
    duration_ms: durationMs,
    execution_envelope_sha256: envelopeSha256,
    metrics: {
      tokens: {
        value: result?.type === 'result' ? result.tokens : null,
        provenance: FAKE_AGENT_PROVENANCE,
      },
      changed_files: {
        value: result?.type === 'result' ? result.changed_files : null,
        provenance: FAKE_AGENT_PROVENANCE,
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
