import { z } from 'zod';

import { PlannedTask, TaskRisk } from './task.js';

const nonEmpty = z.string().trim().min(1);

/**
 * Sinais estruturais avaliados por `evaluateDecomposition`. Cada sinal mede
 * ruptura de coerência, delimitação ou verificabilidade da task — nunca
 * duração absoluta. Um novo sinal deve nomear o campo de `PlannedTask` que o
 * dispara, não um limiar de tempo (ver nota nos limiares abaixo).
 */
export const DecompositionSignalId = z.enum([
  'context_scope_too_broad',
  'cross_cutting_complexity',
  'high_ambiguity',
  'non_deterministic_verification',
  'excessive_dependencies',
  'wide_blast_radius_expected',
  'wide_blast_radius_maximum',
  'excessive_context_pressure',
  'excessive_validation_surface',
  'retry_not_isolated',
  'unbounded_rollback_boundary',
]);
export type DecompositionSignalId = z.infer<typeof DecompositionSignalId>;

/**
 * Onde, dentro do `PlannedTask`, o sinal foi observado, e o valor exato que
 * disparou o gatilho — a "provenance" exigida no veredito. Um sinal sem
 * `field`/`observed` rastreável não é aceito pelo schema.
 */
export const SignalProvenance = z
  .object({
    field: nonEmpty,
    observed: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
    threshold: z.union([z.string(), z.number()]),
  })
  .strict();
export type SignalProvenance = z.infer<typeof SignalProvenance>;

export const TriggeredSignal = z
  .object({
    signal: DecompositionSignalId,
    reason: nonEmpty,
    provenance: SignalProvenance,
  })
  .strict();
export type TriggeredSignal = z.infer<typeof TriggeredSignal>;

/**
 * Veredito de decomposição. `ATOMIC` significa que a task, como declarada,
 * permanece uma Atomic Validatable Change. `DECOMPOSITION_REQUIRED` sempre
 * nomeia ao menos um sinal disparado — nunca é emitido "porque sim".
 *
 * Fragmentação de plano por excesso de granularidade (`MERGE_RECOMMENDED`) é
 * responsabilidade do validador de plano (M75), não deste avaliador de task
 * isolada.
 */
export const DecompositionVerdict = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('ATOMIC') }).strict(),
  z
    .object({
      outcome: z.literal('DECOMPOSITION_REQUIRED'),
      signals: z.array(TriggeredSignal).min(1),
    })
    .strict(),
]);
export type DecompositionVerdict = z.infer<typeof DecompositionVerdict>;

/**
 * Limiares estruturais — sobre BREADTH (áreas de contexto, dependências,
 * superfície de arquivos, pressão de tokens, superfície de validação) e
 * sobre RISCO combinado com delimitação de rollback/retry. Nenhum limiar
 * aqui é de duração: `estimated_duration`, `resource_envelope.duration_ms` e
 * `validation[].timeout_seconds` são deliberadamente ignorados por este
 * avaliador. Duração é um sinal entre outros no domínio do problema, mas
 * está fora do escopo desta implementação — uma task coerente e verificável
 * isoladamente pode ter budget de tempo arbitrariamente grande sem disparar
 * decomposição, e uma task curta ainda pode ser decomposta pelos sinais
 * abaixo.
 */
const MAX_CONTEXT_AREAS = 3;
const MAX_BLOCKED_BY = 2;
const MAX_EXPECTED_CHANGED_FILES = 15;
const MAX_MAXIMUM_CHANGED_FILES = 30;
const MAX_EXPECTED_TOKENS = 150_000;
const MAX_VALIDATION_COMMANDS = 5;
const ROLLBACK_SENSITIVE_RISK: ReadonlySet<TaskRisk> = new Set(['high', 'critical']);

function pushIf(
  signals: TriggeredSignal[],
  condition: boolean,
  signal: DecompositionSignalId,
  reason: string,
  provenance: SignalProvenance,
): void {
  if (condition) {
    signals.push({ signal, reason, provenance });
  }
}

/**
 * Avalia, de forma pura e determinística, se `task` deixou de ser uma
 * mudança atômica e validável (Atomic Validatable Change) e precisa ser
 * decomposta. Sem I/O, sem spawn de processo, sem chamada a provider — só
 * leitura dos campos já declarados em `task`. Mesma entrada produz sempre o
 * mesmo veredito.
 *
 * Ausência de sinal nunca é tratada como evidência de segurança: um campo
 * opcional de `taxonomy` não preenchido, ou uma lista vazia, simplesmente
 * não contribui para o veredito — não é interpretado como "baixo risco".
 */
