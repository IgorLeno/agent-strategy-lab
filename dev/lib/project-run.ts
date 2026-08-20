/**
 * CONTROL PLANE de runs de projeto externo.
 *
 * Este módulo é a costura que faltava entre três coisas que já existiam e não
 * se falavam:
 *
 *   1. a entrada de projeto externo (`dev-run-plan`: repo alvo + PlanFile);
 *   2. o lifecycle universal de M71–M84 (intake, inspeção, assessment,
 *      routing, budget, diagnosis, escalation, review, evidência comparável);
 *   3. as primitives de execução que o harness já tinha (select, packet,
 *      launch, close, validação oficial, automatic repair, recover).
 *
 * NÃO existe segundo executor aqui. O loop continua sendo `runOrchestrate`; o
 * que este módulo faz é DECIDIR, por work unit, qual profile é lançado, com
 * qual worker runtime budget, se a review é exigida, o que um FAIL significa
 * e se uma escalation está autorizada. As decisões entram no loop existente
 * por uma única porta (`ProjectControlPlane`), e o loop continua sendo o dono
 * de estado autoritativo, DAG, commit, validação oficial e recovery.
 *
 * Duas separações são estruturais e não podem ser relaxadas:
 *
 * - WORK DEFINITION vem do PlanFile e é CONFIÁVEL. Nenhum planning worker é
 *   chamado para reescrevê-la: acceptance, validation e dependências entram
 *   verbatim. O que o PlanFile não carrega (risco, taxonomy, envelope) vem da
 *   autorização explícita da run, nunca de default do harness.
 * - EXECUTION AUTHORIZATION vem do `agentlab-run.yaml`. `--profile` nunca
 *   autoriza nada: ele deixa de ser necessário quando existe policy.
 */

import path from 'node:path';

import {
  ProjectIntakeRequest,
  ExecutionAuthorizationScope,
} from '../../src/intake/index.js';
import { inspectRepository, type ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution, type ExecutionAssessment } from '../../src/planner/assess.js';
import { PlannedTask, type TaskRisk } from '../../src/planner/task.js';
import { evaluatePlanWorkflow } from '../../src/planner/validate.js';
import { AttemptRole } from '../../src/performance/attempt-facts.js';
import type { PerformanceHistoryQueryResult } from '../../src/performance/query.js';
import {
  CapabilityRegistry,
  capabilityOf,
  decideEscalation,
  routeInitialProfileWithHistory,
  type EscalationAuthorization,
  type EscalationCandidatePreflight,
  type EscalationExecutionPolicy,
  type EscalationLadder,
  type ProfileCapabilityInput,
  type RoutingCandidate,
} from '../../src/routing/index.js';
import type { FailureDiagnosis } from '../../src/routing/diagnosis.js';
import { assertNoApiCredentials, runBillingPreflight } from './billing.js';
import { experimentFactsOf, sandboxOf, sessionPersistenceOf } from './doctor.js';
import { headSha } from './git.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import {
  buildEnvironment,
  loadProfileFromCatalog,
  profileProvenance,
  type LauncherProfile,
  type ProfileProvenance,
} from './profile.js';
import {
  classificationFor,
  ProjectAuthorizationError,
  type ProjectRunAuthorizationFile,
  type WorkUnitClassification,
} from './project-authorization.js';
import {
  authorizeProjectLaunch,
  combineWorkflowAndReview,
  evaluateEnvironmentReadiness,
  launchProjectReviewer,
  recordComparableRunFacts,
  resolveFailureFollowUp,
  toHumanRequiredOutput,
  type EnvironmentReadinessGate,
  type ProjectLifecyclePathName,
  type ProjectReviewResult,
} from './project-orchestrate.js';
import {
  resolveWorkerRuntimeBudget,
  workerRuntimeBoundsOf,
} from './project-roles.js';
import {
  completionPath,
  readCompletion,
  readLaunchRecord,
  readValidationFailedAttempt,
  validationFailedAttemptPath,
} from './records.js';
import { retryFailedAttempt } from './retry-failed.js';
import type { HumanRequiredOutput } from './routine-autonomy.js';
import { getTaskState, readState } from './state.js';

export const PROJECT_RUN_SCHEMA_VERSION = 1;

/** M82 exige uma consulta já feita; uma run de projeto externo não tem série. */
const HISTORY_MINIMUM_SAMPLE_SIZE = 3;

function emptyPerformanceHistory(): PerformanceHistoryQueryResult {
  return {
    schema_version: 1,
    minimum_sample_size: HISTORY_MINIMUM_SAMPLE_SIZE,
    series: [],
    excluded_runs: [],
    excluded_trials: [],
    comparable_facts_issues: [],
  };
}

// ---------------------------------------------------------------------------
// Capability de profile — derivação única, sem duplicar a do doctor.
// ---------------------------------------------------------------------------

/**
 * Traduz um `LauncherProfile` para a entrada de `capabilityOf` (M77). Model e
 * effort vêm de `experimentFactsOf`; sandbox e persistência de sessão vêm dos
 * helpers do doctor. Um perfil FALSO que declare `test_double_of` representa,
 * para fins de routing, a capability declarada — é o que torna o lifecycle
 * exercitável de ponta a ponta sem provider real, sem que nenhum perfil real
 * possa declarar capacidade que o argv não prove.
 */
