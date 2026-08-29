import {
  AUTOMATIC_REPAIR_EXHAUSTED,
  AUTOMATIC_REPAIR_PROFILE_MISMATCH,
  decideAutomaticRepair,
  haltFromAutomaticRepair,
  haltFromAutomaticRepairProfile,
  reconcileAutomaticRepair,
} from './automatic-repair.js';
import { ESTIMATED_COST_LABEL } from './billing.js';
import type { ValidatedCandidateAcceptancePolicy } from './candidate-review.js';
import { closeTaskByLaunchPolicy } from './close-dispatch.js';
import { experimentFactsOf } from './doctor.js';
import { resumePendingAcceptance } from './finalize-orchestrated.js';
import { headSha } from './git.js';
import { InfraRecoveryError, recoverInfraAttempt } from './infra-recover.js';
import { withHarnessLock } from './lock.js';
import { runOrchestrationPreflight, type PreflightResult } from './orchestrate-preflight.js';
import {
  detailIteration,
  detailPreflight,
  summarizeIteration,
  summarizePreflight,
  type IterationInput,
} from './orchestrate-report.js';
import { resolveHarnessInstallationRoot, type HarnessPaths } from './paths.js';
import { isSameProcessAlive } from './process-identity.js';
import type { LoadedPlan } from './plan.js';
import type { PoolCapacityLaunchContext } from './pool-capacity-observer.js';
import { PoolCapacityObservation } from '../../src/quota/index.js';
import { loadProfile } from './profile.js';
import { writePacket } from './records.js';
import {
  InconsistentAttemptEvidenceError,
  readPreviousAttemptDiagnostics,
} from './retry-failed.js';
import {
  inspectRoutineIncident,
  ROUTINE_RECIPES,
  resolveRoutinePostLaunch,
  resolveRoutinePreflight,
  type HumanRequiredOutput,
  type RoutinePostLaunchIncident,
} from './routine-autonomy.js';
import {
  createRoutineAutonomyRuntime,
  createRoutinePostLaunchRuntime,
} from './routine-autonomy-runtime.js';
import type { ProjectControlPlane } from './project-run.js';
import type { LaunchRecord } from './schemas.js';
import { selectNextTask } from './select.js';
import type { LabProgressListener, LabProgressQuota } from './lab-progress.js';
import { ensureRuntimeDirs, getTaskState, readState } from './state.js';
import { launchTask, prepareNextTask, type LaunchStepResult } from './steps.js';

/**
 * Diagnóstico/manutenção APENAS. Pula o pre-flight automático, e com ele a
 * garantia de que maintenance, recover e readiness foram conferidos antes do
 * launch. Nenhuma execução normal de benchmark deve usar esta flag.
 */
export const SKIP_PREFLIGHT_FLAG = 'skip-preflight';

/**
 * O loop externo: next -> persistir packet -> launch (processo NOVO) -> wait ->
 * close -> PASS? continua : para. O worker nunca executa este loop; ele encerra
 * e o orquestrador decide o que vem depois.
 *
 * `--max-iterations` limita ciclos primários de tarefa, não os launches
 * internos da MESMA tarefa. Uma invocação com `--max-iterations 1` PODE
 * produzir iteration 1 = FIRST_PASS FAIL + iteration 2 = REPAIR + iteration 3 =
 * escalation autorizada, sem lançar a próxima tarefa do plano: os três são
 * tentativas de concluir a mesma unidade de trabalho. Depois delas: se PASS, o
 * budget primário já foi consumido e uma tarefa pendente vira LIMIT_REACHED; se
 * FAIL, para imediatamente. Nunca existe terceiro repair automático, e a
 * escalation continua dependendo de autorização do control plane.
 *
 * Com control plane, um candidate já preparado e validado que aguarda review
 * independente é retomado ANTES do pre-flight: concluir a fronteira de
 * aceitação é pré-requisito para selecionar qualquer tarefa nova.
 *
 * Antes do loop roda o PRE-FLIGHT (maintenance -> recover dry-run ->
 * automatic-repair reconcile -> readiness), dentro do MESMO lock.
 *
 * Exit codes: 0 invocação concluída normalmente (ALL_DONE ou LIMIT_REACHED) |
 * 9 término bloqueante/anormal | 10 harness ocupado.
 */
function recordOf(launch: LaunchStepResult) {
  return launch.outcome?.record ?? null;
}

/**
 * Quota do provider como EVIDÊNCIA de projeção. Só o probe de assinatura
 * autoritativo produz `OBSERVED`; qualquer outra situação permanece UNKNOWN
 * com motivo legível — nenhum provider sem medidor vira "0% consumido".
 */
function observedQuotaOf(record: LaunchRecord | null): LabProgressQuota {
  const capacityRecord = record?.pool_capacity ?? null;
  const parsedCapacity = PoolCapacityObservation.safeParse(
    capacityRecord?.after ?? capacityRecord?.before ?? null,
  );
  const capacity = parsedCapacity.success ? parsedCapacity.data : null;
  if (capacity !== null) {
    if (capacity.status === 'UNKNOWN') {
      return { status: 'UNKNOWN', reason: `${capacity.reason} (${capacity.source})` };
    }
    if (capacity.status === 'EXHAUSTED') {
      return { status: 'EXHAUSTED', reason: `${capacity.reason} (${capacity.source})` };
    }
    if (capacity.status === 'AVAILABLE_WITHOUT_METER') {
      return {
        status: 'UNKNOWN',
        reason: `provider declarou disponibilidade sem medidor: ${capacity.reason} (${capacity.source})`,
      };
    }
    const deltas = new Map(
      (capacityRecord?.deltas ?? []).map((delta) => [delta.window_id, delta]),
    );
    return {
      status: 'OBSERVED',
      windows: capacity.windows.map((window) => ({
        window_id: window.window_id,
        used_pct: window.used_percent,
        remaining_pct: window.remaining_percent,
        consumed_pp: deltas.get(window.window_id)?.consumed_pp ?? null,
        precision: window.precision === 'CURRENCY' ? null : window.precision,
        resets_at: window.resets_at,
      })),
      balance: capacity.balance,
      source: capacity.source,
    };
  }

  const usage = record?.subscription_usage ?? null;
  if (usage === null) {
    return {
      status: 'UNKNOWN',
      reason: 'LaunchRecord.subscription_usage ausente: este provider não expõe medidor de assinatura',
    };
  }
  if (!usage.probe_contract.before.available || !usage.probe_contract.after.available) {
    return { status: 'UNKNOWN', reason: 'probe de quota indisponível antes ou depois do launch' };
  }
  return {
    status: 'OBSERVED',
    windows: [
      {
        window_id: 'five_hour',
        used_pct: usage.five_hour.after_used_pct,
        consumed_pp: usage.five_hour.consumed_pp,
      },
      {
        window_id: 'seven_day_all_models',
        used_pct: usage.seven_day_all_models.after_used_pct,
        consumed_pp: usage.seven_day_all_models.consumed_pp,
      },
    ],
  };
}

