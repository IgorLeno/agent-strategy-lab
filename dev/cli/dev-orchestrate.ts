#!/usr/bin/env tsx
import {
  VERBOSE_FLAG,
  emit,
  isVerbose,
  parseArgs,
  parseMaxIterations,
  parseRoutineAutonomy,
  runMain,
} from '../lib/cli.js';
import { DEFAULT_WORKER_PROFILE_ID } from '../lib/defaults.js';
import { runOrchestrate, SKIP_PREFLIGHT_FLAG } from '../lib/orchestrate.js';
import { exitCodeForOrchestrationStop } from '../lib/orchestration-termination.js';
import { harnessOverrideFromCli, resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';

const DEFAULT_PROFILE = DEFAULT_WORKER_PROFILE_ID;

/**
 * O loop externo: next -> persistir packet -> launch (processo NOVO) -> wait ->
 * close -> PASS? continua : para. O worker nunca executa este loop; ele encerra
 * e o orquestrador decide o que vem depois.
 *
 * Sem `--plan-file` e `--runtime-dir`, o layout histórico permanece
 * (`<repo>/dev/plan.yaml`, `<repo>/.dev`). Overrides são aditivos.
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
 * Exit codes: 0 invocação concluída normalmente (ALL_DONE ou LIMIT_REACHED) |
 * 9 término bloqueante/anormal | 10 harness ocupado.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), [VERBOSE_FLAG, SKIP_PREFLIGHT_FLAG]);
  const paths = resolveHarnessPaths(
    args.options.get('repo') ?? process.cwd(),
    harnessOverrideFromCli({
      planFile: args.options.get('plan-file'),
      runtimeDir: args.options.get('runtime-dir'),
    }),
  );
  const loaded = await loadPlan(paths.planFile);
  const timeoutOverride = args.options.get('timeout-seconds');
  const autonomy = parseRoutineAutonomy(args);
  const result = await runOrchestrate({
    paths,
    loaded,
    profileId: args.options.get('profile') ?? DEFAULT_PROFILE,
    maxIterations: parseMaxIterations(args),
    skipPreflight: args.flags.has(SKIP_PREFLIGHT_FLAG),
    verbose: isVerbose(args),
    ...(timeoutOverride === undefined ? {} : { timeoutOverride }),
    ...(autonomy === undefined ? {} : { autonomy }),
  });
  emit(result.payload);
  process.exit(exitCodeForOrchestrationStop(result.stop));
}

await runMain(main);
