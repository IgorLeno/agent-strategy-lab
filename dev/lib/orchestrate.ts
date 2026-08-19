import {
  AUTOMATIC_REPAIR_EXHAUSTED,
  AUTOMATIC_REPAIR_PROFILE_MISMATCH,
  decideAutomaticRepair,
  haltFromAutomaticRepair,
  haltFromAutomaticRepairProfile,
  reconcileAutomaticRepair,
} from './automatic-repair.js';
import { ESTIMATED_COST_LABEL } from './billing.js';
import { closeTaskByLaunchPolicy } from './close-dispatch.js';
import { experimentFactsOf } from './doctor.js';
import { withHarnessLock } from './lock.js';
import { runOrchestrationPreflight, type PreflightResult } from './orchestrate-preflight.js';
import {
  detailIteration,
  detailPreflight,
  summarizeIteration,
  summarizePreflight,
  type IterationInput,
} from './orchestrate-report.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
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
import { selectNextTask } from './select.js';
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
 * `--max-iterations` limita ciclos primários de tarefa, não o único reparo
 * bounded da mesma tarefa. Uma invocação com `--max-iterations 1` PODE produzir
 * iteration 1 = FIRST_PASS FAIL + iteration 2 = REPAIR, sem lançar a próxima
 * tarefa do plano. Depois do repair: se PASS, o budget primário já foi
 * consumido; se FAIL, para imediatamente. Nunca existe terceiro repair automático.
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
  timeoutOverride: string | undefined,
  repair: { automaticRepair: boolean; repairSourceAttempt: number } | null,
  expectedTaskId?: string,
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

  const launch = await launchTask(
    paths,
    packet,
    profileId,
    timeoutOverride === undefined ? undefined : Number(timeoutOverride),
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

  const close = await closeTaskByLaunchPolicy({ paths, loaded, taskId: packet.task_id });
  const iteration: IterationInput = {
    ...iterationBase,
    close: close.kind,
    reason: close.reason,
  };
  if (close.kind === 'PASS') {
    return { iteration, closeKind: close.kind, stop: null };
  }
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
  return {
    phase: 'POST_LAUNCH',
    authorized_head_before: state.authorized_head_sha ?? '',
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
  timeoutOverride: string | undefined,
  repair: { automaticRepair: boolean; repairSourceAttempt: number } | null,
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
        timeoutOverride,
        repair,
        original.task_id,
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
  timeoutOverride: string | undefined,
  repair: { automaticRepair: boolean; repairSourceAttempt: number } | null,
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
      timeoutOverride,
      repair,
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
          timeoutOverride,
          repair,
          handled.incident.task_id,
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
  readonly timeoutOverride?: string;
  readonly maxIterations: number;
  readonly autonomy?: 'routine';
  readonly skipPreflight?: boolean;
  readonly verbose?: boolean;
}

export interface OrchestrateResult {
  readonly stop: { readonly status: string; readonly reason: string };
  readonly payload: Record<string, unknown>;
  readonly iterationCount: number;
}

/**
 * Loop canônico do orquestrador. `dev-orchestrate` e `dev-run-plan` consomem
 * esta função; nenhum wrapper reimplementa selection, repair, recovery ou launch.
 */
export async function runOrchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
  const {
    paths,
    loaded,
    profileId,
    timeoutOverride,
    maxIterations,
    autonomy,
    skipPreflight = false,
    verbose = false,
  } = options;
  await ensureRuntimeDirs(paths);

  // Só para o relatório: perfil quebrado continua falhando no lançamento, que é
  // onde a falha significa alguma coisa. Ler aqui não muda o fluxo.
  const profile = await loadProfile(paths.repoRoot, profileId).catch(() => null);
  const facts = profile ? experimentFactsOf(profile) : null;

  const iterations: IterationInput[] = [];
  let stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };

  // O lock cobre o pre-flight E o loop INTEIRO: um segundo orquestrador não
  // pode selecionar nem lançar nada enquanto este ciclo estiver em andamento,
  // e nada muda entre o que o pre-flight conferiu e o que o loop lança.
  let exhausted = false;
  let preflight: PreflightResult | null = null;
  let humanRequired: HumanRequiredOutput | null = null;

  await withHarnessLock(paths, 'dev-orchestrate', async () => {
    if (!skipPreflight) {
      let currentPreflight = await runOrchestrationPreflight({
        paths,
        loaded,
        requestedProfileId: profileId,
      });
      if (currentPreflight.status === 'BLOCKED' && autonomy === 'routine') {
        const incident = await inspectRoutineIncident(paths, currentPreflight);
        const resolution = await resolveRoutinePreflight({
          paths,
          incident,
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

    for (let index = 0; index < maxIterations; index += 1) {
      const failed = (await readState(paths)).tasks.find((task) => task.status === 'FAIL');
      if (failed) {
        const pendingDecision = await decideAutomaticRepair(paths, failed.id);
        const profileHalt = haltFromAutomaticRepairProfile(
          pendingDecision,
          failed.id,
          profileId,
        );
        if (profileHalt) {
          stop = profileHalt;
          break;
        }
        const rec = await reconcileAutomaticRepair({ paths, taskId: failed.id });
        const halt = haltFromAutomaticRepair(rec.decision);
        if (halt) {
          stop = halt;
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
      let repairMeta: { automaticRepair: boolean; repairSourceAttempt: number } | null = null;
      if (subjectId) {
        const pendingDecision = await decideAutomaticRepair(paths, subjectId);
        const profileHalt = haltFromAutomaticRepairProfile(
          pendingDecision,
          subjectId,
          profileId,
        );
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
        }
      }

      let executed = await executeReadyTask(paths, loaded, launchProfile, timeoutOverride, repairMeta);
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
          timeoutOverride,
          repairMeta,
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
      if (executed.closeKind === 'PASS') {
        stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };
        exhausted = index === maxIterations - 1;
        continue;
      }
      if (executed.closeKind !== 'FAIL' || executed.stop === null) {
        stop = executed.stop ?? { status: executed.closeKind ?? 'FAIL', reason: executed.iteration.reason };
        break;
      }

      // FIRST official validation FAIL: um repair bounded na mesma invocação,
      // mesmo profile, sem consumir outro ciclo primário de max-iterations.
      const pendingDecision = await decideAutomaticRepair(paths, executed.iteration.taskId);
      const profileHalt = haltFromAutomaticRepairProfile(
        pendingDecision,
        executed.iteration.taskId,
        profileId,
      );
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
        stop = executed.stop;
        break;
      }

      const capabilityRepairMeta = {
        automaticRepair: true,
        repairSourceAttempt: rec.decision.source_attempt,
      } as const;
      let repair = await executeReadyTask(
        paths,
        loaded,
        rec.decision.profile_id,
        timeoutOverride,
        capabilityRepairMeta,
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
          timeoutOverride,
          capabilityRepairMeta,
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
      if (repair.closeKind === 'PASS') {
        stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };
        exhausted = index === maxIterations - 1;
        continue;
      }
      if (repair.closeKind === 'FAIL') {
        const repairDecision = await decideAutomaticRepair(paths, repair.iteration.taskId);
        stop =
          haltFromAutomaticRepair(repairDecision) ??
          repair.stop ?? {
            status: repair.closeKind,
            reason: repair.iteration.reason,
          };
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
  const payload = {
    ...(humanRequired ?? {}),
    ...(preflightReport === null
      ? {}
      : {
          preflight: verbose ? detailPreflight(preflightReport) : summarizePreflight(preflightReport),
        }),
    stopped_by: stop.status,
    reason: stop.reason,
    // O perfil é único na invocação: repetir agente/modelo/effort em cada
    // iteração seria ruído, não evidência adicional.
    profile_id: profileId,
    agent: facts?.agent ?? 'unknown',
    model: facts?.model ?? 'unknown',
    reasoning_effort: facts?.reasoning_effort ?? 'unknown',
    ...(verbose ? { reasoning_effort_source: facts?.reasoning_effort_source ?? 'unknown' } : {}),
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
