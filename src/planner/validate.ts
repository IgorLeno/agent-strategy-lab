/**
 * Validação determinística do PLANO COMPLETO (M75) mais a policy de workflow
 * proporcional que decide, por task, entre `DECOMPOSITION_REQUIRED`,
 * `MERGE_RECOMMENDED`, `DIRECT_ALLOWED` e `REVIEWED_REQUIRED`.
 *
 * Duas camadas, nunca fundidas:
 *
 * 1. `validatePlan` — validação estrutural PURA do plano inteiro (sem I/O):
 *    ciclo de dependências, dependência inexistente/auto-dependência, id
 *    duplicado, task malformada, acceptance/validation ausentes (via
 *    `PlannedTask`) e objetivos múltiplos não relacionados (componentes
 *    desconexos do grafo de dependências). Plano inválido é FAIL CLOSED:
 *    `evaluatePlan` nunca produz veredito de workflow para um plano que não
 *    passou aqui — não executável, não projetável. Nenhuma correção
 *    automática é aplicada.
 *
 * 2. `evaluatePlanWorkflow` — dado um plano JÁ VÁLIDO, decide o veredito de
 *    workflow por task. `DECOMPOSITION_REQUIRED` é sempre derivado de
 *    `evaluateDecomposition` (M74) — nenhum limiar de decomposição é
 *    reimplementado aqui. `DIRECT_ALLOWED` só é emitido quando TODOS os
 *    critérios objetivos declarados em `DirectAllowanceCriterion` estão
 *    satisfeitos E o minimal factual preflight está completo; qualquer
 *    critério não satisfeito OU desconhecido (campo opcional ausente) leva a
 *    `REVIEWED_REQUIRED` — fail safe, nunca otimista.
 *
 * Detecção de ciclo é reimplementada aqui (não em `dev/`) porque
 * `findDependencyCycle` do harness não é exportado e `src/` não pode
 * importar de `dev/` (fronteira de build). A semântica — DFS com pilha
 * `inProgress`, ignorando dependências que não existem no grafo (isso já
 * vira issue própria) — casa deliberadamente com a do harness.
 *
 * Este módulo também implementa a DIRECT TASK NORMALIZATION: a etapa
 * determinística que transforma `ProjectIntakeRequest` + `RequestedScope` +
 * fatos do `ProjectInspection` (minimal factual preflight) numa
 * `PlannedTask`, que só então é avaliada por `evaluatePlanWorkflow`. Nenhum
 * provider real é chamado; nada aqui faz raciocínio semântico de
 * planejamento — é composição determinística de fatos já conhecidos com
 * defaults de policy explícitos e documentados. Ver `normalizeDirectTask`.
 */

import { z } from 'zod';

import {
  ContextRequirement,
  EnvironmentRequirement,
  PlannedTask,
  ValidationCommand,
} from './task.js';
import { TaskBudget, TaskBudgets, TaskTaxonomy } from '../schemas/task-spec.js';
import { DecompositionVerdict, TriggeredSignal, evaluateDecomposition } from './decomposition.js';
import { ProjectIntakeRequest, RequestedScope } from '../intake/index.js';
import { ProjectInspection } from '../inspection/index.js';
import type { ValidationCommandCandidate } from '../inspection/index.js';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');

// ---------------------------------------------------------------------------
// Camada 1 — validação estrutural do plano inteiro.
// ---------------------------------------------------------------------------

export const PlanValidationIssueCode = z.enum([
  'malformed_task',
  'duplicate_task_id',
  'self_dependency',
  'unknown_dependency',
  'dependency_cycle',
  'task_schema_invalid',
  'multiple_objectives',
]);
export type PlanValidationIssueCode = z.infer<typeof PlanValidationIssueCode>;

export const PlanValidationIssue = z
  .object({
    code: PlanValidationIssueCode,
    message: nonEmpty,
    task_id: nonEmpty.nullable(),
    path: z.array(nonEmpty),
  })
  .strict();
export type PlanValidationIssue = z.infer<typeof PlanValidationIssue>;

