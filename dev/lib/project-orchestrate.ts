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
  CandidateReviewCoverage,
  type HandoffConfidenceLevel,
} from './schemas.js';
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
import { claudeOutputFormat, providerTerminalFailure } from './claude-stream.js';
import { buildTimeoutArgv } from './exec.js';
import { evidenceOf, type LaunchFact, type LaunchFactEvidence } from './project-preflight.js';
import type { HarnessPaths } from './paths.js';
import { buildEnvironment, resolveProfileArgv, type LauncherProfile } from './profile.js';
import {
  assertReadOnlyArgv,
  buildRoleArgv,
  resolveWorkerRuntimeBudget,
  type ProjectWorkerRole,
  type RoleWorkspaceAccess,
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
  /**
   * Qualidade da evidência por trás do check. Um check pode ser `ALLOWED` com
   * evidência `UNKNOWN` — é exatamente o caso da quota, que não é probada
   * antes do launch. Separar as duas coisas impede que "não bloqueou" seja
   * lido depois como "foi provado".
   */
  readonly evidence?: LaunchFactEvidence;
  readonly provenance?: string;
}

export interface ProjectLaunchContext {
  readonly scope: ExecutionAuthorizationScope;
  /** A capability autônoma que ESTE launch exerce (worker novo, repair, escalation...). */
  readonly capability: AutonomousExecutionCapability;
  /** Categorias human-gated que a ação implica de fato; `requested_scope` nunca as cobre. */
  readonly implied_human_gated?: readonly HumanGatedCapability[];
  readonly billing_mode: LauncherProfile['billing_mode'];
  /**
   * Fatos tri-state com proveniência, coletados por
   * `collectProjectLaunchFacts`. Booleans foram removidos de propósito: eles
   * obrigavam o chamador a escolher entre `true` e `false` quando a verdade
   * era "não observado", e a escolha que destrava o progresso é sempre `true`.
   */
  readonly quota: LaunchFact;
  readonly credential: LaunchFact;
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

  // POLICY DE QUOTA DESCONHECIDA. Quota só é medida chamando o provider, e
  // medi-la antes de cada launch cobraria o experimento pelo direito de saber.
  // Desconhecida NÃO significa suficiente e NÃO significa insuficiente: o
  // launch segue, porque o provider é quem impõe rate limit e o fará no
  // próprio launch, mas o relatório nunca diz "quota disponível". Só evidência
  // POSITIVA de recusa por limite bloqueia aqui.
  if (context.quota.availability === false) {
    return deny(
      'quota',
      `quota da assinatura indisponível para este launch: ${context.quota.provenance}`,
      null,
    );
  }
  checks.push({
    name: 'quota',
    decision: 'ALLOWED',
    reason:
      context.quota.availability === true
        ? 'quota observada como suficiente'
        : 'quota não observada antes do launch; desconhecida não é suficiente nem insuficiente',
    evidence: evidenceOf(context.quota),
    provenance: context.quota.provenance,
  });

