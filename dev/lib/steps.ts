import { headSha } from './git.js';
import { LaunchError, launchWorker, type LaunchOutcome } from './launch.js';
import { buildTaskPacket } from './packet.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { loadProfile } from './profile.js';
import { readHandoff, writePacket } from './records.js';
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
}

/** Seleciona a próxima tarefa e PERSISTE o packet (dev-next só imprime). */
export async function prepareNextTask(
  paths: HarnessPaths,
  loaded: LoadedPlan,
): Promise<PrepareResult> {
  const state = await readState(paths);
  const selection = selectNextTask(loaded, state);
  if (selection.status !== 'SELECTED' || !selection.task) return { selection, packet: null };

  const previousHandoff = selection.handoffSourceTaskId
    ? await readHandoff(paths, selection.handoffSourceTaskId)
    : null;
  const packet = buildTaskPacket({
    task: selection.task,
    baseSha: await headSha(paths.repoRoot),
    previousHandoff,
  });
  await writePacket(paths, packet);
  return { selection, packet };
}

export interface LaunchStepResult {
  readonly classification: LaunchOutcome['classification'];
  readonly reason: string;
  readonly outcome: LaunchOutcome | null;
}

/**
 * Lança o worker e move o state conforme o término. Processo encerrado com
 * fechamento pendente (RUNNING/FINALIZING) é legítimo e repetível — só
 * timeout e falha de infraestrutura param o fluxo aqui.
 */
export async function launchTask(
  paths: HarnessPaths,
  packet: TaskPacket,
  profileId: string,
  timeoutSecondsOverride?: number,
): Promise<LaunchStepResult> {
  const taskId = packet.task_id;
  const profile = await loadProfile(paths.repoRoot, profileId);
  const before = getTaskState(await readState(paths), taskId);
  if (before.status !== 'READY') {
    throw new LaunchError(`tarefa ${taskId} está ${before.status}; só READY pode ser lançada`);
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
