import { canonicalJson } from './canonical.js';

/** Budgets determinísticos do protocolo de sessões descartáveis. */
export const MAXIMUM_TASK_PACKET_BYTES = 12_288; // 12 KiB
export const MAXIMUM_HANDOFF_BYTES = 4_096; // 4 KiB

export class BudgetExceededError extends Error {
  constructor(
    readonly kind: string,
    readonly actualBytes: number,
    readonly maximumBytes: number,
  ) {
    super(`${kind} excede o budget: ${actualBytes} bytes > ${maximumBytes} bytes`);
    this.name = 'BudgetExceededError';
  }
}

export function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function assertByteBudget(kind: string, value: unknown, maximumBytes: number): void {
  const actual = byteSize(value);
  if (actual > maximumBytes) throw new BudgetExceededError(kind, actual, maximumBytes);
}
