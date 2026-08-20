/**
 * Lifecycle universal de orquestração de projeto (M84).
 *
 * O lab passa a ser CONTROL PLANE de implementações reais reusando o
 * orquestrador que já existe: `selectNextTask`, `launch`, `close`, `recover`,
 * `state`, evidência, automatic repair e os guards continuam sendo os únicos
 * donos de lifecycle, DAG, estado autoritativo, routing, escalation, commit,
 * validação oficial e billing policy. Nada aqui reimplementa nenhum deles e
 * não existe executor paralelo — este módulo COMPÕE os contratos puros de
 * `src/` com o runtime de `dev/`.
 *
 * Dois caminhos, distinguíveis por contrato:
 *
 * - DIRECT — preflight factual mínimo (repo/base revision, git state,
 *   readiness, validation, instruções, source anchors), Direct Task
 *   Normalization de M75, route, budget adaptativo, implementer fresco,
 *   validação determinística e review só quando a policy exigir. Nunca opera
 *   sobre fato ausente ou inválido: os fatos vêm de uma `ProjectInspection`
 *   válida (cacheada ou coleta mínima read-only) e, se a confiança for
 *   insuficiente, o resultado é `REVIEWED_REQUIRED` — jamais uma task
 *   inventada.
 * - REVIEWED — intake, inspeção read-only, planning worker read-only pela
 *   porta adaptada, draft não confiável, normalização/validação determinística
 *   e assessment, tudo já implementado por `generateImplementationPlan`.
 *
 * ESTA é a única task com provider wiring: o adapter real da
 * `PlanningWorkerPort` de M83 para Claude/Codex e o adapter das decisões de
 * M79 para o `HumanRequiredOutput` do harness vivem aqui e somente aqui. O
 * caminho de provider real existe, mas nasce DESLIGADO: só um
 * `ExecutionAuthorizationScope` no nível do projeto/run o habilita, e todo
 * launch ainda passa por escopo, billing, quota, credencial, risco e execution
 * policy. Dry-run e preflight nunca chamam provider.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  authorizeExecutionAction,
  ExecutionAuthorizationScope,
  ProjectIntakeRequest,
  type AutonomousExecutionCapability,
  type ExecutionAuthorizationDecision,
  type HumanGatedCapability,
} from '../../src/intake/index.js';
import { ProjectInspection } from '../../src/inspection/index.js';
import {
  assessExecution,
  type DiversityRequirement,
  type EnvironmentReadinessAssessment,
  type ExecutionAssessment,
  type ReviewRequirementAssessment,
} from '../../src/planner/assess.js';
import type {
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  PlanningWorkerPort,
} from '../../src/planner/draft.js';
import {
  generateImplementationPlan,
  type ImplementationPlan,
  type PlanGenerationStage,
} from '../../src/planner/generate.js';
import { PlannedTask, type TaskRisk } from '../../src/planner/task.js';
import {
  evaluatePlanWorkflow,
  normalizeDirectTask,
  type DirectTaskClassification,
  type MinimalFactualPreflightSource,
  type TaskWorkflowVerdict,
} from '../../src/planner/validate.js';
import {
  comparableRunFactsFromEvidence,
  COMPARABLE_RUN_FACTS_FILE_NAME,
  type ComparableRunFacts,
  type ComparableRunFactsEvidence,
} from '../../src/performance/comparable-run.js';
import {
  decideFailureIntervention,
  type FailureDiagnosis,
  type FailureInterventionAction,
  type HumanInterventionDecision,
} from '../../src/routing/diagnosis.js';
import { writeJsonOnce } from './atomic.js';
import { assertNoApiCredentials, runBillingPreflight } from './billing.js';
import { buildTimeoutArgv } from './exec.js';
import type { HarnessPaths } from './paths.js';
import { buildEnvironment, resolveProfileArgv, type LauncherProfile } from './profile.js';
import {
  assertReadOnlyArgv,
  buildRoleArgv,
  resolveWorkerRuntimeBudget,
  type ProjectWorkerRole,
  type WorkerRuntimeBudgetResolution,
} from './project-roles.js';
import type { HumanRequiredOutput } from './routine-autonomy.js';

export const PROJECT_LIFECYCLE_SCHEMA_VERSION = 1;

/** O caminho de provider real NASCE desligado; só o escopo autorizado o liga. */
export const PROVIDER_PATH_ENABLED_BY_DEFAULT = false;

// ---------------------------------------------------------------------------
// Gate de launch — autorização de ESCOPO, verificada a cada launch.
// ---------------------------------------------------------------------------

export interface ProjectLaunchCheck {
  readonly name: string;
  readonly decision: ExecutionAuthorizationDecision;
  readonly reason: string;
}

export interface ProjectLaunchContext {
  readonly scope: ExecutionAuthorizationScope;
  /** A capability autônoma que ESTE launch exerce (worker novo, repair, escalation...). */
  readonly capability: AutonomousExecutionCapability;
  /** Categorias human-gated que a ação implica de fato; `requested_scope` nunca as cobre. */
  readonly implied_human_gated?: readonly HumanGatedCapability[];
  readonly billing_mode: LauncherProfile['billing_mode'];
  readonly quota_available: boolean;
  readonly credential_proved: boolean;
  readonly risk: TaskRisk;
  readonly worker_owns_commit: boolean;
  readonly worker_owns_official_validation: boolean;
}

export type ProjectLaunchAuthorization =
  | { readonly outcome: 'ALLOW'; readonly checks: readonly ProjectLaunchCheck[] }
  | {
      readonly outcome: 'HUMAN_REQUIRED';
      readonly checks: readonly ProjectLaunchCheck[];
      readonly gated_capability: HumanGatedCapability | null;
      readonly reason: string;
    };

