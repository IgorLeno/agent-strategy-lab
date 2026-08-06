import { canonicalSha256 } from './canonical.js';
import { commitExists, headSha } from './git.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { isSameProcessAlive } from './process-identity.js';
import { readCloseManifest, readCompletion, readHandoff } from './records.js';
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

  // State reconstruído do zero (ou vindo de antes do campo existir) precisa de
  // baseline: sem ele, a guarda de progressão não tem contra o que comparar o
  // HEAD antes da primeira tarefa aceita.
  const base = existing ?? buildInitialState(loaded.plan, loaded.planSha256);
  const baselineSha = base.baseline_sha ?? (await headSha(paths.repoRoot).catch(() => null));
  const state = DevelopmentState.parse({
    ...base,
    plan_sha256: loaded.planSha256,
    baseline_sha: baselineSha,
    tasks,
  });
  return { state, reconciliations, planChanged, stateWasMissing };
}

export type BundleStatus = 'NONE' | 'INCOMPLETE' | 'VALID';

export interface BundleVerification {
  readonly status: BundleStatus;
  readonly reason: string;
  readonly acceptedCommit: string;
  readonly closedAt: string;
}

function bundle(status: BundleStatus, reason: string): BundleVerification {
  return { status, reason, acceptedCommit: '', closedAt: '' };
}

/**
 * Um fechamento aceito só conta quando todas as peças concordam entre si:
 * CompletionRecord PASS, HandoffRecord selado, manifesto amarrando os dois
 * pelo hash, mesma tarefa, mesmo accepted_commit, e o commit existindo no
 * repositório. Qualquer peça faltando ou divergente é `INCOMPLETE` — e
 * INCOMPLETE nunca vira PASS.
 */
export async function verifyCloseBundle(
  paths: HarnessPaths,
  taskId: string,
): Promise<BundleVerification> {
  const completion = await readCompletion(paths, taskId).catch(() => null);
  if (!completion || completion.status !== 'PASS') return bundle('NONE', 'sem fechamento aceito');
  if (completion.task_id !== taskId) {
    return bundle('INCOMPLETE', `completion pertence a ${completion.task_id}`);
  }

  const accepted = completion.orchestrator_evidence.accepted_commit;
  if (!accepted) return bundle('INCOMPLETE', 'completion PASS sem accepted_commit');

  const handoff = await readHandoff(paths, taskId).catch(() => null);
  if (!handoff) return bundle('INCOMPLETE', 'handoff selado ausente ou inválido');
  if (handoff.task_id !== taskId) {
    return bundle('INCOMPLETE', `handoff pertence a ${handoff.task_id}`);
  }
  if (handoff.accepted_commit !== accepted) {
    return bundle('INCOMPLETE', 'handoff e completion discordam do accepted_commit');
  }

  const manifest = await readCloseManifest(paths, taskId).catch(() => null);
  if (!manifest) return bundle('INCOMPLETE', 'manifesto de fechamento ausente ou inválido');
  if (manifest.task_id !== taskId || manifest.accepted_commit !== accepted) {
    return bundle('INCOMPLETE', 'manifesto não corresponde ao fechamento');
  }
  if (manifest.completion_sha256 !== canonicalSha256(completion)) {
    return bundle('INCOMPLETE', 'completion foi alterado depois do fechamento');
  }
  if (manifest.handoff_sha256 !== canonicalSha256(handoff)) {
    return bundle('INCOMPLETE', 'handoff foi alterado depois do fechamento');
  }

  if (!(await commitExists(paths.repoRoot, accepted))) {
    return bundle('INCOMPLETE', `accepted_commit não existe no repositório: ${accepted}`);
  }

  return {
    status: 'VALID',
    reason: 'fechamento completo e consistente',
    acceptedCommit: accepted,
    closedAt: completion.closed_at,
  };
}

async function reconcileTask(
  paths: HarnessPaths,
  before: TaskState,
): Promise<{ task: TaskState; reconciliation: Reconciliation | null }> {
  const bundle = await verifyCloseBundle(paths, before.id);

  // Fechamento já gravado mas perdido do state: o bundle COMPLETO manda.
  if (before.status !== 'PASS' && bundle.status === 'VALID') {
    return {
      task: {
        ...before,
        status: 'PASS',
        phase: null,
        accepted_commit: bundle.acceptedCommit,
        candidate_commit: bundle.acceptedCommit,
        diagnostics: null,
        finished_at: bundle.closedAt,
      },
      reconciliation: {
        task_id: before.id,
        from: before.status,
        to: 'PASS',
        reason: 'fechamento completo existia mas o state não refletia',
      },
    };
  }

  // Bundle pela metade nunca vira PASS: falta contexto selado para a próxima
  // sessão. Repetir o dev-close é o caminho, e ele é idempotente.
  if (before.status !== 'PASS' && bundle.status === 'INCOMPLETE') {
    const diagnostics = `fechamento incompleto (${bundle.reason}) — repita dev-close`;
    return {
      task: { ...before, diagnostics },
      reconciliation: {
        task_id: before.id,
        from: before.status,
        to: before.status,
        reason: diagnostics,
      },
    };
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
  //
  // Nota: o bundle não exige working tree limpa. Recovery roda em momento
  // arbitrário — exigir árvore limpa faria a reconciliação depender de
  // trabalho não relacionado feito depois do fechamento. O que prova o
  // fechamento é o conjunto de records mais a existência do commit aceito.
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
