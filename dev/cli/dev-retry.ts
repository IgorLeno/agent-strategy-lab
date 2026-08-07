#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { attemptAbandonmentPath } from '../lib/records.js';
import { retryAbandonedAttempt } from '../lib/retry.js';
import { AttemptAbandonmentReasonCode } from '../lib/schemas.js';
import { ensureRuntimeDirs } from '../lib/state.js';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  const reason = args.options.get('reason') ?? '';
  const allowInfraOutput = args.flags.has('allow-infra-output');
  const rawReasonCode = args.options.get('reason-code');
  if (taskId === '') throw new Error('--task é obrigatório');

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-retry', () =>
    retryAbandonedAttempt({
      paths,
      taskId,
      reason,
      allowPendingMaintenance: args.flags.has('allow-pending-maintenance'),
      allowInfraOutput,
      ...(rawReasonCode === undefined
        ? {}
        : { reasonCode: AttemptAbandonmentReasonCode.parse(rawReasonCode) }),
    }),
  );

  emit({
    status: result.alreadyRetried ? 'ALREADY_READY' : 'READY',
    task_id: result.record.task_id,
    attempt: result.record.attempt,
    attempt_record: attemptAbandonmentPath(paths, result.record.task_id, result.record.attempt),
    authorized_head_sha: result.state.authorized_head_sha,
    head_sha: result.record.head_sha,
  });
}

await runMain(main);
