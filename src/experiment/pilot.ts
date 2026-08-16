/**
 * `ExperimentSpec` concreto do piloto preservado (ver
 * `docs/reviews/PRE-M2-REVIEW.md`): 2 arms Claude Sonnet 5 Medium vs High, as
 * 3 tasks de `corpus/pilot-v1`, 2 repetitions por task/arm — 12 slots
 * planejados, nenhum executado por esta tarefa.
 *
 * `buildPilotExperimentSpec` só lê `corpus/pilot-v1/*\/task-spec.json` e
 * `strategies/direct/1/strategy.yaml` a partir de `repoRoot` — não executa
 * nenhum provider, não faz spawn, não gasta budget.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadStrategy } from '../strategies/index.js';
import { TaskSpec } from '../schemas/index.js';
import { freezeExperimentSpec, type FrozenExperimentSpec } from './index.js';

export const PILOT_TASK_IDS = [
  'add-bounded-retry',
  'add-jsonl-summary-cli',
  'fix-stable-tag-normalization',
] as const;

export const PILOT_ARM_MEDIUM_ID = 'claude-sonnet-5-medium';
export const PILOT_ARM_HIGH_ID = 'claude-sonnet-5-high';
export const PILOT_SEED = 'agent-strategy-lab-pilot-v1';
export const PILOT_REPETITIONS_PER_ARM_TASK = 2;

async function loadPilotTasks(repoRoot: string): Promise<TaskSpec[]> {
  const tasks: TaskSpec[] = [];
  for (const taskId of PILOT_TASK_IDS) {
    const raw = await readFile(
      path.join(repoRoot, 'corpus', 'pilot-v1', taskId, 'task-spec.json'),
      'utf8',
    );
    tasks.push(TaskSpec.parse(JSON.parse(raw) as unknown));
  }
  return tasks;
}

/** Constrói e congela o `ExperimentSpec` do piloto lendo o corpus/strategy do repo em `repoRoot`. */
export async function buildPilotExperimentSpec(repoRoot: string): Promise<FrozenExperimentSpec> {
  const [tasks, strategy] = await Promise.all([
    loadPilotTasks(repoRoot),
    loadStrategy(repoRoot, 'direct', 1),
  ]);

  return freezeExperimentSpec({
    schema_version: 1,
    id: 'pilot-v1-sonnet-medium-vs-high',
    arms: [
      {
        id: PILOT_ARM_MEDIUM_ID,
        agent_profile: {
          id: PILOT_ARM_MEDIUM_ID,
          cli: 'claude',
          cli_version: '2.1.223',
          model: 'claude-sonnet-5',
          flags: ['--effort', 'medium'],
        },
      },
      {
        id: PILOT_ARM_HIGH_ID,
        agent_profile: {
          id: PILOT_ARM_HIGH_ID,
          cli: 'claude',
          cli_version: '2.1.223',
          model: 'claude-sonnet-5',
          flags: ['--effort', 'high'],
        },
      },
    ],
    tasks,
    repetitions_per_arm_task: PILOT_REPETITIONS_PER_ARM_TASK,
    ordering: {
      scheme: 'seeded_interleaved_counterbalanced',
      seed: PILOT_SEED,
    },
    strategy,
    environment_profile: {
      id: 'pilot-v1-controlled',
      mode: 'controlled',
      env_allowlist: ['PATH', 'LANG'],
      home: 'sanitized',
      instruction_files: [],
      plugins: [],
      skills: [],
      mcp_servers: [],
    },
    billing_policy: {
      billing_mode: 'SUBSCRIPTION',
      max_incremental_charge_usd: null,
      quota_stop_threshold_pct: 80,
    },
    planned_slot_count: 12,
  });
}
