#!/usr/bin/env tsx
import path from 'node:path';

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
import { parseLabUiMode } from '../lib/lab-tui.js';
import { createLabUi } from '../lib/lab-ui.js';
import { harnessOverrideFromCli, resolveHarnessInstallationRoot, resolveHarnessPaths } from '../lib/paths.js';
import { PlanSetupError, runPlan } from '../lib/run-plan.js';

const DRY_RUN_FLAG = 'dry-run';

function requireOption(args: ReturnType<typeof parseArgs>, name: string): string {
  const value = args.options.get(name);
  if (value === undefined || value.length === 0) {
    fail(
      `--${name} é obrigatório para dev-run-plan.\n` +
        'Uso: pnpm dev-run-plan --repo <path> --plan <plan.yaml> --profile <id>\n' +
        '     pnpm dev-run-plan --repo <path> --plan <plan.yaml> --authorization <agentlab-run.yaml>',
    );
  }
  return value;
}

/**
 * Entrypoint ergonômica sobre o lifecycle existente. Não é um segundo
 * executor: resolve o setup, inicializa o runtime só quando necessário e
 * delega a `runOrchestrate` / `initializeHarnessRuntime`.
 *
 * `--profile` é obrigatório SEM `--authorization`: esta CLI não escolhe um
 * default implícito. Com `--authorization <agentlab-run.yaml>`, a run passa
 * pelo control plane universal (M71–M84) — intake, inspeção, assessment,
 * routing dentro da policy autorizada, previsão ADVISORY de runtime,
 * review quando a policy exigir, diagnosis, escalation autorizada e gate
 * humano na fronteira — e `--profile`, se informado, precisa pertencer à
 * policy. Sem `--authorization`, o comportamento histórico é idêntico.
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
  const authorization = args.options.get('authorization');
  const profile = authorization === undefined ? requireOption(args, 'profile') : args.options.get('profile');
  const paths = resolveHarnessPaths(
    repo,
    harnessOverrideFromCli({
      planFile: plan,
      runtimeDir: args.options.get('runtime-dir'),
      profileRoot: args.options.get('profile-root') ?? resolveHarnessInstallationRoot(),
    }),
  );

  const uiMode = args.flags.has('ui') ? null : parseLabUiMode(args.options.get('ui'));
  if (uiMode === null) fail('--ui aceita somente auto, tui ou plain.');
  const ui = createLabUi({
    mode: uiMode,
    isTTY: process.stderr.isTTY === true,
    write: (chunk) => {
      process.stderr.write(chunk);
    },
    title: path.basename(path.resolve(repo)),
    ...(process.stderr.columns === undefined ? {} : { columns: process.stderr.columns }),
  });

  try {
    const machineSafetyCeilingOverride = args.options.get('machine-safety-ceiling-seconds');
    const autonomy = parseRoutineAutonomy(args);
    const result = await runPlan({
      paths,
      onProgress: ui.listener,
      ...(profile === undefined ? {} : { profileId: profile }),
      ...(authorization === undefined ? {} : { authorizationFile: authorization }),
      dryRun: args.flags.has(DRY_RUN_FLAG),
      maxIterations: parseMaxIterations(args),
      verbose: isVerbose(args),
      ...(machineSafetyCeilingOverride === undefined ? {} : { machineSafetyCeilingOverride }),
      ...(autonomy === undefined ? {} : { autonomy }),
    });
    ui.finish();
    emit(result.payload);
    if (result.exitCode !== 0) process.exit(result.exitCode);
  } catch (error) {
    ui.finish();
    if (error instanceof PlanSetupError) fail(error.message);
    throw error;
  }
}

await runMain(main);
