import {
  CredentialRequirement,
  decideCredentialProof,
} from '../../credentials/index.js';
import type {
  AdapterPreflightOptions,
  ProviderAdapter,
} from '../contract.js';
import { buildCodexInvocation, CODEX_ADAPTER_IDENTITY } from './invocation.js';
import { parseCodexLine } from './parser.js';

/**
 * Adapter completo do Codex CLI. O runtime e a coleta da prova de credencial
 * continuam provider-neutral e vivem fora deste objeto.
 */
export const codexAdapter = {
  identity: CODEX_ADAPTER_IDENTITY,
  executionKind: 'REAL_INFERENCE',
  preflight(options: AdapterPreflightOptions) {
    return decideCredentialProof(
      CredentialRequirement.SUBSCRIPTION,
      options.credentialProof,
    );
  },
  buildInvocation: buildCodexInvocation,
  parseLine: parseCodexLine,
} satisfies ProviderAdapter;
