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
 * `result` vira `ExecutionRecord` `COMPLETED` — de outcome `success` ou
 * `failure`, os dois igualmente completos: `outcome` é o desfecho relatado
 * pelo agente, não a dimensão de execução (M26).
 *
 * Timeout (M26) reusa a mesma escalada de sinal e a mesma confirmação de
 * cleanup do runner do produto (`scheduleTimeoutEscalation`,
 * `confirmCleanup`) — não uma versão própria: o fake adapter lê stdout bruto
 * em vez de usar `captureProcess`, mas o comportamento de timeout é o mesmo
 * módulo, não uma reimplementação. `confirmCleanup` rejeitando com
 * `ProcessGroupSurvivorError` (descendente que escapou do process group,
 * variante child-process-leak) propaga como rejeição desta função, do mesmo
 * jeito que `ProcessSpawnError` propaga — mapear para `INFRA_ERROR` é
 * trabalho de quem chama, não deste módulo.
 *
 * Malformed-stream (M26): uma linha de stdout que não é a interface interna
 * não pode ser fatal ao run — só o `result` final materializa o
 * `ExecutionRecord`, e o resto do stream de um provider real também nunca é
 * garantidamente bem formado. A linha vira um evento `unknown` com o texto
 * bruto sanitizado (mesma redação de segredo do `runner/capture.ts`, porque
 * aqui o texto NÃO é a interface interna já tipada — é texto arbitrário que
 * falhou o parse, exatamente o caso para o qual aquela redação existe).
 */
import type { Readable } from 'node:stream';

import { ExecutionStatus } from '../../core/enums.js';
import {
  executionEnvelopeSha256,
  type ExecutionEnvelopeManifest,
} from '../../envelope/index.js';
import type { ExecutionRecord } from '../../schemas/index.js';
import {
  scheduleTimeoutEscalation,
  startProcess,
  type SpawnProcessOptions,
} from '../../runner/index.js';
import { redactString } from '../../storage/index.js';
import { AgentEvent } from '../events.js';

/** Identidade deste adapter — entra no envelope de execução, nunca inventada por quem chama. */
export const FAKE_ADAPTER_IDENTITY = { name: 'fake', version: '1.0.0' } as const;

/**
 * Prazo padrão entre o SIGTERM do timeout e o SIGKILL da escalada. Menor que
 * o default de produção (`runner/capture.ts`, 10s): o fake adapter existe
 * para testes rápidos, e um teste de timeout não deveria esperar 10s pela
 * escalada para confirmar o que já sabe.
 */
const DEFAULT_GRACE_PERIOD_MS = 200;

export interface RunFakeAgentOptions extends SpawnProcessOptions {
  /** Tudo que compõe o envelope de execução, exceto o adapter — este módulo é quem o preenche. */
  readonly manifest: Omit<ExecutionEnvelopeManifest, 'adapter'>;
  /** Prazo entre o SIGTERM do timeout e o SIGKILL da escalada. Default: 200ms. */
  readonly gracePeriodMs?: number;
  /** Teto de `confirmCleanup` depois do kill do group. Default: o de `runner/process-group.ts`. */
  readonly cleanupConfirmTimeoutMs?: number;
}

/** Linha de stdout que não corresponde à interface interna — preservada, não descartada. */
export interface UnknownAgentEvent {
  readonly type: 'unknown';
  /** Texto bruto da linha, sanitizado da mesma forma que `runner/capture.ts` redige stdout. */
  readonly raw: string;
}

export type FakeAgentEvent = AgentEvent | UnknownAgentEvent;

export interface FakeAgentRun {
  readonly record: ExecutionRecord;
  readonly events: FakeAgentEvent[];
}

/** Provenance registrada nas métricas lidas do evento `result` do fake agent. */
const FAKE_AGENT_PROVENANCE = 'fake_agent';

/**
 * Executa o fake agent até o fim e devolve `ExecutionRecord` + os eventos
 * normalizados que ele emitiu.
 *
 * `TIMED_OUT` tem precedência sobre qualquer outra leitura do stream: se o
 * timeout venceu, o que o processo chegou a emitir antes do sinal não muda a
 * dimensão de execução. Sem timeout, `COMPLETED` exige as duas coisas: o
 * processo saiu com exit code 0 *e* o último evento é um `result` — de
 * outcome `success` ou `failure`, os dois igualmente completos. Um exit 0
 * sem esse evento, ou qualquer exit code diferente de 0, não é evidência de
 * execução completa — vira `CRASHED`.
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
  const escalation = scheduleTimeoutEscalation(
    started.child,
    started.pgid,
    options.manifest.timeout_ms,
    options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS,
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
  const events = parseAgentEventsLenient(stdout);
  const result = events.at(-1);
  const succeeded = !timedOut && outcome.exitCode === 0 && result?.type === 'result';

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

/**
 * Interpreta cada linha não vazia de stdout como a interface interna —
 * tolerante ao contrário de `events.ts#parseAgentEvents`: uma linha que não é
 * JSON, ou que não casa com nenhuma variante de `AgentEvent`, não derruba o
 * run. Ela vira um evento `unknown` com o texto bruto sanitizado, e o parse
 * segue para a próxima linha.
 */
function parseAgentEventsLenient(ndjson: string): FakeAgentEvent[] {
  return ndjson
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line): FakeAgentEvent => {
      const parsed = AgentEvent.safeParse(safeJsonParse(line));
      return parsed.success ? parsed.data : { type: 'unknown', raw: redactString(line) };
    });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
