/**
 * Regressão da falha real: uma run contra um repositório externo morreu em
 * `SCHEMA_NORMALIZATION` e o runtime apontado como evidência não continha nem
 * o draft rejeitado nem as issues. Estes testes provam que o modo de falha
 * agora é DIAGNOSTICÁVEL — sem relaxar nenhum gate.
 */

import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { ensureGeneratedProjectPlan } from '../../dev/lib/run-project.js';
import { PlannedTask } from '../../src/planner/task.js';
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

const OBJECTIVE = 'src/t1.txt existe após a execução';

/** Task válida; cada teste degrada exatamente o campo que quer exercitar. */
function validTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'T1',
    objective: 'criar um marcador local',
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
    acceptance: [OBJECTIVE],
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
    ...overrides,
  };
}

/** Worker programável: uma resposta por invocação, na ordem declarada. */
class ScriptedPlanner implements PlanningWorkerPort {
  invocations: PlanningWorkerInvocation[] = [];

  constructor(private readonly responses: readonly PlanningWorkerInvocationResult[]) {}

  async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
    this.invocations.push(invocation);
    const response = this.responses[this.invocations.length - 1];
    if (response === undefined) throw new Error('planner recebeu invocação além do script');
    return response;
  }
}

function draftReturned(draft: unknown, model = 'fake-worker-v1'): PlanningWorkerInvocationResult {
  return {
    outcome: 'DRAFT_RETURNED',
    invocation_id: `unit-planner-${model}`,
    provider_id: 'fake',
    model,
    draft,
  };
}

async function fixture(): Promise<{
  readonly paths: HarnessPaths;
  readonly planFile: string;
  readonly intake: ProjectIntakeRequest;
  readonly authorizationScope: ExecutionAuthorizationScope;
}> {
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
    objectives: [OBJECTIVE],
    constraints: [],
    exclusions: ['deploy'],
    requested_scope: { summary: 'criar um marcador local' },
  };
  return {
    paths,
    planFile,
    intake,
    authorizationScope: {
      schema_version: 1,
      requested_scope: intake.requested_scope,
      autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE'],
      human_gated_capabilities: ['DESTRUCTIVE_ACTION'],
    },
  };
}

async function plan(
  base: Awaited<ReturnType<typeof fixture>>,
  planner: PlanningWorkerPort,
): Promise<void> {
  await ensureGeneratedProjectPlan({
    paths: base.paths,
    intake: base.intake,
    authorizationScope: base.authorizationScope,
    plannerProfileId: 'fake-worker-v1',
    inspect: (repoRoot) => inspectRepository({ repoRoot }),
    planningWorker: async () => planner,
  });
}

async function attemptDirs(paths: HarnessPaths): Promise<readonly string[]> {
  const entries = await readdir(paths.planningEvidenceDir);
  return entries.sort();
}