export function evaluateDecomposition(task: PlannedTask): DecompositionVerdict {
  const signals: TriggeredSignal[] = [];

  pushIf(
    signals,
    task.context_scope.areas.length > MAX_CONTEXT_AREAS,
    'context_scope_too_broad',
    `context_scope.areas tem ${task.context_scope.areas.length} áreas, acima do limite de ${MAX_CONTEXT_AREAS} para uma mudança com fronteira de contexto delimitada`,
    {
      field: 'context_scope.areas',
      observed: task.context_scope.areas,
      threshold: MAX_CONTEXT_AREAS,
    },
  );

  pushIf(
    signals,
    task.taxonomy.complexity === 'cross_cutting',
    'cross_cutting_complexity',
    'taxonomy.complexity é cross_cutting: a task atravessa múltiplos subsistemas, não uma responsabilidade única',
    {
      field: 'taxonomy.complexity',
      observed: task.taxonomy.complexity ?? 'undefined',
      threshold: 'cross_cutting',
    },
  );

  pushIf(
    signals,
    task.taxonomy.ambiguity === 'high',
    'high_ambiguity',
    'taxonomy.ambiguity é high: o objetivo não está delimitado o suficiente para execução isolada',
    {
      field: 'taxonomy.ambiguity',
      observed: task.taxonomy.ambiguity ?? 'undefined',
      threshold: 'high',
    },
  );

  pushIf(
    signals,
    task.taxonomy.verification === 'subjective',
    'non_deterministic_verification',
    'taxonomy.verification é subjective: PASS/FAIL não pode ser determinado objetivamente de forma isolada',
    {
      field: 'taxonomy.verification',
      observed: task.taxonomy.verification ?? 'undefined',
      threshold: 'subjective',
    },
  );

  pushIf(
    signals,
    task.blocked_by.length > MAX_BLOCKED_BY,
    'excessive_dependencies',
    `blocked_by tem ${task.blocked_by.length} dependências, acima do limite de ${MAX_BLOCKED_BY} para uma fronteira de rollback isolada`,
    {
      field: 'blocked_by',
      observed: task.blocked_by,
      threshold: MAX_BLOCKED_BY,
    },
  );

  pushIf(
    signals,
    task.resource_envelope.changed_files.expected > MAX_EXPECTED_CHANGED_FILES,
    'wide_blast_radius_expected',
    `resource_envelope.changed_files.expected é ${task.resource_envelope.changed_files.expected}, acima do limite de ${MAX_EXPECTED_CHANGED_FILES}`,
    {
      field: 'resource_envelope.changed_files.expected',
      observed: task.resource_envelope.changed_files.expected,
      threshold: MAX_EXPECTED_CHANGED_FILES,
    },
  );

  pushIf(
    signals,
    task.resource_envelope.changed_files.maximum > MAX_MAXIMUM_CHANGED_FILES,
    'wide_blast_radius_maximum',
    `resource_envelope.changed_files.maximum é ${task.resource_envelope.changed_files.maximum}, acima do limite de ${MAX_MAXIMUM_CHANGED_FILES}`,
    {
      field: 'resource_envelope.changed_files.maximum',
      observed: task.resource_envelope.changed_files.maximum,
      threshold: MAX_MAXIMUM_CHANGED_FILES,
    },
  );

  pushIf(
    signals,
    task.resource_envelope.tokens.expected > MAX_EXPECTED_TOKENS,
    'excessive_context_pressure',
    `resource_envelope.tokens.expected é ${task.resource_envelope.tokens.expected}, acima do limite de ${MAX_EXPECTED_TOKENS}`,
    {
      field: 'resource_envelope.tokens.expected',
      observed: task.resource_envelope.tokens.expected,
      threshold: MAX_EXPECTED_TOKENS,
    },
  );

  pushIf(
    signals,
    task.validation.length > MAX_VALIDATION_COMMANDS,
    'excessive_validation_surface',
    `validation tem ${task.validation.length} comandos, acima do limite de ${MAX_VALIDATION_COMMANDS} para uma mudança com um único objetivo verificável`,
    {
      field: 'validation',
      observed: task.validation.length,
      threshold: MAX_VALIDATION_COMMANDS,
    },
  );

  pushIf(
    signals,
    task.risk === 'critical' && task.blocked_by.length > 0,
    'retry_not_isolated',
    'risk é critical e blocked_by não está vazio: um retry desta task não pode ser isolado das tasks das quais ela depende',
    {
      field: 'risk,blocked_by',
      observed: `${task.risk}/${task.blocked_by.length}`,
      threshold: 'critical + blocked_by > 0',
    },
  );

  pushIf(
    signals,
    ROLLBACK_SENSITIVE_RISK.has(task.risk) &&
      task.resource_envelope.changed_files.maximum > MAX_MAXIMUM_CHANGED_FILES,
    'unbounded_rollback_boundary',
    `risk é ${task.risk} e resource_envelope.changed_files.maximum (${task.resource_envelope.changed_files.maximum}) excede ${MAX_MAXIMUM_CHANGED_FILES}: a fronteira de rollback não está delimitada para esse nível de risco`,
    {
      field: 'risk,resource_envelope.changed_files.maximum',
      observed: `${task.risk}/${task.resource_envelope.changed_files.maximum}`,
      threshold: `high|critical + changed_files.maximum > ${MAX_MAXIMUM_CHANGED_FILES}`,
    },
  );

  if (signals.length === 0) {
    return { outcome: 'ATOMIC' };
  }
  return { outcome: 'DECOMPOSITION_REQUIRED', signals };
}
