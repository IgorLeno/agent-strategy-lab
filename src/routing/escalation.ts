import { z } from 'zod';

import {
  decideExecutionAuthorization,
  type RealExecutionAuthorization,
} from '../billing/index.js';
import {
  ExecutionAuthorizationScope,
  authorizeExecutionAction,
  type HumanGatedCapability,
} from '../intake/index.js';
import { AttemptRole } from '../performance/attempt-facts.js';
import { CapabilityRegistry, ProfileCapability, providerFactsOf } from './capability.js';
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
    /**
     * SCAFFOLDS autorizados. Uma autorização já gravada que lista apenas
     * `claude`/`codex` continua significando exatamente isso: acrescentar
     * `opencode` ao conjunto de valores POSSÍVEIS não amplia nenhuma
     * autorização existente — só permite que uma run NOVA o declare.
     */
    allowed_providers: z.array(z.enum(['claude', 'codex', 'opencode', 'fake'])).min(1),
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
    /** SCAFFOLD de origem/destino. Fato do experimento, NÃO base da diversidade. */
    from_provider: z.enum(['claude', 'codex', 'opencode', 'fake']),
    to_provider: z.enum(['claude', 'codex', 'opencode', 'fake']),
    /**
     * UPSTREAM de origem/destino — a dimensão que decide se houve diversidade
     * real. `null` quando o perfil não tem identidade normalizada; ali a
     * comparação degrada para o scaffold, com o motivo em `cross_provider_basis`.
     */
    from_upstream: nonEmpty.nullable().default(null),
    to_upstream: nonEmpty.nullable().default(null),
    /**
     * `true` só quando os UPSTREAMS diferem. Trocar de executável contra o
     * mesmo provider (Codex -> OpenCode, ambos na conta ChatGPT) não é uma
     * segunda opinião independente: é o mesmo modelo, o mesmo provider e a
     * mesma franquia, com outro processo em volta.
     */
    cross_provider: z.boolean(),
    /** `true` quando origem e destino consomem a MESMA franquia. */
    shares_quota_pool: z.boolean().default(false),
    /** Como `cross_provider` foi decidido: upstream normalizado ou scaffold degradado. */
    cross_provider_basis: nonEmpty.default('legado: comparação por scaffold'),
    decision_owner: z.literal('agent_strategy_lab_harness'),
    scope_capabilities: z
      .array(
        z.enum([
          'CAPABILITY_ESCALATION_WITHIN_LADDER',
          'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
        ]),
      )
      .min(1),
    evidence_paths: z.array(nonEmpty).min(1),
    preflight_provenance: z.array(nonEmpty),
    provenance: z.literal('project_execution_policy'),
  })
  .strict();
export type EscalationAuthorization = z.infer<typeof EscalationAuthorization>;

const AvailabilityEvidence = z
  .object({
    value: z.boolean().nullable(),
    provenance: nonEmpty,
  })
  .strict();

/** Facts operacionais coletados pelo harness; este decisor permanece sem I/O. */
export interface EscalationCandidatePreflight {
  readonly profile_id: string;
  readonly provider_availability: z.infer<typeof AvailabilityEvidence>;
  readonly credential_availability: z.infer<typeof AvailabilityEvidence>;
  readonly real_execution_authorization: RealExecutionAuthorization;
}

export const EscalationDiscardReason = z.enum([
  'PREFLIGHT_EVIDENCE_MISSING',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_AVAILABILITY_UNKNOWN',
  'CREDENTIAL_MISSING',
  'CREDENTIAL_AVAILABILITY_UNKNOWN',
  'QUOTA_INSUFFICIENT',
  'BILLING_GUARD_BLOCKED',
  'API_BILLING_REQUIRES_EXPLICIT_SELECTION',
]);
export type EscalationDiscardReason = z.infer<typeof EscalationDiscardReason>;

export const DiscardedEscalationStep = z
  .object({
    step_index: z.number().int().positive(),
    profile_id: profileId,
    provider: z.enum(['claude', 'codex', 'opencode', 'fake']),
    reason_codes: z.array(EscalationDiscardReason).min(1),
    reasons: z.array(nonEmpty).min(1),
    capability_failure: z.literal(false),
    evaluation_outcome: z.literal('NOT_EVALUATED'),
  })
  .strict();
