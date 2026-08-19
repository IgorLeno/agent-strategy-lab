import { z } from 'zod';

import {
  ExecutionAuthorizationScope,
  authorizeExecutionAction,
  type HumanGatedCapability,
} from '../intake/index.js';
import { AttemptRole } from '../performance/attempt-facts.js';
import { CapabilityRegistry, ProfileCapability } from './capability.js';
import {
  FailureDiagnosis,
  FailureInterventionDecision,
  HumanInterventionDecision,
  decideFailureIntervention,
} from './diagnosis.js';

const nonEmpty = z.string().trim().min(1);
const profileId = nonEmpty;

export const DEFAULT_ESCALATION_ORDER_RATIONALE =
  'ordem configurada por capability_rank estritamente crescente; ranks vêm da policy, nunca de nomes de modelo ou preferência de provider';

export const EscalationStep = z
  .object({
    profile_id: profileId,
    capability_rank: z.number().int().nonnegative(),
    rationale: nonEmpty,
  })
  .strict();
export type EscalationStep = z.infer<typeof EscalationStep>;

/**
 * Ladder configurável. A ordem do array é o default aprovado e precisa provar
 * capacidade crescente via rank explícito da policy, sem heurística de model.
 */
export const EscalationLadder = z
  .object({
    schema_version: z.literal(1),
    ordering: z.literal('CONFIGURED_CAPABILITY_ASCENDING'),
    ordering_rationale: nonEmpty.default(DEFAULT_ESCALATION_ORDER_RATIONALE),
    steps: z.array(EscalationStep).min(2),
  })
  .strict()
  .superRefine((ladder, context) => {
    const ids = new Set<string>();
    for (let index = 0; index < ladder.steps.length; index += 1) {
      const step = ladder.steps[index];
      if (!step) continue;
      if (ids.has(step.profile_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'profile_id duplicado na ladder',
          path: ['steps', index, 'profile_id'],
        });
      }
      ids.add(step.profile_id);
      const previous = ladder.steps[index - 1];
      if (previous && step.capability_rank <= previous.capability_rank) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'capability_rank precisa ser estritamente crescente',
          path: ['steps', index, 'capability_rank'],
        });
      }
    }
  });
export type EscalationLadder = z.infer<typeof EscalationLadder>;

export const EscalationExecutionPolicy = z
  .object({
    schema_version: z.literal(1),
    authorization_scope: ExecutionAuthorizationScope,
    allowed_profile_ids: z.array(profileId).min(1),
    allowed_providers: z.array(z.enum(['claude', 'codex', 'fake'])).min(1),
    authorized_billing_modes: z.array(nonEmpty).min(1),
    evidence_paths: z.array(nonEmpty).min(1),
    provenance: z.literal('project_execution_policy'),
  })
  .strict();
export type EscalationExecutionPolicy = z.infer<typeof EscalationExecutionPolicy>;

const FailedAttempt = z
  .object({
    profile_id: profileId,
    evaluation_outcome: z.literal('FAIL'),
    evidence_paths: z.array(nonEmpty).min(1),
  })
  .strict();

/** Prova de que diagnosis só ocorre depois do único repair no mesmo profile. */
export const RepairSequenceEvidence = z
  .object({
    initial: FailedAttempt.extend({ attempt_role: z.literal(AttemptRole.INITIAL) }).strict(),
    repair: FailedAttempt.extend({
      attempt_role: z.literal(AttemptRole.REPAIR),
      retry_budget: z.literal(1),
      authorization_provenance: nonEmpty,
    }).strict(),
  })
  .strict()
  .superRefine((sequence, context) => {
    if (sequence.initial.profile_id !== sequence.repair.profile_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'bounded repair precisa usar o mesmo profile do first pass',
        path: ['repair', 'profile_id'],
      });
    }
  });
export type RepairSequenceEvidence = z.infer<typeof RepairSequenceEvidence>;

