import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENT_READINESS_REQUIREMENTS,
  assessExecution,
} from '../../src/planner/assess.js';
import type { ExecutionAssessmentContext } from '../../src/planner/assess.js';
import { PlannedTask } from '../../src/planner/index.js';
import { TaskTaxonomy } from '../../src/schemas/index.js';
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
    task_id: 'M76',
    objective: 'Implementar o assessment de execução',
    blocked_by: [],
    taxonomy: validTaxonomy(),
    risk: 'medium',
    acceptance: ['Avaliação pura e determinística'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/planner/assess.ts'],
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
      tokens: { expected: 10_000, maximum: 200_000 },
      changed_files: { expected: 3, maximum: 10 },
    },
    ...overrides,
  };
}

const HEAD_SHA = 'a'.repeat(40);

function readyInspection(overrides: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: { known: true, value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] }, provenance: 'git' },
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
    project_instructions: [{ path: 'CLAUDE.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'planner', path: 'src/planner' }],
    relevant_files: [],
    risks: [],
    ...overrides,
  };
}

describe('assessExecution — determinismo e pureza', () => {
  it('é determinística: a mesma entrada produz sempre o mesmo resultado', () => {
    const task = coherentTask();
    const context: ExecutionAssessmentContext = { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA };
    expect(assessExecution(task, context)).toEqual(assessExecution(task, context));
  });

  it('não muta a PlannedTask de entrada', () => {
    const task = coherentTask();
    const snapshot = JSON.parse(JSON.stringify(task));
    assessExecution(task, { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA });
    expect(task).toEqual(snapshot);
  });

  it('sem nenhum contexto de inspeção, environment_readiness é UNKNOWN — nunca READY', () => {
    const result = assessExecution(coherentTask());
    expect(result.environment_readiness.status).toBe('UNKNOWN');
    expect(result.environment_readiness.checks).toHaveLength(ENVIRONMENT_READINESS_REQUIREMENTS.length);
    expect(result.environment_readiness.checks.every((check) => check.status === 'unknown')).toBe(true);
  });
});

describe('assessExecution — difficulty', () => {
  it('mantém a dificuldade declarada quando nenhum sinal estrutural de escalada está presente', () => {
    const result = assessExecution(coherentTask({ taxonomy: validTaxonomy({ difficulty_declared: 'easy' }) }));
    expect(result.difficulty.value).toBe('easy');
  });

  it('escala a dificuldade quando complexity é cross_cutting', () => {
    const result = assessExecution(
      coherentTask({ taxonomy: validTaxonomy({ difficulty_declared: 'easy', complexity: 'cross_cutting' }) }),
    );
    expect(result.difficulty.value).toBe('medium');
    expect(result.difficulty.rationale).toContain('cross_cutting');
  });

  it('escala a dificuldade quando ambiguity é high', () => {
    const result = assessExecution(
      coherentTask({ taxonomy: validTaxonomy({ difficulty_declared: 'medium', ambiguity: 'high' }) }),
    );
    expect(result.difficulty.value).toBe('hard');
  });

  it('nunca escala além de hard', () => {
    const result = assessExecution(
      coherentTask({ taxonomy: validTaxonomy({ difficulty_declared: 'hard', ambiguity: 'high' }) }),
    );
    expect(result.difficulty.value).toBe('hard');
  });
});

describe('assessExecution — risk', () => {
  it('ecoa o risco declarado em PlannedTask.risk, sem elevação', () => {
    const result = assessExecution(coherentTask({ risk: 'high' }));
    expect(result.risk.value).toBe('high');
    expect(result.risk.provenance).toBe('task.risk');
  });

  it('ambiente NOT_READY não eleva risco', () => {
    const inspection = readyInspection({
      filesystem_permissions: { known: true, value: { readable: true, writable: false }, provenance: 'fs' },
    });
    const result = assessExecution(coherentTask({ risk: 'low' }), { inspection, expectedBaseRevisionSha: HEAD_SHA });
    expect(result.environment_readiness.status).toBe('NOT_READY');
    expect(result.risk.value).toBe('low');
  });

  it('ambiente UNKNOWN não eleva risco', () => {
    const result = assessExecution(coherentTask({ risk: 'low' }));
    expect(result.environment_readiness.status).toBe('UNKNOWN');
    expect(result.risk.value).toBe('low');
  });
});

