/**
 * M85: E2E fake do lifecycle universal de orquestração de projeto (M84) contra
 * um repositório-alvo EXTERNO sintético, criado e descartado por este arquivo.
 * Reusa o worker falso (`fixtures/fake-worker.mjs`) e o perfil
 * `fake-worker-v1` já existentes — nenhum novo duplo de provider nasce aqui.
 * Perfis extras criados neste arquivo só rotulam metadados de capability
 * (`agent`) para exercitar escalation; o argv real de todos eles continua
 * apontando para o mesmo worker falso, então nenhum provider real, custo ou
 * credencial é exercitado em nenhum cenário.
 *
 * Nove cenários, cada um uma prova independente e mínima:
 *   1. DIRECT        — preflight factual mínimo, route, worker, validation, PASS;
 *                       fato mínimo ausente impede DIRECT em vez de virar default.
 *   2. REVIEWED       — normalization insuficiente aciona planning worker,
 *                       validação determinística, implementer, fresh reviewer, PASS;
 *                       draft que inventa acceptance é sempre REJECTED.
 *   3. CAPABILITY     — FAIL, repair FAIL, diagnosis CAPABILITY, escalation
 *                       (mesmo provider), worker novo, PASS. Integra a prova
 *                       WRITE→READ do contrato de M81.
 *   4. INFRA          — INFRA_ERROR real nunca produz escalation de capacidade.
 *   5. ENVIRONMENT    — ambiente NOT_READY é aplicado antes de culpar capacidade.
 *   6. TASK/CONTEXT   — task ampla demais decompõe em vez de escalar às cegas.
 *   7. CROSS_PROVIDER — escalation cross-provider decidida pelo control plane,
 *                       nunca pelo worker; contexto sempre fresco. Integra a
 *                       prova de AUTONOMIA dentro do escopo (3 tasks, zero gate).
 *   8. HUMAN_GATE     — risco crítico e boundary não autorizado param a
 *                       automação com decision_needed/options expostos e ZERO
 *                       spawn depois do gate. Integra a prova de PARADA na
 *                       fronteira.
 *   9. ROUTING_BUDGET — materialização operacional preserva validation como
 *                       stage do orchestrator; runtime genuíno ainda respeita
 *                       o bound do coding worker.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';

import { FAKE_ADAPTER_IDENTITY } from '../../src/adapters/index.js';
import { AttemptRole } from '../../src/performance/attempt-facts.js';
import {
  comparableRunFactsFromEvidence,
  type ComparableRunFactsEvidence,
} from '../../src/performance/comparable-run.js';
import { queryPerformanceHistory } from '../../src/performance/query.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../../src/intake/index.js';
import type { ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution } from '../../src/planner/assess.js';
import type { PlanningWorkerInvocation, PlanningWorkerInvocationResult, PlanningWorkerPort } from '../../src/planner/draft.js';
import { PlannedTask } from '../../src/planner/task.js';
import type { DirectTaskClassification } from '../../src/planner/validate.js';
import {
  CapabilityRegistry,
  capabilityOf,
  decideEscalation,
  routeInitialProfile,
  type EscalationExecutionPolicy,
  type EscalationLadder,
  type RoutingCandidate,
} from '../../src/routing/index.js';
import type { FailureDiagnosis } from '../../src/routing/diagnosis.js';
import { AUTOMATIC_REPAIR_EXHAUSTED } from '../../dev/lib/automatic-repair.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  authorizeProjectLaunch,
  combineWorkflowAndReview,
  planReviewerInvocation,
  recordComparableRunFacts,
  resolveFailureFollowUp,
  runDirectPath,
  runReviewedPath,
  toHumanRequiredOutput,
  type DirectPathInput,
  type ObservedTaxonomyFacts,
} from '../../dev/lib/project-orchestrate.js';
import { buildWorkUnitFromPlan } from '../../dev/lib/project-run.js';
import { readLaunchRecord, readValidationFailedAttempt } from '../../dev/lib/records.js';
import { retryFailedAttempt } from '../../dev/lib/retry-failed.js';
import { buildInitialState, ensureRuntimeDirs, readState, writeState } from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, type Sandbox } from '../dev/helpers.js';
import { prepareRun } from '../../src/cli/run-prepare.js';
import { executeRun } from '../../src/cli/run-execute.js';
import { TaskSpec, type EnvironmentProfile, type Trial } from '../../src/schemas/index.js';

// ---------------------------------------------------------------------------
// Limpeza — todo diretório temporário criado por este arquivo é descartado.
// ---------------------------------------------------------------------------

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix = 'agentlab-e2e-project-'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

// ---------------------------------------------------------------------------
// Fixture de projeto externo SINTÉTICA — package.json/src/test mínimos por
// cima do mesmo sandbox git que os outros slices de `test/dev/` usam. Criada
// e descartada por este arquivo; o repositório do lab nunca é tocado.
// ---------------------------------------------------------------------------

async function externalProjectFixture(): Promise<Sandbox> {
  const sandbox = await makeSandboxRepo();
  temporaryRoots.push(sandbox.root);
  await mkdir(path.join(sandbox.root, 'src'), { recursive: true });
  await writeFile(
    path.join(sandbox.root, 'package.json'),
    JSON.stringify(
      {
        name: 'external-project-e2e-fixture',
        version: '1.0.0',
        private: true,
        scripts: { typecheck: 'true', test: 'true' },
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    path.join(sandbox.root, 'src', 'greet.ts'),
    'export function greet(name: string): string {\n  return `hello, ${name}`;\n}\n',
    'utf8',
  );
  await writeFile(
    path.join(sandbox.root, 'CLAUDE.md'),
    '# fixture externa sintética (M85) — projeto descartável do teste\n',
    'utf8',
  );
  await commitAll(sandbox.root, 'external project fixture files');
  return sandbox;
}

/** Escreve o plan.yaml do repositório ALVO, comita e inicializa o state a partir do novo HEAD. */
async function writePlanAndInitState(
  sandbox: Sandbox,
  tasks: readonly PlannedTaskLike[],
): Promise<{ readonly paths: HarnessPaths; readonly loaded: LoadedPlan }> {
  const paths = resolveHarnessPaths(sandbox.root, { devDir: sandbox.devDir });
  const planYaml = stringifyYaml({
    schema_version: 1,
    tasks: tasks.map((task) => ({
      id: task.task_id,
      title: `${task.task_id}: ${task.objective.slice(0, 48)}`,
      ...(task.blocked_by.length > 0 ? { blocked_by: [...task.blocked_by] } : {}),
      objective: task.objective,
      initial_files: [...task.initial_files],
      acceptance: [...task.acceptance],
      validation: task.validation.map((command) => ({
        argv: [...command.argv],
        timeout_seconds: command.timeout_seconds,
      })),
    })),
  });
  await writeFile(paths.planFile, planYaml, 'utf8');
  const baseSha = await commitAll(sandbox.root, 'plan for M85 scenario');
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha }));
  return { paths, loaded };
}

interface PlannedTaskLike {
  readonly task_id: string;
  readonly objective: string;
  readonly blocked_by: readonly string[];
  readonly initial_files: readonly string[];
  readonly acceptance: readonly string[];
  readonly validation: readonly { readonly argv: readonly string[]; readonly timeout_seconds: number }[];
}

function orchestrate(
  sandbox: Sandbox,
  mode: string,
  extra: readonly string[] = [],
  profile = 'fake-worker-v1',
) {
  return runDevCli(
    'dev-orchestrate.ts',
    ['--repo', sandbox.root, '--profile', profile, ...extra],
    { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: mode },
  );
}

