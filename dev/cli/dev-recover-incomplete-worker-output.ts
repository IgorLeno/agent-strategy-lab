#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { recoverIncompleteWorkerOutput } from '../lib/incomplete-worker-output-recovery.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { ensureRuntimeDirs } from '../lib/state.js';

/**
 * Preserva patch/logs de um worker que terminou sem completion artifacts e
 * devolve a task a READY. Não inventa report/handoff e não lança provider.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  const reason = args.options.get('reason') ?? '';
  if (taskId === '') throw new Error('--task é obrigatório');

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-recover-incomplete-worker-output', () =>
    recoverIncompleteWorkerOutput({ paths, taskId, reason }),
  );

  const task = result.state.tasks.find((candidate) => candidate.id === taskId);
  emit({
    status: result.alreadyArchived ? 'ALREADY_READY' : 'RECOVERED',
    task_id: result.record.task_id,
    attempt: result.record.attempt,
    evidence_paths: result.evidence_paths,
    archive_paths: result.evidence_paths,
    changed_files: result.changed_files,
    patch_fingerprint: result.patch_fingerprint,
    report_present: result.report_present,
    handoff_present: result.handoff_present,
    capability_fail_recorded: result.capability_fail_recorded,
    official_validation_fail_recorded: result.official_validation_fail_recorded,
    state: task?.status ?? null,
    authorized_head_sha: result.state.authorized_head_sha,
  });
}

await runMain(main);
