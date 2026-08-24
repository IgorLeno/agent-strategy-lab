/**
 * Router inicial, puro e determinístico.
 *
 * A entrada é sempre uma work unit estruturada (`PlannedTask`), produzida pelo
 * planner completo ou pela Direct Task Normalization. O router não lê request
 * bruto, histórico, filesystem, provider ou relógio.
 *
 * TEMPO NÃO É AUTORIDADE AQUI.
 *
 * O router produz um `ExecutionRuntimeForecast`: uma HIPÓTESE sobre quanto a
 * execução deve demorar. Hipótese não é autorização. O forecast não impede
 * routing, não rejeita profile, não define deadline e não encerra worker —
 * nenhum profile é recusado porque a previsão ficou alta. O que decide qual
 * modelo e qual reasoning effort a work unit merece são as CARACTERÍSTICAS da
 * task (classe, dificuldade, complexidade, ambiguidade, risco, pressão de
 * contexto, força de verificação, stack) contra a capability disponível.
 *
 * Tempos permanecem deliberadamente separados:
 * - `estimated_duration` é estimativa ADVISORY da task;
 * - `validation[].timeout_seconds` limita cada comando de validação e é
 *   grandeza SEPARADA, com bound próprio, intocada por este módulo;
 * - `validation_budget` é o custo agregado esperado da validação OFICIAL, e só
 *   entra na previsão do worker quando é o worker que executa esse stage.
 *
 * Uma previsão pertence ao lifecycle stage que consome o tempo. Com
 * `official_validation_owner=orchestrator`, o processo do coding worker termina
 * no candidate e nunca roda a validação oficial: somar esse custo à previsão
 * dele apenas porque ambos são milissegundos descreveria trabalho que ele não
 * faz.
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

const Availability = z
  .object({
    value: z.boolean(),
    provenance: nonEmpty,
  })
  .strict();

/**
 * Fact operacional que não pertence a `ProfileCapability`: a disponibilidade
 * atual do profile.
 *
 * NÃO existe mais `runtime_bounds` aqui. Ele só existia para que a previsão de
 * duração pudesse rejeitar um profile — o gate que foi removido. Manter o
 * campo depois disso seria manter a entrada de uma decisão que não é mais
 * tomada, e o teto de segurança de máquina que sobrou é de outra grandeza:
 * ele é de infraestrutura, não entra em routing e não conhece profile.
 */
export const RoutingCandidate = z
  .object({
    profile_id: identifier,
    availability: Availability,
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
]);
export type CandidateRejectionCode = z.infer<typeof CandidateRejectionCode>;

export const CandidateConsideration = z
  .object({
    profile_id: identifier,
    capability_tier: CapabilityTier.nullable(),
    /** Previsão ADVISORY registrada para auditoria; nunca motivou rejeição. */
    predicted_runtime_ms: z.number().int().nonnegative().nullable(),
    outcome: z.enum(['SELECTED', 'REJECTED', 'NOT_SELECTED']),
    rejection_code: CandidateRejectionCode.nullable(),
    reason: nonEmpty,
  })
  .strict();
export type CandidateConsideration = z.infer<typeof CandidateConsideration>;

/**
 * `aggregate_validation_cost_ms` é OBSERVADO sempre (planejamento e
 * contabilidade da validation stage continuam precisando dele);
 * `worker_owned_validation_cost_ms` é a parcela dele efetivamente cobrada
 * deste worker — zero quando o stage é do orchestrator. Os dois campos juntos
 * tornam a inclusão ou exclusão legível sem consultar o código.
 */
const ForecastComponents = z
  .object({
    envelope_duration_expected_ms: z.number().int().nonnegative(),
    aggregate_validation_cost_ms: z.number().int().nonnegative(),
    worker_owned_validation_cost_ms: z.number().int().nonnegative(),
    capability_multiplier: z.number().positive(),
    task_class_multiplier: z.number().positive(),
    stack_multiplier: z.number().positive(),
    environment_multiplier: z.number().positive(),
  })
  .strict();

