#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { revalidationRecordPath } from '../lib/records.js';
import { revalidateOrchestrated } from '../lib/revalidate.js';
import { ensureRuntimeDirs } from '../lib/state.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  const reasonCode = args.options.get('reason-code') ?? '';
  const reason = args.options.get('reason') ?? '';
  if (taskId === '') throw new Error('--task é obrigatório');

  await ensureRuntimeDirs(paths);
  const loaded = await loadPlan(paths.planFile);
  const result = await withHarnessLock(paths, 'dev-revalidate', () =>
    revalidateOrchestrated({ paths, loaded, taskId, reasonCode, reason }),
  );
  emit({
    status: result.alreadyFinalized ? 'ALREADY_PASS' : result.record.outcome,
    task_id: result.record.task_id,
    attempt: result.record.attempt,
    sequence: result.record.sequence,
    source_base_sha: result.record.source_base_sha,
    finalization_base_sha: result.record.finalization_base_sha,
    candidate_commit: result.record.candidate_commit,
    commit_origin: result.record.commit_origin,
    revalidation_record: revalidationRecordPath(
      paths,
      result.record.task_id,
      result.record.attempt,
      result.record.sequence,
    ),
  });
  if (result.record.outcome === 'FAIL') process.exitCode = 1;
}

await runMain(main);
