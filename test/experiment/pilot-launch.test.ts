/**
 * Caminho oficial do piloto (M70): Claude quota probe obrigatória, sem
 * provider real e sem autorização humana implícita. O fingerprint do
 * ExperimentSpec congelado (2 arms Medium vs High, 3 tasks, 2 repetitions,
 * 12 slots, seed/order/threshold existentes) é verificado contra
 * `buildPilotExperimentSpec` diretamente, nunca hardcoded aqui.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildClaudeQuotaInvocation,
  CLAUDE_QUOTA_PROMPT,
  type ClaudeQuotaCommandRunner,
} from '../../src/adapters/index.js';
import { decideExecutionAuthorization, type RealExecutionAuthorization } from '../../src/billing/index.js';
import { ExecutionStatus } from '../../src/core/enums.js';
import {
  bindOfficialPilotDependencies,
  buildPilotExperimentSpec,
  inspectOfficialPilot,
  OFFICIAL_PILOT_QUOTA_OBSERVER,
  runExperimentSchedule,
  runOfficialPilot,
  quotaUsageFromClaudePreLaunchProbe,
} from '../../src/experiment/index.js';
import { QuotaObservationStatus } from '../../src/schemas/index.js';

const REPO_ROOT = path.resolve('.');
const FIVE_HOUR = 'Aug 16, 7am (America/Sao_Paulo)';
const SEVEN_DAY = 'Aug 18, 3am (America/Sao_Paulo)';

function usageText(fiveHour: number, week = 10): string {
  return (
    `Current session: ${fiveHour}% used · resets ${FIVE_HOUR}\n` +
    `Current week (all models): ${week}% used · resets ${SEVEN_DAY}\n`
  );
}

function probeStdout(text: string): string {
  return JSON.stringify({
    is_error: false,
    total_cost_usd: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    result: text,
  });
}

function fakeProbe(usedPcts: number[]): {
  options: { binary: string; env: Record<string, never>; cwd: string; runner: ClaudeQuotaCommandRunner };
  calls: string[][];
} {
  const remaining = [...usedPcts];
  const calls: string[][] = [];
  const runner: ClaudeQuotaCommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    const used = remaining.length > 1 ? (remaining.shift() as number) : (remaining[0] as number);
    return { exitCode: 0, stdout: probeStdout(usageText(used)), stderr: '' };
  };
  return { options: { binary: 'claude-fixture', env: {}, cwd: '/', runner }, calls };
}

function unavailableProbe(): {
  options: { binary: string; env: Record<string, never>; cwd: string; runner: ClaudeQuotaCommandRunner };
  readonly calls: { value: number };
} {
  const calls = { value: 0 };
  return {
    options: {
      binary: 'claude-fixture',
      env: {},
      cwd: '/',
      runner: async () => {
        calls.value += 1;
        return { exitCode: 1, stdout: '', stderr: 'fixture indisponível' };
      },
    },
    calls,
  };
}

function humanAuthorization(): RealExecutionAuthorization {
  return {
    authorization: { value: 'AUTHORIZED', provenance: 'human_operator_fixture' },
    billing_mode: { value: 'SUBSCRIPTION', provenance: 'pilot_billing_policy' },
    quota: {
      availability: { value: null, provenance: 'not_yet_observed' },
      remaining: { value: null, provenance: 'not_yet_observed' },
      unit: null,
    },
    cost: {
      api_equivalent_usd: { value: null, provenance: 'subscription' },
      projected_incremental_charge_usd: { value: null, provenance: 'subscription' },
      actual_incremental_charge_usd: { value: null, provenance: 'subscription' },
      actual_incremental_charge_authoritative: false,
    },
    budget: { maximum_incremental_charge_usd: { value: null, provenance: 'subscription' } },
  };
}

describe('inspectOfficialPilot', () => {
  it('inspeciona o spec congelado sem autorizar e sem executar slots', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const inspection = await inspectOfficialPilot(REPO_ROOT);

    expect(inspection.hash).toBe(frozen.hash);
    expect(inspection.planned_slot_count).toBe(12);
    expect(inspection.slot_ids).toHaveLength(12);
    expect(inspection.quota_stop_threshold_pct).toBe(80);
    expect(inspection.adapter_name).toBe('claude');
    expect(inspection.execution_kind).toBe('REAL_INFERENCE');
    expect(inspection.observe_quota).toBe(OFFICIAL_PILOT_QUOTA_OBSERVER);
    expect(inspection.authorizes_real_inference).toBe(false);
    expect(inspection.arm_ids).toEqual(['claude-sonnet-5-medium', 'claude-sonnet-5-high']);
  });
});

describe('bindOfficialPilotDependencies', () => {
  it('injeta a Claude quota observer e o adapter REAL_INFERENCE', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([10]);
    const bindings = bindOfficialPilotDependencies({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: probe.options,
    });

    expect(bindings.adapter.identity.name).toBe('claude');
    expect(bindings.adapter.executionKind).toBe('REAL_INFERENCE');
    expect(bindings.observeQuotaKind).toBe(OFFICIAL_PILOT_QUOTA_OBSERVER);
    expect(typeof bindings.observeQuota).toBe('function');
  });
});

describe('runOfficialPilot', () => {
  it('quota abaixo do threshold permite chegar ao executor; cada slot observa de novo', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([79.9, 40, 10]);
    const order: string[] = [];
    let executes = 0;

    const result = await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: {
        ...probe.options,
        runner: async (command, args, env, cwd) => {
          order.push('observe');
          expect(order.filter((item) => item === 'observe').length).toBeGreaterThan(executes);
          return probe.options.runner(command, args, env, cwd);
        },
      },
      executeSlot: (slot) => {
        executes += 1;
        order.push(`execute:${slot.slot_id}`);
        expect(order.filter((item) => item === 'observe').length).toBe(executes);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(frozen.spec.planned_slot_count).toBe(12);
    expect(result.observeQuotaKind).toBe(OFFICIAL_PILOT_QUOTA_OBSERVER);
    expect(result.adapterName).toBe('claude');
    expect(result.executionKind).toBe('REAL_INFERENCE');
    expect(result.stoppedByBillingGuard).toBe(false);
    expect(result.launches).toHaveLength(12);
    expect(result.quotaObservations).toHaveLength(12);
    expect(probe.calls).toHaveLength(12);
    expect(probe.calls[0]).toEqual(buildClaudeQuotaInvocation('claude-fixture'));
    expect(probe.calls[0]).toContain(CLAUDE_QUOTA_PROMPT);
    expect(executes).toBe(12);
    expect(order[0]).toBe('observe');
    expect(order[1]?.startsWith('execute:')).toBe(true);
  });

  it('não é possível executar um slot real sem passar pela checagem de quota', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([10]);
    let probes = 0;
    const executed: string[] = [];

    await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: {
        ...probe.options,
        runner: async (command, args, env, cwd) => {
          probes += 1;
          expect(executed).toHaveLength(probes - 1);
          return probe.options.runner(command, args, env, cwd);
        },
      },
      executeSlot: (slot) => {
        expect(probes).toBe(executed.length + 1);
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(executed).toHaveLength(12);
    expect(probes).toBe(12);
  });

  it('quota exatamente em 80% bloqueia antes do executor', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([80]);
    const executed: string[] = [];

    const result = await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: probe.options,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.reasons).toContain('QUOTA_INSUFFICIENT');
    expect(result.quotaObservations[0]?.availability).toBe('INSUFFICIENT');
    expect(executed).toEqual([]);
    expect(probe.calls).toHaveLength(1);
    expect(result.remainingSlots).toHaveLength(12);
  });

  it('quota acima de 80% bloqueia antes do executor', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([80.1]);
    const executed: string[] = [];

    const result = await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: probe.options,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.reasons).toContain('QUOTA_INSUFFICIENT');
    expect(executed).toEqual([]);
  });

  it('quota abaixo de 80% permite o executor', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([79]);
    const executed: string[] = [];

    const result = await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: probe.options,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(result.stoppedByBillingGuard).toBe(false);
    expect(executed).toHaveLength(12);
  });

  it('o segundo slot recebe uma nova observação de quota', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([10, 20]);
    const executed: string[] = [];

    await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: probe.options,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(probe.calls.length).toBeGreaterThanOrEqual(2);
    expect(executed[0]).not.toBe(executed[1]);
    expect(probe.calls[0]).not.toBe(probe.calls[1]);
  });

  it('retry recebe uma nova observação de quota e BLOCK não chama executeSlot', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const firstSlotId = (await inspectOfficialPilot(REPO_ROOT)).slot_ids[0];
    const remaining = [...Array(12).fill(10), 80];
    const executed: string[] = [];
    const calls: number[] = [];

    const result = await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: {
        binary: 'claude-fixture',
        env: {},
        cwd: '/',
        runner: async () => {
          const used = remaining.length > 1 ? (remaining.shift() as number) : (remaining[0] as number);
          calls.push(used);
          return { exitCode: 0, stdout: probeStdout(usageText(used)), stderr: '' };
        },
      },
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        if (slot.slot_id === firstSlotId) return ExecutionStatus.INFRA_ERROR;
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(calls.at(-1)).toBe(80);
    expect(calls).toHaveLength(13);
    expect(executed.some((slotId) => slotId.includes(':retry:'))).toBe(false);
    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.reasons).toContain('QUOTA_INSUFFICIENT');
    expect(result.quotaObservations.some((observation) => observation.slot.kind === 'RETRY')).toBe(true);
  });

  it('sem autorização humana não fabrica AUTHORIZED e não executa slot', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = fakeProbe([10]);
    const executed: string[] = [];

    const result = await runOfficialPilot({
      frozen,
      quotaProbe: probe.options,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(result.humanAuthorizationProvided).toBe(false);
    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.reasons).toContain('AUTHORIZATION_UNKNOWN');
    expect(executed).toEqual([]);
    expect(probe.calls).toHaveLength(0);
  });

  it('UNAVAILABLE permanece quota desconhecida, não SUFFICIENT fabricado, e é registrado', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const probe = unavailableProbe();
    const executed: string[] = [];

    const result = await runOfficialPilot({
      frozen,
      humanAuthorization: humanAuthorization(),
      quotaProbe: probe.options,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
    });

    expect(result.stoppedByBillingGuard).toBe(false);
    expect(result.quotaObservations[0]?.availability).toBeNull();
    expect(result.quotaObservations[0]?.usage.observation.status).toBe(QuotaObservationStatus.UNAVAILABLE);
    expect(executed).toHaveLength(12);
  });
});

describe('quotaUsageFromClaudePreLaunchProbe', () => {
  it('OBSERVED usa before_used_pct do snapshot pré-launch', () => {
    const usage = quotaUsageFromClaudePreLaunchProbe({
      status: QuotaObservationStatus.OBSERVED,
      reading: {
        five_hour: { used_pct: 79, reset_label: FIVE_HOUR },
        seven_day_all_models: { used_pct: 10, reset_label: SEVEN_DAY },
      },
      reason: null,
      provenance: 'fixture',
    });

    expect(usage.observation.status).toBe(QuotaObservationStatus.OBSERVED);
    expect(usage.windows[0]?.before_used_pct).toBe(79);
    expect(usage.windows[0]?.after_used_pct).toBeNull();
    expect(usage.windows[0]?.same_window).toBe(true);
  });
});

describe('runExperimentSchedule genérico', () => {
  it('continua funcionando sem observeQuota (fixtures)', async () => {
    const frozen = await buildPilotExperimentSpec(REPO_ROOT);
    const result = await runExperimentSchedule({
      frozen,
      executeSlot: () => ExecutionStatus.COMPLETED,
      authorizeSlot: () => decideExecutionAuthorization('FIXTURE'),
    });

    expect(result.stoppedByBillingGuard).toBe(false);
    expect(result.launches).toHaveLength(12);
  });
});
