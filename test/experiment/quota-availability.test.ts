/**
 * Ponte QuotaUsage + ExperimentBillingPolicy → quota.availability.
 *
 * A guarda (M54) só consome availability já decidida; estes testes provam o
 * consumidor da política experimental que faltava em M68, sem chamar provider
 * real e sem alterar o kernel provider-neutral (quota ausente continua null).
 */
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { ProviderAdapter } from '../../src/adapters/index.js';
import {
  BillingGuardBlockedError,
  decideExecutionAuthorization,
  type RealExecutionAuthorization,
} from '../../src/billing/index.js';
import { ExecutionStatus } from '../../src/core/enums.js';
import type { ExecutionEnvelopeManifest } from '../../src/envelope/index.js';
import {
  decideExperimentSlotAuthorization,
  deriveQuotaAvailability,
  freezeExperimentSpec,
  materializeSlotOrder,
  runExperimentSchedule,
  type FrozenExperimentSpec,
} from '../../src/experiment/index.js';
import { executeWithAdapter } from '../../src/runner/index.js';
import {
  QuotaObservationStatus,
  QuotaReasonCode,
  type AgentProfile,
  type EnvironmentProfile,
  type ExperimentBillingPolicy,
  type QuotaUsage,
  type QuotaWindow,
  type TaskSpec,
} from '../../src/schemas/index.js';

const POLICY: ExperimentBillingPolicy = {
  billing_mode: 'SUBSCRIPTION',
  max_incremental_charge_usd: null,
  quota_stop_threshold_pct: 80,
};

function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    window_id: 'five_hour',
    before_used_pct: 10,
    after_used_pct: 25,
    consumed_pp: 15,
    same_window: true,
    reason_code: QuotaReasonCode.OK,
    provenance: 'fixture_quota_window',
    ...overrides,
  };
}

function usage(overrides: Partial<QuotaUsage> = {}): QuotaUsage {
  return {
    provider: 'claude',
    observation: {
      status: QuotaObservationStatus.OBSERVED,
      reason_code: QuotaReasonCode.OK,
      provenance: 'fixture_quota_probe',
    },
    windows: [window()],
    ...overrides,
  };
}

function authorizedSubscription(quota: RealExecutionAuthorization['quota']): RealExecutionAuthorization {
  return {
    authorization: { value: 'AUTHORIZED', provenance: 'fixture_auth' },
    billing_mode: { value: 'SUBSCRIPTION', provenance: 'fixture_profile' },
    quota,
    cost: {
      api_equivalent_usd: { value: null, provenance: 'fixture_cost' },
      projected_incremental_charge_usd: { value: null, provenance: 'fixture_cost' },
      actual_incremental_charge_usd: { value: null, provenance: 'fixture_cost' },
      actual_incremental_charge_authoritative: false,
    },
    budget: { maximum_incremental_charge_usd: { value: null, provenance: 'fixture_budget' } },
  };
}

const budgets = {
  duration_ms: { expected: 120_000, maximum: 300_000 },
  tokens: { expected: 8_000, maximum: 20_000 },
  changed_files: { expected: 1, maximum: 4 },
};

function task(id: string): TaskSpec {
  return {
    id,
    description: `Tarefa ${id}.`,
    visible_criteria: ['Critério único.'],
    task_class: 'feature',
    difficulty: 'medium',
    stack: ['javascript'],
    public_graders: ['node-public-tests'],
    budgets,
  };
}

function agentProfile(id: string, effort: string, cli = 'claude'): AgentProfile {
  return {
    id,
    cli,
    cli_version: '2.1.223',
    model: 'claude-sonnet-5',
    flags: ['--effort', effort],
  };
}

function environmentProfile(): Extract<EnvironmentProfile, { mode: 'controlled' }> {
  return {
    id: 'controlled-clean-room',
    mode: 'controlled',
    env_allowlist: ['PATH', 'LANG'],
    home: 'sanitized',
    instruction_files: [],
    plugins: [],
    skills: [],
    mcp_servers: [],
  };
}

