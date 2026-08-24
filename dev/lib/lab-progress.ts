/**
 * Progresso de lifecycle do `pnpm lab run`.
 *
 * Uma linha por transição relevante, em stderr — nada de TUI, spinner ou
 * dashboard. stdout continua reservado ao payload JSON de máquina. Os eventos
 * são SEMÂNTICOS (stage + detalhe), para que testes verifiquem transições sem
 * snapshot frágil da saída inteira.
 */

export const LAB_PROGRESS_STAGES = [
  'WAITING_FOR_INPUT',
  'PREFLIGHT',
  'TARGET_READY',
  'AUTHORIZED',
  'PLANNING',
  'PLANNER_RUNNING',
  'PLAN_READY',
  'WORKER_RUNNING',
  'VALIDATING',
  'TASK_ACCEPTED',
  'TASK_FAILED',
  'REPAIR',
  'INTEGRATING',
  'PUBLISHED',
  'HUMAN_REQUIRED',
  'ALL_DONE',
  'FAILURE',
] as const;
export type LabProgressStage = (typeof LAB_PROGRESS_STAGES)[number];

export interface LabProgressEvent {
  readonly stage: LabProgressStage;
  readonly detail?: string;
}

export type LabProgressListener = (event: LabProgressEvent) => void;

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** Renderer de terminal: `[mm:ss] STAGE detalhe`. */
export function createProgressRenderer(
  write: (line: string) => void,
  now: () => number = Date.now,
): LabProgressListener {
  const startedAt = now();
  return (event) => {
    const prefix = `[${formatElapsed(now() - startedAt)}] ${event.stage}`;
    write(event.detail === undefined ? `${prefix}\n` : `${prefix} ${event.detail}\n`);
  };
}
