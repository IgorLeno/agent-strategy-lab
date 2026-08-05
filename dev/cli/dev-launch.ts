#!/usr/bin/env tsx
import { emit, fail, parseArgs, runMain } from '../lib/cli.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { readPacket } from '../lib/records.js';
import { ensureRuntimeDirs } from '../lib/state.js';
import { launchTask } from '../lib/steps.js';

const DEFAULT_PROFILE = 'claude-build-worker-v1';

/**
 * Lança UM processo novo para UMA tarefa e espera o término. Não fecha a
 * tarefa e não inicia a próxima — quem fecha é o dev-close, quem encadeia é o
 * dev-orchestrate.
 *
 * Exit codes: 0 processo terminou (aguarda fechamento) | 7 TIMED_OUT | 8 INFRA_ERROR.
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const taskId = args.options.get('task') ?? args.positionals[0];
  if (!taskId) fail('informe --task <id>');

  await ensureRuntimeDirs(paths);
  const packet = await readPacket(paths, taskId);
  if (!packet) fail(`task packet ausente para ${taskId} — o orquestrador precisa persisti-lo antes`);

  const timeoutOverride = args.options.get('timeout-seconds');
  const result = await launchTask(
    paths,
    packet,
    args.options.get('profile') ?? DEFAULT_PROFILE,
    timeoutOverride === undefined ? undefined : Number(timeoutOverride),
  );

  emit({
    task_id: taskId,
    classification: result.classification,
    reason: result.reason,
    exit_code: result.outcome?.record.exit_code ?? null,
    duration_ms: result.outcome?.record.duration_ms ?? null,
    process: result.outcome?.record.process ?? null,
    controlled: result.outcome?.record.controlled ?? null,
  });
  process.exit(
    result.classification === 'FINISHED' ? 0 : result.classification === 'TIMED_OUT' ? 7 : 8,
  );
}

await runMain(main);
