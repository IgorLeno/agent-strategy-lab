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

  it('stack ausente impede a decisão em vez de virar default', () => {
    const facts = inspection({
      stack: { known: false, value: null, reason: 'manifesto ausente', provenance: 'fs:markers' },
    });
    const result = routeInitialProfile(input(workUnit(task(), facts)));
    expect(result).toMatchObject({ outcome: 'HUMAN_REQUIRED' });
    if (result.outcome !== 'HUMAN_REQUIRED') throw new Error('unreachable');
    expect(result.reason).toContain('stack desconhecida');
  });

  it('environment readiness inválido impede routing', () => {
    const facts = inspection({ validation_command_candidates: [] });
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
