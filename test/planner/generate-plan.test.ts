import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { parsePlan } from '../../dev/lib/plan.js';
import type { ProjectInspection } from '../../src/inspection/index.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../../src/intake/index.js';
import {
  generateImplementationPlan,
  projectImplementationPlan,
} from '../../src/planner/generate.js';
import type {
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  PlanningWorkerPort,
} from '../../src/planner/draft.js';
import type { PlannedTask } from '../../src/planner/task.js';

const HEAD_SHA = 'a'.repeat(40);

function intake(): ProjectIntakeRequest {
  return {
    schema_version: 1,
    target_repo: { url: 'https://example.test/project.git' },
    base_revision: { sha: HEAD_SHA },
    user_request: 'Implementar geracao deterministica de plano',
    objectives: ['Plano gerado e validado'],
    constraints: ['nao escrever em dev/plan.yaml'],
    exclusions: ['deploy'],
    requested_scope: { summary: 'Implementar o planner' },
  };
}

function authorizationScope(): ExecutionAuthorizationScope {
  return {
    schema_version: 1,
    requested_scope: { summary: 'Implementar o planner' },
    autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE'],
    human_gated_capabilities: ['DESTRUCTIVE_ACTION'],
  };
}

function inspection(): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/target',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: {
      known: true,
      value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git',
    },
    stack: {
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'package.json',
    },
    package_manager: { known: true, value: 'pnpm', provenance: 'pnpm-lock.yaml' },
    build_system: { known: true, value: 'typescript', provenance: 'tsconfig.json' },
    directories: [{ path: 'src', role: 'source' }],
    tests: {
      known: true,
      value: { framework: 'vitest', test_directories: ['test'] },
      provenance: 'vitest.config.ts',
    },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json:scripts' },
    ],
    dependencies_state: {
      known: true,
      value: { lockfile_path: 'pnpm-lock.yaml', installed: true },
      provenance: 'node_modules',
    },
    required_tools: [{ name: 'node', reason: 'runtime', source: 'package.json:engines' }],
    required_services: [],
    filesystem_permissions: {
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs access',
    },
    feedback_sources: [],
    project_instructions: [{ path: 'AGENTS.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'planner', path: 'src/planner' }],
    relevant_files: ['src/planner/generate.ts'],
    risks: [],
  };
}

function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'M83',
    objective: 'Implementar o planner',
    blocked_by: [],
    taxonomy: {
      version: 1,
      task_class: 'feature',
      difficulty_declared: 'medium',
      complexity: 'local',
      ambiguity: 'low',
      verification: 'deterministic',
    },
    risk: 'low',
    acceptance: ['Plano gerado e validado'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/planner/generate.ts'],
    probable_files: ['src/planner/draft.ts'],
    context_scope: { areas: ['planner'] },
    context_requirements: [{ description: 'planner existente', source_anchor: 'src/planner' }],
    environment_requirements: [{ kind: 'tool', name: 'node', reason: 'runtime' }],
    estimated_duration: { expected: 600_000, maximum: 1_800_000 },
    validation_budget: { expected: 60_000, maximum: 300_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 50_000, maximum: 150_000 },
      changed_files: { expected: 3, maximum: 8 },
    },
    ...overrides,
  };
}

class FakePlanner implements PlanningWorkerPort {
  readonly invocations: PlanningWorkerInvocation[] = [];

  constructor(private readonly result: PlanningWorkerInvocationResult) {}

  async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
    this.invocations.push(invocation);
    return this.result;
  }
}

function fakeReturning(draft: unknown): FakePlanner {
  return new FakePlanner({
    outcome: 'DRAFT_RETURNED',
    invocation_id: 'fake-1',
    provider_id: 'fake',
    model: 'deterministic-test-double',
    draft,
  });
}

async function generate(draft: unknown) {
  const planner = fakeReturning(draft);
  const result = await generateImplementationPlan({
    intake: intake(),
    inspection: inspection(),
    authorizationScope: authorizationScope(),
    planningWorker: planner,
  });
  return { result, planner };
}

