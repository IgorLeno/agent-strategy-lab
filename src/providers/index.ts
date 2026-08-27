/**
 * Identidade de provider: as dimensões que o campo `agent` confundia enquanto
 * só existiam dois scaffolds. Ver `identity.ts` para as invariantes impostas.
 */
export {
  AuthMethod,
  BillingMode as ProviderBillingMode,
  ExecutionScaffold,
  PROVIDER_CONTRACTS,
  ProviderIdentity,
  ProviderIdentityError,
  QuotaPool,
  UpstreamProvider,
  providerContractOf,
  providerIdentityOf,
  requiresExplicitSpendAuthorization,
  sharesQuotaPool,
} from './identity.js';
export {
  SCAFFOLD_BY_AGENT,
  legacyBillingAgrees,
  resolveProfileIdentity,
  type LegacyAgent,
  type LegacyBillingMode,
  type ProfileIdentityInput,
  type ProfileIdentityResolution,
} from './normalize.js';
