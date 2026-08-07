#!/usr/bin/env tsx
import { closeTaskByLaunchPolicy } from '../lib/close-dispatch.js';
import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { readState } from '../lib/state.js';
import { selectNextTask } from '../lib/select.js';

/**
 * Fechamento é do orquestrador, nunca do worker: só aqui o candidate commit
 * vira accepted_commit, e só depois de re-executar as validações do packet.
 *
 * Exit codes: 0 PASS | 5 FAIL | 6 guarda operacional incompleta (retry legítimo).
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const loaded = await loadPlan(paths.planFile);

  const explicit = args.options.get('task') ?? args.positionals[0];
  const taskId = explicit ?? (await inferRunningTask(paths, loaded));
  if (!taskId) fail('nenhuma tarefa RUNNING para fechar — informe --task <id>');

  const result = await withHarnessLock(paths, 'dev-close', () =>
    closeTaskByLaunchPolicy({ paths, loaded, taskId }),
  );
  emit({
    task_id: result.taskId,
    result: result.kind,
    reason: result.reason,
    discrepancies: result.discrepancies,
    accepted_commit: result.completion?.orchestrator_evidence.accepted_commit ?? null,
  });
  process.exit(result.kind === 'PASS' ? 0 : result.kind === 'FAIL' ? 5 : 6);
}

async function inferRunningTask(
  paths: ReturnType<typeof resolveHarnessPaths>,
  loaded: Awaited<ReturnType<typeof loadPlan>>,
): Promise<string | null> {
  const state = await readState(paths);
  const running = state.tasks.find((task) => task.status === 'RUNNING');
  if (running) return running.id;
  // Sem RUNNING, o único fechamento plausível é o repetido de uma tarefa já aceita.
  const selection = selectNextTask(loaded, state);
  return selection.status === 'BUSY' ? (selection.task?.id ?? null) : null;
}

await runMain(main);