describe('generateImplementationPlan', () => {
  it('invoca a porta como READ_ONLY e autoriza estrutura deterministica sem dados do provider', async () => {
    const first = await generate({ schema_version: 1, tasks: [task()] });
    const second = await generate({ schema_version: 1, tasks: [task()] });

    expect(first.result.outcome).toBe('AUTHORIZED');
    expect(second.result).toEqual(first.result);
    expect(first.planner.invocations).toHaveLength(1);
    expect(first.planner.invocations[0]).toMatchObject({
      role: 'READ_ONLY_PLANNER',
      workspace_access: 'READ_ONLY',
    });
    if (first.result.outcome !== 'AUTHORIZED') throw new Error('unreachable');
    expect(first.result.plan.control.acceptance_contract).toEqual(intake().objectives);
    expect(first.result.plan.control.plan_policy.pipeline).toEqual([
      'SCHEMA_NORMALIZATION',
      'AVC_DECOMPOSITION',
      'PLAN_POLICY',
      'DEPENDENCY_VALIDATION',
      'RISK_READINESS',
    ]);
    expect(JSON.stringify(first.result.plan)).not.toContain('fake-1');
  });

  it('projeta deterministicamente para PlanFile aceito pelo parser sem escrever dev/plan.yaml', async () => {
    const planPath = path.resolve(import.meta.dirname, '../../dev/plan.yaml');
    const before = await readFile(planPath, 'utf8');
    const { result } = await generate({ schema_version: 1, tasks: [task()] });
    if (result.outcome !== 'AUTHORIZED') throw new Error('expected authorized plan');

    const projectionA = projectImplementationPlan(result.plan);
    const projectionB = projectImplementationPlan(result.plan);
    expect(projectionA).toEqual(projectionB);
    expect(projectionA.generated_from).toEqual(result.plan.source);
    expect(projectionA.tasks[0]?.constraints).toEqual([
      'nao escrever em dev/plan.yaml',
      'Exclusão autorizada: deploy',
    ]);
    expect(parsePlan(stringifyYaml(projectionA)).plan).toEqual(projectionA);
    expect(await readFile(planPath, 'utf8')).toBe(before);
  });

  it('recusa plano que perde um objetivo do usuario, em vez de corrigi-lo', async () => {
    const { result } = await generate({
      schema_version: 1,
      tasks: [task({ acceptance: ['criterio inventado pelo worker'] })],
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', stage: 'SCHEMA_NORMALIZATION' });
    if (result.outcome !== 'REJECTED') throw new Error('unreachable');
    expect(result.issues.join(' ')).toContain('acceptance_contract');
    expect(result.issues.join(' ')).toContain('Plano gerado e validado');
  });

  it('acceptance tecnico adicional e permitido enquanto todo objetivo do usuario for coberto', async () => {
    const { result } = await generate({
      schema_version: 1,
      tasks: [
        task({
          acceptance: ['Plano gerado e validado', 'pnpm build termina com exit 0'],
        }),
      ],
    });
    expect(result.outcome).toBe('AUTHORIZED');
    if (result.outcome !== 'AUTHORIZED') throw new Error('unreachable');
    expect(result.plan.control.acceptance_contract).toEqual(['Plano gerado e validado']);
    expect(result.plan.tasks[0]?.task.acceptance).toEqual([
      'Plano gerado e validado',
      'pnpm build termina com exit 0',
    ]);
  });

  it('objetivo do usuario pode ser coberto por qualquer task do plano, em qualquer ordem', async () => {
    const { result } = await generate({
      schema_version: 1,
      tasks: [
        task({ task_id: 'bootstrap', acceptance: ['toolchain instalada'] }),
        task({ task_id: 'feature', blocked_by: ['bootstrap'], acceptance: ['Plano gerado e validado'] }),
      ],
    });
    expect(result.outcome).toBe('AUTHORIZED');
  });

  it('falha fechado quando AVC exige decomposicao (fronteira de rollback não delimitada)', async () => {
    const { result } = await generate({
      schema_version: 1,
      tasks: [
        task({
          risk: 'high',
          resource_envelope: {
            duration_ms: { expected: 600_000, maximum: 1_800_000 },
            tokens: { expected: 50_000, maximum: 200_000 },
            changed_files: { expected: 5, maximum: 60 },
          },
        }),
      ],
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', stage: 'AVC_DECOMPOSITION' });
  });

  it('escopo amplo de contexto sozinho nao recusa o plano', async () => {
    const { result } = await generate({
      schema_version: 1,
      tasks: [task({ context_scope: { areas: ['a', 'b', 'c', 'd'] } })],
    });
    expect(result.outcome).toBe('AUTHORIZED');
  });

  it('executa policy antes de recusar dependencias invalidas', async () => {
    const { result } = await generate({
      schema_version: 1,
      tasks: [task({ blocked_by: ['UNKNOWN'] })],
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', stage: 'DEPENDENCY_VALIDATION' });
  });

  it.each([
    [{ argv: ['pnpm', 'test;rm'], timeout_seconds: 300 }, 'metacaractere'],
    [{ argv: ['pnpm', 'test'], timeout_seconds: 3_601 }, 'excede'],
  ])('recusa validation nao projetavel: %s', async (validation, reason) => {
    const { result } = await generate({
      schema_version: 1,
      tasks: [task({ validation: [validation] })],
    });
    expect(result).toMatchObject({ outcome: 'REJECTED', stage: 'SCHEMA_NORMALIZATION' });
    if (result.outcome !== 'REJECTED') throw new Error('unreachable');
    expect(result.issues.join(' ')).toContain(reason);
  });
});