describe('assessExecution — context pressure', () => {
  it('low quando poucas áreas e poucos tokens esperados', () => {
    const result = assessExecution(coherentTask());
    expect(result.context_pressure.value).toBe('low');
  });

  it('high quando context_scope.areas excede o limiar', () => {
    const result = assessExecution(coherentTask({ context_scope: { areas: ['a', 'b', 'c', 'd'] } }));
    expect(result.context_pressure.value).toBe('high');
  });

  it('high quando tokens esperados excedem o limiar', () => {
    const result = assessExecution(
      coherentTask({
        resource_envelope: {
          duration_ms: { expected: 600_000, maximum: 1_800_000 },
          tokens: { expected: 200_000, maximum: 300_000 },
          changed_files: { expected: 3, maximum: 10 },
        },
      }),
    );
    expect(result.context_pressure.value).toBe('high');
  });
});

describe('assessExecution — environment readiness', () => {
  it('READY quando todos os fatos são observados e favoráveis, com base revision confirmada', () => {
    const result = assessExecution(coherentTask(), {
      inspection: readyInspection(),
      expectedBaseRevisionSha: HEAD_SHA,
    });
    expect(result.environment_readiness.status).toBe('READY');
    expect(result.environment_readiness.checks.every((check) => check.status === 'satisfied')).toBe(true);
    expect(result.environment_readiness.facts_source).toBe('full_inspection');
  });

  it('todos os fatos de readiness listados no objetivo estão representados', () => {
    const result = assessExecution(coherentTask(), { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA });
    const requirements = result.environment_readiness.checks.map((check) => check.requirement).sort();
    expect(requirements).toEqual([...ENVIRONMENT_READINESS_REQUIREMENTS].sort());
  });

  it('NOT_READY quando head_sha observado diverge da base revision esperada', () => {
    const result = assessExecution(coherentTask(), {
      inspection: readyInspection(),
      expectedBaseRevisionSha: 'b'.repeat(40),
    });
    expect(result.environment_readiness.status).toBe('NOT_READY');
    const baseRevisionCheck = result.environment_readiness.checks.find((c) => c.requirement === 'base_revision_valid');
    expect(baseRevisionCheck?.status).toBe('not_satisfied');
  });

  it('greenfield (sem validation/build/testes/deps/instruções observados) continua READY: ausência não é blocker', () => {
    const inspection = readyInspection({
      validation_command_candidates: [],
      build_system: { known: false, value: null, reason: 'sem manifesto', provenance: 'fs' },
      tests: { known: false, value: null, reason: 'sem testes', provenance: 'fs' },
      dependencies_state: { known: false, value: null, reason: 'sem lockfile', provenance: 'fs' },
      project_instructions: [],
    });
    const result = assessExecution(coherentTask(), { inspection, expectedBaseRevisionSha: HEAD_SHA });
    expect(result.environment_readiness.status).toBe('READY');
  });

  it('dependências declaradas e não instaladas não bloqueiam: instalar é trabalho do worker', () => {
    const inspection = readyInspection({
      dependencies_state: { known: true, value: { lockfile_path: 'pnpm-lock.yaml', installed: false }, provenance: 'fs' },
    });
    const result = assessExecution(coherentTask(), { inspection, expectedBaseRevisionSha: HEAD_SHA });
    expect(result.environment_readiness.status).toBe('READY');
  });

  it('NOT_READY quando o filesystem observado não é gravável', () => {
    const inspection = readyInspection({
      filesystem_permissions: { known: true, value: { readable: true, writable: false }, provenance: 'fs' },
    });
    const result = assessExecution(coherentTask(), { inspection, expectedBaseRevisionSha: HEAD_SHA });
    expect(result.environment_readiness.status).toBe('NOT_READY');
    const check = result.environment_readiness.checks.find((c) => c.requirement === 'filesystem_permissions_adequate');
    expect(check?.status).toBe('not_satisfied');
  });

  it('UNKNOWN (nunca READY) quando fato de git não é conhecido', () => {
    const inspection = readyInspection({ git: { known: false, value: null, reason: 'repo ilegível', provenance: 'git' } });
    const result = assessExecution(coherentTask(), { inspection, expectedBaseRevisionSha: HEAD_SHA });
    expect(result.environment_readiness.status).not.toBe('READY');
    expect(result.environment_readiness.status).toBe('UNKNOWN');
  });

  it('minimal preflight declarado entra na provenance como facts_source', () => {
    const result = assessExecution(coherentTask(), {
      inspection: readyInspection(),
      expectedBaseRevisionSha: HEAD_SHA,
      factsSource: 'minimal_preflight',
    });
    expect(result.environment_readiness.facts_source).toBe('minimal_preflight');
  });
});

