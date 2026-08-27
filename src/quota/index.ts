/**
 * Observação de capacidade de pools de quota. Medição, nunca autorização:
 * folga baixa é evidência de routing; só esgotamento declarado pelo provider
 * torna um pool indisponível.
 */
export {
  CapacityPrecision,
  CapacityStatus,
  CapacityBalance,
  CapacityWindow,
  PoolCapacityObservation,
  poolUnavailable,
  remainingPercentOf,
  unknownCapacity,
  windowDeltas,
  type WindowDelta,
} from './observation.js';
export {
  SealedCredential,
  accountFingerprint,
  defaultCredentialPaths,
  loadCodexChatGptCredential,
  loadOpenCodeGoCredential,
  loadOpenCodeOpenAiCredential,
  loadOpenRouterCredential,
  sameChatGptAccount,
  type CredentialLookup,
  type CredentialPaths,
} from './credentials.js';
export {
  OPENAI_USAGE_ENDPOINT,
  OPENCODE_GO_USAGE_ENDPOINT,
  OPENROUTER_CREDITS_ENDPOINT,
  anthropicCapacityOf,
  probeOpenAiSubscriptionQuota,
  probeOpenCodeGoQuota,
  probeOpenRouterBalance,
  type AnthropicWindowReading,
  type ProbeFetch,
  type ProbeOptions,
} from './probes.js';
