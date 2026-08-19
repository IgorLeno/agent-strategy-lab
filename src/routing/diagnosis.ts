import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

/**
 * Classes mutuamente exclusivas usadas depois que o único bounded repair
 * falhou. Em particular, ausência de evidência nunca é promovida a
 * CAPABILITY para manter momentum.
 */
export const FailureDiagnosisClassification = z.enum([
  'INFRA',
  'ENVIRONMENT_NOT_READY',
  'TASK_DEFINITION_TOO_BROAD',
  'CONTEXT_PRESSURE',
  'VALIDATION_OR_TOOLING_GAP',
  'CAPABILITY',
  'UNKNOWN_INSUFFICIENT_EVIDENCE',
]);
export type FailureDiagnosisClassification = z.infer<typeof FailureDiagnosisClassification>;

/** O repair de task continua sendo exatamente um attempt no mesmo profile. */
export const BoundedRepairBudget = z
  .object({
    kind: z.literal('BOUNDED_REPAIR'),
    maximum_attempts: z.literal(1),
    attempts_used: z.literal(1),
    same_profile_required: z.literal(true),
  })
  .strict();
export type BoundedRepairBudget = z.infer<typeof BoundedRepairBudget>;

/**
 * Contrato provider-neutral de FAILURE DIAGNOSIS. Os nomes dos campos
 * preservam a semântica da routine autonomy para que M84 só adapte o
 * contrato puro ao output do harness, sem traduzir um vocabulário paralelo.
 */
export const FailureDiagnosis = z
  .object({
    schema_version: z.literal(1),
    classification: FailureDiagnosisClassification,
    rationale: nonEmpty,
    boundary: nonEmpty,
    retry_budget: BoundedRepairBudget,
    decision_needed: nonEmpty,
    why_automation_stopped: nonEmpty,
    options: z.array(nonEmpty).min(1),
    evidence_paths: z.array(nonEmpty).min(1),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type FailureDiagnosis = z.infer<typeof FailureDiagnosis>;

/** Equivalente puro de HumanRequiredOutput; o adapter real pertence a M84. */
export const HumanInterventionDecision = z
  .object({
    status: z.literal('HUMAN_REQUIRED'),
    classification: FailureDiagnosisClassification,
    decision_needed: nonEmpty,
    why_automation_stopped: nonEmpty,
    options: z.array(nonEmpty).min(1),
    evidence_paths: z.array(nonEmpty).min(1),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type HumanInterventionDecision = z.infer<typeof HumanInterventionDecision>;

export const FailureInterventionAction = z.enum([
  'RETRY_INFRA_SAME_PROFILE',
  'REMEDIATE_ENVIRONMENT',
  'REPLAN_OR_DECOMPOSE',
  'RESCOPE_CONTEXT',
  'REPAIR_HARNESS_OR_TOOLING',
  'ESCALATION_ELIGIBLE',
]);
export type FailureInterventionAction = z.infer<typeof FailureInterventionAction>;

const AutomatedFailureIntervention = z
  .object({
    status: z.literal('ACTION_REQUIRED'),
    classification: FailureDiagnosisClassification,
    action: FailureInterventionAction,
    rationale: nonEmpty,
    boundary: nonEmpty,
    consumes_escalation_step: z.literal(false),
    changes_profile: z.boolean(),
    human_required: z.null(),
  })
  .strict();

export const FailureInterventionDecision = z.union([
  AutomatedFailureIntervention,
  z
    .object({
      status: z.literal('HUMAN_REQUIRED'),
      classification: FailureDiagnosisClassification,
      action: z.literal('NONE'),
      rationale: nonEmpty,
      boundary: nonEmpty,
      consumes_escalation_step: z.literal(false),
      changes_profile: z.literal(false),
      human_required: HumanInterventionDecision,
    })
    .strict(),
]);
export type FailureInterventionDecision = z.infer<typeof FailureInterventionDecision>;

export interface FailureInterventionOptions {
  /** Verdadeiro somente quando uma primitive conhecida pode reparar o harness/tooling. */
  readonly harness_remediation_available?: boolean;
}

function humanRequired(diagnosis: FailureDiagnosis): FailureInterventionDecision {
  return {
    status: 'HUMAN_REQUIRED',
    classification: diagnosis.classification,
    action: 'NONE',
    rationale: diagnosis.rationale,
    boundary: diagnosis.boundary,
    consumes_escalation_step: false,
    changes_profile: false,
    human_required: {
      status: 'HUMAN_REQUIRED',
      classification: diagnosis.classification,
      decision_needed: diagnosis.decision_needed,
      why_automation_stopped: diagnosis.why_automation_stopped,
      options: [...diagnosis.options],
      evidence_paths: [...diagnosis.evidence_paths],
      provenance: [...diagnosis.provenance],
    },
  };
}

function action(
  diagnosis: FailureDiagnosis,
  next: FailureInterventionAction,
  changesProfile = false,
): FailureInterventionDecision {
  return {
    status: 'ACTION_REQUIRED',
    classification: diagnosis.classification,
    action: next,
    rationale: diagnosis.rationale,
    boundary: diagnosis.boundary,
    consumes_escalation_step: false,
    changes_profile: changesProfile,
    human_required: null,
  };
}

/**
 * Mapeia diagnóstico para a próxima ação sem I/O. Só CAPABILITY fica elegível
 * para a ladder; até esse resultado não consome degrau nem cria autorização.
 */
export function decideFailureIntervention(
  rawDiagnosis: FailureDiagnosis,
  options: FailureInterventionOptions = {},
): FailureInterventionDecision {
  const diagnosis = FailureDiagnosis.parse(rawDiagnosis);
  switch (diagnosis.classification) {
    case 'INFRA':
      return action(diagnosis, 'RETRY_INFRA_SAME_PROFILE');
    case 'ENVIRONMENT_NOT_READY':
      return action(diagnosis, 'REMEDIATE_ENVIRONMENT');
    case 'TASK_DEFINITION_TOO_BROAD':
      return action(diagnosis, 'REPLAN_OR_DECOMPOSE');
    case 'CONTEXT_PRESSURE':
      return action(diagnosis, 'RESCOPE_CONTEXT');
    case 'VALIDATION_OR_TOOLING_GAP':
      return options.harness_remediation_available
        ? action(diagnosis, 'REPAIR_HARNESS_OR_TOOLING')
        : humanRequired(diagnosis);
    case 'CAPABILITY':
      return action(diagnosis, 'ESCALATION_ELIGIBLE', true);
    case 'UNKNOWN_INSUFFICIENT_EVIDENCE':
      return humanRequired(diagnosis);
  }
}
