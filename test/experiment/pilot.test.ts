import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PILOT_ARM_HIGH_ID,
  PILOT_ARM_MEDIUM_ID,
  PILOT_REPETITIONS_PER_ARM_TASK,
  PILOT_TASK_IDS,
  buildPilotExperimentSpec,
} from '../../src/experiment/pilot.js';

const repoRoot = path.resolve('.');

describe('piloto: ExperimentSpec Sonnet Medium vs High', () => {
  it('congela exatamente 2 arms, 3 tasks, 2 repetitions e 12 slots planejados', async () => {
    const frozen = await buildPilotExperimentSpec(repoRoot);

    expect(frozen.spec.arms).toHaveLength(2);
    expect(frozen.spec.arms.map((arm) => arm.id).sort()).toEqual(
      [PILOT_ARM_MEDIUM_ID, PILOT_ARM_HIGH_ID].sort(),
    );
    expect(frozen.spec.arms.every((arm) => arm.agent_profile.model === 'claude-sonnet-5')).toBe(
      true,
    );

    const medium = frozen.spec.arms.find((arm) => arm.id === PILOT_ARM_MEDIUM_ID);
    const high = frozen.spec.arms.find((arm) => arm.id === PILOT_ARM_HIGH_ID);
    expect(medium?.agent_profile.flags).toEqual(['--effort', 'medium']);
    expect(high?.agent_profile.flags).toEqual(['--effort', 'high']);

    expect(frozen.spec.tasks.map((task) => task.id).sort()).toEqual([...PILOT_TASK_IDS].sort());
    expect(frozen.spec.repetitions_per_arm_task).toBe(PILOT_REPETITIONS_PER_ARM_TASK);
    expect(frozen.spec.planned_slot_count).toBe(12);
    expect(
      frozen.spec.arms.length * frozen.spec.tasks.length * frozen.spec.repetitions_per_arm_task,
    ).toBe(12);
  });

  it('congela a mesma Strategy e o mesmo EnvironmentProfile controlled para os dois arms', async () => {
    const frozen = await buildPilotExperimentSpec(repoRoot);

    expect(frozen.spec.strategy).toEqual({
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    });
    expect(frozen.spec.environment_profile.mode).toBe('controlled');
  });

  it('congela billing/quota policy do piloto (quota stop >= 80%)', async () => {
    const frozen = await buildPilotExperimentSpec(repoRoot);

    expect(frozen.spec.billing_policy.quota_stop_threshold_pct).toBe(80);
  });

  it('produz o mesmo hash em builds independentes a partir do mesmo repo (determinístico)', async () => {
    const first = await buildPilotExperimentSpec(repoRoot);
    const second = await buildPilotExperimentSpec(repoRoot);

    expect(first.hash).toBe(second.hash);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('não executa nenhum slot: o spec congelado não expõe estado de execução', async () => {
    const frozen = await buildPilotExperimentSpec(repoRoot);

    expect(frozen.spec).not.toHaveProperty('executed_slots');
    expect(frozen.spec).not.toHaveProperty('results');
    expect(Object.isFrozen(frozen.spec)).toBe(true);
  });
});
