#!/usr/bin/env tsx
import { inspectProgressionBase } from '../lib/base-guard.js';
import { emit, isVerbose, parseArgs, runMain } from '../lib/cli.js';
import { headSha } from '../lib/git.js';
import { resolveRecoveredWork } from '../lib/steps.js';
import { buildTaskPacket } from '../lib/packet.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { readHandoff } from '../lib/records.js';
import { readPreviousAttemptDiagnostics } from '../lib/retry-failed.js';
import { selectNextTask } from '../lib/select.js';
import { readState } from '../lib/state.js';

/**
 * SOMENTE LEITURA. Seleciona a próxima tarefa e imprime o packet em stdout.
 * Persistir o packet e mudar estado é responsabilidade do orquestrador —
 * quem decide não é quem registra.
 *
 * Exit codes: 0 packet emitido | 0 nada pendente | 4 fluxo parado ou ocupado.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const loaded = await loadPlan(paths.planFile);
  const state = await readState(paths);

  if (state.plan_sha256 !== loaded.planSha256) {
    const reason = 'dev/plan.yaml mudou desde o dev-init — rode dev-recover para reconciliar';
    emit(
      isVerbose(args)
        ? { status: 'BLOCKED', reason, packet: null }
        : { status: 'BLOCKED', ready_to_launch: false, reason },
    );
    process.exit(4);
  }

  const selection = selectNextTask(loaded, state);
  if (selection.status !== 'SELECTED' || !selection.task) {
    emit(
      isVerbose(args)
        ? { status: selection.status, reason: selection.reason, packet: null }
        : { status: selection.status, ready_to_launch: false, reason: selection.reason },
    );
    process.exit(selection.status === 'ALL_DONE' ? 0 : 4);
  }

  const previousHandoff = selection.handoffSourceTaskId
    ? await readHandoff(paths, selection.handoffSourceTaskId)
    : null;

  const task = state.tasks.find((candidate) => candidate.id === selection.task?.id);
  const previousAttemptDiagnostics = await readPreviousAttemptDiagnostics(
    paths,
    selection.task.id,
    task?.attempts ?? 0,
  );
  const progressionBase = await inspectProgressionBase(paths, state);
  const baseSha = await headSha(paths.repoRoot);
  // Trabalho que sobreviveu à morte do provider num attempt anterior. Sai da
  // MESMA derivação que o orquestrador usa para montar o packet de verdade —
  // dev-next imprime o que seria lançado, e não uma segunda opinião.
  const recoveredWork = await resolveRecoveredWork(paths, selection.task.id, state, baseSha);
  const packet = buildTaskPacket({
    task: selection.task,
    baseSha,
    previousHandoff,
    previousAttemptDiagnostics,
    recoveredWork,
  });
  const recoverableOutput =
    packet.recovered_work === undefined
      ? {}
      : { recovered_work: packet.recovered_work };
  const readyToLaunch = progressionBase.blocker === null;

  if (isVerbose(args)) {
    emit({
      status: 'SELECTED',
      reason: selection.reason,
      packet,
      ready_to_launch: readyToLaunch,
      authorized_head_sha: state.authorized_head_sha,
      ...recoverableOutput,
    });
    return;
  }

  emit({
    status: 'SELECTED',
    ready_to_launch: readyToLaunch,
    task_id: selection.task.id,
    title: selection.task.title,
    attempt: (task?.attempts ?? 0) + 1,
    attempt_kind: previousAttemptDiagnostics === null ? 'FIRST_PASS' : 'REPAIR',
    base_sha: baseSha,
    authorized_head_sha: state.authorized_head_sha,
    ...recoverableOutput,
    ...(progressionBase.blocker === null ? {} : { blocker: progressionBase.blocker }),
  });
}

await runMain(main);
