import { createHash } from 'node:crypto';

import { z } from 'zod';

import { ExecutionAuthorizationScope, type ProjectIntakeRequest } from '../intake/index.js';
import type { ProjectInspection } from '../inspection/index.js';
import { PlannedTask } from './task.js';

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumerico com - ou _');

export const MAX_PLANNER_PACKET_BYTES = 16 * 1024;
export const MAX_PLANNER_TASKS = 50;

export const PLANNING_PIPELINE = [
  'SCHEMA_NORMALIZATION',
  'AVC_DECOMPOSITION',
  'PLAN_POLICY',
  'DEPENDENCY_VALIDATION',
  'RISK_READINESS',
] as const;

export const PlanningPolicy = z
  .object({
    schema_version: z.literal(1),
    invalid_draft: z.literal('REJECT'),
    decomposition: z.literal('ATOMIC_ONLY'),
    dependency_graph: z.literal('VALID_DAG_REQUIRED'),
    assessment: z.literal('RISK_READINESS_REQUIRED'),
    pipeline: z.tuple([
      z.literal('SCHEMA_NORMALIZATION'),
      z.literal('AVC_DECOMPOSITION'),
      z.literal('PLAN_POLICY'),
      z.literal('DEPENDENCY_VALIDATION'),
      z.literal('RISK_READINESS'),
    ]),
  })
  .strict();
export type PlanningPolicy = z.infer<typeof PlanningPolicy>;

export const CONTROL_PLANE_PLANNING_POLICY: PlanningPolicy = PlanningPolicy.parse({
  schema_version: 1,
  invalid_draft: 'REJECT',
  decomposition: 'ATOMIC_ONLY',
  dependency_graph: 'VALID_DAG_REQUIRED',
  assessment: 'RISK_READINESS_REQUIRED',
  pipeline: PLANNING_PIPELINE,
});

const RoutingPolicy = z
  .object({
    owner: z.literal('CONTROL_PLANE'),
    provider_selection: z.literal('OUTSIDE_PLANNER'),
  })
  .strict();

const PlanningContract = z
  .object({
    schema_version: z.literal(1),
    worker_role: z.literal('READ_ONLY_PLANNER'),
    output_trust: z.literal('UNTRUSTED_DRAFT'),
    acceptance_contract: z.array(boundedText(1_000)).min(1).max(50),
    plan_policy: PlanningPolicy,
    routing_policy: RoutingPolicy,
    safety_boundaries: z
      .object({
        exclusions: z.array(boundedText(1_000)).max(50),
        authorization_scope: ExecutionAuthorizationScope,
      })
      .strict(),
  })
  .strict();

const PlannerSourceAnchor = z
  .object({
    area: boundedText(200),
    path: boundedText(1_000),
  })
  .strict();

const InspectionSummary = z
  .object({
    inspected_at: boundedText(100),
    head_sha: boundedText(100).nullable(),
    working_tree_dirty: z.boolean().nullable(),
    primary_ecosystem: boundedText(200).nullable(),
    package_manager: boundedText(200).nullable(),
    build_system: boundedText(200).nullable(),
    dependencies_installed: z.boolean().nullable(),
    validation_candidates: z
      .array(
        z
          .object({
            name: boundedText(200),
            command: boundedText(1_000),
            source: boundedText(1_000),
          })
          .strict(),
      )
      .max(20),
    risks: z.array(boundedText(1_000)).max(30),
  })
  .strict();

export const PlannerPacket = z
  .object({
    schema_version: z.literal(1),
    packet_id: z.string().regex(/^[0-9a-f]{64}$/),
    target_repo_url: boundedText(2_000),
    base_revision_sha: z.string().regex(/^[0-9a-f]{40}$/),
    user_intent: z
      .object({
        /**
         * Identidade (SHA-256) da instrução humana COMPLETA. O texto integral
         * NUNCA entra no packet: ele viaja em
         * `PlanningWorkerInvocation.human_instruction`, que é a autoridade de
         * intenção. O packet carrega só fatos derivados e bounded.
         */
        instruction_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        objectives: z.array(boundedText(1_000)).min(1).max(50),
        requested_scope: boundedText(2_000),
      })
      .strict(),
    inspection: InspectionSummary,
    source_anchors: z.array(PlannerSourceAnchor).min(1).max(100),
    constraints: z.array(boundedText(1_000)).max(50),
    planning_contract: PlanningContract,
  })
  .strict()
  .superRefine((packet, context) => {
    const bytes = Buffer.byteLength(JSON.stringify(packet), 'utf8');
    if (bytes > MAX_PLANNER_PACKET_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `PlannerPacket excede o limite de ${MAX_PLANNER_PACKET_BYTES} bytes: ${bytes}`,
      });
    }
  });
export type PlannerPacket = z.infer<typeof PlannerPacket>;

/** Hash da instrução humana completa, em UTF-8 — a ponte packet ↔ autoridade. */
export function humanInstructionSha256(instruction: string): string {
  return createHash('sha256').update(instruction, 'utf8').digest('hex');
}

