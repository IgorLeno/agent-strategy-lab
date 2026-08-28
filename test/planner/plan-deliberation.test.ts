import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ProjectInspection } from '../../src/inspection/index.js';
import {
  ExecutionAuthorizationScope,
  ProjectIntakeRequest,
} from '../../src/intake/index.js';
import {
  deliberatePlan,
  planRevalidator,
  planVersionSha256,
  planViewOf,
  selectDeliberators,
  validatePlannerDraft,
  type DeliberatorAssignment,
  type ImplementationPlan,
  type PlanDeliberationInvocation,
  type PlanDeliberationInvocationResult,
  type PlanDeliberationWorkerPort,
  type PlanGenerationResult,
} from '../../src/planner/index.js';
import { REPO_ROOT } from '../dev/helpers.js';

const HEAD_SHA = 'a'.repeat(40);

function inspection(): ProjectInspection {
  return ProjectInspection.parse({
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-24T00:00:00.000Z',
    git: { known: true, value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] }, provenance: 'git' },
    stack: {
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'fs:package.json',
    },
    package_manager: { known: true, value: 'pnpm', provenance: 'fs:pnpm-lock.yaml' },
    build_system: { known: true, value: 'typescript', provenance: 'fs:tsconfig.json' },
    directories: [],
    tests: { known: true, value: { framework: 'vitest', test_directories: ['test'] }, provenance: 'fs' },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json:scripts' },
    ],
    dependencies_state: {
      known: true,
      value: { lockfile_path: 'pnpm-lock.yaml', installed: true },
      provenance: 'fs',
    },
    required_tools: [],
    required_services: [],
    filesystem_permissions: { known: true, value: { readable: true, writable: true }, provenance: 'fs' },
    feedback_sources: [],
    project_instructions: [{ path: 'AGENTS.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'src', path: 'src' }],
    relevant_files: [],
    risks: [],
  });
}

const OBJECTIVE = 'Adicionar o filtro de cobertura legal';

function intake(): ProjectIntakeRequest {
  return ProjectIntakeRequest.parse({
    schema_version: 1,
    target_repo: { url: 'https://example.invalid/repo.git' },
    base_revision: { sha: HEAD_SHA },
    user_request: `Implementar o MVP: ${OBJECTIVE}.`,
    objectives: [OBJECTIVE],
    constraints: ['Preservar as decisões de docs/architecture.md'],
    exclusions: ['Stockfish'],
    requested_scope: { summary: 'Implementar o MVP do filtro de cobertura legal' },
  });
}

function scope(): ExecutionAuthorizationScope {
  return ExecutionAuthorizationScope.parse({
    schema_version: 1,
    requested_scope: intake().requested_scope,
    autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE', 'DETERMINISTIC_VALIDATION'],
    human_gated_capabilities: ['DEPLOYMENT_OR_PRODUCTION', 'UNAUTHORIZED_API_BILLING'],
  });
}

function draftTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    task_id: 'legal-coverage',
    objective: 'Implementar o filtro de cobertura legal sobre o motor existente',
    blocked_by: [],
    taxonomy: {
      version: 1,
      task_class: 'feature',
      difficulty_declared: 'medium',
      complexity: 'multi_file',
      ambiguity: 'low',
      verification: 'deterministic',
    },
    risk: 'low',
    acceptance: [OBJECTIVE],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/coverage/legal.ts'],
    probable_files: ['src/coverage/legal.ts'],
    context_scope: { areas: ['src/coverage'] },
    context_requirements: [{ description: 'motor de cobertura', source_anchor: 'src/coverage' }],
    environment_requirements: [{ kind: 'tool', name: 'node', reason: 'typecheck' }],
    estimated_duration: { expected: 600_000, maximum: 1_800_000 },
    validation_budget: { expected: 60_000, maximum: 300_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 20_000, maximum: 60_000 },
      changed_files: { expected: 4, maximum: 10 },
    },
    ...overrides,
  };
}

const revalidate = planRevalidator({
  intake: intake(),
  inspection: inspection(),
  authorizationScope: scope(),
});

