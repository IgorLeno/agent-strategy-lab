import { commitExists } from './git.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { isSameProcessAlive } from './process-identity.js';
import { readCompletion } from './records.js';
import {
  DevelopmentState,
  type TaskState,
} from './schemas.js';
import { buildInitialState, initialTaskState, readState } from './state.js';

export interface Reconciliation {
  readonly task_id: string;
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

export interface RecoveryResult {
  readonly state: DevelopmentState;
  readonly reconciliations: readonly Reconciliation[];
  readonly planChanged: boolean;
  readonly stateWasMissing: boolean;
}

/**
 * Reconcilia plano + commits + completions + runtime existente. O plano é a
 * fonte autoritativa; o runtime é reconstruível. Nenhuma tarefa pode ficar
 * RUNNING para sempre: processo morto em EXECUTING vira INFRA_ERROR, e em
 * FINALIZING continua pendente de fechamento — que é retry legítimo.
 */
export async function recover(
  paths: HarnessPaths,
  loaded: LoadedPlan,
): Promise<RecoveryResult> {
  const existing = await readState(paths).catch(() => null);
  const stateWasMissing = existing === null;
  const planChanged = existing !== null && existing.plan_sha256 !== loaded.planSha256;

  const previous = new Map((existing?.tasks ?? []).map((task) => [task.id, task]));
  const reconciliations: Reconciliation[] = [];
  const tasks: TaskState[] = [];

  for (const planTask of loaded.plan.tasks) {
    const before = previous.get(planTask.id);
    if (!before) {
      tasks.push(initialTaskState(planTask.id));
      if (existing) {
        reconciliations.push({
          task_id: planTask.id,
          from: 'ausente',
          to: 'READY',
          reason: 'tarefa nova no plano',
        });
      }
      continue;
    }
    const { task, reconciliation } = await reconcileTask(paths, before);
    tasks.push(task);
    if (reconciliation) reconciliations.push(reconciliation);
  }

  for (const id of previous.keys()) {
    if (!loaded.byId.has(id)) {
      reconciliations.push({
        task_id: id,
        from: previous.get(id)?.status ?? 'desconhecido',
        to: 'removida',
        reason: 'tarefa não existe mais no plano',
      });
    }
  }

  const base = existing ?? buildInitialState(loaded.plan, loaded.planSha256);
  const state = DevelopmentState.parse({
    ...base,
    plan_sha256: loaded.planSha256,
    tasks,
  });
  return { state, reconciliations, planChanged, stateWasMissing };
}

async function reconcileTask(
  paths: HarnessPaths,
  before: TaskState,
): Promise<{ task: TaskState; reconciliation: Reconciliation | null }> {
  const completion = await readCompletion(paths, before.id).catch(() => null);

  // Fechamento já gravado mas perdido do state: o CompletionRecord manda.
  if (before.status !== 'PASS' && completion?.status === 'PASS') {
    const accepted = completion.orchestrator_evidence.accepted_commit;
    if (accepted && (await commitExists(paths.repoRoot, accepted))) {
      return {
        task: {
          ...before,
          status: 'PASS',
          phase: null,
          accepted_commit: accepted,
          candidate_commit: accepted,
          diagnostics: null,
          finished_at: completion.closed_at,
        },
        reconciliation: {
          task_id: before.id,
          from: before.status,
          to: 'PASS',
          reason: 'CompletionRecord aceito existia mas o state não refletia',
        },
      };
    }
  }

  if (before.status !== 'RUNNING') return { task: before, reconciliation: null };

  const alive = before.process ? await isSameProcessAlive(before.process) : false;
  if (alive) return { task: before, reconciliation: null };

  if (before.phase === 'EXECUTING') {
    return {
      task: {
        ...before,
        status: 'INFRA_ERROR',
        phase: null,
        diagnostics: 'RUNNING/EXECUTING com processo inexistente — worker sumiu',
        finished_at: new Date().toISOString(),
      },
      reconciliation: {
        task_id: before.id,
        from: 'RUNNING/EXECUTING',
        to: 'INFRA_ERROR',
        reason: 'processo registrado não existe mais',
      },
    };
  }

  // RUNNING/FINALIZING com processo encerrado é legítimo: falta fechar.
  return {
    task: { ...before, diagnostics: before.diagnostics ?? 'fechamento pendente — repita dev-close' },
    reconciliation: {
      task_id: before.id,
      from: 'RUNNING/FINALIZING',
      to: 'RUNNING/FINALIZING',
      reason: 'processo encerrado, fechamento pendente (retry de dev-close)',
    },
  };
}
