import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import { loadProfile, type LauncherProfile } from '../../dev/lib/profile.js';
import {
  authorizeProjectLaunch,
  buildPlannerPrompt,
  combineWorkflowAndReview,
  createLaunchedPlanningWorker,
  launchProjectReviewer,
  planDirectLifecycle,
  planReviewerInvocation,
  recordComparableRunFacts,
  resolveFailureFollowUp,
  runDirectPath,
  runReviewedPath,
  toHumanRequiredOutput,
  type DirectPathInput,
  type ObservedTaxonomyFacts,
} from '../../dev/lib/project-orchestrate.js';
import {
  assertReadOnlyArgv,
  buildRoleArgv,
  checkValidationCommandTimeout,
  CLAUDE_READ_ONLY_SETTINGS_FILE,
  resolveWorkerRuntimeBudget,
  RoleOverlayError,
  VALIDATION_COMMAND_TIMEOUT_BOUND,
} from '../../dev/lib/project-roles.js';
import type { ProjectInspection } from '../../src/inspection/index.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../../src/intake/index.js';
import type {
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  PlanningWorkerPort,
} from '../../src/planner/draft.js';
import type { PlannedTask } from '../../src/planner/task.js';
import type { FailureDiagnosis } from '../../src/routing/diagnosis.js';
import { REPO_ROOT, runDevCli } from './helpers.js';

const HEAD_SHA = 'a'.repeat(40);
const CLAUDE_PROFILE_ID = 'claude-build-worker-subscription-sonnet5-medium-v3';
const CODEX_PROFILE_ID = 'codex-build-worker-subscription-terra-high-v2';

const temporaryDirs: string[] = [];

afterEach(async () => {
  while (temporaryDirs.length > 0) {
    const directory = temporaryDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function makeTemporaryDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'agentlab-project-'));
  temporaryDirs.push(directory);
  return directory;
}

function intake(): ProjectIntakeRequest {
  return {
    schema_version: 1,
    target_repo: { url: 'https://example.test/project.git' },
    base_revision: { sha: HEAD_SHA },
    user_request: 'Corrigir o parser de configuração',
    objectives: ['Parser aceita a chave nova sem regressão'],
    constraints: ['não alterar o schema público'],
    exclusions: ['deploy'],
    requested_scope: { summary: 'Corrigir o parser de configuração' },
  };
}

function authorizationScope(
  overrides: Partial<ExecutionAuthorizationScope> = {},
): ExecutionAuthorizationScope {
  return {
    schema_version: 1,
    requested_scope: { summary: 'Corrigir o parser de configuração' },
    autonomous_execution_boundary: [
      'DISPOSABLE_LOCAL_WORKSPACE',
      'CONFIGURED_SUBSCRIPTION_WORKER',
      'DETERMINISTIC_VALIDATION',
      'BOUNDED_REPAIR',
      'CAPABILITY_ESCALATION_WITHIN_LADDER',
      'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
    ],
    human_gated_capabilities: [
      'UNAUTHORIZED_API_BILLING',
      'BILLING_MODE_CHANGE',
      'DESTRUCTIVE_ACTION',
      'DEPLOYMENT_OR_PRODUCTION',
      'EXTERNAL_SIDE_EFFECT',
      'SCOPE_EXPANSION',
      'NEW_CREDENTIAL_BOUNDARY',
      'CRITICAL_OR_SECURITY_SENSITIVE_ACTION',
    ],
    ...overrides,
  };
}

function inspection(overrides: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    schema_version: 1,
    repo_root: '/target',
    inspected_at: '2026-08-19T00:00:00.000Z',
    git: {
      known: true,
      value: { head_sha: HEAD_SHA, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git rev-parse',
    },
    stack: {
      known: true,
      value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] },
      provenance: 'package.json',
    },
    package_manager: { known: true, value: 'pnpm', provenance: 'pnpm-lock.yaml' },
    build_system: { known: true, value: 'typescript', provenance: 'tsconfig.json' },
    directories: [{ path: 'src', role: 'source' }],
    tests: {
      known: true,
      value: { framework: 'vitest', test_directories: ['test'] },
      provenance: 'vitest.config.ts',
    },
    validation_command_candidates: [
      { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json:scripts' },
    ],
    dependencies_state: {
      known: true,
      value: { lockfile_path: 'pnpm-lock.yaml', installed: true },
      provenance: 'node_modules',
    },
    required_tools: [{ name: 'node', reason: 'runtime', source: 'package.json:engines' }],
    required_services: [],
    filesystem_permissions: {
      known: true,
      value: { readable: true, writable: true },
      provenance: 'fs access',
    },
    feedback_sources: [],
    project_instructions: [{ path: 'AGENTS.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'config', path: 'src/config' }],
    relevant_files: ['src/config/parse.ts'],
    risks: [],
    ...overrides,
  };
}

const OBSERVED_TAXONOMY: ObservedTaxonomyFacts = {
  facts: { complexity: 'local', ambiguity: 'low', verification: 'deterministic' },
  provenance: 'preflight read-only: escopo de um único arquivo com validation determinística observada',
};

function directInput(overrides: Partial<DirectPathInput> = {}): DirectPathInput {
  return {
    taskId: 'T1',
    intake: intake(),
    inspection: inspection(),
    authorizationScope: authorizationScope(),
    classification: { task_class: 'bugfix', difficulty_declared: 'easy', risk: 'low' },
    minimalFactsSource: 'cached_inspection',
    observedTaxonomy: OBSERVED_TAXONOMY,
    ...overrides,
  };
}

function plannedTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'T1',
    objective: 'Corrigir o parser de configuração',
    blocked_by: [],
    taxonomy: {
      version: 1,
      task_class: 'bugfix',
      difficulty_declared: 'easy',
      complexity: 'local',
      ambiguity: 'low',
      verification: 'deterministic',
    },
    risk: 'low',
    acceptance: ['Parser aceita a chave nova sem regressão'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    initial_files: ['src/config/parse.ts'],
    probable_files: [],
    context_scope: { areas: ['config'] },
    context_requirements: [{ description: 'instrução de projeto', source_anchor: 'AGENTS.md' }],
    environment_requirements: [{ kind: 'tool', name: 'node', reason: 'runtime' }],
    estimated_duration: { expected: 600_000, maximum: 1_800_000 },
    validation_budget: { expected: 300_000, maximum: 900_000 },
    resource_envelope: {
      duration_ms: { expected: 600_000, maximum: 1_800_000 },
      tokens: { expected: 50_000, maximum: 150_000 },
      changed_files: { expected: 3, maximum: 8 },
    },
    ...overrides,
  };
}

