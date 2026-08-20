/**
 * Fronteira entre CANDIDATE VALIDADO e PASS ACEITO.
 *
 * A finalização orchestrator-owned sempre teve duas metades no mesmo passo:
 * PREPARAR o candidate (validação oficial, commit,
 * `OrchestratedFinalizationRecord`) e ACEITÁ-LO (CompletionRecord PASS,
 * HandoffRecord, `state.status = PASS`, `accepted_commit`,
 * `authorized_head_sha`). Enquanto nenhuma review independente existia, colapsar
 * as duas era inofensivo. Deixou de ser: um reviewer que REPROVA depois da
 * aceitação não reprova nada — a mudança já é autoritativa.
 *
 * Este módulo define a fronteira e NADA mais. Ele não lança reviewer, não sabe
 * o que é um profile e não decide policy de review: recebe a decisão de quem
 * tem autoridade para tomá-la e responde uma única pergunta objetiva — este
 * candidate pode ser promovido a PASS?
 *
 * A regra é conjuntiva e não tem exceção:
 *
 *     validation PASS  +  review ACCEPT  =  accepted PASS
 *
 * Nenhuma outra combinação promove. Review pendente, review indisponível e
 * review REJECT são todas "não aceito" — ausência de prova nunca vira aceite.
 */

import { canonicalSha256 } from './canonical.js';
import type { HarnessPaths } from './paths.js';
import { candidateReviewPath, readCandidateReview } from './records.js';
import type {
  CandidateReviewRecord,
  CandidateReviewRequirement,
  OrchestratedFinalizationRecord,
} from './schemas.js';

/**
 * Hash canônico dos resultados da validação oficial deste candidate. É o que
 * amarra o veredito à evidência determinística que o reviewer recebeu: um
 * veredito emitido sobre outra bateria de validação não decide sobre este
 * candidate.
 */
export function validationResultsFingerprint(
  record: OrchestratedFinalizationRecord,
): string {
  return canonicalSha256(record.validation_results);
}

export function finalizationFingerprint(record: OrchestratedFinalizationRecord): string {
  return canonicalSha256(record);
}

export type CandidateReviewStatus =
  /** Nenhuma review exigida por este candidate: o caminho DIRECT histórico. */
  | 'NOT_REQUIRED'
  /** Exigida e ainda sem veredito durável. */
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  /** Existe veredito, mas ele não descreve ESTE candidate/evidência. */
  | 'DIVERGENT';

export interface CandidateReviewLookup {
  readonly status: CandidateReviewStatus;
  readonly reason: string;
  readonly record: CandidateReviewRecord | null;
  readonly requirement: CandidateReviewRequirement | null;
  readonly evidence_path: string;
}

/**
 * Lê o veredito durável e PROVA que ele fala deste candidate. A divergência é
 * um desfecho próprio — e bloqueante — porque um veredito que não amarra ao
 * candidate corrente é evidência de outra coisa, não permissão para promover.
 */
export async function lookupCandidateReview(
  paths: HarnessPaths,
  record: OrchestratedFinalizationRecord,
): Promise<CandidateReviewLookup> {
  const evidencePath = candidateReviewPath(paths, record.task_id, record.attempt);
  const requirement = record.review_requirement ?? null;
  if (requirement === null) {
    return {
      status: 'NOT_REQUIRED',
      reason: 'o candidate não declara review independente exigida',
      record: null,
      requirement: null,
      evidence_path: evidencePath,
    };
  }

  const review = await readCandidateReview(paths, record.task_id, record.attempt);
  if (review === null) {
    return {
      status: 'PENDING',
      reason: `review independente exigida e ainda não decidida para o candidate ${record.candidate_commit}`,
      record: null,
      requirement,
      evidence_path: evidencePath,
    };
  }

  const bindings: string[] = [];
  if (review.candidate_sha !== record.candidate_commit) {
    bindings.push(
      `candidate_sha ${review.candidate_sha} != ${record.candidate_commit}`,
    );
  }
  if (review.finalization_record_sha256 !== finalizationFingerprint(record)) {
    bindings.push('finalization_record_sha256 diverge do candidate preparado');
  }
  if (review.validation_results_sha256 !== validationResultsFingerprint(record)) {
    bindings.push('validation_results_sha256 diverge da validação oficial do candidate');
  }
  if (bindings.length > 0) {
    return {
      status: 'DIVERGENT',
      reason: `veredito de review não pertence a este candidate: ${bindings.join('; ')}`,
      record: review,
      requirement,
      evidence_path: evidencePath,
    };
  }

  return {
    status: review.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
    reason: review.reason,
    record: review,
    requirement,
    evidence_path: evidencePath,
  };
}

/**
 * Decisão devolvida por quem tem autoridade de review. `BLOCKED` cobre REJECT,
 * review indisponível e review não concluída: para a promoção do candidate as
 * três são a mesma coisa.
 */
export type ValidatedCandidateAcceptance =
  | { readonly outcome: 'ACCEPT'; readonly reason: string }
  | { readonly outcome: 'BLOCKED'; readonly code: string; readonly reason: string };

/**
 * Porta ÚNICA pela qual a finalização consulta a autoridade de review. Duas
 * perguntas separadas de propósito: a EXIGÊNCIA precisa ser conhecida antes de
 * o record do candidate ser gravado (é ela que torna o record "preparado, não
 * aceito"), e a DECISÃO só existe depois, sobre o candidate já preparado.
 *
 * Ausente, a finalização se comporta exatamente como antes desta manutenção.
 */
export interface ValidatedCandidateAcceptancePolicy {
  requirementFor(taskId: string): CandidateReviewRequirement | null;
  review(input: {
    readonly taskId: string;
    readonly record: OrchestratedFinalizationRecord;
  }): Promise<ValidatedCandidateAcceptance>;
}
