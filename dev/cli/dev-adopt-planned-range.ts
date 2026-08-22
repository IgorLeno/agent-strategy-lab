#!/usr/bin/env tsx
import { emit, fail, isVerbose, parseArgs, runMain } from '../lib/cli.js';
import { headSha } from '../lib/git.js';
import { withHarnessLock } from '../lib/lock.js';
import { resolveHarnessPaths } from '../lib/paths.js';
import { adoptPlannedWorkRange } from '../lib/planned-work-adoption.js';
import { ensureRuntimeDirs } from '../lib/state.js';

const BOOLEAN_FLAGS = ['dry-run', 'verbose'] as const;

/**
 * `--tasks M87=<sha>,M88=<sha>`: o mapping é EXPLÍCITO por decisão de contrato.
 * A forma `--tasks M87,M88` é recusada de propósito — deduzir o commit pela
 * mensagem transformaria uma heurística em autoridade sobre o que cada tarefa
 * implementou.
 */
function parseTaskCommits(raw: string | undefined): Map<string, string> {
  if (raw === undefined || raw.trim() === '') {
    fail('--tasks é obrigatório no formato M87=<sha>,M88=<sha>');
  }
  const mapping = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0 || separator === trimmed.length - 1) {
      fail(`--tasks exige mapping explícito tarefa=commit; recebido: ${trimmed}`);
    }
    const taskId = trimmed.slice(0, separator).trim();
    const commit = trimmed.slice(separator + 1).trim();
    if (mapping.has(taskId)) fail(`--tasks repete a tarefa ${taskId}`);
    mapping.set(taskId, commit);
  }
  if (mapping.size === 0) fail('--tasks não declarou nenhuma tarefa');
  return mapping;
}

function parseCommitList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), BOOLEAN_FLAGS);
  const paths = resolveHarnessPaths(args.options.get('repo') ?? process.cwd());
  const reason = args.options.get('reason') ?? '';
  const target = args.options.get('target') ?? (await headSha(paths.repoRoot));
  const taskCommits = parseTaskCommits(args.options.get('tasks'));
  const maintenanceCommits = parseCommitList(args.options.get('maintenance-commits'));
  const dryRun = args.flags.has('dry-run');

  await ensureRuntimeDirs(paths);
  const input = {
    paths,
    target,
    taskCommits,
    maintenanceCommits,
    reason,
    dryRun,
  };
  // O dry-run não escreve arquivo, record nem state; ainda assim toma o lock,
  // porque ele LÊ o runtime e um preview calculado durante outra transação
  // descreveria um estado que nunca existiu.
  const result = await withHarnessLock(paths, 'dev-adopt-planned-range', () =>
    adoptPlannedWorkRange(input),
  );

  if (result.status === 'DRY_RUN') {
    const preview = result.preview;
    emit({
      status: 'DRY_RUN',
      previous_authorized_head: preview.previousAuthorizedHeadSha,
      target: preview.targetSha,
      plan_extension_commit: preview.planExtensionCommitSha,
      previous_plan_sha256: preview.previousPlanSha256,
      adopted_plan_sha256: preview.adoptedPlanSha256,
      plan_added_task_count: preview.planAddedTaskIds.length,
      tasks_requested: preview.tasks.map((task) => ({
        task_id: task.taskId,
        commit: task.acceptedCommit,
        committed_at: task.committedAt,
        plan_task_fingerprint_sha256: task.planTaskFingerprintSha256,
        validation_commands: task.validationArgv,
      })),
      maintenance_commits: preview.commits
        .filter((commit) => commit.role === 'unplanned_maintenance')
        .map((commit) => ({ sha: commit.sha, changed_files: commit.changed_files })),
      range_validation_commands: preview.rangeValidationArgv,
      state_transitions: preview.stateTransitions,
      authorized_head_transition: preview.authorizedHeadTransition,
      ...(isVerbose(args) ? { commits: preview.commits } : {}),
      writes: { files: 0, records: 0, state: 0 },
    });
    return;
  }

  emit({
    status: result.status,
    previous_authorized_head_sha: result.record.previous_authorized_head_sha,
    authorized_head_sha: result.authorizedHeadSha,
    target_sha: result.record.adopted_head_sha,
    plan_extension_commit_sha: result.record.plan_extension_commit_sha,
    adoption_record: result.recordPath,
    adopted_tasks: result.record.tasks.map((task) => ({
      task_id: task.task_id,
      accepted_commit: task.accepted_commit,
      completion_origin: task.completion_origin,
      executed_by_harness: task.executed_by_harness,
      validation_summary: task.validation_results.map((entry) => ({
        argv: entry.argv,
        exit_code: entry.exit_code,
        timed_out: entry.timed_out,
      })),
    })),
    range_validation_summary: result.record.range_validation_results.map((entry) => ({
      argv: entry.argv,
      exit_code: entry.exit_code,
      timed_out: entry.timed_out,
    })),
    ...(isVerbose(args) ? { commits: result.record.commits } : {}),
  });
}

await runMain(main);
