import { describe, expect, it } from 'vitest';

import { dispatchWizardResult, shouldOpenWizard } from '../../dev/lib/lab-wizard-dispatch.js';

describe('shouldOpenWizard', () => {
  it('opens only for an empty interactive invocation', () => {
    expect(shouldOpenWizard({ argv: [], stdinIsTTY: true, stderrIsTTY: true })).toBe(true);
    expect(shouldOpenWizard({ argv: ['run'], stdinIsTTY: true, stderrIsTTY: true })).toBe(false);
    expect(shouldOpenWizard({ argv: [], stdinIsTTY: false, stderrIsTTY: false })).toBe(false);
  });
});

describe('dispatchWizardResult', () => {
  it.each([
    { payload: { status: 'ALL_DONE' }, exitCode: 0 },
    { payload: { status: 'HUMAN_REQUIRED' }, exitCode: 9 },
    { payload: { status: 'FAILURE' }, exitCode: 17 },
  ])('emits the exact payload and preserves exitCode $exitCode', (result) => {
    const emitted: Record<string, unknown>[] = [];
    const exits: number[] = [];

    expect(dispatchWizardResult(result, (payload) => emitted.push(payload), (exitCode) => exits.push(exitCode)))
      .toBe('return');
    expect(emitted).toEqual([result.payload]);
    expect(exits).toEqual(result.exitCode === 0 ? [] : [result.exitCode]);
  });

  it('returns cleanly for user completion without dispatching', () => {
    const emitted: Record<string, unknown>[] = [];
    const exits: number[] = [];

    expect(dispatchWizardResult('completed', (payload) => emitted.push(payload), (exitCode) => exits.push(exitCode)))
      .toBe('return');
    expect(emitted).toEqual([]);
    expect(exits).toEqual([]);
  });

  it('continues into the legacy flow for advanced mode', () => {
    const emitted: Record<string, unknown>[] = [];
    const exits: number[] = [];

    expect(dispatchWizardResult('advanced', (payload) => emitted.push(payload), (exitCode) => exits.push(exitCode)))
      .toBe('legacy');
    expect(emitted).toEqual([]);
    expect(exits).toEqual([]);
  });
});
