/**
 * Eventos normalizados: a interface interna que todo adapter fala com o resto
 * do lab, depois de traduzir a saída de uma CLI de provider (ou, no caso do
 * adapter fake, depois de simplesmente ler o que o fake agent já emite neste
 * formato).
 *
 * `result` é sempre o último evento de um run que chegou ao fim por conta
 * própria — `outcome` descreve o desfecho relatado pelo próprio agente, e é
 * distinto do exit code do processo e do `ExecutionStatus` do run.
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const metricValue = z.number().int().nonnegative().nullable();

export const AgentEvent = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('message'),
      role: z.enum(['assistant', 'user', 'system']),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_call'),
      name: nonEmpty,
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('tool_result'),
      name: nonEmpty,
      output: z.unknown(),
    })
    .strict(),
  z
    .object({
      type: z.literal('result'),
      outcome: z.enum(['success', 'failure']),
      tokens: metricValue,
      changed_files: metricValue,
    })
    .strict(),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/**
 * Interpreta cada linha não vazia de um stream NDJSON já na interface
 * interna. Lança em linha inválida — tolerância a stream malformado é escopo
 * do adapter fake `malformed-stream` (M26), não desta função geral.
 */
export function parseAgentEvents(ndjson: string): AgentEvent[] {
  return ndjson
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => AgentEvent.parse(JSON.parse(line)));
}
