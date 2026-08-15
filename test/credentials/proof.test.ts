import { describe, expect, it } from 'vitest';

import {
  CredentialProof,
  CredentialProofMethod,
  CredentialProofStatus,
  CredentialRequirement,
  decideCredentialProof,
  type CredentialProof as CredentialProofValue,
} from '../../src/credentials/index.js';

function fakeProof(status: CredentialProofStatus): CredentialProofValue {
  return {
    provider_id: 'fake-provider',
    status,
    provenance: {
      method: CredentialProofMethod.FIXTURE,
      verifier_id: 'fake-local-status-v1',
    },
  };
}

describe('CredentialProof', () => {
  it.each(Object.values(CredentialProofStatus))('aceita o status provider-neutral %s', (status) => {
    expect(CredentialProof.parse(fakeProof(status))).toEqual(fakeProof(status));
  });

  it('exige provenance explícita', () => {
    const { provenance: _provenance, ...withoutProvenance } = fakeProof(
      CredentialProofStatus.SUBSCRIPTION_VERIFIED,
    );

    expect(CredentialProof.safeParse(withoutProvenance).success).toBe(false);
  });

  it.each(['raw_output', 'api_key', 'token', 'account_email'])(
    'recusa campo que poderia persistir segredo: %s',
    (field) => {
      expect(
        CredentialProof.safeParse({
          ...fakeProof(CredentialProofStatus.API_VERIFIED),
          [field]: 'fake-secret-value',
        }).success,
      ).toBe(false);
    },
  );
});

describe('decideCredentialProof', () => {
  it('permite assinatura somente com prova positiva de assinatura', () => {
    const decision = decideCredentialProof(
      CredentialRequirement.SUBSCRIPTION,
      fakeProof(CredentialProofStatus.SUBSCRIPTION_VERIFIED),
    );

    expect(decision).toMatchObject({
      decision: 'ALLOW',
      reasons: ['SUBSCRIPTION_VERIFIED'],
      policy: { id: 'agentlab-credential-proof', version: 1 },
    });
  });

  it.each([
    [CredentialProofStatus.API_VERIFIED, 'API_NOT_ALLOWED'],
    [CredentialProofStatus.UNKNOWN, 'PROOF_UNKNOWN'],
    [CredentialProofStatus.NOT_APPLICABLE, 'PROOF_NOT_APPLICABLE'],
  ] as const)('falha fechada para assinatura diante de %s', (status, reason) => {
    const decision = decideCredentialProof(
      CredentialRequirement.SUBSCRIPTION,
      fakeProof(status),
    );

    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasons).toEqual([reason]);
  });

  it('ausência de prova — inclusive ausência de API key — não prova assinatura', () => {
    expect(decideCredentialProof(CredentialRequirement.SUBSCRIPTION)).toMatchObject({
      decision: 'BLOCK',
      reasons: ['PROOF_MISSING'],
      proof: null,
    });
  });

  it('permite credencial API para perfil que aceita qualquer credencial verificada', () => {
    expect(
      decideCredentialProof(
        CredentialRequirement.VERIFIED_CREDENTIAL,
        fakeProof(CredentialProofStatus.API_VERIFIED),
      ),
    ).toMatchObject({ decision: 'ALLOW', reasons: ['API_VERIFIED'] });
  });

  it('trata prova malformada como BLOCK e não ecoa a entrada', () => {
    const decision = decideCredentialProof(CredentialRequirement.SUBSCRIPTION, {
      ...fakeProof(CredentialProofStatus.SUBSCRIPTION_VERIFIED),
      raw_output: 'sk-fake-secret',
    });

    expect(decision).toMatchObject({
      decision: 'BLOCK',
      reasons: ['PROOF_INVALID'],
      proof: null,
    });
    expect(JSON.stringify(decision)).not.toContain('sk-fake-secret');
  });

  it('não exige credencial quando ela é explicitamente não aplicável', () => {
    expect(
      decideCredentialProof(
        CredentialRequirement.NONE,
        fakeProof(CredentialProofStatus.NOT_APPLICABLE),
      ),
    ).toMatchObject({ decision: 'ALLOW', reasons: ['CREDENTIAL_NOT_REQUIRED'] });
  });
});
