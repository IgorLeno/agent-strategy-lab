import {
  AUTOMATIC_REPAIR_EXHAUSTED,
  reconcileAutomaticRepair,
} from './automatic-repair.js';
import { inspectProgressionBase, type ProgressionBaseBlocker } from './base-guard.js';
import { gitOrThrow, headSha, isAncestor, isWorkingTreeClean } from './git.js';
import {
  MaintenanceError,
  adoptMaintenance,
  adoptMaintenanceRange,
  reconcileMaintenanceRecords,
  resolveAdoptionKind,
  type MaintenanceValidationRunner,
} from './maintenance.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { readMaintenanceRecord } from './records.js';
import { isRecoveryClean, recover, type Reconciliation } from './recover.js';
import { InconsistentAttemptEvidenceError, readPreviousAttemptDiagnostics } from './retry-failed.js';
import type { MaintenanceCommit, ValidationResult } from './schemas.js';
import { selectNextTask, type SelectionStatus } from './select.js';
import { getTaskState, readState } from './state.js';

/**
 * PRE-FLIGHT do `dev-orchestrate`: o ritual que era feito à mão antes de cada
 * implementação — maintenance, `dev-recover --dry-run`, `dev-next` — executado
 * pelo próprio orquestrador, com as MESMAS primitives, e fail-closed.
 *
 * Nada aqui reimplementa política: a adoção passa por `adoptMaintenance` /
 * `adoptMaintenanceRange` inteiros (allowlist, cadeia linear, árvore limpa,
 * nenhum RUNNING, gates oficiais, MaintenanceRecord), o recover é o `recover()`
 * em dry-run e a seleção é o `selectNextTask` + `inspectProgressionBase` que o
 * fluxo real usa. O preflight só decide SE o fluxo pode continuar.
 *
 * Situação inesperada não é consertada aqui: ela para o comando antes de
 * qualquer launch, para que um humano entre. Automatizar o conserto seria
 * transformar "algo está errado" em "algo foi silenciosamente alterado".
 */

/**
 * Faixa máxima adotada automaticamente. Conservador de propósito: mais que isto
 * já não é "manutenção pendente que ninguém adotou ainda", é histórico que
 * merece leitura humana antes de virar base autorizada.
 */
export const AUTO_MAINTENANCE_MAX_COMMITS = 3;

/** Reason estável e auditável — o MaintenanceRecord diz quem o gerou. */
export const AUTO_MAINTENANCE_REASON =
  'auto-preflight: adopt pending maintenance before orchestration';

export type MaintenanceStageStatus = 'NOOP' | 'ADOPTED' | 'ALREADY_ADOPTED' | 'BLOCKED';

export interface PreflightMaintenance {
  readonly status: MaintenanceStageStatus;
  readonly previous_authorized_head_sha: string | null;
  readonly authorized_head_sha: string | null;
  readonly commit_count: number;
  readonly adoption_kind: 'maintenance' | 'maintenance_range' | null;
  readonly commits: readonly MaintenanceCommit[];
  readonly validation_results: readonly ValidationResult[];
  readonly reason: string | null;
}

export interface PreflightRecover {
  readonly status: 'CLEAN' | 'ATTENTION';
  readonly reconciliation_count: number;
  readonly reconciliations: readonly Reconciliation[];
  readonly plan_changed: boolean;
  readonly state_was_missing: boolean;
  readonly head_matches_authorized: boolean;
  readonly authorized_head_sha: string | null;
  readonly reason: string | null;
}

export interface PreflightNext {
  readonly status: SelectionStatus;
  readonly reason: string;
  readonly task_id: string | null;
  readonly title: string | null;
  readonly attempt: number | null;
  readonly attempt_kind: 'FIRST_PASS' | 'REPAIR' | null;
  readonly base_sha: string | null;
  readonly authorized_head_sha: string | null;
  readonly ready_to_launch: boolean;
  readonly blocker: ProgressionBaseBlocker | null;
  readonly blocker_reason: string | null;
}

export type PreflightBlocker =
  | 'MAINTENANCE_BLOCKED'
  | 'RECOVERY_ATTENTION'
  | 'SELECTION_BLOCKED'
  | 'AUTOMATIC_REPAIR_EXHAUSTED'
  | 'INCONSISTENT_EVIDENCE'
  | 'HISTORICAL_GAP'
  | 'INVALID_EVIDENCE'
  | ProgressionBaseBlocker;

export type PreflightStatus = 'READY' | 'BLOCKED' | 'ALL_DONE';

