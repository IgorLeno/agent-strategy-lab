import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderAdapter } from '../../src/adapters/index.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import {
  BillingGuardBlockedError,
  decideExecutionAuthorization,
  executeWithAdapter,
  type RealExecutionAuthorization,
} from '../../src/runner/index.js';

function authorization(
  overrides: {
    authorization?: RealExecutionAuthorization['authorization']['value'];
    billingMode?: RealExecutionAuthorization['billing_mode']['value'];
    quota?: RealExecutionAuthorization['quota']['availability']['value'];
    remaining?: number | null;
    apiEquivalent?: number | null;
    projectedCharge?: number | null;
    actualCharge?: number | null;
    actualChargeAuthoritative?: boolean;
    budget?: number | null;
  } = {},
): RealExecutionAuthorization {
  return {
    authorization: {
      value: overrides.authorization === undefined ? 'AUTHORIZED' : overrides.authorization,
      provenance: 'fake_auth_probe',
    },
    billing_mode: {
      value: overrides.billingMode === undefined ? 'SUBSCRIPTION' : overrides.billingMode,
      provenance: 'fake_profile',
    },
    quota: {
      availability: {
        value: overrides.quota === undefined ? 'SUFFICIENT' : overrides.quota,
        provenance: 'fake_quota_probe',
      },
      remaining: {
        value: overrides.remaining === undefined ? 80 : overrides.remaining,
        provenance: 'fake_quota_probe',
      },
      unit: 'percent',
    },
    cost: {
      api_equivalent_usd: {
        value: overrides.apiEquivalent === undefined ? null : overrides.apiEquivalent,
        provenance: 'fake_provider_estimate',
      },
      projected_incremental_charge_usd: {
        value: overrides.projectedCharge === undefined ? null : overrides.projectedCharge,
        provenance: 'fake_billing_projection',
      },
      actual_incremental_charge_usd: {
        value: overrides.actualCharge === undefined ? null : overrides.actualCharge,
        provenance: 'fake_billing_record',
      },
      actual_incremental_charge_authoritative:
        overrides.actualChargeAuthoritative === undefined
          ? false
          : overrides.actualChargeAuthoritative,
    },
    budget: {
      maximum_incremental_charge_usd: {
        value: overrides.budget === undefined ? null : overrides.budget,
        provenance: 'fake_run_policy',
      },
    },
  };
}

