import { EvaluationOutcome, ExecutionStatus } from '../core/enums.js';
import type { InterventionRecord } from '../schemas/intervention.js';

/**
 * Papel de um attempt dentro do histórico de um trial. Vem sempre da
 * história fornecida pelo chamador (dev/orchestrate, fixtures de teste) —
 * NUNCA é inferido a partir do conteúdo do próprio attempt.
 */
export enum AttemptRole {
  INITIAL = 'initial',
  REPAIR = 'repair',
  ESCALATION = 'escalation',
  UNKNOWN = 'unknown',
}

/**
 * Evidência objetiva disponível para julgar se um attempt executou
 * inferência. Ambas as provas vêm de dados derivados pelo orquestrador
 * (eventos de transporte, métricas de usage/cost/tokens) — self-report do
 * provider nunca entra aqui.
 *
 * model_events_observed: true quando existe ao menos um evento/model usage
 * objetivo (prova positiva de inferência).
 * zero_inference_proven: true quando usage/cost/tokens foram verificados
 * como zero de forma autoritativa E nenhum modelo foi executado (prova
 * positiva de ausência de inferência). A ausência de eventos, por si só,
 * NUNCA torna este campo true — é preciso prova, não silêncio.
 */
export interface InferenceEvidence {
  readonly model_events_observed: boolean;
  readonly zero_inference_proven: boolean;
}

/** Valor com proveniência: par (valor, motivo/fonte) usado nos fatos derivados. */
export interface WithProvenance<T> {
  readonly value: T;
  readonly provenance: string;
}

export interface AttemptFactsInput {
  readonly execution_status: ExecutionStatus;
  /** null quando o attempt não foi avaliado (nenhuma EvaluationRecord). */
  readonly evaluation_outcome: EvaluationOutcome | null;
  readonly attempt_role: AttemptRole;
  /**
   * null/undefined quando não há registro de intervenções para este attempt
   * (desconhecido) — distinto de [] (registro positivo de zero intervenções).
   */
  readonly interventions: readonly InterventionRecord[] | null;
  readonly inference_evidence: InferenceEvidence;
}

/**
 * Fatos ortogonais de um attempt. Nenhuma dimensão aqui é derivada das
 * outras: execution_status INFRA_ERROR pode coexistir com qualquer valor de
 * had_inference, conforme a evidência disponível — não existe classificação
 * binária INFRA vs INFERENCE_BEARING.
 */
export interface AttemptFacts {
  readonly execution_status: ExecutionStatus;
  readonly had_inference: WithProvenance<boolean | null>;
  readonly evaluation_outcome: EvaluationOutcome | null;
  readonly attempt_role: AttemptRole;
  readonly interventions: readonly InterventionRecord[] | null;
}

function deriveHadInference(evidence: InferenceEvidence): WithProvenance<boolean | null> {
  if (evidence.model_events_observed) {
    return { value: true, provenance: 'model_events_observed' };
  }
  if (evidence.zero_inference_proven) {
    return { value: false, provenance: 'zero_inference_proven' };
  }
  return { value: null, provenance: 'insufficient_evidence' };
}

/**
 * Deriva os fatos ortogonais de um attempt a partir de evidência já
 * coletada pelo chamador. Função pura, sem I/O: quem lê disco/eventos é o
 * chamador (dev/orchestrate ou os leitores de M48+).
 */
export function deriveAttemptFacts(input: AttemptFactsInput): AttemptFacts {
  return {
    execution_status: input.execution_status,
    had_inference: deriveHadInference(input.inference_evidence),
    evaluation_outcome: input.evaluation_outcome,
    attempt_role: input.attempt_role,
    interventions: input.interventions,
  };
}