export interface PreflightResult {
  readonly status: PreflightStatus;
  readonly maintenance: PreflightMaintenance;
  /** `null` quando a maintenance já bloqueou: o estágio nem chegou a rodar. */
  readonly recover: PreflightRecover | null;
  readonly next: PreflightNext | null;
  readonly blocker: PreflightBlocker | null;
  readonly reason: string | null;
}

export interface PreflightInput {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  /**
   * Injetável SÓ para teste. Em produção a adoção roda os gates oficiais —
   * relaxar isso aqui seria criar uma adoção de segunda classe.
   */
  readonly validationRunner?: MaintenanceValidationRunner;
  readonly maxMaintenanceCommits?: number;
  readonly now?: () => string;
}

function blockedMaintenance(
  previous: string | null,
  commitCount: number,
  reason: string,
): PreflightMaintenance {
  return {
    status: 'BLOCKED',
    previous_authorized_head_sha: previous,
    authorized_head_sha: previous,
    commit_count: commitCount,
    adoption_kind: null,
    commits: [],
    validation_results: [],
    reason,
  };
}

/**
 * Caso A (HEAD já autorizado) é NOOP: nenhum record novo, nenhuma validação,
 * nenhuma escrita. Caso B (um commit) e caso C (faixa pequena) delegam às
 * primitives oficiais. Qualquer outra coisa bloqueia.
 */