interface ExecutionResult {
  readonly iteration: IterationInput;
  readonly closeKind: string | null;
  readonly stop: { status: string; reason: string } | null;
}

interface EmptyExecutionResult {
  readonly empty: true;
  readonly stop: { readonly status: string; readonly reason: string };
}

type ReadyTaskExecution = ExecutionResult | EmptyExecutionResult;

async function executeReadyTask(
  paths: HarnessPaths,
  loaded: LoadedPlan,
  profileId: string,
  machineSafetyCeilingOverride: string | undefined,
  repair: { automaticRepair: boolean; repairSourceAttempt: number } | null,
  expectedTaskId?: string,
  acceptance?: ValidatedCandidateAcceptancePolicy,
  onProgress?: LabProgressListener,
  poolCapacity?: PoolCapacityLaunchContext,
): Promise<ReadyTaskExecution> {
  let prepared;
  try {
    prepared = await prepareNextTask(paths, loaded);
  } catch (error) {
    if (error instanceof InconsistentAttemptEvidenceError) {
      return { empty: true, stop: { status: 'INCONSISTENT_EVIDENCE', reason: error.message } };
    }
    throw error;
  }
  const { selection, baseViolation } = prepared;
  let { packet } = prepared;
  if (baseViolation) {
    return { empty: true, stop: { status: 'BASE_DIVERGED', reason: baseViolation } };
  }
  if (!packet || !selection.task) {
    return { empty: true, stop: { status: selection.status, reason: selection.reason } };
  }
  if (expectedTaskId !== undefined && packet.task_id !== expectedTaskId) {
    return {
      empty: true,
      stop: {
        status: 'HUMAN_REQUIRED',
        reason: `retry operacional esperava ${expectedTaskId}, mas selecionou ${packet.task_id}`,
      },
    };
  }

  if (repair !== null) {
    let diagnostics;
    try {
      diagnostics = await readPreviousAttemptDiagnostics(
        paths,
        packet.task_id,
        repair.repairSourceAttempt,
      );
    } catch (error) {
      if (error instanceof InconsistentAttemptEvidenceError) {
        return {
          empty: true,
          stop: { status: 'INCONSISTENT_EVIDENCE', reason: error.message },
        };
      }
      throw error;
    }
    if (diagnostics === null || diagnostics.attempt !== repair.repairSourceAttempt) {
      return {
        empty: true,
        stop: {
          status: 'INCONSISTENT_EVIDENCE',
          reason:
            `repair automático de ${packet.task_id} perdeu diagnostics do source attempt ` +
            repair.repairSourceAttempt,
        },
      };
    }
    packet = { ...packet, previous_attempt_diagnostics: diagnostics };
    await writePacket(paths, packet);
  }

  onProgress?.({
    stage: 'WORKER_RUNNING',
    detail: `task=${packet.task_id} profile=${profileId}`,
    task: {
      task_id: packet.task_id,
      profile_id: profileId,
      ...(repair === null ? {} : { attempt_role: 'repair' as const }),
    },
  });
  const launch = await launchTask(
    paths,
    packet,
    profileId,
    machineSafetyCeilingOverride === undefined ? undefined : Number(machineSafetyCeilingOverride),
    poolCapacity,
  );
  if (launch.classification === 'PREFLIGHT_BLOCKED') {
    return { empty: true, stop: { status: 'PREFLIGHT_BLOCKED', reason: launch.reason } };
  }
  const attempt = getTaskState(await readState(paths), packet.task_id).attempts;
  const attemptKind = packet.previous_attempt_diagnostics ? 'REPAIR' : 'FIRST_PASS';
  const iterationBase = {
    taskId: packet.task_id,
    attempt,
    launch: launch.classification,
    record: recordOf(launch),
    attemptKind,
    ...(repair === null
      ? {}
      : { automaticRepair: repair.automaticRepair, repairSourceAttempt: repair.repairSourceAttempt }),
  } as const;
  if (launch.classification !== 'FINISHED') {
    return {
      iteration: { ...iterationBase, close: null, reason: launch.reason },
      closeKind: null,
      stop: { status: launch.classification, reason: launch.reason },
    };
  }

  onProgress?.({
    stage: 'VALIDATING',
    detail: `task=${packet.task_id}`,
    task: {
      task_id: packet.task_id,
      attempt,
      profile_id: profileId,
      duration_ms: iterationBase.record?.duration_ms ?? null,
      // Quota só quando o PROVIDER a reportou; ausência de medidor permanece
      // UNKNOWN com motivo, nunca vira 0%.
      quota: observedQuotaOf(iterationBase.record),
    },
  });
  const close = await closeTaskByLaunchPolicy({
    paths,
    loaded,
    taskId: packet.task_id,
    ...(acceptance === undefined ? {} : { acceptance }),
  });
  const iteration: IterationInput = {
    ...iterationBase,
    close: close.kind,
    reason: close.reason,
  };
  if (close.kind === 'PASS') {
    onProgress?.({
      stage: 'TASK_ACCEPTED',
      detail: `task=${packet.task_id}`,
      task: {
        task_id: packet.task_id,
        attempt,
        profile_id: profileId,
        close_kind: close.kind,
        duration_ms: iterationBase.record?.duration_ms ?? null,
      },
    });
    return { iteration, closeKind: close.kind, stop: null };
  }
  onProgress?.({
    stage: 'TASK_FAILED',
    detail: `task=${packet.task_id} close=${close.kind}`,
    task: {
      task_id: packet.task_id,
      attempt,
      profile_id: profileId,
      close_kind: close.kind,
      duration_ms: iterationBase.record?.duration_ms ?? null,
    },
  });
  return {
    iteration,
    closeKind: close.kind,
    stop: { status: close.kind, reason: close.reason },
  };
}