describe('assessExecution — verification strength', () => {
  it('weak quando verification é subjective', () => {
    const result = assessExecution(coherentTask({ taxonomy: validTaxonomy({ verification: 'subjective' }) }));
    expect(result.verification_strength.value).toBe('weak');
  });

  it('weak quando validation está vazio', () => {
    const result = assessExecution(coherentTask({ validation: [] }));
    expect(result.verification_strength.value).toBe('weak');
  });

  it('strong quando verification é deterministic e validation é observado no ambiente', () => {
    const result = assessExecution(coherentTask({ taxonomy: validTaxonomy({ verification: 'deterministic' }) }), {
      inspection: readyInspection(),
      expectedBaseRevisionSha: HEAD_SHA,
    });
    expect(result.verification_strength.value).toBe('strong');
  });

  it('partial quando verification não é declarado — nunca strong por omissão', () => {
    const result = assessExecution(coherentTask(), { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA });
    expect(result.verification_strength.value).toBe('partial');
  });
});

describe('assessExecution — confidence', () => {
  it('reduzida quando taxonomy opcional está ausente, mesmo com ambiente READY', () => {
    const result = assessExecution(coherentTask(), { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA });
    expect(result.confidence.value).not.toBe('high');
  });

  it('alta apenas quando taxonomy completa e ambiente READY', () => {
    const result = assessExecution(
      coherentTask({ taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'deterministic' }) }),
      { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.confidence.value).toBe('high');
  });

  it('baixa quando nenhum fato de ambiente está disponível', () => {
    const result = assessExecution(coherentTask());
    expect(result.confidence.value).toBe('low');
  });

  it('fato ausente nunca aumenta confiança: ambiente NOT_READY reduz confiança, nunca eleva', () => {
    const inspection = readyInspection({
      filesystem_permissions: { known: true, value: { readable: true, writable: false }, provenance: 'fs' },
    });
    const complete = assessExecution(
      coherentTask({ taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'deterministic' }) }),
      { inspection, expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(complete.confidence.value).not.toBe('high');
  });
});

