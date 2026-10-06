import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { Ledger } from '../../src/ledger/ledger.js';

const PLAN = {
  repo: '/r',
  plan_rel_path: '.asl/plan.md',
  slug: 'x',
  git_mode: 'branch' as const,
  workspace_dir: '/r',
  branch: 'asl/x',
  base_sha: 'abc',
};

describe('ledger', () => {
  it('registra plano, steps e tentativas numeradas com tokens', () => {
    const ledger = new Ledger(':memory:');
    const plan = ledger.upsertPlan(PLAN);
    expect(plan.status).toBe('running');
    const step = ledger.ensureStep(plan.id, { id: '1.1', title: 'a', tier: 'standard' });
    expect(ledger.ensureStep(plan.id, { id: '1.1', title: 'a editado', tier: 'premium' }).id).toBe(step.id);
    ledger.markStepRunning(step.id);

    const first = ledger.startAttempt({ stepRowId: step.id, profileId: 'p', scaffold: 'claude_code', provider: 'anthropic', model: 'm', effort: 'high', mode: 'edit' });
    ledger.finishAttempt(first.id, { durationMs: 10, exitCode: 0, timedOut: false, outcome: 'gate_failed', gateExitCode: 1, tokens: null, error: 'teste falhou' });
    const second = ledger.startAttempt({ stepRowId: step.id, profileId: 'p', scaffold: 'claude_code', provider: 'anthropic', model: 'm', effort: 'high', mode: 'edit' });
    ledger.finishAttempt(second.id, { durationMs: 20, exitCode: 0, timedOut: false, outcome: 'success', gateExitCode: 0, tokens: { total: 30, input: 20, cached_input: 5, output: 10, reasoning: null }, error: null });
    expect([first.attemptNo, second.attemptNo]).toEqual([1, 2]);

    ledger.finishStep(step.id, { status: 'done', commitSha: 'def', note: 'feito' });
    const [row] = ledger.stepsOf(plan.id);
    expect(row).toMatchObject({ status: 'done', title: 'a editado', tier: 'premium', commit_sha: 'def', note: 'feito' });
    expect(ledger.attemptsOf(step.id).map((attempt) => [attempt.outcome, attempt.tokens_total])).toEqual([
      ['gate_failed', null],
      ['success', 30],
    ]);
    expect(ledger.lastNote(plan.id)).toBe('feito');
  });

  it('step running vira interrupted e o estado sobrevive a reabrir o arquivo', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'asl-ledger-'));
    try {
      const file = path.join(dir, 'sub', 'ledger.db');
      const ledger = new Ledger(file);
      const plan = ledger.upsertPlan(PLAN);
      const step = ledger.ensureStep(plan.id, { id: '1', title: 'a', tier: 'economy' });
      ledger.markStepRunning(step.id);
      ledger.close();

      const reopened = new Ledger(file);
      const found = reopened.findPlan('/r', '.asl/plan.md', 'x');
      expect(found?.base_sha).toBe('abc');
      expect(reopened.markInterrupted(plan.id)).toBe(1);
      expect(reopened.stepsOf(plan.id)[0]?.status).toBe('interrupted');
      reopened.setPlanStatus(plan.id, 'paused');
      expect(reopened.plans()[0]?.status).toBe('paused');
      reopened.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
