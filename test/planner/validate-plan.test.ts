import { describe, expect, it } from 'vitest';

import {
  MINIMAL_FACTUAL_PREFLIGHT_REQUIREMENTS,
  evaluatePlan,
  evaluatePlanWorkflow,
  normalizeDirectTask,
  validatePlan,
} from '../../src/planner/validate.js';
import type {
  DirectTaskClassification,
  DirectTaskNormalizationInput,
  PlanValidationIssue,
  TaskWorkflowVerdict,
  WorkflowEvaluationContext,
} from '../../src/planner/validate.js';
import { PlannedTask } from '../../src/planner/index.js';
import { TaskTaxonomy } from '../../src/schemas/index.js';
import { ProjectIntakeRequest, RequestedScope } from '../../src/intake/index.js';
import { ProjectInspection } from '../../src/inspection/index.js';

function validTaxonomy(overrides: Partial<TaskTaxonomy> = {}): TaskTaxonomy {
  return {
    version: 1,
    task_class: 'feature',
    difficulty_declared: 'medium',
    ...overrides,
  };
}

function coherentTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'M75',
    objective: 'Implementar o validador de plano',
    blocked_by: [],
    taxonomy: validTaxonomy(),
    risk: 'medium',
    acceptance: ['Validação pura e determinística'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/planner/validate.ts'],
    probable_files: ['src/planner/index.ts'],
    context_scope: { areas: ['planner'] },
    context_requirements: [
      { description: 'entender PlannedTask', source_anchor: 'src/planner/task.ts' },
    ],
    environment_requirements: [{ kind: 'tool', name: 'node', reason: 'runtime do worker' }],
    estimated_duration: { expected: 600_000, maximum: 1_800_000 },
    validation_budget: { expected: 60_000, maximum: 300_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 50_000, maximum: 200_000 },
      changed_files: { expected: 3, maximum: 10 },
    },
    ...overrides,
  };
}

function directCandidateTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return coherentTask({
    risk: 'low',
    taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'deterministic' }),
    context_scope: { areas: ['planner'] },
    ...overrides,
  });
}

function plan(tasks: readonly PlannedTask[]): unknown {
  return { schema_version: 1, tasks };
}

