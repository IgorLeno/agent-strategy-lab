import { describe, expect, it } from 'vitest';

import { PlanFormatError, nextPendingStep, parsePlan, setStepStatus } from '../../src/plan/plan.js';

const PLAN = [
  '# Plano: Exportar relatório',
  '',
  'Contexto livre do usuário, ignorado pelo loop.',
  '',
  '## Fase 1 — Base',
  '- [x] 1.1 [economy] Criar módulo',
  '  Critério: `pnpm test` verde.',
  '',
  '  Detalhe depois de linha em branco.',
  '- [ ] 1.2 Ligar CLI',
  '',
  '## Fase 2 — Polimento',
  '- [!] 2.1 [premium] Revisar erros',
  '- [ ] 2.2 [standard] Documentar',
  '',
].join('\n');

describe('plan.md', () => {
  it('lê título, fases, tiers, status e corpo', () => {
    const plan = parsePlan(PLAN);
    expect(plan.title).toBe('Exportar relatório');
    expect(plan.steps.map((step) => [step.id, step.tier, step.status, step.phase])).toEqual([
      ['1.1', 'economy', 'done', 'Fase 1 — Base'],
      ['1.2', 'standard', 'pending', 'Fase 1 — Base'],
      ['2.1', 'premium', 'failed', 'Fase 2 — Polimento'],
      ['2.2', 'standard', 'pending', 'Fase 2 — Polimento'],
    ]);
    expect(plan.steps[0]?.body).toBe('Critério: `pnpm test` verde.\n\nDetalhe depois de linha em branco.');
    expect(plan.steps[1]?.body).toBe('');
    expect(plan.steps[1]?.title).toBe('Ligar CLI');
  });

  it('próximo step é o primeiro pendente na ordem do arquivo', () => {
    expect(nextPendingStep(parsePlan(PLAN))?.id).toBe('1.2');
  });

  it('marcar status troca só o caractere do checkbox', () => {
    const updated = setStepStatus(PLAN, '1.2', 'done');
    const before = PLAN.split('\n');
    const after = updated.split('\n');
    const changed = after.flatMap((line, index) => (line === before[index] ? [] : [index]));
    expect(changed).toEqual([9]);
    expect(after[9]).toBe('- [x] 1.2 Ligar CLI');
    expect(setStepStatus(updated, '1.2', 'pending')).toBe(PLAN);
    expect(parsePlan(setStepStatus(PLAN, '2.2', 'failed')).steps[3]?.status).toBe('failed');
  });

  it('preserva CRLF do usuário', () => {
    const crlf = PLAN.replaceAll('\n', '\r\n');
    const updated = setStepStatus(crlf, '1.2', 'done');
    expect(updated.replace('- [x] 1.2', '- [ ] 1.2')).toBe(crlf);
    expect(parsePlan(crlf).steps[1]?.title).toBe('Ligar CLI');
  });

  it('recusa tier desconhecido, id repetido e step inexistente', () => {
    expect(() => parsePlan('- [ ] 1 [ultra] x')).toThrow(/tier "ultra"/);
    expect(() => parsePlan('- [ ] 1 a\n- [ ] 1 b')).toThrow(PlanFormatError);
    expect(() => setStepStatus(PLAN, '9.9', 'done')).toThrow(/não existe/);
  });

  it('plano sem pendentes não tem próximo step', () => {
    expect(nextPendingStep(parsePlan('- [x] 1 feito'))).toBeNull();
  });
});
