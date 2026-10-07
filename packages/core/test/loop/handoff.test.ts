import { describe, expect, it } from 'vitest';

import { HANDOFF_MAX_BYTES, buildHandoff, tailBytes } from '../../src/loop/handoff.js';
import type { PlanStep } from '../../src/plan/plan.js';

const STEP: PlanStep = {
  id: '1.2',
  title: 'Ligar CLI',
  tier: 'balanced',
  status: 'pending',
  body: 'Critério: comando `x` existe.',
  phase: 'Fase 1',
  line: 3,
};

const BASE = {
  planText: '# Plano: X\n- [x] 1.1 a\n- [ ] 1.2 Ligar CLI\n',
  step: STEP,
  previousNote: null,
  retryError: null,
  gateCommand: 'pnpm test',
  diffStat: ' a.ts | 2 +-\n',
  diffPatch: 'diff --git a/a.ts b/a.ts\n+novo\n',
};

describe('handoff', () => {
  it('traz step, regras, gate, plano e diff', () => {
    const prompt = buildHandoff(BASE);
    expect(prompt).toContain('# Step 1.2 — Ligar CLI\n\nCritério: comando `x` existe.');
    expect(prompt).toContain('`pnpm test` precisa terminar com código 0');
    expect(prompt).toContain('Não faça commit nem push');
    expect(prompt).toContain('- [ ] 1.2 Ligar CLI');
    expect(prompt).toContain('+novo');
    expect(prompt).not.toContain('Nota do step anterior');
    expect(prompt).not.toContain('falhou');
  });

  it('inclui nota anterior e o FIM do erro em retry', () => {
    const error = `${'x'.repeat(20_000)}\nFALHA: teste quebrou`;
    const prompt = buildHandoff({ ...BASE, previousNote: 'criei a.ts', retryError: error });
    expect(prompt).toContain('# Nota do step anterior\n\ncriei a.ts');
    expect(prompt).toContain('FALHA: teste quebrou');
    expect(prompt.length).toBeLessThan(15_000);
  });

  it('diff grande é cortado com aviso e o prompt cabe no teto', () => {
    const patch = 'ç'.repeat(200_000);
    const prompt = buildHandoff({ ...BASE, diffPatch: patch });
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
    expect(prompt).toContain('diff cortado');
    expect(prompt).not.toContain('�');
  });

  it('tailBytes preserva o fim sem quebrar multibyte', () => {
    expect(tailBytes('abc', 10)).toBe('abc');
    expect(tailBytes('ççç', 4)).toBe('çç');
  });
});
