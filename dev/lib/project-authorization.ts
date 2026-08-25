/**
 * EXECUTION AUTHORIZATION de uma run de projeto externo.
 *
 * Este arquivo existe para manter separadas duas coisas que o `--profile` de
 * uma CLI historicamente confundia:
 *
 * - WORK DEFINITION — tarefas, acceptance, dependências e validation. Vem do
 *   PlanFile que o usuário forneceu e é tratada como confiável: nada aqui a
 *   reescreve, e nenhum planning worker é chamado para "melhorar" um plano que
 *   o usuário já declarou.
 * - EXECUTION AUTHORIZATION — quais capabilities o control plane pode exercer
 *   sozinho, quais profiles são elegíveis e qual é a política de cobrança.
 *   Vem DESTE arquivo, sempre explícito, nunca inferido do PlanFile nem do
 *   `--profile`.
 *
 * Os contratos de M71/M73 exigem campos que um PlanFile histórico não contém
 * (risco, taxonomy, envelope de recursos). A regra é: derivar apenas o que é
 * determinístico/observável (áreas de contexto, budget de validação, arquivos
 * iniciais) e EXIGIR declaração explícita para o resto. Classificação ausente
 * vira erro estruturado de setup — nunca um default permissivo.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  AutonomousExecutionCapability,
  HumanGatedCapability,
  RequestedScope,
} from '../../src/intake/index.js';
import { TaskBudget, TaskTaxonomy } from '../../src/schemas/task-spec.js';
import { TaskRisk } from '../../src/planner/task.js';
import { RoutingSelectionPolicy } from '../../src/routing/index.js';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'id deve ser alfanumérico com - _ ou .');

/**
 * Classificação declarada de uma work unit. São exatamente as dimensões que o
 * PlanFile não carrega e que M75/M76 exigem — e que o harness NÃO tem direito
 * de adivinhar: risco e ambiguidade declarados por quem conhece o projeto.
 */
export const WorkUnitClassification = z
  .object({
    task_class: TaskTaxonomy.shape.task_class,
    difficulty_declared: TaskTaxonomy.shape.difficulty_declared,
    risk: TaskRisk,
    complexity: TaskTaxonomy.shape.complexity,
    ambiguity: TaskTaxonomy.shape.ambiguity,
    verification: TaskTaxonomy.shape.verification,
    /** Envelope de recursos do worker; alimenta o budget adaptativo de M78. */
    resource_envelope: z
      .object({
        duration_ms: TaskBudget,
        tokens: TaskBudget,
        changed_files: TaskBudget,
      })
      .strict(),
  })
  .strict();
export type WorkUnitClassification = z.infer<typeof WorkUnitClassification>;

/** Override parcial por task: só o que muda em relação ao default declarado. */
const WorkUnitClassificationOverride = WorkUnitClassification.partial().strict();

/**
 * Degrau da policy de profiles. `capability_rank` é a ordem da ladder de
 * escalation de M80 — vem daqui, nunca de heurística sobre nome de modelo.
 */
export const AuthorizedProfile = z
  .object({
    id: identifier,
    capability_rank: z.number().int().nonnegative(),
    rationale: nonEmpty,
  })
  .strict();
export type AuthorizedProfile = z.infer<typeof AuthorizedProfile>;

/**
 * Policy de profiles da run. Um benchmark que precise FIXAR uma metodologia
 * declara um único profile aqui: o control plane continua fazendo inspection,
 * assessment, budget, validação e review, mas não tem para onde escalar — e
 * uma escalation exigida vira `HUMAN_REQUIRED` em vez de ampliar a policy.
 */
export const ProfilePolicy = z
  .object({
    id: identifier,
    profiles: z.array(AuthorizedProfile).min(1),
    allowed_providers: z.array(z.enum(['claude', 'codex', 'fake'])).min(1),
    /**
     * DESEMPATE entre profiles já suficientes — nunca elegibilidade.
     * Ausente preserva `static_cost`, o comportamento histórico. A policy não
     * amplia autorização: um profile fora de `profiles` continua fora, e um
     * profile sem capacidade suficiente continua sendo recusado.
     */
    selection_policy: RoutingSelectionPolicy.default('static_cost'),
  })
  .strict()
  .superRefine((policy, context) => {
    const seen = new Set<string>();
    const ranks = new Set<number>();
    for (const entry of policy.profiles) {
      if (seen.has(entry.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `profile duplicado na policy: ${entry.id}`,
          path: ['profiles'],
        });
      }
      if (ranks.has(entry.capability_rank)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `capability_rank duplicado na policy: ${entry.capability_rank}`,
          path: ['profiles'],
        });
      }
      seen.add(entry.id);
      ranks.add(entry.capability_rank);
    }
  });
