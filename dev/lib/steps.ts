import { AccessContractError } from './access-contract.js';
import type { ActivityObserverOptions } from './activity-observer.js';
import { checkProgressionBase } from './base-guard.js';
import { headSha } from './git.js';
import {
  BillingPreflightError,
  InboxProvenanceError,
  LaunchError,
  UsageMeasurementSafetyError,
  launchWorker,
  type LaunchOutcome,
} from './launch.js';
import { buildTaskPacket } from './packet.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import {
  createProductionPoolCapacityProbe,
  type PoolCapacityLaunchContext,
} from './pool-capacity-observer.js';
import { loadProfile } from './profile.js';
import {
  readHandoff,
  readInfraFailedAttempt,
  readPreservedBundleManifest,
  writePacket,
} from './records.js';
import { readRecoverableUnfinalizedPatch } from './infra-recover.js';
import { rehydratePreservedBundle } from './failed-attempt-bundle.js';
import { readPreviousAttemptDiagnostics } from './retry-failed.js';
import { selectNextTask, type Selection } from './select.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';
import type {
  DevelopmentState,
  LaunchContinuation,
  RecoveredWorkNotice,
  TaskPacket,
} from './schemas.js';

/**
 * Passos que orquestrador e CLIs individuais compartilham. Cada passo faz uma
 * coisa e devolve o suficiente para decidir o próximo — o encadeamento é do
 * dev-orchestrate, nunca do worker.
 */

export interface PrepareResult {
  readonly selection: Selection;
  readonly packet: TaskPacket | null;
  /** Motivo do bloqueio de base; `null` quando a progressão está liberada. */
  readonly baseViolation: string | null;
}

/** Seleciona a próxima tarefa e PERSISTE o packet (dev-next só imprime). */
export async function prepareNextTask(
  paths: HarnessPaths,
  loaded: LoadedPlan,
): Promise<PrepareResult> {
  const state = await readState(paths);
  const selection = selectNextTask(loaded, state);
  if (selection.status !== 'SELECTED' || !selection.task) {
    return { selection, packet: null, baseViolation: null };
  }

  // A base é conferida ANTES de gerar o packet: base_sha capturado de um HEAD
  // divergente contaminaria a evidência da tarefa inteira.
  const baseViolation = await checkProgressionBase(paths, state);
  if (baseViolation) return { selection, packet: null, baseViolation };

  const previousHandoff = selection.handoffSourceTaskId
    ? await readHandoff(paths, selection.handoffSourceTaskId)
    : null;
  // Diagnostics do repair: a primitive atravessa gaps de INFRA_ERROR
  // (capability-neutral) até o ValidationFailedAttemptRecord que alimenta o reparo.
  const previousAttemptDiagnostics = await readPreviousAttemptDiagnostics(
    paths,
    selection.task.id,
    getTaskState(state, selection.task.id).attempts,
  );
  const baseSha = await headSha(paths.repoRoot);
  // Trabalho que sobreviveu à morte do provider num attempt anterior. Só entra
  // quando ele foi tirado EXATAMENTE desta base: um bundle de outra base não
  // reaplica, e oferecer o que não se sabe aplicar seria promessa vazia.
  const recoveredWork = await resolveRecoveredWork(paths, selection.task.id, state, baseSha);
  const packet = buildTaskPacket({
    task: selection.task,
    baseSha,
    previousHandoff,
    previousAttemptDiagnostics,
    recoveredWork,
  });
  await writePacket(paths, packet);
  return { selection, packet, baseViolation: null };
}

/**
 * O aviso de continuação que vai no packet, derivado do
 * `InfraFailedAttemptRecord` e do manifesto — nunca de estado em memória.
 *
 * `null` quando não há patch recuperável, quando ele foi tirado de outra base,
 * ou quando o bundle sumiu. Nos três casos o attempt seguinte simplesmente
 * começa do base, como sempre começou: continuar é uma oportunidade provada,
 * não uma obrigação que possa travar a tarefa.
 */
