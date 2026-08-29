/**
 * Avaliação DETERMINÍSTICA e rule-based de execução de uma `PlannedTask` (M76).
 *
 * Deriva, a partir do `PlannedTask` (M73) mais fatos observados por um
 * `ProjectInspection` (M72) — completo ou reduzido ao minimal factual
 * preflight do caminho DIRECT (M75) —, sete dimensões, cada uma com
 * `rationale` e `provenance`: `difficulty`, `risk`, `context_pressure`,
 * `environment_readiness`, `verification_strength`, `review_requirement` e
 * `confidence`. Nenhuma dessas dimensões chama um provider real, lê histórico
 * de performance (M82), escolhe profile (M78) ou orça runtime (M78) — tudo
 * isso é fora de escopo aqui.
 *
 * `PlannedTask` de entrada nunca é mutado: `assessExecution` só lê.
 *
 * Environment readiness separa ABSENCE/TO-BE-CREATED de CONCRETE BLOCKER. Um
 * projeto greenfield — sem package.json, sem lockfile, sem build, sem testes,
 * sem dependências instaladas, sem instruções de projeto — é executável: a
 * primeira work unit existe justamente para criar isso, e bloquear ali
 * impediria o bootstrap. Essas ausências são `'satisfied'`, com a razão
 * registrada.
 *
 * Continuam impedindo: repositório inacessível ou estado de git desconhecido,
 * `head_sha` divergente da base revision esperada, e filesystem sem permissão
 * adequada ou não observado. Fato ausente NESSAS dimensões continua sendo
 * `'unknown'`, que nunca é `READY` — nunca `'satisfied'` por omissão. Um
 * ambiente `NOT_READY` ou `UNKNOWN` é sempre classificado como problema de
 * ambiente — nunca eleva `difficulty`, `risk` nem qualquer outra dimensão;
 * ele só reduz `confidence` e é reportado em `environment_readiness` para
 * quem decide effort/model (fora deste módulo).
 *
 * Review requirement expressa DUAS dimensões independentes:
 * `independent_review_required` — PROPORCIONAL: exigido só quando há razão
 * concreta (risco alto/crítico, evidência de verificação fraca ou confiança
 * baixa), nunca por default — e `diversity_requirement` (diversidade de profile/model/provider
 * — PROPORCIONAL ao risco: `not_required` em risco baixo/médio, `preferred`
 * em risco alto, `required` em risco crítico). Diversidade nunca é condição
 * universal de independência — risco baixo/médio pode ter revisão
 * independente com o MESMO profile, desde que invocação e contexto sejam
 * independentes (isso é responsabilidade de quem executa a revisão, não
 * verificado aqui).
 *
 * O resultado combina depois, em outro módulo, com o veredito de plano de M75
 * pelo critério mais restritivo — não é feito aqui.
 */

import { z } from 'zod';

import { PlannedTask, TaskRisk } from './task.js';
import { ProjectInspection } from '../inspection/index.js';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');

// ---------------------------------------------------------------------------
// Bloco comum: um valor derivado sempre vem com rationale e provenance.
// ---------------------------------------------------------------------------

function assessedSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z
    .object({
      value: valueSchema,
      rationale: nonEmpty,
      provenance: nonEmpty,
    })
    .strict();
}

interface Assessed<T> {
  readonly value: T;
  readonly rationale: string;
  readonly provenance: string;
}

function assessed<T>(value: T, rationale: string, provenance: string): Assessed<T> {
  return { value, rationale, provenance };
}

// ---------------------------------------------------------------------------
// Difficulty — base declarada em taxonomy, escalada só por sinal estrutural
// concreto já presente em `task`, nunca por ausência de fato.
// ---------------------------------------------------------------------------

export const DifficultyLevel = z.enum(['trivial', 'easy', 'medium', 'hard']);
export type DifficultyLevel = z.infer<typeof DifficultyLevel>;

const DIFFICULTY_ORDER: readonly DifficultyLevel[] = ['trivial', 'easy', 'medium', 'hard'];

