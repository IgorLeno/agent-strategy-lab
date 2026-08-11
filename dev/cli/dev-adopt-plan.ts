#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { headSha } from '../lib/git.js';
import { withHarnessLock } from '../lib/lock.js';
import { adoptPlanExtension } from '../lib/plan-extension.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { ensureRuntimeDirs } from '../lib/state.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const reason = args.options.get('reason') ?? '';
  const target = args.options.get('target') ?? (await headSha(paths.repoRoot));

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-adopt-plan', () =>
    adoptPlanExtension({
      paths,
      target,
      reason,
    }),
  );

  emit({
    status: result.alreadyAdopted ? 'ALREADY_ADOPTED' : 'ADOPTED',
    previous_authorized_head_sha: result.record.previous_authorized_head_sha,
    authorized_head_sha: result.authorizedHeadSha,
    target_sha: result.targetSha,
    added_task_ids: result.addedTaskIds,
    plan_adoption_record: `${paths.maintenanceDir}/${result.record.adopted_head_sha}.json`,
    validation_summary: result.record.validation_results.map((entry) => ({
      argv: entry.argv,
      exit_code: entry.exit_code,
      timed_out: entry.timed_out,
    })),
  });
}

await runMain(main);
