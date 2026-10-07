import type { Continuity, GitMode, LoopState, PermissionMode, Tier } from '../../shared/ipc';

export const TIER_LETTER: Readonly<Record<Tier, string>> = { economy: 'E', standard: 'S', premium: 'P' };
export const TIER_NAME: Readonly<Record<Tier, string>> = { economy: 'economy', standard: 'standard', premium: 'premium' };

export const MODE_LABEL: Readonly<Record<PermissionMode, string>> = { plan: 'Plan', edit: 'Edit', auto: 'Auto' };
export const CONTINUITY_LABEL: Readonly<Record<Continuity, string>> = {
  step: 'Step a step',
  phase: 'Por fase',
  continuous: 'Contínuo',
};
export const GIT_LABEL: Readonly<Record<GitMode, string>> = { direct: 'Direto', branch: 'Branch', worktree: 'Worktree' };

export const STATE_LABEL: Readonly<Record<LoopState, string>> = {
  idle: 'parado',
  running: 'rodando',
  pausing: 'pausando…',
  paused: 'pausado',
  done: 'concluído',
  error: 'erro',
};

export function duration(ms: number | null): string {
  if (ms === null) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export function tokens(count: number | null): string {
  if (count === null) return '— tokens';
  if (count < 1_000) return `${count} tokens`;
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k tokens`;
  return `${(count / 1_000_000).toFixed(2)}M tokens`;
}