export async function resolveRecoveredWork(
  paths: HarnessPaths,
  taskId: string,
  state: DevelopmentState,
  baseSha: string,
): Promise<RecoveredWorkNotice | null> {
  const recoverable = await readRecoverableUnfinalizedPatch(
    paths,
    taskId,
    getTaskState(state, taskId).attempts,
  );
  if (recoverable === null) return null;
  const manifest = await readPreservedBundleManifest(paths, taskId, recoverable.attempt);
  if (manifest === null || manifest.base_sha !== baseSha) return null;
  return {
    source_attempt: recoverable.attempt,
    changed_files: [...recoverable.changed_files],
    patch_path: recoverable.ref.patch_path,
    patch_sha256: recoverable.ref.patch_sha256,
  };
}

/**
 * Reaplica no alvo o trabalho que o packet declara, e devolve a proveniência
 * para o LaunchRecord.
 *
 * O packet é o canal de entrada, mas não é a autoridade sobre os bytes: o
 * `InfraFailedAttemptRecord` do attempt de origem é. Um packet persistido antes
 * e relançado depois não pode fazer o orquestrador aplicar um patch que a
 * evidência não confirma.
 */
async function rehydrateRecoveredWork(
  paths: HarnessPaths,
  packet: TaskPacket,
): Promise<LaunchContinuation | null> {
  const notice = packet.recovered_work;
  if (notice === undefined) return null;
  const archived = await readInfraFailedAttempt(paths, packet.task_id, notice.source_attempt);
  if (archived?.recoverable_patch == null) {
    throw new ContinuationRehydrationError(
      `packet de ${packet.task_id} declara trabalho recuperado do attempt ${notice.source_attempt}, ` +
        'mas não existe InfraFailedAttemptRecord com patch recuperável',
    );
  }
  if (archived.recoverable_patch.patch_sha256 !== notice.patch_sha256) {
    throw new ContinuationRehydrationError(
      `packet de ${packet.task_id} aponta para um patch que não é o do attempt ${notice.source_attempt}`,
    );
  }
  let rehydrated;
  try {
    rehydrated = await rehydratePreservedBundle({
      paths,
      taskId: packet.task_id,
      attempt: notice.source_attempt,
      baseSha: packet.base_sha,
    });
  } catch (error) {
    throw new ContinuationRehydrationError(
      `reidratação do attempt ${notice.source_attempt} de ${packet.task_id} falhou: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    source_attempt: notice.source_attempt,
    rehydrated_files: [...rehydrated.files],
    patch_path: rehydrated.ref.patch_path,
    patch_sha256: rehydrated.ref.patch_sha256,
    rehydrated_at: new Date().toISOString(),
  };
}

export interface LaunchStepResult {
  readonly classification: LaunchOutcome['classification'] | 'PREFLIGHT_BLOCKED';
  readonly reason: string;
  readonly outcome: LaunchOutcome | null;
}

/**
 * Recusa ANTES do spawn: nenhum provider nasceu, nenhum attempt foi consumido,
 * nenhum LaunchRecord existe. Não é INFRA_ERROR — a tarefa permanece READY.
 */
/**
 * A reidratação do trabalho recuperado falhou. Nenhum provider nasceu e nenhum
 * attempt foi consumido: é blocker operacional, não veredito de infraestrutura.
 * O alvo continua no base e o bundle preservado continua intacto.
 */
export class ContinuationRehydrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationRehydrationError';
  }
}

function isPreSpawnRefusal(error: unknown): boolean {
  return (
    error instanceof ContinuationRehydrationError ||
    error instanceof InboxProvenanceError ||
    error instanceof BillingPreflightError ||
    error instanceof UsageMeasurementSafetyError ||
    // Contrato de acesso não provado: incompatibilidade MECÂNICA entre o que o
    // worker precisa e o que o sandbox concede. Nenhum provider foi chamado, e
    // a tarefa não pode ir para FAIL nem para INFRA_ERROR por causa disto.
    error instanceof AccessContractError
  );
}

/**
 * Lança o worker e move o state conforme o término. Processo encerrado com
 * fechamento pendente (RUNNING/FINALIZING) é legítimo e repetível — só
 * timeout e falha de infraestrutura param o fluxo aqui.
 *
 * Recusa de proveniência/billing/usage ANTES do spawn NÃO muda o status da
 * tarefa: é blocker operacional pré-launch, não veredito de infraestrutura.
 */
export async function launchTask(
  paths: HarnessPaths,
  packet: TaskPacket,
  profileId: string,
  /**
   * Encolhe o TETO DE SEGURANÇA DE MÁQUINA — escape hatch de teste. Nunca é
   * deadline de task: nenhuma previsão de duração chega até aqui.
   */
  machineSafetyCeilingSecondsOverride?: number,
  /** Contexto do routing; ausente usa o observer de produção diretamente. */
  poolCapacity?: PoolCapacityLaunchContext,
  /**
   * Encolhe janelas OBSERVACIONAIS de atividade — escape hatch de teste.
   * Não concede autoridade de termination.
   */
  activityObserverOptions?: ActivityObserverOptions,
): Promise<LaunchStepResult> {
  const taskId = packet.task_id;
  const profile = await loadProfile(paths.repoRoot, profileId, {
    catalogRoot: paths.profileCatalogRoot,
  });
  const stateBefore = await readState(paths);
  const before = getTaskState(stateBefore, taskId);
  if (before.status !== 'READY') {
    throw new LaunchError(`tarefa ${taskId} está ${before.status}; só READY pode ser lançada`);
  }
  // Também aqui, e não só no prepare: o dev-launch aceita packet persistido
  // antes, e o repositório pode ter mudado nesse intervalo. Bloquear não muda
  // o status da tarefa — divergência de base não é falha do worker.
  const baseViolation = await checkProgressionBase(paths, stateBefore);
  if (baseViolation) throw new LaunchError(`base inválida para ${taskId}: ${baseViolation}`);
  if (packet.base_sha !== (await headSha(paths.repoRoot))) {
    throw new LaunchError(
      `packet de ${taskId} tem base_sha ${packet.base_sha}, diferente do HEAD atual — gere o packet de novo`,
    );
  }
  // REIDRATAÇÃO, depois das guardas de base e antes de qualquer efeito de
  // provider: a guarda exige árvore limpa no base, e é exatamente sobre essa
  // árvore que o patch do attempt anterior reaplica. Falhar aqui deixa a tarefa
  // READY, sem consumir attempt e sem tocar o bundle preservado.
  const continuation = await rehydrateRecoveredWork(paths, packet);

  const startedAt = new Date().toISOString();
  const capacity =
    poolCapacity ?? {
      before: undefined,
      probe: createProductionPoolCapacityProbe({ paths }),
    };

  let outcome: LaunchOutcome;
  try {
    outcome = await launchWorker({
      paths,
      profile,
      packet,
      attempt: before.attempts + 1,
      ...('before' in capacity && capacity.before !== undefined
        ? { poolCapacityBefore: capacity.before }
        : {}),
      poolCapacityProbe: capacity.probe,
      continuation,
      ...(machineSafetyCeilingSecondsOverride === undefined
        ? {}
        : { machineSafetyCeilingSecondsOverride }),
      ...(activityObserverOptions === undefined ? {} : { activityObserverOptions }),
      onStarted: async (identity) => {
        const state = await readState(paths);
        await writeState(
          paths,
          withTaskState(state, taskId, {
            status: 'RUNNING',
            phase: 'EXECUTING',
            process: identity,
            base_sha: packet.base_sha,
            attempts: before.attempts + 1,
            diagnostics: null,
            started_at: startedAt,
            finished_at: null,
          }),
        );
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isPreSpawnRefusal(error)) {
      return { classification: 'PREFLIGHT_BLOCKED', reason, outcome: null };
    }
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, taskId, { status: 'INFRA_ERROR', phase: null, diagnostics: reason }),
    );
    return { classification: 'INFRA_ERROR', reason, outcome: null };
  }

  const state = await readState(paths);
  if (outcome.classification === 'FINISHED') {
    await writeState(paths, withTaskState(state, taskId, { phase: 'FINALIZING', diagnostics: null }));
  } else {
    await writeState(
      paths,
      withTaskState(state, taskId, {
        status: outcome.classification === 'TIMED_OUT' ? 'TIMED_OUT' : 'INFRA_ERROR',
        phase: null,
        diagnostics: outcome.reason,
        finished_at: outcome.record.finished_at ?? new Date().toISOString(),
      }),
    );
  }
  return { classification: outcome.classification, reason: outcome.reason, outcome };
}