/**
 * PREVISÃO de runtime da execução. `authority: 'ADVISORY'` está no contrato, e
 * não só no comentário, porque é a propriedade que mais importa: quem lê este
 * objeto não pode usá-lo para negar nada. Ele existe para ser comparado depois
 * com o tempo OBSERVADO — erro de previsão é aprendizado, nunca veredito.
 */
export const ExecutionRuntimeForecast = z
  .object({
    kind: z.literal('EXECUTION_RUNTIME_FORECAST'),
    authority: z.literal('ADVISORY'),
    predicted_runtime_ms: z.number().int().nonnegative(),
    components: ForecastComponents,
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type ExecutionRuntimeForecast = z.infer<typeof ExecutionRuntimeForecast>;

export const RoutingDecision = z
  .object({
    outcome: z.literal('ROUTED'),
    profile: ProfileCapability,
    execution_runtime_forecast: ExecutionRuntimeForecast,
    rationale: z.array(nonEmpty).min(1),
    provenance: z.array(nonEmpty).min(1),
    candidates_considered: z.array(CandidateConsideration).min(1),
  })
  .strict();
export type RoutingDecision = z.infer<typeof RoutingDecision>;

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

/**
 * ÚNICA fonte de verdade sobre quem paga o custo da validação oficial: a
 * ownership já declarada pelo profile. Nada aqui olha profile_id, provider,
 * model, repositório ou task — um segundo sistema de ownership seria uma
 * autoridade concorrente com a execution policy.
 *
 * O worker é cobrado pelo custo agregado da validação oficial exatamente
 * quando ele é o dono desse stage E o executa por inteiro; `targeted` é
 * verificação parcial do próprio worker, não o stage oficial.
 */
function workerOwnsOfficialValidation(ownership: ProfileCapability['ownership']): boolean {
  return (
    ownership.official_validation_owner === 'worker' &&
    ownership.worker_validation_policy === 'full'
  );
}

/**
 * Stack desconhecida não bloqueia: um repositório greenfield ainda não tem
 * manifesto de ecossistema, e é exatamente a primeira work unit que vai criá-lo.
 * O multiplicador de stack só cresce com ecossistemas ADICIONAIS observados,
 * então a ausência de fato cai no multiplicador neutro (1) — nenhum default é
 * inventado sobre qual stack é.
 */
function forecastFor(
  unit: StructuredWorkUnit,
  capability: ProfileCapability,
  tier: CapabilityTier,
): ExecutionRuntimeForecast | null {
  const stack = unit.project_facts.stack;
  const stackMultiplier = stack.known
    ? 1 + Math.max(0, stack.value.ecosystems_detected.length - 1) * 0.1
    : 1;
  const environmentMultiplier =
    1 +
    unit.project_facts.required_services.length * 0.05 +
    unit.project_facts.required_tools.length * 0.02 +
    (capability.environment_mode === 'controlled' ? 0 : 0.05);
  const aggregateValidationCostMs = unit.task.validation_budget.expected;
  const validationOwnedByWorker = workerOwnsOfficialValidation(capability.ownership);
  const components = {
    envelope_duration_expected_ms: unit.task.resource_envelope.duration_ms.expected,
    aggregate_validation_cost_ms: aggregateValidationCostMs,
    worker_owned_validation_cost_ms: validationOwnedByWorker ? aggregateValidationCostMs : 0,
    capability_multiplier: capabilityMultiplier(tier),
    task_class_multiplier: taskClassMultiplier(unit.task.taxonomy.task_class),
    stack_multiplier: stackMultiplier,
    environment_multiplier: environmentMultiplier,
  };
  const unrounded =
    (components.envelope_duration_expected_ms + components.worker_owned_validation_cost_ms) *
    components.capability_multiplier *
    components.task_class_multiplier *
    components.stack_multiplier *
    components.environment_multiplier;
  const predicted = Math.ceil(unrounded / 1_000) * 1_000;
  if (!Number.isSafeInteger(predicted)) return null;

  return ExecutionRuntimeForecast.parse({
    kind: 'EXECUTION_RUNTIME_FORECAST',
    authority: 'ADVISORY',
    predicted_runtime_ms: predicted,
    components,
    provenance: [
      'task.resource_envelope.duration_ms.expected',
      validationOwnedByWorker
        ? `task.validation_budget.expected INCLUÍDO na previsão do worker: ProfileCapability.ownership.official_validation_owner=${capability.ownership.official_validation_owner} e worker_validation_policy=${capability.ownership.worker_validation_policy} — o próprio worker executa a validação oficial`
        : `task.validation_budget.expected OBSERVADO mas EXCLUÍDO da previsão do worker: ProfileCapability.ownership.official_validation_owner=${capability.ownership.official_validation_owner} e worker_validation_policy=${capability.ownership.worker_validation_policy} — a validação oficial é de outro lifecycle stage`,
      'selected ProfileCapability model/reasoning tier',
      'task.taxonomy.task_class',
      'project_facts.stack',
      'project_facts.required_tools,project_facts.required_services,profile.environment_mode',
      'ADVISORY: hipótese de duração; não autoriza, não rejeita e não encerra nada',
    ],
  });
}

function rejected(
  candidate: RoutingCandidate,
  tier: CapabilityTier | null,
  code: CandidateRejectionCode,
  reason: string,
  predictedRuntimeMs: number | null = null,
): CandidateConsideration {
  return {
    profile_id: candidate.profile_id,
    capability_tier: tier,
    predicted_runtime_ms: predictedRuntimeMs,
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
 * profile_id, nunca pela ordem de entrada.
 *
 * A previsão de duração NÃO participa desta escolha. Um forecast alto não
 * rejeita profile, não escala tier e não bloqueia a work unit: ele acompanha a
 * decisão como hipótese registrada. Capability insuficiente continua rejeitando
 * — é a capacidade que decide, não o relógio.
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

  for (const entry of eligible) {
    const forecast = forecastFor(unit, entry.capability, entry.tier);
    if (forecast === null) {
      // Não é recusa por tempo: é aritmética que estourou a representação, e
      // um número ilegível não pode entrar num record de evidência.
      return block(
        'previsão de runtime não é representável como inteiro seguro; requer replan',
        'execution_runtime_forecast.arithmetic',
        considered,
      );
    }

    considered.push({
      profile_id: entry.candidate.profile_id,
      capability_tier: entry.tier,
      predicted_runtime_ms: forecast.predicted_runtime_ms,
      outcome: 'SELECTED',
      rejection_code: null,
      reason: `menor tier adequado (${entry.tier}) para as características declaradas da work unit`,
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
        predicted_runtime_ms: null,
        outcome: 'NOT_SELECTED',
        rejection_code: null,
        reason: `alternativa elegível de custo igual ou maior que o profile selecionado ${entry.candidate.profile_id}`,
      });
    }
    return RoutingDecision.parse({
      outcome: 'ROUTED',
      profile: entry.capability,
      execution_runtime_forecast: forecast,
      rationale: [
        `tier requerido=${requirement.tier} por score=${requirement.score}: ${requirement.reasons.join('; ')}`,
        `profile ${entry.candidate.profile_id} é o menor recurso elegível com capacidade suficiente`,
        `previsão de runtime=${forecast.predicted_runtime_ms}ms é ADVISORY e não participou desta escolha`,
      ],
      provenance: [
        'work_unit.task.taxonomy',
        'work_unit.assessment',
        'work_unit.project_facts',
        'CapabilityRegistry',
        'input.candidates.availability',
      ],
      candidates_considered: considered,
    });
  }

  return block(
    `nenhum profile disponível, compatível e com tier >= ${requirement.tier}; mais tempo não substitui decomposição ou capacidade`,
    'CapabilityRegistry,input.candidates,work_unit.assessment',
    considered,
  );
}