export const EscalationAuthorization = z
  .object({
    decision: z.literal('ALLOWED'),
    capability: z.literal('CAPABILITY_ESCALATION_WITHIN_LADDER'),
    attempt_role: z.literal(AttemptRole.ESCALATION),
    step_index: z.number().int().positive(),
    from_profile_id: profileId,
    to_profile_id: profileId,
    evidence_paths: z.array(nonEmpty).min(1),
    provenance: z.literal('project_execution_policy'),
  })
  .strict();
export type EscalationAuthorization = z.infer<typeof EscalationAuthorization>;

export const HumanEscalationReason = z.enum([
  'INVALID_REPAIR_SEQUENCE',
  'INSUFFICIENT_REGISTRY_EVIDENCE',
  'STEP_OUTSIDE_AUTHORIZED_LADDER',
  'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
  'UNAUTHORIZED_API_BILLING',
  'ESCALATION_NOT_AUTHORIZED',
  'SAFE_ESCALATION_EXHAUSTED',
  'INVALID_ESCALATION_HISTORY',
]);
export type HumanEscalationReason = z.infer<typeof HumanEscalationReason>;

const Escalate = z
  .object({
    outcome: z.literal('ESCALATE'),
    classification: z.literal('CAPABILITY'),
    from_profile: ProfileCapability,
    to_profile: ProfileCapability,
    attempt_role: z.literal(AttemptRole.ESCALATION),
    authorization: EscalationAuthorization,
    rationale: nonEmpty,
    human_required: z.null(),
  })
  .strict();

const NoEscalation = z
  .object({
    outcome: z.literal('NO_ESCALATION'),
    classification: FailureDiagnosis.shape.classification,
    attempt_role: z.null(),
    authorization: z.null(),
    intervention: FailureInterventionDecision,
    human_required: z.null(),
  })
  .strict();

const EscalationHumanRequired = z
  .object({
    outcome: z.literal('HUMAN_REQUIRED'),
    classification: FailureDiagnosis.shape.classification,
    reason_code: HumanEscalationReason.nullable(),
    attempt_role: z.null(),
    authorization: z.null(),
    human_required: HumanInterventionDecision,
  })
  .strict();

export const EscalationDecision = z.discriminatedUnion('outcome', [
  Escalate,
  NoEscalation,
  EscalationHumanRequired,
]);
export type EscalationDecision = z.infer<typeof EscalationDecision>;

export interface EscalationDecisionInput {
  readonly diagnosis: FailureDiagnosis;
  readonly repair_sequence: RepairSequenceEvidence;
  readonly ladder: EscalationLadder;
  readonly capability_registry: CapabilityRegistry;
  readonly execution_policy: EscalationExecutionPolicy;
  readonly prior_authorizations?: readonly EscalationAuthorization[];
  readonly requested_profile_id?: string;
}

export type ResolvedEscalationLadder =
  | { readonly ok: true; readonly steps: readonly (EscalationStep & { readonly profile: ProfileCapability })[] }
  | { readonly ok: false; readonly missing_profile_ids: readonly string[] };

