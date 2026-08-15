#!/usr/bin/env tsx
import {
  AUTOMATIC_REPAIR_EXHAUSTED,
  AUTOMATIC_REPAIR_PROFILE_MISMATCH,
  decideAutomaticRepair,
  haltFromAutomaticRepair,
  haltFromAutomaticRepairProfile,
  reconcileAutomaticRepair,
} from '../lib/automatic-repair.js';
import { ESTIMATED_COST_LABEL } from '../lib/billing.js';
import { closeTaskByLaunchPolicy } from '../lib/close-dispatch.js';
import { VERBOSE_FLAG, emit, fail, isVerbose, parseArgs, runMain } from '../lib/cli.js';
import { DEFAULT_WORKER_PROFILE_ID } from '../lib/defaults.js';
import { experimentFactsOf } from '../lib/doctor.js';
import { withHarnessLock } from '../lib/lock.js';
import {
  runOrchestrationPreflight,
  type PreflightResult,
} from '../lib/orchestrate-preflight.js';
import {
  detailIteration,
  detailPreflight,
  summarizeIteration,
  summarizePreflight,
  type IterationInput,
} from '../lib/orchestrate-report.js';
import { resolveHarnessPaths, type HarnessPaths } from '../lib/paths.js';
import { loadPlan, type LoadedPlan } from '../lib/plan.js';
import { loadProfile } from '../lib/profile.js';
import { InconsistentAttemptEvidenceError } from '../lib/retry-failed.js';
import {
  inspectRoutineIncident,
  resolveRoutinePreflight,
  type HumanRequiredOutput,
} from '../lib/routine-autonomy.js';
import { createRoutineAutonomyRuntime } from '../lib/routine-autonomy-runtime.js';
import { selectNextTask } from '../lib/select.js';
import { ensureRuntimeDirs, getTaskState, readState } from '../lib/state.js';
import { launchTask, prepareNextTask, type LaunchStepResult } from '../lib/steps.js';

const DEFAULT_PROFILE = DEFAULT_WORKER_PROFILE_ID;

/**
 * Diagnóstico/manutenção APENAS. Pula o pre-flight automático, e com ele a
 * garantia de que maintenance, recover e readiness foram conferidos antes do
 * launch. Nenhuma execução normal de benchmark deve usar esta flag.
 */
const SKIP_PREFLIGHT_FLAG = 'skip-preflight';

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
 * Exit codes: 0 fluxo terminou sem pendência | 9 fluxo parado (inclui
 * LIMIT_REACHED, PREFLIGHT_BLOCKED e AUTOMATIC_REPAIR_EXHAUSTED) | 10 harness ocupado.
 */
function recordOf(launch: LaunchStepResult) {
  return launch.outcome?.record ?? null;
}

interface ExecutionResult {
  readonly iteration: IterationInput;
  readonly closeKind: string | null;
  readonly stop: { status: string; reason: string } | null;
}

async function executeReadyTask(
  paths: HarnessPaths,
  loaded: LoadedPlan,
  profileId: string,
  timeoutOverride: string | undefined,
  repair: { automaticRepair: boolean; repairSourceAttempt: number } | null,
): Promise<ExecutionResult | { readonly empty: true; readonly stop: { status: string; reason: string } }> {
  let prepared;
  try {
    prepared = await prepareNextTask(paths, loaded);
  } catch (error) {
    if (error instanceof InconsistentAttemptEvidenceError) {
      return { empty: true, stop: { status: 'INCONSISTENT_EVIDENCE', reason: error.message } };
    }
    throw error;
  }
  const { selection, packet, baseViolation } = prepared;
  if (baseViolation) {
    return { empty: true, stop: { status: 'BASE_DIVERGED', reason: baseViolation } };
  }
  if (!packet || !selection.task) {
    return { empty: true, stop: { status: selection.status, reason: selection.reason } };
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), [VERBOSE_FLAG, SKIP_PREFLIGHT_FLAG]);
  const autonomy = args.options.get('autonomy');
  if (args.flags.has('autonomy') || (autonomy !== undefined && autonomy !== 'routine')) {
    fail('--autonomy aceita somente routine');
  }
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);

  const profileId = args.options.get('profile') ?? DEFAULT_PROFILE;
  const timeoutOverride = args.options.get('timeout-seconds');
  const maxIterations = Number(args.options.get('max-iterations') ?? '100');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    fail(`--max-iterations precisa ser inteiro positivo: ${args.options.get('max-iterations')}`);
  }

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
    if (!args.flags.has(SKIP_PREFLIGHT_FLAG)) {
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

      const executed = await executeReadyTask(paths, loaded, launchProfile, timeoutOverride, repairMeta);
      if ('empty' in executed) {
        stop = executed.stop;
        break;
      }
      iterations.push(executed.iteration);
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

      const repair = await executeReadyTask(
        paths,
        loaded,
        rec.decision.profile_id,
        timeoutOverride,
        { automaticRepair: true, repairSourceAttempt: rec.decision.source_attempt },
      );
      if ('empty' in repair) {
        stop = repair.stop;
        break;
      }
      iterations.push(repair.iteration);
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

  const halted = stop.status !== 'ALL_DONE';
  const verbose = isVerbose(args);
  const estimates = iterations
    .map((iteration) => iteration.record?.billing?.provider_estimated_api_equivalent_usd ?? null)
    .filter((value): value is number => value !== null);
  // Soma das equivalências que as CLIs estimaram; `null` quando nenhuma sessão
  // reportou número. Continua não sendo cobrança.
  const total = estimates.length ? estimates.reduce((sum, value) => sum + value, 0) : null;

  const preflightReport: PreflightResult | null = preflight;
  emit({
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
  });
  process.exit(halted ? 9 : 0);
}

await runMain(main);
