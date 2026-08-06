#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { adoptMaintenance } from '../lib/maintenance.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { ensureRuntimeDirs } from '../lib/state.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const reason = args.options.get('reason') ?? '';
  const bootstrapRange = args.flags.has('bootstrap-range');
  const rawMaximum = args.options.get('max-commits');
  const maxCommits = rawMaximum === undefined ? undefined : Number(rawMaximum);

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-adopt-maintenance', () =>
    adoptMaintenance({
      paths,
      reason,
      bootstrapRange,
      ...(maxCommits === undefined ? {} : { maxCommits }),
    }),
  );

  emit({
    status: result.alreadyAdopted ? 'ALREADY_ADOPTED' : 'ADOPTED',
    previous_authorized_head_sha: result.record.previous_authorized_head_sha,
    authorized_head_sha: result.record.adopted_head_sha,
    maintenance_record: `${paths.maintenanceDir}/${result.record.adopted_head_sha}.json`,
    commits: result.record.commits,
  });
}

await runMain(main);