/** Resolve toda a configuração contra facts do registry, sem consultar provider. */
export function resolveEscalationLadder(
  rawLadder: EscalationLadder,
  registry: CapabilityRegistry,
): ResolvedEscalationLadder {
  const ladder = EscalationLadder.parse(rawLadder);
  const missing = ladder.steps
    .filter((step) => registry.get(step.profile_id) === undefined)
    .map((step) => step.profile_id);
  if (missing.length > 0) return { ok: false, missing_profile_ids: missing };
  return {
    ok: true,
    steps: ladder.steps.map((step) => ({ ...step, profile: registry.get(step.profile_id)! })),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function human(
  diagnosis: FailureDiagnosis,
  reasonCode: HumanEscalationReason | null,
  why: string,
  decisionNeeded: string,
  options: readonly string[],
  extraEvidence: readonly string[],
): EscalationDecision {
  return {
    outcome: 'HUMAN_REQUIRED',
    classification: diagnosis.classification,
    reason_code: reasonCode,
    attempt_role: null,
    authorization: null,
    human_required: {
      status: 'HUMAN_REQUIRED',
      classification: diagnosis.classification,
      decision_needed: decisionNeeded,
      why_automation_stopped: why,
      options: [...options],
      evidence_paths: unique([...diagnosis.evidence_paths, ...extraEvidence]),
      provenance: [...diagnosis.provenance],
    },
  };
}

function gatedCapabilityFor(reason: HumanEscalationReason): HumanGatedCapability {
  switch (reason) {
    case 'UNAUTHORIZED_API_BILLING':
      return 'UNAUTHORIZED_API_BILLING';
    case 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY':
    case 'STEP_OUTSIDE_AUTHORIZED_LADDER':
      return 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY';
    case 'SAFE_ESCALATION_EXHAUSTED':
      return 'SAFE_ESCALATION_EXHAUSTED';
    case 'INVALID_REPAIR_SEQUENCE':
    case 'INSUFFICIENT_REGISTRY_EVIDENCE':
    case 'ESCALATION_NOT_AUTHORIZED':
    case 'INVALID_ESCALATION_HISTORY':
      return 'INSUFFICIENT_EVIDENCE';
  }
}

function humanForReason(
  diagnosis: FailureDiagnosis,
  policy: EscalationExecutionPolicy,
  reason: HumanEscalationReason,
  detail: string,
): EscalationDecision {
  return human(
    diagnosis,
    reason,
    detail,
    `Decidir sobre ${gatedCapabilityFor(reason)} antes de continuar.`,
    ['autorizar explicitamente a mudança de boundary', 'replanear sem escalation'],
    policy.evidence_paths,
  );
}

function currentProfileFromHistory(
  initialProfileId: string,
  prior: readonly EscalationAuthorization[],
  steps: ResolvedEscalationLadder & { readonly ok: true },
): { readonly ok: true; readonly profile_id: string } | { readonly ok: false; readonly reason: string } {
  let current = initialProfileId;
  for (const authorization of prior) {
    const parsed = EscalationAuthorization.safeParse(authorization);
    if (!parsed.success) return { ok: false, reason: 'authorization anterior inválida' };
    const expected = steps.steps[parsed.data.step_index];
    if (
      parsed.data.from_profile_id !== current ||
      expected?.profile_id !== parsed.data.to_profile_id ||
      steps.steps[parsed.data.step_index - 1]?.profile_id !== parsed.data.from_profile_id
    ) {
      return { ok: false, reason: 'authorization anterior não forma cadeia contígua na ladder' };
    }
    current = parsed.data.to_profile_id;
  }
  return { ok: true, profile_id: current };
}

/**
 * Decide um único próximo degrau. Não executa provider, não faz spawn e não
 * muta budget. Uma chamada bem-sucedida produz uma autorização própria para
 * exatamente um degrau; repair authorization nunca é copiada.
 */
export function decideEscalation(input: EscalationDecisionInput): EscalationDecision {
  const diagnosis = FailureDiagnosis.parse(input.diagnosis);
  const sequence = RepairSequenceEvidence.safeParse(input.repair_sequence);
  const policy = EscalationExecutionPolicy.parse(input.execution_policy);
  if (!sequence.success) {
    return humanForReason(
      diagnosis,
      policy,
      'INVALID_REPAIR_SEQUENCE',
      'failure diagnosis não está apoiada por first pass + um bounded repair no mesmo profile',
    );
  }

  const intervention = decideFailureIntervention(diagnosis);
  if (intervention.status === 'HUMAN_REQUIRED') {
    return {
      outcome: 'HUMAN_REQUIRED',
      classification: diagnosis.classification,
      reason_code: null,
      attempt_role: null,
      authorization: null,
      human_required: intervention.human_required,
    };
  }
  if (intervention.action !== 'ESCALATION_ELIGIBLE') {
    return {
      outcome: 'NO_ESCALATION',
      classification: diagnosis.classification,
      attempt_role: null,
      authorization: null,
      intervention,
      human_required: null,
    };
  }

  const resolved = resolveEscalationLadder(input.ladder, input.capability_registry);
  if (!resolved.ok) {
    return humanForReason(
      diagnosis,
      policy,
      'INSUFFICIENT_REGISTRY_EVIDENCE',
      `profiles da ladder ausentes no capability registry: ${resolved.missing_profile_ids.join(', ')}`,
    );
  }

  const history = currentProfileFromHistory(
    sequence.data.repair.profile_id,
    input.prior_authorizations ?? [],
    resolved,
  );
  if (!history.ok) {
    return humanForReason(diagnosis, policy, 'INVALID_ESCALATION_HISTORY', history.reason);
  }
  const currentIndex = resolved.steps.findIndex((step) => step.profile_id === history.profile_id);
  if (currentIndex < 0) {
    return humanForReason(
      diagnosis,
      policy,
      'STEP_OUTSIDE_AUTHORIZED_LADDER',
      `profile atual ${history.profile_id} não pertence à ladder autorizada`,
    );
  }
  const next = resolved.steps[currentIndex + 1];
  if (!next) {
    return humanForReason(
      diagnosis,
      policy,
      'SAFE_ESCALATION_EXHAUSTED',
      'ladder autorizada foi esgotada; novo loop de escalation foi recusado',
    );
  }
  if (input.requested_profile_id !== undefined && input.requested_profile_id !== next.profile_id) {
    return humanForReason(
      diagnosis,
      policy,
      'STEP_OUTSIDE_AUTHORIZED_LADDER',
      `profile solicitado ${input.requested_profile_id} não é o próximo degrau autorizado`,
    );
  }

  const current = resolved.steps[currentIndex]!.profile;
  if (
    current.agent !== next.profile.agent ||
    !policy.allowed_profile_ids.includes(current.profile_id) ||
    !policy.allowed_profile_ids.includes(next.profile_id) ||
    !policy.allowed_providers.includes(current.agent) ||
    !policy.allowed_providers.includes(next.profile.agent)
  ) {
    return humanForReason(
      diagnosis,
      policy,
      'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
      'próximo profile/provider está fora da execution policy ou exigiria cross-provider',
    );
  }
  if (!policy.authorized_billing_modes.includes(next.profile.billing_mode)) {
    const reason =
      next.profile.billing_mode === 'api'
        ? 'UNAUTHORIZED_API_BILLING'
        : 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY';
    return humanForReason(
      diagnosis,
      policy,
      reason,
      `billing_mode=${next.profile.billing_mode} não foi autorizado pela execution policy`,
    );
  }
  if (
    authorizeExecutionAction(policy.authorization_scope, {
      kind: 'autonomous',
      capability: 'CAPABILITY_ESCALATION_WITHIN_LADDER',
    }) !== 'ALLOWED'
  ) {
    return humanForReason(
      diagnosis,
      policy,
      'ESCALATION_NOT_AUTHORIZED',
      'ExecutionAuthorizationScope não autoriza capability escalation dentro da ladder',
    );
  }

  const evidencePaths = unique([
    ...diagnosis.evidence_paths,
    ...sequence.data.initial.evidence_paths,
    ...sequence.data.repair.evidence_paths,
    ...policy.evidence_paths,
  ]);
  const authorization: EscalationAuthorization = {
    decision: 'ALLOWED',
    capability: 'CAPABILITY_ESCALATION_WITHIN_LADDER',
    attempt_role: AttemptRole.ESCALATION,
    step_index: currentIndex + 1,
    from_profile_id: current.profile_id,
    to_profile_id: next.profile_id,
    evidence_paths: evidencePaths,
    provenance: 'project_execution_policy',
  };
  return {
    outcome: 'ESCALATE',
    classification: 'CAPABILITY',
    from_profile: current,
    to_profile: next.profile,
    attempt_role: AttemptRole.ESCALATION,
    authorization,
    rationale: `${next.rationale}; ${input.ladder.ordering_rationale}`,
    human_required: null,
  };
}