function authorizedPlan(draft: unknown = { schema_version: 1, tasks: [draftTask()] }): ImplementationPlan {
  const result: PlanGenerationResult = validatePlannerDraft({
    draft,
    intake: intake(),
    inspection: inspection(),
    authorizationScope: scope(),
  });
  if (result.outcome !== 'AUTHORIZED') {
    throw new Error(`fixture inválida: ${result.stage}: ${result.issues.join('; ')}`);
  }
  return result.plan;
}

const CLAUDE: DeliberatorAssignment = {
  profile_id: 'a-claude-opus',
  provider: 'claude',
  model: 'opus-5',
};
const CODEX: DeliberatorAssignment = {
  profile_id: 'b-codex-sol',
  provider: 'codex',
  model: 'gpt-5.6-sol',
};

interface RecordedInvocation {
  readonly turn: number;
  readonly planSha: string;
  readonly priorObjections: readonly string[];
}

/** Porta de teste: só recebe invocação e devolve veredito. Nada mais. */
function scriptedWorker(
  verdicts: readonly (PlanDeliberationInvocationResult | (() => never))[],
): PlanDeliberationWorkerPort & { readonly seen: RecordedInvocation[] } {
  const seen: RecordedInvocation[] = [];
  return {
    seen,
    async invoke(invocation: PlanDeliberationInvocation): Promise<PlanDeliberationInvocationResult> {
      seen.push({
        turn: invocation.turn,
        planSha: invocation.plan_sha256,
        priorObjections: [...invocation.prior_objections],
      });
      const scripted = verdicts[invocation.turn - 1];
      if (scripted === undefined) throw new Error(`turno ${invocation.turn} não roteirizado`);
      if (typeof scripted === 'function') return scripted();
      return scripted;
    },
  };
}

const ACCEPT: PlanDeliberationInvocationResult = {
  outcome: 'VERDICT_RETURNED',
  verdict: {
    decision: 'ACCEPT',
    material_objections: [],
    material_changes: [],
    rationale: 'o plano cobre o objetivo declarado e respeita as exclusões',
    revised_plan: null,
  },
};

function revise(options: {
  readonly objection: string;
  readonly revisedObjective?: string;
  readonly revisedDraft?: unknown;
}): PlanDeliberationInvocationResult {
  return {
    outcome: 'VERDICT_RETURNED',
    verdict: {
      decision: 'REVISE',
      material_objections: [options.objection],
      material_changes: options.revisedObjective === undefined ? [] : ['objetivo reescrito'],
      rationale: options.objection,
      revised_plan:
        options.revisedDraft ??
        (options.revisedObjective === undefined
          ? null
          : { schema_version: 1, tasks: [draftTask({ objective: options.revisedObjective })] }),
    },
  };
}

