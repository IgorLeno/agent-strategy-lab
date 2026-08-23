/**
 * OPERATIONAL PLANE — observabilidade mínima de um attempt real.
 *
 * Existe para separar duas coisas que estavam fundidas no caminho operacional:
 *
 *   OPERATIONAL PROGRESS                 (a work unit do usuário avança)
 *   EXPERIMENTAL / CANONICAL BENCHMARK   (ExecutionEnvelope, ExecutionRecord,
 *                                         ComparableRunFacts, Evaluation,
 *                                         Score, Qualification, manifests,
 *                                         index, binding)
 *
 * Antes, materializar a segunda era pré-condição da primeira: uma work unit
 * JÁ validada e JÁ aceita perdia a run inteira se o scoring/indexing falhasse.
 * Este record é o que sobra quando essa dependência é cortada — apenas fatos
 * que o control plane já tem em mãos, nenhum deles pedido ao worker e nenhum
 * deles derivado de score.
 *
 * O Experimental Plane NÃO é substituído nem removido por isto. Ele continua
 * sendo o instrumento que produz evidência comparável; o que muda é que a
 * falha dele deixou de ser capaz de reverter trabalho válido.
 *
 * `UNKNOWN ≠ 0`: todo fato que não foi medido fica `null`, nunca zero.
 */
import path from 'node:path';

import { writeFileAtomic } from './atomic.js';
import type { HarnessPaths } from './paths.js';

export const OPERATIONAL_ATTEMPT_SCHEMA_VERSION = 1;

export interface OperationalAttemptRecord {
  readonly schema_version: typeof OPERATIONAL_ATTEMPT_SCHEMA_VERSION;
  readonly task_id: string;
  readonly attempt: number;
  readonly attempt_role: string;
  readonly profile_id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly duration_ms: number | null;
  readonly exit_code: number | null;
  readonly timed_out: boolean | null;
  /** Telemetria do provider quando disponível; `null` é UNKNOWN, não zero. */
  readonly usage_tokens: number | null;
  readonly candidate_commit: string | null;
  readonly changed_files: readonly string[] | null;
  readonly validation_outcome: string | null;
  readonly repair_source_attempt: number | null;
  readonly escalated_from_profile_id: string | null;
  readonly human_intervention: string | null;
  /**
   * `OK` quando a materialização canônica concluiu; `OBSERVABILITY_DEGRADED`
   * quando ela falhou e o progresso operacional seguiu mesmo assim.
   */
  readonly telemetry_status: 'OK' | 'OBSERVABILITY_DEGRADED';
  readonly telemetry_reason: string | null;
  readonly observed_at: string;
}

export function operationalAttemptDir(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.devDir, 'operational-attempts', taskId);
}

export function operationalAttemptPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(operationalAttemptDir(paths, taskId), `attempt-${attempt}.json`);
}

/**
 * Grava o record. Nunca lança: este é o plano de OBSERVABILIDADE, e ele não
 * pode ser a razão pela qual uma work unit válida deixa de avançar. Um erro
 * aqui é reportado pelo valor de retorno, não por exceção.
 */
export async function writeOperationalAttempt(
  paths: HarnessPaths,
  record: OperationalAttemptRecord,
): Promise<boolean> {
  try {
    await writeFileAtomic(
      operationalAttemptPath(paths, record.task_id, record.attempt),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}
