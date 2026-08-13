import {
  InconsistentAttemptEvidenceError,
  retryFailedAttempt,
  type RetryFailedAttemptResult,
} from './retry-failed.js';
import type { HarnessPaths } from './paths.js';
import {
  readCompletion,
  readInfraFailedAttempt,
  readLaunchRecord,
  readValidationFailedAttempt,
} from './records.js';
import type { CompletionRecord, ValidationFailedAttemptRecord } from './schemas.js';
import { getTaskState, readState } from './state.js';

/**
 * Política de UM reparo automático bounded após a primeira falha capability-bearing
 * causada pela validation oficial.
 *
 * A autorização sai dos ValidationFailedAttemptRecords conectados. INFRA_ERROR é
 * capability-neutral: atravessa a cadeia, não cria nem consome autorização.
 * Número operacional do attempt, status isolado e texto de diagnostics NÃO
 * decidem. Evidência inconsistente, gap ou record inválido: fail closed.
 */

export const AUTOMATIC_REPAIR_REASON =
  'reparo automático bounded após a primeira falha da validation oficial';

export const AUTOMATIC_REPAIR_EXHAUSTED = 'AUTOMATIC_REPAIR_EXHAUSTED';

export type AutomaticRepairBlockCode =
  | 'INCONSISTENT_EVIDENCE'
  | 'HISTORICAL_GAP'
  | 'INVALID_EVIDENCE';

export type AutomaticRepairDecision =
  | { readonly action: 'NOT_APPLICABLE' }
  | {
      readonly action: 'REPAIR_ALLOWED';
      readonly source_attempt: number;
      readonly profile_id: string;
      readonly needs_archival: boolean;
    }
  | {
      readonly action: 'REPAIR_EXHAUSTED';
      readonly source_attempt: number;
      readonly validation_fail_count: number;
      readonly reason: string;
    }
  | {
      readonly action: 'BLOCKED';
      readonly code: AutomaticRepairBlockCode;
      readonly reason: string;
    };

type HistoryWalk =
  | { readonly status: 'ok'; readonly records: readonly ValidationFailedAttemptRecord[] }
  | { readonly status: 'inconsistent'; readonly attempt: number; readonly reason: string }
  | { readonly status: 'gap'; readonly attempt: number; readonly reason: string }
  | { readonly status: 'invalid'; readonly attempt: number; readonly reason: string };

function blocked(code: AutomaticRepairBlockCode, reason: string): AutomaticRepairDecision {
  return { action: 'BLOCKED', code, reason };
}