describe('deliberação de plano — turnos, convergência e fronteiras', () => {
  it('entrega cada PlannedTask canônica completa ao deliberador', () => {
    const plan = authorizedPlan();
    const view = planViewOf(plan);

    expect(view.tasks[0]).toEqual(plan.tasks[0]?.task);
  });

  it('max_turns 0 não chama deliberador nenhum', async () => {
    const worker = scriptedWorker([]);
    const result = await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 0,
      diversity: 'cross_provider_preferred',
      deliberators: [CLAUDE, CODEX],
      worker,
      revalidate,
    });

    expect(worker.seen).toEqual([]);
    expect(result.artifact.actual_turns).toBe(0);
    expect(result.artifact.convergence_status).toBe('NOT_REQUESTED');
    expect(result.artifact.final_plan_sha256).toBe(result.artifact.initial_plan_sha256);
  });

  it('max_turns 1 chama exatamente um deliberador', async () => {
    const worker = scriptedWorker([revise({ objection: 'falta cobrir o caso de xeque' })]);
    const result = await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 1,
      diversity: 'cross_provider_preferred',
      deliberators: [CLAUDE, CODEX],
      worker,
      revalidate,
    });

    expect(worker.seen).toHaveLength(1);
    expect(result.artifact.actual_turns).toBe(1);
    expect(result.artifact.convergence_status).toBe('MAX_TURNS_REACHED');
    expect(result.artifact.turns[0]?.decision).toBe('REVISE');
  });

  it('convergência antecipada para antes do máximo e não gasta os turnos restantes', async () => {
    const worker = scriptedWorker([
      revise({ objection: 'o objetivo não cita o filtro legal', revisedObjective: 'Implementar o filtro de cobertura legal com casos de xeque' }),
      revise({ objection: 'a validação precisa ser determinística' }),
      ACCEPT,
    ]);
    const result = await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 5,
      diversity: 'cross_provider_preferred',
      deliberators: [CLAUDE, CODEX],
      worker,
      revalidate,
    });

    expect(worker.seen).toHaveLength(3);
    expect(result.artifact.actual_turns).toBe(3);
    expect(result.artifact.requested_max_turns).toBe(5);
    expect(result.artifact.convergence_status).toBe('CONVERGED');
    expect(result.artifact.stop_reason).toContain('convergência no turno 3');
    expect(result.artifact.turns.map((turn) => turn.converged)).toEqual([false, false, true]);
  });

  it('ACCEPT com objeção material não é convergência: prosa não sela plano', async () => {
    const worker = scriptedWorker([
      {
        outcome: 'VERDICT_RETURNED',
        verdict: {
          decision: 'ACCEPT',
          material_objections: ['aceito, mas a validação está fraca'],
          material_changes: [],
          rationale: 'aceito com ressalva',
          revised_plan: null,
        },
      },
      ACCEPT,
    ]);
    const result = await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 3,
      diversity: 'none',
      deliberators: [CLAUDE],
      worker,
      revalidate,
    });

    expect(result.artifact.turns[0]?.converged).toBe(false);
    expect(result.artifact.actual_turns).toBe(2);
    expect(result.artifact.convergence_status).toBe('CONVERGED');
  });

  it('a revisão passa integralmente para o próximo deliberador', async () => {
    const revised = 'Implementar o filtro de cobertura legal cobrindo xeque e cravada';
    const worker = scriptedWorker([
      revise({ objection: 'faltam xeque e cravada', revisedObjective: revised }),
      ACCEPT,
    ]);
    const initial = authorizedPlan();
    const result = await deliberatePlan({
      plan: initial,
      humanRequest: intake().user_request,
      maxTurns: 3,
      diversity: 'cross_provider_preferred',
      deliberators: [CLAUDE, CODEX],
      worker,
      revalidate,
    });

    // O turno 2 recebeu a versão REVISADA, não a original.
    expect(worker.seen[0]?.planSha).toBe(planVersionSha256(initial));
    expect(worker.seen[1]?.planSha).not.toBe(planVersionSha256(initial));
    expect(worker.seen[1]?.planSha).toBe(result.artifact.final_plan_sha256);
    expect(worker.seen[1]?.priorObjections).toEqual(['faltam xeque e cravada']);
    expect(result.plan.tasks[0]?.task.objective).toBe(revised);
    expect(result.artifact.turns[0]?.revision_status).toBe('ACCEPTED_BY_GATES');
  });

  it('revisão recusada pelos gates não vira plano, mesmo no último turno', async () => {
    // Remove o objetivo do usuário do acceptance: USER OBJECTIVES ⊆ PLAN
    // ACCEPTANCE é gate determinístico e não cede a max_turns.
    const worker = scriptedWorker([
      revise({
        objection: 'quero simplificar o acceptance',
        revisedDraft: {
          schema_version: 1,
          tasks: [draftTask({ acceptance: ['algo mais simples'] })],
        },
      }),
    ]);
    const initial = authorizedPlan();
    const result = await deliberatePlan({
      plan: initial,
      humanRequest: intake().user_request,
      maxTurns: 1,
      diversity: 'none',
      deliberators: [CLAUDE],
      worker,
      revalidate,
    });

    expect(result.artifact.turns[0]?.revision_status).toBe('REJECTED_BY_GATES');
    expect(result.artifact.turns[0]?.revision_rejection).toContain('SCHEMA_NORMALIZATION');
    expect(result.plan).toEqual(initial);
    expect(result.artifact.final_plan_sha256).toBe(result.artifact.initial_plan_sha256);
    expect(result.artifact.convergence_status).toBe('MAX_TURNS_REACHED');
    // O acceptance do humano continua no plano de execução.
    expect(result.plan.tasks[0]?.task.acceptance).toContain(OBJECTIVE);
  });

  it('atingir max_turns encerra a deliberação e nunca supera um human gate', async () => {
    const worker = scriptedWorker([
      revise({ objection: 'primeira objeção' }),
      revise({ objection: 'segunda objeção' }),
    ]);
    const result = await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 2,
      diversity: 'cross_provider_preferred',
      deliberators: [CLAUDE, CODEX],
      worker,
      revalidate,
    });

    expect(result.artifact.actual_turns).toBe(2);
    expect(result.artifact.convergence_status).toBe('MAX_TURNS_REACHED');
    expect(result.artifact.stop_reason).toContain('versão canônica mais recente');
    // O artifact não carrega — e não pode carregar — nenhuma autorização.
    const serialized = JSON.stringify(result.artifact);
    expect(serialized).not.toMatch(/autonomous_execution_boundary|human_gated|ALLOW|authorization_scope/);
    expect(result.artifact.provenance.join(' ')).toContain('nunca supera human gate');
  });

  it('deliberador indisponível preserva a versão canônica anterior', async () => {
    const worker = scriptedWorker([
      { outcome: 'INVOCATION_FAILED', failure: { code: 'PROVIDER_PATH_DISABLED', message: 'desligado' } },
    ]);
    const initial = authorizedPlan();
    const result = await deliberatePlan({
      plan: initial,
      humanRequest: intake().user_request,
      maxTurns: 3,
      diversity: 'none',
      deliberators: [CLAUDE],
      worker,
      revalidate,
    });

    expect(result.plan).toEqual(initial);
    expect(result.artifact.turns[0]?.invocation_failure).toContain('PROVIDER_PATH_DISABLED');
    expect(result.artifact.stop_reason).toContain('versão canônica anterior');
  });

  it('INFRA retryable de um deliberador permite o próximo candidato elegível', async () => {
    const worker = scriptedWorker([
      {
        outcome: 'INVOCATION_FAILED',
        failure: {
          code: 'PROVIDER_INVOCATION_FAILED',
          message: 'Unexpected server error',
          retryable: true,
        },
      },
      ACCEPT,
    ]);
    const result = await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 3,
      diversity: 'none',
      deliberators: [CLAUDE, CODEX],
      worker,
      revalidate,
    });
    expect(result.artifact.turns).toHaveLength(2);
    expect(result.artifact.turns[0]?.invocation_failure).toContain('PROVIDER_INVOCATION_FAILED');
    expect(result.artifact.turns[1]?.decision).toBe('ACCEPT');
    expect(result.artifact.convergence_status).toBe('CONVERGED');
  });

  it('veredito não estruturado não vira convergência nem plano', async () => {
    const worker = scriptedWorker([
      { outcome: 'VERDICT_RETURNED', verdict: { decision: 'parece bom para mim' } },
    ]);
    const initial = authorizedPlan();
    const result = await deliberatePlan({
      plan: initial,
      humanRequest: intake().user_request,
      maxTurns: 3,
      diversity: 'none',
      deliberators: [CLAUDE],
      worker,
      revalidate,
    });

    expect(result.artifact.convergence_status).not.toBe('CONVERGED');
    expect(result.artifact.turns[0]?.invocation_failure).toContain('VERDICT_NOT_STRUCTURED');
    expect(result.plan).toEqual(initial);
  });

  it('os artifacts permitem reconstruir a sequência inteira', async () => {
    const worker = scriptedWorker([
      revise({ objection: 'o1', revisedObjective: 'Implementar o filtro de cobertura legal revisado' }),
      revise({ objection: 'o2' }),
      ACCEPT,
    ]);
    const result = await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 5,
      diversity: 'cross_provider_preferred',
      deliberators: [CLAUDE, CODEX],
      worker,
      revalidate,
    });

    expect(result.artifact.turns.map((turn) => turn.turn)).toEqual([1, 2, 3]);
    expect(result.artifact.turns.map((turn) => turn.provider)).toEqual(['claude', 'codex', 'claude']);
    // Cada turno diz sobre QUAL versão falou, e as versões encadeiam.
    expect(result.artifact.turns[0]?.received_plan_sha256).toBe(result.artifact.initial_plan_sha256);
    expect(result.artifact.turns[1]?.received_plan_sha256).toBe(
      result.artifact.turns[0]?.revised_plan_sha256,
    );
    expect(result.artifact.turns[2]?.received_plan_sha256).toBe(
      result.artifact.final_plan_sha256,
    );
    for (const turn of result.artifact.turns) {
      expect(turn.provenance.length).toBeGreaterThan(0);
      expect(turn.rationale).not.toBeNull();
    }
  });
});

