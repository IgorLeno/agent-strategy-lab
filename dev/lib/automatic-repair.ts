import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalSha256 } from './canonical.js';
import type { HarnessPaths } from './paths.js';
import {
  additionalRepairTaskDir,
  listAdditionalRepairAuthorizationFiles,
  readAttemptAbandonment,
  readCompletion,
  readInfraFailedAttempt,
  readLaunchRecord,
  readProtocolInvalidAttempt,
  readReviewRejectedAttempt,
  readValidationFailedAttempt,
  writeAdditionalRepairAuthorizationConsumption,
  writeAdditionalRepairAuthorizationGrant,
} from './records.js';
import {
  AdditionalRepairAuthorizationConsumptionRecord,
  AdditionalRepairAuthorizationRecord,
  type CompletionRecord,
  type ReviewRejectedAttemptRecord,
  type ValidationFailedAttemptRecord,
} from './schemas.js';
import {
  InconsistentAttemptEvidenceError,
  retryFailedAttempt,
  type RetryFailedAttemptResult,
} from './retry-failed.js';
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
export const AUTOMATIC_REPAIR_PROFILE_MISMATCH = 'AUTOMATIC_REPAIR_PROFILE_MISMATCH';

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
      readonly additional_authorization_sha256?: string;
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

type CapabilityFailureRecord = ValidationFailedAttemptRecord | ReviewRejectedAttemptRecord;

type HistoryWalk =
  | { readonly status: 'ok'; readonly records: readonly CapabilityFailureRecord[] }
  | { readonly status: 'inconsistent'; readonly attempt: number; readonly reason: string }
  | { readonly status: 'gap'; readonly attempt: number; readonly reason: string }
  | { readonly status: 'invalid'; readonly attempt: number; readonly reason: string };

function blocked(code: AutomaticRepairBlockCode, reason: string): AutomaticRepairDecision {
  return { action: 'BLOCKED', code, reason };
}

function exhausted(
  records: readonly CapabilityFailureRecord[],
  failCount = records.length,
): AutomaticRepairDecision {
  const first = records[0];
  return {
    action: 'REPAIR_EXHAUSTED',
    source_attempt: first?.attempt ?? 1,
    validation_fail_count: failCount,
    reason:
      `${AUTOMATIC_REPAIR_EXHAUSTED}: ${failCount} rejeição(ões) capability-bearing ` +
      'já registradas — o único reparo automático bounded foi consumido; intervenção humana é necessária',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AdditionalRepairAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdditionalRepairAuthorizationError';
  }
}

const GRANT_FILE = /^grant-([0-9a-f]{64})\.json$/;
const CONSUMPTION_FILE = /^consumed-([0-9a-f]{64})-attempt-(\d+)\.json$/;

type UnusedGrantLookup =
  | { readonly status: 'none' }
  | { readonly status: 'unused'; readonly sha256: string }
  | { readonly status: 'invalid'; readonly reason: string };

async function readJsonFile(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown;
}

