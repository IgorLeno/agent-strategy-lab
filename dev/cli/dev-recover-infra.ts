#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { recoverInfraAttempt } from '../lib/infra-recover.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { ensureRuntimeDirs } from '../lib/state.js';

/**
 * Arquiva a evidência de um attempt morto por falha terminal do provider e
 * devolve a tarefa a READY. NÃO lança nada: repetir é decisão do usuário.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  const reason = args.options.get('reason') ?? '';
  if (taskId === '') throw new Error('--task é obrigatório');

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-recover-infra', () =>
    recoverInfraAttempt({
      paths,
      taskId,
      reason,
      allowPendingMaintenance: args.flags.has('allow-pending-maintenance'),
    }),
  );

  emit({
    status: result.alreadyArchived ? 'ALREADY_READY' : 'READY',
    task_id: result.record.task_id,
    attempt: result.record.attempt,
    attempt_record: result.recordPath,
    evidence: result.record.evidence.map((file) => file.path),
    provider_failure: result.record.provider_failure,
    exit_code: result.record.exit_code,
    billing: result.record.billing,
    subscription_usage: result.record.subscription_usage,
    stale_inbox_owner_attempt: result.staleInboxOwnerAttempt,
    head_sha: result.record.head_sha,
    authorized_head_sha: result.state.authorized_head_sha,
  });
}

await runMain(main);
