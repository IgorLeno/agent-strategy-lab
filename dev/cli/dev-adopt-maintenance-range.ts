#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { headSha } from '../lib/git.js';
import { withHarnessLock } from '../lib/lock.js';
import { adoptMaintenanceRange } from '../lib/maintenance.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { ensureRuntimeDirs } from '../lib/state.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const reason = args.options.get('reason') ?? '';
  const target = args.options.get('target') ?? (await headSha(paths.repoRoot));
  const rawMaximum = args.options.get('max-commits');
  const maxCommits = rawMaximum === undefined ? Number.NaN : Number(rawMaximum);

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-adopt-maintenance-range', () =>
    adoptMaintenanceRange({
      paths,
      target,
      maxCommits,
      reason,
    }),
  );

  emit({
    status: result.alreadyAdopted ? 'ALREADY_ADOPTED' : 'ADOPTED',
    previous_authorized_head_sha: result.record.previous_authorized_head_sha,
    authorized_head_sha: result.record.adopted_head_sha,
    target_sha: result.record.adopted_head_sha,
    maintenance_record: `${paths.maintenanceDir}/${result.record.adopted_head_sha}.json`,
    commits: result.record.commits,
    validation_summary: result.record.validation_results.map((entry) => ({
      argv: entry.argv,
      exit_code: entry.exit_code,
      timed_out: entry.timed_out,
    })),
  });
}

await runMain(main);
