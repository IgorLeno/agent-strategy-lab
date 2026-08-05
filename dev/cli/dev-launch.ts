#!/usr/bin/env tsx
import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { LaunchError, launchWorker } from '../lib/launch.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadProfile } from '../lib/profile.js';
import { readPacket } from '../lib/records.js';
import { ensureRuntimeDirs, getTaskState, readState, withTaskState, writeState } from '../lib/state.js';

const DEFAULT_PROFILE = 'claude-build-worker-v1';

/**
 * Lança UM processo novo para UMA tarefa e espera o término. Não fecha a
 * tarefa e não inicia a próxima — quem fecha é o dev-close, quem encadeia é o
 * dev-orchestrate.
 *
 * Exit codes: 0 processo terminou (aguarda fechamento) | 7 TIMED_OUT | 8 INFRA_ERROR.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? args.positionals[0];
  if (!taskId) fail('informe --task <id>');

  await ensureRuntimeDirs(paths);
  const packet = await readPacket(paths, taskId);
  if (!packet) fail(`task packet ausente para ${taskId} — o orquestrador precisa persisti-lo antes`);

  const profile = await loadProfile(paths.repoRoot, args.options.get('profile') ?? DEFAULT_PROFILE);
  const timeoutOverride = args.options.get('timeout-seconds');

  const before = await readState(paths);
  const task = getTaskState(before, taskId);
  if (task.status !== 'READY') {
    fail(`tarefa ${taskId} está ${task.status}; só READY pode ser lançada`);
  }

  const startedAt = new Date().toISOString();
  let outcome;
  try {
    outcome = await launchWorker({
      paths,
      profile,
      packet,
      ...(timeoutOverride ? { timeoutSecondsOverride: Number(timeoutOverride) } : {}),
      onStarted: async (identity) => {
        const state = await readState(paths);
        await writeState(
          paths,
          withTaskState(state, taskId, {
            status: 'RUNNING',
            phase: 'EXECUTING',
            process: identity,
            base_sha: packet.base_sha,
            attempts: task.attempts + 1,
            diagnostics: null,
            started_at: startedAt,
            finished_at: null,
          }),
        );
      },
    });
  } catch (error) {
    // Falha de lançamento é problema de infraestrutura, não do agente.
    const state = await readState(paths);
    const reason = error instanceof LaunchError ? error.message : String(error);
    await writeState(
      paths,
      withTaskState(state, taskId, { status: 'INFRA_ERROR', phase: null, diagnostics: reason }),
    );
    emit({ task_id: taskId, classification: 'INFRA_ERROR', reason });
    process.exit(8);
  }

  const state = await readState(paths);
  const finishedAt = outcome.record.finished_at ?? new Date().toISOString();

  if (outcome.classification === 'FINISHED') {
    // Processo encerrado com fechamento pendente é estado LEGÍTIMO e repetível.
    await writeState(
      paths,
      withTaskState(state, taskId, { phase: 'FINALIZING', diagnostics: null }),
    );
  } else {
    await writeState(
      paths,
      withTaskState(state, taskId, {
        status: outcome.classification === 'TIMED_OUT' ? 'TIMED_OUT' : 'INFRA_ERROR',
        phase: null,
        diagnostics: outcome.reason,
        finished_at: finishedAt,
      }),
    );
  }

  emit({
    task_id: taskId,
    classification: outcome.classification,
    reason: outcome.reason,
    exit_code: outcome.record.exit_code,
    duration_ms: outcome.record.duration_ms,
    process: outcome.record.process,
    controlled: outcome.record.controlled,
  });
  process.exit(
    outcome.classification === 'FINISHED' ? 0 : outcome.classification === 'TIMED_OUT' ? 7 : 8,
  );
}

await runMain(main);