/**
 * A autorização é de ESCOPO, não por spawn: worker novo, bounded repair,
 * effort dentro da ladder autorizada e troca Claude/Codex dentro da execution
 * policy são capabilities autônomas — se estiverem no boundary do projeto/run,
 * o launch é `ALLOW` automático, sem novo gate humano. Fora do boundary, ou
 * em qualquer categoria human-gated implicada pela ação, é `HUMAN_REQUIRED`.
 */
export function authorizeProjectLaunch(context: ProjectLaunchContext): ProjectLaunchAuthorization {
  const checks: ProjectLaunchCheck[] = [];
  const deny = (
    name: string,
    reason: string,
    gated: HumanGatedCapability | null,
  ): ProjectLaunchAuthorization => {
    checks.push({ name, decision: 'HUMAN_REQUIRED', reason });
    return { outcome: 'HUMAN_REQUIRED', checks, gated_capability: gated, reason };
  };

  const scopeDecision = authorizeExecutionAction(context.scope, {
    kind: 'autonomous',
    capability: context.capability,
  });
  if (scopeDecision === 'HUMAN_REQUIRED') {
    return deny(
      'scope',
      `capability ${context.capability} fora do autonomous_execution_boundary autorizado`,
      'SCOPE_EXPANSION',
    );
  }
  checks.push({
    name: 'scope',
    decision: 'ALLOWED',
    reason: `capability ${context.capability} dentro do boundary autorizado`,
  });

  for (const gated of context.implied_human_gated ?? []) {
    return deny(
      'implied_human_gated',
      `ação implica ${gated}; requested_scope não autoriza esta categoria`,
      gated,
    );
  }
  checks.push({
    name: 'implied_human_gated',
    decision: 'ALLOWED',
    reason: 'nenhuma categoria human-gated implicada pela ação',
  });

  if (context.billing_mode === 'api') {
    return deny('billing', 'cobrança por API exige autorização humana explícita', 'UNAUTHORIZED_API_BILLING');
  }
  checks.push({ name: 'billing', decision: 'ALLOWED', reason: `billing_mode=${context.billing_mode}` });

  if (!context.quota_available) {
    return deny('quota', 'quota da assinatura indisponível para este launch', null);
  }
  checks.push({ name: 'quota', decision: 'ALLOWED', reason: 'quota disponível' });

  if (!context.credential_proved) {
    return deny(
      'credentials',
      'credencial não provada antes do launch',
      'NEW_CREDENTIAL_BOUNDARY',
    );
  }
  checks.push({ name: 'credentials', decision: 'ALLOWED', reason: 'credencial provada antes do launch' });

  if (context.risk === 'critical') {
    return deny('risk', 'risco crítico ou security-sensitive', 'CRITICAL_OR_SECURITY_SENSITIVE_ACTION');
  }
  checks.push({ name: 'risk', decision: 'ALLOWED', reason: `risk=${context.risk}` });

  if (context.worker_owns_commit || context.worker_owns_official_validation) {
    return deny(
      'execution_policy',
      'worker com ownership de commit ou de validação oficial está fora da execution policy do lifecycle',
      'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
    );
  }
  checks.push({
    name: 'execution_policy',
    decision: 'ALLOWED',
    reason: 'commit e validação oficial pertencem ao orquestrador',
  });

  return { outcome: 'ALLOW', checks };
}

// ---------------------------------------------------------------------------
// Verdict de plano (M75) + review requirement (M76), pelo critério mais restritivo.
// ---------------------------------------------------------------------------

export type ProjectLifecyclePathName = 'DIRECT' | 'REVIEWED';

export interface ProjectWorkflowDecision {
  readonly path: ProjectLifecyclePathName;
  readonly review_required: boolean;
  readonly diversity_requirement: DiversityRequirement;
  readonly workflow: TaskWorkflowVerdict;
  readonly review_requirement: ReviewRequirementAssessment;
  readonly rationale: readonly string[];
}

/**
 * Os dois vereditos são independentes e nenhum relaxa o outro: o caminho só é
 * DIRECT quando M75 diz `DIRECT_ALLOWED`, e a review passa a ser exigida se
 * QUALQUER um dos dois a exigir. Combinação pelo critério mais restritivo.
 */
export function combineWorkflowAndReview(
  workflow: TaskWorkflowVerdict,
  reviewRequirement: ReviewRequirementAssessment,
): ProjectWorkflowDecision {
  const directAllowed = workflow.outcome === 'DIRECT_ALLOWED';
  const reviewRequired = !directAllowed || reviewRequirement.independent_review_required;
  return {
    path: directAllowed ? 'DIRECT' : 'REVIEWED',
    review_required: reviewRequired,
    diversity_requirement: reviewRequirement.diversity_requirement,
    workflow,
    review_requirement: reviewRequirement,
    rationale: [
      `workflow=${workflow.outcome}`,
      `independent_review_required=${reviewRequirement.independent_review_required}`,
      `diversity_requirement=${reviewRequirement.diversity_requirement}`,
      'critério mais restritivo entre verdict de plano e review requirement',
    ],
  };
}

// ---------------------------------------------------------------------------
// Environment readiness ANTES de culpar capacidade.
// ---------------------------------------------------------------------------

export type EnvironmentReadinessGate =
  | { readonly outcome: 'READY' }
  | {
      readonly outcome: 'ENVIRONMENT_NOT_READY' | 'ENVIRONMENT_UNKNOWN';
      readonly reason: string;
      readonly unsatisfied: readonly string[];
    };

/**
 * Ambiente não pronto nunca vira diagnóstico de capacidade: é remediação de
 * ambiente. Esta função é consultada antes de qualquer escalation.
 */