describe('diversidade de deliberadores', () => {
  it('cross_provider_preferred alterna providers quando os dois estão disponíveis', () => {
    const selection = selectDeliberators({
      candidates: [CLAUDE, CODEX],
      maxTurns: 3,
      diversity: 'cross_provider_preferred',
    });
    expect(selection.sequence.map((entry) => entry.provider)).toEqual(['claude', 'codex', 'claude']);
    expect(selection.satisfied).toBe(true);
  });

  it('com um provider só, a preferência não vira exigência silenciosa nem gate', () => {
    const selection = selectDeliberators({
      candidates: [CODEX],
      maxTurns: 2,
      diversity: 'cross_provider_preferred',
    });
    expect(selection.sequence.map((entry) => entry.provider)).toEqual(['codex', 'codex']);
    expect(selection.satisfied).toBe(false);
    expect(selection.reason).toContain('só o provider codex está disponível');
  });

  it('cross_provider_preferred prefere top-tier de provider distinto do planner', () => {
    const selection = selectDeliberators({
      candidates: [CLAUDE, CODEX],
      maxTurns: 3,
      diversity: 'cross_provider_preferred',
      plannerProvider: 'claude',
    });
    expect(selection.sequence.map((entry) => entry.provider)).toEqual(['codex', 'claude', 'codex']);
    expect(selection.satisfied).toBe(true);
  });

  it('planner Sol prefere deliberador Opus', () => {
    const selection = selectDeliberators({
      candidates: [CLAUDE, CODEX],
      maxTurns: 2,
      diversity: 'cross_provider_preferred',
      plannerProvider: 'codex',
    });
    expect(selection.sequence.map((entry) => entry.provider)).toEqual(['claude', 'codex']);
    expect(selection.satisfied).toBe(true);
  });

  it('sem deliberador elegível a deliberação não acontece e o plano segue', async () => {
    const initial = authorizedPlan();
    const result = await deliberatePlan({
      plan: initial,
      humanRequest: intake().user_request,
      maxTurns: 3,
      diversity: 'cross_provider_preferred',
      deliberators: [],
      worker: scriptedWorker([]),
      revalidate,
    });
    expect(result.artifact.convergence_status).toBe('NO_DELIBERATOR_AVAILABLE');
    expect(result.artifact.actual_turns).toBe(0);
    expect(result.plan).toEqual(initial);
  });
});

