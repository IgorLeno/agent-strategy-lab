import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import {
  ensureGeneratedProjectPlan,
  PROJECT_DELIBERATION_ARTIFACT,
} from '../../dev/lib/run-project.js';
import { inspectRepository } from '../../src/inspection/index.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../../src/intake/index.js';
import type {
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  PlanningWorkerPort,
} from '../../src/planner/draft.js';
import type {
  PlanDeliberationArtifact,
  PlanDeliberationInvocation,
  PlanDeliberationInvocationResult,
} from '../../src/planner/deliberation.js';
import type { LabProgressEvent } from '../../dev/lib/lab-progress.js';
import { makeSandboxRepo, runGit } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

class Planner implements PlanningWorkerPort {
  invocations = 0;

  async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
    this.invocations += 1;
    const objective = invocation.packet.user_intent.objectives[0] as string;
    return {
      outcome: 'DRAFT_RETURNED',
      invocation_id: 'unit-planner',
      provider_id: 'fake',
      model: 'fake-worker-v1',
      draft: {
        schema_version: 1,
        tasks: [
          {
            schema_version: 1,
            task_id: 'T1',
            objective: invocation.packet.user_intent.requested_scope,
            blocked_by: [],
            taxonomy: {
              version: 1,
              task_class: 'feature',
              difficulty_declared: 'easy',
              complexity: 'local',
              ambiguity: 'low',
              verification: 'deterministic',
            },
            risk: 'low',
            acceptance: [objective],
            validation: [{ argv: ['true'], timeout_seconds: 30 }],
            initial_files: ['README.md'],
            probable_files: [],
            context_scope: { areas: ['src'] },
            context_requirements: [
              { description: 'seguir o README do projeto', source_anchor: 'README.md' },
            ],
            environment_requirements: [],
            estimated_duration: { expected: 1_000, maximum: 60_000 },
            validation_budget: { expected: 1_000, maximum: 30_000 },
            resource_envelope: {
              duration_ms: { expected: 1_000, maximum: 60_000 },
              tokens: { expected: 1_000, maximum: 10_000 },
              changed_files: { expected: 1, maximum: 3 },
            },
          },
        ],
      },
    };
  }
}

