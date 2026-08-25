/**
 * Progresso de lifecycle do `pnpm lab run`.
 *
 * O evento é SEMÂNTICO: `stage` mais um payload ESTRUTURADO opcional. Nunca
 * uma string a ser reparseada — quem projeta o estado (a TUI) consome os
 * campos tipados, e a linha de texto existe só para o modo plain/log.
 *
 * O renderer é sempre CONSUMIDOR. Nenhum listener recebe handle de state,
 * runtime, plano ou provider: um `LabProgressListener` só pode ler o evento e
 * escrever no terminal. A projeção não é autoridade, e não tem como virar uma.
 *
 * stdout continua reservado ao payload JSON de máquina; tudo aqui é stderr.
 */

export const LAB_PROGRESS_STAGES = [
  'WAITING_FOR_INPUT',
  'PREFLIGHT',
  'TARGET_READY',
  'AUTHORIZED',
  'PLANNING',
  'PLANNER_RUNNING',
  'PLAN_READY',
  'DELIBERATING',
  'PLAN_SEALED',
  'ROUTED',
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

/** Uma task do plano como ela aparece na projeção, com estimativa ADVISORY. */
export interface LabProgressPlanTask {
  readonly task_id: string;
  readonly title: string;
  /** `null` é UNKNOWN: o plano não declara envelope de duração. */
  readonly estimated_duration_ms: number | null;
}

export interface LabProgressPlan {
  readonly origin: 'GENERATED' | 'REUSED' | 'PLAN_FILE';
  readonly tasks: readonly LabProgressPlanTask[];
}

/**
 * Quota do provider como ela foi (ou não foi) OBSERVADA.
 *
 * `UNKNOWN` é um estado de primeira classe com motivo, e não a ausência do
 * campo: um provider que não expõe medidor de assinatura nunca vira "0% usado".
 * Percentual só aparece quando o próprio provider o reportou.
 */
export type LabProgressQuota =
  | { readonly status: 'UNKNOWN'; readonly reason: string }
  | {
      readonly status: 'OBSERVED';
      readonly windows: readonly {
        readonly window_id: string;
        readonly used_pct: number | null;
        readonly consumed_pp: number | null;
      }[];
    };

/**
 * Fatos de execução conhecidos no momento da emissão. Todo campo é opcional
 * porque nem todo emissor conhece tudo — e o que não é conhecido permanece
 * ausente, nunca preenchido com um default plausível.
 */
export interface LabProgressTask {
  readonly task_id: string;
  readonly attempt?: number;
  readonly attempt_role?: 'initial' | 'repair' | 'escalation';
  readonly profile_id?: string;
  readonly provider?: string;
  readonly model?: string | null;
  readonly reasoning_effort?: string | null;
  readonly close_kind?: string;
  readonly escalated_from_profile_id?: string | null;
  readonly duration_ms?: number | null;
  readonly quota?: LabProgressQuota;
}

/** Um turno de deliberação de plano, projetado como evidência já selada. */
export interface LabProgressDeliberation {
  readonly turn: number;
  readonly max_turns: number;
  readonly profile_id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly decision: 'ACCEPT' | 'REVISE';
  readonly converged: boolean;
}

export interface LabProgressEvent {
  readonly stage: LabProgressStage;
  readonly detail?: string;
  readonly plan?: LabProgressPlan;
  readonly task?: LabProgressTask;
  readonly deliberation?: LabProgressDeliberation;
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

/** Encadeia listeners preservando a ordem; um erro de renderer nunca vaza. */
export function combineProgressListeners(
  ...listeners: readonly (LabProgressListener | undefined)[]
): LabProgressListener {
  const active = listeners.filter((listener): listener is LabProgressListener => listener !== undefined);
  return (event) => {
    for (const listener of active) listener(event);
  };
}
