import { describe, expect, it } from 'vitest';

import { ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution, type PlannedTask } from '../../src/planner/index.js';
import {
  CapabilityRegistry,
  capabilityOf,
  routeInitialProfile,
  type InitialRoutingInput,
  type ProfileCapability,
  type RoutingCandidate,
  type StructuredWorkUnit,
} from '../../src/routing/index.js';

const HEAD_SHA = 'a'.repeat(40);

function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'M78',
    objective: 'Implementar uma mudança local',
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
    acceptance: ['mudança validada'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/routing/router.ts'],
    probable_files: ['test/routing/router.test.ts'],
    context_scope: { areas: ['routing'] },
    context_requirements: [{ description: 'router', source_anchor: 'src/routing/router.ts' }],
    environment_requirements: [{ kind: 'tool', name: 'node', reason: 'typecheck' }],
    estimated_duration: { expected: 500_000, maximum: 1_500_000 },
    validation_budget: { expected: 60_000, maximum: 300_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 10_000, maximum: 50_000 },
      changed_files: { expected: 2, maximum: 5 },
    },
    ...overrides,
  };
}

function inspection(overrides: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: {
      known: true,
      value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git',
    },
    stack: {
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'fs:package.json',
    },
    package_manager: { known: true, value: 'pnpm', provenance: 'fs:pnpm-lock.yaml' },
    build_system: { known: true, value: 'typescript', provenance: 'fs:tsconfig.json' },
    directories: [],
    tests: {
      known: true,
      value: { framework: 'vitest', test_directories: ['test'] },
      provenance: 'fs',
    },
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
    filesystem_permissions: {
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs',
    },
    feedback_sources: [],
    project_instructions: [{ path: 'AGENTS.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'routing', path: 'src/routing' }],
    relevant_files: [],
    risks: [],
    ...overrides,
  };
}

function workUnit(
  plannedTask: PlannedTask = task(),
  facts: ProjectInspection = inspection(),
  source: StructuredWorkUnit['source'] = 'planner',
): StructuredWorkUnit {
  return {
    source,
    task: plannedTask,
    assessment: assessExecution(plannedTask, {
      inspection: facts,
      expectedBaseRevisionSha: HEAD_SHA,
      factsSource: source === 'direct_task_normalization' ? 'minimal_preflight' : 'full_inspection',
    }),
    project_facts: facts,
  };
}

function capability(
  profileId: string,
  model: string,
  reasoningEffort: string,
  overrides: Partial<Parameters<typeof capabilityOf>[0]> = {},
): ProfileCapability {
  return capabilityOf({
    profile_id: profileId,
    agent: 'codex',
    model,
    reasoning_effort: reasoningEffort,
    reasoning_effort_source: 'codex_config_override',
    billing_mode: 'subscription_only',
    credential_source: 'chatgpt_subscription',
    environment_mode: 'real-world',
    instruction_environment: 'sanitized_user_home',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    sandbox: 'workspace-write',
    session_persistence: 'ephemeral',
    ...overrides,
  });
}

function candidate(
  profileId: string,
  maximumMs = 3_600_000,
  overrides: Partial<RoutingCandidate> = {},
): RoutingCandidate {
  return {
    profile_id: profileId,
    availability: { value: true, provenance: 'doctor.ok' },
    runtime_bounds: [
      {
        kind: 'WORKER_RUNTIME_BOUND',
        source: 'launcher',
        maximum_ms: maximumMs,
        provenance: 'LauncherProfile.timeout_seconds',
      },
    ],
    ...overrides,
  };
}

function input(
  unit: StructuredWorkUnit = workUnit(),
  capabilities: readonly ProfileCapability[] = [
    capability('luna-medium', 'gpt-5.6-luna', 'medium'),
    capability('terra-medium', 'gpt-5.6-terra', 'medium'),
    capability('sol-high', 'gpt-5.6-sol', 'high'),
  ],
  candidates: readonly RoutingCandidate[] = capabilities.map((entry) => candidate(entry.profile_id)),
): InitialRoutingInput {
  return {
    work_unit: unit,
    role: 'implementer',
    capability_registry: new CapabilityRegistry(capabilities),
    candidates,
  };
}

describe('routeInitialProfile — escolha determinística e econômica', () => {
  it('mesma entrada produz exatamente o mesmo profile e budget', () => {
    const routingInput = input();
    expect(routeInitialProfile(routingInput)).toEqual(routeInitialProfile(routingInput));
  });

  it('task fácil, local, de baixo risco e verificação forte escolhe economy', () => {
    const result = routeInitialProfile(input());
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.profile.profile_id).toBe('luna-medium');
    expect(result.candidates_considered).toContainEqual(
      expect.objectContaining({ profile_id: 'luna-medium', capability_tier: 'economy', outcome: 'SELECTED' }),
    );
    expect(result.candidates_considered).toHaveLength(3);
    expect(result.rationale.join(' ')).toContain('menor recurso elegível');
  });

  it('entre profiles do mesmo tier escolhe o de menor custo model/effort, não a ordem de entrada', () => {
    const terra = capability('terra-medium', 'gpt-5.6-terra', 'medium');
    const sol = capability('sol-medium', 'gpt-5.6-sol', 'medium');
    const mediumTask = task({ taxonomy: { ...task().taxonomy, difficulty_declared: 'medium' } });
    const result = routeInitialProfile(
      input(workUnit(mediumTask), [sol, terra], [candidate(sol.profile_id), candidate(terra.profile_id)]),
    );
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.profile.profile_id).toBe('terra-medium');
    expect(result.candidates_considered).toContainEqual(
      expect.objectContaining({ profile_id: 'sol-medium', outcome: 'NOT_SELECTED' }),
    );
  });

  it('task difícil e de risco alto pode começar no tier intermediário, com rationale', () => {
    const hardTask = task({
      taxonomy: { ...task().taxonomy, difficulty_declared: 'hard' },
      risk: 'high',
    });
    const result = routeInitialProfile(input(workUnit(hardTask)));
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.profile.profile_id).toBe('terra-medium');
    expect(result.rationale.join(' ')).toMatch(/difficulty=hard.*risk=high/);
  });

  it('pressão de contexto, verificação fraca e review requerido elevam o tier', () => {
    const pressuredTask = task({
      taxonomy: {
        ...task().taxonomy,
        complexity: 'cross_cutting',
        ambiguity: 'high',
        verification: 'subjective',
      },
      risk: 'critical',
      context_scope: { areas: ['a', 'b', 'c', 'd'] },
    });
    const result = routeInitialProfile(input(workUnit(pressuredTask)));
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.profile.profile_id).toBe('sol-high');
    expect(result.rationale.join(' ')).toMatch(/context_pressure=high.*verification_strength=weak/);
    expect(result.rationale.join(' ')).toContain('diversity_requirement=required');
  });
});

