/**
 * Regressão do run real `grimperium-d08cac29/semi-imperium-retry-01`.
 *
 * O draft inicial era estruturalmente válido e foi rejeitado em
 * AVC_DECOMPOSITION (`unbounded_rollback_boundary`). O
 * planner respondeu com um plano de substituição maior — e omitiu, em TODAS as
 * tasks, o `schema_version` repetido. As 14 tasks morreram em
 * SCHEMA_NORMALIZATION com "tasks.N.schema_version: Invalid literal value,
 * expected 1" e nenhum executor foi lançado.
 *
 * `schema_version` é metadado de control plane, não decisão de planejamento:
 * a versão externa já validada é propagada para a task que a omite. Todo o
 * resto do contrato continua estrito.
 */
import { describe, expect, it } from 'vitest';

import type { ProjectInspection } from '../../src/inspection/index.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../../src/intake/index.js';
import { normalizeUntrustedPlanDraft } from '../../src/planner/draft.js';
import type {
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  PlanningWorkerPort,
} from '../../src/planner/draft.js';
import { generateImplementationPlan } from '../../src/planner/generate.js';
import type { PlanningAttemptRecord } from '../../src/planner/generate.js';
import type { PlannedTask } from '../../src/planner/task.js';

const HEAD_SHA = 'a'.repeat(40);

function intake(): ProjectIntakeRequest {
  return {
    schema_version: 1,
    target_repo: { url: 'https://example.test/project.git' },
    base_revision: { sha: HEAD_SHA },
    user_request: 'Endurecer a persistência de domínio',
    objectives: ['Persistência endurecida e validada'],
    constraints: [],
    exclusions: ['deploy'],
    requested_scope: { summary: 'Endurecer persistência' },
  };
}

function authorizationScope(): ExecutionAuthorizationScope {
  return {
    schema_version: 1,
    requested_scope: { summary: 'Endurecer persistência' },
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
      value: { primary_ecosystem: 'python', ecosystems_detected: ['python'] },
      provenance: 'pyproject.toml',
    },
    package_manager: { known: true, value: 'poetry', provenance: 'poetry.lock' },
    build_system: { known: true, value: 'poetry', provenance: 'pyproject.toml' },
    directories: [{ path: 'src', role: 'source' }],
    tests: {
      known: true,
      value: { framework: 'pytest', test_directories: ['tests'] },
      provenance: 'pyproject.toml',
    },
    validation_command_candidates: [
      { name: 'tests', command: 'pytest tests/', source: 'pyproject.toml' },
    ],
    dependencies_state: {
      known: true,
      value: { lockfile_path: 'poetry.lock', installed: true },
      provenance: 'venv',
    },
    required_tools: [{ name: 'python', reason: 'runtime', source: 'pyproject.toml' }],
    required_services: [],
    filesystem_permissions: {
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs access',
    },
    feedback_sources: [],
    project_instructions: [{ path: 'CLAUDE.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'persistence', path: 'src/grimperium' }],
    relevant_files: ['src/grimperium/crest_pm7/batch/csv_manager.py'],
    risks: [],
  };
}

/** Task canônica completa; `schema_version` é removido/alterado por caso de teste. */
function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'semiimperium-domain-persistence',
    objective: 'Endurecer a persistência de domínio',
    blocked_by: [],
    taxonomy: {
      version: 1,
      task_class: 'refactor',
      difficulty_declared: 'medium',
      complexity: 'local',
      ambiguity: 'low',
      verification: 'deterministic',
    },
    risk: 'low',
    acceptance: ['Persistência endurecida e validada'],
    validation: [{ argv: ['pytest', 'tests/'], timeout_seconds: 600 }],
    initial_files: ['src/grimperium/crest_pm7/batch/csv_manager.py'],
    probable_files: ['src/grimperium/crest_pm7/batch/csv_manager.py'],
    context_scope: { areas: ['persistence'] },
    context_requirements: [
      { description: 'schema atual do CSV', source_anchor: 'src/grimperium' },
    ],
    environment_requirements: [{ kind: 'tool', name: 'python', reason: 'runtime' }],
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

/** Task tal como o provider a devolveu: sem o metadado de protocolo repetido. */
function taskWithoutProtocolVersion(overrides: Partial<PlannedTask> = {}): Record<string, unknown> {
  const { schema_version: _omitted, ...rest } = task(overrides);
  return rest;
}

class SequencedPlanner implements PlanningWorkerPort {
  readonly invocations: PlanningWorkerInvocation[] = [];

  constructor(private readonly results: readonly PlanningWorkerInvocationResult[]) {}

  async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
    this.invocations.push(invocation);
    const result = this.results[this.invocations.length - 1];
    if (result === undefined) throw new Error('planner recebeu invocacao alem da sequencia esperada');
    return result;
  }
}

