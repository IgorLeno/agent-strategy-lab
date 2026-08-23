import { z } from 'zod';

import { TaskBudget, TaskBudgets, TaskTaxonomy } from '../schemas/task-spec.js';

const nonEmpty = z.string().trim().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');

/**
 * Risco de execução da task. Dimensão NOVA — não existe em TaskSpec nem em
 * TaskTaxonomy, e vive somente aqui para manter os dois contratos históricos
 * inalterados (evidência recomputável).
 */
export const TaskRisk = z.enum(['low', 'medium', 'high', 'critical']);
export type TaskRisk = z.infer<typeof TaskRisk>;

/**
 * Comando de validação declarado pelo planner. O par `{argv, timeout_seconds}`
 * espelha deliberadamente o formato usado pelo harness (`packet.validation`)
 * — duplicação mínima imposta pela fronteira de build entre `src/` e o
 * runtime do orquestrador; a compatibilidade entre os dois formatos é
 * provada em M83, não aqui. `argv` nunca é uma linha de shell.
 */
export const ValidationCommand = z
  .object({
    argv: z.array(nonEmpty).min(1),
    timeout_seconds: z.number().int().positive(),
  })
  .strict();
export type ValidationCommand = z.infer<typeof ValidationCommand>;

/** Fronteira declarada do contexto necessário — áreas do repositório, nunca conteúdo. */
export const ContextScope = z
  .object({
    areas: z.array(nonEmpty).min(1),
  })
  .strict();
export type ContextScope = z.infer<typeof ContextScope>;

/**
 * Um requisito de contexto ancorado numa fonte concreta do repositório.
 * `source_anchor` é sempre um caminho real, nunca uma referência solta —
 * é o que permite montar contexto proporcional depois sem adivinhar onde
 * procurar.
 */
export const ContextRequirement = z
  .object({
    description: nonEmpty,
    source_anchor: nonEmpty,
  })
  .strict();
export type ContextRequirement = z.infer<typeof ContextRequirement>;

/**
 * Requisito de ambiente na forma PLANEJADA — comparável, por forma, aos
 * fatos observados por `RequiredTool`/`RequiredService` em
 * `src/inspection/index.ts` (nome + motivo), mas um tipo próprio: aqui é o
 * que o planner espera que seja necessário, não o que a inspeção
 * efetivamente observou no repositório clonado.
 */
export const EnvironmentRequirement = z
  .object({
    kind: z.enum(['tool', 'service']),
    name: nonEmpty,
    reason: nonEmpty,
  })
  .strict();
export type EnvironmentRequirement = z.infer<typeof EnvironmentRequirement>;

/**
 * Contrato formal de uma task produzida pelo planner. Strict e versionado.
 *
 * Composição, não duplicação:
 * - `taxonomy` é o `TaskTaxonomy` v1 existente, entrando verbatim.
 * - `resource_envelope` é o `TaskBudgets` existente, reusado tal como está —
 *   ele já oferece expected/maximum por task para duration_ms, tokens e
 *   changed_files, que é exatamente o envelope adaptativo necessário. Não
 *   existe aqui nenhum contrato de budget paralelo.
 * - `risk` é a única dimensão nova; não altera TaskSpec, TaskTaxonomy nem os
 *   schemas de performance.
 *
 * Três conceitos de tempo distintos, cada um com o seu próprio bound —
 * nenhum colapsa nos outros:
 * 1. `estimated_duration` — estimativa de duração da task inteira, tal como
 *    planejada (específica desta task; não existe teto universal).
 * 2. `resource_envelope.duration_ms` — o envelope de recursos do runtime do
 *    worker, do qual M78 deriva depois o limite concreto do processo. É
 *    matéria-prima para o worker runtime budget, não o budget em si.
 * 3. `validation[].timeout_seconds` — o limite de UM comando de validação
 *    individual, em segundos, no formato do harness.
 *
 * `validation_budget` é um quarto conceito, ortogonal aos três acima: o
 * custo/budget esperado de RODAR toda a suíte de validação (agregado, não
 * por comando) — permite orçar validação sem confundir com o tempo de
 * implementação (`estimated_duration`) nem com o teto por comando
 * (`validation[].timeout_seconds`).
 *
 * `acceptance` e `validation` são obrigatórios e não vazios: uma task sem
 * critério de aceite ou sem comando de validação não é uma task planejada,
 * é um rascunho.
 */
export const PlannedTask = z
  .object({
    schema_version: z.literal(1),
    task_id: identifier,
    /** Objetivo único da task — o contrato não aceita lista de objetivos. */
    objective: nonEmpty,
    blocked_by: z.array(identifier),
    taxonomy: TaskTaxonomy,
    risk: TaskRisk,
    acceptance: z.array(nonEmpty).min(1),
    validation: z.array(ValidationCommand).min(1),
    initial_files: z.array(nonEmpty),
    probable_files: z.array(nonEmpty),
    context_scope: ContextScope,
    context_requirements: z.array(ContextRequirement),
    environment_requirements: z.array(EnvironmentRequirement),
    estimated_duration: TaskBudget,
    validation_budget: TaskBudget,
    resource_envelope: TaskBudgets,
  })
  .strict()
  .superRefine((task, context) => {
    if (task.estimated_duration.expected > task.estimated_duration.maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expected não pode exceder maximum em estimated_duration',
        path: ['estimated_duration', 'expected'],
      });
    }
    if (task.validation_budget.expected > task.validation_budget.maximum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expected não pode exceder maximum em validation_budget',
        path: ['validation_budget', 'expected'],
      });
    }
  });
export type PlannedTask = z.infer<typeof PlannedTask>;

/**
 * Subconjunto do contrato de planejamento que precisa SOBREVIVER à projeção
 * do plano para o PlanFile executável. Sem ele, a classificação por task que
 * o planner produziu (taxonomy, risco, envelope, pressão de contexto) é
 * descartada e a execução recria tudo a partir de um default global — o
 * routing econômico se perde e uma task easy/local passa a custar o mesmo que
 * uma hard/subsystem.
 *
 * É deliberadamente uma PROJEÇÃO de `PlannedTask`, não um contrato paralelo:
 * cada campo reusa o schema já declarado acima.
 */
export const PlannerTaskMetadata = z
  .object({
    taxonomy: TaskTaxonomy,
    risk: TaskRisk,
    probable_files: z.array(nonEmpty),
    context_scope: ContextScope,
    context_requirements: z.array(ContextRequirement),
    environment_requirements: z.array(EnvironmentRequirement),
    estimated_duration: TaskBudget,
    validation_budget: TaskBudget,
    resource_envelope: TaskBudgets,
  })
  .strict();
export type PlannerTaskMetadata = z.infer<typeof PlannerTaskMetadata>;
