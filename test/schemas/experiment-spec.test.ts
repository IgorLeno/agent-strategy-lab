import { describe, expect, it } from 'vitest';

import { ExperimentSpec } from '../../src/schemas/index.js';
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

function validSpec(): ExperimentSpec {
  return {
    schema_version: 1,
    id: 'pilot-v1-sonnet-medium-vs-high',
    arms: [
      { id: 'medium', agent_profile: agentProfile('medium', 'medium') },
      { id: 'high', agent_profile: agentProfile('high', 'high') },
    ],
    tasks: [task('a'), task('b'), task('c')],
    repetitions_per_arm_task: 2,
    ordering: { scheme: 'seeded_interleaved_counterbalanced', seed: 'pilot-seed' },
    strategy: { name: 'direct', version: 1, prompt: 'Implemente diretamente.' },
    environment_profile: environmentProfile(),
    billing_policy: {
      billing_mode: 'SUBSCRIPTION',
      max_incremental_charge_usd: null,
      quota_stop_threshold_pct: 80,
    },
    planned_slot_count: 12,
  };
}

describe('ExperimentSpec', () => {
  it('aceita um spec bem formado', () => {
    expect(() => ExperimentSpec.parse(validSpec())).not.toThrow();
  });

  it('é estrito: rejeita campo desconhecido', () => {
    expect(() => ExperimentSpec.parse({ ...validSpec(), extra: true })).toThrow();
  });

  it('exige ao menos 2 arms', () => {
    const spec = validSpec();
    expect(() =>
      ExperimentSpec.parse({ ...spec, arms: [spec.arms[0]], planned_slot_count: 6 }),
    ).toThrow();
  });

  it('rejeita arm id duplicado', () => {
    const spec = validSpec();
    expect(() =>
      ExperimentSpec.parse({ ...spec, arms: [spec.arms[0], spec.arms[0]] }),
    ).toThrow();
  });

  it('rejeita task id duplicado', () => {
    const spec = validSpec();
    expect(() =>
      ExperimentSpec.parse({ ...spec, tasks: [spec.tasks[0], spec.tasks[0], spec.tasks[1]] }),
    ).toThrow();
  });

  it('planned_slot_count deve ser arms × tasks × repetitions', () => {
    const spec = validSpec();
    expect(() => ExperimentSpec.parse({ ...spec, planned_slot_count: 11 })).toThrow();
  });

  it('deriva 12 slots planejados para 2 arms × 3 tasks × 2 repetitions', () => {
    const spec = ExperimentSpec.parse(validSpec());
    expect(spec.arms.length * spec.tasks.length * spec.repetitions_per_arm_task).toBe(12);
    expect(spec.planned_slot_count).toBe(12);
  });
});