describe('deliberadores são estruturalmente read-only', () => {
  it('a invocação declara o papel e recusa qualquer outro', async () => {
    const worker = scriptedWorker([ACCEPT]);
    await deliberatePlan({
      plan: authorizedPlan(),
      humanRequest: intake().user_request,
      maxTurns: 1,
      diversity: 'none',
      deliberators: [CLAUDE],
      worker,
      revalidate,
    });
    expect(worker.seen).toHaveLength(1);
  });

  /**
   * Prova ESTRUTURAL: o módulo de deliberação não importa nada capaz de
   * escrever repositório, runtime, git ou provider. Um import que dê esse
   * poder quebra este teste antes de virar comportamento.
   */
  it('o módulo não importa nada com poder de escrita', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'src/planner/deliberation.ts'), 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] as string);
    expect(imports.sort()).toEqual([
      '../envelope/index.js',
      '../inspection/index.js',
      '../intake/index.js',
      './draft.js',
      './generate.js',
      './task.js',
      'zod',
    ]);
    expect(source).not.toMatch(/node:fs|node:child_process|spawn\(|writeFile|exec\(/);
  });

  it('a porta do deliberador só sabe devolver veredito', async () => {
    const worker = scriptedWorker([ACCEPT]);
    const result = await worker.invoke({
      schema_version: 1,
      role: 'READ_ONLY_DELIBERATOR',
      workspace_access: 'READ_ONLY',
      turn: 1,
      max_turns: 1,
      human_request: 'pedido',
      plan: planViewOf(authorizedPlan()),
      plan_sha256: '0'.repeat(64),
      prior_objections: [],
    });
    expect(Object.keys(result).sort()).toEqual(['outcome', 'verdict']);
  });
});