export function evaluateEnvironmentReadiness(
  readiness: EnvironmentReadinessAssessment,
): EnvironmentReadinessGate {
  if (readiness.status === 'READY') return { outcome: 'READY' };
  const unsatisfied = readiness.checks
    .filter((check) => check.status !== 'satisfied')
    .map((check) => `${check.requirement}=${check.status}`);
  return {
    outcome: readiness.status === 'NOT_READY' ? 'ENVIRONMENT_NOT_READY' : 'ENVIRONMENT_UNKNOWN',
    reason: readiness.rationale,
    unsatisfied,
  };
}

// ---------------------------------------------------------------------------
// Caminho DIRECT.
// ---------------------------------------------------------------------------

export const DIRECT_PATH_SKIPPED_STAGES = [
  'broad_exploration',
  'planning_worker',
  'redundant_review',
] as const;

/**
 * Fatos de taxonomy OBSERVADOS no preflight e declarados por quem chama, com
 * proveniência obrigatória. `normalizeDirectTask` deixa estes campos omitidos
 * de propósito — presumi-los favoráveis dentro da normalization seria inventar
 * baixo risco. Aqui eles só entram acompanhados da fonte; ausentes, os
 * critérios de M75 permanecem `unknown` e o caminho vira REVIEWED.
 */
export interface ObservedTaxonomyFacts {
  readonly facts: {
    readonly complexity?: NonNullable<PlannedTask['taxonomy']['complexity']>;
    readonly ambiguity?: NonNullable<PlannedTask['taxonomy']['ambiguity']>;
    readonly verification?: NonNullable<PlannedTask['taxonomy']['verification']>;
  };
  readonly provenance: string;
}

export interface DirectPathInput {
  readonly taskId: string;
  readonly intake: unknown;
  readonly inspection: unknown;
  readonly authorizationScope: unknown;
  readonly classification: DirectTaskClassification;
  /** Proveniência dos fatos mínimos: inspeção cacheada ou coleta mínima read-only. */
  readonly minimalFactsSource?: MinimalFactualPreflightSource;
  /** Sem estes fatos declarados, DIRECT não é alcançável — fail safe, nunca otimista. */
  readonly observedTaxonomy?: ObservedTaxonomyFacts;
}

/**
 * Compõe a work unit normalizada com fatos que o PRÓPRIO preflight observou —
 * `initial_files` vem de `inspection.relevant_files`, `taxonomy` vem dos fatos
 * declarados com proveniência. Nenhum campo é preenchido por default: fato
 * ausente continua ausente, e a work unit resultante é reparseada contra
 * `PlannedTask`, de modo que enriquecimento inválido nunca vira task.
 */
function enrichWithObservedFacts(
  task: PlannedTask,
  inspection: ProjectInspection,
  observed: ObservedTaxonomyFacts | undefined,
): { readonly task: PlannedTask; readonly provenance: readonly string[] } | null {
  const provenance: string[] = [];
  const candidate: PlannedTask = {
    ...task,
    ...(inspection.relevant_files.length > 0
      ? { initial_files: [...inspection.relevant_files] }
      : {}),
    ...(observed === undefined
      ? {}
      : { taxonomy: { ...task.taxonomy, ...observed.facts } }),
  };
  if (inspection.relevant_files.length > 0) {
    provenance.push('initial_files=inspection.relevant_files');
  }
  if (observed !== undefined) provenance.push(`taxonomy=${observed.provenance}`);

  const parsed = PlannedTask.safeParse(candidate);
  return parsed.success ? { task: parsed.data, provenance } : null;
}

export interface DirectPathAccepted {
  readonly outcome: 'DIRECT';
  readonly task: PlannedTask;
  readonly assessment: ExecutionAssessment;
  readonly decision: ProjectWorkflowDecision;
  readonly environment: EnvironmentReadinessGate;
  readonly minimal_facts_source: MinimalFactualPreflightSource;
  readonly fact_provenance: readonly string[];
  readonly skipped_stages: readonly string[];
}

export type DirectPathResult =
  | DirectPathAccepted
  | { readonly outcome: 'REVIEWED_REQUIRED'; readonly reason: string };

/**
 * DIRECT nunca opera sobre fato ausente ou inválido: intake, inspection e
 * escopo são parseados estritamente e qualquer divergência encaminha para
 * REVIEWED em vez de completar o que falta por conta própria. A work unit vem
 * da Direct Task Normalization de M75 — se ela não conseguir compor uma
 * `PlannedTask` a partir de fatos observados, o resultado é
 * `REVIEWED_REQUIRED`, nunca uma task inventada.
 */