class RecordingPlanner implements PlanningWorkerPort {
  readonly invocations: PlanningWorkerInvocation[] = [];

  constructor(private readonly result: PlanningWorkerInvocationResult) {}

  async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
    this.invocations.push(invocation);
    return this.result;
  }
}

function diagnosis(overrides: Partial<FailureDiagnosis> = {}): FailureDiagnosis {
  return {
    schema_version: 1,
    classification: 'CAPABILITY',
    rationale: 'bounded repair esgotado sem progresso no mesmo profile',
    boundary: 'um attempt de repair no mesmo profile',
    retry_budget: {
      kind: 'BOUNDED_REPAIR',
      maximum_attempts: 1,
      attempts_used: 1,
      same_profile_required: true,
    },
    decision_needed: 'autorizar degrau de escalation',
    why_automation_stopped: 'repair esgotado',
    options: ['escalar profile', 'replanejar'],
    evidence_paths: ['.dev/attempts/T1/1-abandoned.json'],
    provenance: ['launch_record', 'validation_log'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('HarnessPaths override aditivo', () => {
  it('mantém o default de resolveHarnessPaths idêntico quando nenhum override é passado', () => {
    const withoutOverride = resolveHarnessPaths('/repo');
    const withEmptyOverride = resolveHarnessPaths('/repo', {});
    expect(withEmptyOverride).toEqual(withoutOverride);
    expect(withoutOverride.planFile).toBe(path.join('/repo', 'dev', 'plan.yaml'));
    expect(withoutOverride.profileCatalogRoot).toBe(path.resolve('/repo'));
    expect(withoutOverride.profileCatalogRoot).toBe(withoutOverride.repoRoot);
  });

  it('redireciona plan file e runtime dir do repositório alvo sem mover o repoRoot', () => {
    const paths = resolveHarnessPaths('/repo', {
      planFile: '/target/plan.yaml',
      devDir: '/runtime/target',
    });
    expect(paths.repoRoot).toBe(path.resolve('/repo'));
    expect(paths.planFile).toBe(path.resolve('/target/plan.yaml'));
    expect(paths.devDir).toBe(path.resolve('/runtime/target'));
    expect(paths.inboxDir).toBe(`${path.resolve('/runtime/target')}-inbox`);
    expect(paths.stateFile).toBe(path.join(path.resolve('/runtime/target'), 'state.json'));
  });
});

describe('roles estruturais', () => {
  it('generaliza o overlay read-only para Claude por settings versionadas', async () => {
    const profile = await loadProfile(REPO_ROOT, CLAUDE_PROFILE_ID);
    const overlay = buildRoleArgv(profile, { role: 'reviewer', prompt: 'packet' });

    expect(overlay.workspace_access).toBe('READ_ONLY');
    const settingsIndex = overlay.argv.indexOf('--settings');
    expect(overlay.argv[settingsIndex + 1]).toBe(CLAUDE_READ_ONLY_SETTINGS_FILE);
    const permissionIndex = overlay.argv.indexOf('--permission-mode');
    expect(overlay.argv[permissionIndex + 1]).toBe('plan');
    expect(overlay.argv).toContain('--setting-sources');
    expect(() => assertReadOnlyArgv('reviewer', profile.agent, overlay.argv)).not.toThrow();

    const settings = JSON.parse(
      await readFile(path.join(REPO_ROOT, CLAUDE_READ_ONLY_SETTINGS_FILE), 'utf8'),
    ) as { permissions: { deny: string[]; allow: string[] } };
    for (const denied of ['Edit', 'Write', 'NotebookEdit', 'Bash(git commit:*)']) {
      expect(settings.permissions.deny).toContain(denied);
    }
    expect(settings.permissions.allow).not.toContain('Edit');
  });

  it('converte o sandbox único do Codex para read-only', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    const overlay = buildRoleArgv(profile, { role: 'planner', prompt: 'packet' });
    const sandboxIndex = overlay.argv.indexOf('--sandbox');

    expect(overlay.argv[sandboxIndex + 1]).toBe('read-only');
    expect(overlay.argv).not.toContain('workspace-write');
    expect(overlay.workspace_access).toBe('READ_ONLY');
  });

  it('implementer mantém mutação, mas contida no workspace autorizado', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    const overlay = buildRoleArgv(profile, { role: 'implementer', prompt: 'packet' });
    const sandboxIndex = overlay.argv.indexOf('--sandbox');

    expect(overlay.argv[sandboxIndex + 1]).toBe('workspace-write');
    expect(overlay.workspace_access).toBe('MUTATION_IN_AUTHORIZED_WORKSPACE');
    expect(() => assertReadOnlyArgv('implementer', profile.agent, overlay.argv)).toThrow(
      RoleOverlayError,
    );
  });

  it('recusa role read-only em profile que possui commit ou validação oficial', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    const owning: LauncherProfile = { ...profile, commit_owner: 'worker' };
    expect(() => buildRoleArgv(owning, { role: 'reviewer', prompt: 'packet' })).toThrow(
      RoleOverlayError,
    );
  });
});

