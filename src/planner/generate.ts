import { z } from 'zod';

import { canonicalSha256 } from '../envelope/index.js';
import {
  ExecutionAuthorizationScope,
  ProjectIntakeRequest,
  executionAuthorizationScopeSha256,
  projectIntakeSha256,
} from '../intake/index.js';
import { ProjectInspection } from '../inspection/index.js';
import { assessExecution, ExecutionAssessment } from './assess.js';
import {
  CONTROL_PLANE_PLANNING_POLICY,
  PlanningPolicy,
  PlanningWorkerInvocation,
  PlanningWorkerInvocationResult,
  buildPlannerPacket,
  normalizeUntrustedPlanDraft,
} from './draft.js';
import type { PlanningWorkerPort } from './draft.js';
import { evaluateDecomposition } from './decomposition.js';
import { PlannedTask, PlannerTaskMetadata } from './task.js';
import { TaskWorkflowVerdict, evaluatePlanWorkflow, validatePlan } from './validate.js';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumerico com - ou _');
const shellMetacharacter = /[;&|<>$`\\\n]/;
export const PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS = 3_600;

const AtomicDecomposition = z.object({ outcome: z.literal('ATOMIC') }).strict();

const AuthorizedPlanTask = z
  .object({
    task: PlannedTask,
    decomposition: AtomicDecomposition,
    workflow: TaskWorkflowVerdict.refine(
      (verdict) => verdict.outcome !== 'DECOMPOSITION_REQUIRED',
      'ImplementationPlan nao aceita DECOMPOSITION_REQUIRED',
    ),
    assessment: ExecutionAssessment,
  })
  .strict();

export const ImplementationPlan = z
  .object({
    schema_version: z.literal(1),
    source: z
      .object({
        intake_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        inspection_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        authorization_scope_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        base_revision_sha: z.string().regex(/^[0-9a-f]{40}$/),
      })
      .strict(),
    control: z
      .object({
        acceptance_contract: z.array(nonEmpty).min(1),
        constraints: z.array(nonEmpty),
        exclusions: z.array(nonEmpty),
        plan_policy: PlanningPolicy,
        routing_policy: z
          .object({
            owner: z.literal('CONTROL_PLANE'),
            provider_selection: z.literal('OUTSIDE_PLANNER'),
          })
          .strict(),
        authorization_scope: ExecutionAuthorizationScope,
      })
      .strict(),
    tasks: z.array(AuthorizedPlanTask).min(1),
  })
  .strict();
export type ImplementationPlan = z.infer<typeof ImplementationPlan>;

export const PlanGenerationStage = z.enum([
  'INPUT_VALIDATION',
  'PACKET_CONSTRUCTION',
  'PLANNING_WORKER',
  'SCHEMA_NORMALIZATION',
  'AVC_DECOMPOSITION',
  'PLAN_POLICY',
  'DEPENDENCY_VALIDATION',
  'RISK_READINESS',
  'IMPLEMENTATION_PLAN',
]);
export type PlanGenerationStage = z.infer<typeof PlanGenerationStage>;

export type PlanGenerationResult =
  | {
      readonly outcome: 'AUTHORIZED';
      readonly plan: ImplementationPlan;
    }
  | {
      readonly outcome: 'REJECTED';
      readonly stage: PlanGenerationStage;
      readonly issues: readonly string[];
    };

export interface GenerateImplementationPlanInput {
  readonly intake: unknown;
  readonly inspection: unknown;
  readonly authorizationScope: unknown;
  readonly planningWorker: PlanningWorkerPort;
}

function rejected(stage: PlanGenerationStage, issues: readonly string[]): PlanGenerationResult {
  return { outcome: 'REJECTED', stage, issues };
}

function zodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
}

/**
 * Os objetivos do usuario sao o PISO do plano, nao o teto:
 * USER OBJECTIVES ⊆ PLAN ACCEPTANCE. Todo objetivo original precisa aparecer
 * VERBATIM em alguma `tasks[].acceptance` — o planner nao pode reescrever,
 * resumir nem substituir silenciosamente o que o usuario pediu. Criterios
 * tecnicos adicionais que a work unit precise satisfazer (por exemplo
 * "pnpm build termina com exit 0") sao legitimos e nao rejeitam o plano.
 */
function validateProtectedAcceptance(tasks: readonly PlannedTask[], acceptance: readonly string[]): string | null {
  const drafted = new Set(tasks.flatMap((task) => task.acceptance));
  const missing = acceptance.filter((objective) => !drafted.has(objective));
  return missing.length === 0
    ? null
    : `draft nao cobre objetivos do acceptance_contract (cada objetivo precisa aparecer verbatim em tasks[].acceptance): ${missing.join(' | ')}`;
}

function validateProjectionCommands(tasks: readonly PlannedTask[]): string[] {
  const issues: string[] = [];
  for (const task of tasks) {
    for (const [index, command] of task.validation.entries()) {
      if (command.timeout_seconds > PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS) {
        issues.push(
          `${task.task_id}.validation[${index}].timeout_seconds excede ${PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS}`,
        );
      }
      if (command.argv.some((argument) => shellMetacharacter.test(argument))) {
        issues.push(`${task.task_id}.validation[${index}].argv contem metacaractere de shell`);
      }
    }
  }
  return issues;
}

/**
 * Control-plane pipeline. O draft jamais e promovido diretamente: cada gate
 * devolve rejeicao explicita e nenhuma etapa reescreve a saida do worker.
 */
export async function generateImplementationPlan(
  input: GenerateImplementationPlanInput,
): Promise<PlanGenerationResult> {
  const intakeResult = ProjectIntakeRequest.safeParse(input.intake);
  const inspectionResult = ProjectInspection.safeParse(input.inspection);
  const authorizationResult = ExecutionAuthorizationScope.safeParse(input.authorizationScope);
  const inputIssues = [
    ...(intakeResult.success ? [] : zodIssues(intakeResult.error)),
    ...(inspectionResult.success ? [] : zodIssues(inspectionResult.error)),
    ...(authorizationResult.success ? [] : zodIssues(authorizationResult.error)),
  ];
  if (inputIssues.length > 0 || !intakeResult.success || !inspectionResult.success || !authorizationResult.success) {
    return rejected('INPUT_VALIDATION', inputIssues);
  }

  const { data: intake } = intakeResult;
  const { data: inspection } = inspectionResult;
  const { data: authorizationScope } = authorizationResult;
  if (authorizationScope.requested_scope.summary !== intake.requested_scope.summary) {
    return rejected('INPUT_VALIDATION', ['authorization_scope.requested_scope diverge do intake']);
  }

  const packetId = canonicalSha256({
    intake: projectIntakeSha256(intake),
    inspection: canonicalSha256(inspection),
    authorization: executionAuthorizationScopeSha256(authorizationScope),
  });

  let invocation: z.infer<typeof PlanningWorkerInvocation>;
  try {
    invocation = PlanningWorkerInvocation.parse({
      schema_version: 1,
      role: 'READ_ONLY_PLANNER',
      workspace_access: 'READ_ONLY',
      packet: buildPlannerPacket({ packetId, intake, inspection, authorizationScope }),
      // A instrução humana completa é a autoridade de intenção e viaja fora
      // do packet bounded; o superRefine da invocação amarra hash e texto.
      human_instruction: intake.user_request,
    });
  } catch (error) {
    return rejected(
      'PACKET_CONSTRUCTION',
      error instanceof z.ZodError ? zodIssues(error) : [error instanceof Error ? error.message : String(error)],
    );
  }

  let rawInvocationResult: unknown;
  try {
    rawInvocationResult = await input.planningWorker.invoke(invocation);
  } catch (error) {
    return rejected('PLANNING_WORKER', [error instanceof Error ? error.message : String(error)]);
  }

  const invocationResult = PlanningWorkerInvocationResult.safeParse(rawInvocationResult);
  if (!invocationResult.success) {
    return rejected('PLANNING_WORKER', zodIssues(invocationResult.error));
  }
  if (invocationResult.data.outcome === 'INVOCATION_FAILED') {
    return rejected('PLANNING_WORKER', [
      `${invocationResult.data.failure.code}: ${invocationResult.data.failure.message}`,
    ]);
  }

  const normalized = normalizeUntrustedPlanDraft(invocationResult.data.draft);
  if (normalized.outcome === 'INVALID_DRAFT') {
    return rejected(
      'SCHEMA_NORMALIZATION',
      normalized.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }

  const acceptanceIssue = validateProtectedAcceptance(normalized.tasks, intake.objectives);
  const projectionIssues = validateProjectionCommands(normalized.tasks);
  if (acceptanceIssue !== null || projectionIssues.length > 0) {
    return rejected('SCHEMA_NORMALIZATION', [
      ...(acceptanceIssue === null ? [] : [acceptanceIssue]),
      ...projectionIssues,
    ]);
  }

  const decompositions = normalized.tasks.map((task) => ({
    task_id: task.task_id,
    verdict: evaluateDecomposition(task),
  }));
  const decompositionFailures = decompositions.filter(
    (entry) => entry.verdict.outcome === 'DECOMPOSITION_REQUIRED',
  );
  if (decompositionFailures.length > 0) {
    return rejected(
      'AVC_DECOMPOSITION',
      decompositionFailures.map(
        (entry) =>
          `${entry.task_id}: ${entry.verdict.outcome} (${entry.verdict.outcome === 'DECOMPOSITION_REQUIRED' ? entry.verdict.signals.map((signal) => signal.signal).join(', ') : ''})`,
      ),
    );
  }

  const workflows = evaluatePlanWorkflow(normalized.tasks, {
    inspection,
    intake,
    minimalFactsSource: 'cached_inspection',
  });
  const unexpectedPolicyFailures = workflows.filter(
    (workflow) => workflow.outcome === 'DECOMPOSITION_REQUIRED',
  );
  if (unexpectedPolicyFailures.length > 0) {
    return rejected('PLAN_POLICY', ['plan policy divergiu do gate AVC previamente calculado']);
  }

  const dependencyValidation = validatePlan({ schema_version: 1, tasks: normalized.tasks });
  if (!dependencyValidation.valid) {
    return rejected(
      'DEPENDENCY_VALIDATION',
      dependencyValidation.issues.map((issue) => `${issue.code}: ${issue.message}`),
    );
  }

  const assessments = normalized.tasks.map((task) =>
    assessExecution(task, {
      inspection,
      expectedBaseRevisionSha: intake.base_revision.sha,
      factsSource: 'full_inspection',
    }),
  );
  const assessmentIssues: string[] = [];
  for (const assessment of assessments) {
    const parsed = ExecutionAssessment.safeParse(assessment);
    if (!parsed.success) assessmentIssues.push(...zodIssues(parsed.error));
  }
  if (assessmentIssues.length > 0) return rejected('RISK_READINESS', assessmentIssues);

  const planCandidate = {
    schema_version: 1 as const,
    source: {
      intake_sha256: projectIntakeSha256(intake),
      inspection_sha256: canonicalSha256(inspection),
      authorization_scope_sha256: executionAuthorizationScopeSha256(authorizationScope),
      base_revision_sha: intake.base_revision.sha,
    },
    control: {
      acceptance_contract: intake.objectives,
      constraints: intake.constraints,
      exclusions: intake.exclusions,
      plan_policy: CONTROL_PLANE_PLANNING_POLICY,
      routing_policy: {
        owner: 'CONTROL_PLANE' as const,
        provider_selection: 'OUTSIDE_PLANNER' as const,
      },
      authorization_scope: authorizationScope,
    },
    tasks: normalized.tasks.map((task, index) => ({
      task,
      decomposition: { outcome: 'ATOMIC' as const },
      workflow: workflows[index],
      assessment: assessments[index],
    })),
  };
  const planResult = ImplementationPlan.safeParse(planCandidate);
  return planResult.success
    ? { outcome: 'AUTHORIZED', plan: planResult.data }
    : rejected('IMPLEMENTATION_PLAN', zodIssues(planResult.error));
}

export const ProjectedPlanFile = z
  .object({
    schema_version: z.literal(1),
    generated_from: ImplementationPlan.shape.source,
    tasks: z
      .array(
        z
          .object({
            id: identifier,
            title: nonEmpty,
            blocked_by: z.array(identifier),
            objective: nonEmpty,
            initial_files: z.array(nonEmpty),
            acceptance: z.array(nonEmpty).min(1),
            planner_metadata: PlannerTaskMetadata,
            validation: z
              .array(
                z
                  .object({
                    argv: z.array(nonEmpty).min(1),
                    timeout_seconds: z.number().int().positive().max(PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS),
                  })
                  .strict(),
              )
              .min(1),
            constraints: z.array(nonEmpty),
            include_previous_handoff: z.boolean(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ProjectedPlanFile = z.infer<typeof ProjectedPlanFile>;

/** Projecao pura: retorna dados compativeis com PlanFile; nunca escreve dev/plan.yaml. */
export function projectImplementationPlan(plan: ImplementationPlan): ProjectedPlanFile {
  const parsed = ImplementationPlan.parse(plan);
  return ProjectedPlanFile.parse({
    schema_version: 1,
    generated_from: parsed.source,
    tasks: parsed.tasks.map(({ task }) => ({
      id: task.task_id,
      title: task.objective,
      blocked_by: task.blocked_by,
      objective: task.objective,
      initial_files: task.initial_files,
      acceptance: task.acceptance,
      planner_metadata: {
        taxonomy: task.taxonomy,
        risk: task.risk,
        probable_files: task.probable_files,
        context_scope: task.context_scope,
        context_requirements: task.context_requirements,
        environment_requirements: task.environment_requirements,
        estimated_duration: task.estimated_duration,
        validation_budget: task.validation_budget,
        resource_envelope: task.resource_envelope,
      },
      validation: task.validation,
      constraints: [
        ...parsed.control.constraints,
        ...parsed.control.exclusions.map(
          (exclusion) => `Exclusão autorizada: ${exclusion}`,
        ),
      ],
      include_previous_handoff: false,
    })),
  });
}
