import { describe, expect, it } from 'vitest';

import {
  evaluationEnvelopeSha256,
  executionEnvelopeSha256,
  type EvaluationEnvelopeManifest,
  type ExecutionEnvelopeManifest,
} from '../../src/envelope/index.js';

const budgets = {
  duration_ms: { expected: 120_000, maximum: 300_000 },
  tokens: { expected: 8_000, maximum: 20_000 },
  changed_files: { expected: 3, maximum: 6 },
};

function executionManifest(): ExecutionEnvelopeManifest {
  return {
    task_spec: {
      id: 'add-retry-policy',
      description: 'Adicionar retentativas limitadas ao cliente HTTP.',
      visible_criteria: ['Retenta somente erros transitórios.'],
      task_class: 'feature',
      difficulty: 'medium',
      stack: ['typescript', 'vitest'],
      public_graders: ['typecheck', 'unit-tests'],
      budgets,
    },
    strategy: {
      name: 'direct',
      version: 1,
      prompt: 'Implemente diretamente a tarefa fornecida e verifique o resultado.',
    },
    compiled_prompt: 'Tarefa: adicionar retentativas limitadas ao cliente HTTP.',
    base_sha: 'b'.repeat(40),
    agent_profile: {
      id: 'codex-gpt-5-6-sol',
      cli: 'codex',
      cli_version: '0.31.0',
      model: 'gpt-5.6-sol',
      flags: ['--ephemeral', '--sandbox=workspace-write'],
    },
    environment_profile: {
      id: 'controlled-clean-room',
      mode: 'controlled',
      env_allowlist: ['PATH', 'LANG'],
      home: 'sanitized',
      instruction_files: [{ path: 'AGENTS.md', sha256: 'a'.repeat(64) }],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    adapter: { name: 'codex', version: '1.0.0' },
    budgets,
    timeout_ms: 300_000,
  };
}

function evaluationManifest(
  executionManifestSha256: string,
): EvaluationEnvelopeManifest {
  return {
    execution_manifest_sha256: executionManifestSha256,
    evaluation_plan: {
      hidden_graders: ['patch-scope'],
      rubric: { correctness: 'A implementação satisfaz os critérios.' },
      weights: { correctness: 1 },
    },
    grader_versions: {
      typecheck: 'typescript@5.7.2',
      'patch-scope': 'patch-scope@1.0.0',
    },
    evaluator_environment: executionManifest().environment_profile,
    evaluation_commands: {
      typecheck: ['pnpm', 'typecheck'],
      'patch-scope': ['node', 'graders/patch-scope.js'],
    },
  };
}

describe('executionEnvelopeSha256', () => {
  it('is stable for the same execution configuration', () => {
    expect(executionEnvelopeSha256(executionManifest())).toBe(
      executionEnvelopeSha256(executionManifest()),
    );
  });

  it('changes when a CLI flag changes', () => {
    const first = executionManifest();
    const second = executionManifest();
    second.agent_profile.flags[1] = '--sandbox=danger-full-access';

    expect(executionEnvelopeSha256(second)).not.toBe(executionEnvelopeSha256(first));
  });

  it('is independent of object key insertion order', () => {
    const original = executionManifest();
    const reordered = {
      timeout_ms: original.timeout_ms,
      budgets: original.budgets,
      adapter: { version: original.adapter.version, name: original.adapter.name },
      environment_profile: original.environment_profile,
      agent_profile: original.agent_profile,
      base_sha: original.base_sha,
      compiled_prompt: original.compiled_prompt,
      strategy: original.strategy,
      task_spec: original.task_spec,
    };

    expect(executionEnvelopeSha256(reordered)).toBe(executionEnvelopeSha256(original));
  });
});

describe('evaluationEnvelopeSha256', () => {
  it('changes for a hidden grader without changing the execution envelope', () => {
    const execution = executionManifest();
    const executionHash = executionEnvelopeSha256(execution);
    const firstEvaluation = evaluationManifest(executionHash);
    const secondEvaluation: EvaluationEnvelopeManifest = {
      ...firstEvaluation,
      evaluation_plan: {
        ...firstEvaluation.evaluation_plan,
        hidden_graders: ['patch-scope', 'semantic-review'],
      },
    };

    expect(evaluationEnvelopeSha256(secondEvaluation)).not.toBe(
      evaluationEnvelopeSha256(firstEvaluation),
    );
    expect(executionEnvelopeSha256(execution)).toBe(executionHash);
  });
});