describe('routeInitialProfile — worker runtime budget é uma grandeza própria', () => {
  it('deriva budget de envelope, capability, custo agregado de validation, stack e ambiente', () => {
    const baseResult = routeInitialProfile(input());
    const richerFacts = inspection({
      stack: {
        known: true,
        value: { primary_ecosystem: 'node', ecosystems_detected: ['node', 'python'] },
        provenance: 'fs',
      },
      required_services: [{ name: 'postgres', reason: 'integração', source: '.env.example' }],
    });
    const richerResult = routeInitialProfile(input(workUnit(task(), richerFacts)));
    expect(baseResult.outcome).toBe('ROUTED');
    expect(richerResult.outcome).toBe('ROUTED');
    if (baseResult.outcome !== 'ROUTED' || richerResult.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(richerResult.worker_runtime_budget.milliseconds).toBeGreaterThan(
      baseResult.worker_runtime_budget.milliseconds,
    );
    expect(richerResult.worker_runtime_budget.components.stack_multiplier).toBeGreaterThan(1);
    expect(richerResult.worker_runtime_budget.components.aggregate_validation_cost_ms).toBe(60_000);
  });

  it('não usa estimated task duration nem timeout por comando e aceita runtime maior que ambos', () => {
    const firstTask = task({
      estimated_duration: { expected: 1, maximum: 2 },
      validation: [{ argv: ['true'], timeout_seconds: 1 }],
    });
    const secondTask = task({
      estimated_duration: { expected: 9_000_000, maximum: 12_000_000 },
      validation: [{ argv: ['true'], timeout_seconds: 3_600 }],
    });
    const first = routeInitialProfile(input(workUnit(firstTask)));
    const second = routeInitialProfile(input(workUnit(secondTask)));
    expect(first.outcome).toBe('ROUTED');
    expect(second.outcome).toBe('ROUTED');
    if (first.outcome !== 'ROUTED' || second.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(first.worker_runtime_budget.milliseconds).toBe(second.worker_runtime_budget.milliseconds);
    expect(first.worker_runtime_budget.milliseconds).toBeGreaterThan(1_000);
    expect(first.worker_runtime_budget.provenance.join(' ')).not.toContain('timeout_seconds');
    expect(first.worker_runtime_budget.provenance.join(' ')).not.toContain('estimated_duration');
  });

  it('não introduz teto universal: budgets acima do antigo teto por comando são roteáveis', () => {
    const longTask = task({
      resource_envelope: {
        ...task().resource_envelope,
        duration_ms: { expected: 8_000_000, maximum: 20_000_000 },
      },
    });
    const luna = capability('luna-medium', 'gpt-5.6-luna', 'medium');
    const result = routeInitialProfile(
      input(workUnit(longTask), [luna], [candidate(luna.profile_id, 30_000_000)]),
    );
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.worker_runtime_budget.milliseconds).toBeGreaterThan(3_600_000);
  });
});

describe('routeInitialProfile — bounds estruturais e fallback', () => {
  it('budget fora do bound retorna BUDGET_UNSUPPORTED com bound, pedido, profile e provenance', () => {
    const luna = capability('luna-medium', 'gpt-5.6-luna', 'medium');
    const result = routeInitialProfile(input(workUnit(), [luna], [candidate(luna.profile_id, 10_000)]));
    expect(result.outcome).toBe('BUDGET_UNSUPPORTED');
    if (result.outcome !== 'BUDGET_UNSUPPORTED') throw new Error('unreachable');
    expect(result.violations[0]).toMatchObject({
      profile_id: 'luna-medium',
      violated_bound: { kind: 'WORKER_RUNTIME_BOUND', source: 'launcher', maximum_ms: 10_000 },
    });
    expect(result.violations[0]?.requested_budget_ms).toBeGreaterThan(10_000);
    expect(result.violations[0]?.provenance.length).toBeGreaterThan(1);
    expect(result.allowed_next_steps).toEqual([
      'TRY_ANOTHER_PROFILE',
      'RECONFIGURE_RUNTIME',
      'REPLAN',
      'HUMAN_REQUIRED',
    ]);
  });

  it('não trunca o budget e tenta outro profile elegível cujo bound suporta o pedido', () => {
    const first = capability('terra-a', 'gpt-5.6-terra', 'medium');
    const second = capability('terra-b', 'gpt-5.6-terra', 'medium');
    const hardTask = task({ taxonomy: { ...task().taxonomy, difficulty_declared: 'hard' }, risk: 'high' });
    const result = routeInitialProfile(
      input(workUnit(hardTask), [first, second], [candidate('terra-a', 10_000), candidate('terra-b')]),
    );
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.profile.profile_id).toBe('terra-b');
    expect(result.candidates_considered).toContainEqual(
      expect.objectContaining({ profile_id: 'terra-a', rejection_code: 'BUDGET_UNSUPPORTED' }),
    );
    expect(result.worker_runtime_budget.milliseconds).toBeGreaterThan(10_000);
  });

  it('valida contra launcher e profile runtime, mas contra nenhum timeout de validation', () => {
    const luna = capability('luna-medium', 'gpt-5.6-luna', 'medium');
    const bounded = candidate(luna.profile_id, 3_600_000, {
      runtime_bounds: [
        {
          kind: 'WORKER_RUNTIME_BOUND',
          source: 'launcher',
          maximum_ms: 3_600_000,
          provenance: 'launcher override',
        },
        {
          kind: 'WORKER_RUNTIME_BOUND',
          source: 'profile_runtime',
          maximum_ms: 800_000,
          provenance: 'profile runtime contract',
        },
      ],
    });
    const result = routeInitialProfile(input(workUnit(), [luna], [bounded]));
    expect(result.outcome).toBe('BUDGET_UNSUPPORTED');
    if (result.outcome !== 'BUDGET_UNSUPPORTED') throw new Error('unreachable');
    expect(result.violations.map((violation) => violation.violated_bound.source)).toEqual([
      'profile_runtime',
    ]);
  });
});

