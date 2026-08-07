#!/usr/bin/env tsx
import { ESTIMATED_COST_LABEL } from '../lib/billing.js';
import { closeTaskByLaunchPolicy } from '../lib/close-dispatch.js';
import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { DEFAULT_WORKER_PROFILE_ID } from '../lib/defaults.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { selectNextTask } from '../lib/select.js';
import { ensureRuntimeDirs, readState } from '../lib/state.js';
import { launchTask, prepareNextTask, type LaunchStepResult } from '../lib/steps.js';

const DEFAULT_PROFILE = DEFAULT_WORKER_PROFILE_ID;

interface Iteration {
  readonly task_id: string;
  readonly launch: string;
  readonly close: string | null;
  readonly reason: string;
  /** Equivalência estimada em preço de API. NÃO é valor cobrado. */
  readonly provider_estimated_api_equivalent_usd: number | null;
}

/**
 * O loop externo: next -> persistir packet -> launch (processo NOVO) -> wait ->
 * close -> PASS? continua : para. O worker nunca executa este loop; ele encerra
 * e o orquestrador decide o que vem depois.
 *
 * Exit codes: 0 fluxo terminou sem pendência | 9 fluxo parado (inclui
 * LIMIT_REACHED) | 10 harness ocupado.
 */
function estimateOf(launch: LaunchStepResult): number | null {
  return launch.outcome?.record.billing?.provider_estimated_api_equivalent_usd ?? null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);

  const profileId = args.options.get('profile') ?? DEFAULT_PROFILE;
  const timeoutOverride = args.options.get('timeout-seconds');
  const maxIterations = Number(args.options.get('max-iterations') ?? '100');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    fail(`--max-iterations precisa ser inteiro positivo: ${args.options.get('max-iterations')}`);
  }

  const iterations: Iteration[] = [];
  let stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };

  // O lock cobre o loop INTEIRO: um segundo orquestrador não pode selecionar
  // nem lançar nada enquanto este ciclo estiver em andamento.
  let exhausted = false;

  await withHarnessLock(paths, 'dev-orchestrate', async () => {
    for (let index = 0; index < maxIterations; index += 1) {
      const { selection, packet, baseViolation } = await prepareNextTask(paths, loaded);
      if (baseViolation) {
        // A tarefa continua READY: base divergente é problema do repositório,
        // não veredito sobre a tarefa.
        stop = { status: 'BASE_DIVERGED', reason: baseViolation };
        break;
      }
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
          provider_estimated_api_equivalent_usd: estimateOf(launch),
        });
        stop = { status: launch.classification, reason: launch.reason };
        break;
      }

      const close = await closeTaskByLaunchPolicy({ paths, loaded, taskId: packet.task_id });
      iterations.push({
        task_id: packet.task_id,
        launch: launch.classification,
        close: close.kind,
        reason: close.reason,
        provider_estimated_api_equivalent_usd: estimateOf(launch),
      });
      if (close.kind !== 'PASS') {
        stop = { status: close.kind, reason: close.reason };
        break;
      }
      stop = { status: 'ALL_DONE', reason: 'nenhuma tarefa pendente' };
      exhausted = index === maxIterations - 1;
    }

    // Sair do `for` por esgotar o limite NÃO é fluxo concluído. Sem esta
    // checagem, `--max-iterations 1` com duas tarefas pendentes reportava
    // ALL_DONE e exit 0, escondendo trabalho que ninguém fez.
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
  const estimates = iterations
    .map((iteration) => iteration.provider_estimated_api_equivalent_usd)
    .filter((value): value is number => value !== null);
  emit({
    stopped_by: stop.status,
    reason: stop.reason,
    iterations,
    // Soma das equivalências que as CLIs estimaram; `null` quando nenhuma
    // sessão reportou número. Continua não sendo cobrança.
    total_provider_estimated_api_equivalent_usd: estimates.length
      ? estimates.reduce((total, value) => total + value, 0)
      : null,
    billing_note: ESTIMATED_COST_LABEL,
  });
  process.exit(halted ? 9 : 0);
}

await runMain(main);