export function runDirectPath(input: DirectPathInput): DirectPathResult {
  const intake = ProjectIntakeRequest.safeParse(input.intake);
  const inspection = ProjectInspection.safeParse(input.inspection);
  const scope = ExecutionAuthorizationScope.safeParse(input.authorizationScope);
  if (!intake.success || !inspection.success || !scope.success) {
    return {
      outcome: 'REVIEWED_REQUIRED',
      reason:
        'fatos do preflight ausentes ou inválidos (intake, inspection ou authorization scope não satisfazem o contrato)',
    };
  }
  if (scope.data.requested_scope.summary !== intake.data.requested_scope.summary) {
    return {
      outcome: 'REVIEWED_REQUIRED',
      reason: 'authorization_scope.requested_scope diverge do intake — escopo pedido não é fato confirmado',
    };
  }

  const normalized = normalizeDirectTask({
    taskId: input.taskId,
    intake: intake.data,
    requestedScope: intake.data.requested_scope,
    inspection: inspection.data,
    classification: input.classification,
  });
  if (normalized.outcome === 'REVIEWED_REQUIRED') {
    return { outcome: 'REVIEWED_REQUIRED', reason: normalized.reason };
  }

  const enriched = enrichWithObservedFacts(normalized.task, inspection.data, input.observedTaxonomy);
  if (enriched === null) {
    return {
      outcome: 'REVIEWED_REQUIRED',
      reason: 'fatos observados não compõem uma PlannedTask válida — confiança insuficiente para o caminho direto',
    };
  }
  const workUnit = enriched.task;

  const assessment = assessExecution(workUnit, {
    inspection: inspection.data,
    expectedBaseRevisionSha: intake.data.base_revision.sha,
    factsSource: 'minimal_preflight',
  });
  const minimalFactsSource = input.minimalFactsSource ?? 'cached_inspection';
  const [workflow] = evaluatePlanWorkflow([workUnit], {
    inspection: inspection.data,
    intake: intake.data,
    minimalFactsSource,
  });
  if (workflow === undefined) {
    return { outcome: 'REVIEWED_REQUIRED', reason: 'workflow não pôde ser avaliado para a work unit normalizada' };
  }

  const decision = combineWorkflowAndReview(workflow, assessment.review_requirement);
  if (decision.path !== 'DIRECT') {
    const reason =
      workflow.outcome === 'REVIEWED_REQUIRED'
        ? workflow.reason
        : `verdict de workflow ${workflow.outcome} impede o caminho direto`;
    return { outcome: 'REVIEWED_REQUIRED', reason };
  }

  return {
    outcome: 'DIRECT',
    task: workUnit,
    assessment,
    decision,
    environment: evaluateEnvironmentReadiness(assessment.environment_readiness),
    minimal_facts_source: minimalFactsSource,
    fact_provenance: [
      `direct_task_normalization:${normalized.task.task_id}`,
      `minimal_factual_preflight:${minimalFactsSource}`,
      ...enriched.provenance,
    ],
    skipped_stages: decision.review_required
      ? DIRECT_PATH_SKIPPED_STAGES.filter((stage) => stage !== 'redundant_review')
      : [...DIRECT_PATH_SKIPPED_STAGES],
  };
}

// ---------------------------------------------------------------------------
// Caminho REVIEWED.
// ---------------------------------------------------------------------------

export interface ReviewedPathInput {
  readonly intake: unknown;
  readonly inspection: unknown;
  readonly authorizationScope: unknown;
  /** Porta de M83; o adapter real Claude/Codex está mais abaixo neste módulo. */
  readonly planningWorker: PlanningWorkerPort;
}

export type ReviewedPathResult =
  | {
      readonly outcome: 'PLANNED';
      readonly plan: ImplementationPlan;
      readonly decisions: readonly ProjectWorkflowDecision[];
    }
  | {
      readonly outcome: 'DECOMPOSITION_REQUIRED';
      readonly stage: PlanGenerationStage;
      readonly issues: readonly string[];
    }
  | {
      readonly outcome: 'REJECTED';
      readonly stage: PlanGenerationStage;
      readonly issues: readonly string[];
    };

/**
 * Reusa o pipeline determinístico de M83 inteiro — normalização, AVC, plan
 * policy, dependências e risk/readiness — sem reabrir nenhum gate. Falha na
 * etapa de decomposição é FAIL-SAFE DE ESCOPO: vira `DECOMPOSITION_REQUIRED`
 * explícito, nunca PASS parcial nem expansão silenciosa do plano.
 */
export async function runReviewedPath(input: ReviewedPathInput): Promise<ReviewedPathResult> {
  const generated = await generateImplementationPlan({
    intake: input.intake,
    inspection: input.inspection,
    authorizationScope: input.authorizationScope,
    planningWorker: input.planningWorker,
  });
  if (generated.outcome === 'REJECTED') {
    return generated.stage === 'AVC_DECOMPOSITION'
      ? { outcome: 'DECOMPOSITION_REQUIRED', stage: generated.stage, issues: generated.issues }
      : { outcome: 'REJECTED', stage: generated.stage, issues: generated.issues };
  }
  return {
    outcome: 'PLANNED',
    plan: generated.plan,
    decisions: generated.plan.tasks.map((entry) =>
      combineWorkflowAndReview(entry.workflow, entry.assessment.review_requirement),
    ),
  };
}

// ---------------------------------------------------------------------------
// Reviewer — contexto fresco universal, diversidade proporcional ao risco.
// ---------------------------------------------------------------------------

export interface ReviewerInvocationPolicy {
  readonly role: 'reviewer';
  readonly profile_id: string;
  readonly fresh_invocation: true;
  readonly shared_conversation: false;
  readonly workspace_access: 'READ_ONLY';
  readonly packet_bounded: true;
  readonly decision_format: 'SINGLE_JSON';
  readonly trusts_implementer_self_report: false;
  readonly diversity_requirement: DiversityRequirement;
  readonly diversity_satisfied: boolean;
  readonly rationale: string;
}

export type ReviewerInvocationPlan =
  | { readonly outcome: 'PLANNED'; readonly policy: ReviewerInvocationPolicy }
  | { readonly outcome: 'DIVERSITY_REQUIRED'; readonly reason: string };

/**
 * Contexto fresco é UNIVERSAL: nova invocação, read-only, packet bounded e uma
 * única decisão JSON, nunca derivada do self-report do implementer.
 * Diversidade de profile/model/provider é POLICY-BASED e proporcional ao
 * risco: em baixo/médio o mesmo profile pode revisar, desde que a invocação
 * seja independente; em crítico a policy pode exigir profile diferente.
 * Nenhuma review de modelo substitui os gates determinísticos.
 */