describe('worker runtime budget e timeout de validation são grandezas separadas', () => {
  it('valida o budget somente contra o bound de runtime do launcher/profile', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    const resolved = resolveWorkerRuntimeBudget({ profile, budgetMs: 900_000 });

    expect(resolved.outcome).toBe('RESOLVED');
    if (resolved.outcome !== 'RESOLVED') return;
    expect(resolved.timeout_seconds_override).toBe(900);
    expect(resolved.checked_bounds.map((bound) => bound.kind)).toEqual([
      'WORKER_RUNTIME_BOUND',
      'WORKER_RUNTIME_BOUND',
    ]);
    // Nenhum bound de validation entra na conta do runtime do worker.
    expect(JSON.stringify(resolved)).not.toContain('VALIDATION_COMMAND_TIMEOUT_BOUND');
  });

  it('budget fora do bound produz BUDGET_UNSUPPORTED nomeando o bound violado', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    const resolved = resolveWorkerRuntimeBudget({
      profile,
      budgetMs: profile.timeout_seconds * 1_000 + 1,
    });

    expect(resolved.outcome).toBe('BUDGET_UNSUPPORTED');
    if (resolved.outcome !== 'BUDGET_UNSUPPORTED') return;
    expect(resolved.violated_bound.source).toBe('profile_runtime');
    expect(resolved.violated_bound.provenance).toContain(profile.id);
    expect(resolved.allowed_next_steps).toEqual([
      'TRY_ANOTHER_PROFILE',
      'RECONFIGURE_RUNTIME',
      'REPLAN',
      'HUMAN_REQUIRED',
    ]);
    // Nunca degradação silenciosa para o valor do bound.
    expect(resolved).not.toHaveProperty('timeout_seconds_override');
  });

  it('timeout de ValidationCommand é checado só contra o próprio contrato, sem min com o runtime', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    const shortRuntime: LauncherProfile = { ...profile, timeout_seconds: 60 };

    const accepted = checkValidationCommandTimeout(300);
    expect(accepted.outcome).toBe('ACCEPTED');
    if (accepted.outcome === 'ACCEPTED') {
      expect(accepted.timeout_seconds).toBe(300);
      expect(accepted.bound).toEqual(VALIDATION_COMMAND_TIMEOUT_BOUND);
    }

    // Runtime de 60s não encolhe o comando de 300s, e o comando não estica o runtime.
    const runtime = resolveWorkerRuntimeBudget({ profile: shortRuntime, budgetMs: 60_000 });
    expect(runtime.outcome).toBe('RESOLVED');
    if (runtime.outcome === 'RESOLVED') expect(runtime.timeout_seconds_override).toBe(60);

    const rejected = checkValidationCommandTimeout(
      VALIDATION_COMMAND_TIMEOUT_BOUND.maximum_seconds + 1,
    );
    expect(rejected.outcome).toBe('BUDGET_UNSUPPORTED');
    if (rejected.outcome !== 'BUDGET_UNSUPPORTED') return;
    expect(rejected.violated_bound.kind).toBe('VALIDATION_COMMAND_TIMEOUT_BOUND');
    expect(rejected.reason).toContain('VALIDATION_COMMAND_TIMEOUT_BOUND');
  });
});

describe('caminho DIRECT', () => {
  it('aceita DIRECT com preflight factual mínimo e pula exploração ampla e planning worker', () => {
    const result = runDirectPath(directInput());

    expect(result.outcome).toBe('DIRECT');
    if (result.outcome !== 'DIRECT') return;
    expect(result.decision.path).toBe('DIRECT');
    expect(result.decision.workflow.outcome).toBe('DIRECT_ALLOWED');
    expect(result.minimal_facts_source).toBe('cached_inspection');
    expect(result.skipped_stages).toContain('broad_exploration');
    expect(result.skipped_stages).toContain('planning_worker');
    expect(result.fact_provenance.join(' ')).toContain('minimal_factual_preflight');
    expect(result.task.validation[0]?.argv).toEqual(['pnpm', 'typecheck']);
  });

  it('nunca opera sobre fato ausente: head_sha divergente do base revision vira REVIEWED_REQUIRED', () => {
    const result = runDirectPath(
      directInput({
        inspection: inspection({
          git: {
            known: true,
            value: { head_sha: 'b'.repeat(40), branch: 'main', dirty: false, remotes: [] },
            provenance: 'git rev-parse',
          },
        }),
      }),
    );

    expect(result.outcome).toBe('REVIEWED_REQUIRED');
    if (result.outcome !== 'REVIEWED_REQUIRED') return;
    expect(result.reason).toContain('repo_and_base_revision_confirmed');
  });

  it('confiança insuficiente vira REVIEWED_REQUIRED sem inventar a task', () => {
    const { observedTaxonomy: _omitted, ...semObservados } = directInput();
    const semTaxonomia = runDirectPath(semObservados);
    expect(semTaxonomia.outcome).toBe('REVIEWED_REQUIRED');

    const semValidation = runDirectPath(
      directInput({ inspection: inspection({ validation_command_candidates: [] }) }),
    );
    expect(semValidation.outcome).toBe('REVIEWED_REQUIRED');
    if (semValidation.outcome !== 'REVIEWED_REQUIRED') return;
    expect(semValidation.reason).toContain('não inventa validation');
  });

  it('escopo pedido divergente do intake não é fato confirmado', () => {
    const result = runDirectPath(
      directInput({
        authorizationScope: authorizationScope({ requested_scope: { summary: 'outra coisa' } }),
      }),
    );
    expect(result.outcome).toBe('REVIEWED_REQUIRED');
  });
});

