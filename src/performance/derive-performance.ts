import { EvaluationOutcome, ExecutionStatus } from '../core/enums.js';
import { InterventionType } from '../schemas/intervention.js';
import { TaskPerformanceRecord } from '../schemas/performance.js';
import { AttemptRole, type AttemptFacts } from './attempt-facts.js';

/**
 * Histórico normalizado de attempts de um trial, já com os fatos ortogonais
 * do M45 (execution status, had_inference com proveniência, evaluation
 * outcome, attempt role, interventions) resolvidos por `deriveAttemptFacts`.
 * derivePerformance não lê disco nem infere nada além do que já está aqui.
 */
export interface AttemptHistory {
  readonly task_id: string;
  readonly trial_id: string;
  readonly attempts: readonly AttemptFacts[];
}

interface HumanInterventionFact {
  readonly value: boolean | null;
  readonly provenance: string;
}

/**
 * interventions === null em um attempt é ausência de registro (desconhecido),
 * NUNCA prova de zero. Só vira false quando TODOS os attempts têm registro
 * positivo (array, possivelmente vazio); vira true assim que qualquer
 * attempt tiver ao menos uma intervenção registrada.
 */
function deriveHumanIntervention(attempts: readonly AttemptFacts[]): HumanInterventionFact {
  const hasRecordedIntervention = attempts.some(
    (attempt) => attempt.interventions !== null && attempt.interventions.length > 0,
  );
  if (hasRecordedIntervention) {
    return { value: true, provenance: 'intervention_recorded' };
  }

  const allAttemptsProveZero = attempts.every((attempt) => attempt.interventions !== null);
  if (allAttemptsProveZero) {
    return { value: false, provenance: 'zero_interventions_recorded_all_attempts' };
  }

  return { value: null, provenance: 'not_recorded' };
}

function deriveInterventionTypes(attempts: readonly AttemptFacts[]): InterventionType[] {
  const types = new Set<InterventionType>();
  for (const attempt of attempts) {
    for (const intervention of attempt.interventions ?? []) {
      types.add(intervention.type);
    }
  }
  return Array.from(types).sort();
}

function deriveAttemptCounts(attempts: readonly AttemptFacts[]) {
  let attemptsWithInference = 0;
  let attemptsWithoutInference = 0;
  let attemptsInferenceUnknown = 0;
  let infraErrorAttempts = 0;
  let repairAttempts = 0;
  let escalations = 0;
  let attemptsRoleUnknown = 0;

  for (const attempt of attempts) {
    if (attempt.had_inference.value === true) {
      attemptsWithInference += 1;
    } else if (attempt.had_inference.value === false) {
      attemptsWithoutInference += 1;
    } else {
      attemptsInferenceUnknown += 1;
    }

    if (attempt.execution_status === ExecutionStatus.INFRA_ERROR) {
      infraErrorAttempts += 1;
    }

    if (attempt.attempt_role === AttemptRole.REPAIR) {
      repairAttempts += 1;
    } else if (attempt.attempt_role === AttemptRole.ESCALATION) {
      escalations += 1;
    } else if (attempt.attempt_role === AttemptRole.UNKNOWN) {
      attemptsRoleUnknown += 1;
    }
  }

  return {
    operational_attempts: attempts.length,
    attempts_with_inference: attemptsWithInference,
    attempts_without_inference: attemptsWithoutInference,
    attempts_inference_unknown: attemptsInferenceUnknown,
    infra_error_attempts: infraErrorAttempts,
    repair_attempts: repairAttempts,
    escalations,
    attempts_role_unknown: attemptsRoleUnknown,
  };
}

/**
 * first_operational_pass olha só para o primeiro attempt da história, na
 * ordem em que ocorreram — inclui attempts INFRA_ERROR, que não passam.
 * first_inference_bearing_pass pula attempts sem inferência confirmada e
 * julga o primeiro attempt com had_inference true; fica null (não false)
 * quando nenhum attempt tem prova positiva de inferência.
 */
function deriveSuccess(attempts: readonly AttemptFacts[], humanIntervention: boolean | null) {
  const firstAttempt = attempts[0] ?? null;
  const firstOperationalPass =
    firstAttempt === null ? null : firstAttempt.evaluation_outcome === EvaluationOutcome.PASS;

  const firstInferenceBearingAttempt =
    attempts.find((attempt) => attempt.had_inference.value === true) ?? null;
  const firstInferenceBearingPass =
    firstInferenceBearingAttempt === null
      ? null
      : firstInferenceBearingAttempt.evaluation_outcome === EvaluationOutcome.PASS;

  const finalPass =
    attempts.length === 0
      ? null
      : attempts.some((attempt) => attempt.evaluation_outcome === EvaluationOutcome.PASS);

  let autonomousFirstPass: boolean | null;
  if (humanIntervention === null) {
    autonomousFirstPass = null;
  } else if (humanIntervention === true) {
    autonomousFirstPass = false;
  } else {
    autonomousFirstPass = firstOperationalPass === true;
  }

  return {
    first_operational_pass: firstOperationalPass,
    first_inference_bearing_pass: firstInferenceBearingPass,
    autonomous_first_pass: autonomousFirstPass,
    final_pass: finalPass,
  };
}

/**
 * Deriva o TaskPerformanceRecord agregado de um trial a partir do histórico
 * normalizado de attempts. Função pura e determinística: mesma entrada,
 * mesmos bytes canônicos. Nenhum I/O — quem lê disco/monta o AttemptHistory
 * é o chamador (dev/orchestrate ou os leitores de M48+).
 */
export function derivePerformance(history: AttemptHistory): TaskPerformanceRecord {
  const { task_id, trial_id, attempts } = history;
  const humanIntervention = deriveHumanIntervention(attempts);

  const record: TaskPerformanceRecord = {
    schema_version: 1,
    task_id,
    trial_id,
    attempts: deriveAttemptCounts(attempts),
    success: deriveSuccess(attempts, humanIntervention.value),
    intervention: {
      human_intervention: humanIntervention,
      intervention_types: deriveInterventionTypes(attempts),
    },
  };

  return TaskPerformanceRecord.parse(record);
}
