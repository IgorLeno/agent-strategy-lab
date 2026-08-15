/** Provider-neutral credential proof, kept separate from billing and quota. */
export {
  CredentialProof,
  CredentialProofMethod,
  CredentialProofProvenance,
  CredentialProofStatus,
  CredentialRequirement,
  decideCredentialProof,
  type CredentialProofDecision,
  type CredentialProofDecisionKind,
  type CredentialProofReasonCode,
} from './proof.js';