function exhausted(
  records: readonly ValidationFailedAttemptRecord[],
  failCount = records.length,
): AutomaticRepairDecision {
  const first = records[0];
  return {
    action: 'REPAIR_EXHAUSTED',
    source_attempt: first?.attempt ?? 1,
    validation_fail_count: failCount,
    reason:
      `${AUTOMATIC_REPAIR_EXHAUSTED}: ${failCount} falha(s) de validation oficial ` +
      'já registradas — o único reparo automático bounded foi consumido; intervenção humana é necessária',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Caminha de `fromAttempt` até 1. Cada attempt precisa de Validation OU Infra.
 * Os dois no mesmo attempt é inconsistência. Ausência é gap. A ordem dos
 * records devolvidos é cronológica (attempt crescente).
 */
async function walkValidationFails(
  paths: HarnessPaths,
  taskId: string,
  fromAttempt: number,
): Promise<HistoryWalk> {
  if (fromAttempt < 1) return { status: 'ok', records: [] };
  const found: ValidationFailedAttemptRecord[] = [];
  for (let current = fromAttempt; current >= 1; current -= 1) {
    let validation: ValidationFailedAttemptRecord | null;
    let infra;
    try {
      validation = await readValidationFailedAttempt(paths, taskId, current);
      infra = await readInfraFailedAttempt(paths, taskId, current);
    } catch (error) {
      return {
        status: 'invalid',
        attempt: current,
        reason: `attempt ${current} de ${taskId} tem record ilegível: ${errorMessage(error)}`,
      };
    }
    if (validation !== null && infra !== null) {
      return {
        status: 'inconsistent',
        attempt: current,
        reason: `attempt ${current} de ${taskId} tem ValidationFailedAttemptRecord e InfraFailedAttemptRecord simultâneos`,
      };
    }
    if (validation !== null) {
      found.push(validation);
      continue;
    }
    if (infra !== null) continue;
    return {
      status: 'gap',
      attempt: current,
      reason: `attempt ${current} de ${taskId} sem record de validation nem de infra`,
    };
  }
  return { status: 'ok', records: found.reverse() };
}

function fromWalk(walk: HistoryWalk): AutomaticRepairDecision | null {
  if (walk.status === 'ok') return null;
  if (walk.status === 'inconsistent') return blocked('INCONSISTENT_EVIDENCE', walk.reason);
  if (walk.status === 'gap') return blocked('HISTORICAL_GAP', walk.reason);
  return blocked('INVALID_EVIDENCE', walk.reason);
}

/**
 * FAIL oficial: o worker entregou SUCCESS e o gate oficial reprovou.
 * Worker FAILURE, FAIL sem validation malsucedida e FAIL com candidate
 * commit (worker-owned) ficam de fora desta automação.
 */
function isOfficialValidationFail(completion: CompletionRecord): boolean {
  if (completion.status !== 'FAIL') return false;
  if (completion.report?.self_reported_result !== 'SUCCESS') return false;
  if (completion.orchestrator_evidence.candidate_commit !== null) return false;
  if (completion.orchestrator_evidence.accepted_commit !== null) return false;
  return completion.orchestrator_evidence.revalidation.some(
    (result) => result.exit_code !== 0 || result.timed_out,
  );
}

async function readCurrentCompletion(
  paths: HarnessPaths,
  taskId: string,
): Promise<{ ok: true; completion: CompletionRecord | null } | { ok: false; reason: string }> {
  try {
    return { ok: true, completion: await readCompletion(paths, taskId) };
  } catch (error) {
    return {
      ok: false,
      reason: `CompletionRecord ilegível: ${errorMessage(error)}`,
    };
  }
}

function allowedFromRecords(
  records: readonly ValidationFailedAttemptRecord[],
  needsArchival: boolean,
): AutomaticRepairDecision {
  if (records.length >= 2) return exhausted(records);
  const source = records[0];
  if (!source) return { action: 'NOT_APPLICABLE' };
  return {
    action: 'REPAIR_ALLOWED',
    source_attempt: source.attempt,
    profile_id: source.profile_id,
    needs_archival: needsArchival,
  };
}

async function decideFromUnarchivedFail(
  paths: HarnessPaths,
  taskId: string,
  attempts: number,
): Promise<AutomaticRepairDecision> {
  const read = await readCurrentCompletion(paths, taskId);
  if (!read.ok) return blocked('INVALID_EVIDENCE', read.reason);
  if (read.completion === null || !isOfficialValidationFail(read.completion)) {
    return { action: 'NOT_APPLICABLE' };
  }

  const history = await walkValidationFails(paths, taskId, attempts - 1);
  if (history.status !== 'ok') {
    return fromWalk(history) ?? { action: 'NOT_APPLICABLE' };
  }

  let profileId: string;
  try {
    const record = await readLaunchRecord(paths, taskId);
    if (record === null) {
      return blocked(
        'INVALID_EVIDENCE',
        `LaunchRecord ausente para o FAIL oficial de ${taskId} attempt ${attempts}`,
      );
    }
    profileId = record.profile_id;
  } catch (error) {
    return blocked('INVALID_EVIDENCE', `LaunchRecord ilegível: ${errorMessage(error)}`);
  }

  // O FAIL corrente ainda não tem ValidationFailedAttemptRecord: soma 1 aos
  // records já arquivados. Não inventa um record paralelo.
  if (history.records.length >= 1) {
    return exhausted(history.records, history.records.length + 1);
  }
  return {
    action: 'REPAIR_ALLOWED',
    source_attempt: attempts,
    profile_id: profileId,
    needs_archival: true,
  };
}

/**
 * Deriva se o próximo capability-bearing attempt desta tarefa pode ser um
 * reparo automático no mesmo profile. Não lança provider e não arquiva.
 */
export async function decideAutomaticRepair(
  paths: HarnessPaths,
  taskId: string,
): Promise<AutomaticRepairDecision> {
  const task = getTaskState(await readState(paths), taskId);

  if (
    task.status === 'RUNNING' ||
    task.status === 'PASS' ||
    task.status === 'TIMED_OUT' ||
    task.status === 'MISSCOPED' ||
    task.status === 'INFRA_ERROR'
  ) {
    return { action: 'NOT_APPLICABLE' };
  }

  if (task.status === 'FAIL') {
    if (task.attempts < 1) return { action: 'NOT_APPLICABLE' };

    let currentValidation;
    let currentInfra;
    try {
      currentValidation = await readValidationFailedAttempt(paths, taskId, task.attempts);
      currentInfra = await readInfraFailedAttempt(paths, taskId, task.attempts);
    } catch (error) {
      return blocked(
        'INVALID_EVIDENCE',
        `attempt ${task.attempts} de ${taskId} tem record ilegível: ${errorMessage(error)}`,
      );
    }
    if (currentValidation !== null && currentInfra !== null) {
      return blocked(
        'INCONSISTENT_EVIDENCE',
        `attempt ${task.attempts} de ${taskId} tem ValidationFailedAttemptRecord e InfraFailedAttemptRecord simultâneos`,
      );
    }
    if (currentInfra !== null) return { action: 'NOT_APPLICABLE' };
    if (currentValidation !== null) {
      const history = await walkValidationFails(paths, taskId, task.attempts - 1);
      if (history.status !== 'ok') {
        return fromWalk(history) ?? { action: 'NOT_APPLICABLE' };
      }
      return allowedFromRecords([...history.records, currentValidation], true);
    }
    return decideFromUnarchivedFail(paths, taskId, task.attempts);
  }

  // READY: a cadeia 1..attempts tem que estar explicada por records.
  const history = await walkValidationFails(paths, taskId, task.attempts);
  if (history.status !== 'ok') {
    return fromWalk(history) ?? { action: 'NOT_APPLICABLE' };
  }
  return allowedFromRecords(history.records, false);
}

export function haltFromAutomaticRepair(
  decision: AutomaticRepairDecision,
): { readonly status: string; readonly reason: string } | null {
  if (decision.action === 'REPAIR_EXHAUSTED') {
    return { status: AUTOMATIC_REPAIR_EXHAUSTED, reason: decision.reason };
  }
  if (decision.action === 'BLOCKED') {
    return { status: decision.code, reason: decision.reason };
  }
  return null;
}

export interface AutomaticRepairReconciliation {
  readonly decision: AutomaticRepairDecision;
  readonly retry: RetryFailedAttemptResult | null;
}

/**
 * Se a política autorizar e a tarefa ainda estiver FAIL, arquiva via a
 * primitive existente. Não adquire lock — o chamador já o segura.
 */
export async function reconcileAutomaticRepair(input: {
  readonly paths: HarnessPaths;
  readonly taskId: string;
}): Promise<AutomaticRepairReconciliation> {
  const decision = await decideAutomaticRepair(input.paths, input.taskId);
  if (decision.action !== 'REPAIR_ALLOWED' || !decision.needs_archival) {
    return { decision, retry: null };
  }
  try {
    const retry = await retryFailedAttempt({
      paths: input.paths,
      taskId: input.taskId,
      reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
      reason: AUTOMATIC_REPAIR_REASON,
    });
    return { decision, retry };
  } catch (error) {
    if (error instanceof InconsistentAttemptEvidenceError) {
      return {
        decision: blocked('INCONSISTENT_EVIDENCE', error.message),
        retry: null,
      };
    }
    return {
      decision: blocked('INVALID_EVIDENCE', errorMessage(error)),
      retry: null,
    };
  }
}