describe('routeInitialProfile — fatos e compatibilidade bloqueiam defaults silenciosos', () => {
  it('minimal factual preflight basta no caminho DIRECT', () => {
    const unit = workUnit(task(), inspection(), 'direct_task_normalization');
    const result = routeInitialProfile(input(unit));
    expect(unit.assessment.environment_readiness.facts_source).toBe('minimal_preflight');
    expect(result.outcome).toBe('ROUTED');
  });

  it('stack ausente (greenfield) não impede a decisão: multiplicador neutro, nenhum default inventado', () => {
    const facts = inspection({
      stack: { known: false, value: null, reason: 'manifesto ausente', provenance: 'fs:markers' },
    });
    const result = routeInitialProfile(input(workUnit(task(), facts)));
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.worker_runtime_budget.components.stack_multiplier).toBe(1);
  });

  it('repositório greenfield inteiro (sem manifesto, build, testes, deps, validation ou instruções) é roteável: a bootstrap task pode lançar', () => {
    const greenfield = inspection({
      stack: { known: false, value: null, reason: 'manifesto ausente', provenance: 'fs:markers' },
      package_manager: { known: false, value: null, reason: 'sem lockfile', provenance: 'fs' },
      build_system: { known: false, value: null, reason: 'sem manifesto', provenance: 'fs' },
      tests: { known: false, value: null, reason: 'sem testes', provenance: 'fs' },
      validation_command_candidates: [],
      dependencies_state: { known: false, value: null, reason: 'sem lockfile', provenance: 'fs' },
      project_instructions: [],
      source_anchors: [],
    });
    const bootstrap = task();
    const unit = workUnit(bootstrap, greenfield);
    expect(unit.assessment.environment_readiness.status).toBe('READY');
    expect(routeInitialProfile(input(unit)).outcome).toBe('ROUTED');
  });

  it('environment readiness inválido impede routing', () => {
    const facts = inspection({
      filesystem_permissions: { known: true, value: { readable: true, writable: false }, provenance: 'fs' },
    });
    const result = routeInitialProfile(input(workUnit(task(), facts)));
    expect(result).toMatchObject({ outcome: 'HUMAN_REQUIRED' });
    if (result.outcome !== 'HUMAN_REQUIRED') throw new Error('unreachable');
    expect(result.reason).toContain('environment_readiness=NOT_READY');
  });

  it('descarta profile indisponível, role incompatível e billing API com motivos', () => {
    const unavailable = capability('luna-unavailable', 'gpt-5.6-luna', 'medium');
    const api = capability('luna-api', 'gpt-5.6-luna', 'medium', { billing_mode: 'api' });
    const incompatible = capability('luna-review-only', 'gpt-5.6-luna', 'medium', {
      sandbox: 'read-only',
    });
    const usable = capability('luna-usable', 'gpt-5.6-luna', 'medium');
    const result = routeInitialProfile(
      input(workUnit(), [unavailable, api, incompatible, usable], [
        candidate(unavailable.profile_id, 3_600_000, {
          availability: { value: false, provenance: 'doctor failed' },
        }),
        candidate(api.profile_id),
        candidate(incompatible.profile_id),
        candidate(usable.profile_id),
      ]),
    );
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(result.profile.profile_id).toBe('luna-usable');
    expect(result.candidates_considered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profile_id: 'luna-unavailable', rejection_code: 'PROFILE_UNAVAILABLE' }),
        expect.objectContaining({ profile_id: 'luna-api', rejection_code: 'API_BILLING_REQUIRES_EXPLICIT_SELECTION' }),
        expect.objectContaining({ profile_id: 'luna-review-only', rejection_code: 'ROLE_INCOMPATIBLE' }),
      ]),
    );
  });

  it('não aceita request bruto no lugar da work unit estruturada', () => {
    const malformed = input();
    const result = routeInitialProfile({
      ...malformed,
      work_unit: { objective: 'request cru' } as unknown as StructuredWorkUnit,
    });
    expect(result).toMatchObject({ outcome: 'HUMAN_REQUIRED' });
    if (result.outcome !== 'HUMAN_REQUIRED') throw new Error('unreachable');
    expect(result.reason).toContain('work unit inválida');
  });
});