describe('ensureGeneratedProjectPlan', () => {
  it('gera uma vez e reutiliza o mesmo PlanFile no restart sem construir outro planner', async () => {
    const sandbox = await makeSandboxRepo();
    created.push(sandbox.root);
    const head = (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const planFile = path.join(sandbox.root, '.dev', 'project', 'generated-plan.yaml');
    const paths = resolveHarnessPaths(sandbox.root, { planFile });
    const intake: ProjectIntakeRequest = {
      schema_version: 1,
      target_repo: { url: sandbox.root },
      base_revision: { sha: head },
      user_request: 'Criar o marcador pedido pelo usuário',
      objectives: ['src/t1.txt existe após a execução'],
      constraints: [],
      exclusions: ['deploy'],
      requested_scope: { summary: 'criar um marcador local' },
    };
    const authorizationScope: ExecutionAuthorizationScope = {
      schema_version: 1,
      requested_scope: intake.requested_scope,
      autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE'],
      human_gated_capabilities: ['DESTRUCTIVE_ACTION'],
    };
    const planner = new Planner();
    let factories = 0;

    const first = await ensureGeneratedProjectPlan({
      paths,
      intake,
      authorizationScope,
      inspect: (repoRoot) => inspectRepository({ repoRoot }),
      planningWorker: async () => {
        factories += 1;
        return planner;
      },
    });
    const second = await ensureGeneratedProjectPlan({
      paths,
      intake,
      authorizationScope,
      inspect: () => {
        throw new Error('inspection não deve repetir no resume');
      },
      planningWorker: async () => {
        throw new Error('planner não deve ser construído no resume');
      },
    });

    expect(first.origin).toBe('GENERATED');
    expect(second.origin).toBe('REUSED');
    expect(factories).toBe(1);
    expect(planner.invocations).toBe(1);
    expect((await loadPlan(planFile)).plan.generated_from?.base_revision_sha).toBe(head);
  });

  it('resume com PlanFile existente não relança planner nem deliberador e preserva os bytes', async () => {
    const sandbox = await makeSandboxRepo();
    created.push(sandbox.root);
    const head = (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const planFile = path.join(sandbox.root, '.dev', 'project', 'generated-plan.yaml');
    const paths = resolveHarnessPaths(sandbox.root, { planFile });
    const intake: ProjectIntakeRequest = {
      schema_version: 1,
      target_repo: { url: sandbox.root },
      base_revision: { sha: head },
      user_request: 'Criar o marcador pedido pelo usuário',
      objectives: ['src/t1.txt existe após a execução'],
      constraints: [],
      exclusions: ['deploy'],
      requested_scope: { summary: 'criar um marcador local' },
    };
    const authorizationScope: ExecutionAuthorizationScope = {
      schema_version: 1,
      requested_scope: intake.requested_scope,
      autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE'],
      human_gated_capabilities: ['DESTRUCTIVE_ACTION'],
    };
    const first = await ensureGeneratedProjectPlan({
      paths,
      intake,
      authorizationScope,
      inspect: (repoRoot) => inspectRepository({ repoRoot }),
      planningWorker: async () => new Planner(),
      deliberation: async () => ({
        maxTurns: 2,
        diversity: 'cross_provider_preferred' as const,
        deliberators: [{ profile_id: 'a-claude', provider: 'claude', model: 'opus-5' }],
        humanRequest: intake.user_request,
        worker: {
          async invoke(): Promise<PlanDeliberationInvocationResult> {
            return {
              outcome: 'VERDICT_RETURNED',
              verdict: {
                decision: 'ACCEPT',
                material_objections: [],
                material_changes: [],
                rationale: 'plano adequado',
                revised_plan: null,
              },
            };
          },
        },
      }),
    });
    const original = await readFile(planFile);

    let plannerFactories = 0;
    let deliberatorFactories = 0;
    let deliberatorInvocations = 0;
    const second = await ensureGeneratedProjectPlan({
      paths,
      intake,
      authorizationScope,
      inspect: () => {
        throw new Error('inspection não deve repetir no resume');
      },
      planningWorker: async () => {
        plannerFactories += 1;
        throw new Error('planner não deve ser construído no resume');
      },
      deliberation: async () => {
        deliberatorFactories += 1;
        return {
          maxTurns: 2,
          diversity: 'cross_provider_preferred' as const,
          deliberators: [{ profile_id: 'a-claude', provider: 'claude', model: 'opus-5' }],
          humanRequest: intake.user_request,
          worker: {
            async invoke(): Promise<PlanDeliberationInvocationResult> {
              deliberatorInvocations += 1;
              throw new Error('deliberador não deve ser chamado no resume');
            },
          },
        };
      },
    });

    expect(first.origin).toBe('GENERATED');
    expect(second.origin).toBe('REUSED');
    expect(plannerFactories).toBe(0);
    expect(deliberatorFactories).toBe(0);
    expect(deliberatorInvocations).toBe(0);
    expect(second.deliberation).toBeNull();
    expect(await readFile(planFile)).toEqual(original);
  });
});

describe('deliberação de plano no caminho de projeto', () => {
  async function fixture() {
    const sandbox = await makeSandboxRepo();
    created.push(sandbox.root);
    const head = (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const planFile = path.join(sandbox.root, '.dev', 'project', 'generated-plan.yaml');
    const paths = resolveHarnessPaths(sandbox.root, { planFile });
    const intake: ProjectIntakeRequest = {
      schema_version: 1,
      target_repo: { url: sandbox.root },
      base_revision: { sha: head },
      user_request: 'Criar o marcador pedido pelo usuário',
      objectives: ['src/t1.txt existe após a execução'],
      constraints: [],
      exclusions: ['deploy'],
      requested_scope: { summary: 'criar um marcador local' },
    };
    const authorizationScope: ExecutionAuthorizationScope = {
      schema_version: 1,
      requested_scope: intake.requested_scope,
      autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE'],
      human_gated_capabilities: ['DESTRUCTIVE_ACTION'],
    };
    return { paths, planFile, intake, authorizationScope };
  }

  it('max_turns 0 não chama deliberador e não muda o plano nem o artifact', async () => {
    const { paths, planFile, intake, authorizationScope } = await fixture();
    let invocations = 0;
    const ensured = await ensureGeneratedProjectPlan({
      paths,
      intake,
      authorizationScope,
      inspect: (repoRoot) => inspectRepository({ repoRoot }),
      planningWorker: async () => new Planner(),
      deliberation: async () => ({
        maxTurns: 0,
        diversity: 'cross_provider_preferred' as const,
        deliberators: [{ profile_id: 'a-claude', provider: 'claude', model: 'opus-5' }],
        humanRequest: intake.user_request,
        worker: {
          async invoke(): Promise<PlanDeliberationInvocationResult> {
            invocations += 1;
            throw new Error('nenhum deliberador deveria ser chamado com max_turns 0');
          },
        },
      }),
    });

    expect(invocations).toBe(0);
    expect(ensured.origin).toBe('GENERATED');
    expect(ensured.deliberation).toBeNull();
    expect(ensured.deliberationArtifactFile).toBeNull();
    expect((await loadPlan(planFile)).plan.tasks).toHaveLength(1);
  });

  it('a implementação só começa depois da versão final e o artifact fica no runtime', async () => {
    const { paths, planFile, intake, authorizationScope } = await fixture();
    const events: LabProgressEvent[] = [];
    const seenTurns: number[] = [];

    const ensured = await ensureGeneratedProjectPlan({
      paths,
      intake,
      authorizationScope,
      inspect: (repoRoot) => inspectRepository({ repoRoot }),
      planningWorker: async () => new Planner(),
      onProgress: (event) => events.push(event),
      deliberation: async () => ({
        maxTurns: 3,
        diversity: 'cross_provider_preferred' as const,
        deliberators: [
          { profile_id: 'a-claude', provider: 'claude', model: 'opus-5' },
          { profile_id: 'b-codex', provider: 'codex', model: 'gpt-5.6-sol' },
        ],
        humanRequest: intake.user_request,
        worker: {
          async invoke(
            invocation: PlanDeliberationInvocation,
          ): Promise<PlanDeliberationInvocationResult> {
            seenTurns.push(invocation.turn);
            // Nenhum PlanFile pode existir enquanto a deliberação acontece: a
            // implementação começa somente depois da versão final.
            await expect(readFile(planFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            return invocation.turn === 1
              ? {
                  outcome: 'VERDICT_RETURNED',
                  verdict: {
                    decision: 'REVISE',
                    material_objections: ['o objetivo precisa citar o marcador'],
                    material_changes: [],
                    rationale: 'objetivo vago',
                    revised_plan: null,
                  },
                }
              : {
                  outcome: 'VERDICT_RETURNED',
                  verdict: {
                    decision: 'ACCEPT',
                    material_objections: [],
                    material_changes: [],
                    rationale: 'plano adequado',
                    revised_plan: null,
                  },
                };
          },
        },
      }),
    });

    expect(seenTurns).toEqual([1, 2]);
    expect(ensured.deliberation?.convergence_status).toBe('CONVERGED');
    expect(ensured.deliberation?.actual_turns).toBe(2);
    expect(ensured.deliberation?.requested_max_turns).toBe(3);

    const artifactFile = ensured.deliberationArtifactFile as string;
    expect(path.basename(artifactFile)).toBe(PROJECT_DELIBERATION_ARTIFACT);
    const artifact = JSON.parse(await readFile(artifactFile, 'utf8')) as PlanDeliberationArtifact;
    expect(artifact.kind).toBe('PLAN_DELIBERATION');
    expect(artifact.turns.map((turn) => turn.provider)).toEqual(['claude', 'codex']);

    // O PlanFile só nasceu depois de a versão final ser selada.
    expect((await loadPlan(planFile)).plan.tasks).toHaveLength(1);
    const stages = events.map((event) => event.stage);
    expect(stages.filter((stage) => stage === 'DELIBERATING')).toHaveLength(2);
    expect(stages.indexOf('PLAN_SEALED')).toBeLessThan(stages.indexOf('PLAN_READY'));
    expect(stages.indexOf('DELIBERATING')).toBeLessThan(stages.indexOf('PLAN_SEALED'));
  });
});
