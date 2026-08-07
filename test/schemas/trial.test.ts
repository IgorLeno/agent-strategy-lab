import { describe, expect, it } from 'vitest';

import {
  ExecutionRequest,
  Trial,
  TrialStatus,
  type TaskBudgets,
} from '../../src/schemas/index.js';

const budgets: TaskBudgets = {
  duration_ms: { expected: 120_000, maximum: 300_000 },
  tokens: { expected: 8_000, maximum: 20_000 },
  changed_files: { expected: 3, maximum: 6 },
};

function validTrial(): Trial {
  return {
    id: 'trial-direct-controlled-001',
    task: {
      id: 'add-retry-policy',
      description: 'Adicionar retentativas limitadas ao cliente HTTP.',
      visible_criteria: ['Retenta somente erros transitórios.'],
      task_class: 'feature',
      difficulty: 'medium',
      stack: ['typescript', 'vitest'],
      public_graders: ['typecheck', 'unit-tests'],
      budgets,
    },
    agent: {
      id: 'codex-gpt-5-6-sol',
      cli: 'codex',
      cli_version: '0.31.0',
      model: 'gpt-5.6-sol',
      flags: ['--ephemeral', '--sandbox=workspace-write'],
    },
    strategy: {
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    },
    environment: {
      id: 'controlled-clean-room',
      mode: 'controlled',
      env_allowlist: ['PATH', 'LANG'],
      home: 'sanitized',
      instruction_files: [{ path: 'AGENTS.md', sha256: 'a'.repeat(64) }],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    status: 'PLANNED',
  };
}

describe('Trial', () => {
  it.each(TrialStatus.options)('parses the %s trial status', (status) => {
    const input: Trial = { ...validTrial(), status };

    expect(Trial.parse(input)).toEqual(input);
  });

  it.each(['FAIL', 'INFRA_ERROR'])(
    'rejects run-level outcome %s as a trial status',
    (status) => {
      expect(Trial.safeParse({ ...validTrial(), status }).success).toBe(false);
    },
  );

  it('rejects malformed factors and unknown fields', () => {
    expect(
      Trial.safeParse({
        ...validTrial(),
        agent: { ...validTrial().agent, model: '   ' },
      }).success,
    ).toBe(false);
    expect(Trial.safeParse({ ...validTrial(), run_outcome: 'FAIL' }).success).toBe(false);
  });
});

describe('ExecutionRequest', () => {
  it('parses a trial reference with base SHA, budgets and timeout', () => {
    const input: ExecutionRequest = {
      trial: validTrial(),
      base_sha: 'b'.repeat(40),
      budgets,
      timeout_ms: 300_000,
    };

    expect(ExecutionRequest.parse(input)).toEqual(input);
  });

  it.each([
    { base_sha: 'not-a-commit', budgets, timeout_ms: 300_000 },
    { base_sha: 'b'.repeat(40), budgets, timeout_ms: 0 },
    {
      base_sha: 'b'.repeat(40),
      budgets: { ...budgets, tokens: { expected: 21_000, maximum: 20_000 } },
      timeout_ms: 300_000,
    },
  ])('rejects an invalid execution request', (requestFields) => {
    expect(
      ExecutionRequest.safeParse({ trial: validTrial(), ...requestFields }).success,
    ).toBe(false);
  });
});
