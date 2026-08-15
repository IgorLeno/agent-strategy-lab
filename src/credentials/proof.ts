import { z } from 'zod';

/**
 * Resultado provider-neutral de uma verificação de credencial.
 *
 * O status registra somente a conclusão sanitizada. Saída bruta da CLI,
 * tokens, chaves e identificadores de conta não fazem parte deste contrato e
 * portanto não podem ser persistidos por meio dele.
 */
export enum CredentialProofStatus {
  SUBSCRIPTION_VERIFIED = 'SUBSCRIPTION_VERIFIED',
  API_VERIFIED = 'API_VERIFIED',
  UNKNOWN = 'UNKNOWN',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
}

/** Como o verificador chegou à conclusão, nunca o material da credencial. */
export enum CredentialProofMethod {
  LOCAL_CLI_STATUS = 'LOCAL_CLI_STATUS',
  ADAPTER_DECLARATION = 'ADAPTER_DECLARATION',
  FIXTURE = 'FIXTURE',
}

const identifier = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/,
    'deve ser um identificador opaco, não saída bruta do provider',
  );

export const CredentialProofProvenance = z
  .object({
    method: z.nativeEnum(CredentialProofMethod),
    /** Id do probe/verificador; não inclui comando, resposta, conta ou segredo. */
    verifier_id: identifier,
  })
  .strict();
export type CredentialProofProvenance = z.infer<typeof CredentialProofProvenance>;

export const CredentialProof = z
  .object({
    provider_id: identifier,
    status: z.nativeEnum(CredentialProofStatus),
    provenance: CredentialProofProvenance,
  })
  .strict();
export type CredentialProof = z.infer<typeof CredentialProof>;

/** Requisito do perfil, separado de billing mode e de disponibilidade de quota. */
export enum CredentialRequirement {
  SUBSCRIPTION = 'SUBSCRIPTION',
  VERIFIED_CREDENTIAL = 'VERIFIED_CREDENTIAL',
  NONE = 'NONE',
}

export type CredentialProofDecisionKind = 'ALLOW' | 'BLOCK';

export type CredentialProofReasonCode =
  | 'CREDENTIAL_NOT_REQUIRED'
  | 'SUBSCRIPTION_VERIFIED'
  | 'API_VERIFIED'
  | 'API_NOT_ALLOWED'
  | 'PROOF_UNKNOWN'
  | 'PROOF_NOT_APPLICABLE'
  | 'PROOF_MISSING'
  | 'PROOF_INVALID';

export interface CredentialProofDecision {
  readonly decision: CredentialProofDecisionKind;
  readonly requirement: CredentialRequirement;
  readonly policy: {
    readonly id: 'agentlab-credential-proof';
    readonly version: 1;
  };
  readonly reasons: readonly CredentialProofReasonCode[];
  /** Somente o contrato sanitizado validado; entrada inválida nunca é ecoada. */
  readonly proof: CredentialProof | null;
}

/**
 * Decide sem I/O e sem consultar billing ou quota. Em particular, a falta de
 * variáveis de API não é uma entrada e jamais produz prova de assinatura.
 */
export function decideCredentialProof(
  requirement: CredentialRequirement,
  candidate?: unknown,
): CredentialProofDecision {
  const policy = { id: 'agentlab-credential-proof', version: 1 } as const;

  if (candidate === undefined) {
    return requirement === CredentialRequirement.NONE
      ? {
          decision: 'ALLOW',
          requirement,
          policy,
          reasons: ['CREDENTIAL_NOT_REQUIRED'],
          proof: null,
        }
      : {
          decision: 'BLOCK',
          requirement,
          policy,
          reasons: ['PROOF_MISSING'],
          proof: null,
        };
  }

  const parsed = CredentialProof.safeParse(candidate);
  if (!parsed.success) {
    return {
      decision: 'BLOCK',
      requirement,
      policy,
      reasons: ['PROOF_INVALID'],
      proof: null,
    };
  }

  const proof = parsed.data;
  if (requirement === CredentialRequirement.NONE) {
    return {
      decision: 'ALLOW',
      requirement,
      policy,
      reasons: ['CREDENTIAL_NOT_REQUIRED'],
      proof,
    };
  }

  switch (proof.status) {
    case CredentialProofStatus.SUBSCRIPTION_VERIFIED:
      return {
        decision: 'ALLOW',
        requirement,
        policy,
        reasons: ['SUBSCRIPTION_VERIFIED'],
        proof,
      };
    case CredentialProofStatus.API_VERIFIED:
      return requirement === CredentialRequirement.SUBSCRIPTION
        ? {
            decision: 'BLOCK',
            requirement,
            policy,
            reasons: ['API_NOT_ALLOWED'],
            proof,
          }
        : {
            decision: 'ALLOW',
            requirement,
            policy,
            reasons: ['API_VERIFIED'],
            proof,
          };
    case CredentialProofStatus.UNKNOWN:
      return {
        decision: 'BLOCK',
        requirement,
        policy,
        reasons: ['PROOF_UNKNOWN'],
        proof,
      };
    case CredentialProofStatus.NOT_APPLICABLE:
      return {
        decision: 'BLOCK',
        requirement,
        policy,
        reasons: ['PROOF_NOT_APPLICABLE'],
        proof,
      };
  }
}