export interface BuildPlannerPacketInput {
  readonly packetId: string;
  readonly intake: ProjectIntakeRequest;
  readonly inspection: ProjectInspection;
  readonly authorizationScope: z.infer<typeof ExecutionAuthorizationScope>;
}

/** Projeta somente fatos e caminhos; conteudo de arquivos e transcript nunca entram no packet. */
export function buildPlannerPacket(input: BuildPlannerPacketInput): PlannerPacket {
  const anchors = new Map<string, { area: string; path: string }>();
  for (const anchor of input.inspection.source_anchors) {
    anchors.set(`${anchor.area}\0${anchor.path}`, anchor);
  }
  for (const instruction of input.inspection.project_instructions) {
    const anchor = { area: 'project_instruction', path: instruction.path };
    anchors.set(`${anchor.area}\0${anchor.path}`, anchor);
  }
  for (const relevantFile of input.inspection.relevant_files) {
    const anchor = { area: 'relevant_file', path: relevantFile };
    anchors.set(`${anchor.area}\0${anchor.path}`, anchor);
  }

  const packet = {
    schema_version: 1 as const,
    packet_id: input.packetId,
    target_repo_url: input.intake.target_repo.url,
    base_revision_sha: input.intake.base_revision.sha,
    user_intent: {
      instruction_sha256: humanInstructionSha256(input.intake.user_request),
      objectives: input.intake.objectives,
      requested_scope: input.intake.requested_scope.summary,
    },
    inspection: {
      inspected_at: input.inspection.inspected_at,
      head_sha: input.inspection.git.known ? input.inspection.git.value.head_sha : null,
      working_tree_dirty: input.inspection.git.known ? input.inspection.git.value.dirty : null,
      primary_ecosystem: input.inspection.stack.known
        ? input.inspection.stack.value.primary_ecosystem
        : null,
      package_manager: input.inspection.package_manager.known
        ? input.inspection.package_manager.value
        : null,
      build_system: input.inspection.build_system.known ? input.inspection.build_system.value : null,
      dependencies_installed: input.inspection.dependencies_state.known
        ? input.inspection.dependencies_state.value.installed
        : null,
      validation_candidates: input.inspection.validation_command_candidates,
      risks: input.inspection.risks,
    },
    source_anchors: [...anchors.values()],
    constraints: input.intake.constraints,
    planning_contract: {
      schema_version: 1 as const,
      worker_role: 'READ_ONLY_PLANNER' as const,
      output_trust: 'UNTRUSTED_DRAFT' as const,
      acceptance_contract: input.intake.objectives,
      plan_policy: CONTROL_PLANE_PLANNING_POLICY,
      routing_policy: {
        owner: 'CONTROL_PLANE' as const,
        provider_selection: 'OUTSIDE_PLANNER' as const,
      },
      safety_boundaries: {
        exclusions: input.intake.exclusions,
        authorization_scope: input.authorizationScope,
      },
    },
  };

  return PlannerPacket.parse(packet);
}

/**
 * Invocação do planning worker: separa a AUTORIDADE da instrução humana do
 * PACKET estruturado de controle.
 *
 * - `packet` — fatos derivados, bounded e validáveis (identidade, inspeção,
 *   contrato de planejamento). Continua pequeno: o texto humano não entra.
 * - `human_instruction` — o corpo COMPLETO da instrução humana, byte a byte.
 *   Não há bound aqui: o tamanho de input é policy de produto
 *   (`MAX_RUN_DIRECTIVE_BYTES` em `src/intake/run-directive.ts`), aplicada
 *   antes de qualquer persistência — nunca truncation neste contrato.
 *
 * O superRefine amarra as duas partes: o hash no packet precisa ser o hash da
 * instrução entregue, então nenhuma das duas pode ser trocada isoladamente.
 */