  // POLICY DE CREDENCIAL DESCONHECIDA. Aqui a assimetria é oposta à da quota:
  // a credencial É probável localmente e de graça, então não tê-la provado é
  // resultado de um probe que falhou, não de uma medição cara evitada. A
  // política de cobrança do laboratório já diz que ausência de prova positiva
  // recusa — desconhecida bloqueia, e nunca é promovida a provada.
  if (context.credential.availability !== true) {
    return deny(
      'credentials',
      context.credential.availability === false
        ? `credencial provada como incompatível com a policy: ${context.credential.provenance}`
        : `credencial não provada antes do launch: ${context.credential.provenance}`,
      'NEW_CREDENTIAL_BOUNDARY',
    );
  }
  checks.push({
    name: 'credentials',
    decision: 'ALLOWED',
    reason: 'credencial provada antes do launch',
    evidence: evidenceOf(context.credential),
    provenance: context.credential.provenance,
  });

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
 * Os dois vereditos continuam independentes, mas respondem a perguntas
 * diferentes e não são somados:
 *
 * - `workflow` (M75) classifica o CAMINHO da work unit. `REVIEWED_REQUIRED`
 *   significa "esta task não satisfaz todos os critérios históricos de
 *   DIRECT_ALLOWED" — o que é o caso normal de qualquer feature não trivial.
 *   Por si só isso NÃO justifica lançar um segundo LLM por work unit.
 * - `review_requirement` (M76) responde se há razão CONCRETA de risco para um
 *   reviewer independente: risco alto/crítico, evidência de verificação
 *   fraca, confiança baixa. É essa dimensão que decide a exigência.
 *
 * `escalatedReview` é a única entrada adicional: repair significativo e
 * escalation são fatos do lifecycle (não do plano nem do assessment) que
 * tornam o candidate concretamente mais arriscado.
 */
export function combineWorkflowAndReview(
  workflow: TaskWorkflowVerdict,
  reviewRequirement: ReviewRequirementAssessment,
  escalatedReview?: { readonly required: boolean; readonly reason: string },
): ProjectWorkflowDecision {
  const directAllowed = workflow.outcome === 'DIRECT_ALLOWED';
  const lifecycleReview = escalatedReview?.required === true;
  const reviewRequired = reviewRequirement.independent_review_required || lifecycleReview;
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
      ...(lifecycleReview ? [`lifecycle_review=${escalatedReview?.reason ?? 'exigida pelo lifecycle'}`] : []),
      'review independente é proporcional ao risco concreto; o caminho REVIEWED por si só não a exige',
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
  /** Fatos tri-state com proveniência; nunca booleans afirmados pelo chamador. */
  readonly credential: LaunchFact;
  readonly quota: LaunchFact;
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
 * Overlay de role pode reintroduzir tokens relativos (settings read-only).
 * Resolve DEPOIS do overlay: recursos do catálogo não são procurados no alvo.
 * Quando catálogo e cwd coincidem (uso histórico), o argv não muda.
 */
export function resolveRoleOverlayArgv(
  paths: HarnessPaths,
  overlayArgv: readonly string[],
): string[] {
  return resolveProfileArgv(overlayArgv, {
    catalogRoot: paths.profileCatalogRoot,
    workerCwd: paths.repoRoot,
  });
}

/**
 * Contrato de saída do planner, exposto COMPACTAMENTE no prompt.
 *
 * O gate de normalização é `PlannedTask.strict()` e continua estrito: nenhum
 * campo a mais, nenhum a menos, nenhum mapeamento heurístico entre a forma
 * "intuitiva" que um modelo produziria (`id`, `intent`, `depends_on`, ...) e a
 * forma real. A correção certa é o planner CONHECER o contrato que precisa
 * produzir — não o control plane adivinhar o que ele quis dizer.
 */
const PLANNED_TASK_OUTPUT_CONTRACT = `Cada item de "tasks" é uma PlannedTask ESTRITA — exatamente estes campos,
com estes nomes, nem mais nem menos:

{"schema_version":1,
 "task_id":"<alfanumérico, - e _>",
 "objective":"<um único objetivo desta work unit>",
 "blocked_by":["<task_id>"],
 "taxonomy":{"version":1,
   "task_class":"bugfix"|"feature"|"refactor"|"test"|"docs"|"chore",
   "difficulty_declared":"trivial"|"easy"|"medium"|"hard",
   "complexity":"local"|"multi_file"|"subsystem"|"cross_cutting" (opcional),
   "ambiguity":"low"|"medium"|"high" (opcional),
   "verification":"deterministic"|"partially_deterministic"|"subjective" (opcional)},
 "risk":"low"|"medium"|"high"|"critical",
 "acceptance":["<critério>", ...] (≥1),
 "validation":[{"argv":["<comando>","<arg>"],"timeout_seconds":<int>}] (≥1),
 "initial_files":["<caminho>"],
 "probable_files":["<caminho>"],
 "context_scope":{"areas":["<área do repositório>"]} (≥1 área),
 "context_requirements":[{"description":"<o que é necessário>","source_anchor":"<caminho real>"}],
 "environment_requirements":[{"kind":"tool"|"service","name":"<nome>","reason":"<motivo>"}],
 "estimated_duration":{"expected":<ms>,"maximum":<ms>},
 "validation_budget":{"expected":<ms>,"maximum":<ms>},
 "resource_envelope":{"duration_ms":{"expected":<ms>,"maximum":<ms>},
   "tokens":{"expected":<tokens>,"maximum":<tokens>},
   "changed_files":{"expected":<n>,"maximum":<n>}}}

UNIDADES: estimated_duration, validation_budget e resource_envelope.duration_ms
são MILISSEGUNDOS; validation[].timeout_seconds é em SEGUNDOS; tokens são
tokens; changed_files é número de arquivos. "expected" nunca excede "maximum".
"argv" é vetor de argumentos, nunca uma linha de shell.

acceptance: todo objetivo do acceptance_contract precisa aparecer VERBATIM em
alguma task. Você PODE acrescentar critérios técnicos adicionais que a work
unit precise satisfazer; não pode reescrever nem substituir os do usuário.

DECOMPOSIÇÃO: decomponha em work units coesas, executáveis e validáveis.
Atomicidade não significa a menor alteração possível. Não crie uma task por
arquivo, função, componente ou teste quando um coding agent puder realizar
essas mudanças com segurança como uma única unidade. Não há quantidade
esperada de tasks. blocked_by forma um DAG; múltiplas raízes e ramos
independentes são válidos.`;

/**
 * Prompt do planner: o PACKET bounded traz fatos derivados e contrato de
 * controle; a INSTRUÇÃO HUMANA COMPLETA viaja íntegra em seção própria e é a
 * autoridade de intenção. Precedência explícita no texto: intenção vem da
 * instrução; policy/safety vêm do packet.
 */
export function buildPlannerPrompt(invocation: PlanningWorkerInvocation): string {
  return [
    'Você é um PLANNING WORKER READ-ONLY do control plane.',
    'Não edite arquivos, não faça commit, não execute validação oficial e não chame outro agente.',
    'Sua saída é um UNTRUSTED DRAFT: ela passa por normalização e validação determinística antes de virar plano.',
    'Não altere plan policy, acceptance contract, routing policy, safety boundaries nem estado autorizado.',
    '',
    'PLANNER PACKET (JSON) — fatos derivados e contrato de controle; NÃO contém a instrução completa:',
    JSON.stringify(invocation.packet, null, 2),
    '',
    'COMPLETE HUMAN INSTRUCTION — autoridade da intenção do usuário, íntegra.',
    'Precedência: para O QUE implementar, este texto governa; para policy, safety',
    'boundaries, acceptance contract e formato de saída, o packet governa.',
    'BEGIN HUMAN INSTRUCTION',
    invocation.human_instruction,
    'END HUMAN INSTRUCTION',
    '',
    'Responda SOMENTE com um único JSON {"schema_version":1,"tasks":[...]}.',
    '',
    PLANNED_TASK_OUTPUT_CONTRACT,
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
        quota: options.quota,
        credential: options.credential,
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

      const overlay = buildRoleArgv(options.profile, {
        role: 'planner',
        prompt: buildPlannerPrompt(invocation),
      });
      assertReadOnlyArgv('planner', options.profile.agent, overlay.argv);
      const argv = resolveRoleOverlayArgv(options.paths, overlay.argv);

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
          argv,
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

      const extracted = extractRoleModelJson({
        agent: options.profile.agent,
        argv,
        stdout,
      });
      switch (extracted.outcome) {
        case 'EXTRACTED':
          return {
            outcome: 'DRAFT_RETURNED',
            invocation_id: invocationId,
            provider_id: options.profile.agent,
            model: options.profile.id,
            draft: extracted.value,
          };
        case 'PROVIDER_TERMINAL_FAILURE':
          return invocationFailure(
            options,
            invocationId,
            'PROVIDER_INVOCATION_FAILED',
            extracted.message,
            true,
          );
        case 'NOT_PARSEABLE':
          return invocationFailure(
            options,
            invocationId,
            'DRAFT_NOT_PARSEABLE',
            extracted.message,
            false,
          );
        default: {
          const _exhaustive: never = extracted;
          return _exhaustive;
        }
      }
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

function parseExactlyOneJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

export type RoleModelJsonExtraction =
  | { readonly outcome: 'EXTRACTED'; readonly value: unknown }
  | { readonly outcome: 'PROVIDER_TERMINAL_FAILURE'; readonly message: string }
  | { readonly outcome: 'NOT_PARSEABLE'; readonly message: string };

/**
 * Separa transporte do provider do payload do modelo. Claude `--output-format json`
 * emite um envelope; só `result` (texto) vai para extractJsonObject.
 */
export function extractRoleModelJson(input: {
  readonly agent: string;
  readonly argv: readonly string[];
  readonly stdout: string;
}): RoleModelJsonExtraction {
  if (input.agent === 'claude' && claudeOutputFormat(input.argv) === 'json') {
    const envelope = parseExactlyOneJsonObject(input.stdout);
    if (envelope === null) {
      return {
        outcome: 'NOT_PARSEABLE',
        message: 'stdout Claude --output-format json não contém exatamente um objeto JSON de transporte',
      };
    }
    const failure = providerTerminalFailure(envelope);
    if (failure !== null) {
      return {
        outcome: 'PROVIDER_TERMINAL_FAILURE',
        message: failure.message ?? failure.signals.join(', '),
      };
    }
    const result = envelope['result'];
    if (typeof result !== 'string') {
      return {
        outcome: 'NOT_PARSEABLE',
        message: 'envelope Claude terminou normalmente sem result textual',
      };
    }
    const value = extractJsonObject(result);
    if (value === null) {
      return {
        outcome: 'NOT_PARSEABLE',
        message: 'result textual do Claude não contém um único objeto JSON legível',
      };
    }
    return { outcome: 'EXTRACTED', value };
  }

  const value = extractJsonObject(input.stdout);
  if (value === null) {
    return {
      outcome: 'NOT_PARSEABLE',
      message: 'saída não contém um único objeto JSON legível',
    };
  }
  return { outcome: 'EXTRACTED', value };
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
  /**
   * `what_i_did_not_check` do handoff v2 do implementer, derivado pelo
   * orquestrador. `null` significa UNKNOWN — handoff v1, que não respondeu à
   * pergunta — e nunca "nenhuma lacuna".
   */
  readonly implementer_gaps: readonly string[] | null;
  /**
   * Opinião do implementer e como o harness a LÊ. É sinal para o reviewer,
   * não veredito: confiança baixa não reprova nada sozinha.
   */
  readonly implementer_confidence: {
    readonly statement: string | null;
    readonly level: HandoffConfidenceLevel;
  } | null;
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
    'Responda SOMENTE com um único JSON:',
    '{"decision":"ACCEPT|REJECT","reason":"...","coverage":{',
    ' "files":[<arquivos do candidate que você auditou>],',
    ' "validations":[[<argv da validação oficial que você leu>]],',
    ' "behaviors":[<aspectos comportamentais auditados, frases curtas>],',
    ' "handoff_gaps":[{"gap":"<texto EXATO de implementer_gaps>",',
    '   "disposition":"accepted_with_justification"|"open_question","note":"..."}]}}',
    '',
    'ACCEPT exige coverage: ao menos um arquivo auditado, ao menos uma validação',
    'referenciada e CADA item de implementer_gaps endereçado exatamente uma vez —',
    'aceito com justificativa ou registrado como pergunta aberta. "looks good",',
    '"revisado" e "tudo coberto" não endereçam nada.',
    'implementer_confidence é opinião, não fato: confiança baixa ou ambígua não',
    'reprova sozinha, mas o risco correspondente precisa aparecer na coverage.',
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
  /**
   * Os MESMOS fatos honestos do implementer. Review read-only não ganha
   * autorização mais fraca: um reviewer lançado com credencial não provada
   * seria uma segunda porta para o que o gate do implementer recusa.
   */
  readonly credential: LaunchFact;
  readonly quota: LaunchFact;
  readonly port?: ProviderRoleInvocationPort;
}

interface ProjectReviewVerdict<Outcome extends 'ACCEPT' | 'REJECT'> {
  readonly outcome: Outcome;
  readonly reason: string;
  /**
   * Cobertura DECLARADA pelo reviewer, do jeito que ele a escreveu. Não é
   * validada aqui: quem decide se ela basta para um ACCEPT é o schema do
   * `CandidateReviewRecord`, não este adapter.
   */
  readonly coverage: CandidateReviewCoverage | null;
  readonly policy: ReviewerInvocationPolicy;
  readonly argv: readonly string[];
  /**
   * Prova ESTRUTURAL do contexto em que o veredito nasceu. Publicada junto com
   * a decisão porque um veredito só vale se o reviewer não podia escrever — e
   * quem audita depois precisa ver o mecanismo, não uma afirmação.
   */
  readonly workspace_access: RoleWorkspaceAccess;
  readonly read_only_mechanism: string;
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
    quota: options.quota,
    credential: options.credential,
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
  const overlay = buildRoleArgv(options.profile, {
    role: 'reviewer',
    prompt,
  });
  assertReadOnlyArgv('reviewer', options.profile.agent, overlay.argv);
  const argv = resolveRoleOverlayArgv(options.paths, overlay.argv);

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
      argv,
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

  const extracted = extractRoleModelJson({
    agent: options.profile.agent,
    argv,
    stdout,
  });
  switch (extracted.outcome) {
    case 'EXTRACTED':
      break;
    case 'PROVIDER_TERMINAL_FAILURE':
      return reviewUnavailable('REVIEW_INVOCATION_FAILED', extracted.message);
    case 'NOT_PARSEABLE':
      return reviewUnavailable('REVIEW_VERDICT_NOT_PARSEABLE', extracted.message);
    default: {
      const _exhaustive: never = extracted;
      return _exhaustive;
    }
  }
  const parsed = extracted.value as
    | { decision?: unknown; reason?: unknown; coverage?: unknown }
    | null;
  const decision = parsed?.decision;
  const reason = parsed?.reason;
  if ((decision !== 'ACCEPT' && decision !== 'REJECT') || typeof reason !== 'string' || reason.trim() === '') {
    return reviewUnavailable(
      'REVIEW_VERDICT_NOT_PARSEABLE',
      'saída do reviewer não contém um único JSON {"decision":"ACCEPT|REJECT","reason":"..."}',
    );
  }
  // Cobertura mal formada NÃO é reparada nem completada: ela simplesmente não
  // existe, e um ACCEPT sem cobertura válida será recusado pelo schema do
  // record. Inventar coverage aqui seria fabricar auditoria.
  const coverage = CandidateReviewCoverage.safeParse(parsed?.coverage);
  return {
    outcome: decision,
    reason: reason.trim(),
    coverage: coverage.success ? coverage.data : null,
    policy: plan.policy,
    argv,
    workspace_access: overlay.workspace_access,
    read_only_mechanism: overlay.mechanism,
  };
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
  readonly quota: LaunchFact;
  readonly credential: LaunchFact;
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
    quota: input.quota,
    credential: input.credential,
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
