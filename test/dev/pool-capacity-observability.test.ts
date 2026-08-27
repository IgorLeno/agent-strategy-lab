import { describe, expect, it } from 'vitest';

import { renderLabFrame } from '../../dev/lib/lab-tui.js';
import { createLabProjection, type LabRunProjection } from '../../dev/lib/lab-projection.js';
import type { LabProgressEvent } from '../../dev/lib/lab-progress.js';

function event(overrides: Partial<LabProgressEvent>): LabProgressEvent {
  return {
    stage: 'WORKER_RUNNING',
    detail: null,
    ...overrides,
  } as LabProgressEvent;
}

function project(events: readonly LabProgressEvent[]): LabRunProjection {
  const port = createLabProjection(() => 0);
  for (const entry of events) port.listener(entry);
  return port.snapshot();
}

function frame(events: readonly LabProgressEvent[]): string {
  return renderLabFrame(project(events), { title: 'teste', columns: 120 }).join('\n');
}

/**
 * A interface le observacoes estruturadas, nunca prosa de log. Estes testes
 * travam a unica regra que importa aqui: o que nao foi medido e IMPRESSO como
 * UNKNOWN, e nunca como zero.
 */
describe('projecao e TUI de capacidade por pool', () => {
  it('mostra a folga observada de cada pool separadamente', () => {
    const rendered = frame([
      event({
        stage: 'WORKER_RUNNING',
        task: {
          task_id: 'T1',
          profile_id: 'codex-sol',
          provider: 'openai',
          quota_pool: 'openai_chatgpt_subscription',
          quota: {
            status: 'OBSERVED',
            windows: [{ window_id: 'primary', used_pct: 3, consumed_pp: null }],
          },
        },
      }),
      event({
        stage: 'WORKER_RUNNING',
        task: {
          task_id: 'T2',
          profile_id: 'opencode-go-glm',
          provider: 'opencode_go',
          quota_pool: 'opencode_go_subscription',
          quota: {
            status: 'OBSERVED',
            windows: [{ window_id: 'rolling', used_pct: 1, consumed_pp: null }],
          },
        },
      }),
    ]);
    expect(rendered).toContain('QUOTA POOLS');
    expect(rendered).toContain('openai_chatgpt_subscription');
    expect(rendered).toContain('opencode_go_subscription');
    expect(rendered).toContain('primary=3% used');
  });

  it('pool sem observacao aparece como UNKNOWN, nunca como 0%', () => {
    const rendered = frame([
      event({
        stage: 'WORKER_RUNNING',
        task: {
          task_id: 'T1',
          profile_id: 'opencode-go-glm',
          provider: 'opencode_go',
          quota_pool: 'opencode_go_subscription',
          quota: { status: 'UNKNOWN', reason: 'credencial ausente' },
        },
      }),
    ]);
    expect(rendered).toContain('quota UNKNOWN (credencial ausente)');
    expect(rendered).not.toMatch(/opencode_go_subscription: quota \w+=0%/);
  });

  it('janela de medidor grosseiro e marcada, para que 0% nao seja lido como zero consumo', () => {
    const rendered = frame([
      event({
        stage: 'WORKER_RUNNING',
        task: {
          task_id: 'T1',
          profile_id: 'opencode-go-glm',
          provider: 'opencode_go',
          quota_pool: 'opencode_go_subscription',
          quota: {
            status: 'OBSERVED',
            windows: [
              {
                window_id: 'rolling',
                used_pct: 0,
                consumed_pp: null,
                precision: 'COARSE_INTEGER_PERCENT',
              },
            ],
          },
        },
      }),
    ]);
    // O til marca a resolucao do medidor: `0%~` e "o inteiro reportado e 0".
    expect(rendered).toContain('rolling=0%~ used');
  });

  it('pool esgotado e impresso como EXHAUSTED com o motivo do provider', () => {
    const rendered = frame([
      event({
        stage: 'WORKER_RUNNING',
        task: {
          task_id: 'T1',
          profile_id: 'codex-sol',
          provider: 'openai',
          quota_pool: 'openai_chatgpt_subscription',
          quota: { status: 'EXHAUSTED', reason: 'provider declarou limit_reached' },
        },
      }),
    ]);
    expect(rendered).toContain('quota EXHAUSTED (provider declarou limit_reached)');
  });

  it('saldo monetario aparece como dinheiro, nao como percentual', () => {
    const rendered = frame([
      event({
        stage: 'WORKER_RUNNING',
        task: {
          task_id: 'T1',
          profile_id: 'opencode-openrouter-api',
          provider: 'openrouter',
          quota_pool: 'openrouter_balance',
          quota: { status: 'OBSERVED', windows: [], balance: { remaining: 9.61, currency: 'USD' } },
        },
      }),
    ]);
    expect(rendered).toContain('saldo USD 9.61');
    expect(rendered).not.toMatch(/openrouter_balance.*%/);
  });

  it('dois perfis do MESMO pool aparecem numa unica linha de capacidade', () => {
    const projection = project([
        event({
          stage: 'WORKER_RUNNING',
          task: {
            task_id: 'T1',
            profile_id: 'codex-sol',
            provider: 'openai',
            quota_pool: 'openai_chatgpt_subscription',
            quota: {
              status: 'OBSERVED',
              windows: [{ window_id: 'primary', used_pct: 3, consumed_pp: null }],
            },
          },
        }),
        event({
          stage: 'WORKER_RUNNING',
          task: {
            task_id: 'T2',
            profile_id: 'opencode-openai-sol',
            provider: 'openai',
            quota_pool: 'openai_chatgpt_subscription',
            quota: {
              status: 'OBSERVED',
              windows: [{ window_id: 'primary', used_pct: 4, consumed_pp: null }],
            },
          },
        }),
    ]);
    // Uma franquia, uma linha: duas linhas sugeririam duas reservas.
    expect(projection.pools).toHaveLength(1);
    expect(projection.pools[0]?.quota_pool).toBe('openai_chatgpt_subscription');
    expect(projection.pools[0]?.profiles).toEqual(['codex-sol', 'opencode-openai-sol']);
  });
});
