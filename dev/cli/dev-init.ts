#!/usr/bin/env tsx
import { access } from 'node:fs/promises';
import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { buildInitialState, ensureRuntimeDirs, writeState } from '../lib/state.js';

/**
 * Cria o runtime (.dev/) a partir de dev/plan.yaml. Nunca sobrescreve um state
 * existente sem --force: reconciliar runtime existente é trabalho do dev-recover.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const { plan, planSha256 } = await loadPlan(paths.planFile);

  const exists = await access(paths.stateFile).then(
    () => true,
    () => false,
  );
  if (exists && !args.flags.has('force')) {
    fail(`state já existe em ${paths.stateFile} — use dev-recover, ou --force para recriar`);
  }

  await ensureRuntimeDirs(paths);
  const state = buildInitialState(plan, planSha256);
  await writeState(paths, state);

  emit({
    initialized: true,
    dev_dir: paths.devDir,
    plan_file: paths.planFile,
    plan_sha256: planSha256,
    task_count: plan.tasks.length,
  });
}

await runMain(main);
