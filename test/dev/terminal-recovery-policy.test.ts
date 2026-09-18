import { describe, expect, it } from 'vitest';

import type { TechnicalBlockedOutput } from '../../dev/lib/control-plane-halt.js';
import {
  classifyTerminalRecovery,
  type TerminalRecoveryFacts,
} from '../../dev/lib/terminal-recovery-policy.js';

const halt: TechnicalBlockedOutput = {
  status: 'BLOCKED',
  blocker: 'INCONSISTENT_EVIDENCE',
  incident_id: 'task:T1',
  decision_needed: 'reconciliar evidência',
  why_automation_stopped: 'artifacts autoritativos divergem',
  options: [],
  evidence_paths: ['runtime/state.json'],
};

const eligible: readonly TerminalRecoveryFacts[] = [
  { kind: 'TYPED_BLOCKED', halt },
  {
    kind: 'OFFICIAL_VALIDATION_FAILURE', task_id: 'T1', verification_only: true,
    reason: 'validação oficial de verification_only falhou', evidence_paths: ['completions/T1.completion.json'],
  },
  {
    kind: 'OFFICIAL_VALIDATION_FAILURE', task_id: 'T2', verification_only: false,
    reason: 'validação oficial falhou', evidence_paths: ['completions/T2.completion.json'],
  },
  { kind: 'INFRA_ERROR', task_id: 'T3', reason: 'provider encerrou', evidence_paths: ['state.json'] },
  { kind: 'TIMED_OUT', task_id: 'T4', reason: 'ceiling de máquina', evidence_paths: ['state.json'] },
  {
    kind: 'PREFLIGHT_TECHNICAL_BLOCK', task_id: null, blocker: 'INVALID_PROVENANCE',
    reason: 'base divergiu', evidence_paths: ['state.json'],
  },
];

const excluded: readonly TerminalRecoveryFacts[] = [
  { kind: 'HUMAN_REQUIRED', reason: 'autoridade humana real' },
  { kind: 'ALL_DONE', reason: 'plano concluído' },
  { kind: 'LIMIT_REACHED', reason: 'limite de iterações' },
  { kind: 'WORKER_REPORTED_FAILURE', task_id: 'T1', reason: 'worker declarou FAILURE' },
  { kind: 'UNTYPED_FAIL', task_id: 'T1', reason: 'FAIL sem prova técnica' },
  { kind: 'MISSCOPED', task_id: 'T1', reason: 'escopo divergente' },
  { kind: 'PREFLIGHT_UNTYPED_BLOCK', reason: 'preflight sem blocker técnico tipado' },
];

describe('classifyTerminalRecovery', () => {
  it.each(eligible)('admits $kind with an explicit technical reason', (facts) => {
    const result = classifyTerminalRecovery(facts);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.halt.status).toBe('BLOCKED');
      expect(result.why_eligible).not.toHaveLength(0);
    }
  });

  it.each(excluded)('excludes $kind without asking the investigator', (facts) => {
    const result = classifyTerminalRecovery(facts);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.why_ineligible).not.toHaveLength(0);
  });
});