export function capabilityInputOf(profile: LauncherProfile): ProfileCapabilityInput {
  const double = profile.test_double_of;
  if (double !== undefined) {
    return {
      profile_id: profile.id,
      agent: double.agent,
      model: double.model,
      reasoning_effort: double.reasoning_effort,
      reasoning_effort_source:
        double.agent === 'codex' ? 'codex_config_override' : 'claude_effort_flag',
      billing_mode: profile.billing_mode,
      credential_source: `declared_test_double:${profile.billing_mode}`,
      environment_mode: profile.environment_mode,
      instruction_environment: profile.instruction_environment,
      commit_owner: profile.commit_owner,
      official_validation_owner: profile.official_validation_owner,
      worker_validation_policy: profile.worker_validation_policy,
      sandbox: double.sandbox,
      session_persistence: sessionPersistenceOf(profile),
    };
  }
  const facts = experimentFactsOf(profile);
  return {
    profile_id: profile.id,
    agent: profile.agent,
    model: facts.model,
    reasoning_effort: facts.reasoning_effort,
    reasoning_effort_source: facts.reasoning_effort_source,
    billing_mode: profile.billing_mode,
    credential_source: `declared:${profile.billing_mode}`,
    environment_mode: profile.environment_mode,
    instruction_environment: profile.instruction_environment,
    commit_owner: profile.commit_owner,
    official_validation_owner: profile.official_validation_owner,
    worker_validation_policy: profile.worker_validation_policy,
    sandbox: sandboxOf(profile),
    session_persistence: sessionPersistenceOf(profile),
  };
}

// ---------------------------------------------------------------------------
// Relatório publicado pelo CLI.
// ---------------------------------------------------------------------------

export interface ProjectRoutingReport {
  readonly source: string;
  readonly selected_profile_id: string;
  readonly pinned: boolean;
  readonly rationale: readonly string[];
}

export interface ProjectBudgetReport {
  readonly requested_ms: number;
  readonly timeout_seconds: number;
  readonly source: string;
  readonly checked_bounds: readonly string[];
}

export interface ProjectReviewReport {
  readonly required: boolean;
  readonly diversity_requirement: string;
  readonly reviewer_profile_id: string | null;
  readonly outcome: string | null;
  readonly reason: string | null;
}

export interface ProjectWorkUnitReport {
  readonly task_id: string;
  readonly attempt_role: AttemptRole;
  readonly path: ProjectLifecyclePathName;
  readonly work_definition_source: 'plan_file';
  readonly planning_worker_invoked: false;
  readonly workflow_outcome: string;
  readonly inspection_provenance: string;
  readonly risk: TaskRisk;
  readonly difficulty: string;
  readonly context_pressure: 'low' | 'medium' | 'high';
  readonly confidence: string;
  readonly verification_strength: string;
  readonly environment_readiness: EnvironmentReadinessGate;
  readonly classification_provenance: string;
  readonly routing: ProjectRoutingReport;
  readonly worker_runtime_budget: ProjectBudgetReport;
  readonly launch_authorization: string;
  review: ProjectReviewReport;
  validation_outcome: string | null;
  comparable_run_facts_path: string | null;
  repair: string | null;
  diagnosis: string | null;
  escalation: string | null;
}

export interface ProjectEscalationReport {
  readonly task_id: string;
  readonly from_profile_id: string;
  readonly to_profile_id: string;
  readonly cross_provider: boolean;
  readonly step_index: number;
  readonly decision_owner: string;
}

export interface ProjectLifecycleReport {
  readonly schema_version: typeof PROJECT_RUN_SCHEMA_VERSION;
  readonly mode: 'PROJECT_LIFECYCLE';
  readonly authorization_file: string;
  readonly profile_policy_id: string;
  readonly eligible_profile_ids: readonly string[];
  readonly autonomous_execution_boundary: readonly string[];
  readonly human_gated_capabilities: readonly string[];
  readonly work_units: readonly ProjectWorkUnitReport[];
  readonly escalations: readonly ProjectEscalationReport[];
  readonly human_gate: HumanRequiredOutput | null;
}

// ---------------------------------------------------------------------------
// Porta consumida por `runOrchestrate`.
// ---------------------------------------------------------------------------

export interface WorkUnitRequest {
  readonly taskId: string;
  readonly attemptKind: 'FIRST_PASS' | 'REPAIR';
  /** Profile imposto pela policy de bounded repair; o routing não o substitui. */
  readonly pinnedProfileId: string | null;
}

export type WorkUnitDecision =
  | {
      readonly outcome: 'LAUNCH';
      readonly profile_id: string;
      readonly timeout_seconds: number;
    }
  | { readonly outcome: 'HUMAN_REQUIRED'; readonly human_required: HumanRequiredOutput };

export interface WorkUnitObservation {
  readonly taskId: string;
  readonly attempt: number;
  readonly profileId: string;
  readonly closeKind: string | null;
  readonly launch: string;
  readonly reason: string;
}

export type WorkUnitFollowUp =
  | { readonly status: 'CONTINUE' }
  | { readonly status: 'HUMAN_REQUIRED'; readonly human_required: HumanRequiredOutput };

export type RepairExhaustedFollowUp =
  | { readonly status: 'ESCALATED'; readonly profile_id: string }
  | { readonly status: 'HUMAN_REQUIRED'; readonly human_required: HumanRequiredOutput }
  | { readonly status: 'NOT_APPLICABLE'; readonly reason: string };

/**
 * Única porta pela qual o control plane universal entra no loop existente.
 * Quando ela é `undefined`, `runOrchestrate` se comporta exatamente como
 * antes — nenhum uso histórico muda de caminho.
 */
export interface ProjectControlPlane {
  readonly kind: 'project_lifecycle';
  beforeWorkUnit(request: WorkUnitRequest): Promise<WorkUnitDecision>;
  afterWorkUnit(observation: WorkUnitObservation): Promise<WorkUnitFollowUp>;
  onRepairExhausted(input: {
    readonly taskId: string;
    readonly reason: string;
  }): Promise<RepairExhaustedFollowUp>;
  snapshot(): ProjectLifecycleReport;
}