describe('assessExecution — review requirement', () => {
  it('diversidade not_required em risco baixo', () => {
    const result = assessExecution(coherentTask({ risk: 'low' }));
    expect(result.review_requirement.diversity_requirement).toBe('not_required');
  });

  it('diversidade not_required em risco médio', () => {
    const result = assessExecution(coherentTask({ risk: 'medium' }));
    expect(result.review_requirement.diversity_requirement).toBe('not_required');
  });

  it('diversidade preferred em risco alto', () => {
    const result = assessExecution(coherentTask({ risk: 'high' }));
    expect(result.review_requirement.diversity_requirement).toBe('preferred');
  });

  it('diversidade required em risco crítico', () => {
    const result = assessExecution(coherentTask({ risk: 'critical' }));
    expect(result.review_requirement.diversity_requirement).toBe('required');
  });

  it('diversidade não é condição universal de independência: risco baixo pode dispensar diversidade sem dispensar review em geral', () => {
    const lowRisk = assessExecution(coherentTask({ risk: 'low' }));
    expect(lowRisk.review_requirement.diversity_requirement).toBe('not_required');
    expect(typeof lowRisk.review_requirement.independent_review_required).toBe('boolean');
  });

  it('review independente exigido quando risco baixo mas evidência não é forte', () => {
    const result = assessExecution(coherentTask({ risk: 'low' }));
    expect(result.verification_strength.value).not.toBe('strong');
    expect(result.review_requirement.independent_review_required).toBe(true);
  });

  it('review independente dispensável quando risco baixo, evidência forte e confiança não é baixa', () => {
    const inspection = readyInspection();
    const result = assessExecution(
      coherentTask({
        risk: 'low',
        taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'deterministic' }),
      }),
      { inspection, expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.verification_strength.value).toBe('strong');
    expect(result.confidence.value).not.toBe('low');
    expect(result.review_requirement.independent_review_required).toBe(false);
    expect(result.review_requirement.reasons).toEqual([]);
  });

  it('feature normal de risco médio com validação adequada não exige reviewer independente', () => {
    const result = assessExecution(
      coherentTask({
        risk: 'medium',
        taxonomy: validTaxonomy({
          task_class: 'feature',
          complexity: 'subsystem',
          ambiguity: 'medium',
          verification: 'deterministic',
        }),
        context_scope: { areas: ['planner', 'harness'] },
      }),
      { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.review_requirement.independent_review_required).toBe(false);
  });

  it('evidência de verificação fraca exige reviewer mesmo em risco baixo', () => {
    const result = assessExecution(
      coherentTask({ risk: 'low', taxonomy: validTaxonomy({ verification: 'subjective' }) }),
      { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.verification_strength.value).toBe('weak');
    expect(result.review_requirement.independent_review_required).toBe(true);
    expect(result.review_requirement.reasons).toContain('verification_strength=weak');
  });

  it('risco alto com verificação forte e confiança não-baixa NÃO exige reviewer', () => {
    const result = assessExecution(
      coherentTask({
        risk: 'high',
        taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'deterministic' }),
      }),
      { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.verification_strength.value).toBe('strong');
    expect(result.confidence.value).not.toBe('low');
    expect(result.review_requirement.independent_review_required).toBe(false);
    expect(result.review_requirement.reasons).toEqual([]);
  });

  it('risco alto com verificação partial e confiança não-baixa NÃO exige reviewer', () => {
    const result = assessExecution(
      coherentTask({
        risk: 'high',
        taxonomy: validTaxonomy({
          complexity: 'local',
          ambiguity: 'low',
          verification: 'partially_deterministic',
        }),
      }),
      { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.verification_strength.value).toBe('partial');
    expect(result.confidence.value).not.toBe('low');
    expect(result.review_requirement.independent_review_required).toBe(false);
    expect(result.review_requirement.reasons).toEqual([]);
  });

  it('risco alto com verificação fraca exige reviewer, e a razão é a verificação — não o label', () => {
    const result = assessExecution(
      coherentTask({
        risk: 'high',
        taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'subjective' }),
      }),
      { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.verification_strength.value).toBe('weak');
    expect(result.review_requirement.independent_review_required).toBe(true);
    expect(result.review_requirement.reasons).toEqual(['verification_strength=weak']);
    expect(result.review_requirement.diversity_requirement).toBe('preferred');
  });

  it('risco alto com confiança baixa exige reviewer, e a razão é a confiança — não o label', () => {
    const result = assessExecution(
      coherentTask({
        risk: 'high',
        taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'deterministic' }),
      }),
    );
    expect(result.confidence.value).toBe('low');
    expect(result.review_requirement.independent_review_required).toBe(true);
    expect(result.review_requirement.reasons).toEqual(['confidence=low']);
    expect(result.review_requirement.diversity_requirement).toBe('preferred');
  });

  it('risk=high nunca é razão de review por si só, em nenhuma combinação', () => {
    for (const verification of ['deterministic', 'partially_deterministic', 'subjective'] as const) {
      const result = assessExecution(
        coherentTask({
          risk: 'high',
          taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification }),
        }),
        { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
      );
      expect(result.review_requirement.reasons).not.toContain('risk=high');
    }
  });

  it('review independente exigido em risco crítico mesmo com evidência forte e confiança alta', () => {
    const inspection = readyInspection();
    const result = assessExecution(
      coherentTask({
        risk: 'critical',
        taxonomy: validTaxonomy({ complexity: 'local', ambiguity: 'low', verification: 'deterministic' }),
      }),
      { inspection, expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.review_requirement.independent_review_required).toBe(true);
    expect(result.review_requirement.diversity_requirement).toBe('required');
    expect(result.review_requirement.reasons).toEqual(['risk=critical']);
  });

  it('MOPAC-like: risco científico critical continua exigindo review e diversidade, sem virar categoria de autorização', () => {
    const result = assessExecution(
      coherentTask({
        task_id: 'mopac_minimum_workflow',
        objective:
          'Implement independent AM1/PM3/PM7 optimization, minimum verification, and explicitly bounded recovery from saddle or verification failure.',
        risk: 'critical',
        taxonomy: validTaxonomy({
          difficulty_declared: 'hard',
          complexity: 'subsystem',
          ambiguity: 'medium',
          verification: 'partially_deterministic',
        }),
        environment_requirements: [
          {
            kind: 'tool',
            name: 'MOPAC',
            reason: 'Optional real AM1/PM3/PM7 optimization; unit tests must use test doubles.',
          },
        ],
      }),
      { inspection: readyInspection(), expectedBaseRevisionSha: HEAD_SHA },
    );
    expect(result.risk.value).toBe('critical');
    expect(result.review_requirement.independent_review_required).toBe(true);
    expect(result.review_requirement.diversity_requirement).toBe('required');
  });
});
