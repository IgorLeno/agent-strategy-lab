/**
 * Renderer de terminal da projeção do lifecycle.
 *
 * Implementação simples e testável de propósito: `renderLabFrame` é uma função
 * PURA de `LabRunProjection` para linhas de texto, sem dependência de
 * biblioteca de TUI, sem estado global e sem acesso a nada do runtime. Repintar
 * é só apagar as linhas do frame anterior e escrever o novo — o que mantém a
 * saída inspecionável por teste, linha a linha, em vez de exigir um terminal
 * virtual.
 *
 * O renderer NÃO tem porta de escrita para o lifecycle: ele recebe uma
 * projeção read-only e um `write` de terminal. Não há caminho daqui para state,
 * plano, provider ou git.
 */
import type { LabProgressQuota } from './lab-progress.js';
import type { LabRunProjection, LabTaskProjection } from './lab-projection.js';

export type LabUiMode = 'auto' | 'tui' | 'plain';

export function parseLabUiMode(value: string | undefined): LabUiMode | null {
  if (value === undefined) return 'auto';
  return value === 'auto' || value === 'tui' || value === 'plain' ? value : null;
}

/** `auto` só vira TUI num terminal interativo de verdade. */
export function resolveLabUiMode(mode: LabUiMode, isTTY: boolean): 'tui' | 'plain' {
  if (mode === 'plain') return 'plain';
  if (mode === 'tui') return 'tui';
  return isTTY ? 'tui' : 'plain';
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (hours > 0) return `${pad(hours)}h${pad(minutes)}m${pad(seconds)}s`;
  return `${pad(minutes)}m${pad(seconds)}s`;
}

/** Estimativa é grandeza grossa: `~04h18m`, nunca `~04h18m07s`. */
export function formatEstimate(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return hours > 0 ? `~${pad(hours)}h${pad(minutes)}m` : `~${pad(minutes)}m`;
}

const MARKER: Readonly<Record<LabTaskProjection['state'], string>> = {
  PENDING: '[ ]',
  RUNNING: '[>]',
  VALIDATING: '[?]',
  ACCEPTED: '[x]',
  REPAIR: '[~]',
  ESCALATED: '[^]',
  FAILED: '[!]',
  HUMAN_REQUIRED: '[H]',
};

function outcomeOf(task: LabTaskProjection): string | null {
  if (task.state === 'ACCEPTED') {
    if (task.first_pass === true) return 'FIRST PASS';
    const parts: string[] = [];
    if (task.repairs > 0) parts.push(`REPAIRED ×${task.repairs}`);
    if (task.escalations > 0) parts.push(`ESCALATED ×${task.escalations}`);
    return parts.length > 0 ? parts.join(' · ') : `ATTEMPTS ×${Math.max(1, task.attempts)}`;
  }
  if (task.state === 'FAILED') return task.close_kind ?? 'FAILED';
  if (task.state === 'HUMAN_REQUIRED') return 'HUMAN REQUIRED';
  return null;
}

function workerLineOf(task: LabTaskProjection): string | null {
  if (task.state !== 'RUNNING' && task.state !== 'VALIDATING' && task.state !== 'REPAIR') return null;
  const parts = [
    task.provider ?? 'provider UNKNOWN',
    task.model ?? 'model UNKNOWN',
    task.reasoning_effort ?? 'effort UNKNOWN',
  ];
  if (task.running_elapsed_ms !== null) parts.push(`${formatDuration(task.running_elapsed_ms)} elapsed`);
  if (task.state === 'VALIDATING') parts.push('validating');
  if (task.escalated_from_profile_id !== null) parts.push(`escalated from ${task.escalated_from_profile_id}`);
  return `        ${parts.join(' · ')}`;
}

function quotaTextOf(quota: LabProgressQuota): string {
  if (quota.status === 'UNKNOWN') return `quota UNKNOWN (${quota.reason})`;
  const windows = quota.windows.map((window) =>
    window.used_pct === null
      ? `${window.window_id}=UNKNOWN`
      : `${window.window_id}=${window.used_pct}% used`,
  );
  return windows.length === 0 ? 'quota UNKNOWN (nenhuma janela observada)' : `quota ${windows.join(' · ')}`;
}

function headlineOf(projection: LabRunProjection): string {
  if (projection.terminal === 'ALL_DONE') return 'ALL DONE';
  if (projection.terminal === 'HUMAN_REQUIRED') return 'HUMAN REQUIRED';
  if (projection.terminal === 'FAILURE') return 'FAILURE';
  return projection.stage;
}

export interface RenderLabFrameOptions {
  readonly title: string;
  /** Colunas do terminal; só corta o título da task, nunca a evidência. */
  readonly columns?: number;
}