async function readUnusedAdditionalRepairGrant(
  paths: HarnessPaths,
  taskId: string,
): Promise<UnusedGrantLookup> {
  let names: readonly string[];
  try {
    names = await listAdditionalRepairAuthorizationFiles(paths, taskId);
  } catch (error) {
    return {
      status: 'invalid',
      reason: `autorização adicional ilegível para ${taskId}: ${errorMessage(error)}`,
    };
  }
  const unused: string[] = [];
  const consumed = new Set<string>();
  for (const name of names) {
    const consumption = CONSUMPTION_FILE.exec(name);
    if (consumption) {
      const grantSha = consumption[1];
      const attempt = Number(consumption[2]);
      const file = path.join(additionalRepairTaskDir(paths, taskId), name);
      try {
        const parsed = AdditionalRepairAuthorizationConsumptionRecord.parse(
          await readJsonFile(file),
        );
        if (parsed.task_id !== taskId || parsed.grant_sha256 !== grantSha) {
          return {
            status: 'invalid',
            reason: `recibo de autorização adicional diverge do nome: ${name}`,
          };
        }
        if (parsed.consumed_by_attempt !== attempt) {
          return {
            status: 'invalid',
            reason: `recibo de autorização adicional diverge do attempt: ${name}`,
          };
        }
      } catch (error) {
        return {
          status: 'invalid',
          reason: `recibo de autorização adicional ilegível (${name}): ${errorMessage(error)}`,
        };
      }
      consumed.add(grantSha);
      continue;
    }
    const grant = GRANT_FILE.exec(name);
    if (!grant) {
      return {
        status: 'invalid',
        reason: `arquivo inesperado em autorização adicional de ${taskId}: ${name}`,
      };
    }
    const grantSha = grant[1];
    const file = path.join(additionalRepairTaskDir(paths, taskId), name);
    try {
      const parsed = AdditionalRepairAuthorizationRecord.parse(await readJsonFile(file));
      if (parsed.task_id !== taskId || parsed.additional_attempts !== 1) {
        return {
          status: 'invalid',
          reason: `concessão adicional diverge do contrato one-shot: ${name}`,
        };
      }
      if (canonicalSha256(parsed) !== grantSha) {
        return {
          status: 'invalid',
          reason: `hash da concessão adicional diverge do nome: ${name}`,
        };
      }
    } catch (error) {
      return {
        status: 'invalid',
        reason: `concessão adicional ilegível (${name}): ${errorMessage(error)}`,
      };
    }
    unused.push(grantSha);
  }
  const remaining = unused.filter((sha) => !consumed.has(sha));
  if (remaining.length === 0) return { status: 'none' };
  if (remaining.length > 1) {
    return {
      status: 'invalid',
      reason: `${taskId} tem mais de uma autorização adicional não consumida`,
    };
  }
  return { status: 'unused', sha256: remaining[0] as string };
}

async function applyUnusedAdditionalRepairGrant(
  paths: HarnessPaths,
  taskId: string,
  decision: AutomaticRepairDecision,
): Promise<AutomaticRepairDecision> {
  if (decision.action !== 'REPAIR_EXHAUSTED') return decision;
  const lookup = await readUnusedAdditionalRepairGrant(paths, taskId);
  if (lookup.status === 'invalid') return blocked('INVALID_EVIDENCE', lookup.reason);
  if (lookup.status === 'none') return decision;
  const task = getTaskState(await readState(paths), taskId);
  const history = await walkValidationFails(paths, taskId, task.attempts);
  if (history.status !== 'ok') {
    return fromWalk(history) ?? blocked('INVALID_EVIDENCE', 'histórico ilegível na autorização adicional');
  }
  const source = history.records.at(-1);
  if (source === undefined) return decision;
  return {
    action: 'REPAIR_ALLOWED',
    source_attempt: source.attempt,
    profile_id: source.profile_id,
    needs_archival: task.status === 'FAIL',
    additional_authorization_sha256: lookup.sha256,
  };
}

export async function grantAdditionalRepairAuthorization(input: {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reason: string;
  readonly now?: () => string;
}): Promise<{
  readonly record: AdditionalRepairAuthorizationRecord;
  readonly path: string;
  readonly sha256: string;
}> {
  if (input.reason.trim() === '') {
    throw new AdditionalRepairAuthorizationError('reason é obrigatório');
  }
  const decision = await decideAutomaticRepair(input.paths, input.taskId);
  if (decision.action === 'BLOCKED') {
    throw new AdditionalRepairAuthorizationError(decision.reason);
  }
  if (decision.action === 'REPAIR_ALLOWED' && decision.additional_authorization_sha256) {
    throw new AdditionalRepairAuthorizationError(
      `já existe autorização one-shot não consumida para ${input.taskId}`,
    );
  }
  if (decision.action !== 'REPAIR_EXHAUSTED') {
    throw new AdditionalRepairAuthorizationError(
      `autorização adicional exige AUTOMATIC_REPAIR_EXHAUSTED; encontrado ${decision.action}`,
    );
  }
  const record = AdditionalRepairAuthorizationRecord.parse({
    schema_version: 1,
    kind: 'ADDITIONAL_REPAIR_AUTHORIZATION',
    task_id: input.taskId,
    additional_attempts: 1,
    reason: input.reason.trim(),
    granted_at: (input.now ?? (() => new Date().toISOString()))(),
    provenance: 'human_explicit',
    blocker: 'AUTOMATIC_REPAIR_EXHAUSTED',
  });
  const sha256 = canonicalSha256(record);
  const file = await writeAdditionalRepairAuthorizationGrant(input.paths, record, sha256);
  return { record, path: file, sha256 };
}

