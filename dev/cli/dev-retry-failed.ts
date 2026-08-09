#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { retryFailedAttempt } from '../lib/retry-failed.js';
import { ensureRuntimeDirs } from '../lib/state.js';

/**
 * Arquiva um attempt REJEITADO pela validation oficial e devolve a tarefa a
 * READY para um novo attempt de reparo.
 *
 * Não chama provider, não cria commit, não mexe em HEAD e não altera
 * authorized_head_sha. `attempts` não diminui — o próximo launch é um attempt
 * NOVO, com o anterior preservado como evidência.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  const reasonCode = args.options.get('reason-code') ?? '';
  const reason = args.options.get('reason') ?? '';
  if (taskId === '') throw new Error('--task é obrigatório');

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-retry-failed', () =>
    retryFailedAttempt({ paths, taskId, reasonCode, reason }),
  );

  emit({
    status: result.alreadyArchived ? 'ALREADY_ARCHIVED' : 'ARCHIVED',
    task_id: result.record.task_id,
    attempt: result.record.attempt,
    source_base_sha: result.record.source_base_sha,
    profile_id: result.record.profile_id,
    worker_self_reported_result: result.record.worker_self_reported_result,
    orchestrator_verdict: result.record.orchestrator_verdict,
    reason_code: result.record.reason_code,
    changed_files: result.record.changed_files,
    restored_files: result.restored,
    removed_files: result.removed,
    change_bundle: result.record.change_bundle,
    failed_attempt_record: result.recordPath,
    archived_completion: result.completionArchivePath,
    released_current_completion: result.releasedCurrentCompletion,
    source_binding_recovered: result.bindingRecovered,
  });
}

await runMain(main);
