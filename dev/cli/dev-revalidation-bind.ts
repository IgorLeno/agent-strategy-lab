#!/usr/bin/env tsx
import { emit, parseArgs, runMain } from '../lib/cli.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { bindRevalidationSource } from '../lib/revalidation-bind.js';
import { ensureRuntimeDirs } from '../lib/state.js';

/**
 * Sela a evidence de origem de um FAIL para que ele possa ser revalidado
 * depois. Não roda validation, não muda state, não move HEAD e não chama
 * provider — publica evidência write-once e nada mais.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? '';
  if (taskId === '') throw new Error('--task é obrigatório');

  await ensureRuntimeDirs(paths);
  const result = await withHarnessLock(paths, 'dev-revalidation-bind', () =>
    bindRevalidationSource({ paths, taskId }),
  );

  emit({
    status: result.alreadyBound ? 'ALREADY_BOUND' : 'BOUND',
    task_id: result.binding.task_id,
    attempt: result.binding.attempt,
    source_base_sha: result.binding.source_base_sha,
    changed_files: result.binding.changed_files,
    derived_patch_fingerprint: result.binding.derived_patch_fingerprint,
    fingerprint_provenance: result.binding.fingerprint_provenance,
    source_binding: result.bindingPath,
    original_completion: result.originalCompletionPath,
  });
}

await runMain(main);
