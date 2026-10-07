import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { InvocationRequest } from '../../src/adapters/invocation.js';
import type { ModelProfile } from '../../src/catalog/catalog.js';
import {
  buildPlanningPrompt,
  extractPlanDraft,
  PLANNING_PROMPT_MAX_BYTES,
  runPlanningTurn,
  type PlanningTurn,
} from '../../src/planning/planning.js';

const FAKE_AGENT = path.join(import.meta.dirname, '..', 'fixtures', 'fake-agent.mjs');
const CATALOG = [
  { id: 'p-a', scaffold: 'fake', provider: 'none', model: 'p-a', effort: null, tier: 'premium', cost_rank: 1 },
  { id: 'p-b', scaffold: 'fake', provider: 'none', model: 'p-b', effort: null, tier: 'premium', cost_rank: 2 },
  { id: 's-a', scaffold: 'fake', provider: 'none', model: 's-a', effort: null, tier: 'standard', cost_rank: 1 },
] as unknown as readonly ModelProfile[];

const PLAN_BLOCK = '```plan\n# Plano: Demo\n\n## Fase 1 — Base\n- [ ] 1.1 [economy] Criar README\n  Um README com o nome do projeto.\n```';

let root: string;
let scriptPath: string;
let modes: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'asl-planning-'));
  scriptPath = path.join(root, 'script.json');
  modes = [];
});

function fakeInvoke(request: InvocationRequest) {
  modes.push(request.mode);
  return {
    argv: [process.execPath, FAKE_AGENT, request.profile.id],
    env: { PATH: process.env['PATH'] ?? '', ASL_FAKE_SCRIPT: scriptPath, ...request.extraEnv },
    stdin: request.prompt,
  };
}

const user = (text: string): PlanningTurn => ({ role: 'user', text });

describe('prompt de planejamento', () => {
  it('leva instruções, formato e a conversa inteira', () => {
    const prompt = buildPlanningPrompt([user('quero um jogo'), { role: 'assistant', text: 'web ou desktop?' }, user('web')]);
    expect(prompt).toContain('```plan');
    expect(prompt).toContain('## Usuário\n\nquero um jogo');
    expect(prompt).toContain('## Planejador (você)\n\nweb ou desktop?');
    expect(prompt.endsWith('## Usuário\n\nweb')).toBe(true);
  });

  it('exige que o último turno seja do usuário', () => {
    expect(() => buildPlanningPrompt([])).toThrow();
    expect(() => buildPlanningPrompt([user('a'), { role: 'assistant', text: 'b' }])).toThrow();
  });

  it('conversa longa mantém o primeiro pedido e os turnos recentes', () => {
    const big = 'x'.repeat(30_000);
    const turns: PlanningTurn[] = [user('PEDIDO ORIGINAL')];
    for (let index = 0; index < 6; index += 1) turns.push({ role: 'assistant', text: `resposta ${index} ${big}` }, user(`msg ${index}`));
    const prompt = buildPlanningPrompt(turns);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(PLANNING_PROMPT_MAX_BYTES);
    expect(prompt).toContain('PEDIDO ORIGINAL');
    expect(prompt).toContain('turnos intermediários omitidos');
    expect(prompt.endsWith('msg 5')).toBe(true);
    expect(prompt).not.toContain('resposta 0');
  });
});

describe('rascunho do plano na resposta', () => {
  it('extrai o último bloco válido', () => {
    const reply = `Primeira versão:\n${PLAN_BLOCK.replace('Criar README', 'Velho')}\n\nVersão final:\n${PLAN_BLOCK}`;
    const draft = extractPlanDraft(reply);
    expect(draft?.plan.title).toBe('Demo');
    expect(draft?.plan.steps.map((step) => `${step.id} ${step.tier} ${step.title}`)).toEqual(['1.1 economy Criar README']);
    expect(draft?.text.endsWith('projeto.\n')).toBe(true);
  });

  it('sem bloco, bloco sem step ou com step já marcado = sem rascunho', () => {
    expect(extractPlanDraft('Qual linguagem?')).toBeNull();
    expect(extractPlanDraft('```plan\n# Plano: Vazio\n```')).toBeNull();
    expect(extractPlanDraft('```plan\n# Plano: X\n- [x] 1 Feito\n```')).toBeNull();
    expect(extractPlanDraft('```plan\n# Plano: X\n- [ ] 1 A\n- [ ] 1 B\n```')).toBeNull();
  });
});

describe('turno de planejamento com agente fake', () => {
  it('modo plan, perfil premium, resposta com rascunho', async () => {
    await writeFile(scriptPath, JSON.stringify({ calls: [{ final: `Resumo.\n\n${PLAN_BLOCK}`, tokens: 900 }] }));
    const result = await runPlanningTurn({ repo: root, turns: [user('um README')], catalog: CATALOG, sourceEnv: {}, invoke: fakeInvoke });
    expect(modes).toEqual(['plan']);
    expect(result).toMatchObject({ status: 'ok', profileId: 'p-a', tokens: { total: 900 } });
    expect(result.status === 'ok' && result.draft?.plan.steps).toHaveLength(1);
  });

  it('falha de provider passa para o próximo premium; resposta sem plano é pergunta', async () => {
    await writeFile(
      scriptPath,
      JSON.stringify({ calls: [{ providerFailure: 'rate limit', exit: 1 }, { final: 'Qual stack?' }] }),
    );
    const attempts: string[] = [];
    const result = await runPlanningTurn({
      repo: root,
      turns: [user('um app')],
      catalog: CATALOG,
      sourceEnv: {},
      invoke: fakeInvoke,
      onAttempt: (profile) => attempts.push(profile.id),
    });
    expect(attempts).toEqual(['p-a', 'p-b']);
    expect(result).toMatchObject({ status: 'ok', profileId: 'p-b', reply: 'Qual stack?', draft: null });
  });

  it('todos os premium falham = erro com os motivos', async () => {
    await writeFile(scriptPath, JSON.stringify({ calls: [{ providerFailure: 'limite A' }, { providerFailure: 'limite B' }] }));
    const result = await runPlanningTurn({ repo: root, turns: [user('x')], catalog: CATALOG, sourceEnv: {}, invoke: fakeInvoke });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toMatch(/nenhum perfil premium disponível: p-a: .*limite A.*; p-b: .*limite B/);
  });

  it('agente sem resposta volta como erro, sem retry automático', async () => {
    await writeFile(scriptPath, JSON.stringify({ calls: [{ exit: 2 }] }));
    const result = await runPlanningTurn({ repo: root, turns: [user('x')], catalog: CATALOG, sourceEnv: {}, invoke: fakeInvoke });
    expect(result.status === 'failed' && result.error).toMatch(/saiu com código 2/);
    expect(modes).toHaveLength(1);
  });

  it('aborto mata o turno', async () => {
    await writeFile(scriptPath, JSON.stringify({ calls: [{ sleepMs: 5_000, final: 'tarde' }] }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runPlanningTurn({
      repo: root,
      turns: [user('x')],
      catalog: CATALOG,
      sourceEnv: {},
      invoke: fakeInvoke,
      signal: controller.signal,
    });
    expect(result).toEqual({ status: 'aborted' });
  });
});
