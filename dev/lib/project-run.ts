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

import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  ProjectIntakeRequest,
  ExecutionAuthorizationScope,
} from '../../src/intake/index.js';
import { inspectRepository, type ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution } from '../../src/planner/assess.js';
import { PlannedTask, type TaskRisk } from '../../src/planner/task.js';
import { evaluatePlanWorkflow } from '../../src/planner/validate.js';
import { resolveDataDir } from '../../src/project/index.js';
import { AttemptRole } from '../../src/performance/attempt-facts.js';
import { InterventionType, type InterventionRecord } from '../../src/schemas/index.js';
import type { PerformanceHistoryQueryResultV2 } from '../../src/performance/query.js';
import {
  CapabilityRegistry,
  capabilityOf,
  decideEscalation,
  routeInitialProfileWithHistory,
  type EscalationAuthorization,
  type EscalationCandidatePreflight,
  type EscalationExecutionPolicy,
  type EscalationLadder,
  type HistoryInformedRoutingResult,
  type ProfileCapabilityInput,
  type RoutingCandidate,
} from '../../src/routing/index.js';
import type { FailureDiagnosis } from '../../src/routing/diagnosis.js';
import {
  finalizationFingerprint,
  lookupCandidateReview,
  validationResultsFingerprint,
  type ValidatedCandidateAcceptance,
  type ValidatedCandidateAcceptancePolicy,
} from './candidate-review.js';
import type { CandidateReviewLookup } from './candidate-review.js';
import type { CommandRunner } from './billing.js';
import { experimentFactsOf, sandboxOf, sessionPersistenceOf } from './doctor.js';
import { executionPolicyOf } from './execution-policy.js';
import { inspectPendingAcceptance } from './finalize-orchestrated.js';
import { headSha } from './git.js';
import { resolveHarnessInstallationRoot, type HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { buildWorkerPrompt } from './prompt.js';
import {
  loadProfileFromCatalog,
  profileProvenance,
  type LauncherProfile,
  type ProfileProvenance,
} from './profile.js';
import {
  collectProjectLaunchFacts,
  escalationPreflightOf,
  evidenceOf,
  type LaunchFact,
  type LaunchFactEvidence,
  type ProjectLaunchFacts,
} from './project-preflight.js';
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
  OPERATIONAL_ATTEMPT_SCHEMA_VERSION,
  operationalAttemptPath,
  writeOperationalAttempt,
} from './operational-attempt.js';
import {
  materializeCanonicalProjectAttempt,
  projectProfileFingerprint,
  projectWorkDefinitionFingerprint,
  queryCanonicalProjectHistory,
} from './project-history.js';
import {
  candidateReviewPath,
  completionPath,
  handoffDraftPath,
  packetPath,
  readCandidateReview,
  readCompletion,
  readHandoffDraft,
  readLaunchRecord,
  readOrchestratedFinalization,
  readPacket,
  readProjectHistoryBinding,
  readValidationFailedAttempt,
  reportPath,
  validationFailedAttemptPath,
  writeCandidateReview,
} from './records.js';
import type {
  CandidateReviewRequirement,
  OrchestratedFinalizationRecord,
} from './schemas.js';
import { isHandoffDraftV2, readHandoffConfidence } from './schemas.js';
import { retryFailedAttempt } from './retry-failed.js';
import type { HumanRequiredOutput } from './routine-autonomy.js';
import { getTaskState, readState } from './state.js';

export const PROJECT_RUN_SCHEMA_VERSION = 1;

const HISTORY_MINIMUM_SAMPLE_SIZE = 3;

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
  /**
   * Estado da série histórica consultada em M82. Desde a24c0cb o caminho de
   * projeto externo materializa cada attempt com inference provada como run
   * canônico (`project-history.ts`) e consulta essa história antes de rotear;
   * `EMPTY` continua sendo o valor honesto enquanto o work definition não tem
   * nenhum episódio registrado, e o routing decide pelo fallback de M78
   * sabendo disso.
   */
  readonly history_status: 'EMPTY' | 'AVAILABLE' | 'INSUFFICIENT';
  readonly history_evidence: {
    readonly episode_count: number;
    readonly series_count: number;
    readonly selected_series_sample_size: number;
    readonly series_considered: HistoryInformedRoutingResult['evidence']['series_considered'];
  };
  readonly rationale: readonly string[];
  /**
   * Preenchido quando o data root canônico existia mas era ILEGÍVEL. O routing
   * seguiu pelo fallback determinístico; isto registra que a série histórica
   * não pôde ser consultada, em vez de deixar a ausência parecer "sem
   * episódios".
   */
  readonly history_unreadable_reason?: string;
}

/** Fato de launch como ele aparece no relatório: valor, qualidade e origem. */
export interface ProjectLaunchFactReport {
  readonly availability: boolean | null;
  readonly evidence: LaunchFactEvidence;
  readonly provenance: string;
}

function factReportOf(fact: LaunchFact): ProjectLaunchFactReport {
  return {
    availability: fact.availability,
    evidence: evidenceOf(fact),
    provenance: fact.provenance,
  };
}

