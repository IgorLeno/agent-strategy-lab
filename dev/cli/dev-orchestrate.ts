#!/usr/bin/env tsx
import { closeTask } from '../lib/close.js';
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { ensureRuntimeDirs } from '../lib/state.js';
import { launchTask, prepareNextTask } from '../lib/steps.js';

const DEFAULT_PROFILE = 'claude-build-worker-v1';

interface Iteration {
  readonly task_id: string;
  readonly launch: string;
  readonly close: string | null;
  readonly reason: string;
}

/**
 * O loop externo: next -> persistir packet -> launch (processo NOVO) -> wait ->
 * close -> PASS? continua : para. O worker nunca executa este loop; ele encerra
 * e o orquestrador decide o que vem depois.
 *
 * Exit codes: 0 fluxo terminou sem pendência | 9 fluxo parado.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);

  const profileId = args.options.get('profile') ?? DEFAULT_PROFILE;
  const timeoutOverride = args.options.get('timeout-seconds');
  const maxIterations = Number(args.options.get('max-iterations') ?? '100');

  const iterations: Iteration[] = [];
  let stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };

  // O lock cobre o loop INTEIRO: um segundo orquestrador não pode selecionar
  // nem lançar nada enquanto este ciclo estiver em andamento.
  await withHarnessLock(paths, 'dev-orchestrate', async () => {
    for (let index = 0; index < maxIterations; index += 1) {
      const { selection, packet } = await prepareNextTask(paths, loaded);
      if (!packet || !selection.task) {
        stop = { status: selection.status, reason: selection.reason };
        break;
      }

      const launch = await launchTask(
        paths,
        packet,
        profileId,
        timeoutOverride === undefined ? undefined : Number(timeoutOverride),
      );
      if (launch.classification !== 'FINISHED') {
        iterations.push({
          task_id: packet.task_id,
          launch: launch.classification,
          close: null,
          reason: launch.reason,
        });
        stop = { status: launch.classification, reason: launch.reason };
        break;
      }

      const close = await closeTask({ paths, loaded, taskId: packet.task_id });
      iterations.push({
        task_id: packet.task_id,
        launch: launch.classification,
        close: close.kind,
        reason: close.reason,
      });
      if (close.kind !== 'PASS') {
        stop = { status: close.kind, reason: close.reason };
        break;
      }
      stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };
    }
  });

  const halted = stop.status !== 'ALL_DONE';
  emit({ stopped_by: stop.status, reason: stop.reason, iterations });
  process.exit(halted ? 9 : 0);
}

await runMain(main);
