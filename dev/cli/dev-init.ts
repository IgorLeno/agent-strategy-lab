#!/usr/bin/env tsx
import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { initializeHarnessRuntime, RuntimeExistsError } from '../lib/init-runtime.js';
import { harnessOverrideFromCli, resolveHarnessPaths } from '../lib/paths.js';

/**
 * Cria o runtime (.dev/) a partir do PlanFile resolvido. Sem `--plan-file` e
 * `--runtime-dir`, o layout histórico (`<repo>/dev/plan.yaml`, `<repo>/.dev`)
 * permanece. Nunca sobrescreve um state existente sem --force: reconciliar
 * runtime existente é trabalho do dev-recover.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(
    args.options.get('repo') ?? process.cwd(),
    harnessOverrideFromCli({
      planFile: args.options.get('plan-file'),
      runtimeDir: args.options.get('runtime-dir'),
    }),
  );

  try {
    const result = await initializeHarnessRuntime(paths, { force: args.flags.has('force') });
    emit({
      initialized: result.initialized,
      dev_dir: result.dev_dir,
      plan_file: result.plan_file,
      plan_sha256: result.plan_sha256,
      task_count: result.task_count,
    });
  } catch (error) {
    if (error instanceof RuntimeExistsError) fail(error.message);
    throw error;
  }
}

await runMain(main);