async function postLaunchIncidentOf(
  paths: HarnessPaths,
  execution: ExecutionResult,
  profileId: string,
): Promise<RoutinePostLaunchIncident> {
  const state = await readState(paths);
  const task = getTaskState(state, execution.iteration.taskId);
  const head = await headSha(paths.repoRoot);
  return {
    phase: 'POST_LAUNCH',
    authorized_head_before: state.authorized_head_sha ?? '',
    head_matches_authorized:
      task.base_sha !== null &&
      state.authorized_head_sha !== null &&
      head === task.base_sha &&
      head === state.authorized_head_sha,
    task_id: execution.iteration.taskId,
    attempt: execution.iteration.attempt,
    profile_id: profileId,
    launch: execution.iteration.launch,
    close: execution.closeKind,
    outcome: execution.stop?.status ?? execution.closeKind ?? execution.iteration.launch,
    reason: execution.stop?.reason ?? execution.iteration.reason,
    task_status: task.status,
    task_phase: task.phase,
    commit_owner: execution.iteration.record?.execution_policy.commit_owner ?? null,
    capability_verdict: execution.closeKind === 'FAIL',
    official_validation_failure: false,
    evidence_paths: [],
  };
}

type RoutinePostLaunchHandling =
  | {
      readonly status: 'RETRIED';
      readonly execution: ExecutionResult;
      readonly human_required: null;
    }
  | {
      readonly status: 'RECOVERED';
      readonly execution: null;
      readonly human_required: null;
      readonly incident: RoutinePostLaunchIncident;
      readonly incident_id: string;
      readonly operational_retry_budget: number;
    }
  | {
      readonly status: 'HUMAN_REQUIRED';
      readonly execution: null;
      readonly human_required: HumanRequiredOutput;
    };

type RoutinePostLaunchSettlement =
  | {
      readonly status: 'EXECUTED';
      readonly execution: ExecutionResult;
      readonly executions: readonly ExecutionResult[];
      readonly human_required: null;
    }
  | {
      readonly status: 'HUMAN_REQUIRED';
      readonly execution: null;
      readonly executions: readonly ExecutionResult[];
      readonly human_required: HumanRequiredOutput;
    };

function assertNever(value: never): never {
  throw new Error(`estado pós-launch não tratado: ${JSON.stringify(value)}`);
}

function needsRoutinePostLaunch(execution: ExecutionResult): boolean {
  return (
    execution.closeKind !== 'PASS' &&
    execution.closeKind !== 'FAIL' &&
    execution.stop !== null
  );
}

function operationalRetryHumanRequired(
  incidentId: string,
  reason: string,
  evidencePaths: readonly string[],
): HumanRequiredOutput {
  return {
    status: 'HUMAN_REQUIRED',
    incident_id: incidentId,
    decision_needed: 'Revisar o incidente operacional persistente antes de um novo provider launch.',
    why_automation_stopped: reason,
    options: [
      'corrigir o protocolo/tooling e rerodar',
      'inspecionar manualmente a evidência preservada',
    ],
    evidence_paths: [...evidencePaths],
  };
}

async function handleRoutinePostLaunch(
  paths: HarnessPaths,
  loaded: LoadedPlan,
  execution: ExecutionResult,
  profileId: string,
  machineSafetyCeilingOverride: string | undefined,
  repair: { automaticRepair: boolean; repairSourceAttempt: number } | null,
  acceptance: ValidatedCandidateAcceptancePolicy | undefined,
  operationalRetryAllowed = true,
): Promise<RoutinePostLaunchHandling> {
  const incident = await postLaunchIncidentOf(paths, execution, profileId);
  const resolution = await resolveRoutinePostLaunch<ExecutionResult>({
    paths,
    incident,
    driver: createRoutinePostLaunchRuntime({ paths }),
    operationalRetryAllowed,
    retrySameTask: async (_actionId, original) => {
      const retry = await executeReadyTask(
        paths,
        loaded,
        original.profile_id,
        machineSafetyCeilingOverride,
        repair,
        original.task_id,
        acceptance,
      );
      if ('empty' in retry) {
        throw new Error(
          `retry operacional da mesma task não produziu execução: ${retry.stop.status}: ${retry.stop.reason}`,
        );
      }
      return {
        incident: await postLaunchIncidentOf(paths, retry, original.profile_id),
        value: retry,
      };
    },
  });
  switch (resolution.status) {
    case 'RETRIED':
      return { status: 'RETRIED', execution: resolution.retry, human_required: null };
    case 'RECOVERED': {
      const recipe = ROUTINE_RECIPES.find(
        (candidate) =>
          candidate.id === resolution.record.recipe_id &&
          candidate.incident_phase === 'POST_LAUNCH',
      );
      return {
        status: 'RECOVERED',
        execution: null,
        human_required: null,
        incident,
        incident_id: resolution.record.incident_id,
        operational_retry_budget: recipe?.retry_budget ?? 0,
      };
    }
    case 'HUMAN_REQUIRED':
      return {
        status: 'HUMAN_REQUIRED',
        execution: null,
        human_required: resolution.human_required,
      };
    default:
      return assertNever(resolution);
  }
}