/**
 * Perfil falso adicional: mesmo argv do worker falso (nenhum novo duplo de
 * provider), id/agent diferentes só para capability metadata.
 *
 * `orchestratorOwned` liga `commit_owner`/`official_validation_owner` ao
 * orquestrador — obrigatório para o profile PRIMARY lançado sob os modos
 * `official-fail*`, porque o worker falso pula git de propósito nesses modos
 * e só um profile orchestrator-owned consegue fechar (ou rejeitar) o attempt.
 * Os profiles ESCALADOS relançam sob o modo `success` (o worker comita
 * normalmente), então ficam worker-owned, como `fake-worker-v1`.
 */
async function writeFakeProfile(
  sandbox: Sandbox,
  id: string,
  options: { readonly agent?: 'fake'; readonly orchestratorOwned?: boolean } = {},
): Promise<void> {
  const agent = options.agent ?? 'fake';
  const ownership = options.orchestratorOwned
    ? ['commit_owner: orchestrator', 'official_validation_owner: orchestrator', 'worker_validation_policy: targeted']
    : [];
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${id}.yaml`),
    [
      `id: ${id}`,
      `agent: ${agent}`,
      ...ownership,
      'argv: [node, fixtures/fake-worker.mjs]',
      'prompt_delivery: argv',
      'forbidden_flags: []',
      'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE]',
    ].join('\n'),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Fixtures puras — intake/inspection/scope/diagnosis, desacopladas de
// qualquer repositório real (`runDirectPath`/`runReviewedPath`/`decideEscalation`
// só checam consistência interna, nunca tocam disco).
// ---------------------------------------------------------------------------

const FIXTURE_HEAD_SHA = 'f'.repeat(40);

function intake(overrides: Partial<ProjectIntakeRequest> = {}): ProjectIntakeRequest {
  return {
    schema_version: 1,
    target_repo: { url: 'https://example.test/external-project.git' },
    base_revision: { sha: FIXTURE_HEAD_SHA },
    user_request: 'Adicionar uma saudação com o nome do usuário',
    objectives: ['greet(name) retorna uma saudação com o nome'],
    constraints: ['não alterar a assinatura pública existente'],
    exclusions: ['deploy'],
    requested_scope: { summary: 'Adicionar uma saudação com o nome do usuário' },
    ...overrides,
  };
}

function scope(overrides: Partial<ExecutionAuthorizationScope> = {}): ExecutionAuthorizationScope {
  return {
    schema_version: 1,
    requested_scope: { summary: 'Adicionar uma saudação com o nome do usuário' },
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
      value: { head_sha: FIXTURE_HEAD_SHA, branch: 'main', dirty: false, remotes: [] },
      provenance: 'git rev-parse',
    },
    stack: { known: true, value: { primary_ecosystem: 'node', ecosystems_detected: ['node'] }, provenance: 'package.json' },
    package_manager: { known: true, value: 'pnpm', provenance: 'pnpm-lock.yaml' },
    build_system: { known: true, value: 'typescript', provenance: 'tsconfig.json' },
    directories: [{ path: 'src', role: 'source' }],
    tests: { known: true, value: { framework: 'vitest', test_directories: ['test'] }, provenance: 'vitest.config.ts' },
    validation_command_candidates: [{ name: 'typecheck', command: 'true', source: 'package.json:scripts' }],
    dependencies_state: { known: true, value: { lockfile_path: 'pnpm-lock.yaml', installed: true }, provenance: 'node_modules' },
    required_tools: [{ name: 'node', reason: 'runtime', source: 'package.json:engines' }],
    required_services: [],
    filesystem_permissions: { known: true, value: { readable: true, writable: true }, provenance: 'fs access' },
    feedback_sources: [],
    project_instructions: [{ path: 'CLAUDE.md', scope: 'root', relevance: 'general' }],
    source_anchors: [{ area: 'greet', path: 'src/greet.ts' }],
    relevant_files: ['src/greet.ts'],
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
    authorizationScope: scope(),
    classification: { task_class: 'feature', difficulty_declared: 'easy', risk: 'low' } as DirectTaskClassification,
    minimalFactsSource: 'cached_inspection',
    observedTaxonomy: OBSERVED_TAXONOMY,
    ...overrides,
  };
}

function plannedTask(overrides: Partial<PlannedTask> = {}): PlannedTask {
  return {
    schema_version: 1,
    task_id: 'T1',
    objective: 'Adicionar uma saudação com o nome do usuário',
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
    acceptance: ['greet(name) retorna uma saudação com o nome'],
    validation: [{ argv: ['true'], timeout_seconds: 30 }],
    initial_files: ['src/greet.ts'],
    probable_files: [],
    context_scope: { areas: ['greet'] },
    context_requirements: [{ description: 'instrução de projeto', source_anchor: 'CLAUDE.md' }],
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
    why_automation_stopped: 'repair esgotado sem progresso',
    options: ['escalar profile', 'replanejar', 'aguardar decisão humana'],
    evidence_paths: ['failed-attempts/T2/attempt-1'],
    provenance: ['launch_record', 'validation_log'],
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

// ---------------------------------------------------------------------------
// Escalation — ladder/registry/policy compartilhados por CAPABILITY e
// CROSS_PROVIDER, cada um com sua própria combinação de agent.
// ---------------------------------------------------------------------------

function escalationCapability(profileId: string, agent: 'fake' | 'codex') {
  return capabilityOf({
    profile_id: profileId,
    agent,
    model: `configured-${profileId}`,
    reasoning_effort: 'high',
    reasoning_effort_source: agent === 'codex' ? 'codex_config_override' : 'claude_effort_flag',
    billing_mode: 'subscription_only',
    credential_source: `${agent}_subscription`,
    environment_mode: 'controlled',
    instruction_environment: 'sanitized',
    commit_owner: 'worker',
    official_validation_owner: 'worker',
    worker_validation_policy: 'full',
    sandbox: 'workspace-write',
    session_persistence: 'ephemeral',
  });
}

function escalationExecutionPolicy(
  overrides: Partial<EscalationExecutionPolicy> = {},
): EscalationExecutionPolicy {
  return {
    schema_version: 1,
    authorization_scope: scope(),
    allowed_profile_ids: [
      'fake-worker-v1',
      'fake-worker-primary-v1',
      'fake-worker-capable-v2',
      'fake-worker-cross-v3',
    ],
    allowed_providers: ['fake', 'codex'],
    authorized_billing_modes: ['subscription_only'],
    evidence_paths: ['policy/execution.json'],
    provenance: 'project_execution_policy',
    ...overrides,
  };
}

function repairSequence(profileId: string) {
  return {
    initial: {
      attempt_role: AttemptRole.INITIAL as const,
      profile_id: profileId,
      evaluation_outcome: 'FAIL' as const,
      evidence_paths: ['failed-attempts/T2/attempt-1'],
    },
    repair: {
      attempt_role: AttemptRole.REPAIR as const,
      profile_id: profileId,
      evaluation_outcome: 'FAIL' as const,
      retry_budget: 1 as const,
      authorization_provenance: 'bounded_repair_policy',
      evidence_paths: ['failed-attempts/T2/attempt-2'],
    },
  };
}

const CAPABILITY_LADDER: EscalationLadder = {
  schema_version: 1,
  ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
  ordering_rationale: 'rank explícito da project policy',
  steps: [
    { profile_id: 'fake-worker-primary-v1', capability_rank: 0, rationale: 'baseline configurado' },
    { profile_id: 'fake-worker-capable-v2', capability_rank: 1, rationale: 'degrau seguinte da ladder' },
  ],
};

const CROSS_PROVIDER_LADDER: EscalationLadder = {
  schema_version: 1,
  ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
  ordering_rationale: 'rank explícito da project policy',
  steps: [
    { profile_id: 'fake-worker-primary-v1', capability_rank: 0, rationale: 'baseline configurado' },
    { profile_id: 'fake-worker-cross-v3', capability_rank: 1, rationale: 'próximo provider autorizado' },
  ],
};

function candidatePreflight(profileId: string) {
  return {
    profile_id: profileId,
    provider_availability: { value: true, provenance: 'fake provider probe' },
    credential_availability: { value: true, provenance: 'fake credential probe' },
    real_execution_authorization: {
      authorization: { value: 'AUTHORIZED' as const, provenance: 'fake execution policy' },
      billing_mode: { value: 'SUBSCRIPTION' as const, provenance: 'configured profile' },
      quota: {
        availability: { value: 'SUFFICIENT' as const, provenance: 'fake quota probe' },
        remaining: { value: 80, provenance: 'fake quota probe' },
        unit: 'percent' as const,
      },
      cost: {
        api_equivalent_usd: { value: null, provenance: 'not used' },
        projected_incremental_charge_usd: { value: null, provenance: 'not used' },
        actual_incremental_charge_usd: { value: null, provenance: 'not observed' },
        actual_incremental_charge_authoritative: false,
      },
      budget: { maximum_incremental_charge_usd: { value: null, provenance: 'not used' } },
    },
  };
}

describe('M85 — External Project Fake E2E', () => {
  // -------------------------------------------------------------------------
  // 1. DIRECT
  // -------------------------------------------------------------------------
  it('DIRECT — preflight mínimo, route, worker, validação determinística, PASS; fato ausente nunca vira default', async () => {
    const decision = runDirectPath(directInput());
    expect(decision.outcome).toBe('DIRECT');
    if (decision.outcome !== 'DIRECT') return;
    expect(decision.decision.workflow.outcome).toBe('DIRECT_ALLOWED');
    expect(decision.skipped_stages).toContain('broad_exploration');
    expect(decision.skipped_stages).toContain('planning_worker');
    expect(decision.fact_provenance.join(' ')).toContain('minimal_factual_preflight');

    // fato mínimo ausente (nenhuma taxonomy observada) impede DIRECT — nunca vira default.
    const { observedTaxonomy: _omitted, ...withoutObservedFacts } = directInput();
    const withoutFacts = runDirectPath(withoutObservedFacts);
    expect(withoutFacts.outcome).toBe('REVIEWED_REQUIRED');

    // sem candidato de validation observado, DIRECT também não inventa comando.
    const withoutValidation = runDirectPath(
      directInput({ inspection: inspection({ validation_command_candidates: [] }) }),
    );
    expect(withoutValidation.outcome).toBe('REVIEWED_REQUIRED');

    // route/worker/validation real: a work unit normalizada vira plan.yaml do
    // repositório-alvo sintético e roda pelo mesmo dev-orchestrate já testado.
    const sandbox = await externalProjectFixture();
    await writePlanAndInitState(sandbox, [decision.task]);
    const result = await orchestrate(sandbox, 'success', ['--max-iterations', '1']);
    expect(result.exitCode, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { stopped_by: string; iterations: { result: string }[] };
    expect(summary.stopped_by).toBe('ALL_DONE');
    expect(summary.iterations.map((iteration) => iteration.result)).toEqual(['PASS']);
    expect((await readState(resolveHarnessPaths(sandbox.root, { devDir: sandbox.devDir }))).tasks[0]?.status).toBe(
      'PASS',
    );
  }, 60_000);

  // -------------------------------------------------------------------------
  // 2. REVIEWED
  // -------------------------------------------------------------------------
  it('REVIEWED — normalization insuficiente aciona planning worker; implementer, validação, fresh reviewer, PASS', async () => {
    // normalization insuficiente (sem taxonomy observada) cai para REVIEWED_REQUIRED.
    const { observedTaxonomy: _omitted, ...ambiguous } = directInput();
    const direct = runDirectPath(ambiguous);
    expect(direct.outcome).toBe('REVIEWED_REQUIRED');

    // draft que inventa acceptance nunca é aceito — normalization jamais inventa a task.
    const inventingPlanner = new RecordingPlanner({
      outcome: 'DRAFT_RETURNED',
      invocation_id: 'inv-invent',
      provider_id: 'fake',
      model: 'fake-worker-v1',
      draft: { schema_version: 1, tasks: [plannedTask({ acceptance: ['critério inventado pelo worker'] })] },
    });
    const invented = await runReviewedPath({
      intake: intake(),
      inspection: inspection(),
      authorizationScope: scope(),
      planningWorker: inventingPlanner,
    });
    expect(invented.outcome).toBe('REJECTED');
    if (invented.outcome === 'REJECTED') expect(invented.issues.join(' ')).toContain('acceptance_contract');

    // draft válido: pipeline determinístico de M83 pela porta adaptada.
    const planner = new RecordingPlanner({
      outcome: 'DRAFT_RETURNED',
      invocation_id: 'inv-1',
      provider_id: 'fake',
      model: 'fake-worker-v1',
      draft: { schema_version: 1, tasks: [plannedTask()] },
    });
    const planned = await runReviewedPath({
      intake: intake(),
      inspection: inspection(),
      authorizationScope: scope(),
      planningWorker: planner,
    });
    expect(planned.outcome).toBe('PLANNED');
    if (planned.outcome !== 'PLANNED') return;
    expect(planner.invocations[0]?.role).toBe('READ_ONLY_PLANNER');
    expect(planner.invocations[0]?.workspace_access).toBe('READ_ONLY');
    const decisions = planned.plan.tasks.map((entry) => combineWorkflowAndReview(entry.workflow, entry.assessment.review_requirement));
    expect(decisions[0]?.path).toBeDefined();

    // implementer + validação determinística real, contra o repositório-alvo sintético.
    const sandbox = await externalProjectFixture();
    const tasks = planned.plan.tasks.map((entry) => entry.task);
    await writePlanAndInitState(sandbox, tasks);
    const result = await orchestrate(sandbox, 'success', ['--max-iterations', '1']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { stopped_by: string }).stopped_by).toBe('ALL_DONE');
    const paths = resolveHarnessPaths(sandbox.root, { devDir: sandbox.devDir });
    expect((await readState(paths)).tasks[0]?.status).toBe('PASS');

    // fresh reviewer: nova invocação read-only, packet bounded, decisão JSON única.
    const reviewerPlan = planReviewerInvocation({
      implementerProfileId: 'fake-worker-v1',
      reviewerProfileId: 'fake-worker-v1',
      diversityRequirement: 'not_required',
    });
    expect(reviewerPlan.outcome).toBe('PLANNED');
    if (reviewerPlan.outcome !== 'PLANNED') return;
    expect(reviewerPlan.policy.fresh_invocation).toBe(true);
    expect(reviewerPlan.policy.shared_conversation).toBe(false);
    expect(reviewerPlan.policy.workspace_access).toBe('READ_ONLY');
    expect(reviewerPlan.policy.decision_format).toBe('SINGLE_JSON');
    expect(reviewerPlan.policy.trusts_implementer_self_report).toBe(false);

    const completion = await readState(paths);
    const acceptedCommit = completion.tasks[0]?.accepted_commit;
    // Reviewer é um processo NOVO, read-only, sem transcript herdado: recebe só o
    // commit aceito por argv e emite um único JSON de decisão em stdout.
    const reviewSource = `const verdict = { decision: 'PASS', accepted_commit: process.argv[1], rationale: 'validação determinística já aceitou o commit' }; process.stdout.write(JSON.stringify(verdict));`;
    const reviewResult = await runDevReview([process.execPath, '-e', reviewSource, acceptedCommit ?? '']);
    expect(reviewResult.decision).toBe('PASS');
    expect(reviewResult.accepted_commit).toBe(acceptedCommit);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 3. CAPABILITY (+ integração WRITE→READ de M81)
  // -------------------------------------------------------------------------
  it('CAPABILITY — FAIL, repair FAIL, diagnosis CAPABILITY, escalation mesmo provider, PASS; write→read de M81', async () => {
    const sandbox = await externalProjectFixture();
    await writeFakeProfile(sandbox, 'fake-worker-primary-v1', { orchestratorOwned: true });
    await writeFakeProfile(sandbox, 'fake-worker-capable-v2');

    const tasks: PlannedTaskLike[] = [
      {
        task_id: 'T1',
        objective: 'tarefa trivial que sempre passa',
        blocked_by: [],
        initial_files: ['src/greet.ts'],
        acceptance: ['sempre satisfeita'],
        validation: [{ argv: ['true'], timeout_seconds: 30 }],
      },
      {
        task_id: 'T2',
        objective: 'tarefa que precisa de escalation de capacidade',
        blocked_by: ['T1'],
        initial_files: ['src/greet.ts'],
        acceptance: ['conteúdo escrito pelo worker escalado'],
        validation: [{ argv: ['grep', '-q', 'feito por T2', 'src/t2.txt'], timeout_seconds: 30 }],
      },
    ];
    const { paths } = await writePlanAndInitState(sandbox, tasks);

    // FIRST_PASS FAIL + bounded REPAIR FAIL, no mesmo profile — real, via processo.
    const exhausted = await orchestrate(sandbox, 'official-fail', ['--max-iterations', '3'], 'fake-worker-primary-v1');
    expect(exhausted.exitCode).toBe(9);
    const exhaustedSummary = JSON.parse(exhausted.stdout) as { stopped_by: string };
    expect(exhaustedSummary.stopped_by).toBe(AUTOMATIC_REPAIR_EXHAUSTED);
    const afterExhaustion = await readState(paths);
    expect(afterExhaustion.tasks[0]?.status).toBe('PASS');
    expect(afterExhaustion.tasks[1]?.status).toBe('FAIL');
    expect(JSON.stringify(exhaustedSummary)).not.toContain('HUMAN_REQUIRED');

    const archived = await readValidationFailedAttempt(paths, 'T2', 1);
    expect(archived).not.toBeNull();
    const originalLaunch = await readLaunchRecord(paths, 'T2');
    expect(originalLaunch?.profile_id).toBe('fake-worker-primary-v1');

    // diagnosis CAPABILITY, grounded na evidência real arquivada.
    const groundedDiagnosis = diagnosis({
      evidence_paths: [archived!.change_bundle.manifest_path, archived!.change_bundle.patch_path],
    });
    const followUp = resolveFailureFollowUp({ diagnosis: groundedDiagnosis, incidentId: 'INC-CAPABILITY' });
    expect(followUp.escalates).toBe(true);
    expect(followUp.action).toBe('ESCALATION_ELIGIBLE');
    expect(followUp.human_required).toBeNull();

    // escalation decidida pelo control plane — MESMO provider, degrau seguinte da ladder.
    const escalation = decideEscalation({
      diagnosis: groundedDiagnosis,
      repair_sequence: repairSequence('fake-worker-primary-v1'),
      ladder: CAPABILITY_LADDER,
      capability_registry: new CapabilityRegistry([
        escalationCapability('fake-worker-primary-v1', 'fake'),
        escalationCapability('fake-worker-capable-v2', 'fake'),
      ]),
      execution_policy: escalationExecutionPolicy(),
      candidate_preflights: [candidatePreflight('fake-worker-capable-v2')],
    });
    expect(escalation.outcome).toBe('ESCALATE');
    if (escalation.outcome !== 'ESCALATE') return;
    expect(escalation.authorization.decision_owner).toBe('agent_strategy_lab_harness');
    expect(escalation.authorization.cross_provider).toBe(false);
    expect(escalation.authorization.to_profile_id).toBe('fake-worker-capable-v2');

    // control plane reabre T2 e lança o worker novo — processo fresco, sem --resume.
    await retryFailedAttempt({
      paths,
      taskId: 'T2',
      reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
      reason: 'harness autorizou escalation dentro da ladder configurada',
    });
    expect((await readState(paths)).tasks[1]).toMatchObject({ status: 'READY' });

    const escalated = await orchestrate(sandbox, 'success', ['--max-iterations', '1'], escalation.authorization.to_profile_id);
    expect(escalated.exitCode, escalated.stderr).toBe(0);
    const escalatedSummary = JSON.parse(escalated.stdout) as { stopped_by: string; profile_id: string };
    expect(escalatedSummary.stopped_by).toBe('ALL_DONE');
    expect(escalatedSummary.profile_id).toBe('fake-worker-capable-v2');
    expect((await readState(paths)).tasks[1]?.status).toBe('PASS');

    const escalatedLaunch = await readLaunchRecord(paths, 'T2');
    expect(escalatedLaunch?.profile_id).toBe('fake-worker-capable-v2');
    expect(escalatedLaunch?.process.pid).not.toBe(originalLaunch?.process.pid);
    expect(escalatedLaunch?.controlled['fresh_process']).toBe(true);
    expect(escalatedLaunch?.controlled['inherited_transcript']).toBe(false);
    expect(escalatedLaunch?.argv.join(' ')).not.toMatch(/--resume|--continue|--fork-session|--session-id/);

    // ---------------------------------------------------------------------
    // Integração WRITE→READ (M81): um run real do fake adapter grava
    // ComparableRunFacts pelo evidence recording path que o lifecycle usa;
    // M81 lê essa evidência e deriva a ComparableRunIdentity com valor real
    // mais provenance — nunca UNKNOWN. Um run histórico sem esse artifact
    // continua UNKNOWN mais provenance, sem migration nem escrita.
    // ---------------------------------------------------------------------
    const escalatedProfileId = escalation.authorization.to_profile_id;
    const labRoot = await temporaryRoot('agentlab-e2e-comparable-');
    const runsDir = path.join(labRoot, 'data', 'runs');

    async function runFakeTrial(trialId: string, recordFacts: boolean): Promise<void> {
      const prepared = await prepareRun({
        trial: fixtureTrial(trialId),
        baseSha: await headSha(sandbox.root),
        budgets: FIXTURE_TASK_BUDGETS,
        timeoutMs: 60_000,
        sourceRepo: sandbox.root,
        adapter: FAKE_ADAPTER_IDENTITY,
        labRoot,
        parentDir: await temporaryRoot('agentlab-e2e-comparable-clone-'),
      });
      if (recordFacts) {
        const evidence: ComparableRunFactsEvidence = {
          authoritative_profile: { id: escalatedProfileId },
          provider: { value: 'fake', provenance: 'escalated_launcher_profile.agent' },
          transport: { value: 'argv_process', provenance: 'profile.prompt_delivery' },
          worker_role: { value: 'implementer', provenance: 'lifecycle.role' },
          attempt_role: { value: AttemptRole.ESCALATION, provenance: 'escalation.authorization.attempt_role' },
        };
        const recorded = await recordComparableRunFacts({ executionDir: prepared.executionDir, evidence });
        expect(recorded.outcome).toBe('RECORDED');
      }
      await writeFile(path.join(prepared.clone.clonePath, 'README.md'), `base\n${trialId}\n`, 'utf8');
      await executeRun({ prepared });
    }

    const writtenTrialId = 'm85-capability-written';
    const historicalTrialId = 'm85-capability-historical';
    await runFakeTrial(writtenTrialId, true);
    await runFakeTrial(historicalTrialId, false);

    const queried = await queryPerformanceHistory({
      runs_dir: runsDir,
      trials: [{ trial_id: writtenTrialId }, { trial_id: historicalTrialId }],
      minimum_sample_size: 1,
    });
    expect(queried.excluded_trials).toEqual([]);

    const writtenSeries = queried.series.find((series) => series.trial_ids.includes(writtenTrialId));
    const historicalSeries = queried.series.find((series) => series.trial_ids.includes(historicalTrialId));
    expect(writtenSeries).toBeDefined();
    expect(historicalSeries).toBeDefined();

    expect(writtenSeries!.identity.profile.profile_id.value).toBe(escalatedProfileId);
    expect(writtenSeries!.identity.profile.profile_id.provenance).toContain('authoritative_launcher_profile');
    expect(writtenSeries!.identity.execution.provider.value).toBe('fake');
    expect(writtenSeries!.identity.execution.provider.provenance).toBe('escalated_launcher_profile.agent');

    // fixture histórica (nunca passou pelo evidence recording path): UNKNOWN + provenance, sem escrita.
    expect(historicalSeries!.identity.profile.profile_id.value).toBe('UNKNOWN');
    expect(historicalSeries!.identity.profile.profile_id.provenance).toBe(
      'comparable_run_facts_artifact_not_present',
    );
    expect(historicalSeries!.identity.execution.provider.value).toBe('UNKNOWN');
    expect(historicalSeries!.identity.execution.provider.provenance).toBe('comparable_run_facts_artifact_not_present');
  }, 120_000);

  // -------------------------------------------------------------------------
  // 4. INFRA
  // -------------------------------------------------------------------------
  it('INFRA — INFRA_ERROR real nunca produz escalation de capacidade', async () => {
    const sandbox = await externalProjectFixture();
    const tasks: PlannedTaskLike[] = [
      {
        task_id: 'T1',
        objective: 'tarefa que sofre falha de infraestrutura do launcher',
        blocked_by: [],
        initial_files: ['src/greet.ts'],
        acceptance: ['nunca alcançada nesta prova'],
        validation: [{ argv: ['true'], timeout_seconds: 30 }],
      },
    ];
    const { paths } = await writePlanAndInitState(sandbox, tasks);

    const result = await orchestrate(sandbox, 'infra-error', ['--max-iterations', '1']);
    expect(result.exitCode).toBe(9);
    expect((JSON.parse(result.stdout) as { stopped_by: string }).stopped_by).toBe('INFRA_ERROR');
    expect((await readState(paths)).tasks[0]?.status).toBe('INFRA_ERROR');

    const infraDiagnosis = diagnosis({
      classification: 'INFRA',
      rationale: 'launcher terminou com exit code de infraestrutura não recuperável',
      evidence_paths: [path.join('logs', 'T1.stdout.log')],
    });
    const followUp = resolveFailureFollowUp({ diagnosis: infraDiagnosis, incidentId: 'INC-INFRA' });
    expect(followUp.action).toBe('RETRY_INFRA_SAME_PROFILE');
    expect(followUp.escalates).toBe(false);
    expect(followUp.human_required).toBeNull();
  }, 60_000);

  // -------------------------------------------------------------------------
  // 5. ENVIRONMENT
  // -------------------------------------------------------------------------
  it('ENVIRONMENT — ambiente NOT_READY é aplicado antes de culpar capacidade', () => {
    const task = plannedTask();
    // Blocker CONCRETO (filesystem não gravável), não mera ausência: um
    // repositório greenfield sem deps instaladas é executável por policy.
    const notReadyInspection = inspection({
      filesystem_permissions: {
        known: true,
        value: { readable: true, writable: false },
        provenance: 'fs',
      },
    });
    const assessment = assessExecution(task, {
      inspection: notReadyInspection,
      expectedBaseRevisionSha: FIXTURE_HEAD_SHA,
      factsSource: 'full_inspection',
    });
    expect(assessment.environment_readiness.status).toBe('NOT_READY');

    const environmentGate = {
      outcome: 'ENVIRONMENT_NOT_READY' as const,
      reason: assessment.environment_readiness.rationale,
      unsatisfied: assessment.environment_readiness.checks
        .filter((check) => check.status === 'not_satisfied')
        .map((check) => check.requirement),
    };

    // mesmo com um diagnóstico CAPABILITY, ambiente NOT_READY vence: nunca escala.
    const followUp = resolveFailureFollowUp({
      diagnosis: diagnosis({ classification: 'CAPABILITY' }),
      incidentId: 'INC-ENV',
      environment: environmentGate,
    });
    expect(followUp.action).toBe('REMEDIATE_ENVIRONMENT');
    expect(followUp.escalates).toBe(false);
    expect(followUp.human_required).toBeNull();
    expect(followUp.rationale).toContain('environment readiness');
  });

  // -------------------------------------------------------------------------
  // 6. TASK/CONTEXT
  // -------------------------------------------------------------------------
  it('TASK/CONTEXT — work unit sem fronteira de rollback decompõe em vez de escalar às cegas', async () => {
    const tooBroad = plannedTask({
      risk: 'high',
      resource_envelope: {
        duration_ms: { expected: 600_000, maximum: 1_800_000 },
        tokens: { expected: 50_000, maximum: 200_000 },
        changed_files: { expected: 5, maximum: 60 },
      },
    });
    const planner = new RecordingPlanner({
      outcome: 'DRAFT_RETURNED',
      invocation_id: 'inv-too-broad',
      provider_id: 'fake',
      model: 'fake-worker-v1',
      draft: { schema_version: 1, tasks: [tooBroad] },
    });
    const result = await runReviewedPath({
      intake: intake(),
      inspection: inspection(),
      authorizationScope: scope(),
      planningWorker: planner,
    });
    expect(result.outcome).toBe('DECOMPOSITION_REQUIRED');
    if (result.outcome === 'DECOMPOSITION_REQUIRED') {
      expect(result.stage).toBe('AVC_DECOMPOSITION');
      expect(result.issues.length).toBeGreaterThan(0);
    }

    const broadFollowUp = resolveFailureFollowUp({
      diagnosis: diagnosis({ classification: 'TASK_DEFINITION_TOO_BROAD' }),
      incidentId: 'INC-TASK',
    });
    expect(broadFollowUp.action).toBe('REPLAN_OR_DECOMPOSE');
    expect(broadFollowUp.escalates).toBe(false);
    expect(broadFollowUp.human_required).toBeNull();

    const pressureFollowUp = resolveFailureFollowUp({
      diagnosis: diagnosis({ classification: 'CONTEXT_PRESSURE' }),
      incidentId: 'INC-CONTEXT',
    });
    expect(pressureFollowUp.action).toBe('RESCOPE_CONTEXT');
    expect(pressureFollowUp.escalates).toBe(false);
    expect(pressureFollowUp.human_required).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 7. CROSS_PROVIDER (+ integração AUTONOMIA dentro do escopo)
  // -------------------------------------------------------------------------
  it('CROSS_PROVIDER — escalation entre providers decidida pelo control plane; 3 tasks sem gate humano intermediário', async () => {
    const sandbox = await externalProjectFixture();
    await writeFakeProfile(sandbox, 'fake-worker-primary-v1', { orchestratorOwned: true });
    await writeFakeProfile(sandbox, 'fake-worker-cross-v3');

    const tasks: PlannedTaskLike[] = [
      {
        task_id: 'T1',
        objective: 'tarefa trivial que sempre passa',
        blocked_by: [],
        initial_files: ['src/greet.ts'],
        acceptance: ['sempre satisfeita'],
        validation: [{ argv: ['true'], timeout_seconds: 30 }],
      },
      {
        task_id: 'T2',
        objective: 'tarefa que precisa de escalation cross-provider',
        blocked_by: ['T1'],
        initial_files: ['src/greet.ts'],
        acceptance: ['conteúdo escrito pelo worker escalado'],
        validation: [{ argv: ['grep', '-q', 'feito por T2', 'src/t2.txt'], timeout_seconds: 30 }],
      },
      {
        task_id: 'T3',
        objective: 'próxima task, deve rodar sem gate humano intermediário',
        blocked_by: ['T2'],
        initial_files: ['src/greet.ts'],
        acceptance: ['sempre satisfeita'],
        validation: [{ argv: ['true'], timeout_seconds: 30 }],
      },
    ];
    const { paths } = await writePlanAndInitState(sandbox, tasks);

    const exhausted = await orchestrate(sandbox, 'official-fail', ['--max-iterations', '4'], 'fake-worker-primary-v1');
    expect(exhausted.exitCode).toBe(9);
    const exhaustedSummary = JSON.parse(exhausted.stdout) as { stopped_by: string };
    expect(exhaustedSummary.stopped_by).toBe(AUTOMATIC_REPAIR_EXHAUSTED);
    expect(JSON.stringify(exhaustedSummary)).not.toContain('HUMAN_REQUIRED');
    const originalLaunch = await readLaunchRecord(paths, 'T2');

    const archived = await readValidationFailedAttempt(paths, 'T2', 1);
    expect(archived).not.toBeNull();
    const groundedDiagnosis = diagnosis({
      evidence_paths: [archived!.change_bundle.manifest_path, archived!.change_bundle.patch_path],
    });

    // decisão de escalation cross-provider: SOMENTE o control plane escolhe o
    // próximo profile/provider — o worker nunca vê nem decide isso.
    const escalation = decideEscalation({
      diagnosis: groundedDiagnosis,
      repair_sequence: repairSequence('fake-worker-primary-v1'),
      ladder: CROSS_PROVIDER_LADDER,
      capability_registry: new CapabilityRegistry([
        escalationCapability('fake-worker-primary-v1', 'fake'),
        escalationCapability('fake-worker-cross-v3', 'codex'),
      ]),
      execution_policy: escalationExecutionPolicy(),
      candidate_preflights: [candidatePreflight('fake-worker-cross-v3')],
    });
    expect(escalation.outcome).toBe('ESCALATE');
    if (escalation.outcome !== 'ESCALATE') return;
    expect(escalation.authorization.cross_provider).toBe(true);
    expect(escalation.authorization.from_provider).toBe('fake');
    expect(escalation.authorization.to_provider).toBe('codex');
    expect(escalation.authorization.decision_owner).toBe('agent_strategy_lab_harness');
    expect(escalation.authorization.scope_capabilities).toContain(
      'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
    );
    // nenhum provider real e nenhuma credencial: o profile escalado ainda
    // aponta para o mesmo worker falso — só o rótulo de capability muda.
    expect(escalation.authorization.to_profile_id).toBe('fake-worker-cross-v3');

    await retryFailedAttempt({
      paths,
      taskId: 'T2',
      reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
      reason: 'harness autorizou escalation cross-provider dentro da ladder configurada',
    });

    // AUTONOMIA dentro do escopo: worker novo (fresco, sem herdar conversa) e a
    // PRÓXIMA task (T3) rodam na MESMA invocação, sem qualquer gate humano.
    const continued = await orchestrate(
      sandbox,
      'success',
      ['--max-iterations', '5'],
      escalation.authorization.to_profile_id,
    );
    expect(continued.exitCode, continued.stderr).toBe(0);
    const continuedSummary = JSON.parse(continued.stdout) as {
      stopped_by: string;
      iterations: { task_id: string; result: string }[];
    };
    expect(continuedSummary.stopped_by).toBe('ALL_DONE');
    expect(continuedSummary.iterations.map((iteration) => iteration.task_id)).toEqual(['T2', 'T3']);
    expect(continuedSummary.iterations.every((iteration) => iteration.result === 'PASS')).toBe(true);
    expect(JSON.stringify(continuedSummary)).not.toContain('HUMAN_REQUIRED');

    const finalState = await readState(paths);
    expect(finalState.tasks.map((task) => task.status)).toEqual(['PASS', 'PASS', 'PASS']);

    const escalatedLaunch = await readLaunchRecord(paths, 'T2');
    expect(escalatedLaunch?.profile_id).toBe('fake-worker-cross-v3');
    expect(escalatedLaunch?.process.pid).not.toBe(originalLaunch?.process.pid);
    expect(escalatedLaunch?.controlled['fresh_process']).toBe(true);
    expect(escalatedLaunch?.controlled['inherited_transcript']).toBe(false);
    expect(escalatedLaunch?.argv.join(' ')).not.toMatch(/--resume|--continue|--fork-session|--session-id/);
  }, 120_000);

  // -------------------------------------------------------------------------
  // 8. HUMAN_GATE (+ integração PARADA na fronteira)
  // -------------------------------------------------------------------------
  it('HUMAN_GATE — risco crítico e boundary não autorizado param a automação com decision_needed/options, zero spawn depois', async () => {
    const sandbox = await externalProjectFixture();
    const tasks: PlannedTaskLike[] = [
      {
        task_id: 'T1',
        objective: 'ação de risco crítico, nunca deveria ser lançada sem humano',
        blocked_by: [],
        initial_files: ['src/greet.ts'],
        acceptance: ['nunca alcançada nesta prova'],
        validation: [{ argv: ['true'], timeout_seconds: 30 }],
      },
    ];
    const { paths } = await writePlanAndInitState(sandbox, tasks);
    const stateBefore = await readState(paths);
    const headBefore = await headSha(sandbox.root);

    // risco crítico / ação security-sensitive: HUMAN_REQUIRED, nenhum launch permitido.
    const criticalAuthorization = authorizeProjectLaunch({
      scope: scope(),
      capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
      billing_mode: 'subscription_only',
      quota: { availability: null, provenance: 'quota não probada antes do launch' },
      credential: { availability: true, provenance: 'probe local provou a assinatura' },
      risk: 'critical',
      worker_owns_commit: false,
      worker_owns_official_validation: false,
    });
    expect(criticalAuthorization.outcome).toBe('HUMAN_REQUIRED');
    if (criticalAuthorization.outcome !== 'HUMAN_REQUIRED') return;
    expect(criticalAuthorization.gated_capability).toBe('CRITICAL_OR_SECURITY_SENSITIVE_ACTION');

    // decision_needed e options expostos ao operador, evidência preservada.
    const insufficientEvidence = resolveFailureFollowUp({
      diagnosis: diagnosis({
        classification: 'UNKNOWN_INSUFFICIENT_EVIDENCE',
        decision_needed: 'decidir se a ação de risco crítico deve prosseguir',
        options: ['autorizar manualmente', 'recusar e replanejar'],
      }),
      incidentId: 'INC-HUMAN-GATE',
    });
    expect(insufficientEvidence.human_required).not.toBeNull();
    const humanRequired = insufficientEvidence.human_required!;
    expect(humanRequired.status).toBe('HUMAN_REQUIRED');
    expect(humanRequired.decision_needed).toBe('decidir se a ação de risco crítico deve prosseguir');
    expect(humanRequired.options).toEqual(['autorizar manualmente', 'recusar e replanejar']);
    expect(humanRequired.evidence_paths.length).toBeGreaterThan(0);

    const adapted = toHumanRequiredOutput(
      {
        status: 'HUMAN_REQUIRED',
        classification: 'CAPABILITY',
        decision_needed: humanRequired.decision_needed,
        why_automation_stopped: humanRequired.why_automation_stopped,
        options: [...humanRequired.options],
        evidence_paths: [...humanRequired.evidence_paths],
        provenance: ['launch_record'],
      },
      'INC-HUMAN-GATE',
    );
    expect(adapted.decision_needed).toBe(humanRequired.decision_needed);
    expect(adapted.options).toEqual(humanRequired.options);

    // PARADA na fronteira: tentativa de escalation cross-provider sem o
    // boundary autorizar essa capability — HUMAN_REQUIRED, zero spawn depois.
    const unauthorizedScope = scope({
      autonomous_execution_boundary: [
        'DISPOSABLE_LOCAL_WORKSPACE',
        'CONFIGURED_SUBSCRIPTION_WORKER',
        'DETERMINISTIC_VALIDATION',
        'BOUNDED_REPAIR',
        'CAPABILITY_ESCALATION_WITHIN_LADDER',
      ],
    });
    const boundaryStop = decideEscalation({
      diagnosis: diagnosis(),
      repair_sequence: repairSequence('fake-worker-primary-v1'),
      ladder: CROSS_PROVIDER_LADDER,
      capability_registry: new CapabilityRegistry([
        escalationCapability('fake-worker-primary-v1', 'fake'),
        escalationCapability('fake-worker-cross-v3', 'codex'),
      ]),
      execution_policy: escalationExecutionPolicy({ authorization_scope: unauthorizedScope }),
      candidate_preflights: [candidatePreflight('fake-worker-cross-v3')],
    });
    expect(boundaryStop.outcome).toBe('HUMAN_REQUIRED');
    if (boundaryStop.outcome === 'HUMAN_REQUIRED') {
      expect(boundaryStop.reason_code).toBe('ESCALATION_NOT_AUTHORIZED');
      expect(boundaryStop.human_required.status).toBe('HUMAN_REQUIRED');
      expect(boundaryStop.human_required.options.length).toBeGreaterThan(0);
    }

    // Zero spawn de worker ou provider depois de QUALQUER um dos dois gates:
    // nenhuma chamada a `orchestrate`/`retryFailedAttempt` acontece daqui em
    // diante nesta prova — state e evidência ficam exatamente como estavam.
    const stateAfter = await readState(paths);
    expect(stateAfter).toEqual(stateBefore);
    expect(await headSha(sandbox.root)).toBe(headBefore);
    expect(stateAfter.tasks.every((task) => task.status === 'READY')).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // 9. ROUTING_BUDGET — integração materialização operacional → M76 → M78
  // -------------------------------------------------------------------------
  it('ROUTING_BUDGET — validation do orchestrator permanece fora do runtime do coding worker', () => {
    const implementationMs = 1_500_000;
    const validationMs = 420_000;
    const advancedBoundMs = 1_800_000;
    const routingInspection = inspection({
      required_tools: [{ name: 'node', reason: 'executar Vitest', source: 'package.json' }],
      source_anchors: [
        { area: 'routing', path: 'src/routing/router.ts' },
        { area: 'orchestration', path: 'dev/lib/project-run.ts' },
      ],
    });

    function routingCapability(profileId: string, model: string, reasoningEffort: string) {
      return capabilityOf({
        profile_id: profileId,
        agent: 'codex',
        model,
        reasoning_effort: reasoningEffort,
        reasoning_effort_source: 'codex_config_override',
        billing_mode: 'subscription_only',
        credential_source: 'fixture_subscription',
        environment_mode: 'real-world',
        instruction_environment: 'sanitized_user_home',
        commit_owner: 'orchestrator',
        official_validation_owner: 'orchestrator',
        worker_validation_policy: 'targeted',
        sandbox: 'workspace-write',
        session_persistence: 'ephemeral',
      });
    }
    const intermediate = routingCapability('fixture-intermediate', 'gpt-5.6-terra', 'medium');
    const advanced = routingCapability('fixture-advanced', 'gpt-5.6-sol', 'high');
    const candidates = [intermediate, advanced].map((profile) => ({
      profile_id: profile.profile_id,
      availability: { value: true, provenance: 'fixture preflight' },
    })) satisfies RoutingCandidate[];
    const registry = new CapabilityRegistry([intermediate, advanced]);

    function routeMaterialized({
      validationExpectedMs = validationMs,
      envelopeExpectedMs = implementationMs,
      envelopeMaximumMs = Math.max(2_400_000, envelopeExpectedMs),
      validationCommandTimeoutSeconds = 180,
    }: {
      validationExpectedMs?: number;
      envelopeExpectedMs?: number;
      envelopeMaximumMs?: number;
      validationCommandTimeoutSeconds?: number;
    } = {}) {
      const built = buildWorkUnitFromPlan({
        planTask: {
          id: 'routing-budget-self-maintenance',
          title: 'Preservar ownership do budget de validação',
          blocked_by: [],
          objective: 'Adicionar uma regressão de routing para uma correção real do harness',
          initial_files: [
            'test/e2e/project-orchestration-e2e.test.ts',
            'src/routing/router.ts',
            'dev/lib/project-run.ts',
          ],
          acceptance: ['routing separa validação oficial e implementação'],
          validation: [
            {
              argv: ['pnpm', 'exec', 'vitest', 'run', 'test/e2e/project-orchestration-e2e.test.ts'],
              timeout_seconds: validationCommandTimeoutSeconds,
            },
            { argv: ['pnpm', 'typecheck'], timeout_seconds: 120 },
            { argv: ['pnpm', 'build'], timeout_seconds: 120 },
          ],
          constraints: [],
          include_previous_handoff: false,
          planner_metadata: {
            taxonomy: {
              version: 1,
              task_class: 'bugfix',
              difficulty_declared: 'hard',
              complexity: 'subsystem',
              ambiguity: 'low',
              verification: 'deterministic',
            },
            risk: 'high',
            probable_files: [],
            context_scope: { areas: ['routing', 'orchestration'] },
            context_requirements: [{
              description: 'contratos públicos do routing e do control plane',
              source_anchor: 'src/routing/router.ts',
            }],
            environment_requirements: [{ kind: 'tool', name: 'node', reason: 'executar Vitest' }],
            estimated_duration: { expected: implementationMs, maximum: 2_400_000 },
            validation_budget: { expected: validationExpectedMs, maximum: 900_000 },
            resource_envelope: {
              duration_ms: { expected: envelopeExpectedMs, maximum: envelopeMaximumMs },
              tokens: { expected: 28_000, maximum: 45_000 },
              changed_files: { expected: 1, maximum: 3 },
            },
          },
        },
        inspection: routingInspection,
        classification: {
          task_class: 'feature',
          difficulty_declared: 'easy',
          risk: 'low',
          complexity: 'local',
          ambiguity: 'low',
          verification: 'deterministic',
          resource_envelope: {
            duration_ms: { expected: 60_000, maximum: 120_000 },
            tokens: { expected: 1_000, maximum: 2_000 },
            changed_files: { expected: 1, maximum: 2 },
          },
        },
      });
      const assessment = assessExecution(built.task, {
        inspection: routingInspection,
        expectedBaseRevisionSha: FIXTURE_HEAD_SHA,
        factsSource: 'full_inspection',
      });
      const result = routeInitialProfile({
        work_unit: {
          source: 'planner',
          task: built.task,
          assessment,
          project_facts: routingInspection,
        },
        role: 'implementer',
        capability_registry: registry,
        candidates,
      });
      return { built, result };
    }

    const baseline = routeMaterialized();
    expect(baseline.built.provenance).toContain(
      'taxonomy/risk/resource_envelope=plan.planner_metadata',
    );
    expect(baseline.built.task).toMatchObject({
      taxonomy: { task_class: 'bugfix', difficulty_declared: 'hard', complexity: 'subsystem' },
      risk: 'high',
      validation_budget: { expected: validationMs },
      resource_envelope: { duration_ms: { expected: implementationMs } },
    });
    expect(baseline.result.outcome).toBe('ROUTED');
    if (baseline.result.outcome !== 'ROUTED') throw new Error('unreachable');

    expect(baseline.result.profile.profile_id).toBe(advanced.profile_id);
    expect(baseline.result.profile.environment_mode).toBe('real-world');
    expect(baseline.result.rationale.join(' ')).toContain('tier requerido=advanced');
    expect(baseline.result.candidates_considered).toContainEqual(expect.objectContaining({
      profile_id: intermediate.profile_id,
      outcome: 'REJECTED',
      rejection_code: 'CAPABILITY_INSUFFICIENT',
    }));
    expect(baseline.result.execution_runtime_forecast).toMatchObject({
      predicted_runtime_ms: 1_445_000,
      authority: 'ADVISORY',
      components: {
        envelope_duration_expected_ms: implementationMs,
        aggregate_validation_cost_ms: validationMs,
        worker_owned_validation_cost_ms: 0,
      },
    });

    const expensiveValidation = routeMaterialized({ validationExpectedMs: 900_000 });
    expect(expensiveValidation.result.outcome).toBe('ROUTED');
    if (expensiveValidation.result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(expensiveValidation.built.task.resource_envelope).toEqual(
      baseline.built.task.resource_envelope,
    );
    expect(expensiveValidation.built.task.validation).toEqual(baseline.built.task.validation);
    expect(expensiveValidation.result.execution_runtime_forecast.predicted_runtime_ms).toBe(
      baseline.result.execution_runtime_forecast.predicted_runtime_ms,
    );
    expect(expensiveValidation.result.execution_runtime_forecast.components).toMatchObject({
      aggregate_validation_cost_ms: 900_000,
      worker_owned_validation_cost_ms: 0,
    });

    const components = baseline.result.execution_runtime_forecast.components;
    const legacyWorkerBudgetMs = Math.ceil(
      ((implementationMs + validationMs) *
        components.capability_multiplier *
        components.task_class_multiplier *
        components.stack_multiplier *
        components.environment_multiplier) /
        1_000,
    ) * 1_000;
    expect(legacyWorkerBudgetMs).toBe(1_849_000);
    expect(legacyWorkerBudgetMs).toBeGreaterThan(advancedBoundMs);
    expect(baseline.built.task.resource_envelope.duration_ms.expected).toBe(implementationMs);

    // Envelope que ANTES estourava o bound de 1.800.000ms e derrubava a work
    // unit. Hoje ele roteia: a previsão é registrada e não recusa nada.
    const oversizedImplementation = routeMaterialized({ envelopeExpectedMs: 2_000_000 });
    expect(oversizedImplementation.result.outcome).toBe('ROUTED');
    if (oversizedImplementation.result.outcome !== 'ROUTED') {
      throw new Error('unreachable');
    }
    expect(oversizedImplementation.result.profile.profile_id).toBe(advanced.profile_id);
    expect(
      oversizedImplementation.result.execution_runtime_forecast.predicted_runtime_ms,
    ).toBe(1_926_000);
    expect(
      oversizedImplementation.result.execution_runtime_forecast.predicted_runtime_ms,
    ).toBeGreaterThan(advancedBoundMs);

    // O requirement é derivado do shape hard/subsystem/high-risk da work unit,
    // não do tamanho do forecast: o mesmo tier advanced é exigido com uma
    // previsão pequena ou enorme, e o tier intermediate falha por capability.
    const enormousEnvelopeMs = 86_400_000;
    const enormous = routeMaterialized({
      envelopeExpectedMs: enormousEnvelopeMs,
      envelopeMaximumMs: 172_800_000,
    });
    expect(enormous.result.outcome).toBe('ROUTED');
    if (enormous.result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(enormous.result.profile.profile_id).toBe(advanced.profile_id);
    expect(enormous.result.rationale[0]).toBe(baseline.result.rationale[0]);
    expect(enormous.result.execution_runtime_forecast).toMatchObject({
      authority: 'ADVISORY',
      predicted_runtime_ms: 83_204_000,
      components: { envelope_duration_expected_ms: enormousEnvelopeMs },
    });

    for (const routed of [baseline.result, enormous.result]) {
      const rejectedCandidates = routed.candidates_considered.filter(
        (consideration) => consideration.outcome === 'REJECTED',
      );
      expect(rejectedCandidates).toEqual([
        expect.objectContaining({
          profile_id: intermediate.profile_id,
          rejection_code: 'CAPABILITY_INSUFFICIENT',
        }),
      ]);
      expect(rejectedCandidates.map(({ reason }) => reason).join(' ')).not.toMatch(
        /budget|runtime|tempo|previsão/i,
      );
    }

    // O timeout limita seu ValidationCommand; mesmo um valor enorme não vira
    // input do forecast e não altera o validation_budget oficial declarado.
    const longValidationCommand = routeMaterialized({
      validationCommandTimeoutSeconds: 3_600,
    });
    expect(longValidationCommand.result.outcome).toBe('ROUTED');
    if (longValidationCommand.result.outcome !== 'ROUTED') throw new Error('unreachable');
    expect(longValidationCommand.built.task.validation[0]?.timeout_seconds).toBe(3_600);
    expect(longValidationCommand.built.task.validation_budget).toEqual(
      baseline.built.task.validation_budget,
    );
    expect(longValidationCommand.result.execution_runtime_forecast).toEqual(
      baseline.result.execution_runtime_forecast,
    );
  });
});

// ---------------------------------------------------------------------------
// Auxiliares do write→read (M81) — trial/task mínimos para `prepareRun`, sem
// task-create/evaluation/score: `readTrialHistory`/`queryPerformanceHistory`
// só precisam de `execution/` selado, que `prepareRun`+`executeRun` já bastam
// para produzir.
// ---------------------------------------------------------------------------

const FIXTURE_ENVIRONMENT_PROFILE: EnvironmentProfile = {
  id: 'm85-controlled-clean-room',
  mode: 'controlled',
  env_allowlist: ['PATH', 'LANG'],
  home: 'sanitized',
  instruction_files: [],
  plugins: [],
  skills: [],
  mcp_servers: [],
};

const FIXTURE_TASK_BUDGETS = {
  duration_ms: { expected: 60_000, maximum: 120_000 },
  tokens: { expected: 128, maximum: 1_000 },
  changed_files: { expected: 1, maximum: 4 },
};

function fixtureTaskSpec(): TaskSpec {
  return TaskSpec.parse({
    id: 'm85-fixture-task',
    description: 'Tarefa fixture do E2E de orquestração de projeto (M85) — nunca roda contra provider real.',
    visible_criteria: ['Critério único, satisfeito pelo fake agent.'],
    task_class: 'feature',
    difficulty: 'easy',
    stack: ['typescript'],
    public_graders: ['typecheck'],
    budgets: FIXTURE_TASK_BUDGETS,
  });
}

function fixtureTrial(trialId: string): Trial {
  return {
    id: trialId,
    task: fixtureTaskSpec(),
    agent: { id: 'm85-fake-arm', cli: 'fake', cli_version: '1.0.0', model: 'fake-model', flags: [] },
    strategy: { name: 'direct', version: 1, prompt: 'Implemente diretamente a tarefa fornecida.' },
    environment: FIXTURE_ENVIRONMENT_PROFILE,
    status: 'PLANNED',
  };
}

/** Roda um "fresh reviewer" — processo NOVO, read-only, decisão JSON única em stdout. */
async function runDevReview(argv: readonly string[]): Promise<{ decision: string; accepted_commit: string | null }> {
  const { spawn } = await import('node:child_process');
  const [program, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(program as string, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout) as { decision: string; accepted_commit: string | null });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