describe('verdict de plano e review requirement combinados pelo critério mais restritivo', () => {
  it('review exigida por qualquer um dos dois vereditos prevalece', () => {
    const direct = combineWorkflowAndReview(
      {
        outcome: 'DIRECT_ALLOWED',
        task_id: 'T1',
        satisfied_criteria: ['low_risk'],
        required_minimal_facts: ['repo_and_base_revision_confirmed'],
        minimal_facts_source: 'cached_inspection',
      },
      {
        independent_review_required: true,
        diversity_requirement: 'not_required',
        rationale: 'policy exige review',
        provenance: 'test',
      },
    );
    expect(direct.path).toBe('DIRECT');
    expect(direct.review_required).toBe(true);

    const reviewed = combineWorkflowAndReview(
      { outcome: 'REVIEWED_REQUIRED', task_id: 'T1', unmet_criteria: [], reason: 'faltam fatos' },
      {
        independent_review_required: false,
        diversity_requirement: 'not_required',
        rationale: 'evidência forte',
        provenance: 'test',
      },
    );
    expect(reviewed.path).toBe('REVIEWED');
    expect(reviewed.review_required).toBe(true);
  });
});

describe('reviewer', () => {
  it('sempre nova invocação read-only com packet bounded e decisão JSON única', () => {
    const plan = planReviewerInvocation({
      implementerProfileId: CODEX_PROFILE_ID,
      reviewerProfileId: CODEX_PROFILE_ID,
      diversityRequirement: 'not_required',
    });

    expect(plan.outcome).toBe('PLANNED');
    if (plan.outcome !== 'PLANNED') return;
    expect(plan.policy.fresh_invocation).toBe(true);
    expect(plan.policy.shared_conversation).toBe(false);
    expect(plan.policy.workspace_access).toBe('READ_ONLY');
    expect(plan.policy.packet_bounded).toBe(true);
    expect(plan.policy.decision_format).toBe('SINGLE_JSON');
    expect(plan.policy.trusts_implementer_self_report).toBe(false);
  });

  it('diversidade é proporcional ao risco: baixo/médio reusa o mesmo profile', () => {
    for (const requirement of ['not_required', 'preferred'] as const) {
      const plan = planReviewerInvocation({
        implementerProfileId: CODEX_PROFILE_ID,
        reviewerProfileId: CODEX_PROFILE_ID,
        diversityRequirement: requirement,
      });
      expect(plan.outcome).toBe('PLANNED');
    }

    const critical = planReviewerInvocation({
      implementerProfileId: CODEX_PROFILE_ID,
      reviewerProfileId: CODEX_PROFILE_ID,
      diversityRequirement: 'required',
    });
    expect(critical.outcome).toBe('DIVERSITY_REQUIRED');

    const diverse = planReviewerInvocation({
      implementerProfileId: CODEX_PROFILE_ID,
      reviewerProfileId: CLAUDE_PROFILE_ID,
      diversityRequirement: 'required',
    });
    expect(diverse.outcome).toBe('PLANNED');
  });
});