function historyStatusOf(
  routed: HistoryInformedRoutingResult,
): ProjectRoutingReport['history_status'] {
  const considered = routed.evidence.series_considered;
  if (considered.some((series) => series.status === 'ELIGIBLE' || series.status === 'AMBIGUOUS')) {
    return 'AVAILABLE';
  }
  if (considered.some((series) => series.series_key !== null && series.status === 'INSUFFICIENT_EVIDENCE')) {
    return 'INSUFFICIENT';
  }
  if (considered.some((series) => series.status === 'INCOMPATIBLE' && series.reason.includes('UNKNOWN'))) {
    return 'INSUFFICIENT';
  }
  return 'EMPTY';
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
  readonly credential: ProjectLaunchFactReport;
  readonly quota: ProjectLaunchFactReport;
  readonly launch_authorization: string;
  review: ProjectReviewReport;
  validation_outcome: string | null;
  comparable_run_facts_path: string | null;
  /** `OK` ou `OBSERVABILITY_DEGRADED`; nunca decide se a work unit avança. */
  telemetry_status: 'OK' | 'OBSERVABILITY_DEGRADED';
  telemetry_reason: string | null;
  operational_attempt_path: string | null;
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

/** Gate humano ainda NÃO publicado: descrição pura, sem efeito em memória. */
interface WorkUnitGate {
  readonly incidentId: string;
  readonly decisionNeeded: string;
  readonly why: string;
  readonly options: readonly string[];
  readonly evidencePaths: readonly string[];
}

/** Resultado da avaliação read-only compartilhada por runtime real e preview. */
interface WorkUnitAssessment {
  readonly outcome: 'LAUNCH' | 'HUMAN_REQUIRED';
  readonly gate: WorkUnitGate | null;
  /** `null` quando a avaliação parou antes de existir uma work unit avaliada. */
  readonly report: ProjectWorkUnitReport | null;
  readonly selectedProfileId: string | null;
  readonly timeoutSeconds: number | null;
  readonly reviewRequirement: CandidateReviewRequirement | null;
  readonly history: PerformanceHistoryQueryResultV2 | null;
  readonly materialization: WorkUnitMaterializationContext | null;
}

interface WorkUnitMaterializationContext {
  readonly planTask: LoadedPlan['plan']['tasks'][number];
  readonly classification: WorkUnitClassification;
  readonly inspection: ProjectInspection;
  readonly baseSha: string;
  readonly instructionFiles: readonly { readonly path: string; readonly sha256: string }[];
  readonly instructionInventoryComplete: boolean;
}

/** Projeção read-only da próxima ação; nada aqui foi decidido nem gravado. */
export interface ProjectWorkUnitPreview {
  readonly status: 'READY' | 'HUMAN_REQUIRED';
  readonly task_id: string | null;
  readonly blocked_by: string | null;
  readonly reason: string | null;
  readonly candidate_commit: string | null;
  readonly evidence_paths: readonly string[];
  readonly work_unit: {
    readonly task_id: string;
    readonly path: ProjectLifecyclePathName;
    readonly attempt_role: AttemptRole;
    readonly inspection_provenance: string;
    readonly environment_readiness: EnvironmentReadinessGate;
    readonly routing: ProjectRoutingReport;
    readonly worker_runtime_budget: ProjectBudgetReport;
    readonly credential: ProjectLaunchFactReport;
    readonly quota: ProjectLaunchFactReport;
    readonly launch_authorization: string;
    readonly review_required: boolean;
    readonly reviewer_profile_id: string | null;
  } | null;
}

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

/**
 * Decisão da autoridade de review sobre UM candidate preparado e validado.
 * `HUMAN_REQUIRED` cobre REJECT, review indisponível e veredito não amarrado
 * ao candidate: para a promoção as três são a mesma coisa — não aceito.
 */
export type CandidateAcceptanceDecision =
  | { readonly status: 'ACCEPTED'; readonly reason: string }
  | {
      readonly status: 'HUMAN_REQUIRED';
      readonly code: string;
      readonly human_required: HumanRequiredOutput;
    };

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
  /**
   * MESMA avaliação de `beforeWorkUnit`, sem nenhum efeito. É a porta do
   * dry-run: existe para que a pré-visualização seja a decisão real, e não uma
   * segunda implementação que pode divergir dela. `taskId` é `null` quando o
   * runtime não tem work unit selecionável — o que não impede a resposta,
   * porque a próxima ação segura pode ser uma decisão de review pendente.
   */
  previewNextAction(request: {
    readonly taskId: string | null;
    readonly attemptKind?: 'FIRST_PASS' | 'REPAIR';
  }): Promise<ProjectWorkUnitPreview>;
  afterWorkUnit(observation: WorkUnitObservation): Promise<WorkUnitFollowUp>;
  onRepairExhausted(input: {
    readonly taskId: string;
    readonly reason: string;
  }): Promise<RepairExhaustedFollowUp>;
  /**
   * Autoridade de review consumida pela FINALIZAÇÃO, e não pelo loop: é ela
   * que decide se um candidate validado pode virar PASS. Entregue como
   * `ValidatedCandidateAcceptancePolicy` porque quem faz a pergunta é a
   * primitive de finalização, que não conhece profile, policy nem reviewer.
   */
  readonly acceptance: ValidatedCandidateAcceptancePolicy;
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
 *
 * Um repositório greenfield ainda não tem source anchor nenhum: a fronteira
 * declarada pela própria work unit (`initial_files`) e, em último caso, a raiz
 * do repositório são fatos igualmente reais, e usá-los evita bloquear
 * justamente a task que vai CRIAR a estrutura.
 */
function contextAreasOf(
  inspection: ProjectInspection,
  initialFiles: readonly string[],
  repoRoot: string,
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
  if (all.length > 0) {
    return { areas: all, provenance: 'inspection.source_anchors (nenhum initial_file ancorado)' };
  }
  const declared = [
    ...new Set(
      initialFiles
        .map((file) => file.split('/')[0])
        .filter((segment): segment is string => segment !== undefined && segment !== ''),
    ),
  ];
  if (declared.length > 0) {
    return { areas: declared, provenance: 'plan.initial_files (repositório sem source anchors observados)' };
  }
  return {
    areas: [path.basename(path.resolve(repoRoot))],
    provenance: 'repo_root (repositório greenfield: nenhum source anchor nem initial_file declarado)',
  };
}

async function fingerprintProjectInstructions(
  repoRoot: string,
  inspection: ProjectInspection,
): Promise<{
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
  readonly complete: boolean;
}> {
  const root = path.resolve(repoRoot);
  const files: { path: string; sha256: string }[] = [];
  for (const instruction of inspection.project_instructions) {
    const absolute = path.resolve(root, instruction.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { files, complete: false };
    try {
      const bytes = await readFile(absolute);
      files.push({
        path: instruction.path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch {
      return { files, complete: false };
    }
  }
  return { files, complete: true };
}

export interface WorkUnitBuild {
  readonly task: PlannedTask;
  readonly provenance: readonly string[];
}

/**
 * Compõe a `PlannedTask` de M73 a partir do PlanFile (objetivo, acceptance,
 * validation, dependências, arquivos iniciais), dos fatos observados pela
 * inspeção (áreas, instruções de projeto, ferramentas/serviços) e da
 * classificação do planejamento. Nenhum campo é preenchido por default do
 * harness: o que falta vira erro estruturado.
 *
 * Precedência da classificação: quando o PlanFile é GERADO e traz
 * `planner_metadata`, a classificação que o planner produziu para AQUELA task
 * é a autoritativa — foi ela que examinou o trabalho. Sem `planner_metadata`
 * (PlanFile manual/histórico), o fallback continua sendo `classificationFor`
 * sobre o `agentlab-run.yaml`. O default global nunca sobrescreve a
 * classificação do planner.
 */
export function buildWorkUnitFromPlan(input: {
  readonly planTask: LoadedPlan['plan']['tasks'][number];
  readonly inspection: ProjectInspection;
  readonly classification: WorkUnitClassification;
  readonly repoRoot?: string;
}): WorkUnitBuild {
  const { planTask, inspection, classification } = input;
  const planner = planTask.planner_metadata;
  const context =
    planner === undefined
      ? contextAreasOf(inspection, planTask.initial_files, input.repoRoot ?? inspection.repo_root)
      : { areas: planner.context_scope.areas, provenance: 'plan.planner_metadata.context_scope' };

  const validationBudgetMs = planTask.validation.reduce(
    (total, command) => total + command.timeout_seconds * 1_000,
    0,
  );

  const candidate = {
    schema_version: 1 as const,
    task_id: planTask.id,
    objective: planTask.objective,
    blocked_by: [...planTask.blocked_by],
    taxonomy:
      planner?.taxonomy ?? {
        version: 1 as const,
        task_class: classification.task_class,
        difficulty_declared: classification.difficulty_declared,
        ...(classification.complexity === undefined ? {} : { complexity: classification.complexity }),
        ...(classification.ambiguity === undefined ? {} : { ambiguity: classification.ambiguity }),
        ...(classification.verification === undefined
          ? {}
          : { verification: classification.verification }),
      },
    risk: planner?.risk ?? classification.risk,
    acceptance: [...planTask.acceptance],
    validation: planTask.validation.map((command) => ({
      argv: [...command.argv],
      timeout_seconds: command.timeout_seconds,
    })),
    initial_files: [...planTask.initial_files],
    probable_files: [...(planner?.probable_files ?? [])],
    context_scope: { areas: [...context.areas] },
    context_requirements:
      planner?.context_requirements ??
      inspection.project_instructions.map((ref) => ({
        description: `instrução de projeto (${ref.relevance}) em ${ref.path}`,
        source_anchor: ref.path,
      })),
    environment_requirements: planner?.environment_requirements ?? [
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
    estimated_duration: planner?.estimated_duration ?? classification.resource_envelope.duration_ms,
    validation_budget: planner?.validation_budget ?? {
      expected: validationBudgetMs,
      maximum: validationBudgetMs,
    },
    resource_envelope: planner?.resource_envelope ?? classification.resource_envelope,
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
    provenance:
      planner === undefined
        ? [
            'work_definition=plan_file',
            `context_scope=${context.provenance}`,
            'context_requirements=inspection.project_instructions',
            'environment_requirements=inspection.required_tools+required_services',
            'validation_budget=sum(plan.validation[].timeout_seconds)',
            'taxonomy/risk/resource_envelope=authorization.work_units',
          ]
        : [
            'work_definition=plan_file',
            `context_scope=${context.provenance}`,
            'context_requirements=plan.planner_metadata.context_requirements',
            'environment_requirements=plan.planner_metadata.environment_requirements',
            'validation_budget=plan.planner_metadata.validation_budget',
            'taxonomy/risk/resource_envelope=plan.planner_metadata',
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
  /**
   * Injetável nos testes: o probe de credencial roda com este runner em vez de
   * spawnar o binário do provider. Nenhum provider real é chamado por causa
   * dele — o default continua sendo o probe LOCAL e gratuito do harness.
   */
  readonly credentialRunner?: CommandRunner;
  readonly now?: () => Date;
  /** Data root do control plane; injetável para isolar testes. */
  readonly historyLabRoot?: string;
}

/**
 * Worker runtime budget do REVIEWER, derivado do envelope DECLARADO na
 * autorização da run. Declarado, e não roteado, de propósito: a review de um
 * candidate precisa ser decidível também por um processo que reabriu o runtime
 * depois de um crash, onde nenhuma decisão de routing em memória existe. O
 * mesmo número nos dois caminhos é o que faz a retomada não ser um segundo
 * regime de execução.
 */
function reviewerBudgetMsOf(
  authorization: ProjectRunAuthorizationFile,
  taskId: string,
): number {
  return classificationFor(authorization, taskId).classification.resource_envelope.duration_ms
    .maximum;
}

export async function createProjectControlPlane(
  input: CreateProjectControlPlaneInput,
): Promise<ProjectControlPlane> {
  const { paths, loaded, authorization } = input;
  const inspect = input.inspect ?? ((repoRoot: string) => inspectRepository({ repoRoot }));
  const historyLabRoot = input.historyLabRoot ?? resolveHarnessInstallationRoot();

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
  /** Relatório da work unit em curso — o único estado por-launch do control plane. */
  let active: ProjectWorkUnitReport | null = null;
  let humanGate: HumanRequiredOutput | null = null;
  /**
   * Exigência de review POR TASK, decidida uma vez em `beforeWorkUnit` e
   * consumida pela finalização do mesmo attempt. Fica num mapa por task, e não
   * só na work unit ativa, porque quem pergunta é a primitive de finalização —
   * que só conhece o `task_id`.
   */
  const reviewRequirementByTask = new Map<string, CandidateReviewRequirement>();
  /** Gate humano do último candidate recusado pela review, lido por `afterWorkUnit`. */
  let blockedReview: HumanRequiredOutput | null = null;
  const historySnapshotByTask = new Map<string, PerformanceHistoryQueryResultV2>();
  /**
   * Attempts que ESTE processo observou de ponta a ponta. É a única prova
   * positiva de que nenhum humano autorizou a continuação entre dois attempts
   * do mesmo episódio: o processo nunca parou entre eles.
   */
  const observedAttemptsByTask = new Map<string, Set<number>>();
  const materializationByTask = new Map<string, WorkUnitMaterializationContext>();
  const episodeByTask = new Map<
    string,
    {
      readonly id: string;
      readonly initialProfileId: string;
      readonly initialProfileFingerprintSha256: string;
      nextOrdinal: number;
    }
  >();

  /**
   * Fatos de launch de UM profile, coletados pela primitive canônica. É a
   * mesma coleta para implementer, reviewer e degrau de escalation: um único
   * lugar produz credencial e quota, e nenhum deles pode afirmar mais do que
   * os outros sobre a mesma máquina.
   */
  function launchFactsFor(profile: LauncherProfile): Promise<ProjectLaunchFacts> {
    return collectProjectLaunchFacts({
      paths,
      profile,
      ...(input.credentialRunner === undefined ? {} : { runner: input.credentialRunner }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }

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

  /**
   * AVALIAÇÃO READ-ONLY de uma work unit — a decisão factual inteira, sem um
   * único efeito.
   *
   * Existe separada de `beforeWorkUnit` porque o dry-run precisa PROVAR a
   * mesma decisão que a execução real vai tomar, e não uma reconstrução
   * plausível dela. Um segundo assessment só para preview seria exatamente o
   * tipo de duplicação que faz o dry-run divergir do runtime no dia em que
   * importa. Aqui roda inspeção, M75, M76, readiness, routing, budget e o gate
   * de launch com fatos honestos; o que NÃO roda é o registro de nada:
   * `workUnits`, `active`, `reviewRequirementByTask`, `blockedReview` e
   * `humanGate` pertencem exclusivamente ao chamador com efeitos.
   */
  async function assessWorkUnit(request: WorkUnitRequest): Promise<WorkUnitAssessment> {
    const blocked = (gate: WorkUnitGate): WorkUnitAssessment => ({
      outcome: 'HUMAN_REQUIRED',
      gate,
      report: null,
      selectedProfileId: null,
      timeoutSeconds: null,
      reviewRequirement: null,
      history: null,
      materialization: null,
    });

    const planTask = loaded.byId.get(request.taskId);
    if (planTask === undefined) {
      return blocked({
        incidentId: `project:${request.taskId}:unknown-task`,
        decisionNeeded: 'reconciliar plano e runtime antes de novo launch',
        why: `task ${request.taskId} selecionada pelo runtime não existe no PlanFile carregado`,
        options: ['revisar o PlanFile', 'inspecionar o runtime'],
        evidencePaths: [paths.planFile],
      });
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
    const built = buildWorkUnitFromPlan({ planTask, inspection, classification, repoRoot: paths.repoRoot });
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
      return blocked({
        incidentId: `project:${request.taskId}:workflow`,
        decisionNeeded: 'revisar a work unit antes de novo launch',
        why: `workflow de ${request.taskId} não pôde ser avaliado`,
        options: ['revisar o PlanFile', 'revisar a classificação declarada'],
        evidencePaths: [paths.planFile],
      });
    }
    // Repair e escalation são fatos do lifecycle: um candidate produzido depois
    // de a validação oficial ter reprovado o attempt anterior, ou por um degrau
    // de escalation, é concretamente mais arriscado que um first pass.
    const escalatedAttempt =
      request.attemptKind === 'REPAIR'
        ? { required: true, reason: 'candidate produzido por BOUNDED_REPAIR' }
        : escalatedProfileByTask.has(request.taskId)
          ? { required: true, reason: 'candidate produzido por degrau de escalation' }
          : { required: false, reason: 'first pass' };
    const decision = combineWorkflowAndReview(
      workflow,
      assessment.review_requirement,
      escalatedAttempt,
    );
    const environment = evaluateEnvironmentReadiness(assessment.environment_readiness);

    const pinned = request.pinnedProfileId ?? escalatedProfileByTask.get(request.taskId) ?? null;
    const eligible = pinned === null ? [...profiles.keys()] : [pinned];
    if (eligible.some((profileId) => !profiles.has(profileId))) {
      return blocked({
        incidentId: `project:${request.taskId}:profile-outside-policy`,
        decisionNeeded: 'usar somente profiles da policy autorizada',
        why: `profile ${pinned} exigido pelo runtime está fora da profile policy ${authorization.profile_policy.id}`,
        options: ['declarar o profile na policy', 'rerodar sem o pin de profile'],
        evidencePaths: [input.authorizationFile],
      });
    }
    const workDefinitionFingerprint = projectWorkDefinitionFingerprint({ planTask, classification });
    const historyQuery = {
      workDefinitionFingerprintSha256: workDefinitionFingerprint,
      eligibleProfileIds: eligible,
      minimumSampleSize: HISTORY_MINIMUM_SAMPLE_SIZE,
      filter: {
        task_class: classification.task_class,
        difficulty: classification.difficulty_declared,
        ...(inspection.stack.known ? { stack: inspection.stack.value.ecosystems_detected } : {}),
      },
    } as const;
    // O histórico canônico é OTIMIZAÇÃO de routing, nunca pré-condição: ele só
    // consegue OVERRIDE quando uma série comparável domina por Pareto. Um data
    // root ilegível é UNKNOWN — e UNKNOWN cai no router determinístico, que é
    // estritamente mais conservador. Deixar a leitura derrubar a run faria
    // telemetria auxiliar decidir se o projeto do usuário anda.
    let historyDegraded: string | null = null;
    const history =
      historySnapshotByTask.get(request.taskId) ??
      (await queryCanonicalProjectHistory({ labRoot: historyLabRoot, ...historyQuery }).catch(
        async (error: unknown) => {
          historyDegraded = error instanceof Error ? error.message : String(error);
          return queryCanonicalProjectHistory({
            labRoot: path.join(historyLabRoot, 'unreadable-history-absent'),
            ...historyQuery,
          });
        },
      ));
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
      history,
      profile_fingerprints_sha256: Object.fromEntries(
        eligible.map((profileId) => [profileId, projectProfileFingerprint(profiles.get(profileId) as LauncherProfile)]),
      ),
    });

    const routingDecision = routed.source === 'HISTORY' ? routed.recommendation : routed.fallback;
    if (routingDecision === null || routingDecision.outcome !== 'ROUTED') {
      const reason =
        routingDecision === null
          ? 'routing histórico/base não produziu decisão aplicável'
          : routingDecision.outcome === 'BUDGET_UNSUPPORTED'
            ? `worker runtime budget não cabe nos bounds dos profiles autorizados: ${routingDecision.violations
                .map((violation) => `${violation.profile_id}=${violation.requested_budget_ms}ms`)
                .join(', ')}`
            : 'routing não produziu profile executável';
      return blocked({
        incidentId: `project:${request.taskId}:routing`,
        decisionNeeded: 'ampliar ou corrigir a profile policy autorizada',
        why: `routing não encontrou profile elegível dentro da policy: ${reason}`,
        options: [
          'declarar um profile compatível na profile_policy',
          'revisar a classificação declarada da work unit',
        ],
        evidencePaths: [input.authorizationFile],
      });
    }

    const routedProfileId = routingDecision.profile.profile_id;
    const selectedProfileId = pinned ?? routedProfileId;
    const profile = profiles.get(selectedProfileId);
    if (profile === undefined) {
      return blocked({
        incidentId: `project:${request.taskId}:profile-outside-policy`,
        decisionNeeded: 'usar somente profiles da policy autorizada',
        why: `profile ${selectedProfileId} exigido pelo runtime está fora da profile policy ${authorization.profile_policy.id}`,
        options: ['declarar o profile na policy', 'rerodar sem o pin de profile'],
        evidencePaths: [input.authorizationFile],
      });
    }

    const budgetMs = routingDecision.worker_runtime_budget.milliseconds;
    const budget = resolveWorkerRuntimeBudget({ profile, budgetMs });
    if (budget.outcome === 'BUDGET_UNSUPPORTED') {
      return blocked({
        incidentId: `project:${request.taskId}:budget`,
        decisionNeeded: 'reconfigurar runtime ou replanejar a work unit',
        why: budget.reason,
        options: [...budget.allowed_next_steps],
        evidencePaths: [input.authorizationFile],
      });
    }

    // Fatos honestos, coletados pelas primitives canônicas imediatamente antes
    // do gate. Nenhum é afirmado por conveniência: o que não puder ser sabido
    // sem chamar provider permanece UNKNOWN, e a policy de UNKNOWN vive em
    // `authorizeProjectLaunch`, não aqui.
    const facts = await launchFactsFor(profile);
    const launchAuthorization = authorizeProjectLaunch({
      scope,
      capability: request.attemptKind === 'REPAIR' ? 'BOUNDED_REPAIR' : 'CONFIGURED_SUBSCRIPTION_WORKER',
      billing_mode: profile.billing_mode,
      quota: facts.quota,
      credential: facts.credential,
      risk: assessment.risk.value,
      worker_owns_commit: profile.commit_owner !== 'orchestrator',
      worker_owns_official_validation: profile.official_validation_owner !== 'orchestrator',
    });

    const reviewerProfileId = authorization.review.reviewer_profile_id ?? selectedProfileId;
    const reviewerProfile = decision.review_required
      ? (profiles.get(reviewerProfileId) ?? null)
      : null;
    // A exigência vale para o candidate que ESTE attempt vier a produzir. Um
    // reviewer que não pertença à policy NÃO relaxa a exigência: ela continua
    // registrada, e a impossibilidade de decidir vira gate humano em vez de
    // aceite silencioso.
    const reviewRequirement: CandidateReviewRequirement | null = decision.review_required
      ? {
          required: true,
          reviewer_profile_id: reviewerProfileId,
          diversity_requirement: decision.diversity_requirement,
          policy_provenance: `assessment.review_requirement + ${input.authorizationFile}`,
        }
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
        history_status: historyStatusOf(routed),
        history_evidence: {
          episode_count: history.episodes.length,
          series_count: history.series.length,
          selected_series_sample_size: routed.evidence.selected_series_sample_size,
          series_considered: routed.evidence.series_considered,
        },
        rationale: [
          ...routed.rationale,
          ...(routed.fallback?.outcome === 'ROUTED' ? routed.fallback.rationale : []),
        ],
        ...(historyDegraded === null ? {} : { history_unreadable_reason: historyDegraded }),
      },
      worker_runtime_budget: {
        requested_ms: budget.requested_budget_ms,
        timeout_seconds: budget.timeout_seconds_override,
        source: routed.source === 'HISTORY' ? 'M81/M82 observed duration p90' : 'M78 adaptive worker runtime budget',
        checked_bounds: budget.checked_bounds.map(
          (bound) => `${bound.source}=${bound.maximum_ms}ms`,
        ),
      },
      credential: factReportOf(facts.credential),
      quota: factReportOf(facts.quota),
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
      telemetry_status: 'OK',
      telemetry_reason: null,
      operational_attempt_path: null,
      repair: request.attemptKind === 'REPAIR' ? 'BOUNDED_REPAIR' : null,
      diagnosis: null,
      escalation: escalatedProfileByTask.get(request.taskId) ?? null,
    };

    const gate: WorkUnitGate | null =
      launchAuthorization.outcome === 'HUMAN_REQUIRED'
        ? {
            incidentId: `project:${request.taskId}:launch-authorization`,
            decisionNeeded: 'autorizar explicitamente a capability exigida por esta work unit',
            why: launchAuthorization.reason,
            options: [
              'ampliar autonomous_execution_boundary de forma explícita',
              'reduzir o risco declarado da work unit',
              'executar a ação manualmente',
            ],
            evidencePaths: [input.authorizationFile],
          }
        : environment.outcome !== 'READY'
          ? {
              incidentId: `project:${request.taskId}:environment`,
              decisionNeeded: 'preparar o ambiente do repositório alvo antes de novo launch',
              why: `${environment.outcome}: ${environment.reason}`,
              options: ['remediar o ambiente', 'declarar os requisitos ausentes'],
              evidencePaths: [paths.repoRoot],
            }
          : null;

    const instructionInventory = await fingerprintProjectInstructions(paths.repoRoot, inspection);
    return {
      outcome: gate === null ? 'LAUNCH' : 'HUMAN_REQUIRED',
      gate,
      report,
      selectedProfileId,
      timeoutSeconds: budget.timeout_seconds_override,
      reviewRequirement,
      history,
      materialization: {
        planTask,
        classification,
        inspection,
        baseSha: head,
        instructionFiles: instructionInventory.files,
        instructionInventoryComplete: instructionInventory.complete,
      },
    };
  }

  async function ensureEpisode(
    request: WorkUnitRequest,
    selectedProfileId: string,
  ): Promise<void> {
    if (episodeByTask.has(request.taskId)) return;
    const state = await readState(paths);
    const taskState = getTaskState(state, request.taskId);
    const previousAttempt = taskState.attempts;
    if (previousAttempt > 0 && (request.attemptKind === 'REPAIR' || escalatedProfileByTask.has(request.taskId))) {
      const previousLaunch = await readLaunchRecord(paths, request.taskId);
      if (previousLaunch !== null) {
        const binding = await readProjectHistoryBinding(
          paths,
          request.taskId,
          previousAttempt,
          previousLaunch.launch_id,
        );
        if (binding !== null) {
          episodeByTask.set(request.taskId, {
            id: binding.execution_episode_id,
            initialProfileId: binding.initial_profile_id,
            initialProfileFingerprintSha256: binding.initial_profile_fingerprint_sha256,
            nextOrdinal: binding.episode_attempt_ordinal + 1,
          });
          return;
        }
      }
    }
    const profile = profiles.get(selectedProfileId) as LauncherProfile;
    const primaryAttempt = previousAttempt + 1;
    const digest = createHash('sha256')
      .update(JSON.stringify({
        schema_version: 1,
        target: path.resolve(paths.repoRoot),
        runtime: path.resolve(paths.devDir),
        task_id: request.taskId,
        primary_attempt: primaryAttempt,
      }))
      .digest('hex');
    episodeByTask.set(request.taskId, {
      id: `episode-${digest.slice(0, 24)}`,
      initialProfileId: selectedProfileId,
      initialProfileFingerprintSha256: projectProfileFingerprint(profile),
      nextOrdinal: 1,
    });
  }

  /**
   * Aplica a MESMA avaliação, agora com os efeitos que só o runtime real pode
   * ter: registrar a work unit, publicar a exigência de review do attempt e
   * abrir o gate humano.
   */
  async function beforeWorkUnit(request: WorkUnitRequest): Promise<WorkUnitDecision> {
    const assessment = await assessWorkUnit(request);
    const gate = assessment.gate;

    if (assessment.report === null) {
      const blocking = gate as WorkUnitGate;
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          blocking.incidentId,
          blocking.decisionNeeded,
          blocking.why,
          blocking.options,
          blocking.evidencePaths,
        ),
      };
    }

    blockedReview = null;
    if (assessment.reviewRequirement === null) {
      reviewRequirementByTask.delete(request.taskId);
    } else {
      reviewRequirementByTask.set(request.taskId, assessment.reviewRequirement);
    }
    workUnits.push(assessment.report);
    active = assessment.report;

    if (gate !== null) {
      return {
        outcome: 'HUMAN_REQUIRED',
        human_required: humanRequired(
          gate.incidentId,
          gate.decisionNeeded,
          gate.why,
          gate.options,
          gate.evidencePaths,
        ),
      };
    }

    if (assessment.history !== null && !historySnapshotByTask.has(request.taskId)) {
      historySnapshotByTask.set(request.taskId, assessment.history);
    }
    if (assessment.materialization !== null) {
      materializationByTask.set(request.taskId, assessment.materialization);
    }
    await ensureEpisode(request, assessment.selectedProfileId as string);

    return {
      outcome: 'LAUNCH',
      profile_id: assessment.selectedProfileId as string,
      timeout_seconds: assessment.timeoutSeconds as number,
    };
  }

  /**
   * PRÉ-VISUALIZAÇÃO do próximo passo — mesma avaliação, zero efeito.
   *
   * Antes de qualquer avaliação de work unit vem a FRONTEIRA DE ACEITAÇÃO: se
   * existe candidate preparado aguardando (ou já reprovado por) review, a
   * próxima ação segura não é lançar nada, é decidir sobre ele. Dizer READY
   * ali seria prever um launch que o runtime real jamais faria.
   */
  async function previewNextAction(request: {
    readonly taskId: string | null;
    readonly attemptKind?: 'FIRST_PASS' | 'REPAIR';
  }): Promise<ProjectWorkUnitPreview> {
    const pending = await inspectPendingAcceptance({ paths, loaded });
    if (pending.status === 'PENDING') {
      const lookup: CandidateReviewLookup = pending.review;
      const accepted = lookup.status === 'ACCEPTED' || lookup.status === 'NOT_REQUIRED';
      if (!accepted) {
        return {
          status: 'HUMAN_REQUIRED',
          task_id: pending.taskId,
          blocked_by: `CANDIDATE_REVIEW_${lookup.status}`,
          reason: lookup.reason,
          candidate_commit: pending.candidateCommit,
          evidence_paths: [lookup.evidence_path],
          work_unit: null,
        };
      }
    }

    if (request.taskId === null) {
      return {
        status: 'READY',
        task_id: null,
        blocked_by: null,
        reason: 'nenhuma work unit selecionável pelo runtime neste momento',
        candidate_commit: null,
        evidence_paths: [],
        work_unit: null,
      };
    }

    const assessment = await assessWorkUnit({
      taskId: request.taskId,
      attemptKind: request.attemptKind ?? 'FIRST_PASS',
      pinnedProfileId: null,
    });
    return {
      status: assessment.outcome === 'LAUNCH' ? 'READY' : 'HUMAN_REQUIRED',
      task_id: request.taskId,
      blocked_by: assessment.gate === null ? null : assessment.gate.incidentId,
      reason: assessment.gate === null ? null : assessment.gate.why,
      candidate_commit: null,
      evidence_paths: assessment.gate === null ? [] : [...assessment.gate.evidencePaths],
      work_unit:
        assessment.report === null
          ? null
          : {
              task_id: assessment.report.task_id,
              path: assessment.report.path,
              attempt_role: assessment.report.attempt_role,
              inspection_provenance: assessment.report.inspection_provenance,
              environment_readiness: assessment.report.environment_readiness,
              routing: assessment.report.routing,
              worker_runtime_budget: assessment.report.worker_runtime_budget,
              credential: assessment.report.credential,
              quota: assessment.report.quota,
              launch_authorization: assessment.report.launch_authorization,
              review_required: assessment.report.review.required,
              reviewer_profile_id: assessment.report.review.reviewer_profile_id,
            },
    };
  }

  /**
   * Evidência canônica de intervenção humana do attempt observado.
   *
   * - REJECT durável de review em attempt anterior do episódio seguido de novo
   *   attempt: um humano liberou o gate, e isso é registrado como intervenção.
   * - primeiro attempt do episódio, ou attempt cujo antecessor foi observado
   *   por este mesmo processo: o lifecycle PROVA zero intervenções.
   * - qualquer outro caso (episódio retomado de disco, antecessor não
   *   observado aqui): desconhecido — nenhum artifact é publicado.
   */
  async function proveInterventionEvidence(
    observation: WorkUnitObservation,
    episode: { readonly nextOrdinal: number },
    observedAttempts: ReadonlySet<number>,
    startedAt: string,
  ): Promise<{ readonly provenance: string; readonly interventions: readonly InterventionRecord[] } | null> {
    const episodeFirstAttempt = observation.attempt - (episode.nextOrdinal - 1);
    const humanReleases: InterventionRecord[] = [];
    for (let attempt = episodeFirstAttempt; attempt < observation.attempt; attempt += 1) {
      const review = await readCandidateReview(paths, observation.taskId, attempt);
      if (review === null || review.decision !== 'REJECT') continue;
      humanReleases.push({
        intervention_id: `human-release:${observation.taskId}:attempt-${attempt}`,
        type: InterventionType.DESIGN_DECISION,
        description: `humano liberou o gate de review REJECT do attempt ${attempt} e autorizou o attempt ${observation.attempt}`,
        occurred_at: startedAt,
        affects_autonomy: true,
      });
    }
    if (humanReleases.length > 0) {
      return {
        provenance: 'CandidateReviewRecord REJECT do episódio seguido de novo attempt autorizado por humano',
        interventions: humanReleases,
      };
    }
    const autonomousContinuity =
      episode.nextOrdinal === 1 || observedAttempts.has(observation.attempt - 1);
    if (!autonomousContinuity) return null;
    return {
      provenance:
        'attempt conduzido integralmente pelo control plane dentro do autonomous_execution_boundary, sem gate humano no episódio até aqui',
      interventions: [],
    };
  }

  async function materializeObservedAttempt(
    observation: WorkUnitObservation,
    report: ProjectWorkUnitReport,
  ): Promise<void> {
    const profile = profiles.get(observation.profileId);
    const context = materializationByTask.get(observation.taskId);
    const episode = episodeByTask.get(observation.taskId);
    const launch = await readLaunchRecord(paths, observation.taskId);
    const packet = await readPacket(paths, observation.taskId);
    if (profile === undefined || context === undefined || episode === undefined || launch === null || packet === null) return;

    const [completion, failed, finalization, reviewRecord] = await Promise.all([
      readCompletion(paths, observation.taskId),
      readValidationFailedAttempt(paths, observation.taskId, observation.attempt),
      readOrchestratedFinalization(paths, observation.taskId, observation.attempt),
      readCandidateReview(paths, observation.taskId, observation.attempt),
    ]);
    const validationResults =
      failed?.original_validation_results ??
      completion?.orchestrator_evidence.revalidation ??
      finalization?.validation_results ??
      [];
    const validationEvidence =
      failed?.original_validation_evidence ??
      completion?.orchestrator_evidence.validation_evidence ??
      finalization?.validation_evidence ??
      [];
    const changedFiles =
      failed?.changed_files ??
      completion?.orchestrator_evidence.changed_files ??
      finalization?.changed_files ??
      null;
    const baseSha =
      failed?.source_base_sha ??
      completion?.orchestrator_evidence.base_sha ??
      finalization?.base_sha ??
      context.baseSha;
    const fakeInference = profile.agent === 'fake' && profile.test_double_of !== undefined
      ? {
          value: failed !== null || (completion !== null && completion.report !== null) || finalization !== null,
          provenance: 'LauncherProfile.test_double_of + durable worker/finalization evidence',
        }
      : undefined;
    if (report.environment_readiness.outcome !== 'READY') {
      throw new Error(
        `attempt observado não pode ser materializado com environment_readiness=${report.environment_readiness.outcome}`,
      );
    }
    const observedAttempts = observedAttemptsByTask.get(observation.taskId) ?? new Set<number>();
    const interventionEvidence = await proveInterventionEvidence(
      observation,
      episode,
      observedAttempts,
      launch.started_at,
    );
    observedAttempts.add(observation.attempt);
    observedAttemptsByTask.set(observation.taskId, observedAttempts);
    const result = await materializeCanonicalProjectAttempt({
      paths,
      labRoot: historyLabRoot,
      planTask: context.planTask,
      classification: context.classification,
      inspection: context.inspection,
      profile,
      capability: capabilityInputOf(profile),
      launch,
      attempt: observation.attempt,
      attemptRole: report.attempt_role as Exclude<AttemptRole, AttemptRole.UNKNOWN>,
      executionEpisodeId: episode.id,
      episodeAttemptOrdinal: episode.nextOrdinal,
      initialProfileId: episode.initialProfileId,
      initialProfileFingerprintSha256: episode.initialProfileFingerprintSha256,
      baseSha,
      compiledPrompt: buildWorkerPrompt(
        packet,
        {
          repoRoot: paths.repoRoot,
          packetPath: packetPath(paths, observation.taskId),
          reportPath: reportPath(paths, observation.taskId),
          handoffDraftPath: handoffDraftPath(paths, observation.taskId),
        },
        executionPolicyOf(profile),
      ),
      validationResults,
      validationEvidence,
      reviewRequired: report.review.required,
      reviewRecord,
      reviewUnavailableReason: report.review.reason,
      changedFiles,
      contextPressure: report.context_pressure,
      environmentReadiness: 'READY',
      instructionFiles: context.instructionFiles,
      instructionInventoryComplete: context.instructionInventoryComplete,
      interventionEvidence,
      ...(fakeInference === undefined ? {} : { observedHadInference: fakeInference }),
      ...(input.now === undefined ? {} : { now: input.now() }),
    });
    episode.nextOrdinal += 1;
    if (result.outcome !== 'SKIPPED') {
      report.comparable_run_facts_path = path.join(
        resolveDataDir({ labRoot: historyLabRoot }),
        'runs',
        result.run_id,
        'execution',
        'comparable-run-facts.json',
      );
    }
  }

  /** Relatório da work unit a que este candidate pertence, se existir neste processo. */
  function reportFor(taskId: string): ProjectWorkUnitReport | undefined {
    return [...workUnits].reverse().find((entry) => entry.task_id === taskId);
  }

  function reviewRequirementFor(taskId: string): CandidateReviewRequirement | null {
    return reviewRequirementByTask.get(taskId) ?? null;
  }

  function reviewBlocked(
    taskId: string,
    code: string,
    outcome: string,
    reason: string,
    decisionNeeded: string,
    options: readonly string[],
    evidencePaths: readonly string[],
  ): CandidateAcceptanceDecision {
    const report = reportFor(taskId);
    if (report !== undefined) report.review = { ...report.review, outcome, reason };
    const output = humanRequired(
      `project:${taskId}:review`,
      decisionNeeded,
      reason,
      options,
      evidencePaths,
    );
    blockedReview = output;
    return { status: 'HUMAN_REQUIRED', code, human_required: output };
  }

  /**
   * DECISÃO de aceitação sobre um candidate JÁ preparado e validado.
   *
   * Roda depois do commit e da validação oficial, e ANTES de existir qualquer
   * artefato de aceitação: nenhum CompletionRecord PASS, nenhum Handoff selado,
   * nenhum `accepted_commit` e nenhum avanço de `authorized_head_sha` foram
   * publicados quando esta função é chamada. O reviewer recebe evidência
   * objetiva (SHA do candidate, arquivos, validação oficial) e a decisão dele
   * é publicada em disco antes de qualquer promoção.
   *
   * Um veredito durável já publicado NÃO é reexecutado: um REJECT continua
   * valendo depois que o processo termina, e rerodar o mesmo comando não o
   * esquece. Reabrir a task é intervenção humana explícita, nunca automação.
   */
  async function reviewValidatedCandidate(request: {
    readonly taskId: string;
    readonly record: OrchestratedFinalizationRecord;
  }): Promise<CandidateAcceptanceDecision> {
    const { taskId, record } = request;
    const evidencePaths = [
      candidateReviewPath(paths, taskId, record.attempt),
      paths.validationLogsDir,
    ];
    const lookup = await lookupCandidateReview(paths, record);
    if (lookup.status === 'NOT_REQUIRED' || lookup.status === 'ACCEPTED') {
      const report = reportFor(taskId);
      if (report !== undefined) {
        report.review = {
          ...report.review,
          outcome: lookup.status === 'ACCEPTED' ? 'ACCEPT' : 'NOT_REQUIRED',
          reason: lookup.reason,
        };
      }
      return { status: 'ACCEPTED', reason: lookup.reason };
    }
    if (lookup.status === 'REJECTED') {
      return reviewBlocked(
        taskId,
        'REVIEW_REJECTED',
        'REJECT',
        `review independente não aceitou a mudança: ${lookup.reason}`,
        'decidir sobre a mudança reprovada pela review independente',
        ['inspecionar o candidate e a evidência preservada', 'reabrir a task explicitamente'],
        evidencePaths,
      );
    }
    if (lookup.status === 'DIVERGENT') {
      return reviewBlocked(
        taskId,
        'REVIEW_EVIDENCE_DIVERGENT',
        'REVIEW_EVIDENCE_DIVERGENT',
        `veredito de review não corresponde ao candidate preparado: ${lookup.reason}`,
        'reconciliar manualmente veredito e candidate antes de qualquer promoção',
        ['inspecionar o veredito preservado', 'inspecionar o candidate preparado'],
        evidencePaths,
      );
    }
    // ACCEPT sem cobertura mínima chega aqui: existe arquivo de veredito, o
    // schema o recusa, e nada é promovido. Não relançamos reviewer por cima de
    // um veredito já publicado — o record é append-only.
    if (lookup.status === 'INVALID') {
      return reviewBlocked(
        taskId,
        'REVIEW_COVERAGE_INSUFFICIENT',
        'REVIEW_COVERAGE_INSUFFICIENT',
        `veredito de review não satisfaz o contrato de cobertura: ${lookup.reason}`,
        'refazer a review com cobertura explícita antes de qualquer promoção',
        ['inspecionar o veredito preservado', 'inspecionar o candidate preparado'],
        evidencePaths,
      );
    }

    const requirement = lookup.requirement as CandidateReviewRequirement;
    const reviewerProfile = profiles.get(requirement.reviewer_profile_id) ?? null;
    if (reviewerProfile === null) {
      return reviewBlocked(
        taskId,
        'REVIEW_PROFILE_OUTSIDE_POLICY',
        'UNAVAILABLE',
        `a policy exigiu review independente e o reviewer ${requirement.reviewer_profile_id} não pertence à profile policy`,
        'declarar um reviewer elegível na profile policy',
        ['declarar review.reviewer_profile_id', 'reduzir o risco declarado'],
        [input.authorizationFile],
      );
    }
    const planTask = loaded.byId.get(taskId);
    if (planTask === undefined) {
      return reviewBlocked(
        taskId,
        'REVIEW_TASK_OUTSIDE_PLAN',
        'UNAVAILABLE',
        `task ${taskId} do candidate não existe no PlanFile carregado`,
        'reconciliar plano e runtime antes de qualquer promoção',
        ['revisar o PlanFile', 'inspecionar o runtime'],
        [paths.planFile],
      );
    }

    // Lacunas e confiança vêm do HandoffDraft do implementer, derivadas pelo
    // orquestrador — o reviewer não as informa sobre si mesmo. Handoff v1 não
    // respondeu à pergunta: isso é UNKNOWN (null), não "nenhuma lacuna".
    const implementerDraft = await readHandoffDraft(paths, taskId);
    const implementerGaps =
      implementerDraft !== null && isHandoffDraftV2(implementerDraft)
        ? [...implementerDraft.what_i_did_not_check]
        : null;
    const implementerConfidence =
      implementerDraft !== null && isHandoffDraftV2(implementerDraft)
        ? {
            statement: implementerDraft.confidence ?? null,
            level: readHandoffConfidence(implementerDraft.confidence).level,
          }
        : null;

    const reviewerFacts = await launchFactsFor(reviewerProfile);
    const verdict: ProjectReviewResult = await launchProjectReviewer({
      paths,
      profile: reviewerProfile,
      scope,
      implementerProfileId: record.profile_id,
      diversityRequirement: requirement.diversity_requirement as never,
      risk: classificationFor(authorization, taskId).classification.risk,
      workerRuntimeBudgetMs: reviewerBudgetMsOf(authorization, taskId),
      // Os MESMOS fatos honestos do implementer, coletados agora para o
      // profile do reviewer. Review read-only não ganha autorização mais
      // fraca — e uma review que não pode ser autorizada vira
      // `REVIEW_UNAVAILABLE`, nunca ACCEPT.
      credential: reviewerFacts.credential,
      quota: reviewerFacts.quota,
      packet: {
        task_id: taskId,
        objective: planTask.objective,
        acceptance: [...planTask.acceptance],
        validation: planTask.validation.map((command) => ({ argv: [...command.argv] })),
        changed_files: [...record.changed_files],
        // O candidate REVISADO, não um accepted_commit: no instante da review
        // nada foi aceito ainda.
        candidate_sha: record.candidate_commit,
        official_validation_outcome: 'PASS',
        evidence_paths: [paths.validationLogsDir],
        implementer_gaps: implementerGaps,
        implementer_confidence: implementerConfidence,
      },
    });

    if (verdict.outcome === 'REVIEW_UNAVAILABLE') {
      // Review exigida que não pôde ser concluída não vira aceite nem vira
      // reprovação permanente: nada é publicado, e a próxima tentativa
      // continua encontrando o candidate aguardando decisão.
      return reviewBlocked(
        taskId,
        verdict.code,
        verdict.code,
        `review independente não pôde ser concluída: ${verdict.reason}`,
        'tornar a review independente executável ou decidir manualmente',
        ['corrigir a configuração do reviewer', 'inspecionar o candidate preparado'],
        evidencePaths,
      );
    }

    // O schema do record é a autoridade sobre a cobertura: um ACCEPT que não a
    // satisfaz não é gravado, e o candidate continua não aceito. O adapter não
    // completa nem conserta a cobertura que o reviewer deixou de declarar.
    try {
      await writeCandidateReview(paths, {
        schema_version: 1,
        task_id: taskId,
        attempt: record.attempt,
        candidate_sha: record.candidate_commit,
        finalization_record_sha256: finalizationFingerprint(record),
        validation_results_sha256: validationResultsFingerprint(record),
        reviewer_profile_id: reviewerProfile.id,
        reviewer_invocation: {
          role: 'reviewer',
          workspace_access: verdict.workspace_access as 'READ_ONLY',
          read_only_mechanism: verdict.read_only_mechanism,
          argv: [...verdict.argv],
          diversity_requirement: requirement.diversity_requirement,
          fresh_context: true,
        },
        ...(implementerGaps === null ? {} : { implementer_gaps: implementerGaps }),
        ...(verdict.coverage === null ? {} : { coverage: verdict.coverage }),
        decision: verdict.outcome,
        reason: verdict.reason,
        decided_at: new Date().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      return reviewBlocked(
        taskId,
        'REVIEW_COVERAGE_INSUFFICIENT',
        'REVIEW_COVERAGE_INSUFFICIENT',
        `veredito de review não satisfaz o contrato de cobertura: ${error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
        'refazer a review com cobertura explícita antes de qualquer promoção',
        ['inspecionar o candidate preparado', 'inspecionar a evidência de validação'],
        evidencePaths,
      );
    }

    if (verdict.outcome === 'ACCEPT') {
      const report = reportFor(taskId);
      if (report !== undefined) {
        report.review = { ...report.review, outcome: 'ACCEPT', reason: verdict.reason };
      }
      return { status: 'ACCEPTED', reason: verdict.reason };
    }
    return reviewBlocked(
      taskId,
      'REVIEW_REJECTED',
      'REJECT',
      `review independente não aceitou a mudança: ${verdict.reason}`,
      'decidir sobre a mudança reprovada pela review independente',
      ['inspecionar o candidate e a evidência preservada', 'reabrir a task explicitamente'],
      evidencePaths,
    );
  }

  const acceptance: ValidatedCandidateAcceptancePolicy = {
    requirementFor: reviewRequirementFor,
    async review(request): Promise<ValidatedCandidateAcceptance> {
      const decision = await reviewValidatedCandidate(request);
      return decision.status === 'ACCEPTED'
        ? { outcome: 'ACCEPT', reason: decision.reason }
        : {
            outcome: 'BLOCKED',
            code: decision.code,
            reason: decision.human_required.why_automation_stopped,
          };
    },
  };

  /**
   * OPERATIONAL PLANE: fatos que o control plane já tem em mãos, gravados
   * ANTES e INDEPENDENTEMENTE da materialização canônica. Nenhum deles é
   * pedido ao worker, nenhum depende de score, qualification ou index.
   */
  async function recordOperationalAttempt(
    observation: WorkUnitObservation,
    report: ProjectWorkUnitReport,
    telemetry: { status: 'OK' | 'OBSERVABILITY_DEGRADED'; reason: string | null },
  ): Promise<void> {
    const profile = profiles.get(observation.profileId);
    const launch = await readLaunchRecord(paths, observation.taskId).catch(() => null);
    const capability = profile === undefined ? null : capabilityInputOf(profile);
    const [completion, finalization] = await Promise.all([
      readCompletion(paths, observation.taskId).catch(() => null),
      readOrchestratedFinalization(paths, observation.taskId, observation.attempt).catch(() => null),
    ]);
    const written = await writeOperationalAttempt(paths, {
      schema_version: OPERATIONAL_ATTEMPT_SCHEMA_VERSION,
      task_id: observation.taskId,
      attempt: observation.attempt,
      attempt_role: report.attempt_role,
      profile_id: observation.profileId,
      provider: capability?.agent ?? 'unknown',
      model: capability?.model ?? null,
      effort: capability?.reasoning_effort ?? null,
      started_at: launch?.started_at ?? null,
      finished_at: launch?.finished_at ?? null,
      duration_ms: launch?.duration_ms ?? null,
      exit_code: launch?.exit_code ?? null,
      timed_out: launch?.timed_out ?? null,
      // Equivalência estimada pela CLI é o único número disponível sem fonte
      // autoritativa; ausência continua UNKNOWN, nunca zero.
      usage_tokens: null,
      candidate_commit: finalization?.candidate_commit ?? null,
      changed_files:
        finalization?.changed_files ?? completion?.orchestrator_evidence.changed_files ?? null,
      validation_outcome: report.validation_outcome,
      repair_source_attempt: null,
      escalated_from_profile_id: escalatedProfileByTask.get(observation.taskId) ?? null,
      human_intervention: humanGate?.why_automation_stopped ?? null,
      telemetry_status: telemetry.status,
      telemetry_reason: telemetry.reason,
      observed_at: (input.now?.() ?? new Date()).toISOString(),
    });
    report.telemetry_status = telemetry.status;
    report.telemetry_reason = telemetry.reason;
    report.operational_attempt_path = written
      ? operationalAttemptPath(paths, observation.taskId, observation.attempt)
      : null;
  }

  async function afterWorkUnit(observation: WorkUnitObservation): Promise<WorkUnitFollowUp> {
    const report = active ?? workUnits.at(-1);
    if (report === undefined) return { status: 'CONTINUE' };
    report.validation_outcome = observation.closeKind ?? observation.launch;

    // FRONTEIRA 2I/2K: a materialização canônica é BENCHMARK-STYLE — envelope,
    // record, comparable facts, evaluation, score, qualification, manifests,
    // index e binding. Ela é valiosa e continua acontecendo, mas deixou de ser
    // pré-condição do progresso: uma work unit já validada e já aceita não
    // pode perder a run porque um registro secundário de aprendizado falhou.
    //
    // A exceção que continua fail-closed está fora daqui: evidência de
    // segurança, billing, autorização, integridade da base e identidade do
    // candidate nunca passou por este caminho.
    let telemetry: { status: 'OK' | 'OBSERVABILITY_DEGRADED'; reason: string | null } = {
      status: 'OK',
      reason: null,
    };
    try {
      await materializeObservedAttempt(observation, report);
    } catch (error) {
      telemetry = {
        status: 'OBSERVABILITY_DEGRADED',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    await recordOperationalAttempt(observation, report, telemetry);

    // A review já aconteceu — na FRONTEIRA DE ACEITAÇÃO, antes de o candidate
    // virar PASS. Aqui só resta propagar o gate humano que ela produziu.
    if (blockedReview !== null) {
      return { status: 'HUMAN_REQUIRED', human_required: blockedReview };
    }
    if (observation.closeKind === 'PASS' && !report.review.required) {
      report.review = {
        ...report.review,
        outcome: 'NOT_REQUIRED',
        reason: 'policy não exigiu review independente',
      };
    }
    return { status: 'CONTINUE' };
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
      preflights.push(escalationPreflightOf(candidate, await launchFactsFor(candidate)));
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
    previewNextAction,
    afterWorkUnit,
    onRepairExhausted,
    acceptance,
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

/** Reexportado para o CLI publicar o estado da task sem reabrir `state.ts`. */
export async function taskStatusOf(paths: HarnessPaths, taskId: string): Promise<string> {
  return getTaskState(await readState(paths), taskId).status;
}
