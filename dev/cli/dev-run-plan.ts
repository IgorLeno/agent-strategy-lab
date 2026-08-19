#!/usr/bin/env tsx
import {
  VERBOSE_FLAG,
  emit,
  fail,
  isVerbose,
  parseArgs,
  parseMaxIterations,
  parseRoutineAutonomy,
  runMain,
} from '../lib/cli.js';
import { harnessOverrideFromCli, resolveHarnessInstallationRoot, resolveHarnessPaths } from '../lib/paths.js';
import { PlanSetupError, runPlan } from '../lib/run-plan.js';

const DRY_RUN_FLAG = 'dry-run';

function requireOption(args: ReturnType<typeof parseArgs>, name: string): string {
  const value = args.options.get(name);
  if (value === undefined || value.length === 0) {
    fail(
      `--${name} é obrigatório para dev-run-plan.\n` +
        'Uso: pnpm dev-run-plan --repo <path> --plan <plan.yaml> --profile <id>',
    );
  }
  return value;
}

/**
 * Entrypoint ergonômica sobre o lifecycle existente. Não é um segundo
 * executor: resolve o setup, inicializa o runtime só quando necessário e
 * delega a `runOrchestrate` / `initializeHarnessRuntime`.
 *
 * `--profile` é obrigatório: esta CLI não escolhe um default implícito.
 * `--plan` aponta para o PlanFile autoritativo e NÃO o copia para
 * `<repo>/dev/plan.yaml`.
 * `--profile` é carregado do catálogo do Agent Strategy Lab (não do alvo).
 * `--profile-root` é override opcional; o happy path não o exige.
 *
 * Exit codes: 0 READY/ALL_DONE/LIMIT_REACHED | 1 setup inválido |
 * 9 mismatch ou término bloqueante | 10 harness ocupado.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), [VERBOSE_FLAG, DRY_RUN_FLAG]);
  const repo = requireOption(args, 'repo');
  const plan = requireOption(args, 'plan');
  const profile = requireOption(args, 'profile');
  const paths = resolveHarnessPaths(
    repo,
    harnessOverrideFromCli({
      planFile: plan,
      runtimeDir: args.options.get('runtime-dir'),
      profileRoot: args.options.get('profile-root') ?? resolveHarnessInstallationRoot(),
    }),
  );

  try {
    const timeoutOverride = args.options.get('timeout-seconds');
    const autonomy = parseRoutineAutonomy(args);
    const result = await runPlan({
      paths,
      profileId: profile,
      dryRun: args.flags.has(DRY_RUN_FLAG),
      maxIterations: parseMaxIterations(args),
      verbose: isVerbose(args),
      ...(timeoutOverride === undefined ? {} : { timeoutOverride }),
      ...(autonomy === undefined ? {} : { autonomy }),
    });
    emit(result.payload);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } catch (error) {
    if (error instanceof PlanSetupError) fail(error.message);
    throw error;
  }
}

await runMain(main);
