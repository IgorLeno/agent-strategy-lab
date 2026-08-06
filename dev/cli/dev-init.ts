#!/usr/bin/env tsx
import { access } from 'node:fs/promises';
import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { headSha } from '../lib/git.js';
import { withHarnessLock } from '../lib/lock.js';
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
  // O HEAD do init é a base legítima da primeira tarefa: sem esse registro,
  // não há como distinguir "nada aconteceu ainda" de "alguém commitou fora".
  const baselineSha = await headSha(paths.repoRoot);
  await withHarnessLock(paths, 'dev-init', () =>
    writeState(paths, buildInitialState(plan, planSha256, { baselineSha })),
  );

  emit({
    initialized: true,
    dev_dir: paths.devDir,
    plan_file: paths.planFile,
    plan_sha256: planSha256,
    task_count: plan.tasks.length,
  });
}

await runMain(main);