function buildFrozen(): FrozenExperimentSpec {
  return freezeExperimentSpec({
    schema_version: 1,
    id: 'quota-enforcement-fixture',
    arms: [
      { id: 'medium', agent_profile: agentProfile('medium', 'medium') },
      { id: 'high', agent_profile: agentProfile('high', 'high') },
    ],
    tasks: [task('a')],
    repetitions_per_arm_task: 1,
    ordering: { scheme: 'seeded_interleaved_counterbalanced' as const, seed: 'quota-enforcement' },
    strategy: { name: 'direct', version: 1, prompt: 'Implemente diretamente.' },
    environment_profile: environmentProfile(),
    billing_policy: POLICY,
    planned_slot_count: 2,
  });
}

describe('deriveQuotaAvailability', () => {
  it('deriva SUFFICIENT quando a utilização observada relevante está abaixo do threshold', () => {
    const derived = deriveQuotaAvailability(
      usage({ windows: [window({ after_used_pct: 79.9, consumed_pp: 69.9 })] }),
      POLICY,
    );

    expect(derived.availability.value).toBe('SUFFICIENT');
    expect(derived.remaining.value).toBeCloseTo(20.1);
    expect(derived.unit).toBe('percent');
  });

  it('deriva INSUFFICIENT quando a utilização observada está exatamente no threshold', () => {
    const derived = deriveQuotaAvailability(
      usage({ windows: [window({ after_used_pct: 80, consumed_pp: 70 })] }),
      POLICY,
    );

    expect(derived.availability.value).toBe('INSUFFICIENT');
    expect(derived.remaining.value).toBe(20);
  });

  it('deriva INSUFFICIENT quando a utilização observada está acima do threshold', () => {
    const derived = deriveQuotaAvailability(
      usage({ windows: [window({ after_used_pct: 81, consumed_pp: 71 })] }),
      POLICY,
    );

    expect(derived.availability.value).toBe('INSUFFICIENT');
  });

  it('UNAVAILABLE nunca vira zero silenciosamente', () => {
    const derived = deriveQuotaAvailability(
      usage({
        observation: {
          status: QuotaObservationStatus.UNAVAILABLE,
          reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
          provenance: 'probe_failed_without_reading',
        },
        windows: [],
      }),
      POLICY,
    );

    expect(derived.availability.value).toBeNull();
    expect(derived.remaining.value).toBeNull();
    expect(derived.unit).toBeNull();
    expect(derived.availability.provenance).toBe('probe_failed_without_reading');
    expect(derived.remaining.provenance).toBe('probe_failed_without_reading');
  });

  it('não soma janelas incompatíveis nem consumed_pp entre window_id distintos', () => {
    const derived = deriveQuotaAvailability(
      usage({
        windows: [
          window({
            window_id: 'five_hour',
            after_used_pct: 40,
            consumed_pp: 40,
          }),
          window({
            window_id: 'seven_day_all_models',
            after_used_pct: 50,
            consumed_pp: 50,
          }),
        ],
      }),
      POLICY,
    );

    expect(derived.availability.value).toBe('SUFFICIENT');
    expect(derived.remaining.value).toBe(50);
  });

  it('janela com same_window false não usa before_used_pct da instância anterior', () => {
    const derived = deriveQuotaAvailability(
      usage({
        windows: [
          window({
            before_used_pct: 95,
            after_used_pct: null,
            consumed_pp: null,
            same_window: false,
            reason_code: QuotaReasonCode.RATE_LIMIT_WINDOW_RESET,
          }),
        ],
      }),
      POLICY,
    );

    expect(derived.availability.value).toBeNull();
    expect(derived.remaining.value).toBeNull();
  });

  it('missing/null permanece semanticamente ausente, sem converter em zero', () => {
    for (const missing of [null, undefined]) {
      const derived = deriveQuotaAvailability(missing, POLICY);
      expect(derived.availability.value).toBeNull();
      expect(derived.remaining.value).toBeNull();
      expect(derived.unit).toBeNull();
      expect(derived.availability.provenance.length).toBeGreaterThan(0);
    }
  });

  it('OBSERVED sem janela comparável permanece ausente, não 0%', () => {
    const derived = deriveQuotaAvailability(
      usage({
        windows: [
          window({
            before_used_pct: null,
            after_used_pct: null,
            consumed_pp: null,
            same_window: null,
            reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
          }),
        ],
      }),
      POLICY,
    );

    expect(derived.availability.value).toBeNull();
    expect(derived.remaining.value).toBeNull();
  });

  it('usa before_used_pct quando after está ausente na mesma janela (snapshot pré-launch)', () => {
    const derived = deriveQuotaAvailability(
      usage({
        windows: [
          window({
            before_used_pct: 79,
            after_used_pct: null,
            consumed_pp: null,
            same_window: true,
          }),
        ],
      }),
      POLICY,
    );

    expect(derived.availability.value).toBe('SUFFICIENT');
    expect(derived.remaining.value).toBe(21);
  });

  it('não compara consumed_pp contra o threshold: delta alto com used_pct baixo permanece SUFFICIENT', () => {
    const derived = deriveQuotaAvailability(
      usage({
        windows: [window({ before_used_pct: 0, after_used_pct: 10, consumed_pp: 90 })],
      }),
      POLICY,
    );

    expect(derived.availability.value).toBe('SUFFICIENT');
  });
});

