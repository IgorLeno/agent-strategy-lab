#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { finalizeRecovered } from '../lib/finalize-recovered.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { loadPlan } from '../lib/plan.js';
import { recoveryRecordPath } from '../lib/records.js';
import { ensureRuntimeDirs } from '../lib/state.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  const sourceAttempt = Number(args.options.get('source-attempt'));
  const reason = args.options.get('reason') ?? '';
  const commitMessage = args.options.get('commit-message') ?? '';
  if (taskId === '') throw new Error('--task é obrigatório');

  await ensureRuntimeDirs(paths);
  const loaded = await loadPlan(paths.planFile);
  const result = await withHarnessLock(paths, 'dev-finalize-recovered', () =>
    finalizeRecovered({
      paths,
      loaded,
      taskId,
      sourceAttempt,
      reason,
      commitMessage,
    }),
  );

  emit({
    status: result.alreadyFinalized ? 'ALREADY_PASS' : 'PASS',
    task_id: result.record.task_id,
    source_attempt: result.record.source_attempt,
    candidate_commit: result.record.candidate_commit,
    commit_origin: result.record.commit_origin,
    recovery_record: recoveryRecordPath(
      paths,
      result.record.task_id,
      result.record.source_attempt,
    ),
  });
}

await runMain(main);