/** Função PURA: mesma projeção, mesmas linhas. */
export function renderLabFrame(
  projection: LabRunProjection,
  options: RenderLabFrameOptions,
): readonly string[] {
  const columns = Math.max(40, options.columns ?? 100);
  const lines: string[] = [
    `AGENT STRATEGY LAB — ${options.title}`,
    `${headlineOf(projection)} · ${formatDuration(projection.elapsed_ms)} elapsed`,
    '',
  ];

  if (projection.forecast !== null) {
    lines.push(`Initial plan estimate: ${formatEstimate(projection.forecast.initial_total_ms)}`);
    lines.push(
      `Remaining estimate:    ${
        projection.remaining_estimate_ms === null
          ? 'UNKNOWN'
          : formatEstimate(projection.remaining_estimate_ms)
      }`,
    );
    if (projection.forecast.tasks_without_estimate.length > 0) {
      lines.push(
        `Sem estimativa (UNKNOWN, fora do total): ${projection.forecast.tasks_without_estimate.join(', ')}`,
      );
    }
    lines.push('ADVISORY — not a deadline');
    lines.push('');
  }

  if (projection.deliberation !== null) {
    const deliberation = projection.deliberation;
    lines.push('PLAN DELIBERATION');
    for (const turn of deliberation.turns) {
      lines.push(
        `[x] ${String(turn.turn)} ${turn.provider} · ${turn.model ?? 'model UNKNOWN'} ... ${turn.decision}`,
      );
    }
    lines.push(
      deliberation.converged && deliberation.converged_at_turn !== null
        ? `CONVERGED AT TURN ${deliberation.converged_at_turn} / MAX ${deliberation.max_turns}`
        : `MAX TURNS ${deliberation.turns.length} / ${deliberation.max_turns}`,
    );
    lines.push('');
  }

  if (projection.tasks.length === 0) {
    lines.push('(plano ainda não declarado)');
  }
  const width = Math.max(2, String(projection.tasks.length).length);
  for (const task of projection.tasks) {
    const outcome = outcomeOf(task);
    const label = `${MARKER[task.state]} ${String(task.index).padStart(width, '0')} ${task.title}`;
    const suffix =
      task.state === 'ACCEPTED' || task.state === 'FAILED' || task.state === 'HUMAN_REQUIRED'
        ? `${task.duration_ms === null ? 'duração UNKNOWN' : formatDuration(task.duration_ms)}${
            outcome === null ? '' : ` · ${outcome}`
          }`
        : '';
    if (suffix.length === 0) {
      lines.push(label.length > columns ? `${label.slice(0, columns - 1)}…` : label);
    } else {
      const available = Math.max(1, columns - suffix.length - 1);
      const trimmed =
        label.length > available ? `${label.slice(0, Math.max(1, available - 1))}…` : label.padEnd(available);
      lines.push(`${trimmed} ${suffix}`);
    }
    const worker = workerLineOf(task);
    if (worker !== null) lines.push(worker);
  }

  if (projection.providers.length > 0) {
    lines.push('');
    lines.push('PROVIDERS');
    for (const provider of projection.providers) {
      lines.push(
        `  ${provider.provider}: launches=${provider.launches} · worker time ${formatDuration(provider.worker_time_ms)} · ${quotaTextOf(provider.quota)}`,
      );
    }
  }

  return lines;
}

export interface LabTuiWriterOptions extends RenderLabFrameOptions {
  readonly write: (chunk: string) => void;
  /** Sequências ANSI só num terminal interativo. */
  readonly ansi?: boolean;
}

const ESC = '\u001B';

export interface LabTuiWriter {
  paint(projection: LabRunProjection): void;
  /** Frame final sem apagar nada: o terminal fica com o resultado visível. */
  finish(projection: LabRunProjection): void;
}

/**
 * Repintura mínima: sobe o cursor pelas linhas do frame anterior, apaga do
 * cursor até o fim da tela e escreve o novo frame. Sem alternate screen —
 * scrollback do usuário permanece intacto.
 */
export function createLabTuiWriter(options: LabTuiWriterOptions): LabTuiWriter {
  let previousLines = 0;
  const ansi = options.ansi ?? true;

  function paintFrame(projection: LabRunProjection): void {
    const frame = renderLabFrame(projection, options);
    const prefix = ansi && previousLines > 0 ? `${ESC}[${previousLines}A${ESC}[0J` : '';
    options.write(`${prefix}${frame.join('\n')}\n`);
    previousLines = frame.length;
  }

  return {
    paint: paintFrame,
    finish(projection) {
      paintFrame(projection);
      previousLines = 0;
    },
  };
}
