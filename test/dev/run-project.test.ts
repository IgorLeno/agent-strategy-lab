import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { ensureGeneratedProjectPlan } from '../../dev/lib/run-project.js';
import { inspectRepository } from '../../src/inspection/index.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../../src/intake/index.js';
import type {
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  PlanningWorkerPort,
} from '../../src/planner/draft.js';
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
            objective: invocation.packet.user_intent.request,
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
});
