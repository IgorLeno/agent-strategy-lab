import { describe, expect, it } from 'vitest';

import { ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution, type PlannedTask } from '../../src/planner/index.js';
import { providerIdentityOf } from '../../src/providers/index.js';
import {
  CapabilityRegistry,
  capabilityOf,
  routeInitialProfile,
  type EvidenceBalanceFacts,
  type ProfileCapability,
  type StructuredWorkUnit,
} from '../../src/routing/index.js';

const HEAD_SHA = 'b'.repeat(40);

function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'provider-pool',
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

function inspection(): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/repo',
    inspected_at: '2026-08-27T00:00:00.000Z',
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
    source_anchors: [{ area: 'routing', path: 'src/routing' }],
    relevant_files: [],
    risks: [],
  };
}

function workUnit(plannedTask: PlannedTask = task()): StructuredWorkUnit {
  const facts = inspection();
  return {
    source: 'planner',
    task: plannedTask,
    assessment: assessExecution(plannedTask, {
      inspection: facts,
      expectedBaseRevisionSha: HEAD_SHA,
      factsSource: 'full_inspection',
    }),
    project_facts: facts,
  };
}

interface CapabilityOptions {
  readonly scaffold: 'claude_code' | 'codex_cli' | 'opencode';
  readonly provider: 'anthropic' | 'openai' | 'opencode_go' | 'openrouter';
  readonly model: string;
  readonly tier: 'economy' | 'intermediate' | 'advanced';
  readonly costRank: number;
}

const AGENT_OF = {
  claude_code: 'claude',
  codex_cli: 'codex',
  opencode: 'opencode',
} as const;

function capability(profileId: string, options: CapabilityOptions): ProfileCapability {
  return capabilityOf({
    profile_id: profileId,
    agent: AGENT_OF[options.scaffold],
    provider_identity: providerIdentityOf({
      execution_scaffold: options.scaffold,
      provider: options.provider,
      model: options.model,
      provenance: 'fixture',
    }),
    capability_prior: {
      tier: options.tier,
      model_cost_rank: options.costRank,
      effort_cost_rank: 0,
      rationale: 'prior de teste',
    },
    model: options.model,
    reasoning_effort: 'unpinned',
    reasoning_effort_source: 'unpinned',
    billing_mode: options.provider === 'openrouter' ? 'api' : 'subscription_only',
    credential_source: 'declared:teste',
    environment_mode: 'real-world',
    instruction_environment: 'real_world_user_home',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    sandbox: 'workspace-write',
    session_persistence: 'ephemeral',
  });
}

const CODEX_OPENAI = capability('codex-sol', {
  scaffold: 'codex_cli',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  tier: 'intermediate',
  costRank: 3,
});
const OPENCODE_OPENAI = capability('opencode-openai-sol', {
  scaffold: 'opencode',
  provider: 'openai',
  model: 'openai/gpt-5.6-sol',
  tier: 'intermediate',
  costRank: 3,
});
const OPENCODE_GO = capability('opencode-go-glm', {
  scaffold: 'opencode',
  provider: 'opencode_go',
  model: 'opencode-go/glm-5.3',
  tier: 'intermediate',
  costRank: 2,
});
const OPENCODE_GO_ECONOMY = capability('opencode-go-flash', {
  scaffold: 'opencode',
  provider: 'opencode_go',
  model: 'opencode-go/deepseek-v4-flash',
  tier: 'economy',
  costRank: 0,
});
const CODEX_ADVANCED = capability('codex-sol-advanced', {
  scaffold: 'codex_cli',
  provider: 'openai',
  model: 'gpt-5.6-sol',
  tier: 'advanced',
  costRank: 4,
});
const OPENROUTER = capability('opencode-openrouter-api', {
  scaffold: 'opencode',
  provider: 'openrouter',
  model: 'openrouter/qwen/qwen3-coder',
  tier: 'intermediate',
  costRank: 1,
});

function facts(overrides: Partial<EvidenceBalanceFacts> = {}): EvidenceBalanceFacts {
  return {
    profile_sample_sizes: {},
    provider_sample_sizes: {},
    run_launches_by_provider: {},
    quota_headroom_by_pool: {},
    provenance: ['fixture'],
    ...overrides,
  } as EvidenceBalanceFacts;
}

