import { z } from 'zod';
import {
  MAXIMUM_HANDOFF_BYTES,
  MAXIMUM_TASK_PACKET_BYTES,
  assertByteBudget,
  byteSize,
} from './budget.js';

export const DEV_SCHEMA_VERSION = 1;

/**
 * Estados do harness — SOMENTE estes (plano, seção "Protocolo de sessões
 * descartáveis"). Uma tarefa ainda não iniciada fica `READY`; a elegibilidade
 * ("dependências PASS") é derivada do plano, não armazenada como estado.
 */
export const TASK_STATUSES = [
  'READY',
  'RUNNING',
  'PASS',
  'FAIL',
  'TIMED_OUT',
  'MISSCOPED',
  'INFRA_ERROR',
] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Fase operacional só existe dentro de RUNNING. */
export const TaskPhase = z.enum(['EXECUTING', 'FINALIZING']);
export type TaskPhase = z.infer<typeof TaskPhase>;

/** Estados terminais que PARAM o fluxo do orquestrador. */
export const BLOCKING_STATUSES: readonly TaskStatus[] = [
  'FAIL',
  'TIMED_OUT',
  'MISSCOPED',
  'INFRA_ERROR',
];

const nonEmpty = z.string().min(1);
const identifier = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'id deve ser alfanumérico com - ou _');
const shaHex = z.string().regex(/^[0-9a-f]{40}$/, 'esperado SHA-1 de commit em hex minúsculo');

// ---------------------------------------------------------------------------
// Validação estruturada: argv, nunca shell — precisa ser re-executável pelo
// dev-close exatamente como o worker recebeu.
// ---------------------------------------------------------------------------

export const ValidationCommand = z
  .object({
    argv: z.array(nonEmpty).min(1),
    timeout_seconds: z.number().int().positive().max(3_600),
  })
  .strict();
export type ValidationCommand = z.infer<typeof ValidationCommand>;

export const ValidationResult = z
  .object({
    argv: z.array(nonEmpty).min(1),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict();
export type ValidationResult = z.infer<typeof ValidationResult>;

// ---------------------------------------------------------------------------
// dev/plan.yaml — definição versionada e autoritativa das tarefas
// ---------------------------------------------------------------------------

export const PlanTask = z
  .object({
    id: identifier,
    title: nonEmpty,
    blocked_by: z.array(identifier).default([]),
    objective: nonEmpty,
    initial_files: z.array(nonEmpty).default([]),
    acceptance: z.array(nonEmpty).min(1),
    validation: z.array(ValidationCommand).min(1),
    constraints: z.array(nonEmpty).default([]),
    include_previous_handoff: z.boolean().default(false),
  })
  .strict();
export type PlanTask = z.infer<typeof PlanTask>;

export const PlanFile = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    tasks: z.array(PlanTask).min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (const task of plan.tasks) {
      if (seen.has(task.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `id duplicado: ${task.id}` });
      }
      seen.add(task.id);
    }
    for (const task of plan.tasks) {
      for (const dependency of task.blocked_by) {
        if (!seen.has(dependency)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${task.id} depende de tarefa inexistente: ${dependency}`,
          });
        }
        if (dependency === task.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${task.id} depende de si mesma`,
          });
        }
      }
    }
  });
export type PlanFile = z.infer<typeof PlanFile>;

// ---------------------------------------------------------------------------
// Handoff — draft do worker, record selado pelo orquestrador. Ambos ≤ 4 KiB.
// ---------------------------------------------------------------------------

const handoffBody = {
  schema_version: z.literal(DEV_SCHEMA_VERSION),
  task_id: identifier,
  result: z.enum(['PASS', 'FAIL']),
  changed_files: z.array(nonEmpty).max(50),
  validations: z.array(ValidationResult).max(20),
  decisions: z.array(nonEmpty).max(5),
  lessons: z.array(nonEmpty).max(3),
  next_relevant_files: z.array(nonEmpty).max(5),
};

/** O worker NÃO sabe se o commit foi aceito — por isso não há accepted_commit. */
export const HandoffDraft = z.object(handoffBody).strict();
export type HandoffDraft = z.infer<typeof HandoffDraft>;

/** Selado pelo orquestrador; só aqui existe accepted_commit. */
export const HandoffRecord = z
  .object({ ...handoffBody, accepted_commit: shaHex, sealed_at: z.string().datetime() })
  .strict();
export type HandoffRecord = z.infer<typeof HandoffRecord>;

// ---------------------------------------------------------------------------
// TaskPacket — a ÚNICA entrada do worker. ≤ 12 KiB.
// ---------------------------------------------------------------------------

export const TaskPacket = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    title: nonEmpty,
    objective: nonEmpty,
    base_sha: shaHex,
    initial_files: z.array(nonEmpty),
    acceptance: z.array(nonEmpty).min(1),
    validation: z.array(ValidationCommand).min(1),
    constraints: z.array(nonEmpty),
    previous_handoff: HandoffRecord.nullable(),
    generated_at: z.string().datetime(),
  })
  .strict();
export type TaskPacket = z.infer<typeof TaskPacket>;