/**
 * O incidente que originou estas regressões: o runtime do coding worker
 * recebia `validation_budget.expected` mesmo quando a validação oficial é do
 * orchestrator, e o excesso derrubava por BUDGET_UNSUPPORTED tasks que cabiam
 * no bound. Os shapes abaixo são genéricos de propósito — nenhum `task_id`,
 * profile ou repositório real participa da regra.
 */
describe('routeInitialProfile — validation budget pertence ao stage que o executa', () => {
  const IMPLEMENTATION_MS = 1_500_000;
  const VALIDATION_MS = 420_000;
  const ADVANCED_BOUND_MS = 1_800_000;

  /** Shape do incidente: hard, subsystem, feature, risco alto. */
  function heavyTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
    return task({
      taxonomy: {
        version: 1,
        task_class: 'feature',
        difficulty_declared: 'hard',
        complexity: 'subsystem',
        ambiguity: 'low',
        verification: 'deterministic',
      },
      risk: 'high',
      estimated_duration: { expected: IMPLEMENTATION_MS, maximum: 1_800_000 },
      validation_budget: { expected: VALIDATION_MS, maximum: 900_000 },
      resource_envelope: {
        duration_ms: { expected: IMPLEMENTATION_MS, maximum: 1_800_000 },
        tokens: { expected: 28_000, maximum: 45_000 },
        changed_files: { expected: 4, maximum: 6 },
      },
      ...overrides,
    });
  }

  function orchestratedAdvanced(): ProfileCapability {
    return capability('sol-high', 'gpt-5.6-sol', 'high');
  }

  /** Policy legada suportada: o próprio worker executa a validação oficial. */
  function workerOwnedAdvanced(): ProfileCapability {
    return capability('sol-high', 'gpt-5.6-sol', 'high', {
      commit_owner: 'worker',
      official_validation_owner: 'worker',
      worker_validation_policy: 'full',
    });
  }

  function routeWith(
    capabilityUsed: ProfileCapability,
    plannedTask: PlannedTask,
    boundMs = ADVANCED_BOUND_MS,
  ) {
    return routeInitialProfile(
      input(workUnit(plannedTask), [capabilityUsed], [candidate(capabilityUsed.profile_id, boundMs)]),
    );
  }

  it('A — com validação oficial do orchestrator, o custo de validação não entra no runtime do worker', () => {
    const result = routeWith(orchestratedAdvanced(), heavyTask());
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');

    const { components, milliseconds } = result.worker_runtime_budget;
    expect(components.aggregate_validation_cost_ms).toBe(VALIDATION_MS);
    expect(components.worker_owned_validation_cost_ms).toBe(0);
    expect(milliseconds).toBe(
      Math.ceil(
        (IMPLEMENTATION_MS *
          components.capability_multiplier *
          components.task_class_multiplier *
          components.stack_multiplier *
          components.environment_multiplier) /
          1_000,
      ) * 1_000,
    );
  });

  it('B — na mesma policy, mudar só o validation_budget não altera o runtime do worker', () => {
    const cheap = routeWith(orchestratedAdvanced(), heavyTask());
    const expensive = routeWith(
      orchestratedAdvanced(),
      heavyTask({ validation_budget: { expected: 900_000, maximum: 1_800_000 } }),
    );
    expect(cheap.outcome).toBe('ROUTED');
    expect(expensive.outcome).toBe('ROUTED');
    if (cheap.outcome !== 'ROUTED' || expensive.outcome !== 'ROUTED') throw new Error('unreachable');

    expect(expensive.worker_runtime_budget.milliseconds).toBe(
      cheap.worker_runtime_budget.milliseconds,
    );
    // O budget de validação continua observado, não some do contrato.
    expect(expensive.worker_runtime_budget.components.aggregate_validation_cost_ms).toBe(900_000);
  });

  it('C — shape hard/subsystem/feature/risco alto cabe num bound advanced de 1.8M e roteia', () => {
    const result = routeWith(orchestratedAdvanced(), heavyTask());
    expect(result.outcome).toBe('ROUTED');
    if (result.outcome !== 'ROUTED') throw new Error('unreachable');

    expect(result.profile.profile_id).toBe('sol-high');
    expect(result.worker_runtime_budget.milliseconds).toBe(1_560_000);
    expect(result.worker_runtime_budget.milliseconds).toBeLessThanOrEqual(ADVANCED_BOUND_MS);
    // A soma antiga (implementação + validação) estourava o mesmo bound.
    expect(
      (IMPLEMENTATION_MS + VALIDATION_MS) *
        result.worker_runtime_budget.components.capability_multiplier *
        result.worker_runtime_budget.components.task_class_multiplier *
        result.worker_runtime_budget.components.stack_multiplier *
        result.worker_runtime_budget.components.environment_multiplier,
    ).toBeGreaterThan(ADVANCED_BOUND_MS);
  });

  it('D — shape de self-maintenance (bugfix, uma tool exigida) deixa de estourar o bound', () => {
    const bugfix = heavyTask({
      taxonomy: {
        version: 1,
        task_class: 'bugfix',
        difficulty_declared: 'hard',
        complexity: 'subsystem',
        ambiguity: 'low',
        verification: 'deterministic',
      },
    });
    const facts = inspection({
      required_tools: [{ name: 'node', reason: 'vitest', source: 'package.json' }],
    });
    const unit = workUnit(bugfix, facts);
    const orchestrated = orchestratedAdvanced();
    const legacy = workerOwnedAdvanced();

    const beforeOwnershipFix = routeInitialProfile(
      input(unit, [legacy], [candidate(legacy.profile_id, ADVANCED_BOUND_MS)]),
    );
    const afterOwnershipFix = routeInitialProfile(
      input(unit, [orchestrated], [candidate(orchestrated.profile_id, ADVANCED_BOUND_MS)]),
    );

    // Cobrar a validação oficial do worker é exatamente o cálculo que produziu
    // o deadlock de bootstrap: 1.849.000ms contra um bound de 1.800.000ms.
    expect(beforeOwnershipFix.outcome).toBe('BUDGET_UNSUPPORTED');
    if (beforeOwnershipFix.outcome !== 'BUDGET_UNSUPPORTED') throw new Error('unreachable');
    expect(beforeOwnershipFix.violations[0]?.requested_budget_ms).toBe(1_849_000);

    expect(afterOwnershipFix.outcome).toBe('ROUTED');
    if (afterOwnershipFix.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(afterOwnershipFix.worker_runtime_budget.milliseconds).toBe(1_445_000);
  });

  it('E — na policy legada, o worker executa a validação oficial e é cobrado por ela', () => {
    const legacy = workerOwnedAdvanced();
    const bound = 4_000_000;
    const withValidation = routeWith(legacy, heavyTask(), bound);
    const withoutValidationChange = routeWith(
      legacy,
      heavyTask({ validation_budget: { expected: 0, maximum: 900_000 } }),
      bound,
    );
    expect(withValidation.outcome).toBe('ROUTED');
    expect(withoutValidationChange.outcome).toBe('ROUTED');
    if (withValidation.outcome !== 'ROUTED' || withoutValidationChange.outcome !== 'ROUTED') {
      throw new Error('unreachable');
    }

    expect(withValidation.worker_runtime_budget.components.worker_owned_validation_cost_ms).toBe(
      VALIDATION_MS,
    );
    expect(withValidation.worker_runtime_budget.milliseconds).toBeGreaterThan(
      withoutValidationChange.worker_runtime_budget.milliseconds,
    );
  });

  it('F — runtime genuíno de implementação acima de todo bound continua BUDGET_UNSUPPORTED, sem clamp', () => {
    const huge = heavyTask({
      validation_budget: { expected: 0, maximum: 0 },
      resource_envelope: {
        ...heavyTask().resource_envelope,
        duration_ms: { expected: 6_000_000, maximum: 8_000_000 },
      },
    });
    const result = routeWith(orchestratedAdvanced(), huge);
    expect(result.outcome).toBe('BUDGET_UNSUPPORTED');
    if (result.outcome !== 'BUDGET_UNSUPPORTED') throw new Error('unreachable');

    const violation = result.violations[0];
    expect(violation?.violated_bound.maximum_ms).toBe(ADVANCED_BOUND_MS);
    expect(violation?.requested_budget_ms).toBeGreaterThan(ADVANCED_BOUND_MS);
  });

  it('H — a ownership da validação não move a capability tier exigida', () => {
    const orchestrated = routeWith(orchestratedAdvanced(), heavyTask());
    const legacy = routeWith(workerOwnedAdvanced(), heavyTask(), 4_000_000);
    expect(orchestrated.outcome).toBe('ROUTED');
    expect(legacy.outcome).toBe('ROUTED');
    if (orchestrated.outcome !== 'ROUTED' || legacy.outcome !== 'ROUTED') {
      throw new Error('unreachable');
    }

    expect(orchestrated.candidates_considered[0]?.capability_tier).toBe('advanced');
    expect(legacy.candidates_considered[0]?.capability_tier).toBe('advanced');
    expect(orchestrated.worker_runtime_budget.components.capability_multiplier).toBe(
      legacy.worker_runtime_budget.components.capability_multiplier,
    );

    // Um profile intermediate não se torna elegível por causa do budget menor.
    const intermediate = capability('terra-medium', 'gpt-5.6-terra', 'medium');
    const rejected = routeWith(intermediate, heavyTask());
    expect(rejected.outcome).toBe('HUMAN_REQUIRED');
  });

  it('I — a provenance diz se a validação foi observada e excluída, ou incluída', () => {
    const orchestrated = routeWith(orchestratedAdvanced(), heavyTask());
    const legacy = routeWith(workerOwnedAdvanced(), heavyTask(), 4_000_000);
    expect(orchestrated.outcome).toBe('ROUTED');
    expect(legacy.outcome).toBe('ROUTED');
    if (orchestrated.outcome !== 'ROUTED' || legacy.outcome !== 'ROUTED') {
      throw new Error('unreachable');
    }

    const orchestratedProvenance = orchestrated.worker_runtime_budget.provenance.join(' ');
    expect(orchestratedProvenance).toContain('task.resource_envelope.duration_ms.expected');
    expect(orchestratedProvenance).toContain('EXCLUÍDO');
    expect(orchestratedProvenance).toContain('official_validation_owner=orchestrator');
    expect(orchestratedProvenance).not.toContain('INCLUÍDO');

    const legacyProvenance = legacy.worker_runtime_budget.provenance.join(' ');
    expect(legacyProvenance).toContain('INCLUÍDO');
    expect(legacyProvenance).toContain('official_validation_owner=worker');
    expect(legacyProvenance).toContain('worker_validation_policy=full');
  });
});