function draftReturned(draft: unknown, invocationId: string): PlanningWorkerInvocationResult {
  return {
    outcome: 'DRAFT_RETURNED',
    invocation_id: invocationId,
    provider_id: 'fake',
    model: 'deterministic-test-double',
    draft,
  };
}

describe('canonicalização do schema_version de protocolo na fronteira do draft', () => {
  it('propaga a versão externa já validada quando a task omite schema_version', () => {
    const result = normalizeUntrustedPlanDraft({
      schema_version: 1,
      tasks: [taskWithoutProtocolVersion()],
    });

    expect(result.outcome).toBe('NORMALIZED');
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.schema_version).toBe(1);
    expect(result.tasks[0]).toEqual(task());
  });

  it('preserva a versão explícita correta sem alterar o parse estrito', () => {
    const result = normalizeUntrustedPlanDraft({ schema_version: 1, tasks: [task()] });

    expect(result.outcome).toBe('NORMALIZED');
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.tasks[0]?.schema_version).toBe(1);
  });

  it('recusa versão de protocolo explicitamente incompatível na task', () => {
    const result = normalizeUntrustedPlanDraft({
      schema_version: 1,
      tasks: [{ ...taskWithoutProtocolVersion(), schema_version: 2 }],
    });

    expect(result.outcome).toBe('INVALID_DRAFT');
    if (result.outcome !== 'INVALID_DRAFT') throw new Error('unreachable');
    expect(result.issues.some((issue) => issue.path.join('.') === 'tasks.0.schema_version')).toBe(true);
  });

  it('não coage string: schema_version "1" continua inválido', () => {
    const result = normalizeUntrustedPlanDraft({
      schema_version: 1,
      tasks: [{ ...taskWithoutProtocolVersion(), schema_version: '1' }],
    });

    expect(result.outcome).toBe('INVALID_DRAFT');
    if (result.outcome !== 'INVALID_DRAFT') throw new Error('unreachable');
    expect(result.issues.some((issue) => issue.path.join('.') === 'tasks.0.schema_version')).toBe(true);
  });

  it.each(['objective', 'acceptance', 'validation', 'task_id', 'resource_envelope'])(
    'só schema_version é canonicalizado: task sem %s continua inválida',
    (field) => {
      const candidate = taskWithoutProtocolVersion();
      delete candidate[field];
      const result = normalizeUntrustedPlanDraft({ schema_version: 1, tasks: [candidate] });

      expect(result.outcome).toBe('INVALID_DRAFT');
      if (result.outcome !== 'INVALID_DRAFT') throw new Error('unreachable');
      expect(result.issues.some((issue) => issue.path.join('.') === `tasks.0.${field}`)).toBe(true);
    },
  );

  it('não muta o candidato: a evidência crua do provider continua sem o campo', () => {
    const raw = { schema_version: 1, tasks: [taskWithoutProtocolVersion()] };
    const snapshot = structuredClone(raw);

    expect(normalizeUntrustedPlanDraft(raw).outcome).toBe('NORMALIZED');
    expect(raw).toEqual(snapshot);
    expect(raw.tasks[0]).not.toHaveProperty('schema_version');
  });
});

