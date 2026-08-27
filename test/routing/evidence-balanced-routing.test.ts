import { describe, expect, it } from 'vitest';

import { ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution, type PlannedTask } from '../../src/planner/index.js';
import { providerIdentityOf } from '../../src/providers/index.js';
import {
  CapabilityRegistry,
  capabilityOf,
  routeInitialProfile,
  type EvidenceBalanceFacts,
  type InitialRoutingInput,
  type ProfileCapability,
  type RoutingCandidate,
  type StructuredWorkUnit,
} from '../../src/routing/index.js';

const HEAD_SHA = 'a'.repeat(40);

/**
 * Cenário do piloto Augmented Chess: quatro profiles de assinatura, dois de
 * cada provider, cruzando os dois degraus de capacidade. O ranking estático
 * ordena terra < sonnet e sol < opus, que foi exatamente o que fez 13 de 13
 * work units caírem em Codex quando o histórico estava vazio.
 */
function task(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'evidence-balanced',
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
    inspected_at: '2026-08-19T00:00:00.000Z',
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

/**
 * Os fixtures carregam identidade upstream normalizada porque é isso que
 * acontece em produção: `agent: codex` fala com `openai`, `agent: claude` fala
 * com `anthropic`. Indexar amostragem e folga por essa identidade — e não pelo
 * nome do executável — é justamente o que faz Codex e OpenCode/openai contarem
 * como um provider só.
 */
function capability(
  profileId: string,
  agent: 'codex' | 'claude',
  model: string,
  reasoningEffort: string,
): ProfileCapability {
  return capabilityOf({
    profile_id: profileId,
    agent,
    provider_identity: providerIdentityOf({
      execution_scaffold: agent === 'codex' ? 'codex_cli' : 'claude_code',
      provider: agent === 'codex' ? 'openai' : 'anthropic',
      model,
      provenance: 'fixture',
    }),
    model,
    reasoning_effort: reasoningEffort,
    reasoning_effort_source: agent === 'codex' ? 'codex_config_override' : 'claude_effort_flag',
    billing_mode: 'subscription_only',
    credential_source: agent === 'codex' ? 'chatgpt_subscription' : 'claude_subscription',
    environment_mode: 'real-world',
    instruction_environment: 'sanitized_user_home',
    commit_owner: 'orchestrator',
    official_validation_owner: 'orchestrator',
    worker_validation_policy: 'targeted',
    sandbox: 'workspace-write',
    session_persistence: 'ephemeral',
  });
}

const TERRA = capability('codex-terra-medium', 'codex', 'gpt-5.6-terra', 'medium');
const SONNET = capability('claude-sonnet5-medium', 'claude', 'sonnet-5', 'medium');
const SOL = capability('codex-sol-high', 'codex', 'gpt-5.6-sol', 'high');
const OPUS = capability('claude-opus5-high', 'claude', 'opus-5', 'high');
const LUNA = capability('codex-luna-minimal', 'codex', 'gpt-5.6-luna', 'minimal');

function candidate(profileId: string): RoutingCandidate {
  return { profile_id: profileId, availability: { value: true, provenance: 'doctor.ok' } };
}

const UNKNOWN_QUOTA = {
  status: 'UNKNOWN' as const,
  reason: 'provider sem medidor de assinatura observável neste runtime',
};

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

function input(
  capabilities: readonly ProfileCapability[],
  options: {
    readonly policy?: 'static_cost' | 'evidence_balanced';
    readonly balance?: EvidenceBalanceFacts;
    readonly unit?: StructuredWorkUnit;
  } = {},
): InitialRoutingInput {
  return {
    work_unit: options.unit ?? workUnit(),
    role: 'implementer',
    capability_registry: new CapabilityRegistry(capabilities),
    candidates: capabilities.map((entry) => candidate(entry.profile_id)),
    ...(options.policy === undefined ? {} : { selection_policy: options.policy }),
    ...(options.balance === undefined ? {} : { evidence_balance: options.balance }),
  };
}

/** Difficulty hard força o tier advanced, onde Sol e Opus se encontram. */
function hardUnit(): StructuredWorkUnit {
  return workUnit(
    task({
      taxonomy: {
        version: 1,
        task_class: 'feature',
        difficulty_declared: 'hard',
        complexity: 'cross_cutting',
        ambiguity: 'high',
        verification: 'partially_deterministic',
      },
      risk: 'high',
    }),
  );
}

function routed(result: ReturnType<typeof routeInitialProfile>): string {
  if (result.outcome !== 'ROUTED') throw new Error(`esperava ROUTED, veio ${result.outcome}`);
  return result.profile.profile_id;
}

describe('evidence_balanced — desempate por aquisição de evidência', () => {
  it('reproduz o viés do piloto: sem balanceamento o custo estático fixa Codex', () => {
    const staticResult = routeInitialProfile(input([TERRA, SONNET]));
    expect(routed(staticResult)).toBe('codex-terra-medium');
    // Repetir mil vezes daria o mesmo profile: nada no ranking estático muda.
    expect(routed(routeInitialProfile(input([TERRA, SONNET])))).toBe('codex-terra-medium');
    const hardStatic = routeInitialProfile(input([SOL, OPUS], { unit: hardUnit() }));
    expect(routed(hardStatic)).toBe('codex-sol-high');
  });

  it('cold-start com Terra e Sonnet igualmente elegíveis adquire evidência dos dois', () => {
    // Rodada 1: ninguém tem amostra; empate cai no custo estático e Codex sai.
    const first = routeInitialProfile(
      input([TERRA, SONNET], { policy: 'evidence_balanced', balance: facts() }),
    );
    expect(routed(first)).toBe('codex-terra-medium');

    // Rodada 2: com Codex já amostrado, o subamostrado passa a ser Claude.
    const second = routeInitialProfile(
      input([TERRA, SONNET], {
        policy: 'evidence_balanced',
        balance: facts({
          profile_sample_sizes: { 'codex-terra-medium': 3, 'claude-sonnet5-medium': 0 },
          provider_sample_sizes: { openai: 3, anthropic: 0 },
          run_launches_by_provider: { openai: 1, anthropic: 0 },
        }),
      }),
    );
    expect(routed(second)).toBe('claude-sonnet5-medium');
    if (second.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(second.selection_evidence?.policy).toBe('evidence_balanced');
    expect(second.selection_evidence?.tie_break).toContain('profile subamostrado');
  });

  it('cold-start com Sol e Opus igualmente elegíveis não escolhe Sol indefinidamente', () => {
    const unit = hardUnit();
    const sampling: Record<string, number> = { 'codex-sol-high': 0, 'claude-opus5-high': 0 };
    const providerSampling: Record<string, number> = { openai: 0, anthropic: 0 };
    const runLaunches: Record<string, number> = { openai: 0, anthropic: 0 };
    const chosen: string[] = [];

    for (let round = 0; round < 6; round += 1) {
      const result = routeInitialProfile(
        input([SOL, OPUS], {
          unit,
          policy: 'evidence_balanced',
          balance: facts({
            profile_sample_sizes: { ...sampling },
            provider_sample_sizes: { ...providerSampling },
            run_launches_by_provider: { ...runLaunches },
          }),
        }),
      );
      const winner = routed(result);
      chosen.push(winner);
      // A run devolve a evidência que o attempt produziu: é o que faz o
      // desempate seguinte enxergar o profile já amostrado.
      sampling[winner] = (sampling[winner] ?? 0) + 1;
      // UPSTREAM, não executável: é essa a chave em que a amostragem conta.
      const provider = winner.startsWith('codex') ? 'openai' : 'anthropic';
      providerSampling[provider] = (providerSampling[provider] ?? 0) + 1;
      runLaunches[provider] = (runLaunches[provider] ?? 0) + 1;
    }

    expect(chosen).toEqual([
      'codex-sol-high',
      'claude-opus5-high',
      'codex-sol-high',
      'claude-opus5-high',
      'codex-sol-high',
      'claude-opus5-high',
    ]);
    expect(new Set(chosen).size).toBe(2);
  });

  it('nunca seleciona profile incapaz para equilibrar consumo', () => {
    const unit = hardUnit();
    // Luna é economy e estaria zerada em amostragem — o incentivo máximo para
    // explorá-la. Ela continua recusada por capacidade insuficiente.
    const result = routeInitialProfile(
      input([LUNA, SOL, OPUS], {
        unit,
        policy: 'evidence_balanced',
        balance: facts({
          profile_sample_sizes: { 'codex-luna-minimal': 0, 'codex-sol-high': 40, 'claude-opus5-high': 40 },
          provider_sample_sizes: { openai: 40, anthropic: 40 },
        }),
      }),
    );
    expect(routed(result)).not.toBe('codex-luna-minimal');
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(
      result.candidates_considered.find((entry) => entry.profile_id === 'codex-luna-minimal'),
    ).toMatchObject({ outcome: 'REJECTED', rejection_code: 'CAPABILITY_INSUFFICIENT' });
    expect(
      result.selection_evidence?.balanced_candidates.some(
        (entry) => entry.profile_id === 'codex-luna-minimal',
      ),
    ).toBe(false);
  });

  it('quota OBSERVADA para todos desempata quando amostragem e concentração empatam', () => {
    const unit = hardUnit();
    const result = routeInitialProfile(
      input([SOL, OPUS], {
        unit,
        policy: 'evidence_balanced',
        balance: facts({
          profile_sample_sizes: { 'codex-sol-high': 5, 'claude-opus5-high': 5 },
          provider_sample_sizes: { openai: 5, anthropic: 5 },
          run_launches_by_provider: { openai: 2, anthropic: 2 },
          quota_headroom_by_pool: {
            openai_chatgpt_subscription: { status: 'OBSERVED', remaining_pct: 12, provenance: 'fixture' },
            anthropic_subscription: { status: 'OBSERVED', remaining_pct: 84, provenance: 'fixture' },
          },
        }),
      }),
    );
    expect(routed(result)).toBe('claude-opus5-high');
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.selection_evidence?.quota_considered).toBe(true);
    expect(result.selection_evidence?.tie_break).toContain('folga de quota OBSERVADA');
  });

  it('quota UNKNOWN não vira fato nem penaliza quem não tem medidor', () => {
    const unit = hardUnit();
    const result = routeInitialProfile(
      input([SOL, OPUS], {
        unit,
        policy: 'evidence_balanced',
        balance: facts({
          profile_sample_sizes: { 'codex-sol-high': 5, 'claude-opus5-high': 5 },
          provider_sample_sizes: { openai: 5, anthropic: 5 },
          run_launches_by_provider: { openai: 2, anthropic: 2 },
          // Só Claude tem medidor; Codex permanece UNKNOWN.
          quota_headroom_by_pool: {
            anthropic_subscription: { status: 'OBSERVED', remaining_pct: 3, provenance: 'fixture' },
            openai_chatgpt_subscription: UNKNOWN_QUOTA,
          },
        }),
      }),
    );
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    // Quota não participou: com 3% restantes contra UNKNOWN, um desempate por
    // quota teria eliminado Claude. O tie-break caiu no custo estático.
    expect(result.selection_evidence?.quota_considered).toBe(false);
    expect(result.selection_evidence?.tie_break).toContain('custo estático');
    const codex = result.selection_evidence?.balanced_candidates.find(
      (entry) => entry.provider === 'openai',
    );
    expect(codex?.quota_headroom.status).toBe('UNKNOWN');
    expect(JSON.stringify(result.selection_evidence)).not.toMatch(/"remaining_pct":\s*0\b/);
  });

  it('decisões continuam determinísticas dadas as mesmas entradas', () => {
    const balanced = input([SOL, OPUS], {
      unit: hardUnit(),
      policy: 'evidence_balanced',
      balance: facts({
        profile_sample_sizes: { 'codex-sol-high': 2, 'claude-opus5-high': 7 },
        provider_sample_sizes: { openai: 2, anthropic: 7 },
      }),
    });
    expect(routeInitialProfile(balanced)).toEqual(routeInitialProfile(balanced));
    expect(routed(routeInitialProfile(balanced))).toBe('codex-sol-high');
  });

  it('evidence_balanced sem fatos observados degrada para o custo estático, sem inventar amostra', () => {
    const result = routeInitialProfile(input([TERRA, SONNET], { policy: 'evidence_balanced' }));
    expect(routed(result)).toBe('codex-terra-medium');
    if (result.outcome !== 'ROUTED') throw new Error('esperava ROUTED');
    expect(result.selection_evidence?.balanced_candidates).toEqual([]);
    expect(result.selection_evidence?.exploration_reason).toContain('degradou para o custo estático');
  });

  it('nenhum forecast participa da autorização ou da seleção', () => {
    const balance = facts({
      profile_sample_sizes: { 'codex-terra-medium': 0, 'claude-sonnet5-medium': 0 },
      provider_sample_sizes: { openai: 0, anthropic: 0 },
    });
    const cheapEnvelope = routeInitialProfile(
      input([TERRA, SONNET], { policy: 'evidence_balanced', balance }),
    );
    const expensiveEnvelope = routeInitialProfile(
      input([TERRA, SONNET], {
        policy: 'evidence_balanced',
        balance,
        unit: workUnit(
          task({
            resource_envelope: {
              duration_ms: { expected: 60_000_000, maximum: 90_000_000 },
              tokens: { expected: 10_000, maximum: 50_000 },
              changed_files: { expected: 2, maximum: 5 },
            },
          }),
        ),
      }),
    );
    if (cheapEnvelope.outcome !== 'ROUTED' || expensiveEnvelope.outcome !== 'ROUTED') {
      throw new Error('esperava ROUTED nos dois');
    }
    // Cem vezes mais previsão de runtime, mesma decisão e mesma autoridade.
    expect(expensiveEnvelope.execution_runtime_forecast.predicted_runtime_ms).toBeGreaterThan(
      cheapEnvelope.execution_runtime_forecast.predicted_runtime_ms * 10,
    );
    expect(expensiveEnvelope.profile.profile_id).toBe(cheapEnvelope.profile.profile_id);
    expect(expensiveEnvelope.execution_runtime_forecast.authority).toBe('ADVISORY');
    expect(expensiveEnvelope.selection_evidence).toEqual(cheapEnvelope.selection_evidence);
    expect(JSON.stringify(expensiveEnvelope.selection_evidence)).not.toMatch(/forecast|runtime/i);
  });
});
