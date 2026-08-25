/**
 * DELIBERAÇÃO OPCIONAL sobre um plano de origem humana.
 *
 * Isto não é review de candidate e não é bounded repair. É uma etapa de
 * REFINAMENTO DE DECISÃO que acontece ANTES de a implementação começar, sobre
 * a versão corrente do plano, e só quando o humano pediu por ela.
 *
 * Três fronteiras sustentam o resto:
 *
 * 1. DELIBERADOR É READ-ONLY. Ele recebe pedido humano, evidência e plano;
 *    critica, revisa e devolve uma versão. Ele não edita repositório, não
 *    executa, não faz commit, não altera autorização e não inicia efeito
 *    externo. A porta que ele atravessa (`PlanDeliberationWorkerPort`) só sabe
 *    receber uma invocação e devolver um veredito estruturado — não existe
 *    caminho daqui para filesystem, git, provider ou state.
 *
 * 2. REVISÃO NÃO É ATALHO. Uma versão revisada volta pelos MESMOS gates de
 *    plano que a versão original atravessou (`validatePlannerDraft`). Revisão
 *    recusada pelos gates não vira plano: a versão canônica anterior continua
 *    valendo, e a recusa fica registrada. Chegar ao número máximo de turnos
 *    nunca autoriza nada — max_turns encerra a deliberação, e não um gate.
 *
 * 3. CONVERGÊNCIA É ESTRUTURADA. Ela não é inferida de prosa: o deliberador
 *    devolve `decision`, `material_objections` e `material_changes`, e só
 *    `ACCEPT` com zero objeções e zero mudanças materiais sela a versão
 *    corrente. Qualquer outra coisa é mais um turno — até o máximo pedido.
 */
import { z } from 'zod';

import { canonicalSha256 } from '../envelope/index.js';
import type { ExecutionAuthorizationScope, ProjectIntakeRequest } from '../intake/index.js';
import type { ProjectInspection } from '../inspection/index.js';
import { UntrustedPlanDraft } from './draft.js';
import { ImplementationPlan, validatePlannerDraft, type PlanGenerationResult } from './generate.js';

const nonEmpty = z.string().trim().min(1);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** Um `deliberation turn` é UMA resposta de UM deliberador sobre a versão corrente. */
export const MAX_DELIBERATION_TURNS_CEILING = 10;

export const DeliberationDiversity = z.enum(['none', 'cross_provider_preferred']);
export type DeliberationDiversity = z.infer<typeof DeliberationDiversity>;

export const DeliberationDecision = z.enum(['ACCEPT', 'REVISE']);
export type DeliberationDecision = z.infer<typeof DeliberationDecision>;

/**
 * Saída ESTRUTURADA do deliberador. `revised_plan` reusa o mesmo contrato
 * não-confiável do draft do planner de propósito: é o que garante que a
 * revisão atravesse exatamente os mesmos gates.
 */
export const DeliberatorVerdict = z
  .object({
    decision: DeliberationDecision,
    material_objections: z.array(boundedText(2_000)).max(50),
    material_changes: z.array(boundedText(2_000)).max(50),
    rationale: boundedText(5_000),
    revised_plan: UntrustedPlanDraft.nullable().default(null),
  })
  .strict()
  .superRefine((verdict, context) => {
    if (verdict.decision === 'ACCEPT' && verdict.revised_plan !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ACCEPT não acompanha revised_plan: aceitar é selar a versão recebida',
        path: ['revised_plan'],
      });
    }
    if (
      verdict.decision === 'REVISE' &&
      verdict.revised_plan === null &&
      verdict.material_objections.length === 0 &&
      verdict.material_changes.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REVISE exige objeção material, mudança material ou plano revisado',
        path: ['decision'],
      });
    }
  });
export type DeliberatorVerdict = z.infer<typeof DeliberatorVerdict>;