function route(
  capabilities: readonly ProfileCapability[],
  options: { readonly balance?: EvidenceBalanceFacts; readonly unit?: StructuredWorkUnit } = {},
) {
  return routeInitialProfile({
    work_unit: options.unit ?? workUnit(),
    role: 'implementer',
    capability_registry: new CapabilityRegistry([...capabilities]),
    candidates: capabilities.map((entry) => ({
      profile_id: entry.profile_id,
      availability: { value: true, provenance: 'doctor.ok' },
    })),
    selection_policy: 'evidence_balanced',
    ...(options.balance ? { evidence_balance: options.balance } : {}),
  });
}

function hardUnit(): StructuredWorkUnit {
  return workUnit(
    task({
      taxonomy: {
        version: 1,
        task_class: 'feature',
        difficulty_declared: 'hard',
        complexity: 'cross_cutting',
        ambiguity: 'high',
        verification: 'deterministic',
      },
      risk: 'high',
    }),
  );
}

describe('routing por pool de quota, não por executável', () => {
  it('Codex/OpenAI e OpenCode/OpenAI não contam como capacidade independente', () => {
    const result = route([CODEX_OPENAI, OPENCODE_OPENAI, OPENCODE_GO], {
      balance: facts({
        profile_sample_sizes: { 'codex-sol': 0, 'opencode-openai-sol': 0, 'opencode-go-glm': 0 },
        provider_sample_sizes: { openai: 0, opencode_go: 0 },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    const candidates = result.selection_evidence?.balanced_candidates ?? [];
    const openaiPools = candidates
      .filter((entry) => entry.provider === 'openai')
      .map((entry) => entry.quota_pool);
    // Dois perfis, dois executáveis, UMA franquia.
    expect(openaiPools).toEqual([
      'openai_chatgpt_subscription',
      'openai_chatgpt_subscription',
    ]);
    expect(new Set(openaiPools).size).toBe(1);
  });

  it('folga é indexada pelo POOL: os dois perfis OpenAI enxergam a mesma', () => {
    const result = route([CODEX_OPENAI, OPENCODE_OPENAI], {
      balance: facts({
        profile_sample_sizes: { 'codex-sol': 0, 'opencode-openai-sol': 0 },
        provider_sample_sizes: { openai: 0 },
        quota_headroom_by_pool: {
          openai_chatgpt_subscription: {
            status: 'OBSERVED',
            remaining_pct: 40,
            provenance: 'fixture',
          },
        },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    for (const candidate of result.selection_evidence?.balanced_candidates ?? []) {
      expect(candidate.quota_headroom).toEqual({
        status: 'OBSERVED',
        remaining_pct: 40,
        provenance: 'fixture',
      });
    }
  });

  it('perfil novo do OpenCode Go participa da exploração quando é suficiente', () => {
    const result = route([CODEX_OPENAI, OPENCODE_GO], {
      balance: facts({
        // OpenAI já amostrado; o Go é o subamostrado.
        profile_sample_sizes: { 'codex-sol': 12, 'opencode-go-glm': 0 },
        provider_sample_sizes: { openai: 12, opencode_go: 0 },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.profile.profile_id).toBe('opencode-go-glm');
    expect(result.selection_evidence?.tie_break).toContain('subamostrado');
  });

  it('história decisiva vence a exploração', () => {
    const result = route([CODEX_OPENAI, OPENCODE_GO], {
      balance: facts({
        // Agora o Go é o já amostrado; a exploração aponta para o outro lado.
        profile_sample_sizes: { 'codex-sol': 0, 'opencode-go-glm': 30 },
        provider_sample_sizes: { openai: 0, opencode_go: 30 },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.profile.profile_id).toBe('codex-sol');
  });

  it('perfil INCAPAZ nunca vence por exploração nem por folga de quota', () => {
    const result = route([OPENCODE_GO_ECONOMY, CODEX_ADVANCED], {
      unit: hardUnit(),
      balance: facts({
        // O incentivo máximo para explorar: zero amostras e folga total.
        profile_sample_sizes: { 'opencode-go-flash': 0, 'codex-sol-advanced': 99 },
        provider_sample_sizes: { opencode_go: 0, openai: 99 },
        quota_headroom_by_pool: {
          opencode_go_subscription: { status: 'OBSERVED', remaining_pct: 100, provenance: 'fixture' },
          openai_chatgpt_subscription: { status: 'OBSERVED', remaining_pct: 2, provenance: 'fixture' },
        },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.profile.profile_id).not.toBe('opencode-go-flash');
    expect(
      result.candidates_considered.find((entry) => entry.profile_id === 'opencode-go-flash')
        ?.rejection_code,
    ).toBe('CAPABILITY_INSUFFICIENT');
  });

  it('pool esgotado pelo provider é pulado quando existe alternativa suficiente', () => {
    const result = route([CODEX_OPENAI, OPENCODE_GO], {
      balance: facts({
        profile_sample_sizes: { 'codex-sol': 0, 'opencode-go-glm': 50 },
        provider_sample_sizes: { openai: 0, opencode_go: 50 },
        quota_headroom_by_pool: {
          openai_chatgpt_subscription: {
            status: 'EXHAUSTED',
            provenance: 'provider declarou limit_reached',
          },
        },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    // A exploração preferiria o Codex (zero amostras); o esgotamento REAL manda.
    expect(result.profile.profile_id).toBe('opencode-go-glm');
    const skipped = result.candidates_considered.find((entry) => entry.profile_id === 'codex-sol');
    expect(skipped?.rejection_code).toBe('QUOTA_POOL_EXHAUSTED');
  });

  it('folga BAIXA é preferência, nunca proibição', () => {
    const result = route([CODEX_OPENAI, OPENCODE_GO], {
      balance: facts({
        profile_sample_sizes: { 'codex-sol': 5, 'opencode-go-glm': 5 },
        provider_sample_sizes: { openai: 5, opencode_go: 5 },
        run_launches_by_provider: { openai: 1, opencode_go: 1 },
        quota_headroom_by_pool: {
          // 1% restante NÃO é esgotamento: nenhum candidato é recusado por isso.
          openai_chatgpt_subscription: { status: 'OBSERVED', remaining_pct: 1, provenance: 'fixture' },
          opencode_go_subscription: { status: 'OBSERVED', remaining_pct: 90, provenance: 'fixture' },
        },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.profile.profile_id).toBe('opencode-go-glm');
    expect(
      result.candidates_considered.some((entry) => entry.rejection_code === 'QUOTA_POOL_EXHAUSTED'),
    ).toBe(false);
    expect(result.selection_evidence?.tie_break).toContain('folga de quota OBSERVADA');
  });

  it('quota UNKNOWN não vira esgotada nem penaliza quem não tem medidor', () => {
    const result = route([CODEX_OPENAI, OPENCODE_GO], {
      balance: facts({
        profile_sample_sizes: { 'codex-sol': 5, 'opencode-go-glm': 5 },
        provider_sample_sizes: { openai: 5, opencode_go: 5 },
        run_launches_by_provider: { openai: 1, opencode_go: 1 },
        quota_headroom_by_pool: {
          opencode_go_subscription: { status: 'OBSERVED', remaining_pct: 3, provenance: 'fixture' },
          openai_chatgpt_subscription: { status: 'UNKNOWN', reason: 'sem medidor neste runtime' },
        },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(
      result.candidates_considered.some((entry) => entry.rejection_code === 'QUOTA_POOL_EXHAUSTED'),
    ).toBe(false);
    // Com UNKNOWN de um lado, a quota simplesmente não desempata.
    expect(result.selection_evidence?.quota_considered).toBe(false);
    expect(JSON.stringify(result.selection_evidence)).not.toMatch(/"remaining_pct":\s*0\b/);
  });

  it('perfil de cobrança por uso nunca é escolhido implicitamente', () => {
    const result = route([OPENROUTER, OPENCODE_GO], {
      balance: facts({
        // OpenRouter é o mais barato pelo rank e o menos amostrado: o máximo
        // de incentivo para escolhê-lo. Ele continua recusado.
        profile_sample_sizes: { 'opencode-openrouter-api': 0, 'opencode-go-glm': 80 },
        provider_sample_sizes: { openrouter: 0, opencode_go: 80 },
      }),
    });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.profile.profile_id).toBe('opencode-go-glm');
    expect(
      result.candidates_considered.find(
        (entry) => entry.profile_id === 'opencode-openrouter-api',
      )?.rejection_code,
    ).toBe('API_BILLING_REQUIRES_EXPLICIT_SELECTION');
  });

  it('prior declarado classifica o modelo sem o router conhecer seu nome', () => {
    // O modelo `opencode-go/glm-5.3` não casa com nenhum padrão histórico do
    // router. Sem prior ele seria CAPABILITY_UNCLASSIFIED e nunca elegível.
    const result = route([OPENCODE_GO], { balance: facts() });
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.profile.capability_prior?.tier).toBe('intermediate');
    expect(result.profile.profile_id).toBe('opencode-go-glm');
  });
});