// ---------------------------------------------------------------------------
// Construção da work unit a partir do PlanFile (work definition confiável).
// ---------------------------------------------------------------------------

function targetRepoUrlOf(inspection: ProjectInspection, repoRoot: string): string {
  const remote = inspection.git.known ? inspection.git.value.remotes[0] : undefined;
  return remote ?? repoRoot;
}

/**
 * Áreas de contexto derivadas dos `source_anchors` OBSERVADOS que cobrem os
 * `initial_files` declarados pela task. Sem correspondência, cai para todas as
 * áreas observadas — nunca inventa uma fronteira que a inspeção não viu.
 */
function contextAreasOf(
  inspection: ProjectInspection,
  initialFiles: readonly string[],
): { readonly areas: readonly string[]; readonly provenance: string } {
  const matched = [
    ...new Set(
      inspection.source_anchors
        .filter((anchor) => initialFiles.includes(anchor.path))
        .map((anchor) => anchor.area),
    ),
  ];
  if (matched.length > 0) {
    return { areas: matched, provenance: 'inspection.source_anchors ∩ plan.initial_files' };
  }
  const all = [...new Set(inspection.source_anchors.map((anchor) => anchor.area))];
  return { areas: all, provenance: 'inspection.source_anchors (nenhum initial_file ancorado)' };
}

export interface WorkUnitBuild {
  readonly task: PlannedTask;
  readonly provenance: readonly string[];
}

/**
 * Compõe a `PlannedTask` de M73 a partir do PlanFile (objetivo, acceptance,
 * validation, dependências, arquivos iniciais), dos fatos observados pela
 * inspeção (áreas, instruções de projeto, ferramentas/serviços) e da
 * classificação DECLARADA na autorização da run. Nenhum campo é preenchido
 * por default do harness: o que falta vira erro estruturado.
 */
export function buildWorkUnitFromPlan(input: {
  readonly planTask: LoadedPlan['plan']['tasks'][number];
  readonly inspection: ProjectInspection;
  readonly classification: WorkUnitClassification;
}): WorkUnitBuild {
  const { planTask, inspection, classification } = input;
  const context = contextAreasOf(inspection, planTask.initial_files);
  if (context.areas.length === 0) {
    throw new ProjectAuthorizationError(
      `nenhum source anchor observado no repositório alvo: context_scope de ${planTask.id} não pode ser determinado sem inventar fronteira.\n` +
        'Nenhum provider foi chamado. Ação segura: rodar sobre um repositório com código-fonte reconhecível.',
    );
  }

  const validationBudgetMs = planTask.validation.reduce(
    (total, command) => total + command.timeout_seconds * 1_000,
    0,
  );

  const candidate = {
    schema_version: 1 as const,
    task_id: planTask.id,
    objective: planTask.objective,
    blocked_by: [...planTask.blocked_by],
    taxonomy: {
      version: 1 as const,
      task_class: classification.task_class,
      difficulty_declared: classification.difficulty_declared,
      ...(classification.complexity === undefined ? {} : { complexity: classification.complexity }),
      ...(classification.ambiguity === undefined ? {} : { ambiguity: classification.ambiguity }),
      ...(classification.verification === undefined
        ? {}
        : { verification: classification.verification }),
    },
    risk: classification.risk,
    acceptance: [...planTask.acceptance],
    validation: planTask.validation.map((command) => ({
      argv: [...command.argv],
      timeout_seconds: command.timeout_seconds,
    })),
    initial_files: [...planTask.initial_files],
    probable_files: [],
    context_scope: { areas: [...context.areas] },
    context_requirements: inspection.project_instructions.map((ref) => ({
      description: `instrução de projeto (${ref.relevance}) em ${ref.path}`,
      source_anchor: ref.path,
    })),
    environment_requirements: [
      ...inspection.required_tools.map((tool) => ({
        kind: 'tool' as const,
        name: tool.name,
        reason: tool.reason,
      })),
      ...inspection.required_services.map((service) => ({
        kind: 'service' as const,
        name: service.name,
        reason: service.reason,
      })),
    ],
    estimated_duration: classification.resource_envelope.duration_ms,
    validation_budget: { expected: validationBudgetMs, maximum: validationBudgetMs },
    resource_envelope: classification.resource_envelope,
  };

  const parsed = PlannedTask.safeParse(candidate);
  if (!parsed.success) {
    throw new ProjectAuthorizationError(
      `work unit ${planTask.id} não satisfaz o contrato PlannedTask: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}\n` +
        'Nenhum provider foi chamado. Ação segura: corrigir a classificação declarada em work_units.',
    );
  }
  return {
    task: parsed.data,
    provenance: [
      'work_definition=plan_file',
      `context_scope=${context.provenance}`,
      'context_requirements=inspection.project_instructions',
      'environment_requirements=inspection.required_tools+required_services',
      'validation_budget=sum(plan.validation[].timeout_seconds)',
      'taxonomy/risk/resource_envelope=authorization.work_units',
    ],
  };
}

// ---------------------------------------------------------------------------
// Diagnosis grounded na evidência real do runtime.
// ---------------------------------------------------------------------------

/**
 * Constrói o `FailureDiagnosis` de M79 a partir dos attempts ARQUIVADOS. Não
 * há promoção otimista: só duas falhas de validation oficial no MESMO profile
 * sustentam `CAPABILITY`; qualquer outra combinação vira
 * `UNKNOWN_INSUFFICIENT_EVIDENCE`, que nunca escala.
 */