async function settleRoutinePostLaunch(
  paths: HarnessPaths,
  loaded: LoadedPlan,
  initial: ExecutionResult,
  profileId: string,
  machineSafetyCeilingOverride: string | undefined,
  repair: { automaticRepair: boolean; repairSourceAttempt: number } | null,
  acceptance: ValidatedCandidateAcceptancePolicy | undefined,
): Promise<RoutinePostLaunchSettlement> {
  const executions: ExecutionResult[] = [initial];
  let execution = initial;
  let operationalRetriesRemaining: number | null = null;
  let recoveredIncidentId = '';
  let recoveredEvidencePaths: readonly string[] = [];

  while (needsRoutinePostLaunch(execution)) {
    const handled = await handleRoutinePostLaunch(
      paths,
      loaded,
      execution,
      profileId,
      machineSafetyCeilingOverride,
      repair,
      acceptance,
      operationalRetriesRemaining !== 0,
    );
    switch (handled.status) {
      case 'RETRIED':
        executions.push(handled.execution);
        return {
          status: 'EXECUTED',
          execution: handled.execution,
          executions,
          human_required: null,
        };
      case 'HUMAN_REQUIRED':
        return {
          status: 'HUMAN_REQUIRED',
          execution: null,
          executions,
          human_required: handled.human_required,
        };
      case 'RECOVERED': {
        operationalRetriesRemaining ??= handled.operational_retry_budget;
        recoveredIncidentId = handled.incident_id;
        recoveredEvidencePaths = handled.incident.evidence_paths;
        if (operationalRetriesRemaining < 1) {
          return {
            status: 'HUMAN_REQUIRED',
            execution: null,
            executions,
            human_required: operationalRetryHumanRequired(
              recoveredIncidentId,
              'budget operacional da recipe esgotado; incidente persistente de protocol/tooling ' +
                'foi recuperado sem novo retry',
              recoveredEvidencePaths,
            ),
          };
        }
        operationalRetriesRemaining -= 1;
        const retry = await executeReadyTask(
          paths,
          loaded,
          handled.incident.profile_id,
          machineSafetyCeilingOverride,
          repair,
          handled.incident.task_id,
          acceptance,
        );
        if ('empty' in retry) {
          return {
            status: 'HUMAN_REQUIRED',
            execution: null,
            executions,
            human_required: operationalRetryHumanRequired(
              recoveredIncidentId,
              `retry operacional da mesma task não pôde executar: ${retry.stop.status}: ${retry.stop.reason}`,
              recoveredEvidencePaths,
            ),
          };
        }
        executions.push(retry);
        execution = retry;
        break;
      }
      default:
        return assertNever(handled);
    }
  }

  return { status: 'EXECUTED', execution, executions, human_required: null };
}

export interface OrchestrateOptions {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly profileId: string;
  readonly machineSafetyCeilingOverride?: string;
  readonly maxIterations: number;
  readonly autonomy?: 'routine';
  readonly skipPreflight?: boolean;
  readonly verbose?: boolean;
  /** Progresso de lifecycle (uma linha por transição); ausente = silencioso. */
  readonly onProgress?: LabProgressListener;
  /**
   * Control plane do lifecycle universal de projeto. Ausente (todo uso
   * histórico), o loop decide exatamente como sempre decidiu: um profile por
   * invocação, budget do launcher e parada no repair esgotado. Presente, as
   * DECISÕES por work unit passam a vir dele — profile, previsão de runtime,
   * review, diagnosis e escalation — sem que o loop, o estado autoritativo, o
   * commit ou a validação oficial mudem de dono.
   */
  readonly controlPlane?: ProjectControlPlane;
}

export interface OrchestrateResult {
  readonly stop: { readonly status: string; readonly reason: string };
  readonly payload: Record<string, unknown>;
  readonly iterationCount: number;
}

/** Um profile que de fato executou nesta run, com os papéis que ele exerceu. */
export interface ProfileUsageReport {
  readonly profile_id: string;
  readonly agent: string;
  readonly model: string;
  readonly reasoning_effort: string;
  readonly attempt_roles: readonly string[];
  readonly launch_count: number;
}

/**
 * Quais profiles executaram, derivado de FATO AUTORITATIVO.
 *
 * A identidade vem do `LaunchRecord` de cada iteração — o que nasceu de fato,
 * não o que foi pedido — e os papéis vêm das decisões que o control plane
 * registrou para aquele profile. Agente/modelo/effort continuam saindo de
 * `experimentFactsOf` sobre o profile do catálogo: nada é inferido a partir do
 * NOME do profile, que é rótulo e não evidência.
 *
 * Um profile sem `LaunchRecord` não entra: gate humano antes do spawn não é
 * execução, e listá-lo diria que alguém rodou quando ninguém rodou.
 */
async function summarizeProfilesUsed(
  paths: HarnessPaths,
  controlPlane: ProjectControlPlane,
  iterations: readonly IterationInput[],
): Promise<ProfileUsageReport[]> {
  const launchCounts = new Map<string, number>();
  for (const iteration of iterations) {
    const id = iteration.record?.profile_id;
    if (id === undefined) continue;
    launchCounts.set(id, (launchCounts.get(id) ?? 0) + 1);
  }

  const rolesByProfile = new Map<string, Set<string>>();
  for (const unit of controlPlane.snapshot().work_units) {
    const id = unit.routing.selected_profile_id;
    if (!launchCounts.has(id)) continue;
    const roles = rolesByProfile.get(id) ?? new Set<string>();
    roles.add(unit.attempt_role);
    rolesByProfile.set(id, roles);
  }

  const reports: ProfileUsageReport[] = [];
  for (const [id, launchCount] of launchCounts) {
    const profile = await loadProfile(paths.repoRoot, id, {
      catalogRoot: paths.profileCatalogRoot,
    }).catch(() => null);
    const profileFacts = profile === null ? null : experimentFactsOf(profile);
    reports.push({
      profile_id: id,
      agent: profileFacts?.agent ?? 'unknown',
      model: profileFacts?.model ?? 'unknown',
      reasoning_effort: profileFacts?.reasoning_effort ?? 'unknown',
      attempt_roles: [...(rolesByProfile.get(id) ?? new Set<string>())],
      launch_count: launchCount,
    });
  }
  return reports;
}

/**
 * Loop canônico do orquestrador. `dev-orchestrate` e `dev-run-plan` consomem
 * esta função; nenhum wrapper reimplementa selection, repair, recovery ou launch.
 */