function escalateDifficulty(level: DifficultyLevel): DifficultyLevel {
  const index = DIFFICULTY_ORDER.indexOf(level);
  return DIFFICULTY_ORDER[Math.min(index + 1, DIFFICULTY_ORDER.length - 1)] as DifficultyLevel;
}

function assessDifficulty(task: PlannedTask): Assessed<DifficultyLevel> {
  const declared = task.taxonomy.difficulty_declared;
  const escalationReasons: string[] = [];

  if (task.taxonomy.complexity === 'cross_cutting' || task.taxonomy.complexity === 'subsystem') {
    escalationReasons.push(`taxonomy.complexity=${task.taxonomy.complexity}`);
  }
  if (task.taxonomy.ambiguity === 'high') {
    escalationReasons.push('taxonomy.ambiguity=high');
  }
  if (task.taxonomy.verification === 'subjective') {
    escalationReasons.push('taxonomy.verification=subjective');
  }

  if (escalationReasons.length === 0) {
    return assessed(
      declared,
      `dificuldade declarada (${declared}) mantida — nenhum sinal estrutural de escalada presente`,
      'taxonomy.difficulty_declared',
    );
  }

  const escalated = escalateDifficulty(declared);
  return assessed(
    escalated,
    `dificuldade declarada (${declared}) escalada para ${escalated} por: ${escalationReasons.join(', ')}`,
    `taxonomy.difficulty_declared,${escalationReasons.map((reason) => reason.split('=')[0]).join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// Risk — sempre o risco declarado em `PlannedTask.risk`, verbatim. Ambiente
// inadequado NUNCA eleva risco (ver nota de módulo); esta dimensão só ecoa,
// com rationale e provenance, o que já foi declarado no planejamento.
// ---------------------------------------------------------------------------

function assessRisk(task: PlannedTask): Assessed<TaskRisk> {
  return assessed(task.risk, `risco declarado em PlannedTask.risk: ${task.risk}`, 'task.risk');
}

// ---------------------------------------------------------------------------
// Context pressure — breadth de contexto e pressão de tokens já declaradas.
// ---------------------------------------------------------------------------

export const ContextPressureLevel = z.enum(['low', 'medium', 'high']);
export type ContextPressureLevel = z.infer<typeof ContextPressureLevel>;

const CONTEXT_PRESSURE_HIGH_AREAS = 3;
const CONTEXT_PRESSURE_MEDIUM_AREAS = 1;
const CONTEXT_PRESSURE_HIGH_TOKENS = 100_000;
const CONTEXT_PRESSURE_MEDIUM_TOKENS = 30_000;

function assessContextPressure(task: PlannedTask): Assessed<ContextPressureLevel> {
  const areas = task.context_scope.areas.length;
  const tokens = task.resource_envelope.tokens.expected;

  if (areas > CONTEXT_PRESSURE_HIGH_AREAS || tokens > CONTEXT_PRESSURE_HIGH_TOKENS) {
    return assessed(
      'high',
      `context_scope.areas=${areas} (limite ${CONTEXT_PRESSURE_HIGH_AREAS}) ou resource_envelope.tokens.expected=${tokens} (limite ${CONTEXT_PRESSURE_HIGH_TOKENS})`,
      'context_scope.areas,resource_envelope.tokens.expected',
    );
  }
  if (areas > CONTEXT_PRESSURE_MEDIUM_AREAS || tokens > CONTEXT_PRESSURE_MEDIUM_TOKENS) {
    return assessed(
      'medium',
      `context_scope.areas=${areas} (limite ${CONTEXT_PRESSURE_MEDIUM_AREAS}) ou resource_envelope.tokens.expected=${tokens} (limite ${CONTEXT_PRESSURE_MEDIUM_TOKENS})`,
      'context_scope.areas,resource_envelope.tokens.expected',
    );
  }
  return assessed(
    'low',
    `context_scope.areas=${areas} e resource_envelope.tokens.expected=${tokens} dentro dos limiares de baixa pressão`,
    'context_scope.areas,resource_envelope.tokens.expected',
  );
}

// ---------------------------------------------------------------------------
// Environment readiness — compara os environment requirements da task com os
// fatos observados. UNKNOWN nunca é READY. Fato ausente nunca é otimista.
// ---------------------------------------------------------------------------

export const EnvironmentReadinessRequirement = z.enum([
  'repository_accessible',
  'base_revision_valid',
  'git_state_known',
  'dependencies_state_known',
  'build_command_known',
  'tests_known',
  'validation_available',
  'required_tools_and_services_identified',
  'instructions_discoverable',
  'environment_constraints_known',
  'filesystem_permissions_adequate',
]);
export type EnvironmentReadinessRequirement = z.infer<typeof EnvironmentReadinessRequirement>;

export const ENVIRONMENT_READINESS_REQUIREMENTS: readonly EnvironmentReadinessRequirement[] =
  EnvironmentReadinessRequirement.options;

export const EnvironmentReadinessCheckStatus = z.enum(['satisfied', 'not_satisfied', 'unknown']);
export type EnvironmentReadinessCheckStatus = z.infer<typeof EnvironmentReadinessCheckStatus>;

export const EnvironmentReadinessCheck = z
  .object({
    requirement: EnvironmentReadinessRequirement,
    status: EnvironmentReadinessCheckStatus,
    reason: nonEmpty,
    provenance: nonEmpty,
  })
  .strict();
export type EnvironmentReadinessCheck = z.infer<typeof EnvironmentReadinessCheck>;

export const EnvironmentReadinessStatus = z.enum(['READY', 'NOT_READY', 'UNKNOWN']);
export type EnvironmentReadinessStatus = z.infer<typeof EnvironmentReadinessStatus>;

export const ReadinessFactsSource = z.enum(['full_inspection', 'minimal_preflight', 'none']);
export type ReadinessFactsSource = z.infer<typeof ReadinessFactsSource>;

export const EnvironmentReadinessAssessment = z
  .object({
    status: EnvironmentReadinessStatus,
    checks: z.array(EnvironmentReadinessCheck).length(ENVIRONMENT_READINESS_REQUIREMENTS.length),
    facts_source: ReadinessFactsSource,
    rationale: nonEmpty,
    provenance: nonEmpty,
  })
  .strict();
export type EnvironmentReadinessAssessment = z.infer<typeof EnvironmentReadinessAssessment>;

function check(
  requirement: EnvironmentReadinessRequirement,
  status: EnvironmentReadinessCheckStatus,
  reason: string,
  provenance: string,
): EnvironmentReadinessCheck {
  return { requirement, status, reason, provenance };
}

/**
 * Compara os `environment_requirements` PLANEJADOS da task (M73) com os
 * fatos observados pela inspeção (M72). Cada checagem é 1:1 com um dos onze
 * fatos de readiness listados no objetivo. `inspection` ausente (nenhuma
 * inspeção completa nem minimal preflight disponível) faz todo o bloco cair
 * em `unknown` — nunca `satisfied` por omissão.
 */
function assessEnvironmentReadinessChecks(
  inspection: ProjectInspection | undefined,
  expectedBaseRevisionSha: string | undefined,
): EnvironmentReadinessCheck[] {
  if (inspection === undefined) {
    return ENVIRONMENT_READINESS_REQUIREMENTS.map((requirement) =>
      check(requirement, 'unknown', 'nenhuma ProjectInspection nem minimal factual preflight fornecidos', 'none'),
    );
  }

  const checks: EnvironmentReadinessCheck[] = [];

  checks.push(
    inspection.git.known
      ? check('repository_accessible', 'satisfied', 'repositório git legível (rev-parse/status observados)', 'inspection.git')
      : check(
          'repository_accessible',
          'unknown',
          `fato de git ausente: ${inspection.git.known === false ? inspection.git.reason : 'desconhecido'}`,
          'inspection.git',
        ),
  );

  if (expectedBaseRevisionSha === undefined) {
    checks.push(
      check('base_revision_valid', 'unknown', 'nenhuma base revision esperada foi declarada ao assessment', 'context.expectedBaseRevisionSha'),
    );
  } else if (!inspection.git.known) {
    checks.push(check('base_revision_valid', 'unknown', 'head_sha observado é desconhecido — não é possível comparar com a base revision esperada', 'inspection.git'));
  } else if (inspection.git.value.head_sha === expectedBaseRevisionSha) {
    checks.push(check('base_revision_valid', 'satisfied', 'head_sha observado coincide com a base revision esperada', 'inspection.git.value.head_sha'));
  } else {
    checks.push(
      check(
        'base_revision_valid',
        'not_satisfied',
        `head_sha observado (${inspection.git.value.head_sha}) diverge da base revision esperada (${expectedBaseRevisionSha})`,
        'inspection.git.value.head_sha',
      ),
    );
  }

  checks.push(
    inspection.git.known
      ? check('git_state_known', 'satisfied', 'branch e working tree (dirty/remotes) observados', 'inspection.git')
      : check('git_state_known', 'unknown', 'estado de git não observado', 'inspection.git'),
  );

  if (!inspection.dependencies_state.known) {
    checks.push(
      check(
        'dependencies_state_known',
        'satisfied',
        'nenhum lockfile observado — projeto greenfield ou pré-bootstrap; a própria work unit pode declarar as dependências',
        'inspection.dependencies_state',
      ),
    );
  } else if (inspection.dependencies_state.value.installed) {
    checks.push(check('dependencies_state_known', 'satisfied', 'dependências declaradas e instaladas', 'inspection.dependencies_state.value.installed'));
  } else {
    checks.push(
      check(
        'dependencies_state_known',
        'satisfied',
        'dependências declaradas e ainda não instaladas — instalação autorizada é trabalho do worker, não blocker de ambiente',
        'inspection.dependencies_state.value.installed',
      ),
    );
  }

  checks.push(
    inspection.build_system.known
      ? check('build_command_known', 'satisfied', `build system observado: ${inspection.build_system.value}`, 'inspection.build_system')
      : check(
          'build_command_known',
          'satisfied',
          'nenhum build system observado — ausência a ser criada pelo bootstrap, não impedimento concreto de execução',
          'inspection.build_system',
        ),
  );

  checks.push(
    inspection.tests.known
      ? check('tests_known', 'satisfied', 'diretórios ou framework de teste observados', 'inspection.tests')
      : check(
          'tests_known',
          'satisfied',
          'nenhum teste observado — ausência a ser criada pela work unit, não impedimento concreto de execução',
          'inspection.tests',
        ),
  );

  checks.push(
    inspection.validation_command_candidates.length > 0
      ? check(
          'validation_available',
          'satisfied',
          `${inspection.validation_command_candidates.length} candidato(s) de validation observado(s)`,
          'inspection.validation_command_candidates',
        )
      : check(
          'validation_available',
          'satisfied',
          'nenhum candidato de validation observado ainda — a validation declarada pela task pode passar a existir depois do bootstrap; a validação oficial continua sendo executada pelo orquestrador',
          'inspection.validation_command_candidates',
        ),
  );

  checks.push(
    check(
      'required_tools_and_services_identified',
      'satisfied',
      `${inspection.required_tools.length} ferramenta(s) e ${inspection.required_services.length} serviço(s) local(is) identificados (lista pode ser vazia)`,
      'inspection.required_tools,inspection.required_services',
    ),
  );

  checks.push(
    inspection.project_instructions.length > 0
      ? check('instructions_discoverable', 'satisfied', `${inspection.project_instructions.length} instrução(ões) de projeto descobertas`, 'inspection.project_instructions')
      : check(
          'instructions_discoverable',
          'satisfied',
          'nenhuma instrução de projeto descoberta (AGENTS.md/CLAUDE.md/README.md/CONTRIBUTING.md ausentes) — ausência, não impedimento',
          'inspection.project_instructions',
        ),
  );

  checks.push(
    check(
      'environment_constraints_known',
      'satisfied',
      `${inspection.risks.length} risco(s)/constraint(s) de ambiente observados a partir da inspeção (lista pode ser vazia)`,
      'inspection.risks',
    ),
  );

  if (!inspection.filesystem_permissions.known) {
    checks.push(check('filesystem_permissions_adequate', 'unknown', 'permissões de filesystem não observadas', 'inspection.filesystem_permissions'));
  } else if (inspection.filesystem_permissions.value.readable && inspection.filesystem_permissions.value.writable) {
    checks.push(check('filesystem_permissions_adequate', 'satisfied', 'repositório legível e gravável', 'inspection.filesystem_permissions.value'));
  } else {
    checks.push(
      check(
        'filesystem_permissions_adequate',
        'not_satisfied',
        `permissões inadequadas: readable=${inspection.filesystem_permissions.value.readable}, writable=${inspection.filesystem_permissions.value.writable}`,
        'inspection.filesystem_permissions.value',
      ),
    );
  }

  return checks;
}

/**
 * `NOT_READY` vence quando ao menos uma checagem observou um problema
 * concreto; senão `UNKNOWN` vence quando ao menos uma checagem não pôde ser
 * confirmada; `READY` só quando TODAS as checagens são `satisfied`. UNKNOWN
 * nunca é READY.
 */
function combineReadinessStatus(checks: readonly EnvironmentReadinessCheck[]): EnvironmentReadinessStatus {
  if (checks.some((entry) => entry.status === 'not_satisfied')) return 'NOT_READY';
  if (checks.some((entry) => entry.status === 'unknown')) return 'UNKNOWN';
  return 'READY';
}

function assessEnvironmentReadiness(
  inspection: ProjectInspection | undefined,
  expectedBaseRevisionSha: string | undefined,
  factsSource: ReadinessFactsSource,
): EnvironmentReadinessAssessment {
  const checks = assessEnvironmentReadinessChecks(inspection, expectedBaseRevisionSha);
  const status = combineReadinessStatus(checks);

  const notSatisfied = checks.filter((entry) => entry.status === 'not_satisfied').map((entry) => entry.requirement);
  const unknownChecks = checks.filter((entry) => entry.status === 'unknown').map((entry) => entry.requirement);

  const rationale =
    status === 'READY'
      ? 'todos os fatos de readiness observados e satisfeitos'
      : status === 'NOT_READY'
        ? `problema de ambiente observado em: ${notSatisfied.join(', ')}`
        : `fato(s) de readiness desconhecido(s), nunca tratado(s) como satisfeito: ${unknownChecks.join(', ')}`;

  return {
    status,
    checks,
    facts_source: factsSource,
    rationale,
    provenance: inspection === undefined ? 'none' : `inspection:${factsSource}`,
  };
}

// ---------------------------------------------------------------------------
// Verification strength — força da evidência declarada/observável de que a
// task pode ser validada objetivamente.
// ---------------------------------------------------------------------------

export const VerificationStrengthLevel = z.enum(['weak', 'partial', 'strong']);
export type VerificationStrengthLevel = z.infer<typeof VerificationStrengthLevel>;

/**
 * `validationCandidatesObserved` é o fato CRU da inspeção, não o status do
 * check de readiness: readiness deixou de tratar a ausência de candidatos
 * como impedimento (greenfield), mas a força da evidência continua sendo
 * medida pelo que foi realmente observado — liberalizar o gate não pode
 * inflar a evidência.
 */
function assessVerificationStrength(
  task: PlannedTask,
  validationCandidatesObserved: boolean,
): Assessed<VerificationStrengthLevel> {
  if (task.taxonomy.verification === 'subjective') {
    return assessed('weak', 'taxonomy.verification=subjective: PASS/FAIL não é objetivamente determinável', 'taxonomy.verification');
  }
  if (task.validation.length === 0) {
    return assessed('weak', 'PlannedTask.validation está vazio: nenhum comando de validação declarado', 'task.validation');
  }
  if (task.taxonomy.verification === 'deterministic' && validationCandidatesObserved) {
    return assessed(
      'strong',
      'taxonomy.verification=deterministic, validation declarado e candidatos de validation observados no ambiente',
      'taxonomy.verification,task.validation,environment_readiness.validation_available',
    );
  }
  if (task.taxonomy.verification === undefined) {
    return assessed('partial', 'taxonomy.verification não declarado — evidência de verificação não confirmada, nunca tratada como forte por omissão', 'taxonomy.verification');
  }
  return assessed(
    'partial',
    `taxonomy.verification=${task.taxonomy.verification} ou nenhum candidato de validation observado no ambiente (observed=${validationCandidatesObserved})`,
    'taxonomy.verification,inspection.validation_command_candidates',
  );
}

// ---------------------------------------------------------------------------
// Confidence — combina fatos ausentes de taxonomy e de environment readiness.
// Fato ausente reduz confiança; nunca aumenta.
// ---------------------------------------------------------------------------

export const ConfidenceLevel = z.enum(['low', 'medium', 'high']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

function assessConfidence(
  task: PlannedTask,
  environmentReadiness: EnvironmentReadinessAssessment,
): Assessed<ConfidenceLevel> {
  const missingTaxonomyFields = (['complexity', 'ambiguity', 'verification'] as const).filter(
    (field) => task.taxonomy[field] === undefined,
  );
  const unknownReadinessChecks = environmentReadiness.checks.filter((entry) => entry.status === 'unknown');

  let score = 2;
  if (environmentReadiness.facts_source === 'none') {
    score -= 2;
  } else if (unknownReadinessChecks.length > 0) {
    score -= 1;
  }
  if (environmentReadiness.status === 'NOT_READY') {
    score -= 1;
  }
  if (missingTaxonomyFields.length > 0) {
    score -= 1;
  }
  score = Math.max(0, Math.min(2, score));

  const level = (['low', 'medium', 'high'] as const)[score] as ConfidenceLevel;
  const reasons: string[] = [];
  if (environmentReadiness.facts_source === 'none') reasons.push('nenhum fato de ambiente disponível');
  if (unknownReadinessChecks.length > 0) reasons.push(`${unknownReadinessChecks.length} fato(s) de readiness desconhecido(s)`);
  if (environmentReadiness.status === 'NOT_READY') reasons.push('ambiente classificado como NOT_READY');
  if (missingTaxonomyFields.length > 0) reasons.push(`taxonomy incompleta (${missingTaxonomyFields.join(', ')} ausente(s))`);

  return assessed(
    level,
    reasons.length === 0
      ? 'todos os fatos relevantes de taxonomy e environment readiness estão presentes'
      : `confiança reduzida por: ${reasons.join('; ')}`,
    'taxonomy.complexity,taxonomy.ambiguity,taxonomy.verification,environment_readiness',
  );
}

// ---------------------------------------------------------------------------
// Review requirement — independência de revisão e diversidade PROPORCIONAL
// ao risco, como duas dimensões separadas.
// ---------------------------------------------------------------------------

export const DiversityRequirement = z.enum(['not_required', 'preferred', 'required']);
export type DiversityRequirement = z.infer<typeof DiversityRequirement>;

export const ReviewRequirementAssessment = z
  .object({
    independent_review_required: z.boolean(),
    diversity_requirement: DiversityRequirement,
    rationale: nonEmpty,
    provenance: nonEmpty,
  })
  .strict();
export type ReviewRequirementAssessment = z.infer<typeof ReviewRequirementAssessment>;

/**
 * Review independente é PROPORCIONAL, não default. Um segundo LLM por work
 * unit custa tempo e dinheiro reais: ele precisa ser justificado por um risco
 * concreto, não pelo fato de a task não ser trivial.
 *
 * Exige reviewer quando, e somente quando, houver uma razão concreta:
 * - `risk` high ou critical (risco de execução; security-sensitive é
 *   categoria de autorização distinta, não derivada deste label);
 * - `verification_strength` weak — validação ausente ou subjetiva, isto é,
 *   PASS/FAIL não é objetivamente determinável;
 * - `confidence` low — os fatos que sustentam a avaliação estão faltando.
 *
 * Risco baixo/médio com validação oficial forte ou razoável (partial) e
 * confiança não-baixa NÃO exige reviewer: a validação oficial do orquestrador
 * já é a evidência. Repair significativo, escalation e evidência inconsistente
 * são conhecidos só pelo lifecycle e entram lá, sobre este resultado.
 */
function assessReviewRequirement(
  risk: TaskRisk,
  verificationStrength: VerificationStrengthLevel,
  confidence: ConfidenceLevel,
): ReviewRequirementAssessment {
  const concreteReasons: string[] = [];
  if (risk === 'high' || risk === 'critical') concreteReasons.push(`risk=${risk}`);
  if (verificationStrength === 'weak') concreteReasons.push('verification_strength=weak');
  if (confidence === 'low') concreteReasons.push('confidence=low');
  const independentReviewRequired = concreteReasons.length > 0;

  const diversityRequirement: DiversityRequirement =
    risk === 'critical' ? 'required' : risk === 'high' ? 'preferred' : 'not_required';

  const rationale = independentReviewRequired
    ? `revisão independente com contexto fresco exigida por razão concreta de risco: ${concreteReasons.join(', ')}`
    : `nenhuma razão concreta de risco (risk=${risk}, verification_strength=${verificationStrength}, confidence=${confidence}) — a validação oficial do orquestrador é a evidência; reviewer independente não é exigido`;

  return {
    independent_review_required: independentReviewRequired,
    diversity_requirement: diversityRequirement,
    rationale: `${rationale}. Diversidade de profile/model/provider é PROPORCIONAL ao risco (${diversityRequirement}) — não é condição universal de independência: em risco baixo/médio o mesmo profile pode revisar, desde que invocação e contexto sejam independentes.`,
    provenance: 'task.risk,verification_strength,confidence',
  };
}

// ---------------------------------------------------------------------------
// Entrada pública.
// ---------------------------------------------------------------------------

export const ExecutionAssessment = z
  .object({
    task_id: identifier,
    difficulty: assessedSchema(DifficultyLevel),
    risk: assessedSchema(TaskRisk),
    context_pressure: assessedSchema(ContextPressureLevel),
    environment_readiness: EnvironmentReadinessAssessment,
    verification_strength: assessedSchema(VerificationStrengthLevel),
    review_requirement: ReviewRequirementAssessment,
    confidence: assessedSchema(ConfidenceLevel),
  })
  .strict();
export type ExecutionAssessment = z.infer<typeof ExecutionAssessment>;

export interface ExecutionAssessmentContext {
  /**
   * `ProjectInspection` já coletada — completa ou reduzida ao minimal
   * factual preflight do caminho DIRECT (M75). A origem entra em
   * `environment_readiness.facts_source`.
   */
  readonly inspection?: ProjectInspection;
  /** Quando fornecida, compara com `inspection.git.value.head_sha` observado. */
  readonly expectedBaseRevisionSha?: string;
  /** Proveniência declarada de `inspection`; default `'full_inspection'` quando `inspection` está presente. */
  readonly factsSource?: Exclude<ReadinessFactsSource, 'none'>;
}

/**
 * Avalia execução de `task` de forma pura e determinística: mesma entrada
 * produz sempre o mesmo `ExecutionAssessment`. Não lê histórico de
 * performance, não escolhe profile, não orça runtime, não chama provider —
 * só compõe fatos já declarados em `task` e em `context.inspection`. `task`
 * nunca é mutado.
 */
export function assessExecution(task: PlannedTask, context: ExecutionAssessmentContext = {}): ExecutionAssessment {
  const factsSource: ReadinessFactsSource =
    context.inspection === undefined ? 'none' : (context.factsSource ?? 'full_inspection');

  const environmentReadiness = assessEnvironmentReadiness(context.inspection, context.expectedBaseRevisionSha, factsSource);
  const validationCandidatesObserved =
    (context.inspection?.validation_command_candidates.length ?? 0) > 0;

  const difficulty = assessDifficulty(task);
  const risk = assessRisk(task);
  const contextPressure = assessContextPressure(task);
  const verificationStrength = assessVerificationStrength(task, validationCandidatesObserved);
  const confidence = assessConfidence(task, environmentReadiness);
  const reviewRequirement = assessReviewRequirement(risk.value, verificationStrength.value, confidence.value);

  return {
    task_id: task.task_id,
    difficulty,
    risk,
    context_pressure: contextPressure,
    environment_readiness: environmentReadiness,
    verification_strength: verificationStrength,
    review_requirement: reviewRequirement,
    confidence,
  };
}