describe('decideExecutionAuthorization', () => {
  it('bloqueia execução real sem evidência e registra unknown sem convertê-lo em zero', () => {
    expect(decideExecutionAuthorization('REAL_INFERENCE')).toEqual({
      decision: 'BLOCK',
      execution_kind: 'REAL_INFERENCE',
      policy: { id: 'agentlab-real-execution-billing-guard', version: 1 },
      reasons: ['AUTHORIZATION_UNKNOWN', 'BILLING_MODE_UNKNOWN', 'QUOTA_UNKNOWN'],
      evidence: null,
    });
  });

  it('bloqueia autorização negada e quota conhecida como insuficiente', () => {
    const decision = decideExecutionAuthorization(
      'REAL_INFERENCE',
      authorization({ authorization: 'DENIED', quota: 'INSUFFICIENT', remaining: 0 }),
    );

    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasons).toContain('AUTHORIZATION_DENIED');
    expect(decision.reasons).toContain('QUOTA_INSUFFICIENT');
    expect(decision.evidence?.quota.remaining.value).toBe(0);
  });

  it('mantém quota desconhecida como null e permite assinatura autorizada', () => {
    const decision = decideExecutionAuthorization(
      'REAL_INFERENCE',
      authorization({ quota: null, remaining: null, apiEquivalent: 12.5 }),
    );

    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasons).toContain('QUOTA_UNKNOWN');
    expect(decision.evidence?.quota.remaining.value).toBeNull();
    expect(decision.evidence?.cost.api_equivalent_usd.value).toBe(12.5);
    expect(decision.evidence?.cost.actual_incremental_charge_usd.value).toBeNull();
  });

  it('não usa API-equivalent como cobrança projetada para liberar modo API', () => {
    const decision = decideExecutionAuthorization(
      'REAL_INFERENCE',
      authorization({ billingMode: 'API', apiEquivalent: 0.01, projectedCharge: null, budget: 10 }),
    );

    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasons).toContain('API_PROJECTED_CHARGE_UNKNOWN');
    expect(decision.reasons).not.toContain('API_PROJECTED_CHARGE_WITHIN_BUDGET');
  });

  it('permite modo API somente com projeção incremental dentro de budget conhecido', () => {
    const decision = decideExecutionAuthorization(
      'REAL_INFERENCE',
      authorization({ billingMode: 'API', apiEquivalent: 99, projectedCharge: 2, budget: 3 }),
    );

    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasons).toContain('API_PROJECTED_CHARGE_WITHIN_BUDGET');
  });

  it('bloqueia modo API acima do budget', () => {
    const decision = decideExecutionAuthorization(
      'REAL_INFERENCE',
      authorization({ billingMode: 'API', projectedCharge: 4, budget: 3 }),
    );

    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasons).toContain('API_PROJECTED_CHARGE_EXCEEDS_BUDGET');
  });

  it('bloqueia valor de cobrança real sem fonte marcada como autoritativa', () => {
    const decision = decideExecutionAuthorization(
      'REAL_INFERENCE',
      authorization({ actualCharge: 1, actualChargeAuthoritative: false }),
    );

    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasons).toContain('NON_AUTHORITATIVE_ACTUAL_CHARGE');
  });

  it('fixture é explicitamente não real e não exige evidência de billing', () => {
    expect(decideExecutionAuthorization('FIXTURE')).toEqual({
      decision: 'ALLOW',
      execution_kind: 'FIXTURE',
      policy: { id: 'agentlab-real-execution-billing-guard', version: 1 },
      reasons: ['NON_REAL_FIXTURE'],
      evidence: null,
    });
  });
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('executeWithAdapter billing boundary', () => {
  it('BLOCK acontece antes do spawn até para uma invocation fake local', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-billing-guard-test-'));
    temporaryRoots.push(root);
    const marker = path.join(root, 'spawned');
    const fakeRealAdapter: ProviderAdapter = {
      identity: { name: 'fake-real-provider', version: '1.0.0' },
      executionKind: 'REAL_INFERENCE',
      buildInvocation: () => ({ argv: [] }),
      parseLine: () => ({ event: { type: 'unknown', raw: '' } }),
    };

    const promise = executeWithAdapter(fakeRealAdapter, {
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      cwd: root,
      manifest: manifest(),
      gracePeriodMs: 20,
    });

    await expect(promise).rejects.toBeInstanceOf(BillingGuardBlockedError);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function manifest(): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  const budgets = {
    duration_ms: { expected: 1_000, maximum: 2_000 },
    tokens: { expected: 10, maximum: 20 },
    changed_files: { expected: 1, maximum: 2 },
  };
  return {
    task_spec: {
      id: 'fake-task',
      description: 'Exercitar a billing guard sem provider real.',
      visible_criteria: ['nenhum spawn quando BLOCK'],
      task_class: 'test',
      difficulty: 'trivial',
      stack: ['typescript'],
      public_graders: ['fake'],
      budgets,
    },
    strategy: { name: 'fake', version: 1, prompt: 'fake' },
    compiled_prompt: 'fake',
    base_sha: 'a'.repeat(40),
    agent_profile: {
      id: 'fake-agent',
      cli: 'fake',
      cli_version: '1.0.0',
      model: 'fake',
      flags: [],
    },
    environment_profile: {
      id: 'fake-environment',
      mode: 'controlled',
      home: 'sanitized',
      env_allowlist: [],
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    budgets,
    timeout_ms: 1_000,
  };
}
