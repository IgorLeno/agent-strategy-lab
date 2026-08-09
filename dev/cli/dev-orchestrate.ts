#!/usr/bin/env tsx
import { ESTIMATED_COST_LABEL } from '../lib/billing.js';
import { closeTaskByLaunchPolicy } from '../lib/close-dispatch.js';
import { VERBOSE_FLAG, emit, fail, isVerbose, parseArgs, runMain } from '../lib/cli.js';
import { DEFAULT_WORKER_PROFILE_ID } from '../lib/defaults.js';
import { experimentFactsOf } from '../lib/doctor.js';
import { withHarnessLock } from '../lib/lock.js';
import {
  detailIteration,
  summarizeIteration,
  type IterationInput,
} from '../lib/orchestrate-report.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { loadProfile } from '../lib/profile.js';
import { selectNextTask } from '../lib/select.js';
import { ensureRuntimeDirs, getTaskState, readState } from '../lib/state.js';
import { launchTask, prepareNextTask, type LaunchStepResult } from '../lib/steps.js';

const DEFAULT_PROFILE = DEFAULT_WORKER_PROFILE_ID;

/**
 * O loop externo: next -> persistir packet -> launch (processo NOVO) -> wait ->
 * close -> PASS? continua : para. O worker nunca executa este loop; ele encerra
 * e o orquestrador decide o que vem depois.
 *
 * Saída padrão: o resultado experimental de cada tarefa (perfil, veredito,
 * tempo de implementação, equivalência em dólar e quota da assinatura).
 * `--verbose` acrescenta os records completos por trás desses números.
 *
 * Exit codes: 0 fluxo terminou sem pendência | 9 fluxo parado (inclui
 * LIMIT_REACHED) | 10 harness ocupado.
 */
function recordOf(launch: LaunchStepResult) {
  return launch.outcome?.record ?? null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), [VERBOSE_FLAG]);
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
      // A tentativa é a do state, não uma contagem local: reparo e retry mexem
      // nela, e o relatório precisa dizer qual tentativa produziu este resultado.
      const attempt = getTaskState(await readState(paths), packet.task_id).attempts;
      if (launch.classification !== 'FINISHED') {
        iterations.push({
          taskId: packet.task_id,
          attempt,
          launch: launch.classification,
          close: null,
          reason: launch.reason,
          record: recordOf(launch),
        });
        stop = { status: launch.classification, reason: launch.reason };
        break;
      }

      const close = await closeTaskByLaunchPolicy({ paths, loaded, taskId: packet.task_id });
      iterations.push({
        taskId: packet.task_id,
        attempt,
        launch: launch.classification,
        close: close.kind,
        reason: close.reason,
        record: recordOf(launch),
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
  const verbose = isVerbose(args);
  const estimates = iterations
    .map((iteration) => iteration.record?.billing?.provider_estimated_api_equivalent_usd ?? null)
    .filter((value): value is number => value !== null);
  // Soma das equivalências que as CLIs estimaram; `null` quando nenhuma sessão
  // reportou número. Continua não sendo cobrança.
  const total = estimates.length ? estimates.reduce((sum, value) => sum + value, 0) : null;

  emit({
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
