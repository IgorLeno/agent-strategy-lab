import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LabProgressEvent } from '../../dev/lib/lab-progress.js';
import { createLabProjection } from '../../dev/lib/lab-projection.js';
import { createLabUi } from '../../dev/lib/lab-ui.js';
import {
  parseLabUiMode,
  renderLabFrame,
  resolveLabUiMode,
} from '../../dev/lib/lab-tui.js';
import { planRuntimeForecast, remainingPlanRuntimeMs } from '../../src/planner/plan-forecast.js';
import { REPO_ROOT } from './helpers.js';

const PLAN: LabProgressEvent = {
  stage: 'PLAN_READY',
  detail: 'origin=PLAN_FILE tasks=3',
  plan: {
    origin: 'PLAN_FILE',
    tasks: [
      { task_id: 'foundation', title: 'Foundation', estimated_duration_ms: 900_000 },
      { task_id: 'domain', title: 'Domain', estimated_duration_ms: 600_000 },
      { task_id: 'coverage', title: 'Coverage engine', estimated_duration_ms: 1_200_000 },
    ],
  },
};

/** Relógio controlado: nenhuma asserção de duração depende do relógio real. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000_000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('projeção read-only do lifecycle', () => {
  it('todas as tasks do plano aparecem assim que PLAN_READY chega', () => {
    const clock = fakeClock();
    const projection = createLabProjection(clock.now);
    expect(projection.snapshot().tasks).toHaveLength(0);

    projection.listener(PLAN);

    const snapshot = projection.snapshot();
    expect(snapshot.tasks.map((task) => task.task_id)).toEqual(['foundation', 'domain', 'coverage']);
    expect(snapshot.tasks.every((task) => task.state === 'PENDING')).toBe(true);
    expect(snapshot.tasks.map((task) => task.index)).toEqual([1, 2, 3]);
  });

  it('mudanças de estado do lifecycle atualizam a projeção', () => {
    const clock = fakeClock();
    const projection = createLabProjection(clock.now);
    projection.listener(PLAN);

    projection.listener({
      stage: 'ROUTED',
      task: {
        task_id: 'foundation',
        profile_id: 'codex-terra',
        provider: 'codex',
        model: 'gpt-5.6-terra',
        reasoning_effort: 'medium',
        attempt_role: 'initial',
      },
    });
    projection.listener({
      stage: 'WORKER_RUNNING',
      task: { task_id: 'foundation', profile_id: 'codex-terra', attempt: 1 },
    });
    expect(projection.snapshot().tasks[0]?.state).toBe('RUNNING');

    clock.advance(60_000);
    projection.listener({ stage: 'VALIDATING', task: { task_id: 'foundation', attempt: 1 } });
    expect(projection.snapshot().tasks[0]?.state).toBe('VALIDATING');

    projection.listener({
      stage: 'TASK_ACCEPTED',
      task: { task_id: 'foundation', attempt: 1, close_kind: 'PASS' },
    });
    const accepted = projection.snapshot().tasks[0];
    expect(accepted?.state).toBe('ACCEPTED');
    expect(projection.snapshot().tasks[1]?.state).toBe('PENDING');
  });

  it('conclusão mostra duração observada e first pass, e repair conta os attempts', () => {
    const clock = fakeClock();
    const projection = createLabProjection(clock.now);
    projection.listener(PLAN);

    projection.listener({
      stage: 'ROUTED',
      task: { task_id: 'foundation', provider: 'codex', model: 'gpt-5.6-terra', attempt_role: 'initial' },
    });
    projection.listener({ stage: 'WORKER_RUNNING', task: { task_id: 'foundation', attempt: 1 } });
    clock.advance(258_000);
    projection.listener({ stage: 'TASK_ACCEPTED', task: { task_id: 'foundation', attempt: 1 } });

    const first = projection.snapshot().tasks[0];
    expect(first?.duration_ms).toBe(258_000);
    expect(first?.first_pass).toBe(true);
    expect(first?.repairs).toBe(0);

    projection.listener({
      stage: 'ROUTED',
      task: { task_id: 'domain', provider: 'codex', model: 'gpt-5.6-terra', attempt_role: 'initial' },
    });
    projection.listener({ stage: 'WORKER_RUNNING', task: { task_id: 'domain', attempt: 1 } });
    clock.advance(100_000);
    projection.listener({ stage: 'TASK_FAILED', task: { task_id: 'domain', attempt: 1, close_kind: 'FAIL' } });
    projection.listener({ stage: 'REPAIR', task: { task_id: 'domain', attempt_role: 'repair' } });
    projection.listener({
      stage: 'ROUTED',
      task: { task_id: 'domain', attempt_role: 'repair', provider: 'codex', model: 'gpt-5.6-terra' },
    });
    projection.listener({ stage: 'WORKER_RUNNING', task: { task_id: 'domain', attempt: 2 } });
    clock.advance(122_000);
    projection.listener({ stage: 'TASK_ACCEPTED', task: { task_id: 'domain', attempt: 2 } });

    const repaired = projection.snapshot().tasks[1];
    // Dois emissores anunciaram o mesmo repair; ele foi contado uma vez só.
    expect(repaired?.repairs).toBe(1);
    expect(repaired?.first_pass).toBe(false);
    expect(repaired?.duration_ms).toBe(122_000);

    const frame = renderLabFrame(projection.snapshot(), { title: 'demo', columns: 100 }).join('\n');
    expect(frame).toMatch(/\[x\] 01 Foundation.*04m18s · FIRST PASS/);
    expect(frame).toMatch(/\[x\] 02 Domain.*02m02s · REPAIRED ×1/);
  });

  it('a estimativa restante diminui por task concluída, sem countdown de relógio', () => {
    const clock = fakeClock();
    const projection = createLabProjection(clock.now);
    projection.listener(PLAN);

    const initial = projection.snapshot();
    expect(initial.forecast?.initial_total_ms).toBe(2_700_000);
    expect(initial.remaining_estimate_ms).toBe(2_700_000);

    // Uma hora de relógio sem concluir nada NÃO muda a estimativa restante.
    clock.advance(3_600_000);
    expect(projection.snapshot().remaining_estimate_ms).toBe(2_700_000);

    projection.listener({ stage: 'WORKER_RUNNING', task: { task_id: 'foundation', attempt: 1 } });
    projection.listener({ stage: 'TASK_ACCEPTED', task: { task_id: 'foundation', attempt: 1 } });
    expect(projection.snapshot().remaining_estimate_ms).toBe(1_800_000);

    projection.listener({ stage: 'WORKER_RUNNING', task: { task_id: 'domain', attempt: 1 } });
    projection.listener({ stage: 'TASK_ACCEPTED', task: { task_id: 'domain', attempt: 1 } });
    expect(projection.snapshot().remaining_estimate_ms).toBe(1_200_000);
  });

  it('o forecast do plano é ADVISORY no contrato e o frame diz isso', () => {
    const forecast = planRuntimeForecast([
      { task_id: 'a', estimated_duration_ms: 1_000 },
      { task_id: 'b', estimated_duration_ms: 2_000 },
    ]);
    expect(forecast.authority).toBe('ADVISORY');
    expect(forecast.kind).toBe('PLAN_RUNTIME_FORECAST');
    expect(remainingPlanRuntimeMs(forecast, new Set(['a']))).toBe(2_000);

    const projection = createLabProjection(fakeClock().now);
    projection.listener(PLAN);
    const frame = renderLabFrame(projection.snapshot(), { title: 'demo' }).join('\n');
    expect(frame).toContain('ADVISORY — not a deadline');
    expect(frame).toContain('Initial plan estimate: ~45m');
  });

  it('task sem estimativa permanece UNKNOWN e não entra no total', () => {
    const projection = createLabProjection(fakeClock().now);
    projection.listener({
      stage: 'PLAN_READY',
      plan: {
        origin: 'PLAN_FILE',
        tasks: [
          { task_id: 'known', title: 'Known', estimated_duration_ms: 600_000 },
          { task_id: 'unknown', title: 'Unknown', estimated_duration_ms: null },
        ],
      },
    });
    const snapshot = projection.snapshot();
    expect(snapshot.forecast?.initial_total_ms).toBe(600_000);
    expect(snapshot.forecast?.tasks_without_estimate).toEqual(['unknown']);
    expect(snapshot.tasks[1]?.estimated_duration_ms).toBeNull();
    expect(renderLabFrame(snapshot, { title: 'demo' }).join('\n')).toContain(
      'Sem estimativa (UNKNOWN, fora do total): unknown',
    );
  });

  it('provider/model aparecem quando conhecidos e a quota UNKNOWN nunca vira número', () => {
    const clock = fakeClock();
    const projection = createLabProjection(clock.now);
    projection.listener(PLAN);
    projection.listener({
      stage: 'ROUTED',
      task: {
        task_id: 'coverage',
        profile_id: 'codex-sol',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
        attempt_role: 'initial',
      },
    });
    projection.listener({ stage: 'WORKER_RUNNING', task: { task_id: 'coverage', attempt: 1 } });
    clock.advance(581_000);

    const running = renderLabFrame(projection.snapshot(), { title: 'demo' }).join('\n');
    expect(running).toContain('[>] 03 Coverage engine');
    expect(running).toContain('codex · gpt-5.6-sol · high · 09m41s elapsed');

    projection.listener({
      stage: 'VALIDATING',
      task: {
        task_id: 'coverage',
        attempt: 1,
        quota: {
          status: 'UNKNOWN',
          reason: 'LaunchRecord.subscription_usage ausente: este provider não expõe medidor de assinatura',
        },
      },
    });
    projection.listener({ stage: 'TASK_ACCEPTED', task: { task_id: 'coverage', attempt: 1 } });

    const snapshot = projection.snapshot();
    const codex = snapshot.providers.find((entry) => entry.provider === 'codex');
    expect(codex?.launches).toBe(1);
    expect(codex?.worker_time_ms).toBe(581_000);
    expect(codex?.quota.status).toBe('UNKNOWN');
    const frame = renderLabFrame(snapshot, { title: 'demo' }).join('\n');
    expect(frame).toMatch(/codex: launches=1 · worker time 09m41s · quota UNKNOWN/);
    expect(frame).not.toMatch(/codex:.*\d+% used/);
  });

  it('quota observada pelo provider aparece com o percentual que ele reportou', () => {
    const clock = fakeClock();
    const projection = createLabProjection(clock.now);
    projection.listener(PLAN);
    projection.listener({
      stage: 'ROUTED',
      task: { task_id: 'domain', provider: 'claude', model: 'opus-5', reasoning_effort: 'high' },
    });
    projection.listener({ stage: 'WORKER_RUNNING', task: { task_id: 'domain', attempt: 1 } });
    projection.listener({
      stage: 'VALIDATING',
      task: {
        task_id: 'domain',
        quota: {
          status: 'OBSERVED',
          windows: [
            { window_id: 'five_hour', used_pct: 12, consumed_pp: 3 },
            { window_id: 'seven_day_all_models', used_pct: 41, consumed_pp: 1 },
          ],
        },
      },
    });
    const frame = renderLabFrame(projection.snapshot(), { title: 'demo' }).join('\n');
    expect(frame).toContain('five_hour=12% used');
    expect(frame).toContain('seven_day_all_models=41% used');
  });

  it('a projeção é determinística: os mesmos eventos produzem o mesmo snapshot', () => {
    const events: LabProgressEvent[] = [
      PLAN,
      { stage: 'ROUTED', task: { task_id: 'foundation', provider: 'codex', model: 'terra' } },
      { stage: 'WORKER_RUNNING', task: { task_id: 'foundation', attempt: 1 } },
      { stage: 'TASK_ACCEPTED', task: { task_id: 'foundation', attempt: 1 } },
      { stage: 'ALL_DONE' },
    ];
    const render = (): string => {
      const clock = fakeClock();
      const projection = createLabProjection(clock.now);
      for (const event of events) {
        projection.listener(event);
        clock.advance(1_000);
      }
      return renderLabFrame(projection.snapshot(), { title: 'demo', columns: 100 }).join('\n');
    };
    expect(render()).toBe(render());
  });
});

describe('modo de interface', () => {
  it('auto usa TUI só em terminal interativo; não-TTY continua log plain', () => {
    expect(parseLabUiMode(undefined)).toBe('auto');
    expect(parseLabUiMode('tui')).toBe('tui');
    expect(parseLabUiMode('bogus')).toBeNull();
    expect(resolveLabUiMode('auto', true)).toBe('tui');
    expect(resolveLabUiMode('auto', false)).toBe('plain');
    expect(resolveLabUiMode('plain', true)).toBe('plain');
    expect(resolveLabUiMode('tui', false)).toBe('tui');
  });

  it('não-TTY continua utilizável: uma linha por transição, sem sequência ANSI', () => {
    const chunks: string[] = [];
    const clock = fakeClock();
    const ui = createLabUi({
      mode: 'auto',
      isTTY: false,
      write: (chunk) => chunks.push(chunk),
      title: 'demo',
      now: clock.now,
      repaintIntervalMs: 0,
    });
    expect(ui.resolved).toBe('plain');
    ui.listener(PLAN);
    clock.advance(1_000);
    ui.listener({ stage: 'WORKER_RUNNING', detail: 'task=foundation profile=codex-terra' });
    ui.finish();

    const output = chunks.join('');
    expect(output).toContain('[00:00] PLAN_READY origin=PLAN_FILE tasks=3');
    expect(output).toContain('[00:01] WORKER_RUNNING task=foundation profile=codex-terra');
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\[/);
  });

  it('tui forçada fora de TTY continua legível e sem sequência de cursor', () => {
    const chunks: string[] = [];
    const ui = createLabUi({
      mode: 'tui',
      isTTY: false,
      write: (chunk) => chunks.push(chunk),
      title: 'demo',
      now: fakeClock().now,
      repaintIntervalMs: 0,
      columns: 100,
    });
    expect(ui.resolved).toBe('tui');
    ui.listener(PLAN);
    ui.finish();
    const output = chunks.join('');
    expect(output).toContain('AGENT STRATEGY LAB — demo');
    expect(output).toContain('[ ] 01 Foundation');
    // eslint-disable-next-line no-control-regex
    expect(output).not.toMatch(/\[/);
  });
});

describe('a projeção não pode alterar estado autoritativo', () => {
  /**
   * Prova ESTRUTURAL, e não de convenção: os módulos da interface não importam
   * nada capaz de escrever state, record, plano, git ou provider. Um import
   * novo que dê esse poder quebra este teste antes de virar comportamento.
   */
  const ALLOWED = new Set([
    './lab-progress.js',
    './lab-projection.js',
    './lab-tui.js',
    './lab-ui.js',
    '../../src/planner/plan-forecast.js',
  ]);

  it.each(['lab-projection.ts', 'lab-tui.ts', 'lab-ui.ts'])(
    '%s importa apenas os próprios contratos read-only',
    async (file) => {
      const source = await readFile(path.join(REPO_ROOT, 'dev/lib', file), 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);
      expect(imports.length).toBeGreaterThan(0);
      for (const specifier of imports) {
        expect(ALLOWED.has(specifier), `${file} importa ${specifier}`).toBe(true);
      }
    },
  );

  it('o listener devolve void: não existe porta de volta para o lifecycle', () => {
    const projection = createLabProjection(fakeClock().now);
    expect(projection.listener(PLAN)).toBeUndefined();
    expect(projection.listener({ stage: 'ALL_DONE' })).toBeUndefined();
    expect(projection.snapshot().terminal).toBe('ALL_DONE');
  });
});