/**
 * Retomada da FINALIZAÇÃO entre processos — a interface de resume é rerodar o
 * mesmo comando.
 *
 * Um attempt cujo worker já terminou mas cujo fechamento não chegou ao state é
 * trabalho legítimo em curso, não incidente do repositório. Antes desta função,
 * `recover` reconciliava esse estado para ELE MESMO ("fechamento pendente —
 * repita dev-close"), o preflight lia a reconciliação como `RECOVERY_ATTENTION`
 * e o runner parava em `PREFLIGHT_BLOCKED`. Destravar exigia que o operador
 * conhecesse `dev-close` / `dev-recover-*` — primitives INTERNAS vazando para a
 * interface.
 *
 * As primitives continuam existindo e continuam sendo as mesmas; o que muda é
 * quem as orquestra. Idempotente por construção: `closeTaskByLaunchPolicy`
 * converge para os mesmos bytes e aceita uma tarefa já fechada.
 *
 * Fail-closed onde importa: worker ainda VIVO não é fechamento pendente, e mais
 * de uma tarefa RUNNING é inconsistência que pertence ao preflight, não a uma
 * retomada silenciosa.
 */
async function resumePendingFinalization(input: {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly acceptance?: ValidatedCandidateAcceptancePolicy;
}): Promise<{ readonly status: 'NONE' | 'RESUMED'; readonly taskId: string | null; readonly reason: string }> {
  let state;
  try {
    state = await readState(input.paths);
  } catch {
    return { status: 'NONE', taskId: null, reason: 'runtime ainda não tem state autoritativo' };
  }
  const running = state.tasks.filter((task) => task.status === 'RUNNING');
  if (running.length !== 1) {
    return { status: 'NONE', taskId: null, reason: 'nenhuma finalização pendente isolada' };
  }
  const pending = running[0];
  if (pending === undefined || pending.phase !== 'FINALIZING' || pending.attempts < 1) {
    return { status: 'NONE', taskId: null, reason: 'tarefa RUNNING não está em FINALIZING' };
  }
  if (!input.loaded.byId.has(pending.id)) {
    return { status: 'NONE', taskId: null, reason: `${pending.id} não existe no plano carregado` };
  }
  if (pending.process !== null && (await isSameProcessAlive(pending.process))) {
    return { status: 'NONE', taskId: pending.id, reason: 'worker do attempt ainda está vivo' };
  }

  const outcome = await closeTaskByLaunchPolicy({
    paths: input.paths,
    loaded: input.loaded,
    taskId: pending.id,
    ...(input.acceptance === undefined ? {} : { acceptance: input.acceptance }),
  });
  if (outcome.kind === 'PENDING') {
    const recovered = await tryRecoverProvenProviderInfra(
      input.paths,
      pending.id,
      `fechamento pendente após falha terminal do provider: ${outcome.reason}`,
    );
    if (recovered) {
      return {
        status: 'RESUMED',
        taskId: pending.id,
        reason: recovered,
      };
    }
  }
  return {
    status: outcome.kind === 'PENDING' ? 'NONE' : 'RESUMED',
    taskId: pending.id,
    reason: outcome.reason,
  };
}

/**
 * INFRA comprovada (LaunchRecord ou stdout tipado) não é decisão humana nem
 * FAIL de capacidade. Resume do MESMO comando recupera sem o operador conhecer
 * `dev-recover-infra`. Ausência de prova deixa o estado como estava.
 */
async function tryRecoverProvenProviderInfra(
  paths: HarnessPaths,
  taskId: string,
  reason: string,
): Promise<string | null> {
  try {
    const recovered = await recoverInfraAttempt({ paths, taskId, reason });
    return recovered.record.reason;
  } catch (error) {
    if (error instanceof InfraRecoveryError) return null;
    throw error;
  }
}

async function resumePendingInfraRecovery(paths: HarnessPaths): Promise<void> {
  let state;
  try {
    state = await readState(paths);
  } catch {
    return;
  }
  const infra = state.tasks.filter((task) => task.status === 'INFRA_ERROR');
  if (infra.length !== 1) return;
  const pending = infra[0];
  if (pending === undefined || pending.attempts < 1) return;
  await tryRecoverProvenProviderInfra(
    paths,
    pending.id,
    pending.diagnostics ?? 'falha de infraestrutura do provider',
  );
}

