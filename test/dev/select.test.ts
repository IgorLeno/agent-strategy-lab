import { describe, expect, it } from 'vitest';
import { parsePlan } from '../../dev/lib/plan.js';
import { selectNextTask } from '../../dev/lib/select.js';
import { buildInitialState } from '../../dev/lib/state.js';
import { DevelopmentState, type TaskStatus } from '../../dev/lib/schemas.js';

const SHA = 'b'.repeat(40);

const PLAN_SOURCE = `
schema_version: 1
tasks:
  - id: T1
    title: primeira
    objective: fazer T1
    acceptance: [ok]
    validation: [{ argv: [pnpm, test], timeout_seconds: 60 }]
  - id: T2
    title: segunda
    blocked_by: [T1]
    objective: fazer T2
    include_previous_handoff: true
    acceptance: [ok]
    validation: [{ argv: [pnpm, test], timeout_seconds: 60 }]
  - id: T3
    title: terceira
    blocked_by: [T2]
    objective: fazer T3
    acceptance: [ok]
    validation: [{ argv: [pnpm, test], timeout_seconds: 60 }]
`;

const loaded = parsePlan(PLAN_SOURCE);

function stateWith(overrides: Record<string, Partial<{ status: TaskStatus; phase: string | null; accepted_commit: string | null }>>) {
  const base = buildInitialState(loaded.plan, loaded.planSha256, { now: '2026-08-05T12:00:00.000Z' });
  return DevelopmentState.parse({
    ...base,
    tasks: base.tasks.map((task) => ({ ...task, ...(overrides[task.id] ?? {}) })),
  });
}

describe('selectNextTask', () => {
  it('escolhe a primeira pendente sem dependências', () => {
    const selection = selectNextTask(loaded, stateWith({}));
    expect(selection.status).toBe('SELECTED');
    expect(selection.task?.id).toBe('T1');
  });

  it('não avança enquanto a dependência não estiver PASS', () => {
    const selection = selectNextTask(loaded, stateWith({ T1: { status: 'READY' } }));
    expect(selection.task?.id).toBe('T1');
  });

  it('avança para a próxima quando a dependência passou', () => {
    const selection = selectNextTask(
      loaded,
      stateWith({ T1: { status: 'PASS', accepted_commit: SHA } }),
    );
    expect(selection.task?.id).toBe('T2');
    expect(selection.handoffSourceTaskId).toBe('T1');
  });

  it('para o fluxo em FAIL, TIMED_OUT, MISSCOPED e INFRA_ERROR', () => {
    for (const status of ['FAIL', 'TIMED_OUT', 'MISSCOPED', 'INFRA_ERROR'] as const) {
      const selection = selectNextTask(loaded, stateWith({ T1: { status } }));
      expect(selection.status, status).toBe('HALTED');
      expect(selection.task).toBeNull();
    }
  });

  it('recusa selecionar enquanto há tarefa RUNNING', () => {
    const selection = selectNextTask(
      loaded,
      stateWith({ T1: { status: 'RUNNING', phase: 'FINALIZING' } }),
    );
    expect(selection.status).toBe('BUSY');
    expect(selection.reason).toMatch(/FINALIZING/);
  });

  it('reporta ALL_DONE quando nada resta', () => {
    const selection = selectNextTask(
      loaded,
      stateWith({
        T1: { status: 'PASS', accepted_commit: SHA },
        T2: { status: 'PASS', accepted_commit: SHA },
        T3: { status: 'PASS', accepted_commit: SHA },
      }),
    );
    expect(selection.status).toBe('ALL_DONE');
  });

  it('é determinística — mesmo plano e estado, mesma escolha', () => {
    const state = stateWith({ T1: { status: 'PASS', accepted_commit: SHA } });
    expect(selectNextTask(loaded, state)).toEqual(selectNextTask(loaded, state));
  });
});