export const PlanningWorkerInvocation = z
  .object({
    schema_version: z.literal(1),
    role: z.literal('READ_ONLY_PLANNER'),
    workspace_access: z.literal('READ_ONLY'),
    packet: PlannerPacket,
    human_instruction: z.string().trim().min(1),
    revision: z
      .object({
        attempt: z.literal(2),
        previous_stage: z.enum([
          'SCHEMA_NORMALIZATION',
          'AVC_DECOMPOSITION',
          'DEPENDENCY_VALIDATION',
        ]),
        issues: z.array(z.string().trim().min(1)).min(1),
        requires_complete_replacement: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((invocation, context) => {
    if (humanInstructionSha256(invocation.human_instruction) !== invocation.packet.user_intent.instruction_sha256) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'human_instruction não corresponde ao user_intent.instruction_sha256 do packet: a instrução entregue ao planner divergiu da autoridade',
      });
    }
  });
export type PlanningWorkerInvocation = z.infer<typeof PlanningWorkerInvocation>;

const InvocationIdentity = {
  invocation_id: boundedText(500),
  provider_id: boundedText(200),
  model: boundedText(500),
  /** Profile que de fato produziu este resultado. Ausente em fixtures legados. */
  profile_id: boundedText(200).optional(),
  /** Upstream autoritativo (`providerFactsOf`), não scaffold. */
  upstream_provider: boundedText(200).optional(),
};

export const PlanningWorkerInvocationResult = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('DRAFT_RETURNED'),
      ...InvocationIdentity,
      // `any` evita que Zod estreite `unknown` para `{ } | null` no tipo de
      // saida; o valor continua desconhecido e e parseado somente no gate.
      draft: z.any().refine((value: unknown) => value !== undefined, 'draft e obrigatorio'),
    })
    .strict(),
  z
    .object({
      outcome: z.literal('INVOCATION_FAILED'),
      ...InvocationIdentity,
      failure: z
        .object({
          code: identifier,
          message: boundedText(2_000),
          retryable: z.boolean(),
        })
        .strict(),
    })
    .strict(),
]);
export type PlanningWorkerInvocationResult =
  | {
      readonly outcome: 'DRAFT_RETURNED';
      readonly invocation_id: string;
      readonly provider_id: string;
      readonly model: string;
      readonly profile_id?: string;
      readonly upstream_provider?: string;
      readonly draft: unknown;
    }
  | {
      readonly outcome: 'INVOCATION_FAILED';
      readonly invocation_id: string;
      readonly provider_id: string;
      readonly model: string;
      readonly profile_id?: string;
      readonly upstream_provider?: string;
      readonly failure: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

/** Porta provider-agnostic; launcher, credenciais, quota e processo pertencem ao adapter de M84. */
export interface PlanningWorkerPort {
  invoke(invocation: PlanningWorkerInvocation): Promise<PlanningWorkerInvocationResult>;
}

export const UntrustedPlanDraft = z
  .object({
    schema_version: z.literal(1),
    tasks: z.array(z.unknown()).min(1).max(MAX_PLANNER_TASKS),
  })
  .strict();
export type UntrustedPlanDraft = z.infer<typeof UntrustedPlanDraft>;

export interface DraftIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export type DraftNormalizationResult =
  | { readonly outcome: 'NORMALIZED'; readonly tasks: readonly PlannedTask[] }
  | { readonly outcome: 'INVALID_DRAFT'; readonly issues: readonly DraftIssue[] };

/**
 * Canonicalizacao de METADADO DE PROTOCOLO — nao e reparo de schema.
 *
 * `schema_version` e a unica coisa dentro de uma task que nao e decisao de
 * planejamento: e a versao do protocolo, e ela JA foi validada no envelope
 * externo do draft (`UntrustedPlanDraft.schema_version`). Exigir que um
 * provider a repita, identica, dentro de cada task nao acrescenta informacao
 * nenhuma — so cria um ponto de falha probabilistico. Foi exatamente assim que
 * uma revisao real morreu em SCHEMA_NORMALIZATION: o outer trazia
 * `schema_version: 1`, as 14 tasks omitiam o campo repetido, e nenhum executor
 * chegou a ser lancado.
 *
 * A regra e deliberadamente estreita:
 * - campo AUSENTE num candidato objeto -> propaga a versao externa ja validada;
 * - campo PRESENTE -> passa intacto, e um valor incompativel (`2`, `"1"`)
 *   continua sendo rejeitado por `PlannedTask`.
 *
 * Nenhum outro campo recebe default, alias, coercao ou adivinhacao, e o
 * candidato nunca e mutado: a evidencia crua do provider permanece byte a byte
 * o que ele devolveu.
 */
function canonicalizeTaskProtocolVersion(candidate: unknown, schemaVersion: 1): unknown {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return candidate;
  }
  if (Object.hasOwn(candidate, 'schema_version')) return candidate;
  return { ...candidate, schema_version: schemaVersion };
}

/**
 * Parse estrito, sem defaults e sem reparo: qualquer divergencia e devolvida
 * como rejeicao. A unica excecao e a propagacao deterministica do
 * `schema_version` externo ja validado para uma task que o omite
 * (`canonicalizeTaskProtocolVersion`) — controle de protocolo, nunca conteudo
 * de planejamento.
 */
export function normalizeUntrustedPlanDraft(input: unknown): DraftNormalizationResult {
  const outer = UntrustedPlanDraft.safeParse(input);
  if (!outer.success) {
    return {
      outcome: 'INVALID_DRAFT',
      issues: outer.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    };
  }

  const tasks: PlannedTask[] = [];
  const issues: DraftIssue[] = [];
  for (const [index, candidate] of outer.data.tasks.entries()) {
    const parsed = PlannedTask.safeParse(
      canonicalizeTaskProtocolVersion(candidate, outer.data.schema_version),
    );
    if (parsed.success) {
      tasks.push(parsed.data);
    } else {
      issues.push(
        ...parsed.error.issues.map((issue) => ({
          path: ['tasks', index, ...issue.path],
          message: issue.message,
        })),
      );
    }
  }

  return issues.length === 0 ? { outcome: 'NORMALIZED', tasks } : { outcome: 'INVALID_DRAFT', issues };
}
