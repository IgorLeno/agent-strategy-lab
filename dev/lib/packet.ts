import {
  DEV_SCHEMA_VERSION,
  type HandoffRecord,
  type PlanTask,
  type PreviousAttemptDiagnostics,
  type TaskPacket,
  parseTaskPacket,
} from './schemas.js';

export interface BuildPacketInput {
  readonly task: PlanTask;
  readonly baseSha: string;
  readonly previousHandoff: HandoffRecord | null;
  /** Só existe em attempt de reparo; derivado de record, nunca de transcript. */
  readonly previousAttemptDiagnostics?: PreviousAttemptDiagnostics | null;
  readonly now?: string;
}

/**
 * O packet contém SOMENTE o que o plano declara, mais — em attempt de reparo —
 * o diagnóstico objetivo do attempt anterior derivado pelo orquestrador. Nada
 * de transcript, conversa, raciocínio, logs ou reviews históricos: a limpeza de
 * contexto é garantida pelo processo novo, e o packet é o único canal de
 * entrada permitido.
 */
export function buildTaskPacket(input: BuildPacketInput): TaskPacket {
  const { task, baseSha, previousHandoff } = input;
  return parseTaskPacket({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: task.id,
    title: task.title,
    objective: task.objective,
    base_sha: baseSha,
    initial_files: task.initial_files,
    acceptance: task.acceptance,
    validation: task.validation,
    constraints: task.constraints,
    previous_handoff: task.include_previous_handoff ? previousHandoff : null,
    ...(input.previousAttemptDiagnostics
      ? { previous_attempt_diagnostics: input.previousAttemptDiagnostics }
      : {}),
    generated_at: input.now ?? new Date().toISOString(),
  });
}