async function runMaintenanceStage(input: PreflightInput): Promise<PreflightMaintenance> {
  const { paths } = input;
  const maximum = input.maxMaintenanceCommits ?? AUTO_MAINTENANCE_MAX_COMMITS;

  let state;
  try {
    state = await readState(paths);
  } catch (error) {
    return blockedMaintenance(
      null,
      0,
      `state do harness ilegível: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const previous = state.authorized_head_sha;
  if (previous === null) {
    return blockedMaintenance(null, 0, 'authorized_head_sha ausente; adoção automática recusada');
  }

  const head = await headSha(paths.repoRoot);
  if (head === previous) {
    return {
      status: 'NOOP',
      previous_authorized_head_sha: previous,
      authorized_head_sha: previous,
      commit_count: 0,
      adoption_kind: null,
      commits: [],
      validation_results: [],
      reason: null,
    };
  }

  // As primitives repetem estas checagens; antecipá-las é o que permite dizer
  // POR QUE o preflight parou em vez de devolver uma exceção genérica.
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    return blockedMaintenance(previous, 0, 'working tree suja; adoção automática recusada');
  }
  const running = state.tasks.find((task) => task.status === 'RUNNING');
  if (running) {
    return blockedMaintenance(previous, 0, `tarefa RUNNING: ${running.id}`);
  }
  if (!(await isAncestor(paths.repoRoot, previous, head))) {
    return blockedMaintenance(
      previous,
      0,
      `HEAD (${head}) não descende do authorized_head_sha (${previous})`,
    );
  }

  const pending = Number(
    (await gitOrThrow(paths.repoRoot, ['rev-list', '--count', `${previous}..${head}`])).trim(),
  );
  if (!Number.isInteger(pending) || pending < 1) {
    return blockedMaintenance(previous, 0, `faixa pendente inesperada entre base e HEAD: ${pending}`);
  }
  if (pending > maximum) {
    return blockedMaintenance(
      previous,
      pending,
      `${pending} commits pendentes excedem o limite automático de ${maximum}`,
    );
  }

  // Extensão de plano tem record próprio e adoção própria: mesmo já gravado, o
  // preflight nunca o consome. Sem esta recusa, um record de plan_extension no
  // HEAD faria `adoptMaintenance` concluir a adoção pendente automaticamente.
  const existing = await readMaintenanceRecord(paths, head).catch(() => null);
  if (existing && resolveAdoptionKind(existing) === 'plan_extension') {
    return blockedMaintenance(previous, pending, 'adoção de plan_extension nunca é automática');
  }

  // Crash entre gravar o record e avançar o state deixa uma cadeia JÁ publicada
  // partindo da base atual. Adotar por cima dela criaria uma SEGUNDA saída a
  // partir da mesma base — exatamente as candidates ambíguas que
  // `reconcileMaintenanceRecords`/`maintenanceChainBetween` recusam depois.
  // Concluir a adoção pendente só é seguro quando o record que já existe é o
  // mesmo que o preflight fecharia: começa na base e termina no HEAD. Qualquer
  // outra forma é recuperação humana, não automação — fail-closed.
  let reconciled: string | null;
  try {
    reconciled = await reconcileMaintenanceRecords(paths, previous);
  } catch (error) {
    if (error instanceof MaintenanceError) {
      return blockedMaintenance(previous, pending, error.message);
    }
    throw error;
  }
  if (reconciled !== previous) {
    const resumable = reconciled === head && existing?.previous_authorized_head_sha === previous;
    if (!resumable) {
      return blockedMaintenance(
        previous,
        pending,
        `MaintenanceRecord pendente já adota até ${reconciled} sem estar refletido no state; ` +
          'recuperação manual é necessária antes de qualquer adoção automática',
      );
    }
  }

  try {
    const result =
      pending === 1
        ? await adoptMaintenance({
            paths,
            reason: AUTO_MAINTENANCE_REASON,
            ...(input.validationRunner ? { validationRunner: input.validationRunner } : {}),
            ...(input.now ? { now: input.now } : {}),
          })
        : await adoptMaintenanceRange({
            paths,
            target: head,
            maxCommits: maximum,
            reason: AUTO_MAINTENANCE_REASON,
            ...(input.validationRunner ? { validationRunner: input.validationRunner } : {}),
            ...(input.now ? { now: input.now } : {}),
          });
    const kind = resolveAdoptionKind(result.record);
    if (kind === 'plan_extension') {
      return blockedMaintenance(previous, pending, 'adoção de plan_extension nunca é automática');
    }
    return {
      status: result.alreadyAdopted ? 'ALREADY_ADOPTED' : 'ADOPTED',
      previous_authorized_head_sha: result.record.previous_authorized_head_sha,
      authorized_head_sha: result.record.adopted_head_sha,
      commit_count: result.record.commits.length,
      adoption_kind: kind,
      commits: result.record.commits,
      validation_results: result.record.validation_results,
      reason: null,
    };
  } catch (error) {
    if (error instanceof MaintenanceError) {
      return blockedMaintenance(previous, pending, error.message);
    }
    throw error;
  }
}

/**
 * Mesma visão do `dev-recover --dry-run` compacto — e em dry-run de verdade:
 * o preflight não escreve state para "consertar" nada.
 */
async function runRecoverStage(input: PreflightInput): Promise<PreflightRecover> {
  const { paths, loaded } = input;
  const result = await recover(paths, loaded, { applyRecovered: false });
  const head = await headSha(paths.repoRoot);
  const headMatchesAuthorized = head === result.state.authorized_head_sha;
  const clean = isRecoveryClean(result, head);

  const reasons: string[] = [];
  if (result.stateWasMissing) reasons.push('state do harness ausente');
  if (result.planChanged) reasons.push('dev/plan.yaml mudou desde o dev-init');
  if (result.reconciliations.length > 0) {
    reasons.push(`${result.reconciliations.length} reconciliação(ões) pendente(s)`);
  }
  if (!headMatchesAuthorized) {
    reasons.push(`HEAD (${head}) não é o authorized_head_sha (${result.state.authorized_head_sha})`);
  }

  return {
    status: clean ? 'CLEAN' : 'ATTENTION',
    reconciliation_count: result.reconciliations.length,
    reconciliations: result.reconciliations,
    plan_changed: result.planChanged,
    state_was_missing: result.stateWasMissing,
    head_matches_authorized: headMatchesAuthorized,
    authorized_head_sha: result.state.authorized_head_sha,
    reason: clean ? null : reasons.join('; '),
  };
}

/**
 * SOMENTE LEITURA. A seleção autoritativa que persiste packet continua sendo a
 * do loop (`prepareNextTask`); duplicar a persistência aqui geraria dois
 * packets para o mesmo attempt, e só o segundo valeria.
 */
async function runNextStage(input: PreflightInput): Promise<PreflightNext> {
  const { paths, loaded } = input;
  const state = await readState(paths);
  const selection = selectNextTask(loaded, state);
  if (selection.status !== 'SELECTED' || !selection.task) {
    return {
      status: selection.status,
      reason: selection.reason,
      task_id: null,
      title: null,
      attempt: null,
      attempt_kind: null,
      base_sha: null,
      authorized_head_sha: state.authorized_head_sha,
      ready_to_launch: false,
      blocker: null,
      blocker_reason: null,
    };
  }

  const task = getTaskState(state, selection.task.id);
  let previousAttemptDiagnostics;
  try {
    previousAttemptDiagnostics = await readPreviousAttemptDiagnostics(
      paths,
      selection.task.id,
      task.attempts,
    );
  } catch (error) {
    if (error instanceof InconsistentAttemptEvidenceError) {
      return {
        status: selection.status,
        reason: error.message,
        task_id: selection.task.id,
        title: selection.task.title,
        attempt: task.attempts + 1,
        attempt_kind: null,
        base_sha: await headSha(paths.repoRoot),
        authorized_head_sha: state.authorized_head_sha,
        ready_to_launch: false,
        blocker: null,
        blocker_reason: error.message,
      };
    }
    throw error;
  }
  const progression = await inspectProgressionBase(paths, state);

  return {
    status: selection.status,
    reason: selection.reason,
    task_id: selection.task.id,
    title: selection.task.title,
    attempt: task.attempts + 1,
    attempt_kind: previousAttemptDiagnostics === null ? 'FIRST_PASS' : 'REPAIR',
    base_sha: await headSha(paths.repoRoot),
    authorized_head_sha: state.authorized_head_sha,
    ready_to_launch: progression.blocker === null,
    blocker: progression.blocker,
    blocker_reason: progression.reason,
  };
}

function haltFromRepairDecision(
  decision: Awaited<ReturnType<typeof reconcileAutomaticRepair>>['decision'],
): { blocker: PreflightBlocker; reason: string } | null {
  if (decision.action === 'REPAIR_EXHAUSTED') {
    return { blocker: AUTOMATIC_REPAIR_EXHAUSTED, reason: decision.reason };
  }
  if (decision.action === 'BLOCKED') {
    return { blocker: decision.code, reason: decision.reason };
  }
  return null;
}

/**
 * Conclui o archival/reopen do PRIMEIRO FAIL oficial quando a política autoriza,
 * e recusa o terceiro capability-bearing attempt automático. Usa a mesma
 * primitive que o loop do orquestrador.
 */
async function runAutomaticRepairStage(
  input: PreflightInput,
): Promise<{ blocker: PreflightBlocker; reason: string } | null> {
  const state = await readState(input.paths);
  const halted = state.tasks.find((task) => task.status === 'FAIL');
  const selected = halted ? null : selectNextTask(input.loaded, state);
  const taskId = halted?.id ?? selected?.task?.id ?? null;
  if (taskId === null) return null;

  const { decision } = await reconcileAutomaticRepair({ paths: input.paths, taskId });
  return haltFromRepairDecision(decision);
}

/**
 * Executa os três estágios em ordem e para no primeiro que não estiver verde.
 * O chamador precisa segurar o MESMO lock que vai cobrir a orquestração: entre
 * verificar e lançar não pode existir janela em que HEAD ou state mudem.
 */
export async function runOrchestrationPreflight(
  input: PreflightInput,
): Promise<PreflightResult> {
  const maintenance = await runMaintenanceStage(input);
  if (maintenance.status === 'BLOCKED') {
    return {
      status: 'BLOCKED',
      maintenance,
      recover: null,
      next: null,
      blocker: 'MAINTENANCE_BLOCKED',
      reason: maintenance.reason,
    };
  }

  const recovery = await runRecoverStage(input);
  if (recovery.status !== 'CLEAN') {
    return {
      status: 'BLOCKED',
      maintenance,
      recover: recovery,
      next: null,
      blocker: 'RECOVERY_ATTENTION',
      reason: recovery.reason,
    };
  }

  const repairHalt = await runAutomaticRepairStage(input);
  if (repairHalt) {
    const next = await runNextStage(input);
    return {
      status: 'BLOCKED',
      maintenance,
      recover: recovery,
      next,
      blocker: repairHalt.blocker,
      reason: repairHalt.reason,
    };
  }

  const next = await runNextStage(input);
  if (next.status === 'ALL_DONE') {
    return { status: 'ALL_DONE', maintenance, recover: recovery, next, blocker: null, reason: next.reason };
  }
  if (next.status !== 'SELECTED') {
    return {
      status: 'BLOCKED',
      maintenance,
      recover: recovery,
      next,
      blocker: 'SELECTION_BLOCKED',
      reason: next.reason,
    };
  }
  if (!next.ready_to_launch) {
    return {
      status: 'BLOCKED',
      maintenance,
      recover: recovery,
      next,
      // O código do bloqueio de base é o mesmo que o `dev-next` mostra:
      // BASE_DIVERGED continua sendo BASE_DIVERGED.
      blocker: next.blocker ?? 'SELECTION_BLOCKED',
      reason: next.blocker_reason ?? next.reason,
    };
  }

  return { status: 'READY', maintenance, recover: recovery, next, blocker: null, reason: null };
}
