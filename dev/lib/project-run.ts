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
 * qual previsão de runtime, se a review é exigida, o que um FAIL significa
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
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from './canonical.js';

import {
  ProjectIntakeRequest,
  ExecutionAuthorizationScope,
} from '../../src/intake/index.js';
import { inspectRepository, type ProjectInspection } from '../../src/inspection/index.js';
import { assessExecution } from '../../src/planner/assess.js';
import { PlannedTask, type TaskRisk } from '../../src/planner/task.js';
import { evaluatePlanWorkflow } from '../../src/planner/validate.js';
import { resolveDataDir } from '../../src/project/index.js';
import { resolveProfileIdentity } from '../../src/providers/index.js';
import type { PoolCapacityObservation } from '../../src/quota/index.js';
import { AttemptRole } from '../../src/performance/attempt-facts.js';
import { InterventionType, type InterventionRecord } from '../../src/schemas/index.js';
import type { PerformanceHistoryQueryResultV2 } from '../../src/performance/query.js';
import { redactString } from '../../src/storage/index.js';
import {
  CapabilityRegistry,
  capabilityOf,
  decideEscalation,
  EvidenceBalanceFacts,
  providerFactsOf,
  routeInitialProfileWithHistory,
  type EscalationAuthorization,
  type EscalationCandidatePreflight,
  type EscalationExecutionPolicy,
  type EscalationLadder,
  type HistoryInformedRoutingResult,
  type ProfileCapabilityInput,
  type QuotaHeadroom,
  type RoutingCandidate,
  type SelectionEvidence,
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
  collectCurrentLaunchFacts,
  currentQuotaHeadroomByPool,
  escalationPreflightOf,
  evidenceOf,
  type LaunchFact,
  type LaunchFactEvidence,
  type ProjectLaunchFacts,
} from './project-preflight.js';
import {
  createProductionPoolCapacityProbe,
  observeEligiblePoolCapacities,
  type PoolCapacityLaunchContext,
  type PoolCapacityProbe,
} from './pool-capacity-observer.js';
import {
  isRetryableReviewerInvocationFailure,
  isRetryableReviewerUnavailability,
  selectReviewerProfileForFreshCapacity,
  type ReviewerFailureDomain,
  type ReviewerUnavailabilityCause,
} from './reviewer-capacity.js';
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
  toTechnicalBlockedOutput,
  type EnvironmentReadinessGate,
  type ProjectLifecyclePathName,
  type ProjectReviewResult,
  type ProviderRoleInvocationPort,
} from './project-orchestrate.js';
import type { LabProgressListener, LabProgressQuota } from './lab-progress.js';
import { resolveImpliedHumanGatedFromRuntime } from './human-gated-intent.js';
import { machineSafetyCeiling } from './machine-safety.js';
import {
  OPERATIONAL_ATTEMPT_SCHEMA_VERSION,
  operationalAttemptPath,
  writeOperationalAttempt,
} from './operational-attempt.js';
import {
  materializeCanonicalProjectAttempt,
  observedTokensOf,
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
  listReviewParseFailures,
  readPacket,
  readProjectHistoryBinding,
  readReviewRejectionClassification,
  readReviewRejectedAttempt,
  readValidationFailedAttempt,
  reportPath,
  validationFailedAttemptPath,
  writeCandidateReview,
  writeReviewParseFailure,
  writeReviewRejectionClassification,
} from './records.js';
import type {
  CandidateReviewFocusedContext,
  CandidateReviewRequirement,
  OrchestratedFinalizationRecord,
  ReviewParseFailureRecord,
} from './schemas.js';
import { isHandoffDraftV2, readHandoffConfidence } from './schemas.js';
import { retryFailedAttempt, retryReviewRejectedAttempt } from './retry-failed.js';
import {
  type ControlPlaneHalt,
  type HumanAuthority,
  type TechnicalBlocker,
  createHumanRequired,
  createTechnicalBlocked,
} from './control-plane-halt.js';
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
      // Um worker falso não tem upstream: nenhuma identidade é fabricada para
      // ele, e o routing o vê degradar para o próprio scaffold declarado.
      provider_identity: null,
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
  // Identidade upstream normalizada. Um perfil legado cuja combinação não tem
  // contrato declarado permanece `null` — a semântica antiga continua valendo
  // para ele, e nenhuma autorização de cobrança é remapeada por inferência.
  const resolution = resolveProfileIdentity({
    profile_id: profile.id,
    agent: profile.agent,
    billing_mode: profile.billing_mode,
    model: facts.model,
    declared_provider: profile.provider,
  });
  return {
    profile_id: profile.id,
    agent: profile.agent,
    provider_identity: resolution.outcome === 'IDENTIFIED' ? resolution.identity : null,
    capability_prior: profile.capability_prior ?? null,
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
  /**
   * Quem realmente decidiu. `HISTORY` significa que uma série comparável
   * dominou; `COLD_START` significa que a história não decidiu e a escolha
   * saiu do desempate declarado pela policy.
   */
  readonly decision_mode: 'HISTORY' | 'COLD_START';
  /** Desempate entre profiles igualmente suficientes; `null` quando a história decidiu. */
  readonly selection: SelectionEvidence | null;
  /** Dimensões de utilidade que ficaram fora da comparação por UNKNOWN observado. */
  readonly dimensions_omitted: HistoryInformedRoutingResult['evidence']['dimensions_omitted'];
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

function progressQuotaOf(capacity: PoolCapacityObservation | null): LabProgressQuota {
  if (capacity === null) {
    return { status: 'UNKNOWN', reason: 'pool sem observação de capacidade neste assessment' };
  }
  if (capacity.status === 'UNKNOWN') {
    return { status: 'UNKNOWN', reason: `${capacity.reason} (${capacity.source})` };
  }
  if (capacity.status === 'EXHAUSTED') {
    return { status: 'EXHAUSTED', reason: `${capacity.reason} (${capacity.source})` };
  }
  return {
    status: 'OBSERVED',
    windows: capacity.windows.map((window) => ({
      window_id: window.window_id,
      used_pct: window.used_percent,
      remaining_pct: window.remaining_percent,
      consumed_pp: null,
      precision: window.precision === 'CURRENCY' ? null : window.precision,
      resets_at: window.resets_at,
    })),
    balance: capacity.balance,
    source: capacity.source,
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

/**
 * PREVISÃO e OBSERVAÇÃO lado a lado. `predicted_ms` é hipótese; `observed_ms` é
 * fato, preenchido depois do término. O erro de previsão é telemetria pura:
 * ele nunca muda PASS/FAIL, nunca rejeita profile e nunca encerra worker.
 */
export interface ProjectRuntimeForecastReport {
  readonly predicted_ms: number;
  readonly authority: 'ADVISORY';
  readonly source: string;
  /** `null` até o worker terminar. */
  observed_ms: number | null;
  absolute_prediction_error_ms: number | null;
  relative_prediction_error: number | null;
  observed_to_predicted_ratio: number | null;
  /** Teto de segurança de MÁQUINA sob o qual o worker roda; não é budget. */
  readonly machine_safety_ceiling_seconds: number;
  readonly machine_safety_ceiling_provenance: string;
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
  readonly runtime_forecast: ProjectRuntimeForecastReport;
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
  /**
   * A parada do control plane: `HUMAN_REQUIRED` com autoridade nomeada, ou
   * `BLOCKED` com blocker técnico tipado. Substitui `human_gate`, que dava a
   * TODA parada a aparência de decisão humana.
   */
  readonly halt: ControlPlaneHalt | null;
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
      /** Snapshot do assessment e observer pós-execução do mesmo pool. */
      readonly pool_capacity: PoolCapacityLaunchContext;
    }
  | { readonly outcome: 'HALT'; readonly halt: ControlPlaneHalt };

/**
 * Parada ainda NÃO publicada: descrição pura, sem efeito em memória.
 *
 * O discriminante `authority`/`blocker` é obrigatório justamente para que
 * nenhuma descrição de parada possa ser escrita sem dizer, ali mesmo, se
 * existe autoridade humana ou se o caso é um defeito técnico.
 */
type WorkUnitGate = {
  readonly incidentId: string;
  readonly decisionNeeded: string;
  readonly why: string;
  readonly options: readonly string[];
  readonly evidencePaths: readonly string[];
} & (
  | { readonly authority: HumanAuthority; readonly blocker?: undefined }
  | { readonly blocker: TechnicalBlocker; readonly authority?: undefined }
);

/** Resultado da avaliação read-only compartilhada por runtime real e preview. */
interface WorkUnitAssessment {
  readonly outcome: 'LAUNCH' | 'HALT';
  readonly gate: WorkUnitGate | null;
  /** `null` quando a avaliação parou antes de existir uma work unit avaliada. */
  readonly report: ProjectWorkUnitReport | null;
  readonly selectedProfileId: string | null;
  readonly selectedCapacity: PoolCapacityObservation | null;
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
  readonly status: 'READY' | 'HALT';
  /**
   * QUE TIPO de parada o runtime real tomaria. O dry-run precisa provar a
   * decisão real, e "existe autoridade humana" contra "é defeito técnico" é
   * exatamente a parte da decisão que este PR passou a distinguir.
   */
  readonly halt_status: 'HUMAN_REQUIRED' | 'BLOCKED' | null;
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
    readonly runtime_forecast: ProjectRuntimeForecastReport;
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
  | { readonly status: 'REPAIR_READY'; readonly task_id: string; readonly source_attempt: number }
  | { readonly status: 'HALT'; readonly halt: ControlPlaneHalt };

/**
 * Decisão da autoridade de review sobre UM candidate preparado e validado.
 * `HUMAN_REQUIRED` cobre REJECT, review indisponível e veredito não amarrado
 * ao candidate: para a promoção as três são a mesma coisa — não aceito.
 */
export type CandidateAcceptanceDecision =
  | { readonly status: 'ACCEPTED'; readonly reason: string }
  | { readonly status: 'REPAIRABLE'; readonly reason: string }
  | {
      readonly status: 'HALT';
      readonly code: string;
      readonly halt: ControlPlaneHalt;
    };

export type RepairExhaustedFollowUp =
  | { readonly status: 'ESCALATED'; readonly profile_id: string }
  | { readonly status: 'HALT'; readonly halt: ControlPlaneHalt }
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
  reconcilePendingReviewRejection(): Promise<WorkUnitFollowUp>;
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
  /** Injetável nos testes; produção usa o factory read-only normalizado. */
  readonly poolCapacityProbe?: PoolCapacityProbe;
  readonly now?: () => Date;
  /** Data root do control plane; injetável para isolar testes. */
  readonly historyLabRoot?: string;
  /** Porta read-only do reviewer; injetável para integração determinística. */
  readonly reviewerPort?: ProviderRoleInvocationPort;
  /**
   * Projeção read-only do lifecycle. O control plane EMITE; o listener não
   * devolve nada e não tem porta de volta para decisão, state ou provider.
   */
  readonly onProgress?: LabProgressListener;
}

/**
 * Worker runtime budget do REVIEWER, derivado do envelope DECLARADO na
 * autorização da run. Declarado, e não roteado, de propósito: a review de um
 * candidate precisa ser decidível também por um processo que reabriu o runtime
 * depois de um crash, onde nenhuma decisão de routing em memória existe. O
 * mesmo número nos dois caminhos é o que faz a retomada não ser um segundo
 * regime de execução.
 */
export async function createProjectControlPlane(
  input: CreateProjectControlPlaneInput,
): Promise<ProjectControlPlane> {
  const { paths, loaded, authorization } = input;
  const inspect = input.inspect ?? ((repoRoot: string) => inspectRepository({ repoRoot }));
  const historyLabRoot = input.historyLabRoot ?? resolveHarnessInstallationRoot();
  const poolCapacityProbe =
    input.poolCapacityProbe ??
    createProductionPoolCapacityProbe({
      paths,
      ...(input.now === undefined ? {} : { now: input.now }),
    });

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

  /** Concentração OBSERVADA por provider nesta run: launches já decididos. */
  const launchesByProvider = new Map<string, number>();
  const registry = new CapabilityRegistry(
    [...profiles.values()].map((profile) => capabilityOf(capabilityInputOf(profile))),
  );

  const scope: ExecutionAuthorizationScope = ExecutionAuthorizationScope.parse({
    schema_version: 1,
    requested_scope: authorization.requested_scope,
    autonomous_execution_boundary: authorization.autonomous_execution_boundary,
    human_gated_capabilities: authorization.human_gated_capabilities,
  });
  const impliedHumanGated = await resolveImpliedHumanGatedFromRuntime(paths.devDir, scope);

  const ladderSteps = [...authorization.profile_policy.profiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  );

  const workUnits: ProjectWorkUnitReport[] = [];
  const escalations: ProjectEscalationReport[] = [];
  const escalatedProfileByTask = new Map<string, string>();
  const priorAuthorizations: EscalationAuthorization[] = [];
  /** Relatório da work unit em curso — o único estado por-launch do control plane. */
  let active: ProjectWorkUnitReport | null = null;
  let controlPlaneHalt: ControlPlaneHalt | null = null;
  /**
   * Exigência de review POR TASK, decidida uma vez em `beforeWorkUnit` e
   * consumida pela finalização do mesmo attempt. Fica num mapa por task, e não
   * só na work unit ativa, porque quem pergunta é a primitive de finalização —
   * que só conhece o `task_id`.
   */
  const reviewRequirementByTask = new Map<string, CandidateReviewRequirement>();
  /** Gate humano do último candidate recusado pela review, lido por `afterWorkUnit`. */
  let blockedReview: ControlPlaneHalt | null = null;
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
  async function launchFactsFor(
    profile: LauncherProfile,
    /**
     * Snapshot já observado por ESTA decisão imediata. Passá-lo é a única
     * forma autorizada de não reprobar: dentro de um mesmo assessment, dois
     * profiles do MESMO pool leem a MESMA medição. Ausente, esta atividade faz
     * a sua própria leitura fresca — nunca herda a de outra work unit.
     */
    observed?: ReadonlyMap<string, PoolCapacityObservation>,
  ): Promise<ProjectLaunchFacts> {
    return collectCurrentLaunchFacts({
      paths,
      profile,
      probe: poolCapacityProbe,
      poolOf: (item) => quotaPoolOf(item.id),
      ...(observed === undefined ? {} : { observed }),
      ...(input.credentialRunner === undefined ? {} : { runner: input.credentialRunner }),
    });
  }

  /** Provider (agent) de um profile da policy; `null` fora dela. */
  /**
   * UPSTREAM de um profile, não o executável. `providerFactsOf` degrada para
   * `scaffold:<agent>` quando o profile não tem identidade normalizada — o que
   * preserva o comportamento histórico dos perfis legados sem nunca agrupar
   * dois scaffolds distintos por engano.
   */
  function providerOf(profileId: string): string | null {
    const capability = registry.get(profileId);
    return capability === undefined ? null : providerFactsOf(capability).provider;
  }

  /** POOL de quota de um profile: a chave de capacidade, não de diversidade. */
  function quotaPoolOf(profileId: string): string | null {
    const capability = registry.get(profileId);
    return capability === undefined ? null : providerFactsOf(capability).quota_pool;
  }

  /**
   * Amostragem comparável POR PROFILE e POR PROVIDER, concentração nesta run e
   * folga de quota ATUAL. Zero amostras é um FATO — é justamente o fato que a
   * política de cold-start precisa para preferir adquirir a evidência que
   * falta. Quota ausente permanece UNKNOWN e simplesmente não desempata.
   *
   * As duas histórias não se confundem: a de DESEMPENHO continua inteira e
   * decide qualidade; a de QUOTA não entra aqui de forma alguma.
   */
  async function evidenceBalanceFactsOf(
    eligible: readonly string[],
    history: PerformanceHistoryQueryResultV2,
    quotaHeadroom: Readonly<Record<string, QuotaHeadroom>>,
  ): Promise<EvidenceBalanceFacts> {
    const profileSamples: Record<string, number> = Object.fromEntries(
      eligible.map((profileId) => [profileId, 0]),
    );
    const providerSamples: Record<string, number> = {};
    for (const profileId of eligible) {
      const provider = providerOf(profileId);
      if (provider !== null) providerSamples[provider] = providerSamples[provider] ?? 0;
    }
    for (const series of history.series) {
      const profileId = series.identity.profile.profile_id.value;
      if (profileId === 'UNKNOWN' || profileSamples[profileId] === undefined) continue;
      const observed = series.routing_aggregations.trials.sample_size;
      profileSamples[profileId] = (profileSamples[profileId] ?? 0) + observed;
      const provider = providerOf(profileId);
      if (provider !== null) providerSamples[provider] = (providerSamples[provider] ?? 0) + observed;
    }
    const runLaunches: Record<string, number> = {};
    for (const provider of Object.keys(providerSamples)) {
      runLaunches[provider] = launchesByProvider.get(provider) ?? 0;
    }
    return EvidenceBalanceFacts.parse({
      profile_sample_sizes: profileSamples,
      provider_sample_sizes: providerSamples,
      run_launches_by_provider: runLaunches,
      quota_headroom_by_pool: quotaHeadroom,
      provenance: [
        'PerformanceHistoryQueryResultV2.series[].routing_aggregations.trials.sample_size',
        'launches já decididos por este control plane nesta run',
        'observação read-only FRESCA por POOL, feita nesta atividade; nenhum LaunchRecord anterior participa',
      ],
    });
  }

  function candidatesFor(eligible: readonly string[]): RoutingCandidate[] {
    return eligible.map((id) => {
      const provenance = provenances.get(id) as ProfileProvenance;
      return {
        profile_id: id,
        availability: {
          value: true,
          provenance: `profile carregado do catálogo do harness (${provenance.source_file})`,
        },
      };
    });
  }

  /**
   * PONTO ÚNICO de publicação de uma parada do control plane. Nenhum caller
   * monta um halt à mão: `gate.authority` ou `gate.blocker` decide o tipo, e o
   * construtor central valida a autoridade contra o enum fechado.
   */
  function publishHalt(gate: WorkUnitGate): ControlPlaneHalt {
    const body = {
      incident_id: gate.incidentId,
      decision_needed: gate.decisionNeeded,
      why_automation_stopped: gate.why,
      options: [...gate.options],
      evidence_paths: [...gate.evidencePaths],
    };
    const output =
      gate.authority === undefined
        ? createTechnicalBlocked({ blocker: gate.blocker, ...body })
        : createHumanRequired({ human_authority: gate.authority, ...body });
    controlPlaneHalt = output;
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
   * `controlPlaneHalt` pertencem exclusivamente ao chamador com efeitos.
   */
  /** `null` quando o runtime ainda não tem state — não é erro, é ausência. */
  async function readStateIfInitialized(
    target: HarnessPaths,
  ): Promise<Awaited<ReturnType<typeof readState>> | null> {
    try {
      return await readState(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * Escopo FOCADO herdado do REJECT que autorizou este bounded repair.
   *
   * Um repair depois de review REJECT não merece outra review geral: a review
   * geral já aconteceu sobre a mesma work unit, e repeti-la é exatamente o
   * mecanismo que move a definição de pronto indefinidamente. O que a segunda
   * review precisa decidir é bem menor e vem inteiro de records duráveis —
   * nunca de transcript nem do raciocínio do reviewer anterior.
   *
   * `null` significa "sem REJECT anterior": repair de validação oficial, ou
   * primeiro attempt. Nesse caso a review, se exigida, é GENERAL.
   */
  async function focusedReviewScopeFor(
    request: WorkUnitRequest,
    acceptance: readonly string[],
  ): Promise<CandidateReviewFocusedContext | null> {
    // Dry-run e pré-inicialização não têm state: sem attempt registrado não
    // existe REJECT pendente, e adivinhar um seria inventar exigência.
    const state = await readStateIfInitialized(paths);
    if (state === null) return null;
    const taskState = getTaskState(state, request.taskId);
    // Caminha para trás como os demais consumidores de lifecycle records: um
    // attempt INFRA ou uma falha de validação NO MEIO não resolve o REJECT
    // anterior, e perder o rastro ali seria perder exatamente a exigência que
    // este escopo existe para carregar. Um ACCEPT durável encerra a busca.
    let rejected: Awaited<ReturnType<typeof readReviewRejectedAttempt>> = null;
    for (let attempt = taskState.attempts; attempt >= 1; attempt -= 1) {
      const accepted = await readCandidateReview(paths, request.taskId, attempt);
      if (accepted?.decision === 'ACCEPT') break;
      rejected = await readReviewRejectedAttempt(paths, request.taskId, attempt);
      if (rejected !== null) break;
    }
    if (rejected === null) return null;
    const blockingFindings = rejected.blocking_findings ?? [];
    const impacted = [
      ...new Set([
        ...blockingFindings.flatMap((finding) => finding.impacted_files ?? []),
        ...rejected.changed_files,
      ]),
    ];
    const relevantAcceptance = [
      ...new Set(
        blockingFindings.flatMap((finding) =>
          finding.acceptance_criterion === undefined ? [] : [finding.acceptance_criterion],
        ),
      ),
    ];
    return {
      source_attempt: rejected.attempt,
      rejected_candidate_sha: rejected.candidate_sha,
      rejection_disposition: 'IMPLEMENTATION_DEFECT',
      original_review_sha256: rejected.review_record_sha256,
      original_finalization_sha256: rejected.finalization_record_sha256,
      // Findings estruturados são a formulação mais precisa do que reprovou;
      // o reason textual é o fallback dos vereditos sem contrato de findings.
      blocking_finding:
        blockingFindings.length === 0
          ? rejected.review_reason
          : blockingFindings.map((finding) => finding.summary).join('; '),
      ...(blockingFindings.length === 0 ? {} : { blocking_findings: blockingFindings }),
      impacted_files: impacted,
      relevant_acceptance: relevantAcceptance.length === 0 ? [...acceptance] : relevantAcceptance,
    };
  }

  async function assessWorkUnit(request: WorkUnitRequest): Promise<WorkUnitAssessment> {
    const blocked = (gate: WorkUnitGate): WorkUnitAssessment => ({
      outcome: 'HALT',
      gate,
      report: null,
      selectedProfileId: null,
      selectedCapacity: null,
      reviewRequirement: null,
      history: null,
      materialization: null,
    });

    const planTask = loaded.byId.get(request.taskId);
    if (planTask === undefined) {
      // Plano e runtime discordam sobre quais tasks existem: incoerência de
      // configuração, não autorização que alguém precise conceder.
      return blocked({
        blocker: 'RUNTIME_CONFIGURATION_INVALID',
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
        blocker: 'RUNTIME_CONFIGURATION_INVALID',
        incidentId: `project:${request.taskId}:workflow`,
        decisionNeeded: 'revisar a work unit antes de novo launch',
        why: `workflow de ${request.taskId} não pôde ser avaliado`,
        options: ['revisar o PlanFile', 'revisar a classificação declarada'],
        evidencePaths: [paths.planFile],
      });
    }
    // Repair e escalation descrevem COMO o candidate foi produzido. A review
    // continua derivada somente dos fatos concretos do candidate/task atual.
    // Um REJECT de defeito de implementação ainda NÃO verificado é fato
    // concreto da task, não do jeito como o candidate foi produzido: enquanto
    // ninguém provar que o defeito bloqueante foi corrigido, ele continua
    // exigindo review — mesmo que o assessment do attempt seguinte, com outra
    // inspeção fresca, deixe de encontrar razão própria.
    const focusedScope = await focusedReviewScopeFor(request, planTask.acceptance);
    const decision = combineWorkflowAndReview(
      workflow,
      assessment.review_requirement,
      focusedScope === null ? null : { source_attempt: focusedScope.source_attempt },
    );
    const environment = evaluateEnvironmentReadiness(assessment.environment_readiness);

    const requestedPin = request.pinnedProfileId ?? escalatedProfileByTask.get(request.taskId) ?? null;
    if (requestedPin !== null && !profiles.has(requestedPin)) {
      // AQUI existe autoridade humana de verdade: o runtime exige um profile
      // que a policy autorizada não contém, e só o operador amplia a policy.
      return blocked({
        authority: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
        incidentId: `project:${request.taskId}:profile-outside-policy`,
        decisionNeeded: 'usar somente profiles da policy autorizada',
        why: `profile ${requestedPin} exigido pelo runtime está fora da profile policy ${authorization.profile_policy.id}`,
        options: ['declarar o profile na policy', 'rerodar sem o pin de profile'],
        evidencePaths: [input.authorizationFile],
      });
    }

    // Snapshot por POOL e por ASSESSMENT, sobre TODA a policy. Um pin cujo pool
    // está EXHAUSTED não pode esconder alternativas já autorizadas — isso
    // transformaria INFRA temporária em HUMAN_REQUIRED de "ampliar policy".
    const freshCapacityByPool = await observeEligiblePoolCapacities(
      [...profiles.values()],
      poolCapacityProbe,
      (profile) => quotaPoolOf(profile.id),
    );
    const currentCapacityByPool = currentQuotaHeadroomByPool(freshCapacityByPool);

    let pinned = requestedPin;
    if (pinned !== null) {
      const pinPool = quotaPoolOf(pinned);
      const pinCapacity = pinPool === null ? null : (freshCapacityByPool.get(pinPool) ?? null);
      if (pinCapacity?.status === 'EXHAUSTED') {
        pinned = null;
      }
    }
    const eligible = pinned === null ? [...profiles.keys()] : [pinned];
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

    // FATOS de aquisição de evidência. Amostragem sai da história canônica de
    // DESEMPENHO, concentração sai dos launches desta run e headroom sai
    // EXCLUSIVAMENTE do snapshot fresco acima. História de quota não entra:
    // ela descreve consumo passado, não capacidade agora.
    const selectionPolicy = authorization.profile_policy.selection_policy;
    const evidenceBalance = await evidenceBalanceFactsOf(
      eligible,
      history,
      currentCapacityByPool,
    );
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
      selection_policy: selectionPolicy,
      evidence_balance: evidenceBalance,
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
          : 'routing não produziu profile executável';
      // Nenhum profile elegível AGORA. Isto NÃO é autoridade humana: a causa
      // pode ser quota temporariamente esgotada, classificação da work unit ou
      // um candidate inválido — e todas se resolvem sem ampliar autorização.
      return blocked({
        blocker: 'NO_ELIGIBLE_EXECUTOR',
        incidentId: `project:${request.taskId}:routing`,
        decisionNeeded: 'corrigir a elegibilidade de routing antes de novo launch',
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
        authority: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
        incidentId: `project:${request.taskId}:profile-outside-policy`,
        decisionNeeded: 'usar somente profiles da policy autorizada',
        why: `profile ${selectedProfileId} exigido pelo runtime está fora da profile policy ${authorization.profile_policy.id}`,
        options: ['declarar o profile na policy', 'rerodar sem o pin de profile'],
        evidencePaths: [input.authorizationFile],
      });
    }

    // A previsão de runtime entra no relatório e PARA POR AÍ. Nada abaixo a
    // compara com bound nenhum: um forecast alto não bloqueia a work unit, não
    // rejeita o profile já escolhido por capability e não vira deadline.
    const predictedRuntimeMs = routingDecision.execution_runtime_forecast.predicted_runtime_ms;
    const ceiling = machineSafetyCeiling();

    // Fatos honestos, coletados pelas primitives canônicas imediatamente antes
    // do gate. Nenhum é afirmado por conveniência: o que não puder ser sabido
    // sem chamar provider permanece UNKNOWN, e a policy de UNKNOWN vive em
    // `authorizeProjectLaunch`, não aqui.
    const selectedPool = quotaPoolOf(selectedProfileId);
    const selectedCapacity =
      selectedPool === null ? null : (freshCapacityByPool.get(selectedPool) ?? null);
    // O MESMO snapshot que roteou vira o fato de quota do launch: é a mesma
    // decisão imediata, então reobservar aqui seria uma requisição duplicada.
    const facts = await launchFactsFor(profile, freshCapacityByPool);
    const launchAuthorization = authorizeProjectLaunch({
      scope,
      capability: request.attemptKind === 'REPAIR' ? 'BOUNDED_REPAIR' : 'CONFIGURED_SUBSCRIPTION_WORKER',
      billing_mode: profile.billing_mode,
      quota: facts.quota,
      credential: facts.credential,
      risk: assessment.risk.value,
      worker_owns_commit: profile.commit_owner !== 'orchestrator',
      worker_owns_official_validation: profile.official_validation_owner !== 'orchestrator',
      ...(impliedHumanGated.length === 0 ? {} : { implied_human_gated: impliedHumanGated }),
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
          schema_version: 2,
          required: true,
          reviewer_profile_id: reviewerProfileId,
          diversity_requirement: decision.diversity_requirement,
          policy_provenance: `assessment.review_requirement + ${input.authorizationFile}`,
          // Observabilidade determinística: a review obrigatória sempre sabe
          // dizer QUAL fato concreto de policy a tornou obrigatória.
          reasons: [
            ...assessment.review_requirement.reasons,
            ...(focusedScope === null
              ? []
              : [`unresolved_review_reject=attempt ${focusedScope.source_attempt}`]),
          ],
          mode: focusedScope === null ? 'GENERAL' : 'FOCUSED_REREVIEW',
          task_acceptance_sha256: canonicalSha256([...planTask.acceptance]),
          ...(focusedScope === null ? {} : { focused_review: focusedScope }),
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
        decision_mode: routed.source === 'HISTORY' ? 'HISTORY' : 'COLD_START',
        selection:
          routed.source === 'HISTORY' || routed.fallback?.outcome !== 'ROUTED'
            ? null
            : (routed.fallback.selection_evidence ?? null),
        dimensions_omitted: routed.evidence.dimensions_omitted,
        history_evidence: {
          episode_count: history.episodes.length,
          series_count: history.series.length,
          selected_series_sample_size: routed.evidence.selected_series_sample_size,
          series_considered: routed.evidence.series_considered,
        },
        rationale: [
          ...routed.rationale,
          ...(routed.fallback?.outcome === 'ROUTED' ? routed.fallback.rationale : []),
          ...(routed.fallback?.outcome === 'ROUTED'
            ? routed.fallback.candidates_considered
                .filter((candidate) => candidate.outcome === 'REJECTED')
                .map(
                  (candidate) =>
                    `${candidate.profile_id}: ${candidate.rejection_code ?? 'REJECTED'} — ${candidate.reason}`,
                )
            : []),
        ],
        ...(historyDegraded === null ? {} : { history_unreadable_reason: historyDegraded }),
      },
      runtime_forecast: {
        predicted_ms: predictedRuntimeMs,
        authority: 'ADVISORY',
        source:
          routed.source === 'HISTORY'
            ? 'M81/M82 observed duration p90'
            : 'M78 execution runtime forecast',
        observed_ms: null,
        absolute_prediction_error_ms: null,
        relative_prediction_error: null,
        observed_to_predicted_ratio: null,
        machine_safety_ceiling_seconds: ceiling.seconds,
        machine_safety_ceiling_provenance: ceiling.provenance,
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

    // As DUAS paradas de launch, separadas na origem:
    //  - autorização negada nomeia a capability human-gated que falta;
    //  - recusa técnica (quota esgotada) e ambiente não pronto não nomeiam
    //    autoridade nenhuma — consertar o ambiente e esperar o reset da janela
    //    são ações técnicas, não decisões de operador.
    const gate: WorkUnitGate | null =
      launchAuthorization.outcome === 'HUMAN_REQUIRED'
        ? {
            authority: launchAuthorization.gated_capability,
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
        : launchAuthorization.outcome === 'BLOCKED'
          ? {
              blocker: launchAuthorization.blocker,
              incidentId: `project:${request.taskId}:launch-blocked`,
              decisionNeeded: 'restabelecer capacidade de execução antes de novo launch',
              why: launchAuthorization.reason,
              options: [
                'aguardar o reset da janela de quota',
                'inspecionar a observação fresca de capacidade',
              ],
              evidencePaths: [input.authorizationFile],
            }
          : environment.outcome !== 'READY'
            ? {
                blocker: 'RUNTIME_CONFIGURATION_INVALID',
                incidentId: `project:${request.taskId}:environment`,
                decisionNeeded: 'preparar o ambiente do repositório alvo antes de novo launch',
                why: `${environment.outcome}: ${environment.reason}`,
                options: ['remediar o ambiente', 'declarar os requisitos ausentes'],
                evidencePaths: [paths.repoRoot],
              }
            : null;

    const instructionInventory = await fingerprintProjectInstructions(paths.repoRoot, inspection);
    return {
      outcome: gate === null ? 'LAUNCH' : 'HALT',
      gate,
      report,
      selectedProfileId,
      selectedCapacity,
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
      return { outcome: 'HALT', halt: publishHalt(gate as WorkUnitGate) };
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
      return { outcome: 'HALT', halt: publishHalt(gate) };
    }

    if (assessment.history !== null && !historySnapshotByTask.has(request.taskId)) {
      historySnapshotByTask.set(request.taskId, assessment.history);
    }
    if (assessment.materialization !== null) {
      materializationByTask.set(request.taskId, assessment.materialization);
    }
    await ensureEpisode(request, assessment.selectedProfileId as string);

    const selectedProfileId = assessment.selectedProfileId as string;
    const capability = registry.get(selectedProfileId);
    const selectedQuotaPool = quotaPoolOf(selectedProfileId);
    if (capability !== undefined) {
      launchesByProvider.set(capability.agent, (launchesByProvider.get(capability.agent) ?? 0) + 1);
    }
    // A decisão de routing PROJETADA: provider, model e effort são fatos que
    // só o control plane conhece autoritativamente neste instante. Emitir é
    // observação; nada abaixo lê este evento de volta.
    input.onProgress?.({
      stage: 'ROUTED',
      detail: `task=${request.taskId} profile=${selectedProfileId} source=${assessment.report.routing.source} history=${assessment.report.routing.history_status}`,
      task: {
        task_id: request.taskId,
        profile_id: selectedProfileId,
        attempt_role:
          assessment.report.attempt_role === AttemptRole.REPAIR
            ? 'repair'
            : assessment.report.attempt_role === AttemptRole.ESCALATION
              ? 'escalation'
              : 'initial',
        ...(capability === undefined
          ? {}
          : {
              provider: capability.agent,
              model: capability.model,
              reasoning_effort: capability.reasoning_effort,
              ...(selectedQuotaPool === null ? {} : { quota_pool: selectedQuotaPool }),
            }),
        quota: progressQuotaOf(assessment.selectedCapacity),
        escalated_from_profile_id: assessment.report.escalation,
      },
    });

    return {
      outcome: 'LAUNCH',
      profile_id: selectedProfileId,
      pool_capacity: {
        before: assessment.selectedCapacity,
        probe: poolCapacityProbe,
      },
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
        if (lookup.status === 'REJECTED' && lookup.record?.rejection_disposition === undefined) {
          return {
            status: 'HALT',
            // Classificar um REJECT legado é execução read-only de um
            // classificador, não autorização de ninguém.
            halt_status: 'BLOCKED',
            task_id: pending.taskId,
            blocked_by: 'REVIEW_REJECTION_CLASSIFICATION_REQUIRED',
            reason:
              'REJECT legado exige classificação read-only fresca; dry-run não chama provider nem presume disposição',
            candidate_commit: pending.candidateCommit,
            evidence_paths: [lookup.evidence_path],
            work_unit: null,
          };
        }
        if (
          lookup.status === 'REJECTED' &&
          lookup.record?.rejection_disposition === 'IMPLEMENTATION_DEFECT' &&
          authorization.autonomous_execution_boundary.includes('BOUNDED_REPAIR')
        ) {
          return {
            status: 'READY',
            halt_status: null,
            task_id: pending.taskId,
            blocked_by: 'REVIEW_REPAIR_READY',
            reason: 'próxima ação segura é arquivar o REJECT e abrir o bounded repair',
            candidate_commit: pending.candidateCommit,
            evidence_paths: [lookup.evidence_path],
            work_unit: null,
          };
        }
        return {
          status: 'HALT',
          // Só um REJECT já emitido é decisão humana; review indisponível,
          // divergente ou sem cobertura é defeito técnico.
          halt_status: lookup.status === 'REJECTED' ? 'HUMAN_REQUIRED' : 'BLOCKED',
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
        halt_status: null,
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
      status: assessment.outcome === 'LAUNCH' ? 'READY' : 'HALT',
      halt_status:
        assessment.gate === null
          ? null
          : assessment.gate.authority === undefined
            ? 'BLOCKED'
            : 'HUMAN_REQUIRED',
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
              runtime_forecast: assessment.report.runtime_forecast,
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
      const automaticReviewRepair = await readReviewRejectedAttempt(
        paths,
        observation.taskId,
        attempt,
      );
      if (automaticReviewRepair !== null) continue;
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
      // Contagem reportada pelo provider: entra na história como métrica
      // observada e é a mesma evidência que prova a inferência.
      observedTokens: observedTokensOf(launch),
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

  /**
   * Parada da autoridade de review. `kind` é obrigatório e discrimina as duas
   * causas que antes eram a mesma coisa:
   *
   *  - `authority` — o veredito humano JÁ EXISTE e reprovou por algo que só um
   *    humano decide (escopo, arquitetura, produto). Reabrir a task é decisão
   *    de operador.
   *  - `blocker` — a review não pôde ser CONCLUÍDA, ou a evidência não amarra
   *    ao candidate. Isso é defeito técnico: reviewer inexecutável, veredito
   *    ilegível, cobertura ausente, quota esgotada. Nenhuma autorização
   *    conserta, e continuar sem review nunca foi opção.
   *
   * As duas continuam fail-closed: nada é promovido em nenhum dos casos.
   * Esta função NÃO decide se review é exigida, quem revisa, nem se um REJECT
   * bloqueia — só nomeia corretamente a parada que já acontecia.
   */
  function reviewBlocked(
    taskId: string,
    kind: { readonly authority: HumanAuthority } | { readonly blocker: TechnicalBlocker },
    code: string,
    outcome: string,
    reason: string,
    decisionNeeded: string,
    options: readonly string[],
    evidencePaths: readonly string[],
  ): CandidateAcceptanceDecision {
    const report = reportFor(taskId);
    if (report !== undefined) report.review = { ...report.review, outcome, reason };
    const body = {
      incidentId: `project:${taskId}:review`,
      decisionNeeded,
      why: reason,
      options,
      evidencePaths,
    };
    const output = publishHalt(
      'authority' in kind
        ? { authority: kind.authority, ...body }
        : { blocker: kind.blocker, ...body },
    );
    blockedReview = output;
    return { status: 'HALT', code, halt: output };
  }

  async function existingEvidencePaths(candidates: readonly string[]): Promise<string[]> {
    const existing: string[] = [];
    for (const candidate of candidates) {
      try {
        await access(candidate);
        existing.push(candidate);
      } catch {
        // evidência fantasma não entra na decisão
      }
    }
    return existing;
  }

  async function persistUnparseableReviewEvidence(details: {
    readonly taskId: string;
    readonly attempt: number;
    readonly profile: LauncherProfile;
    readonly code: string;
    readonly reason: string;
    readonly stdout: string;
    readonly stderr: string | null;
    readonly parseOutcome: ReviewParseFailureRecord['parse_outcome'];
  }): Promise<string> {
    const capturedAt = (input.now?.() ?? new Date()).toISOString();
    return writeReviewParseFailure(paths, {
      schema_version: 1,
      kind: 'REVIEW_PARSE_FAILURE',
      task_id: details.taskId,
      attempt: details.attempt,
      role: 'reviewer',
      profile_id: details.profile.id,
      provider: details.profile.provider ?? details.profile.agent,
      agent: details.profile.agent,
      parse_outcome: details.parseOutcome,
      code: details.code,
      reason: details.reason,
      stdout: redactString(details.stdout),
      stderr: details.stderr === null ? null : redactString(details.stderr),
      captured_at: capturedAt,
      provenance:
        'stdout da invocação do reviewer, redigido antes da persistência; não é CandidateReviewRecord',
    });
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
    const legacyRejectedReview =
      lookup.status === 'REJECTED' && lookup.record?.rejection_disposition === undefined
        ? lookup.record
        : null;
    if (legacyRejectedReview !== null) {
      const existingClassification = await readReviewRejectionClassification(
        paths,
        taskId,
        record.attempt,
      );
      if (existingClassification !== null) {
        if (
          existingClassification.candidate_sha !== record.candidate_commit ||
          existingClassification.review_record_sha256 !== canonicalSha256(legacyRejectedReview)
        ) {
          return reviewBlocked(
   taskId,
   { blocker: 'INCONSISTENT_EVIDENCE' },
   'LEGACY_REJECTION_CLASSIFICATION_DIVERGENT',
            'REVIEW_EVIDENCE_DIVERGENT',
            'classificação persistida não corresponde ao candidate/REJECT legado',
            'reconciliar manualmente a classificação e o REJECT preservados',
            ['inspecionar os records append-only ligados por hash'],
            evidencePaths,
          );
        }
        if (existingClassification.disposition === 'IMPLEMENTATION_DEFECT') {
          return {
            status: 'REPAIRABLE',
            reason:
              `REJECT legado já classificado como defeito de implementação: ` +
              existingClassification.reason,
          };
        }
        return reviewBlocked(
   taskId,
   { authority: 'UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION' },
   'REVIEW_REJECTED_HUMAN_DECISION',
          'REJECT',
          `REJECT legado classificado como ${existingClassification.disposition}: ${existingClassification.reason}`,
          'resolver a decisão humana indicada pela classificação estruturada',
          ['inspecionar o REJECT e a classificação preservados'],
          evidencePaths,
        );
      }
    }
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
    if (lookup.status === 'REJECTED' && legacyRejectedReview === null) {
      if (lookup.record?.rejection_disposition === 'IMPLEMENTATION_DEFECT') {
        const report = reportFor(taskId);
        if (report !== undefined) {
          report.review = { ...report.review, outcome: 'REJECT', reason: lookup.reason };
        }
        return {
          status: 'REPAIRABLE',
          reason: `review independente classificou defeito de implementação: ${lookup.reason}`,
        };
      }
      return reviewBlocked(
   taskId,
   { authority: 'UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION' },
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
   { blocker: 'INCONSISTENT_EVIDENCE' },
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
   { blocker: 'INSUFFICIENT_EVIDENCE' },
   'REVIEW_COVERAGE_INSUFFICIENT',
        'REVIEW_COVERAGE_INSUFFICIENT',
        `veredito de review não satisfaz o contrato de cobertura: ${lookup.reason}`,
        'refazer a review com cobertura explícita antes de qualquer promoção',
        ['inspecionar o veredito preservado', 'inspecionar o candidate preparado'],
        evidencePaths,
      );
    }

    const requirement = lookup.requirement as CandidateReviewRequirement;
    // V1 é o requirement histórico: sem razões, sem modo e sempre GENERAL.
    const requirementV2 =
      'schema_version' in requirement && requirement.schema_version === 2 ? requirement : null;
    const pinnedReviewerId = requirement.reviewer_profile_id;
    const freshCapacityByPool = await observeEligiblePoolCapacities(
      [...profiles.values()],
      poolCapacityProbe,
      (profile) => quotaPoolOf(profile.id),
    );
    const planTask = loaded.byId.get(taskId);
    if (planTask === undefined) {
      return reviewBlocked(
   taskId,
   { blocker: 'RUNTIME_CONFIGURATION_INVALID' },
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

    const excludedProfileIds = [
      ...new Set(
        (await listReviewParseFailures(paths, taskId, record.attempt))
          .filter((entry) => isRetryableReviewerInvocationFailure(entry.code))
          .map((entry) => entry.profile_id),
      ),
    ];
    // Indisponibilidade PROVADA, e só ela, exclui reviewers. Uma falha
    // profile-local prova o profile, não o provider: nada aqui infere outage
    // mais amplo do que a evidência sustenta.
    const provenFailureDomains: ReviewerFailureDomain[] = [];
    const persistedEvidence: string[] = [];
    let lastSelectionReason = '';
    let lastSelectionCause: ReviewerUnavailabilityCause | null = null;
    let lastInvocationFailureReason: string | null = null;
    let reviewerProfile: LauncherProfile | null = null;
    let verdict: ProjectReviewResult | null = null;
    const policySize = Math.max(1, authorization.profile_policy.profiles.length);

    for (let launchIndex = 0; launchIndex < policySize; launchIndex += 1) {
      const selectedReviewer = selectReviewerProfileForFreshCapacity({
        pinnedProfileId: pinnedReviewerId,
        policyProfiles: authorization.profile_policy.profiles,
        poolOf: quotaPoolOf,
        providerOf: (profileId) => profiles.get(profileId)?.provider ?? null,
        capacityByPool: freshCapacityByPool,
        excludedProfileIds,
        unavailableFailureDomains: provenFailureDomains,
        implementerProfileId: record.profile_id,
        diversityRequirement: requirement.diversity_requirement,
      });
      lastSelectionReason = selectedReviewer.reason;
      lastSelectionCause = selectedReviewer.cause;
      if (selectedReviewer.profileId === null) {
        break;
      }
      const found = profiles.get(selectedReviewer.profileId) ?? null;
      if (found === null) {
        return reviewBlocked(
   taskId,
   { authority: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY' },
   'REVIEW_PROFILE_OUTSIDE_POLICY',
          'UNAVAILABLE',
          `a policy exigiu review independente e o reviewer ${selectedReviewer.profileId} não pertence à profile policy`,
          'declarar um reviewer elegível na profile policy',
          ['declarar review.reviewer_profile_id', 'reduzir o risco declarado'],
          [input.authorizationFile],
        );
      }
      reviewerProfile = found;
      const reviewerFacts = await launchFactsFor(reviewerProfile, freshCapacityByPool);
      verdict = await launchProjectReviewer({
        paths,
        profile: reviewerProfile,
        scope,
        implementerProfileId: record.profile_id,
        diversityRequirement: requirement.diversity_requirement as never,
        risk: classificationFor(authorization, taskId).classification.risk,
        // Os MESMOS fatos honestos do implementer, coletados agora para o
        // profile do reviewer. Review read-only não ganha autorização mais
        // fraca — e uma review que não pode ser autorizada vira
        // `REVIEW_UNAVAILABLE`, nunca ACCEPT.
        credential: reviewerFacts.credential,
        quota: reviewerFacts.quota,
        ...(impliedHumanGated.length === 0 ? {} : { implied_human_gated: impliedHumanGated }),
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
          ...(requirementV2 === null
            ? {}
            : {
                review_contract_version: 2 as const,
                review_mode: requirementV2.mode,
                review_reasons: requirementV2.reasons,
                ...(requirementV2.focused_review === undefined
                  ? {}
                  : { focused_review: requirementV2.focused_review }),
              }),
          ...(legacyRejectedReview === null
            ? {}
            : { prior_rejection_reason: legacyRejectedReview.reason }),
        },
        ...(input.reviewerPort === undefined ? {} : { port: input.reviewerPort }),
      });

      if (verdict.outcome !== 'REVIEW_UNAVAILABLE') {
        break;
      }
      // Review exigida que não pôde ser concluída não vira aceite nem vira
      // reprovação permanente. A evidência real da invocação é persistida
      // ANTES do HUMAN_REQUIRED; review.json só existe para um veredito válido.
      if (verdict.evidence !== undefined) {
        persistedEvidence.push(
          await persistUnparseableReviewEvidence({
            taskId,
            attempt: record.attempt,
            profile: reviewerProfile,
            code: verdict.code,
            reason: verdict.reason,
            stdout: verdict.evidence.stdout,
            stderr: verdict.evidence.stderr,
            parseOutcome: verdict.evidence.parse_outcome,
          }),
        );
      }
      if (isRetryableReviewerUnavailability(verdict.code)) {
        // Falha de invocação é indisponibilidade PROVADA daquele profile;
        // conflito de diversidade é policy, não falha, e continua exclusão
        // simples. Nenhum dos dois autoriza concluir nada sobre o provider.
        if (isRetryableReviewerInvocationFailure(verdict.code)) {
          provenFailureDomains.push({
            scope: 'PROFILE',
            id: reviewerProfile.id,
            status: 'PROVEN',
          });
        } else {
          excludedProfileIds.push(reviewerProfile.id);
        }
        lastInvocationFailureReason = verdict.reason;
        continue;
      }
      // Review EXIGIDA que não pôde ser concluída. O reviewer não emitiu
      // veredito: nada foi decidido, nem a favor nem contra. Isso é defeito de
      // invocação/protocolo — não existe autorização humana que o conserte, e
      // continuar sem review permanece proibido.
      //
      // A ÚNICA exceção é o launch recusado por autorização: ali a fronteira
      // humana é real e a autoridade é nomeada pela própria autorização.
      return reviewBlocked(
        taskId,
        verdict.code === 'REVIEW_LAUNCH_HUMAN_REQUIRED'
          ? { authority: 'SCOPE_EXPANSION' }
          : verdict.code === 'REVIEW_LAUNCH_QUOTA_EXHAUSTED'
            ? { blocker: 'NO_ELIGIBLE_EXECUTOR' }
            : { blocker: 'PROVIDER_OR_INFRA_FAILURE' },
        verdict.code,
        verdict.code,
        `review independente não pôde ser concluída: ${verdict.reason}`,
        'tornar a review independente executável antes de qualquer promoção',
        ['corrigir a configuração do reviewer', 'inspecionar o candidate preparado'],
        await existingEvidencePaths([...persistedEvidence, paths.validationLogsDir]),
      );
    }

    if (
      reviewerProfile === null ||
      verdict === null ||
      verdict.outcome === 'REVIEW_UNAVAILABLE'
    ) {
      if (lastInvocationFailureReason !== null) {
        return reviewBlocked(
   taskId,
   { blocker: 'PROVIDER_OR_INFRA_FAILURE' },
   'REVIEW_INVOCATION_FAILED',
          'REVIEW_INVOCATION_FAILED',
          `review independente não pôde ser concluída: ${lastInvocationFailureReason}`,
          'tornar a review independente executável ou decidir manualmente',
          ['corrigir a configuração do reviewer', 'inspecionar o candidate preparado'],
          await existingEvidencePaths([...persistedEvidence, paths.validationLogsDir]),
        );
      }
      // A causa decide o TIPO da parada, e só uma das três é autoridade
      // humana: uma policy sem nenhum profile capaz de satisfazer a
      // diversidade exigida só é resolvida por alguém ampliando a policy.
      // Pool esgotado e INFRA se resolvem no reset da janela ou no conserto.
      const diversityGap = lastSelectionCause === 'DIVERSITY_POLICY_HAS_NO_ALTERNATIVE';
      return reviewBlocked(
        taskId,
        diversityGap
          ? { authority: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY' }
          : { blocker: 'NO_ELIGIBLE_EXECUTOR' },
        'REVIEW_LAUNCH_UNAVAILABLE',
        'UNAVAILABLE',
        lastSelectionReason,
        diversityGap
          ? 'declarar na profile policy um reviewer que satisfaça a diversidade exigida'
          : 'restabelecer capacidade de review antes de qualquer promoção',
        diversityGap
          ? ['declarar outro profile na profile_policy', 'reduzir o risco declarado da work unit']
          : ['inspecionar a observação fresca de capacidade', 'aguardar o reset da quota'],
        [input.authorizationFile],
      );
    }

    if (legacyRejectedReview !== null) {
      if (verdict.outcome !== 'REJECT') {
        return reviewBlocked(
   taskId,
   { blocker: 'INCONSISTENT_EVIDENCE' },
   'LEGACY_REJECTION_CLASSIFICATION_INVALID',
          'UNAVAILABLE',
          'classificador tentou substituir o REJECT legado em vez de classificá-lo',
          'classificar a natureza do REJECT legado sem redecidir o veredito',
          ['inspecionar o REJECT preservado', 'executar classificador read-only fresco'],
          evidencePaths,
        );
      }
      await writeReviewRejectionClassification(paths, {
        schema_version: 1,
        task_id: taskId,
        attempt: record.attempt,
        candidate_sha: record.candidate_commit,
        review_record_sha256: canonicalSha256(legacyRejectedReview),
        classifier_profile_id: reviewerProfile.id,
        classifier_invocation: {
          role: 'reviewer',
          workspace_access: verdict.workspace_access as 'READ_ONLY',
          read_only_mechanism: verdict.read_only_mechanism,
          argv: [...verdict.argv],
          diversity_requirement: requirement.diversity_requirement,
          fresh_context: true,
        },
        disposition: verdict.rejection_disposition,
        reason: verdict.reason,
        classified_at: (input.now?.() ?? new Date()).toISOString(),
      });
      if (verdict.rejection_disposition === 'IMPLEMENTATION_DEFECT') {
        return {
          status: 'REPAIRABLE',
          reason: `REJECT legado classificado como defeito de implementação: ${verdict.reason}`,
        };
      }
      return reviewBlocked(
   taskId,
   { authority: 'UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION' },
   'REVIEW_REJECTED_HUMAN_DECISION',
        'REJECT',
        `REJECT legado classificado como ${verdict.rejection_disposition}: ${verdict.reason}`,
        'resolver a decisão humana indicada pela classificação estruturada',
        ['inspecionar o REJECT e a classificação preservados'],
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
        ...(verdict.findings === null ? {} : { findings: [...verdict.findings] }),
        // Modo em que o veredito nasceu, copiado do requirement que o exigiu.
        // Sem ele, o record perderia a dimensão que decide quais relationships
        // têm autoridade sobre estes findings. Requirement v1 não declara modo
        // e continua sendo GENERAL por ausência.
        ...('mode' in requirement ? { review_mode: requirement.mode } : {}),
        decision: verdict.outcome,
        ...(verdict.outcome === 'REJECT'
          ? { rejection_disposition: verdict.rejection_disposition }
          : {}),
        reason: verdict.reason,
        decided_at: new Date().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      return reviewBlocked(
   taskId,
   { blocker: 'INSUFFICIENT_EVIDENCE' },
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
    if (verdict.rejection_disposition === 'IMPLEMENTATION_DEFECT') {
      const report = reportFor(taskId);
      if (report !== undefined) {
        report.review = { ...report.review, outcome: 'REJECT', reason: verdict.reason };
      }
      return {
        status: 'REPAIRABLE',
        reason: `review independente classificou defeito de implementação: ${verdict.reason}`,
      };
    }
    return reviewBlocked(
   taskId,
   { authority: 'UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION' },
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
            code: decision.status === 'REPAIRABLE' ? 'REVIEW_REPAIRABLE' : decision.code,
            reason:
              decision.status === 'REPAIRABLE'
                ? decision.reason
                : decision.halt.why_automation_stopped,
          };
    },
  };

  async function reconcilePendingReviewRejection(): Promise<WorkUnitFollowUp> {
    const pending = await inspectPendingAcceptance({ paths, loaded });
    if (pending.status === 'NONE' || pending.review.status !== 'REJECTED') {
      return { status: 'CONTINUE' };
    }
    const disposition = pending.review.record?.rejection_disposition;
    if (disposition !== 'IMPLEMENTATION_DEFECT') {
      const decision = await reviewValidatedCandidate({
        taskId: pending.taskId,
        record: pending.record,
      });
      if (decision.status === 'HALT') {
        return { status: 'HALT', halt: decision.halt };
      }
      if (decision.status !== 'REPAIRABLE') return { status: 'CONTINUE' };
    }
    if (!authorization.autonomous_execution_boundary.includes('BOUNDED_REPAIR')) {
      // AUTORIDADE REAL: ampliar o boundary autônomo da run é do operador.
      const output = publishHalt({
        authority: 'SCOPE_EXPANSION',
        incidentId: `project:${pending.taskId}:review-repair-authorization`,
        decisionNeeded: 'autorizar explicitamente BOUNDED_REPAIR ou decidir manualmente',
        why: 'review encontrou defeito de implementação, mas a run não autoriza bounded repair',
        options: [
          'adicionar BOUNDED_REPAIR ao autonomous_execution_boundary',
          'inspecionar o candidate',
        ],
        evidencePaths: [input.authorizationFile, pending.review.evidence_path],
      });
      blockedReview = output;
      return { status: 'HALT', halt: output };
    }
    await retryReviewRejectedAttempt({
      paths,
      taskId: pending.taskId,
      reason: 'bounded repair autorizado para implementation defect rejeitado pela review',
      ...(input.now === undefined ? {} : { now: () => input.now!().toISOString() }),
    });
    return {
      status: 'REPAIR_READY',
      task_id: pending.taskId,
      source_attempt: pending.attempt,
    };
  }

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
      // Contagem reportada pelo próprio provider sobre o turno; ausência
      // continua UNKNOWN, nunca zero.
      usage_tokens: launch?.observed_tokens?.total ?? null,
      candidate_commit: finalization?.candidate_commit ?? null,
      changed_files:
        finalization?.changed_files ?? completion?.orchestrator_evidence.changed_files ?? null,
      validation_outcome: report.validation_outcome,
      repair_source_attempt: null,
      escalated_from_profile_id: escalatedProfileByTask.get(observation.taskId) ?? null,
      // Só uma parada com AUTORIDADE HUMANA conta como intervenção humana no
      // plano operacional. Um blocker técnico não é intervenção de ninguém.
      human_intervention:
        controlPlaneHalt?.status === 'HUMAN_REQUIRED'
          ? controlPlaneHalt.why_automation_stopped
          : null,
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
    await recordObservedRuntime(observation, report);

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
      return { status: 'HALT', halt: blockedReview };
    }
    const reviewRepair = await reconcilePendingReviewRejection();
    if (reviewRepair.status !== 'CONTINUE') return reviewRepair;
    if (observation.closeKind === 'PASS' && !report.review.required) {
      report.review = {
        ...report.review,
        outcome: 'NOT_REQUIRED',
        reason: 'policy não exigiu review independente',
      };
    }
    return { status: 'CONTINUE' };
  }

  /**
   * PREVISÃO vs OBSERVAÇÃO. Puramente observacional: nada aqui lê ou escreve
   * `validation_outcome`, `review` ou qualquer veredito. Uma previsão errada
   * por um fator de dez continua produzindo o mesmo PASS/FAIL — o erro é o
   * dado que vai calibrar a previsão, não uma acusação contra o worker.
   *
   * Falhar ao LER a duração observada também não muda nada: o campo continua
   * `null`, porque ausência de medição não é medição zero.
   */
  async function recordObservedRuntime(
    observation: WorkUnitObservation,
    report: ProjectWorkUnitReport,
  ): Promise<void> {
    let observedMs: number | null = null;
    try {
      const record = await readLaunchRecord(paths, observation.taskId);
      observedMs = record?.duration_ms ?? null;
    } catch {
      observedMs = null;
    }
    if (observedMs === null) return;

    const predicted = report.runtime_forecast.predicted_ms;
    report.runtime_forecast.observed_ms = observedMs;
    report.runtime_forecast.absolute_prediction_error_ms = Math.abs(observedMs - predicted);
    // Previsão zero não tem razão definida; `null` diz isso em vez de fingir.
    report.runtime_forecast.relative_prediction_error =
      predicted === 0 ? null : (observedMs - predicted) / predicted;
    report.runtime_forecast.observed_to_predicted_ratio =
      predicted === 0 ? null : observedMs / predicted;
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
    if (followUp.halt !== null) {
      controlPlaneHalt = followUp.halt;
      return { status: 'HALT', halt: followUp.halt };
    }
    if (!followUp.escalates || initialProfileId === null) {
      return { status: 'NOT_APPLICABLE', reason: followUp.rationale };
    }

    if (ladderSteps.length < 2) {
      // AUTORIDADE REAL: a ladder autorizada tem um degrau só, e ampliá-la
      // é ampliar a policy de profiles — decisão do operador.
      const output = publishHalt({
        authority: 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
        incidentId: `project:${request.taskId}:escalation`,
        decisionNeeded: 'autorizar explicitamente um profile adicional para escalar',
        why: `diagnosis CAPABILITY exige escalation, mas a policy ${authorization.profile_policy.id} declara um único profile elegível`,
        options: [
          'declarar outro profile na profile_policy',
          'aceitar o resultado do profile fixado pelo experimento',
        ],
        evidencePaths: [...evidencePaths, input.authorizationFile],
      });
      if (report !== undefined) report.escalation = 'HUMAN_REQUIRED';
      return { status: 'HALT', halt: output };
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

    // UMA decisão de escalation, UMA rodada de observação. Os degraus da ladder
    // são avaliados juntos, então os pools são lidos uma vez e compartilhados:
    // dois degraus contra a mesma conta OpenAI não geram duas requisições, e
    // nenhum deles herda a leitura de uma work unit anterior.
    const ladderCandidates = ladderSteps
      .map((entry) => profiles.get(entry.id))
      .filter((candidate): candidate is LauncherProfile => candidate !== undefined);
    const ladderCapacityByPool = await observeEligiblePoolCapacities(
      ladderCandidates,
      poolCapacityProbe,
      (profile) => quotaPoolOf(profile.id),
    );
    const preflights: EscalationCandidatePreflight[] = [];
    for (const candidate of ladderCandidates) {
      preflights.push(
        escalationPreflightOf(candidate, await launchFactsFor(candidate, ladderCapacityByPool)),
      );
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
      // O tipo da parada vem da DECISÃO de escalation, não de um default.
      // `HUMAN_REQUIRED` só chega aqui carregando a autoridade que M79 nomeou;
      // `TECHNICAL_BLOCKER` e `NO_ESCALATION` são defeitos de evidência ou
      // diagnósticos não escaláveis, e nenhum dos dois pede autorização.
      const incidentId = `project:${request.taskId}:escalation`;
      const output: ControlPlaneHalt =
        escalation.outcome === 'HUMAN_REQUIRED'
          ? toHumanRequiredOutput(escalation.human_required, incidentId)
          : escalation.outcome === 'TECHNICAL_BLOCKER'
            ? toTechnicalBlockedOutput(
                {
                  blocker: escalation.blocker,
                  classification: escalation.classification,
                  rationale: escalation.rationale,
                  evidence_paths: [...escalation.evidence_paths, ...evidencePaths],
                },
                incidentId,
              )
            : createTechnicalBlocked({
                blocker: 'INSUFFICIENT_EVIDENCE',
                incident_id: incidentId,
                decision_needed: 'inspecionar a evidência preservada da task bloqueada',
                why_automation_stopped: `escalation não aplicável: ${escalation.classification}`,
                options: ['inspecionar a evidência preservada'],
                evidence_paths: [...evidencePaths],
              });
      controlPlaneHalt = output;
      if (report !== undefined) report.escalation = output.status;
      return { status: 'HALT', halt: output };
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
    reconcilePendingReviewRejection,
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
        halt: controlPlaneHalt,
      };
    },
  };
}

/** Reexportado para o CLI publicar o estado da task sem reabrir `state.ts`. */
export async function taskStatusOf(paths: HarnessPaths, taskId: string): Promise<string> {
  return getTaskState(await readState(paths), taskId).status;
}