describe('decideExperimentSlotAuthorization', () => {
  it('INSUFFICIENT derivado leva o BillingGuard existente a BLOCK', () => {
    const decision = decideExperimentSlotAuthorization(
      'REAL_INFERENCE',
      authorizedSubscription({
        availability: { value: null, provenance: 'placeholder' },
        remaining: { value: null, provenance: 'placeholder' },
        unit: null,
      }),
      usage({ windows: [window({ after_used_pct: 80, consumed_pp: 5 })] }),
      POLICY,
    );

    expect(decision.decision).toBe('BLOCK');
    expect(decision.reasons).toContain('QUOTA_INSUFFICIENT');
    expect(decision.evidence?.quota.availability.value).toBe('INSUFFICIENT');
  });

  it('UNAVAILABLE permanece QUOTA_UNKNOWN e não reescreve a política da guarda para BLOCK', () => {
    const decision = decideExperimentSlotAuthorization(
      'REAL_INFERENCE',
      authorizedSubscription({
        availability: { value: 'SUFFICIENT', provenance: 'stale_claim' },
        remaining: { value: 100, provenance: 'stale_claim' },
        unit: 'percent',
      }),
      usage({
        observation: {
          status: QuotaObservationStatus.UNAVAILABLE,
          reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
          provenance: 'probe_unavailable',
        },
        windows: [],
      }),
      POLICY,
    );

    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasons).toContain('QUOTA_UNKNOWN');
    expect(decision.evidence?.quota.availability.value).toBeNull();
    expect(decision.evidence?.quota.remaining.value).toBeNull();
  });

  it('FIXTURE continua ALLOW mesmo com quota no threshold', () => {
    const decision = decideExperimentSlotAuthorization(
      'FIXTURE',
      authorizedSubscription({
        availability: { value: null, provenance: 'unused' },
        remaining: { value: null, provenance: 'unused' },
        unit: null,
      }),
      usage({ windows: [window({ after_used_pct: 99, consumed_pp: 1 })] }),
      POLICY,
    );

    expect(decision.decision).toBe('ALLOW');
    expect(decision.reasons).toEqual(['NON_REAL_FIXTURE']);
  });
});

