import { z } from 'zod';

import { PlannedTask, TaskRisk } from './task.js';

const nonEmpty = z.string().trim().min(1);

/**
 * Vocabulário histórico de sinais estruturais. Nem todo membro é EMITIDO: a
 * policy de autonomia (control the boundaries, not the implementation)
 * reserva `DECOMPOSITION_REQUIRED` para o que excede uma fronteira segura de
 * execução/rollback, e complexidade ordinária de engenharia — escopo amplo,
 * ambiguidade alta, verificação subjetiva, muitas dependências, muitos
 * arquivos, muitos tokens, muitos comandos de validação — deixou de ser hard
 * block. Esses sinais continuam no enum por compatibilidade de records
 * históricos e alimentam assessment/routing/effort, não a recusa do plano.
 * `EMITTED_DECOMPOSITION_SIGNALS` nomeia o subconjunto que ainda bloqueia.
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
 * Subconjunto EMITIDO de `DecompositionSignalId`. Só entra aqui o que
 * caracteriza uma work unit objetivamente não delimitada em termos de
 * execução/rollback — não complexidade de engenharia. Complexidade ordinária
 * (cross_cutting, ambiguidade alta, verificação subjetiva, muitas
 * dependências/arquivos/tokens/comandos) é insumo de assessment, routing,
 * effort e budget: ela escolhe um modelo mais capaz, não recusa o plano.
 */
export const EMITTED_DECOMPOSITION_SIGNALS: readonly DecompositionSignalId[] = [
  'retry_not_isolated',
  'unbounded_rollback_boundary',
];

/**
 * Único limiar estrutural remanescente: a superfície MÁXIMA de arquivos que
 * ainda mantém uma fronteira de rollback delimitada, e apenas para risco
 * alto/crítico. Nenhum limiar aqui é de duração: `estimated_duration`,
 * `resource_envelope.duration_ms` e `validation[].timeout_seconds` são
 * deliberadamente ignorados por este avaliador.
 */
const MAX_MAXIMUM_CHANGED_FILES = 30;
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
 * Avalia, de forma pura e determinística, se `task` excede a fronteira segura
 * de execução/rollback de uma única work unit. Sem I/O, sem spawn de
 * processo, sem chamada a provider — só leitura dos campos já declarados em
 * `task`. Mesma entrada produz sempre o mesmo veredito.
 *
 * A pergunta que cada sinal precisa responder é "existe um risco concreto que
 * justifica impedir o coding agent de trabalhar?". Um sinal que só descreve
 * que o trabalho é difícil não responde sim — ele pertence ao routing.
 */
export function evaluateDecomposition(task: PlannedTask): DecompositionVerdict {
  const signals: TriggeredSignal[] = [];

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
