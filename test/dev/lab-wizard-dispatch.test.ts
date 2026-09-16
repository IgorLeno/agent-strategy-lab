import { describe, expect, it } from 'vitest';

import { shouldOpenWizard } from '../../dev/lib/lab-wizard-dispatch.js';

describe('shouldOpenWizard', () => {
  it('opens only for an empty interactive invocation', () => {
    expect(shouldOpenWizard({ argv: [], stdinIsTTY: true, stderrIsTTY: true })).toBe(true);
    expect(shouldOpenWizard({ argv: ['run'], stdinIsTTY: true, stderrIsTTY: true })).toBe(false);
    expect(shouldOpenWizard({ argv: [], stdinIsTTY: false, stderrIsTTY: false })).toBe(false);
  });
});