describe('runExperimentSchedule — enforcement da política de quota antes do launch', () => {
  it('bloqueia o próximo launch ANTES do spawn quando a quota atinge o threshold', async () => {
    const frozen = buildFrozen();
    const executed: string[] = [];
    const observedSlots: string[] = [];

    const result = await runExperimentSchedule({
      frozen,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
      authorizeSlot: () =>
        decideExecutionAuthorization(
          'REAL_INFERENCE',
          authorizedSubscription({
            availability: { value: null, provenance: 'not_yet_derived' },
            remaining: { value: null, provenance: 'not_yet_derived' },
            unit: null,
          }),
        ),
      observeQuota: (slot) => {
        observedSlots.push(slot.slot_id);
        return usage({ windows: [window({ after_used_pct: 80, consumed_pp: 2 })] });
      },
    });

    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.decision).toBe('BLOCK');
    expect(result.blockedDecision?.reasons).toContain('QUOTA_INSUFFICIENT');
    expect(executed).toEqual([]);
    expect(observedSlots).toHaveLength(1);
    expect(result.remainingSlots).toHaveLength(2);
  });

  it('retry consulta novamente a política de quota antes de lançar', async () => {
    const frozen = buildFrozen();
    const firstSlotId = materializeSlotOrder(frozen)[0]?.slot_id;
    const executed: string[] = [];
    const observedKinds: string[] = [];

    const result = await runExperimentSchedule({
      frozen,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return slot.slot_id === firstSlotId ? ExecutionStatus.INFRA_ERROR : ExecutionStatus.COMPLETED;
      },
      authorizeSlot: () =>
        decideExecutionAuthorization(
          'REAL_INFERENCE',
          authorizedSubscription({
            availability: { value: null, provenance: 'not_yet_derived' },
            remaining: { value: null, provenance: 'not_yet_derived' },
            unit: null,
          }),
        ),
      observeQuota: (slot) => {
        observedKinds.push(slot.kind);
        const usedPct = slot.kind === 'RETRY' ? 80 : 70;
        return usage({ windows: [window({ after_used_pct: usedPct, consumed_pp: 1 })] });
      },
    });

    expect(observedKinds).toContain('RETRY');
    expect(executed.every((slotId) => !slotId.includes(':retry:'))).toBe(true);
    expect(result.launches.some((launch) => launch.slot.kind === 'RETRY')).toBe(false);
    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.reasons).toContain('QUOTA_INSUFFICIENT');
  });

  it('sem observeQuota, fixtures e demais billing modes existentes continuam válidos', async () => {
    const frozen = buildFrozen();
    const result = await runExperimentSchedule({
      frozen,
      executeSlot: () => ExecutionStatus.COMPLETED,
      authorizeSlot: () => decideExecutionAuthorization('FIXTURE'),
    });

    expect(result.stoppedByBillingGuard).toBe(false);
    expect(result.launches).toHaveLength(2);
    expect(result.launches.every((launch) => launch.status === ExecutionStatus.COMPLETED)).toBe(true);
  });
});

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('executeWithAdapter — BLOCK derivado ocorre antes do spawn', () => {
  it('não spawna processo quando a quota derivada é INSUFFICIENT', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-quota-availability-'));
    temporaryRoots.push(root);
    const marker = path.join(root, 'spawned');
    const adapter: ProviderAdapter = {
      identity: { name: 'fake-real-provider', version: '1.0.0' },
      executionKind: 'REAL_INFERENCE',
      buildInvocation: () => ({ argv: [] }),
      parseLine: () => ({ event: { type: 'unknown', raw: '' } }),
    };

    const decision = decideExperimentSlotAuthorization(
      'REAL_INFERENCE',
      authorizedSubscription({
        availability: { value: null, provenance: 'placeholder' },
        remaining: { value: null, provenance: 'placeholder' },
        unit: null,
      }),
      usage({ windows: [window({ after_used_pct: 80, consumed_pp: 1 })] }),
      POLICY,
    );

    expect(decision.evidence).not.toBeNull();
    if (decision.evidence === null) return;

    const promise = executeWithAdapter(adapter, {
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`],
      cwd: root,
      manifest: manifest(),
      gracePeriodMs: 20,
      realExecutionAuthorization: decision.evidence,
    });

    await expect(promise).rejects.toBeInstanceOf(BillingGuardBlockedError);
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

function manifest(): Omit<ExecutionEnvelopeManifest, 'adapter'> {
  const runBudgets = {
    duration_ms: { expected: 1_000, maximum: 2_000 },
    tokens: { expected: 10, maximum: 20 },
    changed_files: { expected: 1, maximum: 2 },
  };
  return {
    task_spec: {
      id: 'quota-block-task',
      description: 'Provar BLOCK de quota antes do spawn, sem provider real.',
      visible_criteria: ['nenhum spawn quando INSUFFICIENT'],
      task_class: 'test',
      difficulty: 'trivial',
      stack: ['typescript'],
      public_graders: ['fake'],
      budgets: runBudgets,
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
    budgets: runBudgets,
    timeout_ms: 1_000,
  };
}