function issueCodes(issues: readonly PlanValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe('validatePlan — validação estrutural pura e determinística', () => {
  it('é determinística: a mesma entrada produz sempre o mesmo resultado', () => {
    const input = plan([coherentTask()]);
    expect(validatePlan(input)).toEqual(validatePlan(input));
  });

  it('aceita um plano com uma task coerente e sem dependências', () => {
    const result = validatePlan(plan([coherentTask()]));
    expect(result.valid).toBe(true);
  });

  it('recusa ciclo de dependência com o caminho do ciclo no motivo', () => {
    const a = coherentTask({ task_id: 'A', blocked_by: ['B'] });
    const b = coherentTask({ task_id: 'B', blocked_by: ['C'] });
    const c = coherentTask({ task_id: 'C', blocked_by: ['A'] });
    const result = validatePlan(plan([a, b, c]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    const cycleIssue = result.issues.find((issue) => issue.code === 'dependency_cycle');
    expect(cycleIssue).toBeDefined();
    expect(cycleIssue?.message).toMatch(/A -> B -> C -> A|B -> C -> A -> B|C -> A -> B -> C/);
  });

  it('recusa dependência inexistente', () => {
    const a = coherentTask({ task_id: 'A', blocked_by: ['DOES_NOT_EXIST'] });
    const result = validatePlan(plan([a]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(issueCodes(result.issues)).toContain('unknown_dependency');
  });

  it('recusa autodependência', () => {
    const a = coherentTask({ task_id: 'A', blocked_by: ['A'] });
    const result = validatePlan(plan([a]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(issueCodes(result.issues)).toContain('self_dependency');
  });

  it('recusa id de task duplicado', () => {
    const result = validatePlan(plan([coherentTask({ task_id: 'A' }), coherentTask({ task_id: 'A' })]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(issueCodes(result.issues)).toContain('duplicate_task_id');
  });

  it('recusa task sem acceptance', () => {
    const raw = { ...coherentTask(), acceptance: [] };
    const result = validatePlan(plan([raw as unknown as PlannedTask]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(issueCodes(result.issues)).toContain('task_schema_invalid');
  });

  it('recusa task com validation insuficiente (vazia)', () => {
    const raw = { ...coherentTask(), validation: [] };
    const result = validatePlan(plan([raw as unknown as PlannedTask]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(issueCodes(result.issues)).toContain('task_schema_invalid');
  });

  it('recusa task malformada (task_id ou blocked_by de forma inválida)', () => {
    const result = validatePlan(plan([{ task_id: 123, blocked_by: [] } as unknown as PlannedTask]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    expect(issueCodes(result.issues)).toContain('malformed_task');
  });

  it('aceita DAG com múltiplas raízes e ramos independentes', () => {
    const foundation = coherentTask({ task_id: 'foundation', blocked_by: [] });
    const engine = coherentTask({ task_id: 'engine', blocked_by: ['foundation'] });
    const assets = coherentTask({ task_id: 'assets', blocked_by: ['foundation'] });
    const infra = coherentTask({ task_id: 'infra', blocked_by: [] });
    const result = validatePlan(plan([foundation, engine, assets, infra]));
    expect(result.valid).toBe(true);
  });

  it('componentes desconexos nunca emitem multiple_objectives', () => {
    const a = coherentTask({ task_id: 'A', blocked_by: [] });
    const b = coherentTask({ task_id: 'B', blocked_by: ['A'] });
    const c = coherentTask({ task_id: 'C', blocked_by: [] });
    const result = validatePlan(plan([a, b, c]));
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error('unreachable');
    expect(result.tasks.map((task) => task.task_id)).toEqual(['A', 'B', 'C']);
  });

  it('aceita plano conexo com múltiplas tasks encadeadas (não é objetivo múltiplo)', () => {
    const a = coherentTask({ task_id: 'A', blocked_by: [] });
    const b = coherentTask({ task_id: 'B', blocked_by: ['A'] });
    const result = validatePlan(plan([a, b]));
    expect(result.valid).toBe(true);
  });

  it('não corrige nada automaticamente: retorna somente os issues, nunca um plano ajustado', () => {
    const raw = { ...coherentTask({ task_id: 'A', blocked_by: ['A'] }) };
    const result = validatePlan(plan([raw]));
    expect(result.valid).toBe(false);
    if (result.valid) throw new Error('unreachable');
    // O único jeito de "corrigir" seria o próprio chamador re-submeter um plano novo.
    expect(Object.keys(result)).toEqual(['valid', 'issues']);
  });
});

describe('evaluatePlan — fail closed', () => {
  it('plano inválido não produz vereditos de workflow', () => {
    const result = evaluatePlan(plan([coherentTask({ task_id: 'A', blocked_by: ['A'] })]));
    expect(result.executable).toBe(false);
    if (result.executable) throw new Error('unreachable');
    expect(result.validation.valid).toBe(false);
  });

  it('plano válido produz um veredito de workflow por task', () => {
    const result = evaluatePlan(plan([coherentTask()]));
    expect(result.executable).toBe(true);
    if (!result.executable) throw new Error('unreachable');
    expect(result.verdicts).toHaveLength(1);
  });
});

describe('evaluatePlanWorkflow — DECOMPOSITION_REQUIRED', () => {
  it('deriva DECOMPOSITION_REQUIRED da engine de M74, com os sinais dela', () => {
    const unbounded = coherentTask({
      risk: 'high',
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 5, maximum: 60 },
      },
    });
    const [verdict] = evaluatePlanWorkflow([unbounded]);
    expect(verdict?.outcome).toBe('DECOMPOSITION_REQUIRED');
    if (verdict?.outcome !== 'DECOMPOSITION_REQUIRED') throw new Error('unreachable');
    expect(verdict.signals.some((s) => s.signal === 'unbounded_rollback_boundary')).toBe(true);
  });

  it('complexidade ordinária de engenharia não vira DECOMPOSITION_REQUIRED', () => {
    const wide = coherentTask({ context_scope: { areas: ['a', 'b', 'c', 'd'] } });
    const [verdict] = evaluatePlanWorkflow([wide]);
    expect(verdict?.outcome).not.toBe('DECOMPOSITION_REQUIRED');
  });

  it('não decompõe uma task crítica só porque ela depende de um predecessor separável', () => {
    const predecessor = coherentTask({
      task_id: 'prepare_authoritative_input',
      objective: 'Preparar e validar a entrada autoritativa do estágio seguinte',
      blocked_by: [],
      risk: 'high',
      context_scope: { areas: ['input preparation'] },
    });
    const downstream = coherentTask({
      task_id: 'apply_critical_transformation',
      objective: 'Aplicar uma transformação crítica e validável sobre a entrada já aceita',
      blocked_by: [predecessor.task_id],
      risk: 'critical',
      context_scope: { areas: ['critical transformation'] },
    });

    const validated = validatePlan(plan([predecessor, downstream]));
    expect(validated.valid).toBe(true);

    const verdicts = evaluatePlanWorkflow([predecessor, downstream]);
    expect(verdicts.find((verdict) => verdict.task_id === downstream.task_id)?.outcome).toBe(
      'REVIEWED_REQUIRED',
    );
  });
});

describe('evaluatePlanWorkflow — MERGE_RECOMMENDED', () => {
  it('nomeia as tasks candidatas quando são encadeadas, triviais e de mesmo escopo', () => {
    const a = coherentTask({
      task_id: 'A',
      blocked_by: [],
      context_scope: { areas: ['planner'] },
      resource_envelope: {
        duration_ms: { expected: 60_000, maximum: 120_000 },
        tokens: { expected: 1_000, maximum: 2_000 },
        changed_files: { expected: 1, maximum: 2 },
      },
    });
    const b = coherentTask({
      task_id: 'B',
      blocked_by: ['A'],
      context_scope: { areas: ['planner'] },
      resource_envelope: {
        duration_ms: { expected: 60_000, maximum: 120_000 },
        tokens: { expected: 1_000, maximum: 2_000 },
        changed_files: { expected: 1, maximum: 2 },
      },
    });
    const verdicts = evaluatePlanWorkflow([a, b]);
    for (const verdict of verdicts) {
      expect(verdict.outcome).toBe('MERGE_RECOMMENDED');
      if (verdict.outcome !== 'MERGE_RECOMMENDED') throw new Error('unreachable');
      expect(verdict.candidate_task_ids).toEqual(['A', 'B']);
    }
  });

  it('não recomenda merge quando o escopo difere', () => {
    const a = coherentTask({
      task_id: 'A',
      blocked_by: [],
      context_scope: { areas: ['planner'] },
      resource_envelope: {
        duration_ms: { expected: 60_000, maximum: 120_000 },
        tokens: { expected: 1_000, maximum: 2_000 },
        changed_files: { expected: 1, maximum: 2 },
      },
    });
    const b = coherentTask({
      task_id: 'B',
      blocked_by: ['A'],
      context_scope: { areas: ['inspection'] },
      resource_envelope: {
        duration_ms: { expected: 60_000, maximum: 120_000 },
        tokens: { expected: 1_000, maximum: 2_000 },
        changed_files: { expected: 1, maximum: 2 },
      },
    });
    const verdicts = evaluatePlanWorkflow([a, b]);
    expect(verdicts.some((v) => v.outcome === 'MERGE_RECOMMENDED')).toBe(false);
  });
});

describe('evaluatePlanWorkflow — DIRECT_ALLOWED', () => {
  const inspection: ProjectInspection = {
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: { known: true, value: { head_sha: 'a'.repeat(40), branch: 'main', dirty: false, remotes: [] }, provenance: 'git' },
    stack: { known: true, value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] }, provenance: 'fs' },
    package_manager: { known: true, value: 'pnpm', provenance: 'fs' },
    build_system: { known: true, value: 'typescript', provenance: 'fs' },
    directories: [],
    tests: { known: true, value: { framework: 'vitest', test_directories: ['test'] }, provenance: 'fs' },
    validation_command_candidates: [{ name: 'typecheck', command: 'tsc --noEmit', source: 'package.json:scripts' }],
    dependencies_state: { known: true, value: { lockfile_path: 'pnpm-lock.yaml', installed: true }, provenance: 'fs' },
    required_tools: [],
    required_services: [],
    filesystem_permissions: { known: true, value: { readable: true, writable: true }, provenance: 'fs' },
    feedback_sources: [],
    project_instructions: [],
    source_anchors: [{ area: 'planner', path: 'src/planner' }],
    relevant_files: [],
    risks: [],
  };

  const intake: ProjectIntakeRequest = {
    schema_version: 1,
    target_repo: { url: 'https://example.invalid/repo.git' },
    base_revision: { sha: 'a'.repeat(40) },
    user_request: 'ajustar validação',
    objectives: ['validação passa'],
    constraints: [],
    exclusions: [],
    requested_scope: { summary: 'ajuste pontual no planner' },
  };

  const context: WorkflowEvaluationContext = { inspection, intake, minimalFactsSource: 'cached_inspection' };

  it('exige todos os critérios objetivos satisfeitos', () => {
    const [verdict] = evaluatePlanWorkflow([directCandidateTask()], context);
    expect(verdict?.outcome).toBe('DIRECT_ALLOWED');
    if (verdict?.outcome !== 'DIRECT_ALLOWED') throw new Error('unreachable');
    expect(verdict.satisfied_criteria.length).toBeGreaterThan(0);
    expect(verdict.required_minimal_facts).toEqual(MINIMAL_FACTUAL_PREFLIGHT_REQUIREMENTS);
    expect(verdict.minimal_facts_source).toBe('cached_inspection');
  });

  it('critério não satisfeito produz REVIEWED_REQUIRED — fail safe', () => {
    const task = directCandidateTask({ risk: 'high' });
    const [verdict] = evaluatePlanWorkflow([task], context);
    expect(verdict?.outcome).toBe('REVIEWED_REQUIRED');
    if (verdict?.outcome !== 'REVIEWED_REQUIRED') throw new Error('unreachable');
    expect(verdict.unmet_criteria.some((c) => c.criterion === 'low_risk')).toBe(true);
  });

  it('critério desconhecido (campo taxonomy opcional ausente) produz REVIEWED_REQUIRED — fail safe', () => {
    const task = directCandidateTask({ taxonomy: validTaxonomy() });
    const [verdict] = evaluatePlanWorkflow([task], context);
    expect(verdict?.outcome).toBe('REVIEWED_REQUIRED');
    if (verdict?.outcome !== 'REVIEWED_REQUIRED') throw new Error('unreachable');
    const unknownStatuses = verdict.unmet_criteria.filter((c) => c.status === 'unknown');
    expect(unknownStatuses.length).toBeGreaterThan(0);
  });

  it('DIRECT_ALLOWED nunca dispensa validation determinística: sem taxonomy.verification=deterministic vira REVIEWED_REQUIRED mesmo com todo o resto satisfeito', () => {
    const task = directCandidateTask({ taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'partially_deterministic' }) });
    const [verdict] = evaluatePlanWorkflow([task], context);
    expect(verdict?.outcome).toBe('REVIEWED_REQUIRED');
    if (verdict?.outcome !== 'REVIEWED_REQUIRED') throw new Error('unreachable');
    expect(verdict.unmet_criteria.some((c) => c.criterion === 'deterministic_validation_known')).toBe(true);
  });

  it('sem preflight (nem inspection nem intake), critérios objetivos satisfeitos ainda assim não bastam', () => {
    const [verdict] = evaluatePlanWorkflow([directCandidateTask()]);
    expect(verdict?.outcome).toBe('REVIEWED_REQUIRED');
    if (verdict?.outcome !== 'REVIEWED_REQUIRED') throw new Error('unreachable');
    expect(verdict.reason).toContain('preflight');
  });

  it('fato mínimo ausente (head_sha divergente do base_revision) impede DIRECT_ALLOWED', () => {
    const staleInspection: ProjectInspection = {
      ...inspection,
      git: { known: true, value: { head_sha: 'b'.repeat(40), branch: 'main', dirty: false, remotes: [] }, provenance: 'git' },
    };
    const [verdict] = evaluatePlanWorkflow([directCandidateTask()], { inspection: staleInspection, intake });
    expect(verdict?.outcome).toBe('REVIEWED_REQUIRED');
    if (verdict?.outcome !== 'REVIEWED_REQUIRED') throw new Error('unreachable');
    expect(verdict.reason).toContain('repo_and_base_revision_confirmed');
  });

  it('fato mínimo inválido (nenhum validation_command_candidate observado) impede DIRECT_ALLOWED', () => {
    const noValidationInspection: ProjectInspection = { ...inspection, validation_command_candidates: [] };
    const [verdict] = evaluatePlanWorkflow([directCandidateTask()], { inspection: noValidationInspection, intake });
    expect(verdict?.outcome).toBe('REVIEWED_REQUIRED');
    if (verdict?.outcome !== 'REVIEWED_REQUIRED') throw new Error('unreachable');
    expect(verdict.reason).toContain('validation_available_identified');
  });
});

describe('normalizeDirectTask — Direct Task Normalization', () => {
  const inspection: ProjectInspection = {
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: { known: true, value: { head_sha: 'a'.repeat(40), branch: 'main', dirty: false, remotes: [] }, provenance: 'git' },
    stack: { known: true, value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] }, provenance: 'fs' },
    package_manager: { known: true, value: 'pnpm', provenance: 'fs' },
    build_system: { known: true, value: 'typescript', provenance: 'fs' },
    directories: [],
    tests: { known: true, value: { framework: 'vitest', test_directories: ['test'] }, provenance: 'fs' },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json:scripts' },
      { name: 'dangerous', command: 'pnpm test && rm -rf /', source: 'package.json:scripts' },
    ],
    dependencies_state: { known: true, value: { lockfile_path: 'pnpm-lock.yaml', installed: true }, provenance: 'fs' },
    required_tools: [{ name: 'node 20', reason: 'engines.node declarado', source: 'package.json:engines' }],
    required_services: [],
    filesystem_permissions: { known: true, value: { readable: true, writable: true }, provenance: 'fs' },
    feedback_sources: [],
    project_instructions: [{ path: 'CLAUDE.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'planner', path: 'src/planner' }],
    relevant_files: [],
    risks: [],
  };

  const intake: ProjectIntakeRequest = {
    schema_version: 1,
    target_repo: { url: 'https://example.invalid/repo.git' },
    base_revision: { sha: 'a'.repeat(40) },
    user_request: 'corrigir mensagem de erro',
    objectives: ['mensagem de erro corrigida'],
    constraints: [],
    exclusions: [],
    requested_scope: { summary: 'corrigir texto da mensagem de erro em validate.ts' },
  };

  const requestedScope: RequestedScope = intake.requested_scope;

  const classification: DirectTaskClassification = {
    task_class: 'bugfix',
    difficulty_declared: 'trivial',
    risk: 'low',
  };

  function normalizationInput(
    overrides: Partial<DirectTaskNormalizationInput> = {},
  ): DirectTaskNormalizationInput {
    return { taskId: 'M75-direct-1', intake, requestedScope, inspection, classification, ...overrides };
  }

  it('produz uma work unit compatível com PlannedTask a partir de intake + requested_scope + preflight', () => {
    const result = normalizeDirectTask(normalizationInput());
    expect(result.outcome).toBe('NORMALIZED');
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(() => PlannedTask.parse(result.task)).not.toThrow();
  });

  it('preenche objective a partir de requested_scope.summary (verbatim)', () => {
    const result = normalizeDirectTask(normalizationInput());
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.task.objective).toBe(requestedScope.summary);
  });

  it('preenche acceptance a partir de intake.objectives (verbatim, sem inventar critério)', () => {
    const result = normalizeDirectTask(normalizationInput());
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.task.acceptance).toEqual(intake.objectives);
  });

  it('descarta candidato de validation que precisaria de shell, nunca inventa nem conserta', () => {
    const result = normalizeDirectTask(normalizationInput());
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.task.validation).toEqual([{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }]);
  });

  it('preenche context_scope.areas a partir de source_anchors conhecidos', () => {
    const result = normalizeDirectTask(normalizationInput());
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.task.context_scope.areas).toEqual(['planner']);
  });

  it('nunca inventa dependências: blocked_by é sempre vazio', () => {
    const result = normalizeDirectTask(normalizationInput());
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.task.blocked_by).toEqual([]);
  });

  it('não assume ambiguidade/complexidade/verificação favoráveis: taxonomy fica sem esses campos', () => {
    const result = normalizeDirectTask(normalizationInput());
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.task.taxonomy.ambiguity).toBeUndefined();
    expect(result.task.taxonomy.complexity).toBeUndefined();
    expect(result.task.taxonomy.verification).toBeUndefined();
  });

  it('risco vem só de classification, nunca inventado como baixo por omissão', () => {
    const result = normalizeDirectTask(normalizationInput({ classification: { ...classification, risk: 'high' } }));
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    expect(result.task.risk).toBe('high');
  });

  it('sem source anchors conhecidos, confiança é insuficiente e o resultado é REVIEWED_REQUIRED', () => {
    const result = normalizeDirectTask(
      normalizationInput({ inspection: { ...inspection, source_anchors: [] } }),
    );
    expect(result.outcome).toBe('REVIEWED_REQUIRED');
  });

  it('sem nenhum validation_command_candidate seguro, confiança é insuficiente e o resultado é REVIEWED_REQUIRED', () => {
    const result = normalizeDirectTask(
      normalizationInput({
        inspection: {
          ...inspection,
          validation_command_candidates: [
            { name: 'dangerous', command: 'pnpm test && rm -rf /', source: 'package.json:scripts' },
          ],
        },
      }),
    );
    expect(result.outcome).toBe('REVIEWED_REQUIRED');
  });

  it('é determinística: a mesma entrada produz sempre o mesmo resultado', () => {
    const input = normalizationInput();
    expect(normalizeDirectTask(input)).toEqual(normalizeDirectTask(input));
  });

  it('a work unit normalizada, alimentada em evaluatePlanWorkflow, nunca recebe o request bruto — só PlannedTask', () => {
    const result = normalizeDirectTask(normalizationInput());
    if (result.outcome !== 'NORMALIZED') throw new Error('unreachable');
    const verdicts: readonly TaskWorkflowVerdict[] = evaluatePlanWorkflow([result.task], { inspection, intake });
    expect(verdicts).toHaveLength(1);
  });
});
