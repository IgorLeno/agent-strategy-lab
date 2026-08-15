#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { recoverProtocolOutput } from '../lib/protocol-output-recovery.js';

/** Arquiva output protocol-invalid e reabre a task sem produzir capability verdict. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  const reason = args.options.get('reason') ?? '';
  if (taskId === '') throw new Error('--task é obrigatório');

  const result = await withHarnessLock(paths, 'dev-recover-protocol-output', () =>
    recoverProtocolOutput({ paths, taskId, reason }),
  );

  emit({
    status: result.alreadyArchived ? 'ALREADY_READY' : 'RECOVERED',
    task_id: result.record.task_id,
    attempt: result.record.attempt,
    classification: result.record.classification,
    attempt_record: result.recordPath,
    protocol_invalid_paths: result.record.protocol_invalid_paths,
    changed_files: result.record.changed_files,
    report_sha256: result.record.report.sha256,
    handoff_draft_sha256: result.record.handoff_draft.sha256,
    patch_fingerprint: result.record.patch_fingerprint,
    capability_fail_recorded: false,
    official_validation_fail_recorded: false,
    authorized_head_sha: result.state.authorized_head_sha,
  });
}

await runMain(main);
