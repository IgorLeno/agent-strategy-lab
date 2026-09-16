export function shouldOpenWizard(input: {
  readonly argv: readonly string[];
  readonly stdinIsTTY: boolean;
  readonly stderrIsTTY: boolean;
}): boolean {
  return input.argv.length === 0 && input.stdinIsTTY && input.stderrIsTTY;
}
