/**
 * Contratos puros da recuperação de incidente.
 *
 * Este módulo não lança provider, não escreve no projeto e não cria gates
 * humanos. Ele só valida a evidência que atravessa a fronteira entre um
 * `TechnicalBlockedOutput` terminal e a camada de recuperação do Lab.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { HumanAuthority, TechnicalBlocker } from '../../src/intake/index.js';
import type { TechnicalBlockedOutput } from './control-plane-halt.js';

const nonEmpty = z.string().trim().min(1);

export const RecoveryMode = z.enum(['ask', 'auto', 'stop']);
export type RecoveryMode = z.infer<typeof RecoveryMode>;

export const RecoveryDecision = z.enum(['investigate', 'stop']);
export type RecoveryDecision = z.infer<typeof RecoveryDecision>;

export const IncidentClassification = z.enum([
  'TARGET_PROJECT',
  'HARNESS',
  'ENVIRONMENT',
  'PROVIDER',
  'MISSING_CONTEXT',
  'HUMAN_DECISION',
]);
export type IncidentClassification = z.infer<typeof IncidentClassification>;

export const IncidentEvidence = z.object({
  path: nonEmpty,
  summary: nonEmpty,
}).strict();
export type IncidentEvidence = z.infer<typeof IncidentEvidence>;

/** Output aceito do investigator. Prosa livre não é autoridade operacional. */
export const IncidentDiagnosis = z.object({
  schema_version: z.literal(1),
  classification: IncidentClassification,
  root_cause: nonEmpty,
  evidence: z.array(IncidentEvidence).min(1),
  remediation: z.array(nonEmpty),
  safe_within_current_authority: z.boolean(),
  resume_strategy: nonEmpty,
  human_authority: HumanAuthority.optional(),
}).strict().superRefine((value, context) => {
  if (value.classification === 'HUMAN_DECISION' && value.human_authority === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'HUMAN_DECISION exige human_authority' });
  }
  if (value.classification !== 'HUMAN_DECISION' && value.human_authority !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'human_authority só cabe em HUMAN_DECISION' });
  }
  if (value.classification === 'HUMAN_DECISION' && value.safe_within_current_authority) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'HUMAN_DECISION não cabe na autoridade atual' });
  }
});
export type IncidentDiagnosis = z.infer<typeof IncidentDiagnosis>;

export const InvestigatorLaunchEvidence = z.object({
  schema_version: z.literal(1),
  profile_id: nonEmpty,
  outcome: z.enum(['DIAGNOSED', 'INVOCATION_FAILED', 'INVALID_OUTPUT']),
  detail: nonEmpty.optional(),
}).strict();
export type InvestigatorLaunchEvidence = z.infer<typeof InvestigatorLaunchEvidence>;

export const IncidentInvestigationResult = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('DIAGNOSED'),
    diagnosis: IncidentDiagnosis,
    launches: z.array(InvestigatorLaunchEvidence),
  }).strict(),
  z.object({
    outcome: z.literal('UNAVAILABLE'),
    reason: nonEmpty,
    launches: z.array(InvestigatorLaunchEvidence),
  }).strict(),
]);
export type IncidentInvestigationResult = z.infer<typeof IncidentInvestigationResult>;

export const RecoveryBudget = z.object({
  max_investigator_launches: z.number().int().positive().max(3).default(3),
  max_remediation_cycles: z.number().int().positive().max(2).default(2),
}).strict();
export type RecoveryBudget = z.infer<typeof RecoveryBudget>;
export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  max_investigator_launches: 3,
  max_remediation_cycles: 2,
};

export const RecoveryIncident = z.object({
  schema_version: z.literal(1),
  incident_id: nonEmpty,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  task_id: z.string().trim().min(1).nullable(),
  blocker: TechnicalBlocker,
  reason: nonEmpty,
  evidence_paths: z.array(nonEmpty),
  runtime_dir: nonEmpty,
  created_at: nonEmpty,
  budget: RecoveryBudget,
}).strict();
export type RecoveryIncident = z.infer<typeof RecoveryIncident>;

export interface RecoveryBudgetUsage {
  readonly investigator_launches: number;
  readonly remediation_cycles: number;
  readonly previous_fingerprints: readonly string[];
}

