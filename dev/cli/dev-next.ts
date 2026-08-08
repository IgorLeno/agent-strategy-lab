#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { headSha } from '../lib/git.js';
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
    emit({
      status: 'BLOCKED',
      reason: 'dev/plan.yaml mudou desde o dev-init — rode dev-recover para reconciliar',
      packet: null,
    });
    process.exit(4);
  }

  const selection = selectNextTask(loaded, state);
  if (selection.status !== 'SELECTED' || !selection.task) {
    emit({ status: selection.status, reason: selection.reason, packet: null });
    process.exit(selection.status === 'ALL_DONE' ? 0 : 4);
  }

  const previousHandoff = selection.handoffSourceTaskId
    ? await readHandoff(paths, selection.handoffSourceTaskId)
    : null;

  const task = state.tasks.find((candidate) => candidate.id === selection.task?.id);
  const packet = buildTaskPacket({
    task: selection.task,
    baseSha: await headSha(paths.repoRoot),
    previousHandoff,
    previousAttemptDiagnostics: await readPreviousAttemptDiagnostics(
      paths,
      selection.task.id,
      task?.attempts ?? 0,
    ),
  });

  emit({ status: 'SELECTED', reason: selection.reason, packet });
}

await runMain(main);
