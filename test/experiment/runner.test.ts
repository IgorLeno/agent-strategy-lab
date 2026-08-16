import { describe, expect, it } from 'vitest';

import { ExecutionStatus } from '../../src/core/enums.js';
import {
  freezeExperimentSpec,
  materializeSlotOrder,
  runExperimentSchedule,
  type FrozenExperimentSpec,
  type PlannedSlot,
} from '../../src/experiment/index.js';
import { decideExecutionAuthorization, type BillingGuardDecision } from '../../src/billing/index.js';
import type { AgentProfile, EnvironmentProfile, TaskSpec } from '../../src/schemas/index.js';

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

function agentProfile(id: string, effort: string): AgentProfile {
  return {
    id,
    cli: 'claude',
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

function buildFrozen(seed: string | number): FrozenExperimentSpec {
  return freezeExperimentSpec({
    schema_version: 1,
    id: 'pilot-v1-sonnet-medium-vs-high',
    arms: [
      { id: 'medium', agent_profile: agentProfile('medium', 'medium') },
      { id: 'high', agent_profile: agentProfile('high', 'high') },
    ],
    tasks: [task('a'), task('b'), task('c')],
    repetitions_per_arm_task: 2,
    ordering: { scheme: 'seeded_interleaved_counterbalanced' as const, seed },
    strategy: { name: 'direct', version: 1, prompt: 'Implemente diretamente.' },
    environment_profile: environmentProfile(),
    billing_policy: {
      billing_mode: 'SUBSCRIPTION' as const,
      max_incremental_charge_usd: null,
      quota_stop_threshold_pct: 80,
    },
    planned_slot_count: 12,
  });
}

const FIXTURE_ALLOW: BillingGuardDecision = decideExecutionAuthorization('FIXTURE');

describe('materializeSlotOrder', () => {
  it('deriva exatamente os 12 planned slots (2 arms × 3 tasks × 2 repetitions)', () => {
    const slots = materializeSlotOrder(buildFrozen('seed-a'));

    expect(slots).toHaveLength(12);
    const seen = new Set<string>();
    for (const slot of slots) {
      const key = `${slot.task_id}:${slot.arm_id}:${slot.repetition_index}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(slot.kind).toBe('PLANNED');
      expect(['medium', 'high']).toContain(slot.arm_id);
      expect(['a', 'b', 'c']).toContain(slot.task_id);
      expect([0, 1]).toContain(slot.repetition_index);
    }
    expect(slots.map((slot) => slot.order_index)).toEqual([...Array(12).keys()]);
  });

  it('mesma seed produz sempre a mesma ordem', () => {
    const first = materializeSlotOrder(buildFrozen('agent-strategy-lab-pilot-v1'));
    const second = materializeSlotOrder(buildFrozen('agent-strategy-lab-pilot-v1'));

    expect(second.map((slot) => slot.slot_id)).toEqual(first.map((slot) => slot.slot_id));
  });

  it('outra seed pode alterar a ordem de forma válida (mesmo conjunto de slots)', () => {
    const a = materializeSlotOrder(buildFrozen('seed-one'));
    const b = materializeSlotOrder(buildFrozen('seed-two'));

    expect(new Set(a.map((slot) => slot.slot_id))).toEqual(new Set(b.map((slot) => slot.slot_id)));
    expect(a.map((slot) => slot.slot_id)).not.toEqual(b.map((slot) => slot.slot_id));
  });

  it('arms sempre intercalados: cada bloco de 2 slots consecutivos contém os dois arms', () => {
    const slots = materializeSlotOrder(buildFrozen('seed-a'));

    for (let index = 0; index < slots.length; index += 2) {
      const block = [slots[index] as PlannedSlot, slots[index + 1] as PlannedSlot];
      expect(new Set(block.map((slot) => slot.arm_id))).toEqual(new Set(['medium', 'high']));
    }
  });

  it('nunca executa todos os slots de um arm antes dos de outro', () => {
    const slots = materializeSlotOrder(buildFrozen('seed-a'));
    const firstHighIndex = slots.findIndex((slot) => slot.arm_id === 'high');
    const lastMediumIndex = slots.map((slot) => slot.arm_id).lastIndexOf('medium');

    expect(firstHighIndex).toBeLessThan(lastMediumIndex);
  });
});

describe('runExperimentSchedule', () => {
  it('lança todos os slots via executor fake, na ordem materializada, quando a guard sempre permite', async () => {
    const frozen = buildFrozen('seed-a');
    const expectedOrder = materializeSlotOrder(frozen);

    const result = await runExperimentSchedule({
      frozen,
      executeSlot: () => ExecutionStatus.COMPLETED,
      authorizeSlot: () => FIXTURE_ALLOW,
    });

    expect(result.stoppedByBillingGuard).toBe(false);
    expect(result.remainingSlots).toHaveLength(0);
    expect(result.launches).toHaveLength(12);
    expect(result.launches.map((launch) => launch.slot.slot_id)).toEqual(
      expectedOrder.map((slot) => slot.slot_id),
    );
    expect(result.launches.every((launch) => launch.status === ExecutionStatus.COMPLETED)).toBe(true);
  });

  it('INFRA_ERROR gera um retry slot separado, nunca capability FAIL do slot original', async () => {
    const frozen = buildFrozen('seed-a');
    const firstSlotId = materializeSlotOrder(frozen)[0]?.slot_id;

    let infraAttempts = 0;
    const result = await runExperimentSchedule({
      frozen,
      executeSlot: (slot) => {
        if (slot.slot_id === firstSlotId && infraAttempts === 0) {
          infraAttempts += 1;
          return ExecutionStatus.INFRA_ERROR;
        }
        return ExecutionStatus.COMPLETED;
      },
      authorizeSlot: () => FIXTURE_ALLOW,
    });

    expect(result.stoppedByBillingGuard).toBe(false);
    // 12 planned + 1 retry gerado pelo INFRA_ERROR do primeiro slot.
    expect(result.launches).toHaveLength(13);

    const originalLaunch = result.launches.find((launch) => launch.slot.slot_id === firstSlotId);
    expect(originalLaunch?.status).toBe(ExecutionStatus.INFRA_ERROR);
    expect(originalLaunch?.slot.kind).toBe('PLANNED');

    const retryLaunch = result.launches.find((launch) => launch.slot.kind === 'RETRY');
    expect(retryLaunch?.slot.retry_of).toBe(firstSlotId);
    expect(retryLaunch?.status).toBe(ExecutionStatus.COMPLETED);
  });

  it('respeita maxRetriesPerSlot: para de tentar depois do limite', async () => {
    const frozen = buildFrozen('seed-a');

    const result = await runExperimentSchedule({
      frozen,
      executeSlot: () => ExecutionStatus.INFRA_ERROR,
      authorizeSlot: () => FIXTURE_ALLOW,
      maxRetriesPerSlot: 1,
    });

    // 12 slots planejados, cada um com 1 retry = 24 launches, sem loop infinito.
    expect(result.launches).toHaveLength(24);
    expect(result.launches.every((launch) => launch.status === ExecutionStatus.INFRA_ERROR)).toBe(true);
  });

  it('billing BLOCK interrompe o launch imediatamente, preservando os slots restantes', async () => {
    const frozen = buildFrozen('seed-a');
    const order = materializeSlotOrder(frozen);
    const blockAtSlotId = order[3]?.slot_id;
    const blockedDecision = decideExecutionAuthorization('REAL_INFERENCE');

    const executed: string[] = [];
    const result = await runExperimentSchedule({
      frozen,
      executeSlot: (slot) => {
        executed.push(slot.slot_id);
        return ExecutionStatus.COMPLETED;
      },
      authorizeSlot: (slot) => (slot.slot_id === blockAtSlotId ? blockedDecision : FIXTURE_ALLOW),
    });

    expect(result.stoppedByBillingGuard).toBe(true);
    expect(result.blockedDecision?.decision).toBe('BLOCK');
    expect(result.launches).toHaveLength(3);
    expect(executed).toEqual(order.slice(0, 3).map((slot) => slot.slot_id));
    expect(result.remainingSlots.map((slot) => slot.slot_id)).toEqual(
      order.slice(3).map((slot) => slot.slot_id),
    );
  });
});