export type RecoveryBudgetStatus =
  | { readonly status: 'AVAILABLE' }
  | { readonly status: 'EXHAUSTED'; readonly reason: string };

export function recoveryBudgetStatus(
  budget: RecoveryBudget,
  usage: RecoveryBudgetUsage,
  fingerprint: string,
): RecoveryBudgetStatus {
  if (usage.previous_fingerprints.includes(fingerprint) && usage.remediation_cycles >= budget.max_remediation_cycles) {
    return { status: 'EXHAUSTED', reason: 'a mesma fingerprint sobreviveu ao orçamento de remediação' };
  }
  if (usage.investigator_launches >= budget.max_investigator_launches) {
    return { status: 'EXHAUSTED', reason: 'orçamento de investigator esgotado' };
  }
  return { status: 'AVAILABLE' };
}

/** Identidade baseada apenas em fatos persistíveis, nunca em resposta oculta de modelo. */
export function incidentFingerprint(input: {
  readonly task_id: string | null;
  readonly blocker: TechnicalBlocker;
  readonly reason: string;
  readonly evidence_paths: readonly string[];
  readonly base_sha?: string | null;
  readonly head_sha?: string | null;
}): string {
  const canonical = JSON.stringify({
    task_id: input.task_id,
    blocker: input.blocker,
    reason: input.reason.trim(),
    evidence_paths: [...new Set(input.evidence_paths)].sort(),
    base_sha: input.base_sha ?? null,
    head_sha: input.head_sha ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function recoveryModeForSession(input: {
  readonly configured: RecoveryMode | undefined;
  readonly isTTY: boolean;
}): RecoveryMode {
  if (input.configured !== undefined) return input.configured;
  return input.isTTY ? 'ask' : 'stop';
}

/** Diagnóstico mínimo, factual e explicável para a escolha de parar. */
export function diagnosticFromTechnicalHalt(
  halt: TechnicalBlockedOutput,
  terminalLifecycleRecordPath: string,
): IncidentDiagnosis {
  const classification: IncidentClassification =
    halt.blocker === 'PROVIDER_OR_INFRA_FAILURE' || halt.blocker === 'NO_ELIGIBLE_EXECUTOR'
      ? 'PROVIDER'
      : halt.blocker === 'RUNTIME_CONFIGURATION_INVALID' || halt.blocker === 'VALIDATION_OR_TOOLING_GAP'
        ? 'ENVIRONMENT'
        : halt.blocker === 'INSUFFICIENT_EVIDENCE' || halt.blocker === 'INCONSISTENT_EVIDENCE'
          ? 'MISSING_CONTEXT'
          : 'TARGET_PROJECT';
  return {
    schema_version: 1,
    classification,
    root_cause: halt.why_automation_stopped,
    evidence: halt.evidence_paths.length > 0
      ? halt.evidence_paths.map((path) => ({ path, summary: 'evidência referenciada pelo lifecycle terminal' }))
      : [{
          path: terminalLifecycleRecordPath,
          summary: 'record estruturado do lifecycle terminal que originou este incidente',
        }],
    remediation: [...halt.options],
    safe_within_current_authority: false,
    resume_strategy: 'preservar o runtime e retomar a partir dos artifacts persistidos após investigação autorizada',
  };
}

/** Só um halt técnico tipado abre a fronteira de recovery. */
export function technicalHaltFromPayload(payload: Record<string, unknown>): TechnicalBlockedOutput | null {
  const lifecycle = payload['project_lifecycle'];
  if (typeof lifecycle !== 'object' || lifecycle === null) return null;
  const halt = (lifecycle as Record<string, unknown>)['halt'];
  if (typeof halt !== 'object' || halt === null) return null;
  const parsed = z.object({
    status: z.literal('BLOCKED'),
    blocker: TechnicalBlocker,
    incident_id: nonEmpty,
    decision_needed: nonEmpty,
    why_automation_stopped: nonEmpty,
    options: z.array(z.string()),
    evidence_paths: z.array(nonEmpty),
  }).strict().safeParse(halt);
  return parsed.success ? parsed.data : null;
}
