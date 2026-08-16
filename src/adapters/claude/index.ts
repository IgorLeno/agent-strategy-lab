import {
  CredentialRequirement,
  decideCredentialProof,
} from '../../credentials/index.js';
import type {
  AdapterPreflightOptions,
  ProviderAdapter,
} from '../contract.js';
import { buildClaudeInvocation, CLAUDE_ADAPTER_IDENTITY } from './invocation.js';
import { parseClaudeLine } from './parser.js';

/**
 * Adapter completo da Claude CLI. Compõe apenas comportamento específico do
 * provider; coleta de credencial e todo o runtime de processos ficam fora.
 */
export const claudeAdapter = {
  identity: CLAUDE_ADAPTER_IDENTITY,
  executionKind: 'REAL_INFERENCE',
  preflight(options: AdapterPreflightOptions) {
    return decideCredentialProof(
      CredentialRequirement.SUBSCRIPTION,
      options.credentialProof,
    );
  },
  buildInvocation: buildClaudeInvocation,
  parseLine: parseClaudeLine,
} satisfies ProviderAdapter;