export async function diagnoseExhaustedRepair(
  paths: HarnessPaths,
  taskId: string,
): Promise<{
  readonly diagnosis: FailureDiagnosis;
  readonly initialProfileId: string | null;
  readonly evidencePaths: readonly [string, string];
}> {
  const task = getTaskState(await readState(paths), taskId);
  const currentAttempt = task.attempts;
  // O first pass já foi ARQUIVADO pelo bounded repair; o repair é o attempt
  // corrente, ainda não arquivado — sua evidência é o CompletionRecord FAIL e
  // o LaunchRecord do próprio attempt.
  const archived = currentAttempt >= 2
    ? await readValidationFailedAttempt(paths, taskId, currentAttempt - 1)
    : null;
  const completion = await readCompletion(paths, taskId);
  const launch = await readLaunchRecord(paths, taskId);
  const evidencePaths: readonly [string, string] = [
    validationFailedAttemptPath(paths, taskId, Math.max(1, currentAttempt - 1)),
    completionPath(paths, taskId),
  ];

  const sameProfile =
    archived !== null && launch !== null && archived.profile_id === launch.profile_id;
  const capability =
    task.status === 'FAIL' &&
    currentAttempt >= 2 &&
    completion?.status === 'FAIL' &&
    sameProfile;

  const base = {
    schema_version: 1 as const,
    boundary: 'exatamente um bounded repair no mesmo profile, já consumido',
    retry_budget: {
      kind: 'BOUNDED_REPAIR' as const,
      maximum_attempts: 1 as const,
      attempts_used: 1 as const,
      same_profile_required: true as const,
    },
    evidence_paths: [...evidencePaths],
    provenance: [
      `ValidationFailedAttemptRecord attempt ${Math.max(1, currentAttempt - 1)}`,
      `CompletionRecord FAIL do attempt ${currentAttempt}`,
      'LaunchRecord do attempt corrente',
      'automatic-repair policy (dev/lib/automatic-repair.ts)',
    ],
  };

  if (!capability || archived === null) {
    return {
      diagnosis: {
        ...base,
        classification: 'UNKNOWN_INSUFFICIENT_EVIDENCE',
        rationale:
          'a evidência disponível não prova first pass e bounded repair reprovados pela validation oficial no mesmo profile',
        decision_needed: 'decidir manualmente o próximo passo para a task bloqueada',
        why_automation_stopped:
          'evidência insuficiente para classificar a falha; ausência de prova nunca é promovida a CAPABILITY',
        options: [
          'inspecionar a evidência preservada dos attempts',
          'reabrir a task explicitamente com dev-retry-failed',
        ],
      },
      initialProfileId: archived?.profile_id ?? null,
      evidencePaths,
    };
  }

  return {
    diagnosis: {
      ...base,
      classification: 'CAPABILITY',
      rationale: `first pass e bounded repair falharam a validation oficial no mesmo profile ${archived.profile_id}`,
      decision_needed: 'autorizar o próximo degrau da ladder configurada',
      why_automation_stopped: 'o único reparo bounded no mesmo profile foi consumido sem PASS',
      options: [
        'escalar para o próximo profile autorizado da policy',
        'replanejar a work unit',
        'decidir manualmente',
      ],
    },
    initialProfileId: archived.profile_id,
    evidencePaths,
  };
}

// ---------------------------------------------------------------------------
// Control plane.
// ---------------------------------------------------------------------------

export interface CreateProjectControlPlaneInput {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly authorization: ProjectRunAuthorizationFile;
  readonly authorizationFile: string;
  /** Injetável nos testes; default é a inspeção read-only real do alvo. */
  readonly inspect?: (repoRoot: string) => Promise<ProjectInspection>;
}

interface ActiveWorkUnit {
  readonly report: ProjectWorkUnitReport;
  readonly assessment: ExecutionAssessment;
  readonly task: PlannedTask;
  readonly scope: ExecutionAuthorizationScope;
  readonly budgetMs: number;
  readonly reviewerProfile: LauncherProfile | null;
}