export type ProfilePolicy = z.infer<typeof ProfilePolicy>;

/**
 * Contrato completo do arquivo `agentlab-run.yaml`. Estrito: um campo
 * desconhecido é erro de setup, não configuração tolerada em silêncio.
 */
export const ProjectRunAuthorizationFile = z
  .object({
    schema_version: z.literal(1),
    requested_scope: RequestedScope,
    /** Objetivos declarados; ausentes, derivam dos objectives do PlanFile. */
    objectives: z.array(nonEmpty).optional(),
    constraints: z.array(nonEmpty).default([]),
    exclusions: z.array(nonEmpty).default([]),
    autonomous_execution_boundary: z.array(AutonomousExecutionCapability).min(1),
    human_gated_capabilities: z.array(HumanGatedCapability).min(1),
    billing: z
      .object({
        allowed_billing_modes: z
          .array(z.enum(['subscription_only', 'api', 'not_applicable']))
          .min(1),
      })
      .strict(),
    profile_policy: ProfilePolicy,
    review: z
      .object({
        /** Profile do reviewer; ausente, o control plane usa o implementer. */
        reviewer_profile_id: identifier.optional(),
      })
      .strict()
      .default({}),
    work_units: z
      .object({
        default: WorkUnitClassification,
        overrides: z.record(WorkUnitClassificationOverride).default({}),
      })
      .strict(),
  })
  .strict()
  .superRefine((file, context) => {
    if (file.billing.allowed_billing_modes.includes('api')) {
      // Cobrança por API é human-gated por contrato; autorizá-la num arquivo
      // de run seria exatamente a inferência que M73 proíbe.
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'billing.allowed_billing_modes não pode conter api: cobrança por API é human-gated',
        path: ['billing', 'allowed_billing_modes'],
      });
    }
    const reviewer = file.review.reviewer_profile_id;
    if (reviewer !== undefined && !file.profile_policy.profiles.some((entry) => entry.id === reviewer)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `review.reviewer_profile_id ${reviewer} não pertence à profile policy`,
        path: ['review', 'reviewer_profile_id'],
      });
    }
  });
export type ProjectRunAuthorizationFile = z.infer<typeof ProjectRunAuthorizationFile>;

/** Falha de setup da autorização: nenhum provider, attempt ou state novo. */
export class ProjectAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectAuthorizationError';
  }
}

export interface LoadedProjectRunAuthorization {
  readonly file: ProjectRunAuthorizationFile;
  readonly source_file: string;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Carrega e valida o arquivo de autorização. Qualquer problema é recusa
 * explícita ANTES de qualquer efeito — nunca autorização parcial.
 */
export async function loadProjectRunAuthorization(
  file: string,
): Promise<LoadedProjectRunAuthorization> {
  const resolved = path.resolve(file);
  let raw: string;
  try {
    raw = await readFile(resolved, 'utf8');
  } catch (error) {
    const detail =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'arquivo inexistente'
        : error instanceof Error
          ? error.message
          : String(error);
    throw new ProjectAuthorizationError(
      `arquivo de autorização ilegível em ${resolved}: ${detail}\n` +
        'Nenhum state autoritativo foi criado. Nenhum provider foi chamado.\n' +
        'Ação segura: informar --authorization apontando para um agentlab-run.yaml válido.',
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    throw new ProjectAuthorizationError(
      `YAML inválido em ${resolved}: ${error instanceof Error ? error.message : String(error)}\n` +
        'Nenhum provider foi chamado.',
    );
  }

  const result = ProjectRunAuthorizationFile.safeParse(parsed);
  if (!result.success) {
    throw new ProjectAuthorizationError(
      `autorização inválida em ${resolved}: ${describeIssues(result.error)}\n` +
        'Nenhum attempt foi consumido. Nenhum provider foi chamado.\n' +
        'Ação segura: corrigir o contrato de autorização e rerodar.',
    );
  }
  return { file: result.data, source_file: resolved };
}

/**
 * Classificação efetiva de uma work unit: default da run mais o override
 * declarado para aquela task. Ausência de override não é ausência de fato — o
 * default é uma declaração explícita do operador, não um preenchimento do
 * harness.
 */
export function classificationFor(
  file: ProjectRunAuthorizationFile,
  taskId: string,
): { readonly classification: WorkUnitClassification; readonly provenance: string } {
  const override = file.work_units.overrides[taskId];
  if (override === undefined) {
    return {
      classification: file.work_units.default,
      provenance: 'authorization.work_units.default',
    };
  }
  return {
    classification: WorkUnitClassification.parse({ ...file.work_units.default, ...override }),
    provenance: `authorization.work_units.default + overrides.${taskId}`,
  };
}
