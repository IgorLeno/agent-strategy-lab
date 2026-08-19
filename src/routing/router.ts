/**
 * Router inicial, puro e determinístico.
 *
 * A entrada é sempre uma work unit estruturada (`PlannedTask`), produzida pelo
 * planner completo ou pela Direct Task Normalization. O router não lê request
 * bruto, histórico, filesystem, provider ou relógio.
 *
 * Tempos permanecem deliberadamente separados:
 * - `estimated_duration` é apenas uma estimativa da task e não entra na conta;
 * - `validation[].timeout_seconds` limita cada comando e não entra na conta;
 * - `validation_budget` é o custo agregado esperado de validação;
 * - o resultado abaixo é o WORKER RUNTIME BUDGET e só é comparado com bounds
 *   de runtime do launcher/profile fornecidos pelo control plane.
 */

import { z } from 'zod';

import { ProjectInspection } from '../inspection/index.js';
import { ExecutionAssessment, PlannedTask } from '../planner/index.js';
import { CapabilityRegistry, ProfileCapability } from './capability.js';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');

export const WorkerRole = z.enum(['planner', 'implementer', 'reviewer']);
export type WorkerRole = z.infer<typeof WorkerRole>;

export const WorkUnitSource = z.enum(['planner', 'direct_task_normalization']);
export type WorkUnitSource = z.infer<typeof WorkUnitSource>;

/**
 * O inspection é parte da entrada porque stack/ambiente são fatos observados,
 * não defaults do router. O assessment deve ter sido derivado da mesma task.
 */
export const StructuredWorkUnit = z
  .object({
    source: WorkUnitSource,
    task: PlannedTask,
    assessment: ExecutionAssessment,
    project_facts: ProjectInspection,
  })
  .strict()
  .superRefine((unit, context) => {
    if (unit.task.task_id !== unit.assessment.task_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'assessment.task_id deve identificar a mesma PlannedTask',
        path: ['assessment', 'task_id'],
      });
    }
  });
export type StructuredWorkUnit = z.infer<typeof StructuredWorkUnit>;

export const RuntimeBoundSource = z.enum(['launcher', 'profile_runtime']);
export type RuntimeBoundSource = z.infer<typeof RuntimeBoundSource>;

/** Um bound de WORKER runtime; nunca representa timeout de ValidationCommand. */
export const WorkerRuntimeBound = z
  .object({
    kind: z.literal('WORKER_RUNTIME_BOUND'),
    source: RuntimeBoundSource,
    maximum_ms: z.number().int().positive(),
    provenance: nonEmpty,
  })
  .strict();
export type WorkerRuntimeBound = z.infer<typeof WorkerRuntimeBound>;

const Availability = z
  .object({
    value: z.boolean(),
    provenance: nonEmpty,
  })
  .strict();

/**
 * Facts operacionais que não pertencem a `ProfileCapability`: disponibilidade
 * atual e bounds de runtime. Os bounds são todos da mesma grandeza; é válido
 * usar o mais restritivo entre launcher/profile, mas nunca um bound de
 * validation.
 */
export const RoutingCandidate = z
  .object({
    profile_id: identifier,
    availability: Availability,
    runtime_bounds: z.array(WorkerRuntimeBound).min(1),
  })
  .strict();
export type RoutingCandidate = z.infer<typeof RoutingCandidate>;

export const CapabilityTier = z.enum(['economy', 'intermediate', 'advanced']);
export type CapabilityTier = z.infer<typeof CapabilityTier>;

export const CandidateRejectionCode = z.enum([
  'PROFILE_UNAVAILABLE',
  'API_BILLING_REQUIRES_EXPLICIT_SELECTION',
  'ROLE_INCOMPATIBLE',
  'CAPABILITY_UNCLASSIFIED',
  'CAPABILITY_INSUFFICIENT',
  'BUDGET_UNSUPPORTED',
]);
export type CandidateRejectionCode = z.infer<typeof CandidateRejectionCode>;

export const CandidateConsideration = z
  .object({
    profile_id: identifier,
    capability_tier: CapabilityTier.nullable(),
    requested_worker_runtime_budget_ms: z.number().int().nonnegative().nullable(),
    outcome: z.enum(['SELECTED', 'REJECTED', 'NOT_SELECTED']),
    rejection_code: CandidateRejectionCode.nullable(),
    reason: nonEmpty,
  })
  .strict();
export type CandidateConsideration = z.infer<typeof CandidateConsideration>;

