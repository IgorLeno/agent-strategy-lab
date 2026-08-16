import { describe, expect, it } from 'vitest';

import { freezeExperimentSpec, type FrozenExperimentSpec } from '../../src/experiment/index.js';
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

function specInput() {
  return {
    schema_version: 1,
    id: 'pilot-v1-sonnet-medium-vs-high',
    arms: [
      { id: 'medium', agent_profile: agentProfile('medium', 'medium') },
      { id: 'high', agent_profile: agentProfile('high', 'high') },
    ],
    tasks: [task('a'), task('b'), task('c')],
    repetitions_per_arm_task: 2,
    ordering: { scheme: 'seeded_interleaved_counterbalanced' as const, seed: 'pilot-seed' },
    strategy: { name: 'direct', version: 1, prompt: 'Implemente diretamente.' },
    environment_profile: environmentProfile(),
    billing_policy: {
      billing_mode: 'SUBSCRIPTION' as const,
      max_incremental_charge_usd: null,
      quota_stop_threshold_pct: 80,
    },
    planned_slot_count: 12,
  };
}

describe('freezeExperimentSpec', () => {
  it('rejeita entrada inválida', () => {
    expect(() => freezeExperimentSpec({ ...specInput(), planned_slot_count: 1 })).toThrow();
  });

  it('produz o mesmo hash para o mesmo conteúdo', () => {
    const a = freezeExperimentSpec(specInput());
    const b = freezeExperimentSpec(specInput());
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produz hash diferente quando qualquer campo congelado muda', () => {
    const base = freezeExperimentSpec(specInput());
    const changedSeed = freezeExperimentSpec({
      ...specInput(),
      ordering: { scheme: 'seeded_interleaved_counterbalanced', seed: 'other-seed' },
    });
    const changedRepetitions = freezeExperimentSpec({
      ...specInput(),
      repetitions_per_arm_task: 3,
      planned_slot_count: 18,
    });

    expect(changedSeed.hash).not.toBe(base.hash);
    expect(changedRepetitions.hash).not.toBe(base.hash);
  });

  it('é insensível à ordem das chaves do objeto de entrada (hash canônico)', () => {
    const input = specInput();
    const reordered = {
      planned_slot_count: input.planned_slot_count,
      billing_policy: input.billing_policy,
      environment_profile: input.environment_profile,
      strategy: input.strategy,
      ordering: input.ordering,
      repetitions_per_arm_task: input.repetitions_per_arm_task,
      tasks: input.tasks,
      arms: input.arms,
      id: input.id,
      schema_version: input.schema_version,
    };

    expect(freezeExperimentSpec(reordered).hash).toBe(freezeExperimentSpec(input).hash);
  });

  it('congela profundamente: mutação em runtime lança', () => {
    const frozen: FrozenExperimentSpec = freezeExperimentSpec(specInput());

    expect(() => {
      (frozen.spec as { id: string }).id = 'mutated';
    }).toThrow(TypeError);
    expect(() => {
      (frozen.spec.arms as unknown as { push: (value: unknown) => void }).push(frozen.spec.arms[0]);
    }).toThrow(TypeError);
    expect(() => {
      (frozen.spec.arms[0] as { id: string }).id = 'mutated';
    }).toThrow(TypeError);

    expect(frozen.spec.id).toBe('pilot-v1-sonnet-medium-vs-high');
  });
});