export async function consumeAdditionalRepairAuthorization(input: {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly grantSha256: string;
  readonly attempt: number;
  readonly now?: () => string;
}): Promise<string> {
  const lookup = await readUnusedAdditionalRepairGrant(input.paths, input.taskId);
  if (lookup.status === 'invalid') {
    throw new AdditionalRepairAuthorizationError(lookup.reason);
  }
  if (lookup.status === 'none' || lookup.sha256 !== input.grantSha256) {
    throw new AdditionalRepairAuthorizationError(
      `concessão ${input.grantSha256} não está disponível para consumo em ${input.taskId}`,
    );
  }
  const record = AdditionalRepairAuthorizationConsumptionRecord.parse({
    schema_version: 1,
    kind: 'ADDITIONAL_REPAIR_AUTHORIZATION_CONSUMPTION',
    task_id: input.taskId,
    grant_sha256: input.grantSha256,
    consumed_by_attempt: input.attempt,
    consumed_at: (input.now ?? (() => new Date().toISOString()))(),
  });
  return writeAdditionalRepairAuthorizationConsumption(input.paths, record);
}

/**
 * Caminha de `fromAttempt` até 1. Cada attempt precisa de exatamente um record
 * conhecido. Validation conta capability; Infra é neutro; Abandonment encerra
 * a travessia sem apagar os records já encontrados no segmento posterior à
 * boundary. Mais de um record no mesmo attempt é inconsistência; ausência é gap.
 */