// ---------------------------------------------------------------------------
// Autoria dividida: report é do worker, evidence é do orquestrador.
// ---------------------------------------------------------------------------

export const AgentCompletionReport = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    self_reported_result: z.enum(['SUCCESS', 'FAILURE']),
    summary: nonEmpty,
    candidate_commit: shaHex.nullable(),
    changed_files: z.array(nonEmpty).max(50),
    validations: z.array(ValidationResult).max(20),
    decisions: z.array(nonEmpty).max(5),
    lessons: z.array(nonEmpty).max(3),
    relevant_files: z.array(nonEmpty).max(5),
  })
  .strict();
export type AgentCompletionReport = z.infer<typeof AgentCompletionReport>;

/** Identidade de processo além do PID — PID é reutilizável pelo kernel. */
export const ProcessIdentity = z
  .object({
    pid: z.number().int().positive(),
    pgid: z.number().int().positive(),
    started_at: z.string().datetime(),
    proc_start_ticks: z.number().int().nonnegative(),
    command_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ProcessIdentity = z.infer<typeof ProcessIdentity>;

/**
 * O que o launcher observou do processo do worker. Escrito pelo dev-launch e
 * lido pelo dev-close — o worker não tem acesso a esses fatos sobre si mesmo.
 */
export const LaunchRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    profile_id: nonEmpty,
    argv: z.array(nonEmpty).min(1),
    process: ProcessIdentity,
    started_at: z.string().datetime(),
    finished_at: z.string().datetime().nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    /** O que o perfil conseguiu de fato controlar — não o que pretendia. */
    controlled: z.record(z.union([z.boolean(), z.string(), z.number()])),
  })
  .strict();
export type LaunchRecord = z.infer<typeof LaunchRecord>;

export const OrchestratorEvidence = z
  .object({
    task_id: identifier,
    base_sha: shaHex,
    candidate_commit: shaHex.nullable(),
    accepted_commit: shaHex.nullable(),
    changed_files: z.array(nonEmpty),
    working_tree_clean: z.boolean(),
    process: ProcessIdentity.nullable(),
    duration_ms: z.number().int().nonnegative(),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    revalidation: z.array(ValidationResult),
    observed_at: z.string().datetime(),
  })
  .strict();
export type OrchestratorEvidence = z.infer<typeof OrchestratorEvidence>;

export const CompletionRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    status: TaskStatus,
    report: AgentCompletionReport.nullable(),
    orchestrator_evidence: OrchestratorEvidence,
    report_matches_evidence: z.boolean(),
    discrepancies: z.array(nonEmpty),
    closed_at: z.string().datetime(),
  })
  .strict();
export type CompletionRecord = z.infer<typeof CompletionRecord>;

// ---------------------------------------------------------------------------
// Estado de runtime (.dev/state.json) — NÃO versionado
// ---------------------------------------------------------------------------

export const TaskState = z
  .object({
    id: identifier,
    status: TaskStatus,
    phase: TaskPhase.nullable(),
    attempts: z.number().int().nonnegative(),
    process: ProcessIdentity.nullable(),
    base_sha: shaHex.nullable(),
    candidate_commit: shaHex.nullable(),
    accepted_commit: shaHex.nullable(),
    diagnostics: z.string().nullable(),
    started_at: z.string().datetime().nullable(),
    finished_at: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((task, ctx) => {
    if (task.status === 'RUNNING' && task.phase === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${task.id}: RUNNING exige phase` });
    }
    if (task.status !== 'RUNNING' && task.phase !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${task.id}: phase só existe dentro de RUNNING`,
      });
    }
    if (task.status === 'PASS' && task.accepted_commit === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${task.id}: PASS exige accepted_commit`,
      });
    }
    if (task.accepted_commit !== null && task.status !== 'PASS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${task.id}: accepted_commit só é promovido em PASS`,
      });
    }
  });
export type TaskState = z.infer<typeof TaskState>;

export const DevelopmentState = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    plan_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    tasks: z.array(TaskState).min(1),
  })
  .strict();
export type DevelopmentState = z.infer<typeof DevelopmentState>;

// ---------------------------------------------------------------------------
// Parsers com budget — schema válido mas acima do budget também é rejeição.
// ---------------------------------------------------------------------------

export function parseTaskPacket(input: unknown): TaskPacket {
  const packet = TaskPacket.parse(input);
  assertByteBudget('TaskPacket', packet, MAXIMUM_TASK_PACKET_BYTES);
  return packet;
}

export function parseHandoffDraft(input: unknown): HandoffDraft {
  const draft = HandoffDraft.parse(input);
  assertByteBudget('HandoffDraft', draft, MAXIMUM_HANDOFF_BYTES);
  return draft;
}

export function parseHandoffRecord(input: unknown): HandoffRecord {
  const record = HandoffRecord.parse(input);
  assertByteBudget('HandoffRecord', record, MAXIMUM_HANDOFF_BYTES);
  return record;
}

export { MAXIMUM_HANDOFF_BYTES, MAXIMUM_TASK_PACKET_BYTES, byteSize };