export async function runOrchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const {
    paths,
    loaded,
    profileId,
    machineSafetyCeilingOverride,
    maxIterations,
    autonomy,
    skipPreflight = false,
    verbose = false,
    onProgress,
    controlPlane,
  } = options;
  await ensureRuntimeDirs(paths);

  // Só para o relatório: perfil quebrado continua falhando no lançamento, que é
  // onde a falha significa alguma coisa. Ler aqui não muda o fluxo.
  const profile = await loadProfile(paths.repoRoot, profileId, {
    catalogRoot: paths.profileCatalogRoot,
  }).catch(() => null);
  const facts = profile ? experimentFactsOf(profile) : null;

  const iterations: IterationInput[] = [];
  let stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };

  // O lock cobre o pre-flight E o loop INTEIRO: um segundo orquestrador não
  // pode selecionar nem lançar nada enquanto este ciclo estiver em andamento,
  // e nada muda entre o que o pre-flight conferiu e o que o loop lança.
  let exhausted = false;
  let preflight: PreflightResult | null = null;
  let humanRequired: HumanRequiredOutput | null = null;

  const acceptance = controlPlane?.acceptance;

  await withHarnessLock(paths, 'dev-orchestrate', async () => {
    // FRONTEIRA DE ACEITAÇÃO retomada ANTES de qualquer coisa.
    //
    // Um candidate já preparado e validado que aguarda review independente é
    // trabalho em curso desta run, não incidente do repositório: concluí-lo é
    // pré-requisito para o preflight, que legitimamente recusa operar com uma
    // tarefa RUNNING. É isto que faz um REJECT sobreviver ao fim do processo —
    // rerodar o mesmo comando reencontra o veredito publicado em vez de
    // esquecê-lo — e faz um ACCEPT já publicado ser promovido sem repetir
    // implementer nem reviewer.
    if (acceptance !== undefined) {
      const reviewReconciliation = await controlPlane!.reconcilePendingReviewRejection();
      if (reviewReconciliation.status === 'HUMAN_REQUIRED') {
        humanRequired = reviewReconciliation.human_required;
        stop = {
          status: 'HUMAN_REQUIRED',
          reason: reviewReconciliation.human_required.why_automation_stopped,
        };
        return;
      }
      const resumed = await resumePendingAcceptance({ paths, loaded, acceptance });
      if (resumed.status === 'BLOCKED') {
        humanRequired = controlPlane?.snapshot().human_gate ?? null;
        stop = {
          status: 'HUMAN_REQUIRED',
          reason: humanRequired?.why_automation_stopped ?? resumed.reason,
        };
        return;
      }
    }

    // FINALIZAÇÃO pendente retomada antes de selecionar qualquer tarefa nova.
    // Vale com e sem control plane: `dev-orchestrate`, `dev-run-plan` e
    // `dev-run-project` compartilham este caminho, então rerodar o MESMO
    // comando é a interface de resume em todos eles.
    await resumePendingFinalization({
      paths,
      loaded,
      ...(acceptance === undefined ? {} : { acceptance }),
    });
    await resumePendingInfraRecovery(paths);

    if (!skipPreflight) {
      let currentPreflight = await runOrchestrationPreflight({
        paths,
        loaded,
        requestedProfileId: profileId,
        ...(controlPlane === undefined
          ? {}
          : { profileSelectionOwner: 'project_control_plane' as const }),
      });
      if (currentPreflight.status === 'BLOCKED' && autonomy === 'routine') {
        const incident = await inspectRoutineIncident(paths, currentPreflight);
        // Harness self-maintenance só é legítima no próprio Agent Strategy Lab.
        // Num repositório alvo externo, um incidente de projeto não autoriza
        // manutenção de harness dentro do alvo — a resolução é fail-closed.
        const harnessRoot = resolveHarnessInstallationRoot();
        const resolution = await resolveRoutinePreflight({
          paths,
          incident,
          harnessSelfMaintenance:
            paths.repoRoot === harnessRoot
              ? {
                  allowed: true,
                  reason: `repositório conduzido é a própria instalação do harness (${harnessRoot})`,
                }
              : {
                  allowed: false,
                  reason: `repoRoot=${paths.repoRoot} difere da instalação do harness ${harnessRoot}`,
                },
          driver: createRoutineAutonomyRuntime({
            paths,
            loaded,
            requestedProfileId: profileId,
          }),
        });
        currentPreflight = resolution.preflight;
        humanRequired = resolution.human_required;
        if (resolution.status === 'HUMAN_REQUIRED') {
          stop = {
            status: 'HUMAN_REQUIRED',
            reason: resolution.human_required?.why_automation_stopped ?? 'decisão humana necessária',
          };
          preflight = currentPreflight;
          return;
        }
      }
      preflight = currentPreflight;
      if (currentPreflight.status === 'BLOCKED') {
        // Bloqueio de pre-flight é problema do repositório, não veredito de
        // tarefa: nenhum provider é lançado, nenhum attempt é consumido e
        // nenhum status de tarefa muda — exceto o archival do primeiro FAIL
        // oficial, que o preflight pode concluir para o repair bounded.
        stop = { status: 'PREFLIGHT_BLOCKED', reason: currentPreflight.reason ?? 'pre-flight bloqueado' };
        if (currentPreflight.blocker === AUTOMATIC_REPAIR_EXHAUSTED) {
          stop = { status: AUTOMATIC_REPAIR_EXHAUSTED, reason: currentPreflight.reason ?? AUTOMATIC_REPAIR_EXHAUSTED };
        } else if (currentPreflight.blocker === AUTOMATIC_REPAIR_PROFILE_MISMATCH) {
          stop = {
            status: AUTOMATIC_REPAIR_PROFILE_MISMATCH,
            reason: currentPreflight.reason ?? AUTOMATIC_REPAIR_PROFILE_MISMATCH,
          };
        } else if (
          currentPreflight.blocker === 'INCONSISTENT_EVIDENCE' ||
          currentPreflight.blocker === 'HISTORICAL_GAP' ||
          currentPreflight.blocker === 'INVALID_EVIDENCE'
        ) {
          stop = {
            status: currentPreflight.blocker,
            reason: currentPreflight.reason ?? currentPreflight.blocker,
          };
        }
        return;
      }
      if (currentPreflight.status === 'ALL_DONE') {
        stop = { status: 'ALL_DONE', reason: currentPreflight.reason ?? 'nenhuma tarefa pendente' };
        return;
      }
    }

    /**
     * Escalation autorizada pelo control plane depois do bounded repair
     * esgotado. Sem control plane a resposta é sempre `null` e o loop para
     * exatamente onde parava antes — o gate humano continua sendo o
     * `dev-retry-failed` explícito.
     */
    const escalateOrHalt = async (
      taskId: string,
      halt: { status: string; reason: string },
    ): Promise<'CONTINUE' | 'HALT'> => {
      if (controlPlane === undefined) return 'HALT';
      const followUp = await controlPlane.onRepairExhausted({ taskId, reason: halt.reason });
      if (followUp.status === 'ESCALATED') return 'CONTINUE';
      if (followUp.status === 'HUMAN_REQUIRED') {
        humanRequired = followUp.human_required;
        stop = {
          status: 'HUMAN_REQUIRED',
          reason: followUp.human_required.why_automation_stopped,
        };
        return 'HALT';
      }
      return 'HALT';
    };

    /**
     * `--max-iterations` conta CICLOS PRIMÁRIOS DE TASK, não launches internos.
     *
     * First pass, o único bounded repair e a escalation autorizada da MESMA
     * task pertencem ao mesmo ciclo primário: são tentativas de concluir uma
     * unidade de trabalho, não unidades de trabalho diferentes. Contá-los
     * separadamente fazia `--max-iterations 1` interromper a escalation logo
     * depois de autorizá-la — e reportar ALL_DONE com a task ainda em aberto.
     *
     * `escalationContinuation` marca exatamente essa retomada: a próxima volta
     * do laço continua o ciclo já contado em vez de abrir um novo.
     */
    let cycle = 0;
    let escalationContinuation = false;
    for (;;) {
      if (!escalationContinuation) {
        if (cycle >= maxIterations) break;
        cycle += 1;
      }
      escalationContinuation = false;
      const failed = (await readState(paths)).tasks.find((task) => task.status === 'FAIL');
      if (failed) {
        const pendingDecision = await decideAutomaticRepair(paths, failed.id);
        const profileHalt = controlPlane
          ? null
          : haltFromAutomaticRepairProfile(pendingDecision, failed.id, profileId);
        if (profileHalt) {
          stop = profileHalt;
          break;
        }
        const rec = await reconcileAutomaticRepair({ paths, taskId: failed.id });
        const halt = haltFromAutomaticRepair(rec.decision);
        if (halt) {
          if ((await escalateOrHalt(failed.id, halt)) === 'CONTINUE') {
            escalationContinuation = true;
            continue;
          }
          stop = stop.status === 'HUMAN_REQUIRED' ? stop : halt;
          break;
        }
        if (rec.decision.action !== 'REPAIR_ALLOWED') {
          stop = { status: 'FAIL', reason: failed.diagnostics ?? `${failed.id} está FAIL` };
          break;
        }
      }

      const selected = selectNextTask(loaded, await readState(paths));
      const subjectId = selected.task?.id ?? null;
      let launchProfile = profileId;
      let poolCapacity: PoolCapacityLaunchContext | undefined;
      let repairMeta: { automaticRepair: boolean; repairSourceAttempt: number } | null = null;
      if (subjectId) {
        const pendingDecision = await decideAutomaticRepair(paths, subjectId);
        const profileHalt = controlPlane
          ? null
          : haltFromAutomaticRepairProfile(pendingDecision, subjectId, profileId);
        if (profileHalt) {
          stop = profileHalt;
          break;
        }
        const rec = await reconcileAutomaticRepair({ paths, taskId: subjectId });
        const halt = haltFromAutomaticRepair(rec.decision);
        if (halt) {
          stop = halt;
          break;
        }
        if (rec.decision.action === 'REPAIR_ALLOWED') {
          launchProfile = rec.decision.profile_id;
          repairMeta = {
            automaticRepair: true,
            repairSourceAttempt: rec.decision.source_attempt,
          };
          onProgress?.({
            stage: 'REPAIR',
            detail: `task=${subjectId} profile=${launchProfile}`,
            task: { task_id: subjectId, profile_id: launchProfile, attempt_role: 'repair' },
          });
        }
      }

      // O control plane decide o profile POR work unit; a previsão de runtime
      // acompanha a decisão como evidência, sem limitar nada.
      // No bounded repair o profile é imposto pela policy existente e entra
      // como pin: routing informa, mas não troca o profile do repair.
      if (controlPlane !== undefined && subjectId !== null) {
        const decision = await controlPlane.beforeWorkUnit({
          taskId: subjectId,
          attemptKind: repairMeta === null ? 'FIRST_PASS' : 'REPAIR',
          pinnedProfileId: repairMeta === null ? null : launchProfile,
        });
        if (decision.outcome === 'HUMAN_REQUIRED') {
          humanRequired = decision.human_required;
          stop = {
            status: 'HUMAN_REQUIRED',
            reason: decision.human_required.why_automation_stopped,
          };
          break;
        }
        launchProfile = decision.profile_id;
        poolCapacity = decision.pool_capacity;
      }

      let executed = await executeReadyTask(
        paths,
        loaded,
        launchProfile,
        machineSafetyCeilingOverride,
        repairMeta,
        undefined,
        acceptance,
        onProgress,
        poolCapacity,
      );
      if ('empty' in executed) {
        stop = executed.stop;
        break;
      }
      if (autonomy === 'routine') {
        const settled = await settleRoutinePostLaunch(
          paths,
          loaded,
          executed,
          launchProfile,
          machineSafetyCeilingOverride,
          repairMeta,
          acceptance,
        );
        iterations.push(...settled.executions.map((item) => item.iteration));
        if (settled.status === 'HUMAN_REQUIRED') {
          humanRequired = settled.human_required;
          stop = {
            status: 'HUMAN_REQUIRED',
            reason: settled.human_required.why_automation_stopped,
          };
          break;
        }
        executed = settled.execution;
      } else {
        iterations.push(executed.iteration);
      }
      let reviewRepairReady = false;
      if (controlPlane !== undefined) {
        const followUp = await controlPlane.afterWorkUnit({
          taskId: executed.iteration.taskId,
          attempt: executed.iteration.attempt,
          profileId: launchProfile,
          closeKind: executed.closeKind,
          launch: executed.iteration.launch,
          reason: executed.iteration.reason,
        });
        if (followUp.status === 'HUMAN_REQUIRED') {
          humanRequired = followUp.human_required;
          stop = {
            status: 'HUMAN_REQUIRED',
            reason: followUp.human_required.why_automation_stopped,
          };
          break;
        }
        reviewRepairReady = followUp.status === 'REPAIR_READY';
      }
      if (executed.closeKind === 'PASS') {
        stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };
        exhausted = cycle >= maxIterations;
        continue;
      }
      if (!reviewRepairReady && (executed.closeKind !== 'FAIL' || executed.stop === null)) {
        stop = executed.stop ?? { status: executed.closeKind ?? 'FAIL', reason: executed.iteration.reason };
        break;
      }

      // FIRST official validation FAIL: um repair bounded na mesma invocação,
      // mesmo profile, sem consumir outro ciclo primário de max-iterations.
      const pendingDecision = await decideAutomaticRepair(paths, executed.iteration.taskId);
      const profileHalt = controlPlane
        ? null
        : haltFromAutomaticRepairProfile(pendingDecision, executed.iteration.taskId, profileId);
      if (profileHalt) {
        stop = profileHalt;
        break;
      }
      const rec = await reconcileAutomaticRepair({ paths, taskId: executed.iteration.taskId });
      const halt = haltFromAutomaticRepair(rec.decision);
      if (halt) {
        stop = halt;
        break;
      }
      if (rec.decision.action !== 'REPAIR_ALLOWED') {
        stop = executed.stop ?? {
          status: 'REVIEW_REPAIR_NOT_AUTHORIZED',
          reason: executed.iteration.reason,
        };
        break;
      }

      const capabilityRepairMeta = {
        automaticRepair: true,
        repairSourceAttempt: rec.decision.source_attempt,
      } as const;
      let repairPoolCapacity: PoolCapacityLaunchContext | undefined;
      if (controlPlane !== undefined) {
        const decision = await controlPlane.beforeWorkUnit({
          taskId: executed.iteration.taskId,
          attemptKind: 'REPAIR',
          pinnedProfileId: rec.decision.profile_id,
        });
        if (decision.outcome === 'HUMAN_REQUIRED') {
          humanRequired = decision.human_required;
          stop = {
            status: 'HUMAN_REQUIRED',
            reason: decision.human_required.why_automation_stopped,
          };
          break;
        }
        repairPoolCapacity = decision.pool_capacity;
      }
      let repair = await executeReadyTask(
        paths,
        loaded,
        rec.decision.profile_id,
        machineSafetyCeilingOverride,
        capabilityRepairMeta,
        undefined,
        acceptance,
        undefined,
        repairPoolCapacity,
      );
      if ('empty' in repair) {
        stop = repair.stop;
        break;
      }
      if (autonomy === 'routine') {
        const settled = await settleRoutinePostLaunch(
          paths,
          loaded,
          repair,
          rec.decision.profile_id,
          machineSafetyCeilingOverride,
          capabilityRepairMeta,
          acceptance,
        );
        iterations.push(...settled.executions.map((item) => item.iteration));
        if (settled.status === 'HUMAN_REQUIRED') {
          humanRequired = settled.human_required;
          stop = {
            status: 'HUMAN_REQUIRED',
            reason: settled.human_required.why_automation_stopped,
          };
          break;
        }
        repair = settled.execution;
      } else {
        iterations.push(repair.iteration);
      }
      let repairReviewReady = false;
      if (controlPlane !== undefined) {
        const followUp = await controlPlane.afterWorkUnit({
          taskId: repair.iteration.taskId,
          attempt: repair.iteration.attempt,
          profileId: rec.decision.profile_id,
          closeKind: repair.closeKind,
          launch: repair.iteration.launch,
          reason: repair.iteration.reason,
        });
        if (followUp.status === 'HUMAN_REQUIRED') {
          humanRequired = followUp.human_required;
          stop = {
            status: 'HUMAN_REQUIRED',
            reason: followUp.human_required.why_automation_stopped,
          };
          break;
        }
        repairReviewReady = followUp.status === 'REPAIR_READY';
      }
      if (repair.closeKind === 'PASS') {
        stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };
        exhausted = cycle >= maxIterations;
        continue;
      }
      if (repair.closeKind === 'FAIL' || repairReviewReady) {
        const repairDecision = await decideAutomaticRepair(paths, repair.iteration.taskId);
        const repairHalt =
          haltFromAutomaticRepair(repairDecision) ??
          repair.stop ?? {
            status: repair.closeKind ?? 'REVIEW_REPAIR_EXHAUSTED',
            reason: repair.iteration.reason,
          };
        // Repair esgotado: o control plane pode autorizar o degrau seguinte da
        // ladder configurada e reabrir a task pela primitive oficial. Sem
        // control plane, o comportamento histórico é intocado.
        if ((await escalateOrHalt(repair.iteration.taskId, repairHalt)) === 'CONTINUE') {
          escalationContinuation = true;
          continue;
        }
        stop = stop.status === 'HUMAN_REQUIRED' ? stop : repairHalt;
        break;
      }
      stop = repair.stop ?? { status: repair.closeKind ?? 'FAIL', reason: repair.iteration.reason };
      break;
    }

    // Sair do `for` por esgotar o limite NÃO é fluxo concluído. Sem esta
    // checagem, `--max-iterations 1` com duas tarefas pendentes reportava
    // ALL_DONE e exit 0, escondendo trabalho que ninguém fez.
    // O repair bounded pertence ao ciclo primário já contado: depois dele,
    // a próxima tarefa do plano NÃO entra se o budget primário acabou.
    if (exhausted) {
      const selection = selectNextTask(loaded, await readState(paths));
      if (selection.status !== 'ALL_DONE') {
        stop = {
          status: 'LIMIT_REACHED',
          reason: `limite de ${maxIterations} iteração(ões) atingido; ${selection.reason}`,
        };
      }
    }
  });

  const estimates = iterations
    .map((iteration) => iteration.record?.billing?.provider_estimated_api_equivalent_usd ?? null)
    .filter((value): value is number => value !== null);
  // Soma das equivalências que as CLIs estimaram; `null` quando nenhuma sessão
  // reportou número. Continua não sendo cobrança.
  const total = estimates.length ? estimates.reduce((sum, value) => sum + value, 0) : null;

  const preflightReport: PreflightResult | null = preflight;
  // Quem escolheu os profiles desta run. Sem control plane a resposta é a
  // histórica — um profile por invocação — e o output não muda em nada.
  const profilesUsed =
    controlPlane === undefined
      ? null
      : await summarizeProfilesUsed(paths, controlPlane, iterations);
  const payload = {
    ...(humanRequired ?? {}),
    ...(preflightReport === null
      ? {}
      : {
          preflight: verbose ? detailPreflight(preflightReport) : summarizePreflight(preflightReport),
        }),
    stopped_by: stop.status,
    reason: stop.reason,
    // SEM control plane o perfil É único na invocação: repetir agente/modelo/
    // effort em cada iteração seria ruído, não evidência adicional.
    //
    // COM control plane deixou de ser verdade — routing e escalation podem
    // trocar de profile entre attempts. Os campos abaixo continuam existindo
    // por compatibilidade, mas passam a ser explicitamente o BOOTSTRAP da
    // invocação, e `profiles_used` diz quem de fato executou.
    profile_id: profileId,
    agent: facts?.agent ?? 'unknown',
    model: facts?.model ?? 'unknown',
    reasoning_effort: facts?.reasoning_effort ?? 'unknown',
    ...(verbose ? { reasoning_effort_source: facts?.reasoning_effort_source ?? 'unknown' } : {}),
    ...(profilesUsed === null
      ? {}
      : {
          profile_selection_owner: 'project_control_plane',
          profile_id_role: 'bootstrap_default',
          profiles_used: profilesUsed,
        }),
    iteration_count: iterations.length,
    iterations: iterations.map((iteration) =>
      verbose ? detailIteration(iteration) : summarizeIteration(iteration),
    ),
    total_api_equivalent_usd: total,
    ...(verbose ? { total_provider_estimated_api_equivalent_usd: total } : {}),
    billing_note: ESTIMATED_COST_LABEL,
  };

  return { stop, payload, iterationCount: iterations.length };
}