describe('gate humano proporcional e autorização de escopo', () => {
  const base = {
    scope: authorizationScope(),
    billing_mode: 'subscription_only' as const,
    quota: { availability: null, provenance: 'quota não probada antes do launch' },
    credential: { availability: true, provenance: 'probe local provou a assinatura' },
    risk: 'low' as const,
    worker_owns_commit: false,
    worker_owns_official_validation: false,
  };

  it('não existe aprovação humana universal entre plano e execução', () => {
    for (const capability of [
      'CONFIGURED_SUBSCRIPTION_WORKER',
      'BOUNDED_REPAIR',
      'CAPABILITY_ESCALATION_WITHIN_LADDER',
      'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
    ] as const) {
      const authorization = authorizeProjectLaunch({ ...base, capability });
      expect(authorization.outcome).toBe('ALLOW');
    }
  });

  it('requested_scope não autoriza billing, credencial, ação destrutiva, efeito externo, deploy nem security-sensitive', () => {
    const gated = [
      'UNAUTHORIZED_API_BILLING',
      'BILLING_MODE_CHANGE',
      'DESTRUCTIVE_ACTION',
      'EXTERNAL_SIDE_EFFECT',
      'DEPLOYMENT_OR_PRODUCTION',
      'CRITICAL_OR_SECURITY_SENSITIVE_ACTION',
    ] as const;
    for (const capability of gated) {
      const authorization = authorizeProjectLaunch({
        ...base,
        capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
        implied_human_gated: [capability],
      });
      expect(authorization.outcome).toBe('HUMAN_REQUIRED');
      if (authorization.outcome !== 'HUMAN_REQUIRED') continue;
      expect(authorization.gated_capability).toBe(capability);
    }

    expect(
      authorizeProjectLaunch({ ...base, capability: 'CONFIGURED_SUBSCRIPTION_WORKER', billing_mode: 'api' })
        .outcome,
    ).toBe('HUMAN_REQUIRED');
    expect(
      authorizeProjectLaunch({
        ...base,
        capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
        credential: { availability: false, provenance: 'probe local provou fonte de API' },
      }).outcome,
    ).toBe('HUMAN_REQUIRED');
    expect(
      authorizeProjectLaunch({ ...base, capability: 'CONFIGURED_SUBSCRIPTION_WORKER', risk: 'critical' })
        .outcome,
    ).toBe('HUMAN_REQUIRED');
  });

  it('A/B/C — credencial provada libera; provada-falsa e desconhecida param, sem promoção', () => {
    const proven = authorizeProjectLaunch({
      ...base,
      capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
      credential: { availability: true, provenance: 'probe local provou a assinatura' },
    });
    expect(proven.outcome).toBe('ALLOW');
    const credentialCheck = proven.checks.find((check) => check.name === 'credentials');
    expect(credentialCheck?.evidence).toBe('PROVEN_TRUE');

    for (const credential of [
      { availability: false as const, provenance: 'probe local provou fonte de API' },
      { availability: null, provenance: 'CLI não está autenticada' },
    ]) {
      const authorization = authorizeProjectLaunch({
        ...base,
        capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
        credential,
      });
      expect(authorization.outcome).toBe('HUMAN_REQUIRED');
      if (authorization.outcome !== 'HUMAN_REQUIRED') continue;
      expect(authorization.gated_capability).toBe('NEW_CREDENTIAL_BOUNDARY');
      // A proveniência do que NÃO foi provado precisa chegar a quem decide.
      expect(authorization.reason).toContain(credential.provenance);
    }
  });

  it('D/E — quota provada-falsa bloqueia; quota desconhecida segue sem virar "disponível"', () => {
    const insufficient = authorizeProjectLaunch({
      ...base,
      capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
      quota: { availability: false, provenance: 'provider recusou por limite; janela não resetou' },
    });
    expect(insufficient.outcome).toBe('HUMAN_REQUIRED');
    expect(insufficient.checks.at(-1)?.name).toBe('quota');

    const unknown = authorizeProjectLaunch({
      ...base,
      capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
      quota: { availability: null, provenance: 'quota não probada antes do launch' },
    });
    // Desconhecida não bloqueia — o provider é quem impõe rate limit, e ele o
    // fará no próprio launch — mas o relatório JAMAIS afirma disponibilidade.
    expect(unknown.outcome).toBe('ALLOW');
    const quotaCheck = unknown.checks.find((check) => check.name === 'quota');
    expect(quotaCheck?.evidence).toBe('UNKNOWN');
    expect(quotaCheck?.reason).not.toContain('quota disponível');
    expect(quotaCheck?.provenance).toContain('não probada');
  });

  it('F — nenhum UNKNOWN é reportado como provado em nenhuma combinação', () => {
    const values: readonly (boolean | null)[] = [true, false, null];
    for (const credential of values) {
      for (const quota of values) {
        const authorization = authorizeProjectLaunch({
          ...base,
          capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
          credential: { availability: credential, provenance: 'evidência declarada pelo teste' },
          quota: { availability: quota, provenance: 'evidência declarada pelo teste' },
        });
        for (const check of authorization.checks) {
          if (check.name === 'credentials' && credential === null) {
            expect(check.evidence).not.toBe('PROVEN_TRUE');
          }
          if (check.name === 'quota' && quota === null) {
            expect(check.evidence).not.toBe('PROVEN_TRUE');
          }
        }
        // Só credencial PROVEN TRUE chega a ALLOW; UNKNOWN nunca destrava.
        expect(authorization.outcome === 'ALLOW').toBe(credential === true && quota !== false);
      }
    }
  });

  it('capability fora do boundary é scope expansion', () => {
    const authorization = authorizeProjectLaunch({
      ...base,
      scope: authorizationScope({ autonomous_execution_boundary: ['DISPOSABLE_LOCAL_WORKSPACE'] }),
      capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
    });
    expect(authorization.outcome).toBe('HUMAN_REQUIRED');
    if (authorization.outcome !== 'HUMAN_REQUIRED') return;
    expect(authorization.gated_capability).toBe('SCOPE_EXPANSION');
  });
});