/** Projeção BOUNDED do plano entregue ao deliberador; nunca o repositório. */
export const DeliberationPlanView = z
  .object({
    schema_version: z.literal(1),
    acceptance_contract: z.array(boundedText(1_000)).min(1),
    constraints: z.array(boundedText(1_000)),
    exclusions: z.array(boundedText(1_000)),
    tasks: z
      .array(
        z
          .object({
            task_id: nonEmpty,
            objective: boundedText(2_000),
            blocked_by: z.array(nonEmpty),
            acceptance: z.array(boundedText(1_000)).min(1),
            validation: z.array(boundedText(1_000)),
            risk: nonEmpty,
            difficulty: nonEmpty,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type DeliberationPlanView = z.infer<typeof DeliberationPlanView>;

export const PlanDeliberationInvocation = z
  .object({
    schema_version: z.literal(1),
    /**
     * O deliberador roda com o MESMO overlay estrutural read-only do planner.
     * O contrato o declara para que uma porta que o ignore falhe aqui, e não
     * depois de um efeito.
     */
    role: z.literal('READ_ONLY_DELIBERATOR'),
    workspace_access: z.literal('READ_ONLY'),
    turn: z.number().int().positive(),
    max_turns: z.number().int().positive(),
    /** Instrução humana VERBATIM: ela é a autoridade de intenção. */
    human_request: nonEmpty,
    plan: DeliberationPlanView,
    plan_sha256: sha256,
    /** Objeções que os turnos anteriores levantaram, para não repetir trabalho. */
    prior_objections: z.array(boundedText(2_000)).max(200),
  })
  .strict();
export type PlanDeliberationInvocation = z.infer<typeof PlanDeliberationInvocation>;

export type PlanDeliberationInvocationResult =
  | { readonly outcome: 'VERDICT_RETURNED'; readonly verdict: unknown }
  | {
      readonly outcome: 'INVOCATION_FAILED';
      readonly failure: { readonly code: string; readonly message: string };
    };

/**
 * Porta provider-agnostic do deliberador. É deliberadamente estreita: recebe
 * invocação, devolve veredito. Não há aqui nada que possa escrever.
 */
export interface PlanDeliberationWorkerPort {
  invoke(invocation: PlanDeliberationInvocation): Promise<PlanDeliberationInvocationResult>;
}

export const DeliberatorAssignment = z
  .object({
    profile_id: nonEmpty,
    provider: nonEmpty,
    model: nonEmpty.nullable(),
  })
  .strict();
export type DeliberatorAssignment = z.infer<typeof DeliberatorAssignment>;

export const DeliberationRevisionStatus = z.enum([
  'NOT_PROPOSED',
  'ACCEPTED_BY_GATES',
  'REJECTED_BY_GATES',
]);
export type DeliberationRevisionStatus = z.infer<typeof DeliberationRevisionStatus>;

/**
 * Registro AUDITÁVEL de um turno. Não é transcript opaco: cada campo responde
 * a uma pergunta que alguém vai fazer depois — quem falou, sobre qual versão,
 * o que decidiu, o que objetou, o que mudou e o que os gates fizeram com isso.
 */
export const DeliberationTurnRecord = z
  .object({
    turn: z.number().int().positive(),
    profile_id: nonEmpty,
    provider: nonEmpty,
    model: nonEmpty.nullable(),
    received_plan_sha256: sha256,
    decision: DeliberationDecision.nullable(),
    material_objections: z.array(boundedText(2_000)),
    material_changes: z.array(boundedText(2_000)),
    rationale: boundedText(5_000).nullable(),
    revised_plan_sha256: sha256.nullable(),
    revision_status: DeliberationRevisionStatus,
    revision_rejection: nonEmpty.nullable(),
    converged: z.boolean(),
    /** `null` quando o turno produziu veredito; preenchido quando falhou. */
    invocation_failure: nonEmpty.nullable(),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type DeliberationTurnRecord = z.infer<typeof DeliberationTurnRecord>;

export const DeliberationConvergenceStatus = z.enum([
  'NOT_REQUESTED',
  'CONVERGED',
  'MAX_TURNS_REACHED',
  'NO_DELIBERATOR_AVAILABLE',
]);
export type DeliberationConvergenceStatus = z.infer<typeof DeliberationConvergenceStatus>;

export const PlanDeliberationArtifact = z
  .object({
    kind: z.literal('PLAN_DELIBERATION'),
    schema_version: z.literal(1),
    requested_max_turns: z.number().int().nonnegative(),
    actual_turns: z.number().int().nonnegative(),
    convergence_status: DeliberationConvergenceStatus,
    initial_plan_sha256: sha256,
    final_plan_sha256: sha256,
    stop_reason: nonEmpty,
    diversity: z
      .object({
        requested: DeliberationDiversity,
        satisfied: z.boolean(),
        reason: nonEmpty,
      })
      .strict(),
    turns: z.array(DeliberationTurnRecord),
    provenance: z.array(nonEmpty).min(1),
  })
  .strict();
export type PlanDeliberationArtifact = z.infer<typeof PlanDeliberationArtifact>;

export function planViewOf(plan: ImplementationPlan): DeliberationPlanView {
  return DeliberationPlanView.parse({
    schema_version: 1,
    acceptance_contract: plan.control.acceptance_contract,
    constraints: plan.control.constraints,
    exclusions: plan.control.exclusions,
    tasks: plan.tasks.map((entry) => ({
      task_id: entry.task.task_id,
      objective: entry.task.objective,
      blocked_by: entry.task.blocked_by,
      acceptance: entry.task.acceptance,
      validation: entry.task.validation.map((command) => command.argv.join(' ')),
      risk: entry.task.risk,
      difficulty: entry.assessment.difficulty.value,
    })),
  });
}

/** Identidade da VERSÃO do plano; é ela que cada turno recebe e carimba. */
export function planVersionSha256(plan: ImplementationPlan): string {
  return canonicalSha256(planViewOf(plan));
}

/**
 * Sequência de deliberadores. `cross_provider_preferred` alterna providers
 * enquanto houver mais de um; com um provider só, ela devolve o mesmo profile
 * e o artifact registra explicitamente que a diversidade NÃO foi satisfeita —
 * preferência não vira exigência silenciosa nem gate novo.
 */
export function selectDeliberators(input: {
  readonly candidates: readonly DeliberatorAssignment[];
  readonly maxTurns: number;
  readonly diversity: DeliberationDiversity;
}): {
  readonly sequence: readonly DeliberatorAssignment[];
  readonly satisfied: boolean;
  readonly reason: string;
} {
  const candidates = [...input.candidates].sort((left, right) =>
    left.profile_id.localeCompare(right.profile_id),
  );
  if (candidates.length === 0) {
    return { sequence: [], satisfied: false, reason: 'nenhum profile elegível para o papel de deliberador' };
  }
  if (input.diversity === 'none') {
    return {
      sequence: Array.from({ length: input.maxTurns }, (_, index) => candidates[index % candidates.length] as DeliberatorAssignment),
      satisfied: true,
      reason: 'diversidade não foi pedida; a sequência percorre os profiles elegíveis em ordem determinística',
    };
  }

  const byProvider = new Map<string, DeliberatorAssignment[]>();
  for (const candidate of candidates) {
    byProvider.set(candidate.provider, [...(byProvider.get(candidate.provider) ?? []), candidate]);
  }
  const providers = [...byProvider.keys()].sort();
  if (providers.length < 2) {
    return {
      sequence: Array.from({ length: input.maxTurns }, (_, index) => candidates[index % candidates.length] as DeliberatorAssignment),
      satisfied: false,
      reason: `cross_provider_preferred pedido, mas só o provider ${providers[0]} está disponível e autorizado; a deliberação segue sem alternância, registrada`,
    };
  }

  const sequence: DeliberatorAssignment[] = [];
  const cursor = new Map<string, number>();
  for (let turn = 0; turn < input.maxTurns; turn += 1) {
    const provider = providers[turn % providers.length] as string;
    const pool = byProvider.get(provider) as DeliberatorAssignment[];
    const index = cursor.get(provider) ?? 0;
    sequence.push(pool[index % pool.length] as DeliberatorAssignment);
    cursor.set(provider, index + 1);
  }
  return {
    sequence,
    satisfied: true,
    reason: `alternância cross-provider entre ${providers.join(', ')}`,
  };
}

export interface DeliberatePlanInput {
  /** Versão inicial: já AUTORIZADA pelos gates; a geração não conta como turno. */
  readonly plan: ImplementationPlan;
  readonly humanRequest: string;
  readonly maxTurns: number;
  readonly diversity: DeliberationDiversity;
  readonly deliberators: readonly DeliberatorAssignment[];
  readonly worker: PlanDeliberationWorkerPort;
  /** MESMOS gates da geração; injetados para manter esta função pura. */
  readonly revalidate: (draft: unknown) => PlanGenerationResult;
}

export interface DeliberatePlanResult {
  readonly plan: ImplementationPlan;
  readonly artifact: PlanDeliberationArtifact;
}

function artifactOf(input: {
  readonly requestedMaxTurns: number;
  readonly turns: readonly DeliberationTurnRecord[];
  readonly convergence: DeliberationConvergenceStatus;
  readonly initialSha: string;
  readonly finalSha: string;
  readonly stopReason: string;
  readonly diversity: DeliberationDiversity;
  readonly diversitySatisfied: boolean;
  readonly diversityReason: string;
}): PlanDeliberationArtifact {
  return PlanDeliberationArtifact.parse({
    kind: 'PLAN_DELIBERATION',
    schema_version: 1,
    requested_max_turns: input.requestedMaxTurns,
    actual_turns: input.turns.length,
    convergence_status: input.convergence,
    initial_plan_sha256: input.initialSha,
    final_plan_sha256: input.finalSha,
    stop_reason: input.stopReason,
    diversity: {
      requested: input.diversity,
      satisfied: input.diversitySatisfied,
      reason: input.diversityReason,
    },
    turns: input.turns,
    provenance: [
      'PlanDeliberationInvocation READ_ONLY_DELIBERATOR: deliberadores nunca escrevem repositório, runtime ou autorização',
      'validatePlannerDraft: toda revisão passou pelos mesmos gates da geração original',
      'max_turns encerra a deliberação e nunca supera human gate, safety, billing ou credencial',
    ],
  });
}

/**
 * Executa até `maxTurns` turnos, parando ANTES no primeiro veredito
 * convergente. `maxTurns: 0` não chama deliberador nenhum — o plano corrente é
 * o plano final, e o artifact registra que a deliberação não foi pedida.
 */
export async function deliberatePlan(input: DeliberatePlanInput): Promise<DeliberatePlanResult> {
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 0) {
    throw new RangeError('max_turns deve ser inteiro não negativo');
  }
  if (input.maxTurns > MAX_DELIBERATION_TURNS_CEILING) {
    throw new RangeError(
      `max_turns=${input.maxTurns} excede o teto de produto ${MAX_DELIBERATION_TURNS_CEILING}`,
    );
  }

  const initialSha = planVersionSha256(input.plan);
  if (input.maxTurns === 0) {
    return {
      plan: input.plan,
      artifact: artifactOf({
        requestedMaxTurns: 0,
        turns: [],
        convergence: 'NOT_REQUESTED',
        initialSha,
        finalSha: initialSha,
        stopReason: 'max_turns=0: nenhuma deliberação foi pedida e o plano corrente é o final',
        diversity: input.diversity,
        diversitySatisfied: true,
        diversityReason: 'deliberação não foi pedida',
      }),
    };
  }

  const selection = selectDeliberators({
    candidates: input.deliberators,
    maxTurns: input.maxTurns,
    diversity: input.diversity,
  });
  if (selection.sequence.length === 0) {
    return {
      plan: input.plan,
      artifact: artifactOf({
        requestedMaxTurns: input.maxTurns,
        turns: [],
        convergence: 'NO_DELIBERATOR_AVAILABLE',
        initialSha,
        finalSha: initialSha,
        stopReason: selection.reason,
        diversity: input.diversity,
        diversitySatisfied: false,
        diversityReason: selection.reason,
      }),
    };
  }

  const turns: DeliberationTurnRecord[] = [];
  const priorObjections: string[] = [];
  let current = input.plan;
  let convergence: DeliberationConvergenceStatus = 'MAX_TURNS_REACHED';
  let stopReason = `max_turns=${input.maxTurns} alcançado sem convergência; a versão canônica mais recente é o plano de execução`;

  for (const [index, deliberator] of selection.sequence.entries()) {
    const turn = index + 1;
    const receivedSha = planVersionSha256(current);
    const invocation = PlanDeliberationInvocation.parse({
      schema_version: 1,
      role: 'READ_ONLY_DELIBERATOR',
      workspace_access: 'READ_ONLY',
      turn,
      max_turns: input.maxTurns,
      human_request: input.humanRequest,
      plan: planViewOf(current),
      plan_sha256: receivedSha,
      prior_objections: [...priorObjections],
    });

    let result: PlanDeliberationInvocationResult;
    try {
      result = await input.worker.invoke(invocation);
    } catch (error) {
      result = {
        outcome: 'INVOCATION_FAILED',
        failure: {
          code: 'DELIBERATOR_INVOCATION_THREW',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    const base = {
      turn,
      profile_id: deliberator.profile_id,
      provider: deliberator.provider,
      model: deliberator.model,
      received_plan_sha256: receivedSha,
      provenance: [
        `PlanDeliberationInvocation(turn=${turn}, max_turns=${input.maxTurns})`,
        `plano recebido=${receivedSha}`,
      ],
    } as const;

    if (result.outcome === 'INVOCATION_FAILED') {
      // Deliberador indisponível NÃO invalida o plano corrente: ele é uma
      // etapa de refinamento opcional, e a versão canônica já passou pelos
      // gates. A falha fica registrada e a deliberação para.
      turns.push(
        DeliberationTurnRecord.parse({
          ...base,
          decision: null,
          material_objections: [],
          material_changes: [],
          rationale: null,
          revised_plan_sha256: null,
          revision_status: 'NOT_PROPOSED',
          revision_rejection: null,
          converged: false,
          invocation_failure: `${result.failure.code}: ${result.failure.message}`,
        }),
      );
      stopReason = `deliberação encerrada no turno ${turn}: ${result.failure.code}; a versão canônica anterior segue como plano de execução`;
      break;
    }

    const parsed = DeliberatorVerdict.safeParse(result.verdict);
    if (!parsed.success) {
      // Prosa não vira convergência, e saída malformada não vira plano.
      turns.push(
        DeliberationTurnRecord.parse({
          ...base,
          decision: null,
          material_objections: [],
          material_changes: [],
          rationale: null,
          revised_plan_sha256: null,
          revision_status: 'NOT_PROPOSED',
          revision_rejection: null,
          converged: false,
          invocation_failure: `VERDICT_NOT_STRUCTURED: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')}`,
        }),
      );
      stopReason = `deliberação encerrada no turno ${turn}: veredito não estruturado; a versão canônica anterior segue como plano de execução`;
      break;
    }

    const verdict = parsed.data;
    const converged =
      verdict.decision === 'ACCEPT' &&
      verdict.material_objections.length === 0 &&
      verdict.material_changes.length === 0;

    let revisionStatus: DeliberationRevisionStatus = 'NOT_PROPOSED';
    let revisionRejection: string | null = null;
    let revisedSha: string | null = null;
    if (verdict.revised_plan !== null) {
      const revalidated = input.revalidate(verdict.revised_plan);
      if (revalidated.outcome === 'AUTHORIZED') {
        current = revalidated.plan;
        revisionStatus = 'ACCEPTED_BY_GATES';
        revisedSha = planVersionSha256(current);
      } else {
        revisionStatus = 'REJECTED_BY_GATES';
        revisionRejection = `${revalidated.stage}: ${revalidated.issues.join('; ')}`;
      }
    }

    priorObjections.push(...verdict.material_objections);
    turns.push(
      DeliberationTurnRecord.parse({
        ...base,
        decision: verdict.decision,
        material_objections: verdict.material_objections,
        material_changes: verdict.material_changes,
        rationale: verdict.rationale,
        revised_plan_sha256: revisedSha,
        revision_status: revisionStatus,
        revision_rejection: revisionRejection,
        converged,
        invocation_failure: null,
      }),
    );

    if (converged) {
      convergence = 'CONVERGED';
      stopReason = `convergência no turno ${turn} de no máximo ${input.maxTurns}: ACCEPT com zero objeções e zero mudanças materiais; os turnos restantes não foram gastos`;
      break;
    }
  }

  return {
    plan: current,
    artifact: artifactOf({
      requestedMaxTurns: input.maxTurns,
      turns,
      convergence,
      initialSha,
      finalSha: planVersionSha256(current),
      stopReason,
      diversity: input.diversity,
      diversitySatisfied: selection.satisfied,
      diversityReason: selection.reason,
    }),
  };
}

/** Revalidação padrão: literalmente os gates da geração, sem atalho. */
export function planRevalidator(context: {
  readonly intake: ProjectIntakeRequest;
  readonly inspection: ProjectInspection;
  readonly authorizationScope: ExecutionAuthorizationScope;
}): (draft: unknown) => PlanGenerationResult {
  return (draft) =>
    validatePlannerDraft({
      draft,
      intake: context.intake,
      inspection: context.inspection,
      authorizationScope: context.authorizationScope,
    });
}
