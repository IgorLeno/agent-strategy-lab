#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { recover } from '../lib/recover.js';
import { ensureRuntimeDirs, writeState } from '../lib/state.js';

/**
 * Reconcilia runtime e realidade. Com `--dry-run` apenas relata: reconciliar
 * é uma decisão, e às vezes o que se quer é entender antes de mexer.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);

  // --dry-run só relata, então dispensa o lock; aplicar reconciliação muda o
  // state e precisa da mesma exclusão mútua dos outros comandos.
  const result = args.flags.has('dry-run')
    ? await recover(paths, loaded, { applyRecovered: false })
    : await withHarnessLock(paths, 'dev-recover', async () => {
        const reconciled = await recover(paths, loaded, { applyRecovered: true });
        await writeState(paths, reconciled.state);
        return reconciled;
      });

  emit({
    dry_run: args.flags.has('dry-run'),
    state_was_missing: result.stateWasMissing,
    plan_changed: result.planChanged,
    reconciliations: result.reconciliations,
    authorized_head_sha: result.state.authorized_head_sha,
    statuses: Object.fromEntries(result.state.tasks.map((task) => [task.id, task.status])),
  });
}

await runMain(main);