describe('failure diagnosis depois do repair esgotado', () => {
  it('só CAPABILITY escala; as demais classes seguem caminhos próprios', () => {
    const capability = resolveFailureFollowUp({ diagnosis: diagnosis(), incidentId: 'INC-1' });
    expect(capability.escalates).toBe(true);
    expect(capability.action).toBe('ESCALATION_ELIGIBLE');

    const cases = [
      ['ENVIRONMENT_NOT_READY', 'REMEDIATE_ENVIRONMENT'],
      ['TASK_DEFINITION_TOO_BROAD', 'REPLAN_OR_DECOMPOSE'],
      ['CONTEXT_PRESSURE', 'RESCOPE_CONTEXT'],
      ['INFRA', 'RETRY_INFRA_SAME_PROFILE'],
    ] as const;
    for (const [classification, action] of cases) {
      const followUp = resolveFailureFollowUp({
        diagnosis: diagnosis({ classification }),
        incidentId: 'INC-1',
      });
      expect(followUp.action).toBe(action);
      expect(followUp.escalates).toBe(false);
    }
  });

  it('environment readiness é aplicada antes de culpar capacidade', () => {
    const followUp = resolveFailureFollowUp({
      diagnosis: diagnosis(),
      incidentId: 'INC-1',
      environment: {
        outcome: 'ENVIRONMENT_NOT_READY',
        reason: 'dependências não instaladas',
        unsatisfied: ['dependencies_installed=not_satisfied'],
      },
    });
    expect(followUp.action).toBe('REMEDIATE_ENVIRONMENT');
    expect(followUp.escalates).toBe(false);
  });

  it('adapta a decisão pura de M79 para o HumanRequiredOutput do harness', () => {
    const followUp = resolveFailureFollowUp({
      diagnosis: diagnosis({ classification: 'UNKNOWN_INSUFFICIENT_EVIDENCE' }),
      incidentId: 'INC-9',
    });
    expect(followUp.escalates).toBe(false);
    expect(followUp.human_required).not.toBeNull();
    expect(followUp.human_required?.status).toBe('HUMAN_REQUIRED');
    expect(followUp.human_required?.incident_id).toBe('INC-9');
    expect(followUp.human_required?.evidence_paths).toEqual([
      '.dev/attempts/T1/1-abandoned.json',
    ]);
    expect(followUp.human_required?.why_automation_stopped).toContain('provenance');

    const direct = toHumanRequiredOutput(
      {
        status: 'HUMAN_REQUIRED',
        classification: 'CAPABILITY',
        decision_needed: 'decidir',
        why_automation_stopped: 'parou',
        options: ['a'],
        evidence_paths: ['p'],
        provenance: ['launch_record'],
      },
      'INC-2',
    );
    expect(direct.options).toEqual(['a']);
  });
});

describe('evidence recording path — writer dos ComparableRunFacts', () => {
  it('escreve o contrato de M81 com provenance e não reescreve run já gravado', async () => {
    const executionDir = path.join(await makeTemporaryDir(), 'run-1', 'execution');
    const evidence = {
      authoritative_profile: { id: CODEX_PROFILE_ID },
      provider: { value: 'codex', provenance: 'launcher_profile.agent' },
      worker_role: { value: 'implementer', provenance: 'lifecycle.role' },
    } as const;

    const first = await recordComparableRunFacts({ executionDir, evidence });
    expect(first.outcome).toBe('RECORDED');
    if (first.outcome !== 'RECORDED') return;
    expect(first.facts.profile_id.value).toBe(CODEX_PROFILE_ID);
    expect(first.facts.profile_id.provenance).toContain('authoritative_launcher_profile');
    // Sem evidência não existe default: fica UNKNOWN com o motivo registrado.
    expect(first.facts.transport.value).toBe('UNKNOWN');
    expect(first.facts.transport.provenance).toBe('transport_not_recorded');

    const replay = await recordComparableRunFacts({ executionDir, evidence });
    expect(replay.outcome).toBe('RECORDED');

    const divergent = await recordComparableRunFacts({
      executionDir,
      evidence: { ...evidence, provider: { value: 'claude', provenance: 'outro' } },
    });
    expect(divergent.outcome).toBe('ALREADY_RECORDED');

    const onDisk = JSON.parse(await readFile(first.file, 'utf8')) as { provider: { value: string } };
    expect(onDisk.provider.value).toBe('codex');
  });
});