export function planReviewerInvocation(input: {
  readonly implementerProfileId: string;
  readonly reviewerProfileId: string;
  readonly diversityRequirement: DiversityRequirement;
}): ReviewerInvocationPlan {
  const different = input.reviewerProfileId !== input.implementerProfileId;
  if (input.diversityRequirement === 'required' && !different) {
    return {
      outcome: 'DIVERSITY_REQUIRED',
      reason: `policy exige diversidade de profile/model/provider para este risco; reviewer e implementer usam ${input.reviewerProfileId}`,
    };
  }
  return {
    outcome: 'PLANNED',
    policy: {
      role: 'reviewer',
      profile_id: input.reviewerProfileId,
      fresh_invocation: true,
      shared_conversation: false,
      workspace_access: 'READ_ONLY',
      packet_bounded: true,
      decision_format: 'SINGLE_JSON',
      trusts_implementer_self_report: false,
      diversity_requirement: input.diversityRequirement,
      diversity_satisfied: different,
      rationale: different
        ? 'reviewer usa profile distinto do implementer'
        : 'mesmo profile com invocação e contexto independentes — permitido para este nível de risco',
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter M79 → HumanRequiredOutput real do harness.
// ---------------------------------------------------------------------------

/**
 * Adapter, não vocabulário paralelo: os campos puros de M79 entram verbatim no
 * `HumanRequiredOutput` que o harness já publica. `provenance` não tem campo
 * correspondente e por isso é anexada ao motivo — perder proveniência seria
 * perder a evidência de por que a automação parou.
 */
export function toHumanRequiredOutput(
  decision: HumanInterventionDecision,
  incidentId: string,
): HumanRequiredOutput {
  return {
    status: 'HUMAN_REQUIRED',
    incident_id: incidentId,
    decision_needed: decision.decision_needed,
    why_automation_stopped: `${decision.why_automation_stopped} (classification=${decision.classification}; provenance: ${decision.provenance.join(', ')})`,
    options: [...decision.options],
    evidence_paths: [...decision.evidence_paths],
  };
}

export interface ProjectFailureFollowUp {
  readonly classification: FailureDiagnosis['classification'];
  readonly action: FailureInterventionAction | 'NONE';
  /** Somente CAPABILITY fica elegível à ladder de escalation. */
  readonly escalates: boolean;
  readonly human_required: HumanRequiredOutput | null;
  readonly rationale: string;
}

/**
 * Consultada DEPOIS do bounded repair esgotado. Environment readiness é
 * aplicada antes de culpar capacidade: com ambiente não pronto, mesmo um
 * diagnóstico de CAPABILITY é redirecionado para remediação de ambiente e
 * não consome degrau de escalation.
 */
export function resolveFailureFollowUp(input: {
  readonly diagnosis: FailureDiagnosis;
  readonly incidentId: string;
  readonly environment?: EnvironmentReadinessGate;
  readonly harnessRemediationAvailable?: boolean;
}): ProjectFailureFollowUp {
  const environment = input.environment;
  if (environment && environment.outcome === 'ENVIRONMENT_NOT_READY') {
    return {
      classification: input.diagnosis.classification,
      action: 'REMEDIATE_ENVIRONMENT',
      escalates: false,
      human_required: null,
      rationale: `environment readiness aplicada antes de capacidade: ${environment.reason}`,
    };
  }

  const decision = decideFailureIntervention(input.diagnosis, {
    ...(input.harnessRemediationAvailable === undefined
      ? {}
      : { harness_remediation_available: input.harnessRemediationAvailable }),
  });
  if (decision.status === 'HUMAN_REQUIRED') {
    return {
      classification: decision.classification,
      action: 'NONE',
      escalates: false,
      human_required: toHumanRequiredOutput(decision.human_required, input.incidentId),
      rationale: decision.rationale,
    };
  }
  return {
    classification: decision.classification,
    action: decision.action,
    escalates: decision.action === 'ESCALATION_ELIGIBLE',
    human_required: null,
    rationale: decision.rationale,
  };
}

// ---------------------------------------------------------------------------
// Evidence recording path — writer dos ComparableRunFacts (contrato de M81).
// ---------------------------------------------------------------------------

export type ComparableRunFactsRecording =
  | { readonly outcome: 'RECORDED'; readonly file: string; readonly facts: ComparableRunFacts }
  | { readonly outcome: 'ALREADY_RECORDED'; readonly file: string };

/**
 * O lifecycle é o WRITER dos `ComparableRunFacts`; M81 só lê depois. Consome o
 * contrato de M81 diretamente (`comparableRunFactsFromEvidence`) — nenhum
 * schema paralelo nasce em `dev/`. A escrita é ADITIVA: `writeJsonOnce` publica
 * uma vez e recusa divergência, então um run já gravado nunca é reescrito e
 * runs históricos nunca ganham evidência retroativa.
 */
export async function recordComparableRunFacts(input: {
  /** Diretório `execution/` do run novo — exatamente onde M81 procura o artifact. */
  readonly executionDir: string;
  readonly evidence: ComparableRunFactsEvidence;
}): Promise<ComparableRunFactsRecording> {
  const file = path.join(input.executionDir, COMPARABLE_RUN_FACTS_FILE_NAME);
  const facts = comparableRunFactsFromEvidence(input.evidence);
  try {
    await writeJsonOnce(file, facts);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('artifact append-only diverge')) {
      return { outcome: 'ALREADY_RECORDED', file };
    }
    throw error;
  }
  return { outcome: 'RECORDED', file, facts };
}

// ---------------------------------------------------------------------------
// Adapter real da PlanningWorkerPort (M83) para Claude/Codex.
// ---------------------------------------------------------------------------

export interface ProviderRoleInvocationInput {
  readonly role: ProjectWorkerRole;
  readonly profile: LauncherProfile;
  readonly argv: readonly string[];
  readonly prompt: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutSeconds: number;
}

/** Execução do processo fresco; injetável para provar o wiring sem chamar provider. */
export interface ProviderRoleInvocationPort {
  run(input: ProviderRoleInvocationInput): Promise<string>;
}

export interface LaunchedPlanningWorkerOptions {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  readonly scope: ExecutionAuthorizationScope;
  /** Default `false`: o caminho de provider real existe, mas nasce desligado. */
  readonly providerEnabled?: boolean;
  /** Default `true`: dry-run/preflight jamais chama provider. */
  readonly dryRun?: boolean;
  readonly credentialProved: boolean;
  readonly quotaAvailable: boolean;
  /** Budget de runtime do worker, derivado por policy; validado só contra o bound de runtime. */
  readonly workerRuntimeBudgetMs: number;
  readonly port?: ProviderRoleInvocationPort;
  readonly invocationId?: string;
}

function invocationFailure(
  options: LaunchedPlanningWorkerOptions,
  invocationId: string,
  code: string,
  message: string,
  retryable: boolean,
): PlanningWorkerInvocationResult {
  return {
    outcome: 'INVOCATION_FAILED',
    invocation_id: invocationId,
    provider_id: options.profile.agent,
    model: options.profile.id,
    failure: { code, message, retryable },
  };
}

/**
 * Recursos relativos do argv (fixtures, settings versionadas) pertencem ao
 * CATÁLOGO do harness, não ao repositório alvo. Sem esta resolução, um role
 * lançado sobre um alvo externo procuraria os arquivos do profile dentro do
 * alvo. Quando catálogo e cwd coincidem (uso histórico), o argv não muda.
 */
function catalogResolvedProfile(paths: HarnessPaths, profile: LauncherProfile): LauncherProfile {
  return {
    ...profile,
    argv: resolveProfileArgv(profile.argv, {
      catalogRoot: paths.profileCatalogRoot,
      workerCwd: paths.repoRoot,
    }),
  };
}

/** O packet do planner vira o prompt bounded — fatos derivados, nunca transcript. */
export function buildPlannerPrompt(invocation: PlanningWorkerInvocation): string {
  return [
    'Você é um PLANNING WORKER READ-ONLY do control plane.',
    'Não edite arquivos, não faça commit, não execute validação oficial e não chame outro agente.',
    'Sua saída é um UNTRUSTED DRAFT: ela passa por normalização e validação determinística antes de virar plano.',
    'Não altere plan policy, acceptance contract, routing policy, safety boundaries nem estado autorizado.',
    '',
    'PLANNER PACKET (JSON):',
    JSON.stringify(invocation.packet, null, 2),
    '',
    'Responda SOMENTE com um único JSON {"schema_version":1,"tasks":[...]}.',
  ].join('\n');
}

/**
 * Adapter REAL da porta de M83 para Claude/Codex: role read-only estrutural,
 * processo fresco, ambiente derivado do profile, prova de credencial e guarda
 * de cobrança antes de cada launch. O provider só é chamado quando o escopo do
 * projeto/run habilita o caminho real E o modo não é dry-run — caso contrário
 * a invocação falha de forma explícita, nunca em silêncio.
 */
export function createLaunchedPlanningWorker(
  options: LaunchedPlanningWorkerOptions,
): PlanningWorkerPort {
  const invocationId = options.invocationId ?? `planner-${options.profile.id}`;
  return {
    async invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult> {
      if (invocation.role !== 'READ_ONLY_PLANNER' || invocation.workspace_access !== 'READ_ONLY') {
        return invocationFailure(
          options,
          invocationId,
          'PLANNER_ROLE_CONTRACT_VIOLATED',
          'invocação de planning worker precisa ser READ_ONLY_PLANNER com workspace_access READ_ONLY',
          false,
        );
      }

      const authorization = authorizeProjectLaunch({
        scope: options.scope,
        capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
        billing_mode: options.profile.billing_mode,
        quota_available: options.quotaAvailable,
        credential_proved: options.credentialProved,
        risk: 'low',
        worker_owns_commit: options.profile.commit_owner !== 'orchestrator',
        worker_owns_official_validation: options.profile.official_validation_owner !== 'orchestrator',
      });
      if (authorization.outcome === 'HUMAN_REQUIRED') {
        return invocationFailure(
          options,
          invocationId,
          'PLANNING_LAUNCH_HUMAN_REQUIRED',
          authorization.reason,
          false,
        );
      }

      const budget = resolveWorkerRuntimeBudget({
        profile: options.profile,
        budgetMs: options.workerRuntimeBudgetMs,
      });
      if (budget.outcome === 'BUDGET_UNSUPPORTED') {
        return invocationFailure(options, invocationId, 'BUDGET_UNSUPPORTED', budget.reason, false);
      }

      const overlay = buildRoleArgv(catalogResolvedProfile(options.paths, options.profile), {
        role: 'planner',
        prompt: buildPlannerPrompt(invocation),
      });
      assertReadOnlyArgv('planner', options.profile.agent, overlay.argv);

      if (!(options.providerEnabled ?? PROVIDER_PATH_ENABLED_BY_DEFAULT)) {
        return invocationFailure(
          options,
          invocationId,
          'PROVIDER_PATH_DISABLED',
          'caminho de provider real desligado por default; habilite pelo ExecutionAuthorizationScope do projeto/run',
          false,
        );
      }
      if (options.dryRun ?? true) {
        return invocationFailure(
          options,
          invocationId,
          'DRY_RUN_NO_PROVIDER_CALL',
          'dry-run/preflight não chama provider',
          false,
        );
      }

      const port = options.port;
      if (port === undefined) {
        return invocationFailure(
          options,
          invocationId,
          'PROVIDER_PORT_NOT_CONFIGURED',
          'nenhuma porta de invocação de processo configurada para o caminho real',
          false,
        );
      }

      const home = path.join(options.paths.devDir, 'project', 'homes', options.profile.id);
      await mkdir(home, { recursive: true });
      const env = buildEnvironment(options.profile, process.env, { sanitizedHome: home });
      assertNoApiCredentials('ambiente do planning worker', env);
      const billing = await runBillingPreflight({
        agent: options.profile.agent,
        billingMode: options.profile.billing_mode,
        binary: options.profile.argv[0] as string,
        env,
        orchestratorEnv: process.env,
      });
      if (!billing.ok) {
        return invocationFailure(
          options,
          invocationId,
          'BILLING_PREFLIGHT_REFUSED',
          billing.refusal ?? 'motivo não informado',
          false,
        );
      }

      let stdout: string;
      try {
        stdout = await port.run({
          role: 'planner',
          profile: options.profile,
          argv: overlay.argv,
          prompt: buildPlannerPrompt(invocation),
          cwd: options.paths.repoRoot,
          env,
          timeoutSeconds: budget.timeout_seconds_override,
        });
      } catch (error) {
        return invocationFailure(
          options,
          invocationId,
          'PROVIDER_INVOCATION_FAILED',
          error instanceof Error ? error.message : String(error),
          true,
        );
      }

      const draft = extractJsonObject(stdout);
      if (draft === null) {
        return invocationFailure(
          options,
          invocationId,
          'DRAFT_NOT_PARSEABLE',
          'saída do planning worker não contém um único objeto JSON legível',
          false,
        );
      }
      return {
        outcome: 'DRAFT_RETURNED',
        invocation_id: invocationId,
        provider_id: options.profile.agent,
        model: options.profile.id,
        draft,
      };
    },
  };
}

/**
 * Processo NOVO por work unit, sem conversa compartilhada: o `timeout` externo
 * encerra o grupo, e o estado autoritativo continua em disco, independente da
 * sessão do modelo.
 */
export function createProviderRoleInvocationPort(): ProviderRoleInvocationPort {
  return {
    run(input) {
      const [program, ...args] = buildTimeoutArgv([...input.argv], input.timeoutSeconds);
      return new Promise<string>((resolve, reject) => {
        const child = spawn(program as string, args, {
          cwd: input.cwd,
          env: input.env,
          stdio: [input.profile.prompt_delivery === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => {
          if (code !== 0) {
            reject(
              new Error(
                `${input.role} terminou com exit ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
              ),
            );
            return;
          }
          resolve(Buffer.concat(stdout).toString('utf8'));
        });
        if (input.profile.prompt_delivery === 'stdin') child.stdin?.end(input.prompt, 'utf8');
      });
    },
  };
}

/** Um único objeto JSON, sem reparo: saída ambígua é recusada, não corrigida. */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const parsers: string[] = [];
  if (trimmed !== '') parsers.push(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/i);
  if (fenced?.[1]) parsers.push(fenced[1]);
  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced?.[0]) parsers.push(braced[0]);
  for (const candidate of parsers) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Invocação real do reviewer — mesmos guards do planning worker.
// ---------------------------------------------------------------------------

/** Fatos derivados que o reviewer recebe. Nunca transcript, nunca self-report. */
export interface ProjectReviewPacket {
  readonly task_id: string;
  readonly objective: string;
  readonly acceptance: readonly string[];
  readonly validation: readonly { readonly argv: readonly string[] }[];
  readonly changed_files: readonly string[];
  readonly candidate_sha: string | null;
  readonly official_validation_outcome: string;
  readonly evidence_paths: readonly string[];
}

export function buildReviewerPrompt(packet: ProjectReviewPacket): string {
  return [
    'Você é o REVIEWER independente e SOMENTE LEITURA do control plane.',
    'Não edite arquivos, não faça commit, não execute validação oficial e não chame outro agente.',
    'Você NÃO confia no self-report do implementer: decida pela evidência abaixo e pelo repositório.',
    '',
    'REVIEW PACKET (JSON):',
    JSON.stringify(packet, null, 2),
    '',
    'Responda SOMENTE com um único JSON {"decision":"ACCEPT|REJECT","reason":"..."}.',
  ].join('\n');
}

export interface ProjectReviewerLaunchOptions {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  readonly scope: ExecutionAuthorizationScope;
  readonly implementerProfileId: string;
  readonly diversityRequirement: DiversityRequirement;
  readonly packet: ProjectReviewPacket;
  readonly risk: TaskRisk;
  readonly workerRuntimeBudgetMs: number;
  readonly quotaAvailable: boolean;
  readonly credentialProved: boolean;
  readonly port?: ProviderRoleInvocationPort;
}

interface ProjectReviewVerdict<Outcome extends 'ACCEPT' | 'REJECT'> {
  readonly outcome: Outcome;
  readonly reason: string;
  readonly policy: ReviewerInvocationPolicy;
  readonly argv: readonly string[];
}

export type ProjectReviewResult =
  | ProjectReviewVerdict<'ACCEPT'>
  | ProjectReviewVerdict<'REJECT'>
  | { readonly outcome: 'REVIEW_UNAVAILABLE'; readonly code: string; readonly reason: string };

function reviewUnavailable(code: string, reason: string): ProjectReviewResult {
  return { outcome: 'REVIEW_UNAVAILABLE', code, reason };
}

/**
 * Invocação NOVA, contexto fresco, read-only estrutural e uma única decisão
 * JSON. Reusa exatamente os mesmos guards do adapter de planning: escopo,
 * billing, quota, credencial, risco e execution policy. Saída ambígua não é
 * reparada — vira `REVIEW_UNAVAILABLE`, nunca um ACCEPT presumido.
 */
export async function launchProjectReviewer(
  options: ProjectReviewerLaunchOptions,
): Promise<ProjectReviewResult> {
  const plan = planReviewerInvocation({
    implementerProfileId: options.implementerProfileId,
    reviewerProfileId: options.profile.id,
    diversityRequirement: options.diversityRequirement,
  });
  if (plan.outcome === 'DIVERSITY_REQUIRED') {
    return reviewUnavailable('REVIEW_DIVERSITY_REQUIRED', plan.reason);
  }

  const authorization = authorizeProjectLaunch({
    scope: options.scope,
    capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
    billing_mode: options.profile.billing_mode,
    quota_available: options.quotaAvailable,
    credential_proved: options.credentialProved,
    risk: options.risk,
    worker_owns_commit: options.profile.commit_owner !== 'orchestrator',
    worker_owns_official_validation: options.profile.official_validation_owner !== 'orchestrator',
  });
  if (authorization.outcome === 'HUMAN_REQUIRED') {
    return reviewUnavailable('REVIEW_LAUNCH_HUMAN_REQUIRED', authorization.reason);
  }

  const budget = resolveWorkerRuntimeBudget({
    profile: options.profile,
    budgetMs: options.workerRuntimeBudgetMs,
  });
  if (budget.outcome === 'BUDGET_UNSUPPORTED') {
    return reviewUnavailable('REVIEW_BUDGET_UNSUPPORTED', budget.reason);
  }

  const prompt = buildReviewerPrompt(options.packet);
  const overlay = buildRoleArgv(catalogResolvedProfile(options.paths, options.profile), {
    role: 'reviewer',
    prompt,
  });
  assertReadOnlyArgv('reviewer', options.profile.agent, overlay.argv);

  const home = path.join(options.paths.devDir, 'project', 'homes', options.profile.id);
  await mkdir(home, { recursive: true });
  const env = buildEnvironment(options.profile, process.env, { sanitizedHome: home });
  assertNoApiCredentials('ambiente do reviewer', env);
  const billing = await runBillingPreflight({
    agent: options.profile.agent,
    billingMode: options.profile.billing_mode,
    binary: options.profile.argv[0] as string,
    env,
    orchestratorEnv: process.env,
  });
  if (!billing.ok) {
    return reviewUnavailable(
      'REVIEW_BILLING_PREFLIGHT_REFUSED',
      billing.refusal ?? 'motivo não informado',
    );
  }

  const port = options.port ?? createProviderRoleInvocationPort();
  let stdout: string;
  try {
    stdout = await port.run({
      role: 'reviewer',
      profile: options.profile,
      argv: overlay.argv,
      prompt,
      cwd: options.paths.repoRoot,
      env,
      timeoutSeconds: budget.timeout_seconds_override,
    });
  } catch (error) {
    return reviewUnavailable(
      'REVIEW_INVOCATION_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }

  const parsed = extractJsonObject(stdout) as { decision?: unknown; reason?: unknown } | null;
  const decision = parsed?.decision;
  const reason = parsed?.reason;
  if ((decision !== 'ACCEPT' && decision !== 'REJECT') || typeof reason !== 'string' || reason.trim() === '') {
    return reviewUnavailable(
      'REVIEW_VERDICT_NOT_PARSEABLE',
      'saída do reviewer não contém um único JSON {"decision":"ACCEPT|REJECT","reason":"..."}',
    );
  }
  return { outcome: decision, reason: reason.trim(), policy: plan.policy, argv: overlay.argv };
}

// ---------------------------------------------------------------------------
// Vista consolidada, consumida pelo CLI.
// ---------------------------------------------------------------------------

export interface ProjectLifecyclePlan {
  readonly schema_version: typeof PROJECT_LIFECYCLE_SCHEMA_VERSION;
  readonly path: ProjectLifecyclePathName;
  readonly task_id: string;
  readonly review_required: boolean;
  readonly diversity_requirement: DiversityRequirement;
  readonly environment: EnvironmentReadinessGate;
  readonly worker_runtime_budget: WorkerRuntimeBudgetResolution;
  readonly launch_authorization: ProjectLaunchAuthorization;
  readonly skipped_stages: readonly string[];
  readonly rationale: readonly string[];
}

export interface ProjectLifecyclePlanInput extends DirectPathInput {
  readonly profile: LauncherProfile;
  readonly workerRuntimeBudgetMs: number;
  readonly quotaAvailable: boolean;
  readonly credentialProved: boolean;
}

export type ProjectLifecyclePlanResult =
  | { readonly outcome: 'PLANNED'; readonly plan: ProjectLifecyclePlan; readonly direct: DirectPathAccepted }
  | { readonly outcome: 'REVIEWED_REQUIRED'; readonly reason: string };

/**
 * Compõe o caminho DIRECT com budget e gate de launch numa vista única — é o
 * que o CLI publica em dry-run, sem tocar em provider, estado ou plano.
 */
export function planDirectLifecycle(input: ProjectLifecyclePlanInput): ProjectLifecyclePlanResult {
  const direct = runDirectPath(input);
  if (direct.outcome === 'REVIEWED_REQUIRED') return direct;

  const budget = resolveWorkerRuntimeBudget({
    profile: input.profile,
    budgetMs: input.workerRuntimeBudgetMs,
  });
  const authorization = authorizeProjectLaunch({
    scope: ExecutionAuthorizationScope.parse(input.authorizationScope),
    capability: 'CONFIGURED_SUBSCRIPTION_WORKER',
    billing_mode: input.profile.billing_mode,
    quota_available: input.quotaAvailable,
    credential_proved: input.credentialProved,
    risk: direct.assessment.risk.value,
    worker_owns_commit: input.profile.commit_owner !== 'orchestrator',
    worker_owns_official_validation: input.profile.official_validation_owner !== 'orchestrator',
  });

  return {
    outcome: 'PLANNED',
    direct,
    plan: {
      schema_version: PROJECT_LIFECYCLE_SCHEMA_VERSION,
      path: 'DIRECT',
      task_id: direct.task.task_id,
      review_required: direct.decision.review_required,
      diversity_requirement: direct.decision.diversity_requirement,
      environment: direct.environment,
      worker_runtime_budget: budget,
      launch_authorization: authorization,
      skipped_stages: direct.skipped_stages,
      rationale: direct.decision.rationale,
    },
  };
}