export async function createProjectControlPlane(
  input: CreateProjectControlPlaneInput,
): Promise<ProjectControlPlane> {
  const { paths, loaded, authorization } = input;
  const inspect = input.inspect ?? ((repoRoot: string) => inspectRepository({ repoRoot }));

  const profiles = new Map<string, LauncherProfile>();
  const provenances = new Map<string, ProfileProvenance>();
  for (const entry of authorization.profile_policy.profiles) {
    try {
      profiles.set(entry.id, await loadProfileFromCatalog(paths.profileCatalogRoot, entry.id));
    } catch (error) {
      throw new ProjectAuthorizationError(
        `profile ${entry.id} da policy ${authorization.profile_policy.id} recusado antes de qualquer provider spawn: ` +
          `${error instanceof Error ? error.message : String(error)}\n` +
          'Nenhum attempt foi consumido. Nenhum state autoritativo foi alterado.',
      );
    }
    provenances.set(entry.id, profileProvenance(paths.profileCatalogRoot, entry.id));
  }

  for (const [id, profile] of profiles) {
    if (!authorization.billing.allowed_billing_modes.includes(profile.billing_mode)) {
      throw new ProjectAuthorizationError(
        `profile ${id} declara billing_mode=${profile.billing_mode}, fora de billing.allowed_billing_modes.\n` +
          'Nenhum provider foi chamado.',
      );
    }
    const capabilityAgent = profile.test_double_of?.agent ?? profile.agent;
    if (
      !authorization.profile_policy.allowed_providers.includes(profile.agent) &&
      !authorization.profile_policy.allowed_providers.includes(capabilityAgent)
    ) {
      throw new ProjectAuthorizationError(
        `profile ${id} usa o provider ${profile.agent}, fora de profile_policy.allowed_providers.\n` +
          'Nenhum provider foi chamado.',
      );
    }
  }

  const registry = new CapabilityRegistry(
    [...profiles.values()].map((profile) => capabilityOf(capabilityInputOf(profile))),
  );

  const scope: ExecutionAuthorizationScope = ExecutionAuthorizationScope.parse({
    schema_version: 1,
    requested_scope: authorization.requested_scope,
    autonomous_execution_boundary: authorization.autonomous_execution_boundary,
    human_gated_capabilities: authorization.human_gated_capabilities,
  });

  const ladderSteps = [...authorization.profile_policy.profiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  );

  const workUnits: ProjectWorkUnitReport[] = [];
  const escalations: ProjectEscalationReport[] = [];
  const escalatedProfileByTask = new Map<string, string>();
  const priorAuthorizations: EscalationAuthorization[] = [];
  let active: ActiveWorkUnit | null = null;
  let humanGate: HumanRequiredOutput | null = null;

  function candidatesFor(eligible: readonly string[]): RoutingCandidate[] {
    return eligible.map((id) => {
      const profile = profiles.get(id) as LauncherProfile;
      const provenance = provenances.get(id) as ProfileProvenance;
      return {
        profile_id: id,
        availability: {
          value: true,
          provenance: `profile carregado do catálogo do harness (${provenance.source_file})`,
        },
        runtime_bounds: workerRuntimeBoundsOf(profile).map((bound) => ({ ...bound })),
      };
    });
  }

  function humanRequired(
    incidentId: string,
    decisionNeeded: string,
    why: string,
    options: readonly string[],
    evidencePaths: readonly string[],
  ): HumanRequiredOutput {
    const output: HumanRequiredOutput = {
      status: 'HUMAN_REQUIRED',
      incident_id: incidentId,
      decision_needed: decisionNeeded,
      why_automation_stopped: why,
      options: [...options],
      evidence_paths: [...evidencePaths],
    };
    humanGate = output;
    return output;
  }

  async function beforeWorkUnit(request: WorkUnitRequest): Promise<WorkUnitDecision> {
    const planTask = loaded.byId.get(request.taskId);
    if (planTask === undefined) {
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${request.taskId}:unknown-task`,
          'reconciliar plano e runtime antes de novo launch',
          `task ${request.taskId} selecionada pelo runtime não existe no PlanFile carregado`,
          ['revisar o PlanFile', 'inspecionar o runtime'],
          [paths.planFile],
        ),
      };
    }

    const inspection = await inspect(paths.repoRoot);
    const head = await headSha(paths.repoRoot);
    const intake = ProjectIntakeRequest.parse({
      schema_version: 1,
      target_repo: { url: targetRepoUrlOf(inspection, paths.repoRoot) },
      base_revision: { sha: head },
      user_request: authorization.requested_scope.summary,
      objectives:
        authorization.objectives ?? loaded.plan.tasks.map((task) => task.objective),
      constraints: [...authorization.constraints],
      exclusions: [...authorization.exclusions],
      requested_scope: authorization.requested_scope,
    });

    const { classification, provenance: classificationProvenance } = classificationFor(
      authorization,
      request.taskId,
    );
    const built = buildWorkUnitFromPlan({ planTask, inspection, classification });
    const assessment = assessExecution(built.task, {
      inspection,
      expectedBaseRevisionSha: intake.base_revision.sha,
      factsSource: 'full_inspection',
    });
    const [workflow] = evaluatePlanWorkflow([built.task], {
      inspection,
      intake,
      minimalFactsSource: 'fresh_minimal_collection',
    });
    if (workflow === undefined) {
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${request.taskId}:workflow`,
          'revisar a work unit antes de novo launch',
          `workflow de ${request.taskId} não pôde ser avaliado`,
          ['revisar o PlanFile', 'revisar a classificação declarada'],
          [paths.planFile],
        ),
      };
    }
    const decision = combineWorkflowAndReview(workflow, assessment.review_requirement);
    const environment = evaluateEnvironmentReadiness(assessment.environment_readiness);

    const eligible = [...profiles.keys()];
    const routed = routeInitialProfileWithHistory({
      work_unit: {
        source: 'direct_task_normalization',
        task: built.task,
        assessment,
        project_facts: inspection,
      },
      role: 'implementer',
      capability_registry: registry,
      candidates: candidatesFor(eligible),
      history: emptyPerformanceHistory(),
    });

    const fallback = routed.fallback;
    if (fallback === null || fallback.outcome !== 'ROUTED') {
      const reason =
        fallback === null
          ? 'recomendação histórica não pôde ser aplicada'
          : fallback.outcome === 'BUDGET_UNSUPPORTED'
            ? `worker runtime budget não cabe nos bounds dos profiles autorizados: ${fallback.violations
                .map((violation) => `${violation.profile_id}=${violation.requested_budget_ms}ms`)
                .join(', ')}`
            : fallback.reason;
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${request.taskId}:routing`,
          'ampliar ou corrigir a profile policy autorizada',
          `routing não encontrou profile elegível dentro da policy: ${reason}`,
          [
            'declarar um profile compatível na profile_policy',
            'revisar a classificação declarada da work unit',
          ],
          [input.authorizationFile],
        ),
      };
    }

    const routedProfileId = fallback.profile.profile_id;
    const pinned = request.pinnedProfileId ?? escalatedProfileByTask.get(request.taskId) ?? null;
    const selectedProfileId = pinned ?? routedProfileId;
    const profile = profiles.get(selectedProfileId);
    if (profile === undefined) {
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${request.taskId}:profile-outside-policy`,
          'usar somente profiles da policy autorizada',
          `profile ${selectedProfileId} exigido pelo runtime está fora da profile policy ${authorization.profile_policy.id}`,
          ['declarar o profile na policy', 'rerodar sem o pin de profile'],
          [input.authorizationFile],
        ),
      };
    }

    const budgetMs = fallback.worker_runtime_budget.milliseconds;
    const budget = resolveWorkerRuntimeBudget({ profile, budgetMs });
    if (budget.outcome === 'BUDGET_UNSUPPORTED') {
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${request.taskId}:budget`,
          'reconfigurar runtime ou replanejar a work unit',
          budget.reason,
          [...budget.allowed_next_steps],
          [input.authorizationFile],
        ),
      };
    }

    const launchAuthorization = authorizeProjectLaunch({
      scope,
      capability: request.attemptKind === 'REPAIR' ? 'BOUNDED_REPAIR' : 'CONFIGURED_SUBSCRIPTION_WORKER',
      billing_mode: profile.billing_mode,
      quota_available: true,
      credential_proved: true,
      risk: assessment.risk.value,
      worker_owns_commit: profile.commit_owner !== 'orchestrator',
      worker_owns_official_validation: profile.official_validation_owner !== 'orchestrator',
    });

    const reviewerProfileId = authorization.review.reviewer_profile_id ?? selectedProfileId;
    const reviewerProfile = decision.review_required
      ? (profiles.get(reviewerProfileId) ?? null)
      : null;

    const report: ProjectWorkUnitReport = {
      task_id: request.taskId,
      attempt_role:
        request.attemptKind === 'REPAIR'
          ? AttemptRole.REPAIR
          : escalatedProfileByTask.has(request.taskId)
            ? AttemptRole.ESCALATION
            : AttemptRole.INITIAL,
      path: decision.path,
      work_definition_source: 'plan_file',
      planning_worker_invoked: false,
      workflow_outcome: workflow.outcome,
      inspection_provenance: `inspectRepository(${inspection.repo_root}) em ${inspection.inspected_at}`,
      risk: assessment.risk.value,
      difficulty: assessment.difficulty.value,
      context_pressure: assessment.context_pressure.value,
      confidence: assessment.confidence.value,
      verification_strength: assessment.verification_strength.value,
      environment_readiness: environment,
      classification_provenance: `${classificationProvenance}; ${built.provenance.join('; ')}`,
      routing: {
        source: routed.source,
        selected_profile_id: selectedProfileId,
        pinned: pinned !== null,
        rationale: [...routed.rationale, ...fallback.rationale],
      },
      worker_runtime_budget: {
        requested_ms: budget.requested_budget_ms,
        timeout_seconds: budget.timeout_seconds_override,
        source: 'M78 adaptive worker runtime budget',
        checked_bounds: budget.checked_bounds.map(
          (bound) => `${bound.source}=${bound.maximum_ms}ms`,
        ),
      },
      launch_authorization: launchAuthorization.outcome,
      review: {
        required: decision.review_required,
        diversity_requirement: decision.diversity_requirement,
        reviewer_profile_id: reviewerProfile?.id ?? null,
        outcome: null,
        reason: null,
      },
      validation_outcome: null,
      comparable_run_facts_path: null,
      repair: request.attemptKind === 'REPAIR' ? 'BOUNDED_REPAIR' : null,
      diagnosis: null,
      escalation: escalatedProfileByTask.get(request.taskId) ?? null,
    };
    workUnits.push(report);
    active = { report, assessment, task: built.task, scope, budgetMs, reviewerProfile };

    if (launchAuthorization.outcome === 'HUMAN_REQUIRED') {
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${request.taskId}:launch-authorization`,
          'autorizar explicitamente a capability exigida por esta work unit',
          launchAuthorization.reason,
          [
            'ampliar autonomous_execution_boundary de forma explícita',
            'reduzir o risco declarado da work unit',
            'executar a ação manualmente',
          ],
          [input.authorizationFile],
        ),
      };
    }
    if (environment.outcome !== 'READY') {
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${request.taskId}:environment`,
          'preparar o ambiente do repositório alvo antes de novo launch',
          `${environment.outcome}: ${environment.reason}`,
          ['remediar o ambiente', 'declarar os requisitos ausentes'],
          [paths.repoRoot],
        ),
      };
    }

    return {
      outcome: 'LAUNCH',
      profile_id: selectedProfileId,
      timeout_seconds: budget.timeout_seconds_override,
    };
  }

  async function recordEvidence(
    observation: WorkUnitObservation,
    report: ProjectWorkUnitReport,
  ): Promise<void> {
    const profile = profiles.get(observation.profileId);
    if (profile === undefined) return;
    const executionDir = path.join(
      paths.devDir,
      'project',
      'executions',
      observation.taskId,
      `attempt-${observation.attempt}`,
    );
    const recorded = await recordComparableRunFacts({
      executionDir,
      evidence: {
        authoritative_profile: { id: profile.id },
        profile_provenance: 'authoritative_launcher_profile',
        provider: { value: profile.agent, provenance: 'launcher_profile.agent' },
        transport: { value: profile.prompt_delivery, provenance: 'launcher_profile.prompt_delivery' },
        worker_role: { value: 'implementer', provenance: 'project_lifecycle.role' },
        attempt_role: { value: report.attempt_role, provenance: 'project_lifecycle.attempt_role' },
        context_pressure: {
          value: report.context_pressure,
          provenance: 'assessment.context_pressure',
        },
        // `ENVIRONMENT_UNKNOWN` não existe no contrato comparável de M81 e não
        // pode ser reescrito como READY: fato desconhecido fica UNKNOWN.
        ...(report.environment_readiness.outcome === 'READY'
          ? {
              environment_readiness: {
                value: 'READY' as const,
                provenance: 'assessment.environment_readiness',
              },
            }
          : report.environment_readiness.outcome === 'ENVIRONMENT_NOT_READY'
            ? {
                environment_readiness: {
                  value: 'NOT_READY' as const,
                  provenance: 'assessment.environment_readiness',
                },
              }
            : {}),
      },
    });
    report.comparable_run_facts_path = recorded.file;
  }

  async function afterWorkUnit(observation: WorkUnitObservation): Promise<WorkUnitFollowUp> {
    const current = active;
    const report = current?.report ?? workUnits.at(-1);
    if (report === undefined || current === null) return { status: 'CONTINUE' };
    report.validation_outcome = observation.closeKind ?? observation.launch;
    await recordEvidence(observation, report);

    if (observation.closeKind !== 'PASS') return { status: 'CONTINUE' };
    if (!report.review.required) {
      report.review = { ...report.review, outcome: 'NOT_REQUIRED', reason: 'policy não exigiu review independente' };
      return { status: 'CONTINUE' };
    }

    const reviewerProfile = current.reviewerProfile;
    if (reviewerProfile === null) {
      report.review = { ...report.review, outcome: 'UNAVAILABLE', reason: 'reviewer não pertence à profile policy' };
      return {
        status: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          `project:${observation.taskId}:review-profile`,
          'declarar um reviewer elegível na profile policy',
          'a policy exigiu review independente e nenhum reviewer autorizado existe',
          ['declarar review.reviewer_profile_id', 'reduzir o risco declarado'],
          [input.authorizationFile],
        ),
      };
    }

    const completion = await readCompletion(paths, observation.taskId);
    const evidence = completion?.orchestrator_evidence ?? null;
    const verdict: ProjectReviewResult = await launchProjectReviewer({
      paths,
      profile: reviewerProfile,
      scope: current.scope,
      implementerProfileId: observation.profileId,
      diversityRequirement: report.review.diversity_requirement as never,
      risk: report.risk,
      workerRuntimeBudgetMs: current.budgetMs,
      quotaAvailable: true,
      credentialProved: true,
      packet: {
        task_id: observation.taskId,
        objective: current.task.objective,
        acceptance: current.task.acceptance,
        validation: current.task.validation.map((command) => ({ argv: command.argv })),
        changed_files: evidence?.changed_files ?? [],
        candidate_sha: evidence?.accepted_commit ?? null,
        official_validation_outcome: observation.closeKind,
        evidence_paths: [paths.validationLogsDir],
      },
    });

    if (verdict.outcome === 'ACCEPT') {
      report.review = { ...report.review, outcome: 'ACCEPT', reason: verdict.reason };
      return { status: 'CONTINUE' };
    }
    const outcome = verdict.outcome === 'REJECT' ? 'REJECT' : verdict.code;
    const reason = verdict.reason;
    report.review = {
      ...report.review,
      outcome,
      reason,
    };
    return {
      status: 'HUMAN_REQUIRED',
      human_required: humanRequired(
        `project:${observation.taskId}:review`,
        'decidir sobre a mudança reprovada ou não revisável',
        `review independente não aceitou a mudança: ${reason}`,
        ['inspecionar o commit e a evidência', 'reabrir a task explicitamente'],
        [paths.validationLogsDir],
      ),
    };
  }

  async function onRepairExhausted(request: {
    readonly taskId: string;
    readonly reason: string;
  }): Promise<RepairExhaustedFollowUp> {
    const report = workUnits.at(-1);
    const { diagnosis, initialProfileId, evidencePaths } = await diagnoseExhaustedRepair(
      paths,
      request.taskId,
    );
    if (report !== undefined) report.diagnosis = diagnosis.classification;

    const followUp = resolveFailureFollowUp({
      diagnosis,
      incidentId: `project:${request.taskId}:diagnosis`,
    });
    if (followUp.human_required !== null) {
      humanGate = followUp.human_required;
      return { status: 'HUMAN_REQUIRED', human_required: followUp.human_required };
    }
    if (!followUp.escalates || initialProfileId === null) {
      return { status: 'NOT_APPLICABLE', reason: followUp.rationale };
    }

    if (ladderSteps.length < 2) {
      const output = humanRequired(
        `project:${request.taskId}:escalation`,
        'autorizar explicitamente um profile adicional para escalar',
        `diagnosis CAPABILITY exige escalation, mas a policy ${authorization.profile_policy.id} declara um único profile elegível`,
        [
          'declarar outro profile na profile_policy',
          'aceitar o resultado do profile fixado pelo experimento',
        ],
        [...evidencePaths, input.authorizationFile],
      );
      if (report !== undefined) report.escalation = 'HUMAN_REQUIRED';
      return { status: 'HUMAN_REQUIRED', human_required: output };
    }

    const ladder: EscalationLadder = {
      schema_version: 1,
      ordering: 'CONFIGURED_CAPABILITY_ASCENDING',
      ordering_rationale: `ranks declarados em profile_policy ${authorization.profile_policy.id}`,
      steps: ladderSteps.map((entry) => ({
        profile_id: entry.id,
        capability_rank: entry.capability_rank,
        rationale: entry.rationale,
      })),
    };
    const executionPolicy: EscalationExecutionPolicy = {
      schema_version: 1,
      authorization_scope: scope,
      allowed_profile_ids: ladderSteps.map((entry) => entry.id),
      allowed_providers: [...authorization.profile_policy.allowed_providers],
      authorized_billing_modes: [...authorization.billing.allowed_billing_modes],
      evidence_paths: [input.authorizationFile],
      provenance: 'project_execution_policy',
    };

    const preflights: EscalationCandidatePreflight[] = [];
    for (const entry of ladderSteps) {
      const candidate = profiles.get(entry.id);
      if (candidate === undefined) continue;
      preflights.push(await escalationPreflight(paths, candidate));
    }

    const escalation = decideEscalation({
      diagnosis,
      repair_sequence: {
        initial: {
          attempt_role: AttemptRole.INITIAL,
          profile_id: initialProfileId,
          evaluation_outcome: 'FAIL',
          evidence_paths: [evidencePaths[0] as string],
        },
        repair: {
          attempt_role: AttemptRole.REPAIR,
          profile_id: initialProfileId,
          evaluation_outcome: 'FAIL',
          retry_budget: 1,
          authorization_provenance: 'automatic-repair policy do harness',
          evidence_paths: [evidencePaths[1] as string],
        },
      },
      ladder,
      capability_registry: registry,
      execution_policy: executionPolicy,
      prior_authorizations: priorAuthorizations,
      candidate_preflights: preflights,
    });

    if (escalation.outcome !== 'ESCALATE') {
      const output =
        escalation.human_required === null
          ? humanRequired(
              `project:${request.taskId}:escalation`,
              'decidir manualmente o próximo passo da task bloqueada',
              `escalation não autorizada: ${escalation.classification}`,
              ['inspecionar a evidência preservada'],
              [...evidencePaths],
            )
          : toHumanRequiredOutput(escalation.human_required, `project:${request.taskId}:escalation`);
      humanGate = output;
      if (report !== undefined) report.escalation = 'HUMAN_REQUIRED';
      return { status: 'HUMAN_REQUIRED', human_required: output };
    }

    // O control plane reabre a task pela primitive OFICIAL — a mesma que o
    // `dev-retry-failed` humano usa. A diferença é só a autorização: aqui ela
    // vem da ladder configurada, e não de um gate humano por spawn.
    await retryFailedAttempt({
      paths,
      taskId: request.taskId,
      reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
      reason:
        `escalation autorizada pelo control plane: ${escalation.authorization.from_profile_id} -> ` +
        `${escalation.authorization.to_profile_id} (degrau ${escalation.authorization.step_index} da ladder configurada)`,
    });

    priorAuthorizations.push(escalation.authorization);
    escalatedProfileByTask.set(request.taskId, escalation.authorization.to_profile_id);
    escalations.push({
      task_id: request.taskId,
      from_profile_id: escalation.authorization.from_profile_id,
      to_profile_id: escalation.authorization.to_profile_id,
      cross_provider: escalation.authorization.cross_provider,
      step_index: escalation.authorization.step_index,
      decision_owner: escalation.authorization.decision_owner,
    });
    if (report !== undefined) report.escalation = escalation.authorization.to_profile_id;
    return { status: 'ESCALATED', profile_id: escalation.authorization.to_profile_id };
  }

  return {
    kind: 'project_lifecycle',
    beforeWorkUnit,
    afterWorkUnit,
    onRepairExhausted,
    snapshot(): ProjectLifecycleReport {
      return {
        schema_version: PROJECT_RUN_SCHEMA_VERSION,
        mode: 'PROJECT_LIFECYCLE',
        authorization_file: input.authorizationFile,
        profile_policy_id: authorization.profile_policy.id,
        eligible_profile_ids: [...profiles.keys()],
        autonomous_execution_boundary: [...authorization.autonomous_execution_boundary],
        human_gated_capabilities: [...authorization.human_gated_capabilities],
        work_units: workUnits.map((unit) => ({ ...unit })),
        escalations: [...escalations],
        human_gate: humanGate,
      };
    },
  };
}

/**
 * Evidência de preflight de um degrau da ladder. Vem do MESMO
 * `runBillingPreflight` que o launcher usa — nenhum fato é inventado, e quota
 * permanece desconhecida porque não é probada antes do launch (desconhecido
 * não bloqueia por si só, mas também nunca vira "suficiente").
 */
async function escalationPreflight(
  paths: HarnessPaths,
  profile: LauncherProfile,
): Promise<EscalationCandidatePreflight> {
  const home = path.join(paths.devDir, 'project', 'homes', profile.id);
  const env = buildEnvironment(profile, process.env, { sanitizedHome: home });
  assertNoApiCredentials(`preflight de escalation de ${profile.id}`, env);
  const billing = await runBillingPreflight({
    agent: profile.agent,
    billingMode: profile.billing_mode,
    binary: profile.argv[0] as string,
    env,
    orchestratorEnv: process.env,
  });
  const credentialKnown =
    profile.agent === 'fake' ? true : billing.credential.verified;
  return {
    profile_id: profile.id,
    provider_availability: {
      value: billing.ok,
      provenance: `runBillingPreflight(${profile.id}): ${billing.refusal ?? 'sem recusa'}`,
    },
    credential_availability: {
      value: credentialKnown,
      provenance: `${billing.credential.source}: ${billing.credential.detail}`,
    },
    real_execution_authorization: {
      authorization: {
        value: billing.ok ? 'AUTHORIZED' : 'DENIED',
        provenance: 'runBillingPreflight do harness',
      },
      billing_mode: {
        value: profile.billing_mode === 'subscription_only' ? 'SUBSCRIPTION' : 'NO_CHARGE',
        provenance: 'launcher_profile.billing_mode',
      },
      quota: {
        availability: { value: null, provenance: 'quota não é probada antes do launch' },
        remaining: { value: null, provenance: 'quota não é probada antes do launch' },
        unit: null,
      },
      cost: {
        api_equivalent_usd: { value: null, provenance: 'nenhuma cobrança projetada em assinatura' },
        projected_incremental_charge_usd: {
          value: null,
          provenance: 'nenhuma cobrança projetada em assinatura',
        },
        actual_incremental_charge_usd: { value: null, provenance: 'não observada' },
        actual_incremental_charge_authoritative: false,
      },
      budget: {
        maximum_incremental_charge_usd: {
          value: null,
          provenance: 'nenhum budget de cobrança em assinatura',
        },
      },
    },
  };
}

/** Reexportado para o CLI publicar o estado da task sem reabrir `state.ts`. */
export async function taskStatusOf(paths: HarnessPaths, taskId: string): Promise<string> {
  return getTaskState(await readState(paths), taskId).status;
}
