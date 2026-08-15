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
 *
 * `runFakeAgent` (M51B): não roda mais o processo por conta própria — delega
 * inteiro para `executeWithAdapter` (`runner/execute.ts`), o runtime comum
 * que qualquer `ProviderAdapter` compartilha. Esta função sobrevive como uma
 * conveniência de teste com o shape antigo (`FakeAgentRun`), não como uma
 * segunda implementação de spawn/timeout/cleanup/montagem de record.
 */
import path from 'node:path';

import type { ExecutionRecord } from '../../schemas/index.js';
import { executeWithAdapter, type ExecuteWithAdapterOptions } from '../../runner/index.js';
import { redactString } from '../../storage/index.js';
import type {
  AdapterInvocation,
  BuildInvocationOptions,
  ParsedProviderLine,
  ProviderAdapter,
  UnknownProviderEvent,
} from '../contract.js';
import { AgentEvent } from '../events.js';

/** Identidade deste adapter — entra no envelope de execução, nunca inventada por quem chama. */
export const FAKE_ADAPTER_IDENTITY = { name: 'fake', version: '1.0.0' } as const;

/**
 * Provenance registrada nas métricas lidas do evento `result` do fake agent —
 * distinta de `identity.name` ('fake') porque descreve especificamente a
 * origem da leitura (o fake agent), não o adapter que a interpretou.
 */
const FAKE_AGENT_PROVENANCE = 'fake_agent';

/**
 * Prazo padrão entre o SIGTERM do timeout e o SIGKILL da escalada. Menor que
 * o default de produção (`runner/capture.ts`, 10s): o fake adapter existe
 * para testes rápidos, e um teste de timeout não deveria esperar 10s pela
 * escalada para confirmar o que já sabe.
 */
const DEFAULT_GRACE_PERIOD_MS = 200;

export interface RunFakeAgentOptions extends Omit<ExecuteWithAdapterOptions, 'gracePeriodMs'> {
  /** Prazo entre o SIGTERM do timeout e o SIGKILL da escalada. Default: 200ms. */
  readonly gracePeriodMs?: number;
}

/** Linha de stdout que não corresponde à interface interna — preservada, não descartada. */
export type UnknownAgentEvent = UnknownProviderEvent;

export type FakeAgentEvent = AgentEvent | UnknownAgentEvent;

export interface FakeAgentRun {
  readonly record: ExecutionRecord;
  readonly events: FakeAgentEvent[];
  readonly parsedLines: ParsedProviderLine[];
}

/**
 * Executa o fake agent até o fim e devolve `ExecutionRecord` + os eventos
 * normalizados que ele emitiu.
 *
 * Conveniência de teste sobre `executeWithAdapter(fakeAdapter, options)`
 * (M51B): o shape (`FakeAgentRun`, default de `gracePeriodMs`) é o que os
 * testes de M25/M26 já esperavam, mas spawn, timeout, cleanup e a montagem
 * do `ExecutionRecord` são inteiramente do runtime comum — nada disso é
 * reimplementado aqui.
 */
export async function runFakeAgent(options: RunFakeAgentOptions): Promise<FakeAgentRun> {
  const run = await executeWithAdapter(fakeAdapter, {
    ...options,
    gracePeriodMs: options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS,
  });
  return run;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Caminho do fake agent relativo à raiz do repo — o que `buildInvocation` do fake adapter aponta. */
const FAKE_AGENT_ENTRY = path.join('fixtures', 'fake-agent', 'index.mjs');

/**
 * Forma `ProviderAdapter` do fake adapter: identidade, `buildInvocation` e o parser de linha —
 * a mesma forma que os adapters reais (claude, codex) vão seguir. `runFakeAgent` roda este
 * objeto através de `executeWithAdapter` (M51B); `resolveAdapter('fake')` devolve o mesmo
 * objeto para quem quiser chamar `executeWithAdapter` diretamente.
 */
export const fakeAdapter: ProviderAdapter = {
  identity: FAKE_ADAPTER_IDENTITY,
  executionKind: 'FIXTURE',
  metricsProvenance: FAKE_AGENT_PROVENANCE,
  buildInvocation(options: BuildInvocationOptions): AdapterInvocation {
    return {
      argv: [process.execPath, path.join(options.cwd, FAKE_AGENT_ENTRY)],
      stdin: options.manifest.compiled_prompt,
    };
  },
  parseLine(raw: string): ParsedProviderLine {
    const parsed = AgentEvent.safeParse(safeJsonParse(raw));
    if (!parsed.success) {
      return { event: { type: 'unknown', raw: redactString(raw) } };
    }
    const observation: ParsedProviderLine['observation'] =
      parsed.data.type === 'result'
        ? { usage: { tokens: parsed.data.tokens }, terminal: parsed.data.outcome }
        : undefined;
    return observation === undefined
      ? { event: parsed.data }
      : { event: parsed.data, observation };
  },
};