const BudgetComponents = z
  .object({
    envelope_duration_expected_ms: z.number().int().nonnegative(),
    aggregate_validation_cost_ms: z.number().int().nonnegative(),
    capability_multiplier: z.number().positive(),
    task_class_multiplier: z.number().positive(),
    stack_multiplier: z.number().positive(),
    environment_multiplier: z.number().positive(),
  })
  .strict();

export const WorkerRuntimeBudget = z
  .object({
    kind: z.literal('WORKER_RUNTIME_BUDGET'),
    milliseconds: z.number().int().nonnegative(),
    components: BudgetComponents,
    checked_runtime_bounds: z.array(WorkerRuntimeBound).min(1),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type WorkerRuntimeBudget = z.infer<typeof WorkerRuntimeBudget>;

export const RoutingDecision = z
  .object({
    outcome: z.literal('ROUTED'),
    profile: ProfileCapability,
    worker_runtime_budget: WorkerRuntimeBudget,
    rationale: z.array(nonEmpty).min(1),
    provenance: z.array(nonEmpty).min(1),
    candidates_considered: z.array(CandidateConsideration).min(1),
  })
  .strict();
export type RoutingDecision = z.infer<typeof RoutingDecision>;

const BudgetViolation = z
  .object({
    profile_id: identifier,
    requested_budget_ms: z.number().int().nonnegative(),
    violated_bound: WorkerRuntimeBound,
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type BudgetViolation = z.infer<typeof BudgetViolation>;

export const BudgetUnsupported = z
  .object({
    outcome: z.literal('BUDGET_UNSUPPORTED'),
    violations: z.array(BudgetViolation).min(1),
    candidates_considered: z.array(CandidateConsideration).min(1),
    allowed_next_steps: z.tuple([
      z.literal('TRY_ANOTHER_PROFILE'),
      z.literal('RECONFIGURE_RUNTIME'),
      z.literal('REPLAN'),
      z.literal('HUMAN_REQUIRED'),
    ]),
    rationale: z.array(nonEmpty).min(1),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type BudgetUnsupported = z.infer<typeof BudgetUnsupported>;

export const RoutingBlocked = z
  .object({
    outcome: z.literal('HUMAN_REQUIRED'),
    reason: nonEmpty,
    candidates_considered: z.array(CandidateConsideration),
    allowed_next_steps: z.array(z.enum(['RECONFIGURE_RUNTIME', 'REPLAN', 'HUMAN_REQUIRED'])).min(1),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type RoutingBlocked = z.infer<typeof RoutingBlocked>;

export const InitialRoutingResult = z.discriminatedUnion('outcome', [
  RoutingDecision,
  BudgetUnsupported,
  RoutingBlocked,
]);
export type InitialRoutingResult = z.infer<typeof InitialRoutingResult>;

export interface InitialRoutingInput {
  readonly work_unit: StructuredWorkUnit;
  readonly role: WorkerRole;
  readonly capability_registry: CapabilityRegistry;
  readonly candidates: readonly RoutingCandidate[];
}

const TIER_ORDER: Readonly<Record<CapabilityTier, number>> = {
  economy: 0,
  intermediate: 1,
  advanced: 2,
};

const MODEL_TIER_PATTERNS: readonly (readonly [RegExp, CapabilityTier])[] = [
  [/luna/i, 'economy'],
  [/(terra|sonnet)/i, 'intermediate'],
  [/(sol|opus)/i, 'intermediate'],
];

const MODEL_COST_PATTERNS: readonly (readonly [RegExp, number])[] = [
  [/luna/i, 0],
  [/terra/i, 1],
  [/sonnet/i, 2],
  [/sol/i, 3],
  [/opus/i, 4],
];

const EFFORT_COST: Readonly<Record<string, number>> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

function capabilityTierOf(capability: ProfileCapability): CapabilityTier | null {
  const modelTier = MODEL_TIER_PATTERNS.find(([pattern]) => pattern.test(capability.model))?.[1];
  if (modelTier === undefined) return null;

  const effort = capability.reasoning_effort.toLowerCase();
  if (['unknown', 'unpinned', 'not_applicable'].includes(effort)) return null;
  if (['high', 'xhigh', 'max'].includes(effort) && modelTier !== 'economy') return 'advanced';
  return modelTier;
}

function capabilityCostOf(capability: ProfileCapability): readonly [number, number] {
  const modelCost = MODEL_COST_PATTERNS.find(([pattern]) => pattern.test(capability.model))?.[1] ?? Number.MAX_SAFE_INTEGER;
  const effortCost = EFFORT_COST[capability.reasoning_effort.toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
  return [modelCost, effortCost];
}

function requiredTierOf(unit: StructuredWorkUnit): { tier: CapabilityTier; score: number; reasons: string[] } {
  const { task, assessment } = unit;
  const reasons: string[] = [];
  let score = 0;

  const add = (points: number, reason: string): void => {
    score += points;
    reasons.push(`${reason} (${points >= 0 ? '+' : ''}${points})`);
  };

  add(({ trivial: 0, easy: 0, medium: 1, hard: 2 } as const)[assessment.difficulty.value], `difficulty=${assessment.difficulty.value}`);
  add(({ local: 0, multi_file: 1, subsystem: 2, cross_cutting: 3 } as const)[task.taxonomy.complexity ?? 'local'], `complexity=${task.taxonomy.complexity ?? 'não declarada'}`);
  add(({ low: 0, medium: 1, high: 2 } as const)[task.taxonomy.ambiguity ?? 'low'], `ambiguity=${task.taxonomy.ambiguity ?? 'não declarada'}`);
  add(({ low: 0, medium: 1, high: 2, critical: 4 } as const)[assessment.risk.value], `risk=${assessment.risk.value}`);
  add(({ low: 0, medium: 1, high: 2 } as const)[assessment.context_pressure.value], `context_pressure=${assessment.context_pressure.value}`);
  add(({ strong: 0, partial: 1, weak: 2 } as const)[assessment.verification_strength.value], `verification_strength=${assessment.verification_strength.value}`);
  add(({ high: 0, medium: 1, low: 2 } as const)[assessment.confidence.value], `confidence=${assessment.confidence.value}`);
  add(assessment.review_requirement.independent_review_required ? 1 : 0, `independent_review_required=${assessment.review_requirement.independent_review_required}`);
  add(({ not_required: 0, preferred: 1, required: 2 } as const)[assessment.review_requirement.diversity_requirement], `diversity_requirement=${assessment.review_requirement.diversity_requirement}`);
  add(task.taxonomy.task_class === 'refactor' ? 1 : task.taxonomy.task_class === 'docs' ? -1 : 0, `task_class=${task.taxonomy.task_class}`);

  return { tier: score <= 1 ? 'economy' : score <= 6 ? 'intermediate' : 'advanced', score, reasons };
}

function taskClassMultiplier(taskClass: PlannedTask['taxonomy']['task_class']): number {
  if (taskClass === 'docs' || taskClass === 'chore') return 0.9;
  if (taskClass === 'refactor' || taskClass === 'feature') return 1.1;
  return 1;
}

function capabilityMultiplier(tier: CapabilityTier): number {
  return tier === 'economy' ? 1.2 : tier === 'intermediate' ? 1 : 0.9;
}

function budgetFor(
  unit: StructuredWorkUnit,
  capability: ProfileCapability,
  tier: CapabilityTier,
  runtimeBounds: readonly WorkerRuntimeBound[],
): WorkerRuntimeBudget | null {
  const stack = unit.project_facts.stack;
  if (!stack.known) return null;

  const stackMultiplier = 1 + Math.max(0, stack.value.ecosystems_detected.length - 1) * 0.1;
  const environmentMultiplier =
    1 +
    unit.project_facts.required_services.length * 0.05 +
    unit.project_facts.required_tools.length * 0.02 +
    (capability.environment_mode === 'controlled' ? 0 : 0.05);
  const components = {
    envelope_duration_expected_ms: unit.task.resource_envelope.duration_ms.expected,
    aggregate_validation_cost_ms: unit.task.validation_budget.expected,
    capability_multiplier: capabilityMultiplier(tier),
    task_class_multiplier: taskClassMultiplier(unit.task.taxonomy.task_class),
    stack_multiplier: stackMultiplier,
    environment_multiplier: environmentMultiplier,
  };
  const unrounded =
    (components.envelope_duration_expected_ms + components.aggregate_validation_cost_ms) *
    components.capability_multiplier *
    components.task_class_multiplier *
    components.stack_multiplier *
    components.environment_multiplier;
  const milliseconds = Math.ceil(unrounded / 1_000) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return null;

  return WorkerRuntimeBudget.parse({
    kind: 'WORKER_RUNTIME_BUDGET',
    milliseconds,
    components,
    checked_runtime_bounds: runtimeBounds,
    provenance: [
      'task.resource_envelope.duration_ms.expected',
      'task.validation_budget.expected (aggregate validation cost)',
      'selected ProfileCapability model/reasoning tier',
      'task.taxonomy.task_class',
      'project_facts.stack',
      'project_facts.required_tools,project_facts.required_services,profile.environment_mode',
    ],
  });
}

function rejected(
  candidate: RoutingCandidate,
  tier: CapabilityTier | null,
  code: CandidateRejectionCode,
  reason: string,
  requestedBudget: number | null = null,
): CandidateConsideration {
  return {
    profile_id: candidate.profile_id,
    capability_tier: tier,
    requested_worker_runtime_budget_ms: requestedBudget,
    outcome: 'REJECTED',
    rejection_code: code,
    reason,
  };
}

function roleCompatibility(capability: ProfileCapability, role: WorkerRole) {
  return capability.role_compatibility[role];
}

function block(reason: string, provenance: string, considered: CandidateConsideration[] = []): RoutingBlocked {
  return {
    outcome: 'HUMAN_REQUIRED',
    reason,
    candidates_considered: considered,
    allowed_next_steps: ['REPLAN', 'HUMAN_REQUIRED'],
    provenance: [provenance],
  };
}

/**
 * Escolhe o menor tier adequado; empate é resolvido por tier, modelo, effort e
 * profile_id, nunca pela ordem de entrada. Budget insuficiente rejeita o
 * profile e permite tentar outro — o valor nunca é truncado ao bound.
 */
export function routeInitialProfile(input: InitialRoutingInput): InitialRoutingResult {
  const roleParsed = WorkerRole.safeParse(input.role);
  if (!roleParsed.success) return block('worker role inválido impede routing', 'WorkerRole.safeParse');
  const role = roleParsed.data;
  const unitParsed = StructuredWorkUnit.safeParse(input.work_unit);
  if (!unitParsed.success) {
    return block(
      `work unit inválida: ${unitParsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
      'StructuredWorkUnit.safeParse',
    );
  }
  const unit = unitParsed.data;
  if (unit.assessment.environment_readiness.status !== 'READY') {
    return block(
      `environment_readiness=${unit.assessment.environment_readiness.status}: fato ausente ou inválido impede routing`,
      'assessment.environment_readiness',
    );
  }
  if (!unit.project_facts.stack.known) {
    return block(
      `stack desconhecida: ${unit.project_facts.stack.reason}; router não aplica default`,
      'project_facts.stack',
    );
  }

  const parsedCandidates = input.candidates.map((candidate) => RoutingCandidate.safeParse(candidate));
  const invalidCandidate = parsedCandidates.find((candidate) => !candidate.success);
  if (invalidCandidate !== undefined && !invalidCandidate.success) {
    return block(
      `candidate inválido: ${invalidCandidate.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
      'RoutingCandidate.safeParse',
    );
  }
  const candidates = parsedCandidates
    .map((candidate) => {
      if (!candidate.success) throw new Error('unreachable: invalid candidate handled above');
      return candidate.data;
    })
    .sort((left, right) => left.profile_id.localeCompare(right.profile_id));
  if (candidates.length === 0) return block('nenhum profile candidato foi fornecido', 'input.candidates');

  const requirement = requiredTierOf(unit);
  const considered: CandidateConsideration[] = [];
  const eligible: Array<{
    candidate: RoutingCandidate;
    capability: ProfileCapability;
    tier: CapabilityTier;
  }> = [];

  for (const candidate of candidates) {
    const capability = input.capability_registry.get(candidate.profile_id);
    if (!candidate.availability.value || capability === undefined) {
      considered.push(
        rejected(
          candidate,
          capability === undefined ? null : capabilityTierOf(capability),
          'PROFILE_UNAVAILABLE',
          capability === undefined
            ? 'profile ausente do CapabilityRegistry'
            : `profile indisponível: ${candidate.availability.provenance}`,
        ),
      );
      continue;
    }
    if (capability.billing_mode === 'api') {
      considered.push(rejected(candidate, capabilityTierOf(capability), 'API_BILLING_REQUIRES_EXPLICIT_SELECTION', 'profile billing_mode=api nunca é escolhido implicitamente'));
      continue;
    }
    const compatibility = roleCompatibility(capability, role);
    if (compatibility.value !== true) {
      considered.push(
        rejected(
          candidate,
          capabilityTierOf(capability),
          'ROLE_INCOMPATIBLE',
          `role=${role} incompatível ou indeterminável: ${compatibility.provenance}`,
        ),
      );
      continue;
    }
    const tier = capabilityTierOf(capability);
    if (tier === null) {
      considered.push(rejected(candidate, null, 'CAPABILITY_UNCLASSIFIED', `model/effort sem tier conhecido: ${capability.model}/${capability.reasoning_effort}`));
      continue;
    }
    if (TIER_ORDER[tier] < TIER_ORDER[requirement.tier]) {
      considered.push(rejected(candidate, tier, 'CAPABILITY_INSUFFICIENT', `tier=${tier} abaixo do requerido=${requirement.tier} (score=${requirement.score})`));
      continue;
    }
    eligible.push({ candidate, capability, tier });
  }

  eligible.sort((left, right) => {
    const tierDifference = TIER_ORDER[left.tier] - TIER_ORDER[right.tier];
    if (tierDifference !== 0) return tierDifference;
    const [leftModelCost, leftEffortCost] = capabilityCostOf(left.capability);
    const [rightModelCost, rightEffortCost] = capabilityCostOf(right.capability);
    if (leftModelCost !== rightModelCost) return leftModelCost - rightModelCost;
    if (leftEffortCost !== rightEffortCost) return leftEffortCost - rightEffortCost;
    return left.candidate.profile_id.localeCompare(right.candidate.profile_id);
  });

  const violations: BudgetViolation[] = [];
  for (const entry of eligible) {
    const budget = budgetFor(unit, entry.capability, entry.tier, entry.candidate.runtime_bounds);
    if (budget === null) {
      return block('worker runtime budget não é representável como inteiro seguro; requer replan', 'worker_runtime_budget.arithmetic', considered);
    }
    const violatedBounds = entry.candidate.runtime_bounds.filter(
      (bound) => budget.milliseconds > bound.maximum_ms,
    );
    if (violatedBounds.length > 0) {
      for (const violatedBound of violatedBounds) {
        violations.push({
          profile_id: entry.candidate.profile_id,
          requested_budget_ms: budget.milliseconds,
          violated_bound: violatedBound,
          provenance: [...budget.provenance, violatedBound.provenance],
        });
      }
      considered.push(
        rejected(
          entry.candidate,
          entry.tier,
          'BUDGET_UNSUPPORTED',
          `budget solicitado=${budget.milliseconds}ms excede ${violatedBounds.map((bound) => `${bound.source}=${bound.maximum_ms}ms`).join(', ')}; valor não foi truncado`,
          budget.milliseconds,
        ),
      );
      continue;
    }

    considered.push({
      profile_id: entry.candidate.profile_id,
      capability_tier: entry.tier,
      requested_worker_runtime_budget_ms: budget.milliseconds,
      outcome: 'SELECTED',
      rejection_code: null,
      reason: `menor tier adequado (${entry.tier}) com todos os WORKER_RUNTIME_BOUND satisfeitos`,
    });
    for (const alternative of eligible) {
      if (
        alternative.candidate.profile_id === entry.candidate.profile_id ||
        considered.some((item) => item.profile_id === alternative.candidate.profile_id)
      ) {
        continue;
      }
      considered.push({
        profile_id: alternative.candidate.profile_id,
        capability_tier: alternative.tier,
        requested_worker_runtime_budget_ms: null,
        outcome: 'NOT_SELECTED',
        rejection_code: null,
        reason: `alternativa elegível de custo igual ou maior que o profile selecionado ${entry.candidate.profile_id}`,
      });
    }
    return RoutingDecision.parse({
      outcome: 'ROUTED',
      profile: entry.capability,
      worker_runtime_budget: budget,
      rationale: [
        `tier requerido=${requirement.tier} por score=${requirement.score}: ${requirement.reasons.join('; ')}`,
        `profile ${entry.candidate.profile_id} é o menor recurso elegível com capacidade suficiente`,
        'worker runtime budget validado somente contra bounds de runtime do launcher/profile',
      ],
      provenance: [
        'work_unit.task.taxonomy',
        'work_unit.assessment',
        'work_unit.project_facts',
        'CapabilityRegistry',
        'input.candidates.availability,input.candidates.runtime_bounds',
      ],
      candidates_considered: considered,
    });
  }

  if (violations.length > 0) {
    return BudgetUnsupported.parse({
      outcome: 'BUDGET_UNSUPPORTED',
      violations,
      candidates_considered: considered,
      allowed_next_steps: ['TRY_ANOTHER_PROFILE', 'RECONFIGURE_RUNTIME', 'REPLAN', 'HUMAN_REQUIRED'],
      rationale: ['nenhum profile de capacidade adequada suporta o worker runtime budget solicitado sem violar bound estrutural'],
      provenance: ['worker_runtime_budget', 'input.candidates.runtime_bounds'],
    });
  }
  return block(
    `nenhum profile disponível, compatível e com tier >= ${requirement.tier}; budget maior não substitui decomposição ou capacidade`,
    'CapabilityRegistry,input.candidates,work_unit.assessment',
    considered,
  );
}
