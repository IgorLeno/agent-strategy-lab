import { describe, expect, it } from 'vitest';

import {
  buildClaudeInvocation,
  claudeAdapter,
  fakeAdapter,
  parseClaudeLine,
  resolveAdapter,
} from '../../src/adapters/index.js';
import {
  CredentialProofMethod,
  CredentialProofStatus,
} from '../../src/credentials/index.js';

describe('Claude ProviderAdapter', () => {
  it('é registrado pela cli claude sem alterar o registro do fake', () => {
    expect(resolveAdapter('claude')).toBe(claudeAdapter);
    expect(resolveAdapter('fake')).toBe(fakeAdapter);
    expect(() => resolveAdapter('desconhecido')).toThrow(/claude/);
  });

  it('compõe identidade, invocation e parser já definidos sem runtime próprio', () => {
    expect(claudeAdapter.identity).toEqual({ name: 'claude', version: '1.0.0' });
    expect(claudeAdapter.executionKind).toBe('REAL_INFERENCE');
    expect(claudeAdapter.buildInvocation).toBe(buildClaudeInvocation);
    expect(claudeAdapter.parseLine).toBe(parseClaudeLine);
    expect(claudeAdapter).not.toHaveProperty('execute');
  });

  it('aceita prova sanitizada de assinatura sem chamar a CLI', () => {
    const decision = claudeAdapter.preflight({
      credentialProof: {
        provider_id: 'claude',
        status: CredentialProofStatus.SUBSCRIPTION_VERIFIED,
        provenance: {
          method: CredentialProofMethod.LOCAL_CLI_STATUS,
          verifier_id: 'claude-auth-status-v1',
        },
      },
    });

    expect(decision).toMatchObject({
      decision: 'ALLOW',
      requirement: 'SUBSCRIPTION',
      reasons: ['SUBSCRIPTION_VERIFIED'],
    });
  });

  it('falha fechada quando a prova de assinatura está ausente', () => {
    expect(claudeAdapter.preflight({})).toMatchObject({
      decision: 'BLOCK',
      reasons: ['PROOF_MISSING'],
      proof: null,
    });
  });
});
