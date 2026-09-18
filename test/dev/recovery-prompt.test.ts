import { describe, expect, it, vi } from 'vitest';

import type { RecoveryIncident } from '../../dev/lib/incident-recovery.js';
import { createRecoveryDecisionPrompt } from '../../dev/lib/recovery-prompt.js';

const incident: RecoveryIncident = {
  schema_version: 1,
  incident_id: 'incident-1',
  fingerprint: 'a'.repeat(64),
  task_id: 'T1',
  blocker: 'PROVIDER_OR_INFRA_FAILURE',
  reason: 'O provider encerrou antes de produzir um resultado.',
  evidence_paths: [],
  runtime_dir: '/runs/incident-1',
  created_at: '2026-09-18T00:00:00.000Z',
  budget: { max_investigator_launches: 3, max_remediation_cycles: 2 },
};

function fixture(result: 'investigate' | 'stop' | Error) {
  const write = vi.fn<(chunk: string) => void>();
  const select = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { write, select, decide: createRecoveryDecisionPrompt({ write, select }) };
}

describe('createRecoveryDecisionPrompt', () => {
  it.each(['investigate', 'stop'] as const)('returns the explicit %s choice with product copy', async (decision) => {
    const f = fixture(decision);

    await expect(f.decide(incident)).resolves.toBe(decision);
    expect(f.write.mock.calls.map(([chunk]) => chunk).join('')).toContain(
      'Encontrei um problema técnico que os mecanismos automáticos atuais não conseguiram resolver.',
    );
    expect(f.write.mock.calls.map(([chunk]) => chunk).join('')).toContain(`Resumo curto:\n${incident.reason}`);
    expect(f.select).toHaveBeenCalledWith('Como deseja continuar?', [
      { name: 'Investigar e tentar corrigir automaticamente', value: 'investigate' },
      { name: 'Parar e mostrar diagnóstico', value: 'stop' },
    ]);
  });

  it.each(['ExitPromptError', 'AbortPromptError'])('maps %s cancellation to stop', async (name) => {
    const f = fixture(Object.assign(new Error('cancel'), { name }));
    await expect(f.decide(incident)).resolves.toBe('stop');
  });

  it('preserves unexpected prompt failures', async () => {
    const error = new Error('terminal unavailable');
    const f = fixture(error);
    await expect(f.decide(incident)).rejects.toBe(error);
  });
});
