import { canonicalSha256 } from './canonical.js';
import {
  sealOrchestratedFinalization,
  verifyOrchestratedFinalizationRecord,
} from './finalize-orchestrated.js';
import {
  sealRecoveredFinalization,
  verifyRecoveredFinalizationRecord,
} from './finalize-recovered.js';
import {
  sealOrchestratedRevalidation,
  verifyOrchestratedRevalidationRecord,
} from './revalidate.js';
import { commitExists, headSha } from './git.js';
import { reconcileMaintenanceRecords } from './maintenance.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { loadPlan } from './plan.js';
import { isSameProcessAlive } from './process-identity.js';
import {
  readCloseManifest,
  readCompletion,
  readHandoff,
  listOrchestratedRevalidations,
  readOrchestratedFinalization,
  readRecoveredFinalization,
  readOrchestratedRevalidation,
} from './records.js';
import {
  DevelopmentState,
  type TaskState,
} from './schemas.js';
import {
  buildInitialState,
  deriveAuthorizedHead,
  initialTaskState,
  readState,
} from './state.js';

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

export interface RecoveryOptions {
  /** `false` em dry-run: relata bundle recuperável sem escrever records. */
  readonly applyRecovered?: boolean;
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
  options: RecoveryOptions = {},
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
    const { task, reconciliation } = await reconcileTask(paths, loaded, before, options);
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
  const previousTaskBase = deriveAuthorizedHead(base.tasks, baselineSha);
  const reconciledTaskBase = deriveAuthorizedHead(tasks, baselineSha);
  let authorizedHead = base.authorized_head_sha ?? previousTaskBase;
  if (authorizedHead === previousTaskBase && reconciledTaskBase !== previousTaskBase) {
    authorizedHead = reconciledTaskBase;
  }
  authorizedHead = await reconcileMaintenanceRecords(paths, authorizedHead);
  const state = DevelopmentState.parse({
    ...base,
    plan_sha256: loaded.planSha256,
    baseline_sha: baselineSha,
    authorized_head_sha: authorizedHead,
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

  if (completion.finalization_mode === 'recovered') {
    if (
      completion.commit_origin !== 'orchestrator_recovery' ||
      completion.recovery_source_attempt === undefined ||
      completion.recovery_record_sha256 === undefined
    ) {
      return bundle('INCOMPLETE', 'completion recovered sem metadados de recovery');
    }
    const recovery = await readRecoveredFinalization(
      paths,
      taskId,
      completion.recovery_source_attempt,
    ).catch(() => null);
    if (!recovery) return bundle('INCOMPLETE', 'RecoveredFinalizationRecord ausente ou inválido');
    if (
      recovery.task_id !== taskId ||
      recovery.source_attempt !== completion.recovery_source_attempt
    ) {
      return bundle('INCOMPLETE', 'RecoveredFinalizationRecord pertence a outra origem');
    }
    if (completion.recovery_record_sha256 !== canonicalSha256(recovery)) {
      return bundle('INCOMPLETE', 'RecoveredFinalizationRecord foi alterado depois do fechamento');
    }
    try {
      await verifyRecoveredFinalizationRecord(paths, recovery);
    } catch (error) {
      return bundle(
        'INCOMPLETE',
        `RecoveredFinalizationRecord divergente: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (recovery.candidate_commit !== accepted) {
      return bundle('INCOMPLETE', 'recovery record discorda do accepted_commit');
    }
  }

  if (completion.revalidated_after_validation_failure === true) {
    if (
      completion.finalization_mode !== 'normal' ||
      completion.commit_origin !== 'orchestrator' ||
      completion.revalidation_attempt === undefined ||
      completion.revalidation_sequence === undefined ||
      completion.revalidation_record_sha256 === undefined
    ) {
      return bundle('INCOMPLETE', 'completion revalidado sem metadados de revalidation');
    }
    const revalidation = await readOrchestratedRevalidation(
      paths,
      taskId,
      completion.revalidation_attempt,
      completion.revalidation_sequence,
    ).catch(() => null);
    if (!revalidation) {
      return bundle('INCOMPLETE', 'OrchestratedRevalidationRecord ausente ou inválido');
    }
    if (
      revalidation.task_id !== taskId ||
      revalidation.attempt !== completion.revalidation_attempt ||
      revalidation.sequence !== completion.revalidation_sequence
    ) {
      return bundle('INCOMPLETE', 'OrchestratedRevalidationRecord pertence a outra origem');
    }
    if (completion.revalidation_record_sha256 !== canonicalSha256(revalidation)) {
      return bundle('INCOMPLETE', 'OrchestratedRevalidationRecord foi alterado depois do fechamento');
    }
    try {
      const loaded = await loadPlan(paths.planFile);
      await verifyOrchestratedRevalidationRecord(paths, loaded, revalidation);
    } catch (error) {
      return bundle(
        'INCOMPLETE',
        `OrchestratedRevalidationRecord divergente: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (revalidation.candidate_commit !== accepted) {
      return bundle('INCOMPLETE', 'revalidation record discorda do accepted_commit');
    }
  } else if (completion.commit_origin === 'orchestrator') {
    if (
      completion.finalization_mode !== 'normal' ||
      completion.orchestrated_finalization_attempt === undefined ||
      completion.orchestrated_finalization_record_sha256 === undefined
    ) {
      return bundle('INCOMPLETE', 'completion orchestrator sem metadados de finalization');
    }
    const finalization = await readOrchestratedFinalization(
      paths,
      taskId,
      completion.orchestrated_finalization_attempt,
    ).catch(() => null);
    if (!finalization) {
      return bundle('INCOMPLETE', 'OrchestratedFinalizationRecord ausente ou inválido');
    }
    if (completion.orchestrated_finalization_record_sha256 !== canonicalSha256(finalization)) {
      return bundle('INCOMPLETE', 'OrchestratedFinalizationRecord foi alterado depois do fechamento');
    }
    try {
      const loaded = await loadPlan(paths.planFile);
      await verifyOrchestratedFinalizationRecord(
        { paths, loaded, taskId },
        finalization,
      );
    } catch (error) {
      return bundle(
        'INCOMPLETE',
        `OrchestratedFinalizationRecord divergente: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (finalization.candidate_commit !== accepted) {
      return bundle('INCOMPLETE', 'finalization record discorda do accepted_commit');
    }
  }

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
  loaded: LoadedPlan,
  before: TaskState,
  options: RecoveryOptions,
): Promise<{ task: TaskState; reconciliation: Reconciliation | null }> {
  let closeBundle = await verifyCloseBundle(paths, before.id);

  // Fechamento já gravado mas perdido do state: o bundle COMPLETO manda.
  if (before.status !== 'PASS' && closeBundle.status === 'VALID') {
    return {
      task: {
        ...before,
        status: 'PASS',
        phase: null,
        accepted_commit: closeBundle.acceptedCommit,
        candidate_commit: closeBundle.acceptedCommit,
        diagnostics: null,
        finished_at: closeBundle.closedAt,
      },
      reconciliation: {
        task_id: before.id,
        from: before.status,
        to: 'PASS',
        reason: 'fechamento completo existia mas o state não refletia',
      },
    };
  }

  if (before.status !== 'PASS') {
    let revalidations = null;
    let revalidationReadError: unknown = null;
    try {
      revalidations = await listOrchestratedRevalidations(paths, before.id, before.attempts);
    } catch (error) {
      revalidationReadError = error;
    }
    if (revalidationReadError) {
      const diagnostics = `revalidation inválida: ${
        revalidationReadError instanceof Error
          ? revalidationReadError.message
          : String(revalidationReadError)
      }`;
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
    const revalidation = revalidations?.findLast((record) => record.outcome === 'PASS');
    if (revalidation) {
      try {
        await verifyOrchestratedRevalidationRecord(paths, loaded, revalidation);
        if (!options.applyRecovered) {
          const diagnostics = 'revalidation válida aguarda dev-recover sem --dry-run';
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
        await sealOrchestratedRevalidation(paths, loaded, revalidation);
        closeBundle = await verifyCloseBundle(paths, before.id);
        if (closeBundle.status !== 'VALID') throw new Error(closeBundle.reason);
        return {
          task: {
            ...before,
            status: 'PASS',
            phase: null,
            accepted_commit: closeBundle.acceptedCommit,
            candidate_commit: closeBundle.acceptedCommit,
            diagnostics: null,
            finished_at: closeBundle.closedAt,
          },
          reconciliation: {
            task_id: before.id,
            from: before.status,
            to: 'PASS',
            reason: 'revalidation reconciliada sem novo commit',
          },
        };
      } catch (error) {
        const diagnostics = `revalidation incompleta: ${
          error instanceof Error ? error.message : String(error)
        }`;
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
    }

    let orchestrated = null;
    let orchestratedReadError: unknown = null;
    try {
      orchestrated = await readOrchestratedFinalization(paths, before.id, before.attempts);
    } catch (error) {
      orchestratedReadError = error;
    }
    if (orchestratedReadError) {
      const diagnostics = `orchestrated finalization inválida: ${
        orchestratedReadError instanceof Error
          ? orchestratedReadError.message
          : String(orchestratedReadError)
      }`;
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
    if (orchestrated) {
      try {
        const finalizeInput = { paths, loaded, taskId: before.id };
        await verifyOrchestratedFinalizationRecord(finalizeInput, orchestrated);
        if (!options.applyRecovered) {
          const diagnostics = 'orchestrated finalization válida aguarda dev-recover sem --dry-run';
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
        await sealOrchestratedFinalization(finalizeInput, orchestrated);
        closeBundle = await verifyCloseBundle(paths, before.id);
        if (closeBundle.status !== 'VALID') throw new Error(closeBundle.reason);
        return {
          task: {
            ...before,
            status: 'PASS',
            phase: null,
            accepted_commit: closeBundle.acceptedCommit,
            candidate_commit: closeBundle.acceptedCommit,
            diagnostics: null,
            finished_at: closeBundle.closedAt,
          },
          reconciliation: {
            task_id: before.id,
            from: before.status,
            to: 'PASS',
            reason: 'orchestrated finalization reconciliada sem novo commit',
          },
        };
      } catch (error) {
        const diagnostics = `orchestrated finalization incompleta: ${
          error instanceof Error ? error.message : String(error)
        }`;
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
    }

    let recovered = null;
    let recoveryReadError: unknown = null;
    try {
      recovered = await readRecoveredFinalization(paths, before.id, before.attempts);
    } catch (error) {
      recoveryReadError = error;
    }

    if (recoveryReadError) {
      const diagnostics = `recovered finalization inválida: ${
        recoveryReadError instanceof Error ? recoveryReadError.message : String(recoveryReadError)
      }`;
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

    if (recovered) {
      try {
        await verifyRecoveredFinalizationRecord(paths, recovered);
        if (!options.applyRecovered) {
          const diagnostics = 'recovered finalization válida aguarda dev-recover sem --dry-run';
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
        await sealRecoveredFinalization(paths, recovered);
        closeBundle = await verifyCloseBundle(paths, before.id);
        if (closeBundle.status !== 'VALID') {
          throw new Error(closeBundle.reason);
        }
        return {
          task: {
            ...before,
            status: 'PASS',
            phase: null,
            accepted_commit: closeBundle.acceptedCommit,
            candidate_commit: closeBundle.acceptedCommit,
            diagnostics: null,
            finished_at: closeBundle.closedAt,
          },
          reconciliation: {
            task_id: before.id,
            from: before.status,
            to: 'PASS',
            reason: 'recovered finalization reconciliada sem novo commit',
          },
        };
      } catch (error) {
        const diagnostics = `recovered finalization incompleta: ${
          error instanceof Error ? error.message : String(error)
        }`;
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
    }
  }

  // Bundle pela metade nunca vira PASS: falta contexto selado para a próxima
  // sessão. Repetir o dev-close é o caminho, e ele é idempotente.
  if (before.status !== 'PASS' && closeBundle.status === 'INCOMPLETE') {
    const diagnostics = `fechamento incompleto (${closeBundle.reason}) — repita dev-close`;
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