async function readEvidence(
  paths: HarnessPaths,
  attempt: string,
  file: string,
): Promise<Record<string, unknown>> {
  const raw = await readFile(path.join(paths.planningEvidenceDir, attempt, file), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('evidência de planejamento — draft inicial inválido', () => {
  it('preserva o draft exato e as issues de SCHEMA_NORMALIZATION antes de descartá-lo', async () => {
    const base = await fixture();
    // O modo de falha REAL observado: schema_version chegou como string.
    const invalidDraft = { schema_version: 1, tasks: [validTask({ schema_version: '1' })] };
    const planner = new ScriptedPlanner([draftReturned(invalidDraft), draftReturned(invalidDraft)]);

    await expect(plan(base, planner)).rejects.toThrow(/SCHEMA_NORMALIZATION/);

    // O gate estrito continua exatamente como era: nenhuma coerção nasceu.
    expect(PlannedTask.safeParse(validTask({ schema_version: '1' })).success).toBe(false);
    expect(PlannedTask.safeParse(validTask()).success).toBe(true);

    const dirs = await attemptDirs(base.paths);
    expect(dirs[0]).toBe('attempt-01');

    // O draft persistido é BYTE A BYTE o que o worker devolveu.
    const persistedDraft = await readEvidence(base.paths, 'attempt-01', 'draft.json');
    expect(persistedDraft).toEqual(invalidDraft);
    expect((persistedDraft['tasks'] as Record<string, unknown>[])[0]?.['schema_version']).toBe('1');

    const validation = await readEvidence(base.paths, 'attempt-01', 'validation.json');
    expect(validation['outcome']).toBe('REJECTED');
    expect(validation['rejected_stage']).toBe('SCHEMA_NORMALIZATION');
    expect(validation['issues']).toContain('tasks.0.schema_version: Invalid literal value, expected 1');

    const metadata = await readEvidence(base.paths, 'attempt-01', 'invocation-metadata.json');
    expect(metadata['attempt']).toBe(1);
    expect(metadata['kind']).toBe('INITIAL_DRAFT');
    expect(metadata['provider_id']).toBe('fake');
    expect(metadata['role']).toBe('READ_ONLY_PLANNER');
    expect(metadata['base_revision_sha']).toBe(base.intake.base_revision.sha);
    // Nenhum segredo entra na evidência.
    expect(JSON.stringify(metadata)).not.toMatch(/token|api[_-]?key|secret|credential/i);

    // Nenhum PlanFile nasceu e o executor não foi chamado.
    await expect(readFile(base.planFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('evidência de planejamento — tentativa de revisão', () => {
  it('audita as duas tentativas separadamente e preserva o draft de cada uma', async () => {
    const base = await fixture();
    const firstDraft = { schema_version: 1, tasks: [validTask({ schema_version: '1' })] };
    // A substituição COMPLETA pedida na revisão também falha, por outro campo.
    const secondDraft = {
      schema_version: 1,
      tasks: [validTask({ task_id: 'T2', risk: 'inexistente' })],
    };
    const planner = new ScriptedPlanner([
      draftReturned(firstDraft, 'model-a'),
      draftReturned(secondDraft, 'model-b'),
    ]);

    let message = '';
    try {
      await plan(base, planner);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/SCHEMA_NORMALIZATION/);

    expect(planner.invocations).toHaveLength(2);
    expect(await attemptDirs(base.paths)).toEqual(['attempt-01', 'attempt-02']);

    // Primeiro draft continua íntegro — a revisão não o sobrescreveu.
    expect(await readEvidence(base.paths, 'attempt-01', 'draft.json')).toEqual(firstDraft);
    expect(await readEvidence(base.paths, 'attempt-02', 'draft.json')).toEqual(secondDraft);

    const revisionRequest = await readEvidence(base.paths, 'attempt-02', 'revision-request.json');
    expect(revisionRequest['attempt']).toBe(2);
    expect(revisionRequest['previous_stage']).toBe('SCHEMA_NORMALIZATION');
    expect(revisionRequest['requires_complete_replacement']).toBe(true);
    expect(revisionRequest['issues']).toContain(
      'tasks.0.schema_version: Invalid literal value, expected 1',
    );

    const secondMetadata = await readEvidence(base.paths, 'attempt-02', 'invocation-metadata.json');
    expect(secondMetadata['kind']).toBe('REVISION');
    expect(secondMetadata['attempt']).toBe(2);
    expect(secondMetadata['model']).toBe('model-b');
    expect(secondMetadata['previous_rejected_stage']).toBe('SCHEMA_NORMALIZATION');

    const secondValidation = await readEvidence(base.paths, 'attempt-02', 'validation.json');
    expect(secondValidation['rejected_stage']).toBe('SCHEMA_NORMALIZATION');

    // A falha terminal aponta os artifacts, não só a raiz do runtime — e não
    // despeja o draft no terminal.
    expect(message).toContain(path.join(base.paths.planningEvidenceDir, 'attempt-01'));
    expect(message).toContain(path.join(base.paths.planningEvidenceDir, 'attempt-02'));
    expect(message).toContain('validation.json');
    expect(message).not.toContain('estimated_duration');
  });
});

describe('evidência de planejamento — planejamento bem-sucedido', () => {
  it('não altera a semântica: PlanFile normal e a tentativa fica auditável', async () => {
    const base = await fixture();
    const draft = { schema_version: 1, tasks: [validTask()] };
    await plan(base, new ScriptedPlanner([draftReturned(draft)]));

    expect((await loadPlan(base.planFile)).plan.tasks).toHaveLength(1);
    expect(await attemptDirs(base.paths)).toEqual(['attempt-01']);

    const validation = await readEvidence(base.paths, 'attempt-01', 'validation.json');
    expect(validation['outcome']).toBe('AUTHORIZED');
    expect(validation['rejected_stage']).toBeNull();
    expect(validation['issues']).toEqual([]);
    expect(await readEvidence(base.paths, 'attempt-01', 'draft.json')).toEqual(draft);
  });
});

describe('evidência de planejamento — falha de invocação', () => {
  it('preserva a falha estruturada mesmo sem draft nenhum', async () => {
    const base = await fixture();
    const planner = new ScriptedPlanner([
      {
        outcome: 'INVOCATION_FAILED',
        invocation_id: 'unit-planner-fail',
        provider_id: 'fake',
        model: 'fake-worker-v1',
        failure: { code: 'PROVIDER_TIMEOUT', message: 'worker não respondeu', retryable: true },
      },
    ]);

    await expect(plan(base, planner)).rejects.toThrow(/PROVIDER_TIMEOUT/);

    expect(await attemptDirs(base.paths)).toEqual(['attempt-01']);
    const files = (await readdir(path.join(base.paths.planningEvidenceDir, 'attempt-01'))).sort();
    expect(files).toEqual(['invocation-metadata.json', 'result.json']);

    const result = await readEvidence(base.paths, 'attempt-01', 'result.json');
    expect(result['outcome']).toBe('INVOCATION_FAILED');
    expect(result['draft_file']).toBeNull();
    expect(result['failure']).toEqual({
      code: 'PROVIDER_TIMEOUT',
      message: 'worker não respondeu',
      retryable: true,
    });
  });
});

describe('evidência de planejamento — append-only', () => {
  it('uma execução posterior no mesmo runtime nunca sobrescreve a evidência anterior', async () => {
    const base = await fixture();
    const firstDraft = { schema_version: 1, tasks: [validTask({ schema_version: '1' })] };
    await expect(
      plan(base, new ScriptedPlanner([draftReturned(firstDraft), draftReturned(firstDraft)])),
    ).rejects.toThrow(/SCHEMA_NORMALIZATION/);

    const attemptOneBytes = await readFile(
      path.join(base.paths.planningEvidenceDir, 'attempt-01', 'draft.json'),
      'utf8',
    );

    // Retry no MESMO runtime, com outro draft — também inválido.
    const retryDraft = { schema_version: 1, tasks: [validTask({ task_id: 'T9', risk: 'nope' })] };
    await expect(
      plan(base, new ScriptedPlanner([draftReturned(retryDraft), draftReturned(retryDraft)])),
    ).rejects.toThrow(/SCHEMA_NORMALIZATION/);

    expect(await attemptDirs(base.paths)).toEqual([
      'attempt-01',
      'attempt-02',
      'attempt-03',
      'attempt-04',
    ]);
    // Os bytes da primeira tentativa continuam exatamente os mesmos.
    expect(
      await readFile(
        path.join(base.paths.planningEvidenceDir, 'attempt-01', 'draft.json'),
        'utf8',
      ),
    ).toBe(attemptOneBytes);
    expect(await readEvidence(base.paths, 'attempt-03', 'draft.json')).toEqual(retryDraft);
  });
});