async function walkValidationFails(
  paths: HarnessPaths,
  taskId: string,
  fromAttempt: number,
): Promise<HistoryWalk> {
  if (fromAttempt < 1) return { status: 'ok', records: [] };
  const found: CapabilityFailureRecord[] = [];
  for (let current = fromAttempt; current >= 1; current -= 1) {
    let validation: ValidationFailedAttemptRecord | null;
    let infra;
    let abandonment;
    let protocolInvalid;
    let reviewRejected: ReviewRejectedAttemptRecord | null;
    try {
      validation = await readValidationFailedAttempt(paths, taskId, current);
      infra = await readInfraFailedAttempt(paths, taskId, current);
      abandonment = await readAttemptAbandonment(paths, taskId, current);
      protocolInvalid = await readProtocolInvalidAttempt(paths, taskId, current);
      reviewRejected = await readReviewRejectedAttempt(paths, taskId, current);
    } catch (error) {
      return {
        status: 'invalid',
        attempt: current,
        reason: `attempt ${current} de ${taskId} tem record ilegível: ${errorMessage(error)}`,
      };
    }
    const recordCount = [validation, reviewRejected, infra, abandonment, protocolInvalid].filter(
      (record) => record !== null,
    ).length;
    if (recordCount > 1) {
      return {
        status: 'inconsistent',
        attempt: current,
        reason: `attempt ${current} de ${taskId} tem lifecycle records incompatíveis simultâneos`,
      };
    }
    if (abandonment !== null) return { status: 'ok', records: found.reverse() };
    if (validation !== null) {
      found.push(validation);
      continue;
    }
    if (reviewRejected !== null) {
      found.push(reviewRejected);
      continue;
    }
    if (infra !== null || protocolInvalid !== null) continue;
    return {
      status: 'gap',
      attempt: current,
      reason: `attempt ${current} de ${taskId} sem lifecycle record conhecido`,
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
  records: readonly CapabilityFailureRecord[],
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
async function decideAutomaticRepairCore(
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
    let currentAbandonment;
    let currentProtocolInvalid;
    try {
      currentValidation = await readValidationFailedAttempt(paths, taskId, task.attempts);
      currentInfra = await readInfraFailedAttempt(paths, taskId, task.attempts);
      currentAbandonment = await readAttemptAbandonment(paths, taskId, task.attempts);
      currentProtocolInvalid = await readProtocolInvalidAttempt(paths, taskId, task.attempts);
    } catch (error) {
      return blocked(
        'INVALID_EVIDENCE',
        `attempt ${task.attempts} de ${taskId} tem record ilegível: ${errorMessage(error)}`,
      );
    }
    const currentRecordCount = [
      currentValidation,
      currentInfra,
      currentAbandonment,
      currentProtocolInvalid,
    ].filter((record) => record !== null).length;
    if (currentRecordCount > 1) {
      return blocked(
        'INCONSISTENT_EVIDENCE',
        `attempt ${task.attempts} de ${taskId} tem lifecycle records incompatíveis simultâneos`,
      );
    }
    if (currentAbandonment !== null) return { action: 'NOT_APPLICABLE' };
    if (currentInfra !== null) return { action: 'NOT_APPLICABLE' };
    if (currentProtocolInvalid !== null) return { action: 'NOT_APPLICABLE' };
    if (currentValidation !== null) {
      const history = await walkValidationFails(paths, taskId, task.attempts - 1);
      if (history.status !== 'ok') {
        return fromWalk(history) ?? { action: 'NOT_APPLICABLE' };
      }
      return allowedFromRecords([...history.records, currentValidation], true);
    }
    return decideFromUnarchivedFail(paths, taskId, task.attempts);
  }

  // READY com dois FAILs oficiais só existe após `dev-retry-failed`: essa
  // reabertura explícita é o gate humano para uma tentativa/escalada normal.
  const history = await walkValidationFails(paths, taskId, task.attempts);
  if (history.status !== 'ok') {
    return fromWalk(history) ?? { action: 'NOT_APPLICABLE' };
  }
  if (
    history.records.length >= 2 &&
    history.records.some((record) => 'rejection_disposition' in record)
  ) {
    return exhausted(history.records);
  }
  if (history.records.length >= 2) return { action: 'NOT_APPLICABLE' };
  return allowedFromRecords(history.records, false);
}

/**
 * Deriva se o próximo capability-bearing attempt desta tarefa pode ser um
 * reparo automático no mesmo profile. Não lança provider e não arquiva.
 */
export async function decideAutomaticRepair(
  paths: HarnessPaths,
  taskId: string,
): Promise<AutomaticRepairDecision> {
  const decision = await decideAutomaticRepairCore(paths, taskId);
  return applyUnusedAdditionalRepairGrant(paths, taskId, decision);
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

export function haltFromAutomaticRepairProfile(
  decision: AutomaticRepairDecision,
  taskId: string,
  requestedProfileId: string,
): { readonly status: typeof AUTOMATIC_REPAIR_PROFILE_MISMATCH; readonly reason: string } | null {
  if (decision.action !== 'REPAIR_ALLOWED' || decision.profile_id === requestedProfileId) {
    return null;
  }
  return {
    status: AUTOMATIC_REPAIR_PROFILE_MISMATCH,
    reason:
      `automatic repair de ${taskId} exige profile ${decision.profile_id}; ` +
      `rerode com --profile ${decision.profile_id}`,
  };
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
  if (decision.action === 'REPAIR_ALLOWED' && decision.additional_authorization_sha256) {
    const task = getTaskState(await readState(input.paths), input.taskId);
    await consumeAdditionalRepairAuthorization({
      paths: input.paths,
      taskId: input.taskId,
      grantSha256: decision.additional_authorization_sha256,
      attempt: task.attempts + 1,
    });
  }
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