describe('ciclo real: rejeição em AVC_DECOMPOSITION seguida de revisão sem schema_version', () => {
  it('a revisão completa deixa de morrer em SCHEMA_NORMALIZATION e chega aos gates seguintes', async () => {
    // Draft inicial: a fronteira máxima de arquivos de uma task crítica é
    // realmente não delimitada, então AVC_DECOMPOSITION continua legítimo.
    const initialDraft = {
      schema_version: 1,
      tasks: [
        task({ task_id: 'conformer-search-selection', acceptance: ['Persistência endurecida e validada'] }),
        task({
          task_id: 'mopac-minimum-verified-workflow',
          risk: 'critical',
          blocked_by: ['conformer-search-selection'],
          resource_envelope: {
            duration_ms: { expected: 600_000, maximum: 1_800_000 },
            tokens: { expected: 50_000, maximum: 150_000 },
            changed_files: { expected: 8, maximum: 40 },
          },
        }),
      ],
    };
    // Replacement: decomposto e sem o metadado de protocolo repetido.
    const replacementDraft = {
      schema_version: 1,
      tasks: [
        taskWithoutProtocolVersion({
          task_id: 'conformer-search-selection',
          acceptance: ['Persistência endurecida e validada'],
        }),
        taskWithoutProtocolVersion({
          task_id: 'mopac-minimum-verified-workflow',
          blocked_by: ['conformer-search-selection'],
        }),
      ],
    };

    const planner = new SequencedPlanner([
      draftReturned(initialDraft, 'fake-1'),
      draftReturned(replacementDraft, 'fake-2'),
    ]);
    const records: PlanningAttemptRecord[] = [];

    const result = await generateImplementationPlan({
      intake: intake(),
      inspection: inspection(),
      authorizationScope: authorizationScope(),
      planningWorker: planner,
      onAttempt: (record) => {
        records.push(record);
      },
    });

    expect(planner.invocations).toHaveLength(2);
    expect(planner.invocations[1]?.revision).toMatchObject({
      attempt: 2,
      previous_stage: 'AVC_DECOMPOSITION',
      requires_complete_replacement: true,
    });
    expect(records[0]?.validation).toMatchObject({
      outcome: 'REJECTED',
      rejected_stage: 'AVC_DECOMPOSITION',
    });
    expect(records[0]?.validation?.issues.join(' ')).toContain('unbounded_rollback_boundary');

    // A asserção central: a revisão passa da normalização de schema.
    expect(records[1]?.validation?.rejected_stage).not.toBe('SCHEMA_NORMALIZATION');
    expect(records[1]?.validation?.issues.join(' ')).not.toContain('schema_version');
    expect(result.outcome).toBe('AUTHORIZED');
  });

  it('a evidência persistida da tentativa continua fiel ao que o provider devolveu', async () => {
    const replacementDraft = {
      schema_version: 1,
      tasks: [taskWithoutProtocolVersion()],
    };
    const snapshot = structuredClone(replacementDraft);
    const planner = new SequencedPlanner([draftReturned(replacementDraft, 'fake-1')]);
    const records: PlanningAttemptRecord[] = [];

    await generateImplementationPlan({
      intake: intake(),
      inspection: inspection(),
      authorizationScope: authorizationScope(),
      planningWorker: planner,
      onAttempt: (record) => {
        records.push(record);
      },
    });

    const evidence = records[0]?.invocation;
    if (evidence?.outcome !== 'DRAFT_RETURNED') throw new Error('expected DRAFT_RETURNED evidence');
    expect(evidence.draft).toEqual(snapshot);
    const persisted = evidence.draft as { tasks: readonly Record<string, unknown>[] };
    expect(persisted.tasks[0]).not.toHaveProperty('schema_version');
    expect(replacementDraft).toEqual(snapshot);
  });
});
