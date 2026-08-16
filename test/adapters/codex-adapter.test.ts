import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildCodexInvocation,
  claudeAdapter,
  codexAdapter,
  fakeAdapter,
  parseCodexLine,
  resolveAdapter,
} from '../../src/adapters/index.js';
import type { RealExecutionAuthorization } from '../../src/billing/index.js';
import { ExecutionStatus } from '../../src/core/index.js';
import {
  CredentialProofMethod,
  CredentialProofStatus,
} from '../../src/credentials/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import { executeWithAdapter } from '../../src/runner/index.js';

const budgets = {
  duration_ms: { expected: 1_000, maximum: 60_000 },
  tokens: { expected: 100, maximum: 1_000 },
  changed_files: { expected: 1, maximum: 5 },
};
const FAKE_CODEX_STREAM = path.resolve(
  import.meta.dirname,
  '../../fixtures/fake-codex-stream.mjs',
);

function manifest(): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  return {
    task_spec: {
      id: 'codex-adapter-smoke',
      description: 'Smoke local do parser Codex sem inferência.',
      visible_criteria: ['preserva observation terminal'],
      task_class: 'test',
      difficulty: 'trivial',
      stack: ['typescript'],
      public_graders: ['unit-test'],
      budgets,
    },
    strategy: { name: 'direct', version: 1, prompt: 'fixture local' },
    compiled_prompt: 'fixture local',
    base_sha: 'a'.repeat(40),
    agent_profile: {
      id: 'codex-fixture',
      cli: 'codex',
      cli_version: 'fixture',
      model: 'fixture',
      flags: [],
    },
    environment_profile: {
      id: 'codex-fixture',
      mode: 'controlled',
      home: 'sanitized',
      env_allowlist: [],
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    budgets,
    timeout_ms: 60_000,
  };
}

function subscriptionAuthorization(): RealExecutionAuthorization {
  const evidence = <T>(value: T | null) => ({ value, provenance: 'codex-fixture' });
  return {
    authorization: evidence('AUTHORIZED'),
    billing_mode: evidence('SUBSCRIPTION'),
    quota: { availability: evidence('SUFFICIENT'), remaining: evidence(null), unit: null },
    cost: {
      api_equivalent_usd: evidence(null),
      projected_incremental_charge_usd: evidence(null),
      actual_incremental_charge_usd: evidence(null),
      actual_incremental_charge_authoritative: false,
    },
    budget: { maximum_incremental_charge_usd: evidence(null) },
  };
}

describe('Codex ProviderAdapter', () => {
  it('é registrado pela cli codex sem alterar Claude ou fake', () => {
    expect(resolveAdapter('codex')).toBe(codexAdapter);
    expect(resolveAdapter('claude')).toBe(claudeAdapter);
    expect(resolveAdapter('fake')).toBe(fakeAdapter);
    expect(() => resolveAdapter('desconhecido')).toThrow(/codex/);
  });

  it('compõe identidade, invocation e parser sem duplicar o runtime comum', () => {
    expect(codexAdapter.identity).toEqual({ name: 'codex', version: '1.0.0' });
    expect(codexAdapter.executionKind).toBe('REAL_INFERENCE');
    expect(codexAdapter.buildInvocation).toBe(buildCodexInvocation);
    expect(codexAdapter.parseLine).toBe(parseCodexLine);
    expect(codexAdapter).not.toHaveProperty('execute');
  });

  it('integra o mesmo preflight de assinatura sem chamar a CLI', () => {
    expect(
      codexAdapter.preflight({
        credentialProof: {
          provider_id: 'codex',
          status: CredentialProofStatus.SUBSCRIPTION_VERIFIED,
          provenance: {
            method: CredentialProofMethod.LOCAL_CLI_STATUS,
            verifier_id: 'codex-login-status-v1',
          },
        },
      }),
    ).toMatchObject({
      decision: 'ALLOW',
      requirement: 'SUBSCRIPTION',
      reasons: ['SUBSCRIPTION_VERIFIED'],
    });
    expect(codexAdapter.preflight({})).toMatchObject({
      decision: 'BLOCK',
      reasons: ['PROOF_MISSING'],
    });
  });

  it('mantém failure do provider como observation enquanto o processo concluído é COMPLETED', async () => {
    const run = await executeWithAdapter(codexAdapter, {
      argv: [process.execPath, FAKE_CODEX_STREAM],
      cwd: process.cwd(),
      manifest: manifest(),
      gracePeriodMs: 200,
      realExecutionAuthorization: subscriptionAuthorization(),
    });

    expect(run.record.status).toBe(ExecutionStatus.COMPLETED);
    expect(run.parsedLines.at(-1)?.observation).toEqual({
      usage: { tokens: null },
      terminal: 'failure',
    });
  });
});