export type PlanValidationResult =
  | { readonly valid: true; readonly tasks: readonly PlannedTask[] }
  | { readonly valid: false; readonly issues: readonly PlanValidationIssue[] };

const PlanShape = z
  .object({
    schema_version: z.literal(1),
    tasks: z.array(z.unknown()).min(1),
  })
  .strict();

/** Extração mínima de identidade — só o suficiente para checar o grafo de dependências. */
const TaskIdentityCandidate = z
  .object({
    task_id: identifier,
    blocked_by: z.array(identifier),
  })
  .passthrough();

interface TaskIdentity {
  readonly task_id: string;
  readonly blocked_by: readonly string[];
}

/**
 * Mesma semântica de `findDependencyCycle` do harness (`dev/lib/schemas.ts`):
 * DFS com pilha `inProgress`; dependências inexistentes no grafo são
 * ignoradas aqui porque já viram `unknown_dependency` em separado.
 */
function findPlanDependencyCycle(identities: readonly TaskIdentity[]): string[] | null {
  const byId = new Map(identities.map((identity) => [identity.task_id, identity]));
  const settled = new Set<string>();
  const inProgress: string[] = [];

  function visit(id: string): string[] | null {
    const position = inProgress.indexOf(id);
    if (position >= 0) return [...inProgress.slice(position), id];
    if (settled.has(id)) return null;

    inProgress.push(id);
    for (const dependency of byId.get(id)?.blocked_by ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    inProgress.pop();
    settled.add(id);
    return null;
  }

  for (const identity of identities) {
    const cycle = visit(identity.task_id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Componentes conexos do grafo de dependências, tratado como não-dirigido.
 * Mais de um componente entre duas ou mais tasks é o proxy estrutural para
 * "objetivos múltiplos não relacionados" empacotados no mesmo plano — nunca
 * inferido por leitura semântica de texto.
 */
function findDisconnectedGroups(identities: readonly TaskIdentity[]): string[][] {
  const knownIds = new Set(identities.map((identity) => identity.task_id));
  const adjacency = new Map<string, string[]>();
  for (const identity of identities) {
    if (!adjacency.has(identity.task_id)) adjacency.set(identity.task_id, []);
    for (const dependency of identity.blocked_by) {
      if (!knownIds.has(dependency)) continue;
      adjacency.get(identity.task_id)?.push(dependency);
      if (!adjacency.has(dependency)) adjacency.set(dependency, []);
      adjacency.get(dependency)?.push(identity.task_id);
    }
  }

  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const identity of identities) {
    if (visited.has(identity.task_id)) continue;
    const group: string[] = [];
    const stack = [identity.task_id];
    visited.add(identity.task_id);
    while (stack.length > 0) {
      const current = stack.pop() as string;
      group.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/**
 * Validação pura e determinística do plano inteiro. Sem I/O, sem correção
 * automática: um plano inválido apenas é recusado, com o motivo exato de
 * cada issue.
 */
export function validatePlan(input: unknown): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];

  const shape = PlanShape.safeParse(input);
  if (!shape.success) {
    for (const issue of shape.error.issues) {
      issues.push({
        code: 'task_schema_invalid',
        message: issue.message,
        task_id: null,
        path: issue.path.map(String),
      });
    }
    return { valid: false, issues };
  }

  const rawTasks = shape.data.tasks;

  const identityByIndex: Array<TaskIdentity | null> = rawTasks.map((raw, index) => {
    const parsed = TaskIdentityCandidate.safeParse(raw);
    if (!parsed.success) {
      issues.push({
        code: 'malformed_task',
        message: `tasks[${index}] não tem task_id/blocked_by válidos: ${parsed.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
        task_id: null,
        path: ['tasks', String(index)],
      });
      return null;
    }
    return { task_id: parsed.data.task_id, blocked_by: parsed.data.blocked_by };
  });

  const identities = identityByIndex.filter((identity): identity is TaskIdentity => identity !== null);

  const seenIds = new Set<string>();
  for (const identity of identities) {
    if (seenIds.has(identity.task_id)) {
      issues.push({
        code: 'duplicate_task_id',
        message: `id duplicado: ${identity.task_id}`,
        task_id: identity.task_id,
        path: ['tasks'],
      });
    }
    seenIds.add(identity.task_id);
  }

  for (const identity of identities) {
    for (const dependency of identity.blocked_by) {
      if (dependency === identity.task_id) {
        issues.push({
          code: 'self_dependency',
          message: `${identity.task_id} depende de si mesma`,
          task_id: identity.task_id,
          path: ['tasks', identity.task_id, 'blocked_by'],
        });
        continue;
      }
      if (!seenIds.has(dependency)) {
        issues.push({
          code: 'unknown_dependency',
          message: `${identity.task_id} depende de tarefa inexistente: ${dependency}`,
          task_id: identity.task_id,
          path: ['tasks', identity.task_id, 'blocked_by'],
        });
      }
    }
  }

  const cycle = findPlanDependencyCycle(identities);
  if (cycle) {
    issues.push({
      code: 'dependency_cycle',
      message: `ciclo de dependências no plano: ${cycle.join(' -> ')}`,
      task_id: cycle[0] ?? null,
      path: ['tasks'],
    });
  }

  if (identities.length > 1) {
    const groups = findDisconnectedGroups(identities);
    if (groups.length > 1) {
      const description = groups.map((group) => `[${group.join(', ')}]`).join(' ; ');
      issues.push({
        code: 'multiple_objectives',
        message: `plano contém ${groups.length} grupos de tasks sem relação de dependência entre si — possíveis objetivos múltiplos não relacionados: ${description}`,
        task_id: null,
        path: ['tasks'],
      });
    }
  }

  const parsedTasks: PlannedTask[] = [];
  rawTasks.forEach((raw, index) => {
    const parsed = PlannedTask.safeParse(raw);
    if (!parsed.success) {
      const taskId = identityByIndex[index]?.task_id ?? null;
      for (const issue of parsed.error.issues) {
        issues.push({
          code: 'task_schema_invalid',
          message: `${taskId ?? `tasks[${index}]`}: ${issue.path.join('.')} ${issue.message}`,
          task_id: taskId,
          path: ['tasks', String(index), ...issue.path.map(String)],
        });
      }
      return;
    }
    parsedTasks.push(parsed.data);
  });

  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return { valid: true, tasks: parsedTasks };
}

// ---------------------------------------------------------------------------
// Camada 2 — policy de workflow proporcional (plano já válido).
// ---------------------------------------------------------------------------

export const DirectAllowanceCriterion = z.enum([
  'narrow_context_scope',
  'low_risk',
  'low_ambiguity',
  'known_initial_scope',
  'bounded_context_scope',
  'no_open_architecture_decision',
  'not_security_sensitive',
  'no_external_side_effect',
  'no_wide_behavior_change',
  'deterministic_validation_known',
  'sufficient_source_of_truth',
]);
export type DirectAllowanceCriterion = z.infer<typeof DirectAllowanceCriterion>;

export const DirectAllowanceCriterionStatus = z.enum(['satisfied', 'not_satisfied', 'unknown']);
export type DirectAllowanceCriterionStatus = z.infer<typeof DirectAllowanceCriterionStatus>;

interface DirectAllowanceCriterionResult {
  readonly criterion: DirectAllowanceCriterion;
  readonly status: DirectAllowanceCriterionStatus;
}

/**
 * Cada critério mapeia para UM campo já declarado em `PlannedTask` — nenhum
 * critério depende de inferência textual. Campo opcional ausente sempre vira
 * `unknown`, nunca `satisfied` por omissão (fail safe).
 */
function evaluateDirectAllowanceCriteria(
  task: PlannedTask,
  decomposition: DecompositionVerdict,
): readonly DirectAllowanceCriterionResult[] {
  const results: DirectAllowanceCriterionResult[] = [];

  results.push({
    criterion: 'narrow_context_scope',
    status: task.context_scope.areas.length === 1 ? 'satisfied' : 'not_satisfied',
  });

  results.push({
    criterion: 'low_risk',
    status: task.risk === 'low' ? 'satisfied' : 'not_satisfied',
  });

  results.push({
    criterion: 'low_ambiguity',
    status:
      task.taxonomy.ambiguity === undefined
        ? 'unknown'
        : task.taxonomy.ambiguity === 'low'
          ? 'satisfied'
          : 'not_satisfied',
  });

  results.push({
    criterion: 'known_initial_scope',
    status: task.initial_files.length > 0 ? 'satisfied' : 'not_satisfied',
  });

  results.push({
    criterion: 'bounded_context_scope',
    status: decomposition.outcome === 'ATOMIC' ? 'satisfied' : 'not_satisfied',
  });

  results.push({
    criterion: 'no_open_architecture_decision',
    status:
      task.taxonomy.complexity === undefined
        ? 'unknown'
        : task.taxonomy.complexity === 'local'
          ? 'satisfied'
          : 'not_satisfied',
  });

  results.push({
    criterion: 'not_security_sensitive',
    status: task.risk === 'critical' ? 'not_satisfied' : 'satisfied',
  });

  results.push({
    criterion: 'no_external_side_effect',
    status: task.environment_requirements.some((requirement) => requirement.kind === 'service')
      ? 'not_satisfied'
      : 'satisfied',
  });

  results.push({
    criterion: 'no_wide_behavior_change',
    status:
      task.taxonomy.complexity === undefined
        ? 'unknown'
        : task.taxonomy.complexity === 'local' || task.taxonomy.complexity === 'multi_file'
          ? 'satisfied'
          : 'not_satisfied',
  });

  results.push({
    criterion: 'deterministic_validation_known',
    status:
      task.taxonomy.verification === undefined
        ? 'unknown'
        : task.taxonomy.verification === 'deterministic'
          ? 'satisfied'
          : 'not_satisfied',
  });

  results.push({
    criterion: 'sufficient_source_of_truth',
    status: task.context_requirements.length > 0 ? 'satisfied' : 'not_satisfied',
  });

  return results;
}

export const MinimalFactualPreflightRequirement = z.enum([
  'repo_and_base_revision_confirmed',
  'git_working_state_known',
  'environment_readiness_known',
  'validation_available_identified',
  'source_anchors_discovered',
]);
export type MinimalFactualPreflightRequirement = z.infer<typeof MinimalFactualPreflightRequirement>;

export const MINIMAL_FACTUAL_PREFLIGHT_REQUIREMENTS: readonly MinimalFactualPreflightRequirement[] =
  MinimalFactualPreflightRequirement.options;

export const MinimalFactualPreflightSource = z.enum(['cached_inspection', 'fresh_minimal_collection']);
export type MinimalFactualPreflightSource = z.infer<typeof MinimalFactualPreflightSource>;

export interface WorkflowEvaluationContext {
  /** `ProjectInspection` válida — cacheada de uma inspeção anterior ou recém-coletada. */
  readonly inspection?: ProjectInspection;
  readonly intake?: ProjectIntakeRequest;
  /** Declara a proveniência dos fatos, exigida no veredito `DIRECT_ALLOWED`. */
  readonly minimalFactsSource?: MinimalFactualPreflightSource;
}

interface MinimalFactualPreflightEvaluation {
  readonly satisfied: boolean;
  readonly missing: readonly MinimalFactualPreflightRequirement[];
  readonly source: MinimalFactualPreflightSource;
}

/**
 * DIRECT_ALLOWED nunca dispensa fatos: aceita uma `ProjectInspection` válida
 * (cacheada ou de coleta mínima read-only), mas exige que ela cubra os cinco
 * fatos mínimos. Fato ausente ou inválido (ex.: `head_sha` divergente do
 * `base_revision` pedido) impede o veredito.
 */
function evaluateMinimalFactualPreflight(
  context: WorkflowEvaluationContext,
): MinimalFactualPreflightEvaluation {
  const source = context.minimalFactsSource ?? 'cached_inspection';
  const { inspection, intake } = context;

  if (inspection === undefined || intake === undefined) {
    return { satisfied: false, missing: MINIMAL_FACTUAL_PREFLIGHT_REQUIREMENTS, source };
  }

  const missing: MinimalFactualPreflightRequirement[] = [];

  if (!(inspection.git.known && inspection.git.value.head_sha === intake.base_revision.sha)) {
    missing.push('repo_and_base_revision_confirmed');
  }
  if (!inspection.git.known) {
    missing.push('git_working_state_known');
  }
  if (!(inspection.dependencies_state.known && inspection.filesystem_permissions.known)) {
    missing.push('environment_readiness_known');
  }
  if (inspection.validation_command_candidates.length === 0) {
    missing.push('validation_available_identified');
  }
  if (inspection.source_anchors.length === 0) {
    missing.push('source_anchors_discovered');
  }

  return { satisfied: missing.length === 0, missing, source };
}

export const TaskWorkflowVerdict = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('DECOMPOSITION_REQUIRED'),
      task_id: identifier,
      signals: z.array(TriggeredSignal).min(1),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('MERGE_RECOMMENDED'),
      task_id: identifier,
      candidate_task_ids: z.array(identifier).min(2),
      reason: nonEmpty,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('DIRECT_ALLOWED'),
      task_id: identifier,
      satisfied_criteria: z.array(DirectAllowanceCriterion).min(1),
      required_minimal_facts: z.array(MinimalFactualPreflightRequirement).min(1),
      minimal_facts_source: MinimalFactualPreflightSource,
    })
    .strict(),
  z
    .object({
      outcome: z.literal('REVIEWED_REQUIRED'),
      task_id: identifier,
      unmet_criteria: z.array(
        z.object({ criterion: DirectAllowanceCriterion, status: DirectAllowanceCriterionStatus }).strict(),
      ),
      reason: nonEmpty,
    })
    .strict(),
]);
export type TaskWorkflowVerdict = z.infer<typeof TaskWorkflowVerdict>;

const MERGE_TRIVIAL_MAX_CHANGED_FILES = 2;
const MERGE_TRIVIAL_MAX_TOKENS = 20_000;

function sameContextScope(a: PlannedTask, b: PlannedTask): boolean {
  const areasA = [...a.context_scope.areas].sort();
  const areasB = [...b.context_scope.areas].sort();
  return areasA.length === areasB.length && areasA.every((area, index) => area === areasB[index]);
}

/**
 * Fragmentação de plano: tasks encadeadas 1-a-1 (uma única dependência),
 * ambas ATOMIC segundo M74, com o mesmo `context_scope.areas` e envelope
 * trivial, são candidatas a serem uma task só. Une-find sobre pares para
 * agrupar cadeias inteiras — não só pares isolados.
 */
function detectMergeCandidates(
  tasks: readonly PlannedTask[],
  decompositionByTaskId: ReadonlyMap<string, DecompositionVerdict>,
): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(tasks.map((task) => [task.task_id, task]));
  const parent = new Map<string, string>(tasks.map((task) => [task.task_id, task.task_id]));

  function find(id: string): string {
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    parent.set(id, root);
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  function isTrivialAtomic(task: PlannedTask): boolean {
    return (
      decompositionByTaskId.get(task.task_id)?.outcome === 'ATOMIC' &&
      task.resource_envelope.changed_files.expected <= MERGE_TRIVIAL_MAX_CHANGED_FILES &&
      task.resource_envelope.tokens.expected <= MERGE_TRIVIAL_MAX_TOKENS
    );
  }

  for (const task of tasks) {
    if (task.blocked_by.length !== 1) continue;
    const dependencyId = task.blocked_by[0];
    const dependency = dependencyId === undefined ? undefined : byId.get(dependencyId);
    if (dependency === undefined) continue;
    if (!isTrivialAtomic(task) || !isTrivialAtomic(dependency)) continue;
    if (!sameContextScope(task, dependency)) continue;
    union(task.task_id, dependency.task_id);
  }

  const groups = new Map<string, string[]>();
  for (const task of tasks) {
    const root = find(task.task_id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)?.push(task.task_id);
  }

  const result = new Map<string, readonly string[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort();
    for (const id of group) result.set(id, sorted);
  }
  return result;
}

/**
 * Veredito de workflow por task, sobre um plano JÁ VALIDADO por
 * `validatePlan`. Precedência fixa: `DECOMPOSITION_REQUIRED` (M74) sempre
 * vence; depois `MERGE_RECOMMENDED` (fragmentação de plano); depois
 * `DIRECT_ALLOWED` (todos os critérios objetivos + preflight completo);
 * senão `REVIEWED_REQUIRED` — o default fail-safe.
 */
export function evaluatePlanWorkflow(
  tasks: readonly PlannedTask[],
  context: WorkflowEvaluationContext = {},
): readonly TaskWorkflowVerdict[] {
  const decompositionByTaskId = new Map(tasks.map((task) => [task.task_id, evaluateDecomposition(task)]));
  const mergeGroups = detectMergeCandidates(tasks, decompositionByTaskId);

  return tasks.map((task): TaskWorkflowVerdict => {
    const decomposition = decompositionByTaskId.get(task.task_id) as DecompositionVerdict;

    if (decomposition.outcome === 'DECOMPOSITION_REQUIRED') {
      return { outcome: 'DECOMPOSITION_REQUIRED', task_id: task.task_id, signals: decomposition.signals };
    }

    const mergeGroup = mergeGroups.get(task.task_id);
    if (mergeGroup) {
      return {
        outcome: 'MERGE_RECOMMENDED',
        task_id: task.task_id,
        candidate_task_ids: [...mergeGroup],
        reason: `tasks encadeadas (${mergeGroup.join(', ')}) com o mesmo context_scope.areas e envelope trivial — fragmentação desnecessária de um único trabalho`,
      };
    }

    const criteria = evaluateDirectAllowanceCriteria(task, decomposition);
    const unmet = criteria.filter((result) => result.status !== 'satisfied');

    if (unmet.length > 0) {
      return {
        outcome: 'REVIEWED_REQUIRED',
        task_id: task.task_id,
        unmet_criteria: unmet.map((result) => ({ criterion: result.criterion, status: result.status })),
        reason: `critérios objetivos de DIRECT_ALLOWED não satisfeitos ou desconhecidos: ${unmet
          .map((result) => result.criterion)
          .join(', ')}`,
      };
    }

    const preflight = evaluateMinimalFactualPreflight(context);
    if (!preflight.satisfied) {
      return {
        outcome: 'REVIEWED_REQUIRED',
        task_id: task.task_id,
        unmet_criteria: [],
        reason: `minimal factual preflight incompleto — fatos ausentes: ${preflight.missing.join(', ')}`,
      };
    }

    return {
      outcome: 'DIRECT_ALLOWED',
      task_id: task.task_id,
      satisfied_criteria: criteria.map((result) => result.criterion),
      required_minimal_facts: [...MINIMAL_FACTUAL_PREFLIGHT_REQUIREMENTS],
      minimal_facts_source: preflight.source,
    };
  });
}

export type PlanEvaluationResult =
  | { readonly executable: false; readonly validation: Extract<PlanValidationResult, { valid: false }> }
  | { readonly executable: true; readonly tasks: readonly PlannedTask[]; readonly verdicts: readonly TaskWorkflowVerdict[] };

/**
 * Combina as duas camadas: plano inválido nunca chega à policy de workflow
 * — não é executável nem projetável (fail closed).
 */
export function evaluatePlan(input: unknown, context: WorkflowEvaluationContext = {}): PlanEvaluationResult {
  const validation = validatePlan(input);
  if (!validation.valid) {
    return { executable: false, validation };
  }
  return { executable: true, tasks: validation.tasks, verdicts: evaluatePlanWorkflow(validation.tasks, context) };
}

// ---------------------------------------------------------------------------
// Direct Task Normalization.
// ---------------------------------------------------------------------------

/**
 * Classificação de policy que a normalization NÃO decide sozinha — não é um
 * segundo planner. `task_class`, `difficulty_declared` e `risk` expressam um
 * julgamento de planejamento; quem chama `normalizeDirectTask` precisa
 * fornecê-los já resolvidos (por exemplo, por uma policy de projeto
 * upstream), nunca inferidos por leitura semântica do texto do pedido aqui.
 */
export interface DirectTaskClassification {
  readonly task_class: TaskTaxonomy['task_class'];
  readonly difficulty_declared: TaskTaxonomy['difficulty_declared'];
  readonly risk: PlannedTask['risk'];
}

export interface DirectTaskNormalizationInput {
  readonly taskId: string;
  readonly intake: ProjectIntakeRequest;
  readonly requestedScope: RequestedScope;
  readonly inspection: ProjectInspection;
  readonly classification: DirectTaskClassification;
}

export type DirectTaskNormalizationResult =
  | { readonly outcome: 'NORMALIZED'; readonly task: PlannedTask }
  | { readonly outcome: 'REVIEWED_REQUIRED'; readonly reason: string };

/** Nenhum caractere de shell é aceito — argv nunca é uma linha de shell (ver `ValidationCommand`). */
const SHELL_METACHARACTER_PATTERN = /[;&|<>$`\\"'*?{}[\]~\n]/;

/**
 * Converte `validation_command_candidates` OBSERVADOS pela inspeção em
 * `ValidationCommand`. Nunca inventa um comando: candidato cujo `command`
 * pareça precisar de shell (redirecionamento, pipe, substituição) é
 * descartado, não "consertado" — normalization não corrige, só compõe fatos
 * conhecidos com policy determinística.
 */
function deriveValidationCommands(
  candidates: readonly ValidationCommandCandidate[],
  timeoutSeconds: number,
): ValidationCommand[] {
  const commands: ValidationCommand[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.command.trim();
    if (trimmed === '' || SHELL_METACHARACTER_PATTERN.test(trimmed)) continue;
    const argv = trimmed.split(/\s+/);
    commands.push({ argv, timeout_seconds: timeoutSeconds });
  }
  return commands;
}

/**
 * Budgets de policy fixos do perfil de normalization direta — não são fatos
 * observados sobre a task específica, são o teto operacional determinístico
 * atribuído uniformemente a este caminho (permitido explicitamente pelo
 * objetivo: "policy determinística" é uma das fontes aceitas).
 */
const DIRECT_NORMALIZATION_VALIDATION_TIMEOUT_SECONDS = 300;
const DIRECT_NORMALIZATION_ESTIMATED_DURATION: TaskBudget = { expected: 600_000, maximum: 1_800_000 };
const DIRECT_NORMALIZATION_VALIDATION_BUDGET: TaskBudget = { expected: 300_000, maximum: 900_000 };
const DIRECT_NORMALIZATION_RESOURCE_ENVELOPE: TaskBudgets = {
  duration_ms: { expected: 600_000, maximum: 1_800_000 },
  tokens: { expected: 50_000, maximum: 150_000 },
  changed_files: { expected: 3, maximum: 8 },
};

/**
 * Transforma `ProjectIntakeRequest` + `RequestedScope` + fatos do preflight
 * (`ProjectInspection`) numa `PlannedTask` — a work unit ESTRUTURADA que M74
 * e o restante da policy de workflow sempre recebem, nunca o request bruto.
 *
 * Cada campo tem uma fonte rastreável e nenhum campo é inventado:
 * - `objective` vem de `requestedScope.summary` (verbatim).
 * - `acceptance` vem de `intake.objectives` (verbatim) — o único critério de
 *   aceite que o request formal já declara; normalization não sintetiza
 *   novos critérios.
 * - `validation` vem só de `inspection.validation_command_candidates`
 *   observados e sintaticamente seguros; se nenhum candidato seguro existir,
 *   o resultado é `REVIEWED_REQUIRED` — nunca um comando inventado.
 * - `context_scope.areas` vem de `inspection.source_anchors` conhecidos; se
 *   nenhum existir, `REVIEWED_REQUIRED` — nunca uma fronteira adivinhada.
 * - `context_requirements` e `environment_requirements` vêm de
 *   `project_instructions`/`required_tools`/`required_services` observados.
 * - `blocked_by` é sempre `[]` — normalization não infere dependências.
 * - `taxonomy.complexity`/`ambiguity`/`verification` ficam OMITIDOS (campos
 *   opcionais) quando não há fato observado — nunca assumidos como
 *   favoráveis; isso propositalmente faz `DIRECT_ALLOWED` exigir preflight
 *   real depois, em vez de a normalization já presumir baixo risco/ambiguidade.
 * - `task_class`, `difficulty_declared` e `risk` vêm de `classification`,
 *   fornecida por quem chama — nunca inferidos aqui.
 *
 * O resultado final ainda passa por `PlannedTask.safeParse`: se a work unit
 * composta não for um `PlannedTask` válido, a confiança é insuficiente e o
 * resultado é `REVIEWED_REQUIRED`, encaminhando para o caminho completo
 * (inspection completa, planning worker, draft não confiável e validação
 * determinística) em vez de produzir um plano ruim silenciosamente.
 */
export function normalizeDirectTask(input: DirectTaskNormalizationInput): DirectTaskNormalizationResult {
  const areas = [...new Set(input.inspection.source_anchors.map((anchor) => anchor.area))];
  if (areas.length === 0) {
    return {
      outcome: 'REVIEWED_REQUIRED',
      reason: 'nenhum source anchor conhecido no preflight — context_scope não pode ser determinado sem inventar fronteira',
    };
  }

  const validation = deriveValidationCommands(
    input.inspection.validation_command_candidates,
    DIRECT_NORMALIZATION_VALIDATION_TIMEOUT_SECONDS,
  );
  if (validation.length === 0) {
    return {
      outcome: 'REVIEWED_REQUIRED',
      reason: 'nenhum comando de validation seguro observado no preflight — normalization não inventa validation',
    };
  }

  const contextRequirements: ContextRequirement[] = input.inspection.project_instructions.map((ref) => ({
    description: `instrução de projeto (${ref.relevance}) em ${ref.path}`,
    source_anchor: ref.path,
  }));

  const environmentRequirements: EnvironmentRequirement[] = [
    ...input.inspection.required_tools.map((tool) => ({
      kind: 'tool' as const,
      name: tool.name,
      reason: tool.reason,
    })),
    ...input.inspection.required_services.map((service) => ({
      kind: 'service' as const,
      name: service.name,
      reason: service.reason,
    })),
  ];

  const candidate = {
    schema_version: 1 as const,
    task_id: input.taskId,
    objective: input.requestedScope.summary,
    blocked_by: [],
    taxonomy: {
      version: 1 as const,
      task_class: input.classification.task_class,
      difficulty_declared: input.classification.difficulty_declared,
    },
    risk: input.classification.risk,
    acceptance: input.intake.objectives,
    validation,
    initial_files: [],
    probable_files: [],
    context_scope: { areas },
    context_requirements: contextRequirements,
    environment_requirements: environmentRequirements,
    estimated_duration: DIRECT_NORMALIZATION_ESTIMATED_DURATION,
    validation_budget: DIRECT_NORMALIZATION_VALIDATION_BUDGET,
    resource_envelope: DIRECT_NORMALIZATION_RESOURCE_ENVELOPE,
  };

  const parsed = PlannedTask.safeParse(candidate);
  if (!parsed.success) {
    return {
      outcome: 'REVIEWED_REQUIRED',
      reason: `work unit normalizada não satisfaz o contrato PlannedTask: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    };
  }
  return { outcome: 'NORMALIZED', task: parsed.data };
}
