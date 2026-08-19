import { checkProgressionBase } from './base-guard.js';
import { headSha } from './git.js';
import {
  BillingPreflightError,
  InboxProvenanceError,
  LaunchError,
  UsageMeasurementSafetyError,
  launchWorker,
  type LaunchOutcome,
} from './launch.js';
import { buildTaskPacket } from './packet.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { loadProfile } from './profile.js';
import { readHandoff, writePacket } from './records.js';
import { readPreviousAttemptDiagnostics } from './retry-failed.js';
import { selectNextTask, type Selection } from './select.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';
import type { TaskPacket } from './schemas.js';

/**
 * Passos que orquestrador e CLIs individuais compartilham. Cada passo faz uma
 * coisa e devolve o suficiente para decidir o próximo — o encadeamento é do
 * dev-orchestrate, nunca do worker.
 */

export interface PrepareResult {
  readonly selection: Selection;
  readonly packet: TaskPacket | null;
  /** Motivo do bloqueio de base; `null` quando a progressão está liberada. */
  readonly baseViolation: string | null;
}

/** Seleciona a próxima tarefa e PERSISTE o packet (dev-next só imprime). */
export async function prepareNextTask(
  paths: HarnessPaths,
  loaded: LoadedPlan,
): Promise<PrepareResult> {
  const state = await readState(paths);
  const selection = selectNextTask(loaded, state);
  if (selection.status !== 'SELECTED' || !selection.task) {
    return { selection, packet: null, baseViolation: null };
  }

  // A base é conferida ANTES de gerar o packet: base_sha capturado de um HEAD
  // divergente contaminaria a evidência da tarefa inteira.
  const baseViolation = await checkProgressionBase(paths, state);
  if (baseViolation) return { selection, packet: null, baseViolation };

  const previousHandoff = selection.handoffSourceTaskId
    ? await readHandoff(paths, selection.handoffSourceTaskId)
    : null;
  // Diagnostics do repair: a primitive atravessa gaps de INFRA_ERROR
  // (capability-neutral) até o ValidationFailedAttemptRecord que alimenta o reparo.
  const previousAttemptDiagnostics = await readPreviousAttemptDiagnostics(
    paths,
    selection.task.id,
    getTaskState(state, selection.task.id).attempts,
  );
  const packet = buildTaskPacket({
    task: selection.task,
    baseSha: await headSha(paths.repoRoot),
    previousHandoff,
    previousAttemptDiagnostics,
  });
  await writePacket(paths, packet);
  return { selection, packet, baseViolation: null };
}

export interface LaunchStepResult {
  readonly classification: LaunchOutcome['classification'] | 'PREFLIGHT_BLOCKED';
  readonly reason: string;
  readonly outcome: LaunchOutcome | null;
}

/**
 * Recusa ANTES do spawn: nenhum provider nasceu, nenhum attempt foi consumido,
 * nenhum LaunchRecord existe. Não é INFRA_ERROR — a tarefa permanece READY.
 */
function isPreSpawnRefusal(error: unknown): boolean {
  return (
    error instanceof InboxProvenanceError ||
    error instanceof BillingPreflightError ||
    error instanceof UsageMeasurementSafetyError
  );
}

/**
 * Lança o worker e move o state conforme o término. Processo encerrado com
 * fechamento pendente (RUNNING/FINALIZING) é legítimo e repetível — só
 * timeout e falha de infraestrutura param o fluxo aqui.
 *
 * Recusa de proveniência/billing/usage ANTES do spawn NÃO muda o status da
 * tarefa: é blocker operacional pré-launch, não veredito de infraestrutura.
 */
export async function launchTask(
  paths: HarnessPaths,
  packet: TaskPacket,
  profileId: string,
  timeoutSecondsOverride?: number,
): Promise<LaunchStepResult> {
  const taskId = packet.task_id;
  const profile = await loadProfile(paths.repoRoot, profileId, {
    catalogRoot: paths.profileCatalogRoot,
  });
  const stateBefore = await readState(paths);
  const before = getTaskState(stateBefore, taskId);
  if (before.status !== 'READY') {
    throw new LaunchError(`tarefa ${taskId} está ${before.status}; só READY pode ser lançada`);
  }
  // Também aqui, e não só no prepare: o dev-launch aceita packet persistido
  // antes, e o repositório pode ter mudado nesse intervalo. Bloquear não muda
  // o status da tarefa — divergência de base não é falha do worker.
  const baseViolation = await checkProgressionBase(paths, stateBefore);
  if (baseViolation) throw new LaunchError(`base inválida para ${taskId}: ${baseViolation}`);
  if (packet.base_sha !== (await headSha(paths.repoRoot))) {
    throw new LaunchError(
      `packet de ${taskId} tem base_sha ${packet.base_sha}, diferente do HEAD atual — gere o packet de novo`,
    );
  }
  const startedAt = new Date().toISOString();

  let outcome: LaunchOutcome;
  try {
    outcome = await launchWorker({
      paths,
      profile,
      packet,
      ...(timeoutSecondsOverride === undefined ? {} : { timeoutSecondsOverride }),
      onStarted: async (identity) => {
        const state = await readState(paths);
        await writeState(
          paths,
          withTaskState(state, taskId, {
            status: 'RUNNING',
            phase: 'EXECUTING',
            process: identity,
            base_sha: packet.base_sha,
            attempts: before.attempts + 1,
            diagnostics: null,
            started_at: startedAt,
            finished_at: null,
          }),
        );
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isPreSpawnRefusal(error)) {
      return { classification: 'PREFLIGHT_BLOCKED', reason, outcome: null };
    }
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, taskId, { status: 'INFRA_ERROR', phase: null, diagnostics: reason }),
    );
    return { classification: 'INFRA_ERROR', reason, outcome: null };
  }

  const state = await readState(paths);
  if (outcome.classification === 'FINISHED') {
    await writeState(paths, withTaskState(state, taskId, { phase: 'FINALIZING', diagnostics: null }));
  } else {
    await writeState(
      paths,
      withTaskState(state, taskId, {
        status: outcome.classification === 'TIMED_OUT' ? 'TIMED_OUT' : 'INFRA_ERROR',
        phase: null,
        diagnostics: outcome.reason,
        finished_at: outcome.record.finished_at ?? new Date().toISOString(),
      }),
    );
  }
  return { classification: outcome.classification, reason: outcome.reason, outcome };
}