export type DiscardedEscalationStep = z.infer<typeof DiscardedEscalationStep>;

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
    discarded_steps: z.array(DiscardedEscalationStep),
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
    discarded_steps: z.array(DiscardedEscalationStep),
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
    discarded_steps: z.array(DiscardedEscalationStep),
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
  readonly candidate_preflights?: readonly EscalationCandidatePreflight[];
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

function unique<Value extends string>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}

function human(
  diagnosis: FailureDiagnosis,
  reasonCode: HumanEscalationReason | null,
  why: string,
  decisionNeeded: string,
  options: readonly string[],
  extraEvidence: readonly string[],
  discardedSteps: readonly DiscardedEscalationStep[] = [],
): EscalationDecision {
  return {
    outcome: 'HUMAN_REQUIRED',
    classification: diagnosis.classification,
    reason_code: reasonCode,
    attempt_role: null,
    authorization: null,
    discarded_steps: [...discardedSteps],
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
  discardedSteps: readonly DiscardedEscalationStep[] = [],
): EscalationDecision {
  return human(
    diagnosis,
    reason,
    detail,
    `Decidir sobre ${gatedCapabilityFor(reason)} antes de continuar.`,
    ['autorizar explicitamente a mudança de boundary', 'replanear sem escalation'],
    policy.evidence_paths,
    discardedSteps,
  );
}

function currentProfileFromHistory(
  initialProfileId: string,
  prior: readonly EscalationAuthorization[],
  steps: ResolvedEscalationLadder & { readonly ok: true },
): { readonly ok: true; readonly profile_id: string } | { readonly ok: false; readonly reason: string } {
  let current = initialProfileId;
  let currentStepIndex = steps.steps.findIndex((step) => step.profile_id === initialProfileId);
  if (currentStepIndex < 0) {
    return { ok: false, reason: 'profile inicial não pertence à ladder' };
  }
  for (const authorization of prior) {
    const parsed = EscalationAuthorization.safeParse(authorization);
    if (!parsed.success) return { ok: false, reason: 'authorization anterior inválida' };
    const expected = steps.steps[parsed.data.step_index];
    if (
      parsed.data.from_profile_id !== current ||
      expected?.profile_id !== parsed.data.to_profile_id ||
      parsed.data.step_index <= currentStepIndex
    ) {
      return { ok: false, reason: 'authorization anterior não forma cadeia contígua na ladder' };
    }
    current = parsed.data.to_profile_id;
    currentStepIndex = parsed.data.step_index;
  }
  return { ok: true, profile_id: current };
}

function discardedStep(
  stepIndex: number,
  profile: ProfileCapability,
  reasonCodes: readonly EscalationDiscardReason[],
  reasons: readonly string[],
): DiscardedEscalationStep {
  return {
    step_index: stepIndex,
    profile_id: profile.profile_id,
    provider: profile.agent,
    reason_codes: unique(reasonCodes),
    reasons: unique(reasons),
    capability_failure: false,
    evaluation_outcome: 'NOT_EVALUATED',
  };
}

function preflightProvenance(preflight: EscalationCandidatePreflight): string[] {
  const evidence = preflight.real_execution_authorization;
  return unique([
    preflight.provider_availability.provenance,
    preflight.credential_availability.provenance,
    evidence.authorization.provenance,
    evidence.billing_mode.provenance,
    evidence.quota.availability.provenance,
    evidence.quota.remaining.provenance,
  ]);
}

function unavailableStep(
  stepIndex: number,
  profile: ProfileCapability,
  preflight: EscalationCandidatePreflight | undefined,
): { readonly discarded: DiscardedEscalationStep | null; readonly provenance: readonly string[] } {
  if (preflight === undefined) {
    return {
      discarded: discardedStep(
        stepIndex,
        profile,
        ['PREFLIGHT_EVIDENCE_MISSING'],
        ['preflight de provider, credencial, quota e billing não foi fornecido pelo harness'],
      ),
      provenance: [],
    };
  }

  const provider = AvailabilityEvidence.parse(preflight.provider_availability);
  const credential = AvailabilityEvidence.parse(preflight.credential_availability);
  const provenance = preflightProvenance(preflight);
  const reasonCodes: EscalationDiscardReason[] = [];
  const reasons: string[] = [];

  if (provider.value === false) {
    reasonCodes.push('PROVIDER_UNAVAILABLE');
    reasons.push(`provider indisponível: ${provider.provenance}`);
  } else if (provider.value === null) {
    reasonCodes.push('PROVIDER_AVAILABILITY_UNKNOWN');
    reasons.push(`disponibilidade do provider desconhecida: ${provider.provenance}`);
  }
  if (credential.value === false) {
    reasonCodes.push('CREDENTIAL_MISSING');
    reasons.push(`credencial ausente: ${credential.provenance}`);
  } else if (credential.value === null) {
    reasonCodes.push('CREDENTIAL_AVAILABILITY_UNKNOWN');
    reasons.push(`disponibilidade da credencial desconhecida: ${credential.provenance}`);
  }

  const billingDecision = decideExecutionAuthorization(
    'REAL_INFERENCE',
    preflight.real_execution_authorization,
  );
  if (billingDecision.reasons.includes('QUOTA_INSUFFICIENT')) {
    reasonCodes.push('QUOTA_INSUFFICIENT');
    reasons.push('quota insuficiente segundo a billing/quota guard');
  }
  if (billingDecision.decision === 'BLOCK') {
    reasonCodes.push('BILLING_GUARD_BLOCKED');
    reasons.push(`billing guard bloqueou o degrau: ${billingDecision.reasons.join(', ')}`);
  }

  return {
    discarded:
      reasonCodes.length === 0
        ? null
        : discardedStep(stepIndex, profile, reasonCodes, reasons),
    provenance,
  };
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
      discarded_steps: [],
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
      discarded_steps: [],
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
  if (resolved.steps[currentIndex + 1] === undefined) {
    return humanForReason(
      diagnosis,
      policy,
      'SAFE_ESCALATION_EXHAUSTED',
      'ladder autorizada foi esgotada; novo loop de escalation foi recusado',
    );
  }
  const requestedStepIndex =
    input.requested_profile_id === undefined
      ? null
      : resolved.steps.findIndex((step) => step.profile_id === input.requested_profile_id);
  if (requestedStepIndex !== null && requestedStepIndex <= currentIndex) {
    return humanForReason(
      diagnosis,
      policy,
      'STEP_OUTSIDE_AUTHORIZED_LADDER',
      `profile solicitado ${input.requested_profile_id} não é um degrau posterior autorizado`,
    );
  }

  const current = resolved.steps[currentIndex]!.profile;
  if (
    !policy.allowed_profile_ids.includes(current.profile_id) ||
    !policy.allowed_providers.includes(current.agent)
  ) {
    return humanForReason(
      diagnosis,
      policy,
      'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
      'profile/provider atual está fora da execution policy',
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

  const preflights = new Map(
    (input.candidate_preflights ?? []).map((preflight) => [preflight.profile_id, preflight]),
  );
  const discardedSteps: DiscardedEscalationStep[] = [];
  let next: (typeof resolved.steps)[number] | undefined;
  let selectedPreflightProvenance: readonly string[] = [];

  for (let stepIndex = currentIndex + 1; stepIndex < resolved.steps.length; stepIndex += 1) {
    const candidate = resolved.steps[stepIndex];
    if (!candidate) continue;

    if (
      !policy.allowed_profile_ids.includes(candidate.profile_id) ||
      !policy.allowed_providers.includes(candidate.profile.agent)
    ) {
      return humanForReason(
        diagnosis,
        policy,
        'PROFILE_OR_PROVIDER_OUTSIDE_POLICY',
        `profile/provider ${candidate.profile_id}/${candidate.profile.agent} está fora da execution policy`,
        discardedSteps,
      );
    }
    if (!policy.authorized_billing_modes.includes(candidate.profile.billing_mode)) {
      const reason =
        candidate.profile.billing_mode === 'api'
          ? 'UNAUTHORIZED_API_BILLING'
          : 'PROFILE_OR_PROVIDER_OUTSIDE_POLICY';
      return humanForReason(
        diagnosis,
        policy,
        reason,
        `billing_mode=${candidate.profile.billing_mode} não foi autorizado pela execution policy`,
        discardedSteps,
      );
    }

    if (
      candidate.profile.billing_mode === 'api' &&
      input.requested_profile_id !== candidate.profile_id
    ) {
      discardedSteps.push(
        discardedStep(
          stepIndex,
          candidate.profile,
          ['API_BILLING_REQUIRES_EXPLICIT_SELECTION'],
          ['profile billing_mode=api nunca é escolhido implicitamente'],
        ),
      );
      continue;
    }

    const crossProvider = current.agent !== candidate.profile.agent;
    if (
      crossProvider &&
      authorizeExecutionAction(policy.authorization_scope, {
        kind: 'autonomous',
        capability: 'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
      }) !== 'ALLOWED'
    ) {
      return humanForReason(
        diagnosis,
        policy,
        'ESCALATION_NOT_AUTHORIZED',
        'ExecutionAuthorizationScope não autoriza troca cross-provider entre profiles configurados',
        discardedSteps,
      );
    }

    const candidatePreflight = preflights.get(candidate.profile_id);
    if (crossProvider || candidatePreflight !== undefined) {
      const preflight = unavailableStep(stepIndex, candidate.profile, candidatePreflight);
      if (preflight.discarded !== null) {
        discardedSteps.push(preflight.discarded);
        continue;
      }
      selectedPreflightProvenance = preflight.provenance;
    }

    if (requestedStepIndex !== null && stepIndex < requestedStepIndex) {
      return humanForReason(
        diagnosis,
        policy,
        'STEP_OUTSIDE_AUTHORIZED_LADDER',
        `profile solicitado ${input.requested_profile_id} pularia o degrau disponível ${candidate.profile_id}`,
        discardedSteps,
      );
    }
    if (requestedStepIndex !== null && stepIndex > requestedStepIndex) break;

    next = candidate;
    break;
  }

  if (next === undefined) {
    const discardSummary = discardedSteps
      .map((step) => `${step.profile_id}: ${step.reason_codes.join(', ')}`)
      .join('; ');
    return humanForReason(
      diagnosis,
      policy,
      'SAFE_ESCALATION_EXHAUSTED',
      discardSummary.length > 0
        ? `todos os degraus restantes foram descartados sem capability FAIL: ${discardSummary}`
        : 'nenhum próximo degrau autorizado permaneceu disponível',
      discardedSteps,
    );
  }

  const evidencePaths = unique([
    ...diagnosis.evidence_paths,
    ...sequence.data.initial.evidence_paths,
    ...sequence.data.repair.evidence_paths,
    ...policy.evidence_paths,
  ]);
  // DIVERSIDADE É DE UPSTREAM, NÃO DE EXECUTÁVEL. Comparar `agent` faria
  // Codex -> OpenCode/openai passar por troca de provider quando os dois falam
  // com a mesma conta ChatGPT, consomem a mesma franquia e usam o mesmo modelo.
  const currentFacts = providerFactsOf(current);
  const nextFacts = providerFactsOf(next.profile);
  const crossProvider = currentFacts.provider !== nextFacts.provider;
  const crossProviderBasis =
    current.provider_identity !== null && next.profile.provider_identity !== null
      ? `upstream normalizado: ${currentFacts.provider} -> ${nextFacts.provider}` +
        (currentFacts.quota_pool === nextFacts.quota_pool
          ? ` (MESMO pool ${currentFacts.quota_pool}: não é capacidade independente)`
          : ` (pools distintos: ${currentFacts.quota_pool} -> ${nextFacts.quota_pool})`)
      : `identidade upstream ausente em ao menos um degrau; comparação degradou para o scaffold: ${currentFacts.provenance}`;

  const authorization: EscalationAuthorization = {
    decision: 'ALLOWED',
    capability: 'CAPABILITY_ESCALATION_WITHIN_LADDER',
    attempt_role: AttemptRole.ESCALATION,
    step_index: resolved.steps.indexOf(next),
    from_profile_id: current.profile_id,
    to_profile_id: next.profile_id,
    from_provider: current.agent,
    to_provider: next.profile.agent,
    from_upstream: currentFacts.provider,
    to_upstream: nextFacts.provider,
    cross_provider: crossProvider,
    shares_quota_pool: currentFacts.quota_pool === nextFacts.quota_pool,
    cross_provider_basis: crossProviderBasis,
    decision_owner: 'agent_strategy_lab_harness',
    scope_capabilities: crossProvider
      ? [
          'CAPABILITY_ESCALATION_WITHIN_LADDER',
          'CROSS_PROVIDER_WITHIN_ALLOWED_SUBSCRIPTION_PROFILES',
        ]
      : ['CAPABILITY_ESCALATION_WITHIN_LADDER'],
    evidence_paths: evidencePaths,
    preflight_provenance: [...selectedPreflightProvenance],
    provenance: 'project_execution_policy',
  };
  return {
    outcome: 'ESCALATE',
    classification: 'CAPABILITY',
    from_profile: current,
    to_profile: next.profile,
    attempt_role: AttemptRole.ESCALATION,
    authorization,
    discarded_steps: discardedSteps,
    rationale: `${next.rationale}; ${input.ladder.ordering_rationale}`,
    human_required: null,
  };
}