describe('adapter real da PlanningWorkerPort', () => {
  const paths = resolveHarnessPaths(REPO_ROOT);

  async function worker(
    overrides: Partial<Parameters<typeof createLaunchedPlanningWorker>[0]> = {},
  ): Promise<PlanningWorkerPort> {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    return createLaunchedPlanningWorker({
      paths,
      profile,
      scope: authorizationScope(),
      credential: { availability: true, provenance: 'probe local provou a assinatura' },
      quota: { availability: null, provenance: 'quota não probada antes do launch' },
      workerRuntimeBudgetMs: 600_000,
      ...overrides,
    });
  }

  function invocation(): PlanningWorkerInvocation {
    return {
      schema_version: 1,
      role: 'READ_ONLY_PLANNER',
      workspace_access: 'READ_ONLY',
      packet: {
        schema_version: 1,
        packet_id: 'f'.repeat(64),
        target_repo_url: 'https://example.test/project.git',
        base_revision_sha: HEAD_SHA,
        user_intent: {
          request: 'Corrigir o parser',
          objectives: ['Parser corrigido'],
          requested_scope: 'Corrigir o parser',
        },
        inspection: {
          inspected_at: '2026-08-19T00:00:00.000Z',
          head_sha: HEAD_SHA,
          working_tree_dirty: false,
          primary_ecosystem: 'node',
          package_manager: 'pnpm',
          build_system: 'typescript',
          dependencies_installed: true,
          validation_candidates: [
            { name: 'typecheck', command: 'pnpm typecheck', source: 'package.json' },
          ],
          risks: [],
        },
        source_anchors: [{ area: 'config', path: 'src/config' }],
        constraints: [],
        planning_contract: {
          schema_version: 1,
          worker_role: 'READ_ONLY_PLANNER',
          output_trust: 'UNTRUSTED_DRAFT',
          acceptance_contract: ['Parser corrigido'],
          plan_policy: {
            schema_version: 1,
            invalid_draft: 'REJECT',
            decomposition: 'ATOMIC_ONLY',
            dependency_graph: 'VALID_DAG_REQUIRED',
            assessment: 'RISK_READINESS_REQUIRED',
            pipeline: [
              'SCHEMA_NORMALIZATION',
              'AVC_DECOMPOSITION',
              'PLAN_POLICY',
              'DEPENDENCY_VALIDATION',
              'RISK_READINESS',
            ],
          },
          routing_policy: { owner: 'CONTROL_PLANE', provider_selection: 'OUTSIDE_PLANNER' },
          safety_boundaries: { exclusions: [], authorization_scope: authorizationScope() },
        },
      },
    };
  }

  it('nasce desligado: sem habilitação de escopo nenhum provider é chamado', async () => {
    let called = false;
    const port = await worker({
      port: {
        run: async () => {
          called = true;
          return '{}';
        },
      },
    });
    const result = await port.invoke(invocation());

    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('PROVIDER_PATH_DISABLED');
    expect(called).toBe(false);
  });

  it('dry-run com provider habilitado ainda não chama provider', async () => {
    let called = false;
    const port = await worker({
      providerEnabled: true,
      dryRun: true,
      port: {
        run: async () => {
          called = true;
          return '{}';
        },
      },
    });
    const result = await port.invoke(invocation());

    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('DRY_RUN_NO_PROVIDER_CALL');
    expect(called).toBe(false);
  });

  it('recusa antes de qualquer efeito quando o launch exige gate humano', async () => {
    const port = await worker({
      credential: { availability: null, provenance: 'credencial não provada' },
      providerEnabled: true,
      dryRun: false,
    });
    const result = await port.invoke(invocation());

    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('PLANNING_LAUNCH_HUMAN_REQUIRED');
  });

  it('recusa budget fora do bound de runtime antes de lançar', async () => {
    const port = await worker({ workerRuntimeBudgetMs: 99_999_999, providerEnabled: true, dryRun: false });
    const result = await port.invoke(invocation());

    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('BUDGET_UNSUPPORTED');
    expect(result.failure.message).toContain('bound');
  });

  it('recusa invocação que não declare role read-only', async () => {
    const port = await worker();
    const result = await port.invoke({
      ...invocation(),
      role: 'IMPLEMENTER',
    } as never);

    expect(result.outcome).toBe('INVOCATION_FAILED');
    if (result.outcome !== 'INVOCATION_FAILED') return;
    expect(result.failure.code).toBe('PLANNER_ROLE_CONTRACT_VIOLATED');
  });

  it('o prompt do planner carrega o packet bounded, sem transcript', () => {
    const prompt = buildPlannerPrompt(invocation());
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('UNTRUSTED DRAFT');
    expect(prompt).toContain('"packet_id"');
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(32 * 1024);
  });
});

describe('caminho REVIEWED', () => {
  it('usa o pipeline determinístico de M83 pela porta adaptada', async () => {
    const planner = new RecordingPlanner({
      outcome: 'DRAFT_RETURNED',
      invocation_id: 'inv-1',
      provider_id: 'codex',
      model: CODEX_PROFILE_ID,
      draft: { schema_version: 1, tasks: [plannedTask()] },
    });

    const result = await runReviewedPath({
      intake: intake(),
      inspection: inspection(),
      authorizationScope: authorizationScope(),
      planningWorker: planner,
    });

    expect(result.outcome).toBe('PLANNED');
    if (result.outcome !== 'PLANNED') return;
    expect(result.plan.tasks).toHaveLength(1);
    expect(result.decisions[0]?.review_required).toBeDefined();
    expect(planner.invocations[0]?.role).toBe('READ_ONLY_PLANNER');
    expect(planner.invocations[0]?.workspace_access).toBe('READ_ONLY');
  });

  it('draft que altera o acceptance contract é recusado, nunca corrigido', async () => {
    const planner = new RecordingPlanner({
      outcome: 'DRAFT_RETURNED',
      invocation_id: 'inv-2',
      provider_id: 'codex',
      model: CODEX_PROFILE_ID,
      draft: {
        schema_version: 1,
        tasks: [plannedTask({ acceptance: ['critério inventado pelo worker'] })],
      },
    });

    const result = await runReviewedPath({
      intake: intake(),
      inspection: inspection(),
      authorizationScope: authorizationScope(),
      planningWorker: planner,
    });

    expect(result.outcome).toBe('REJECTED');
    if (result.outcome !== 'REJECTED') return;
    expect(result.issues.join(' ')).toContain('acceptance_contract');
  });
});

