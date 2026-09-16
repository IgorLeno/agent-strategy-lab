import type { WizardResult } from './lab-wizard.js';

export function shouldOpenWizard(input: {
  readonly argv: readonly string[];
  readonly stdinIsTTY: boolean;
  readonly stderrIsTTY: boolean;
}): boolean {
  return input.argv.length === 0 && input.stdinIsTTY && input.stderrIsTTY;
}

export function dispatchWizardResult(
  result: WizardResult,
  emit: (payload: Record<string, unknown>) => void,
  exit: (exitCode: number) => void,
): 'legacy' | 'return' {
  if (result === 'advanced') return 'legacy';
  if (result === 'completed') return 'return';

  emit(result.payload);
  if (result.exitCode !== 0) exit(result.exitCode);
  return 'return';
}
