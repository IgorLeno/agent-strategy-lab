import { closeTask, type CloseInput, type CloseOutcome } from './close.js';
import { finalizeOrchestratedTask } from './finalize-orchestrated.js';
import { readLaunchRecord } from './records.js';

/** Dispatches solely from the policy captured at launch, never from mutable profile files. */
export async function closeTaskByLaunchPolicy(input: CloseInput): Promise<CloseOutcome> {
  const launch = await readLaunchRecord(input.paths, input.taskId);
  // Runs anteriores à existência de LaunchRecord só podem ter sido worker-owned.
  if (!launch) return closeTask(input);
  return launch.execution_policy.commit_owner === 'orchestrator'
    ? finalizeOrchestratedTask(input)
    : closeTask(input);
}