describe('dev-project-orchestrate', () => {
  async function writeRequest(withTaxonomy: boolean): Promise<string> {
    const directory = await makeTemporaryDir();
    const file = path.join(directory, 'request.json');
    await writeFile(
      file,
      JSON.stringify({
        task_id: 'T1',
        worker_runtime_budget_ms: 900_000,
        minimal_facts_source: 'cached_inspection',
        classification: { task_class: 'bugfix', difficulty_declared: 'easy', risk: 'low' },
        intake: intake(),
        inspection: inspection(),
        authorization_scope: authorizationScope(),
        ...(withTaxonomy ? { observed_taxonomy: OBSERVED_TAXONOMY } : {}),
      }),
      'utf8',
    );
    return file;
  }

  it('publica o caminho DIRECT em dry-run, com plan file e runtime dir redirecionados', async () => {
    const request = await writeRequest(true);
    const runtimeDir = await makeTemporaryDir();
    const result = await runDevCli('dev-project-orchestrate.ts', [
      '--request',
      request,
      '--profile',
      CODEX_PROFILE_ID,
      '--plan-file',
      path.join(runtimeDir, 'plan.yaml'),
      '--runtime-dir',
      path.join(runtimeDir, 'runtime'),
    ]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      status: string;
      dry_run: boolean;
      provider_called: boolean;
      plan_file: string;
      runtime_dir: string;
      lifecycle: { path: string; review_required: boolean; launch_authorization: { outcome: string } };
    };
    expect(output.status).toBe('PLANNED');
    expect(output.dry_run).toBe(true);
    expect(output.provider_called).toBe(false);
    expect(output.plan_file).toBe(path.join(runtimeDir, 'plan.yaml'));
    expect(output.runtime_dir).toBe(path.join(runtimeDir, 'runtime'));
    expect(output.lifecycle.path).toBe('DIRECT');
    // Dry-run não prova credencial nem quota, então o launch real ainda não é liberado.
    expect(output.lifecycle.launch_authorization.outcome).toBe('HUMAN_REQUIRED');
  });

  it('sai em REVIEWED_REQUIRED quando os fatos não sustentam o caminho direto', async () => {
    const request = await writeRequest(false);
    const result = await runDevCli('dev-project-orchestrate.ts', [
      '--request',
      request,
      '--profile',
      CODEX_PROFILE_ID,
    ]);

    expect(result.exitCode).toBe(4);
    const output = JSON.parse(result.stdout) as { status: string; provider_called: boolean };
    expect(output.status).toBe('REVIEWED_REQUIRED');
    expect(output.provider_called).toBe(false);
  });
});

describe('G — reviewer não ganha autorização mais fraca que o implementer', () => {
  const paths = resolveHarnessPaths(REPO_ROOT);

  function reviewerPacket() {
    return {
      task_id: 'T1',
      objective: 'objetivo declarado pelo PlanFile',
      acceptance: ['aceitação declarada'],
      validation: [{ argv: ['true'] }],
      changed_files: ['src/greet.ts'],
      candidate_sha: 'b'.repeat(40),
      official_validation_outcome: 'PASS' as const,
      evidence_paths: [paths.validationLogsDir],
    };
  }

  for (const [label, credential] of [
    ['desconhecida', { availability: null, provenance: 'CLI não está autenticada' }],
    ['provada-falsa', { availability: false as const, provenance: 'fonte da credencial é API' }],
  ] as const) {
    it(`credencial ${label} vira REVIEW_UNAVAILABLE, nunca ACCEPT, e não invoca provider`, async () => {
      const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
      let invoked = false;
      const result = await launchProjectReviewer({
        paths,
        profile,
        scope: authorizationScope(),
        implementerProfileId: CLAUDE_PROFILE_ID,
        diversityRequirement: 'required',
        risk: 'low',
        workerRuntimeBudgetMs: 600_000,
        credential,
        quota: { availability: null, provenance: 'quota não probada antes do launch' },
        packet: reviewerPacket(),
        port: {
          run: async () => {
            invoked = true;
            return '{"decision":"ACCEPT","reason":"jamais deveria ser perguntado"}';
          },
        },
      });

      expect(result.outcome).toBe('REVIEW_UNAVAILABLE');
      if (result.outcome !== 'REVIEW_UNAVAILABLE') return;
      expect(result.code).toBe('REVIEW_LAUNCH_HUMAN_REQUIRED');
      expect(invoked).toBe(false);
    });
  }

  it('quota provada-falsa também para a review antes de qualquer invocação', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    let invoked = false;
    const result = await launchProjectReviewer({
      paths,
      profile,
      scope: authorizationScope(),
      implementerProfileId: CLAUDE_PROFILE_ID,
      diversityRequirement: 'required',
      risk: 'low',
      workerRuntimeBudgetMs: 600_000,
      credential: { availability: true, provenance: 'probe local provou a assinatura' },
      quota: { availability: false, provenance: 'provider recusou por limite' },
      packet: reviewerPacket(),
      port: {
        run: async () => {
          invoked = true;
          return '{"decision":"ACCEPT","reason":"jamais deveria ser perguntado"}';
        },
      },
    });

    expect(result.outcome).toBe('REVIEW_UNAVAILABLE');
    expect(invoked).toBe(false);
  });
});

describe('vista consolidada do lifecycle', () => {
  it('publica caminho, budget e gate de launch sem tocar em provider', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_PROFILE_ID);
    const result = planDirectLifecycle({
      ...directInput(),
      profile,
      workerRuntimeBudgetMs: 900_000,
      quota: { availability: null, provenance: 'quota não probada antes do launch' },
      credential: { availability: true, provenance: 'probe local provou a assinatura' },
    });

    expect(result.outcome).toBe('PLANNED');
    if (result.outcome !== 'PLANNED') return;
    expect(result.plan.path).toBe('DIRECT');
    expect(result.plan.worker_runtime_budget.outcome).toBe('RESOLVED');
    expect(result.plan.launch_authorization.outcome).toBe('ALLOW');
    expect(result.plan.task_id).toBe('T1');
  });
});
