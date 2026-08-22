import { z } from 'zod';
import {
  MAXIMUM_HANDOFF_BYTES,
  MAXIMUM_TASK_PACKET_BYTES,
  assertByteBudget,
  byteSize,
} from './budget.js';
import { ExecutionPolicy, LEGACY_EXECUTION_POLICY } from './execution-policy.js';

/**
 * Versão dos records do harness (PlanFile, TaskPacket, completions, ...).
 * O handoff NÃO usa este número: ele tem versionamento próprio
 * (`HANDOFF_SCHEMA_VERSION`), para que evoluir o contrato de handoff não
 * redefina a semântica de tudo o mais.
 */
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

/**
 * Evidence externa de uma validação oficial. Os streams continuam fora dos
 * records estruturados; aqui ficam somente localização, tamanho e digest.
 */
export const ValidationEvidence = ValidationResult.extend({
  sequence: z.number().int().positive(),
  stdout_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  stderr_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  stdout_bytes: z.number().int().nonnegative(),
  stderr_bytes: z.number().int().nonnegative(),
  stdout_path: nonEmpty,
  stderr_path: nonEmpty,
}).strict();
export type ValidationEvidence = z.infer<typeof ValidationEvidence>;

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

/**
 * O plano precisa ser um DAG. Um ciclo não gera erro em lugar nenhum: o
 * seletor simplesmente nunca encontra tarefa elegível e o harness fica
 * `BLOCKED` para sempre, sem dizer por quê. Melhor recusar no carregamento.
 *
 * DFS com marcação em progresso; devolve o caminho do primeiro ciclo achado,
 * que é o que torna a mensagem acionável.
 */
function findDependencyCycle(tasks: readonly PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const settled = new Set<string>();
  const inProgress: string[] = [];

  function visit(id: string): string[] | null {
    const position = inProgress.indexOf(id);
    if (position >= 0) return [...inProgress.slice(position), id];
    if (settled.has(id)) return null;

    inProgress.push(id);
    for (const dependency of byId.get(id)?.blocked_by ?? []) {
      // Dependência inexistente já vira issue própria; aqui só não se navega.
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    inProgress.pop();
    settled.add(id);
    return null;
  }

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle) return cycle;
  }
  return null;
}

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
    const cycle = findDependencyCycle(plan.tasks);
    if (cycle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ciclo de dependências no plano: ${cycle.join(' -> ')}`,
      });
    }
  });
export type PlanFile = z.infer<typeof PlanFile>;

// ---------------------------------------------------------------------------
// Handoff — draft do worker, record selado pelo orquestrador. Ambos ≤ 4 KiB.
//
// O handoff versiona SOZINHO. `DEV_SCHEMA_VERSION` continua descrevendo
// PlanFile, TaskPacket e os demais records: subir aquele número para evoluir
// este contrato redefiniria a semântica de tudo que nunca mudou. Por isso
// existem V1 e V2 lado a lado, e um reader que aceita os dois — handoff v1
// persistido continua legítimo, sem migração e sem campo fabricado.
// ---------------------------------------------------------------------------

export const HANDOFF_SCHEMA_VERSION_V1 = 1;
export const HANDOFF_SCHEMA_VERSION_V2 = 2;
/** Versão de toda escrita NOVA. Ler v1 continua sendo obrigação permanente. */
export const HANDOFF_SCHEMA_VERSION = HANDOFF_SCHEMA_VERSION_V2;

/** Records do harness que uma referência de evidência pode apontar. */
export const HANDOFF_EVIDENCE_RECORD_KINDS = [
  'validation',
  'completion',
  'handoff',
  'finalization',
  'review',
  'launch',
  'revalidation',
] as const;
export const HandoffEvidenceRecordKind = z.enum(HANDOFF_EVIDENCE_RECORD_KINDS);
export type HandoffEvidenceRecordKind = z.infer<typeof HandoffEvidenceRecordKind>;

/** Afirmação do worker SOBRE a referência — curta, e nunca o conteúdo dela. */
const evidenceClaim = z.string().min(1).max(160);
/** "120" ou "120-148": o intervalo, jamais as linhas em si. */
const evidenceLineRange = z
  .string()
  .regex(/^[1-9]\d*(-[1-9]\d*)?$/, 'lines deve ser "N" ou "N-M" com N,M ≥ 1');

/**
 * Evidência é PONTEIRO, não payload. Cada tipo de referência tem forma
 * própria — arquivo com caminho e intervalo, comando com argv, record com
 * task/attempt — justamente para que "evidência" não vire uma string livre
 * que só parece tipada. Conteúdo de arquivo, diff, stdout, stderr e
 * transcript continuam fora do handoff: quem quer os fatos abre a fonte.
 */
const handoffEvidenceVariants = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('file'),
      path: z.string().min(1).max(200),
      lines: evidenceLineRange.optional(),
      claim: evidenceClaim,
    })
    .strict(),
  z
    .object({
      kind: z.literal('command'),
      argv: z.array(nonEmpty).min(1).max(8),
      claim: evidenceClaim,
    })
    .strict(),
  z
    .object({
      kind: z.literal('record'),
      record_kind: HandoffEvidenceRecordKind,
      task_id: identifier,
      attempt: z.number().int().positive().optional(),
      claim: evidenceClaim,
    })
    .strict(),
]);

export const HandoffEvidenceReference = handoffEvidenceVariants.superRefine((reference, ctx) => {
  if (reference.kind !== 'file' || reference.lines === undefined) return;
  const [start, end] = reference.lines.split('-').map(Number);
  if (end !== undefined && end < (start as number)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `intervalo de linhas invertido: ${reference.lines}`,
    });
  }
});
export type HandoffEvidenceReference = z.infer<typeof HandoffEvidenceReference>;

// ---------------------------------------------------------------------------
// Confidence — opinião do worker, lida pessimistamente pelo harness.
// ---------------------------------------------------------------------------

export const HANDOFF_CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;
export const HandoffConfidenceLevel = z.enum(HANDOFF_CONFIDENCE_LEVELS);
export type HandoffConfidenceLevel = z.infer<typeof HandoffConfidenceLevel>;

export interface HandoffConfidenceReading {
  readonly level: HandoffConfidenceLevel;
  /** Sempre o worker: nenhum nível de confiança nasce de evidência do harness. */
  readonly source: 'worker_statement';
  /** Marcadores reconhecidos, na ordem da tabela — a leitura é auditável. */
  readonly markers: readonly string[];
}

interface ConfidenceMarker {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Tabela ÚNICA e ordenada. Sem modelo, sem heurística escondida: a mesma
 * frase produz sempre o mesmo nível, e a lista de marcadores explica por quê.
 */
const CONFIDENCE_NEGATION_MARKERS: readonly ConfidenceMarker[] = [
  { name: 'negation:pt', pattern: /\b(nao|nem|nunca|sem)\b/ },
  { name: 'negation:en', pattern: /\b(not|no|never|without|cannot|cant|couldnt|didnt|wasnt)\b/ },
];

const CONFIDENCE_LOW_MARKERS: readonly ConfidenceMarker[] = [
  { name: 'low:pt', pattern: /\b(baixa|baixo|incerto|incerta|inseguro|insegura|duvid\w*|fragil|arriscad\w*|risco)\b/ },
  { name: 'low:en', pattern: /\b(low|uncertain|unsure|shaky|fragile|risky|risk|doubt\w*)\b/ },
];

const CONFIDENCE_HEDGE_MARKERS: readonly ConfidenceMarker[] = [
  { name: 'hedge:pt', pattern: /\b(talvez|acho|creio|parece|aparentemente|provavel\w*|possivel\w*|deve|deveria|presumo|suponho|em geral|na maior parte)\b/ },
  { name: 'hedge:en', pattern: /\b(maybe|perhaps|think|believe|seems|apparently|probably|possibly|should|likely|mostly|assume|assuming|guess)\b/ },
];

const CONFIDENCE_MEDIUM_MARKERS: readonly ConfidenceMarker[] = [
  { name: 'medium:pt', pattern: /\b(media|medio|moderad\w*|parcial\w*|razoavel)\b/ },
  { name: 'medium:en', pattern: /\b(medium|moderate|partial\w*|reasonable)\b/ },
];

const CONFIDENCE_HIGH_MARKERS: readonly ConfidenceMarker[] = [
  { name: 'high:pt', pattern: /\b(alta|alto|certeza|certo|confiante|confianca|verificad\w*|comprovad\w*|totalmente|plenamente)\b/ },
  { name: 'high:en', pattern: /\b(high|certain|sure|confident|confidence|verified|proven|fully|thoroughly)\b/ },
];

function normalizeConfidenceStatement(statement: string): string {
  return statement
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['´`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function matched(text: string, markers: readonly ConfidenceMarker[]): readonly string[] {
  return markers.filter((marker) => marker.pattern.test(text)).map((marker) => marker.name);
}

/**
 * Leitura LENIENTE na entrada e PESSIMISTA na saída. Aceita a frase que o
 * worker escreveu, mas nunca a lê para cima: negação, hedge e ambiguidade
 * derrubam o nível, e texto irreconhecível é UNKNOWN — jamais HIGH por
 * omissão. Confidence continua sendo opinião: esta função só declara como o
 * harness a lê, nunca promove a frase a fato.
 */
export function readHandoffConfidence(statement: string | undefined): HandoffConfidenceReading {
  if (statement === undefined || statement.trim() === '') {
    return { level: 'UNKNOWN', source: 'worker_statement', markers: [] };
  }
  const text = normalizeConfidenceStatement(statement);
  const negation = matched(text, CONFIDENCE_NEGATION_MARKERS);
  const low = matched(text, CONFIDENCE_LOW_MARKERS);
  const hedge = matched(text, CONFIDENCE_HEDGE_MARKERS);
  const medium = matched(text, CONFIDENCE_MEDIUM_MARKERS);
  const high = matched(text, CONFIDENCE_HIGH_MARKERS);
  const markers = [...negation, ...low, ...hedge, ...medium, ...high];

  if (negation.length > 0 || low.length > 0) {
    return { level: 'LOW', source: 'worker_statement', markers };
  }
  if (hedge.length > 0 || medium.length > 0) {
    return { level: 'MEDIUM', source: 'worker_statement', markers };
  }
  if (high.length > 0) {
    return { level: 'HIGH', source: 'worker_statement', markers };
  }
  return { level: 'UNKNOWN', source: 'worker_statement', markers };
}

// ---------------------------------------------------------------------------

/** Campos que v1 e v2 compartilham, com a MESMA semântica. */
const handoffCommonBody = {
  task_id: identifier,
  result: z.enum(['PASS', 'FAIL']),
  changed_files: z.array(nonEmpty).max(50),
  validations: z.array(ValidationResult).max(20),
  decisions: z.array(nonEmpty).max(5),
  lessons: z.array(nonEmpty).max(3),
  next_relevant_files: z.array(nonEmpty).max(5),
};

const handoffV2Body = {
  ...handoffCommonBody,
  /** Referências à evidência; nunca a evidência. Opcional = não declarada. */
  evidence: z.array(HandoffEvidenceReference).max(8).optional(),
  /** Opcional: ausente significa "não registrado", nunca "não existe". */
  open_questions: z.array(nonEmpty).max(5).optional(),
  /**
   * OBRIGATÓRIO no draft v2. A distinção é o contrato inteiro:
   *   ausente → protocolo inválido (o worker não respondeu à pergunta)
   *   []      → o worker afirma POSITIVAMENTE não ter identificado nenhuma
   *             verificação relevante deixada de fora
   *   [item]  → o worker reconhece explicitamente uma lacuna
   * Nenhum leitor pode normalizar ausência para lista vazia.
   */
  what_i_did_not_check: z.array(nonEmpty).max(5),
  /** Nas palavras do worker. O nível é DERIVADO por `readHandoffConfidence`. */
  confidence: z.string().min(1).max(200).optional(),
};

const sealedBody = { accepted_commit: shaHex, sealed_at: z.string().datetime() };

/** O worker NÃO sabe se o commit foi aceito — por isso não há accepted_commit. */
export const HandoffDraftV1 = z
  .object({ schema_version: z.literal(HANDOFF_SCHEMA_VERSION_V1), ...handoffCommonBody })
  .strict();
export type HandoffDraftV1 = z.infer<typeof HandoffDraftV1>;

export const HandoffDraftV2 = z
  .object({ schema_version: z.literal(HANDOFF_SCHEMA_VERSION_V2), ...handoffV2Body })
  .strict();
export type HandoffDraftV2 = z.infer<typeof HandoffDraftV2>;

/** Selado pelo orquestrador; só aqui existe accepted_commit. */
export const HandoffRecordV1 = z
  .object({ schema_version: z.literal(HANDOFF_SCHEMA_VERSION_V1), ...handoffCommonBody, ...sealedBody })
  .strict();
export type HandoffRecordV1 = z.infer<typeof HandoffRecordV1>;

export const HandoffRecordV2 = z
  .object({ schema_version: z.literal(HANDOFF_SCHEMA_VERSION_V2), ...handoffV2Body, ...sealedBody })
  .strict();
export type HandoffRecordV2 = z.infer<typeof HandoffRecordV2>;

/** Leitores: toda leitura do harness aceita as duas versões, sem migração. */
export const HandoffDraftReader = z.discriminatedUnion('schema_version', [
  HandoffDraftV1,
  HandoffDraftV2,
]);
export const HandoffRecordReader = z.discriminatedUnion('schema_version', [
  HandoffRecordV1,
  HandoffRecordV2,
]);

export const HandoffDraft = HandoffDraftReader;
export type HandoffDraft = z.infer<typeof HandoffDraftReader>;

export const HandoffRecord = HandoffRecordReader;
export type HandoffRecord = z.infer<typeof HandoffRecordReader>;

export function isHandoffDraftV2(draft: HandoffDraft): draft is HandoffDraftV2 {
  return draft.schema_version === HANDOFF_SCHEMA_VERSION_V2;
}

export function isHandoffRecordV2(record: HandoffRecord): record is HandoffRecordV2 {
  return record.schema_version === HANDOFF_SCHEMA_VERSION_V2;
}

/**
 * Fatos que SÓ o orquestrador pode originar. Nenhum deles vem do draft: o
 * worker não sabe o que foi commitado, o que a validação oficial devolveu nem
 * se a mudança foi aceita. Eles chegam aqui derivados de change bundle,
 * ValidationEvidence e do commit — nunca do self-report.
 */
export interface SealedHandoffFacts {
  readonly task_id: string;
  readonly result: 'PASS' | 'FAIL';
  readonly changed_files: readonly string[];
  readonly validations: readonly ValidationResult[];
  readonly accepted_commit: string;
  readonly sealed_at: string;
}

/**
 * Selamento ÚNICO do handoff — a fronteira de autoria mora aqui, e não
 * replicada em cada caminho de fechamento.
 *
 *   worker      → decisions, lessons, next_relevant_files, evidence,
 *                 open_questions, what_i_did_not_check, confidence
 *   orquestrador→ task_id, result, changed_files, validations,
 *                 accepted_commit, sealed_at
 *
 * O record é montado CAMPO A CAMPO, nunca por spread do draft: um worker que
 * escreva changed_files ou validations diferentes da evidência não desloca
 * nada, porque esses campos não são lidos do draft em lugar nenhum.
 *
 * `evidence` sobrevive como o que é — CLAIM do worker com uma referência.
 * Nada aqui a promove a evidência verificada: a evidência oficial continua
 * sendo `validations`/ValidationEvidence, derivada pelo orquestrador.
 *
 * Draft v1 sela record v1; draft v2 sela record v2. Um handoff v1 não ganha
 * campo v2 nenhum — o fluxo histórico permanece byte-compatível.
 */
export function sealHandoff(draft: HandoffDraft, facts: SealedHandoffFacts): HandoffRecord {
  const derived = {
    task_id: facts.task_id,
    result: facts.result,
    changed_files: [...facts.changed_files],
    validations: [...facts.validations],
    accepted_commit: facts.accepted_commit,
    sealed_at: facts.sealed_at,
  };
  const opinion = {
    decisions: draft.decisions,
    lessons: draft.lessons,
    next_relevant_files: draft.next_relevant_files,
  };

  if (!isHandoffDraftV2(draft)) {
    return HandoffRecordV1.parse({
      schema_version: HANDOFF_SCHEMA_VERSION_V1,
      ...derived,
      ...opinion,
    });
  }
  return HandoffRecordV2.parse({
    schema_version: HANDOFF_SCHEMA_VERSION_V2,
    ...derived,
    ...opinion,
    // Ausente no draft continua ausente no record: UNKNOWN não vira [].
    ...(draft.evidence === undefined ? {} : { evidence: draft.evidence }),
    ...(draft.open_questions === undefined ? {} : { open_questions: draft.open_questions }),
    what_i_did_not_check: draft.what_i_did_not_check,
    ...(draft.confidence === undefined ? {} : { confidence: draft.confidence }),
  });
}

// ---------------------------------------------------------------------------
// TaskPacket — a ÚNICA entrada do worker. ≤ 12 KiB.
// ---------------------------------------------------------------------------

/**
 * O que um attempt de reparo sabe do attempt anterior. Tudo aqui é DERIVADO
 * pelo orquestrador a partir de records selados — nunca transcript, raciocínio
 * ou conversa do provider anterior. Um FAIL legítimo precisa dizer ao próximo
 * worker o que falhou, sem reintroduzir contexto pela porta dos fundos.
 */
export const PreviousAttemptFailedValidation = z
  .object({
    argv: z.array(nonEmpty).min(1),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    /** Caminho do log oficial, relativo ao devDir; ausente em record legado. */
    stdout_path: nonEmpty.optional(),
    stderr_path: nonEmpty.optional(),
  })
  .strict();
export type PreviousAttemptFailedValidation = z.infer<typeof PreviousAttemptFailedValidation>;

export const PreviousAttemptDiagnostics = z
  .object({
    attempt: z.number().int().positive(),
    profile_id: nonEmpty,
    /** O worker anterior declarou sucesso; o orquestrador rejeitou a solução. */
    worker_self_reported_result: z.literal('SUCCESS'),
    reason_code: nonEmpty,
    reason: nonEmpty,
    failed_validations: z.array(PreviousAttemptFailedValidation).min(1).max(20),
    changed_files: z.array(nonEmpty).max(50),
    /** Diretório dos logs oficiais, relativo ao devDir. */
    validation_logs_dir: nonEmpty,
  })
  .strict();
export type PreviousAttemptDiagnostics = z.infer<typeof PreviousAttemptDiagnostics>;

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
    /** Só existe em attempt de reparo; ausente em packet legado e no attempt 1. */
    previous_attempt_diagnostics: PreviousAttemptDiagnostics.optional(),
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
/** Descendente do worker que ainda estava vivo quando a sessão terminou. */
export const SurvivorProcess = z
  .object({
    pid: z.number().int().positive(),
    command: nonEmpty,
    matched_by: z.enum(['process_group', 'launch_tag']),
  })
  .strict();
export type SurvivorProcess = z.infer<typeof SurvivorProcess>;

/**
 * Cobrança do run. Os campos são separados de propósito: um único `cost_usd`
 * misturaria "o que a CLI estimou em preço de API" com "o que foi cobrado", e
 * são coisas diferentes. Com assinatura, o run consome a franquia incluída e
 * NÃO gera cobrança adicional — a estimativa continua sendo emitida.
 */
export const BillingRecord = z
  .object({
    mode: z.enum(['subscription_only', 'api', 'not_applicable']),
    credential_source: z.enum([
      'claude_subscription_oauth',
      'chatgpt_subscription',
      'api',
      'unknown',
      'not_applicable',
    ]),
    included_allowance_consumed: z.boolean(),
    /** Equivalência estimada por preço de API sobre tokens. NÃO é cobrança. */
    provider_estimated_api_equivalent_usd: z.number().nullable(),
    /** Só deixa de ser `null` com fonte de faturamento autoritativa. */
    actual_incremental_charge_usd: z.number().nullable(),
    authoritative_billing_verified: z.boolean(),
  })
  .strict()
  .superRefine((billing, ctx) => {
    if (billing.actual_incremental_charge_usd !== null && !billing.authoritative_billing_verified) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'actual_incremental_charge_usd exige authoritative_billing_verified: estimativa da CLI não é cobrança',
      });
    }
  });
export type BillingRecord = z.infer<typeof BillingRecord>;

/**
 * Falha TERMINAL declarada pelo provider na própria mensagem `result`.
 *
 * Existir aqui significa que a SESSÃO não terminou por conclusão do trabalho —
 * o protocolo do worker pode nem ter começado. É por isso que o campo mora no
 * LaunchRecord e não em `billing`: cobrança e término são perguntas distintas,
 * e um run pode ter falhado depois de consumo real.
 */
export const ProviderTerminalFailure = z
  .object({
    is_error: z.boolean(),
    terminal_reason: z.string().nullable(),
    /** Status HTTP quando houve um; `null` em falha de transporte. */
    api_error_status: z.union([z.string(), z.number()]).nullable(),
    subtype: z.string().nullable(),
    num_turns: z.number().nullable(),
    /** Texto do erro truncado; a íntegra fica no stdout preservado. */
    message: z.string().nullable(),
    message_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    /** Campos que motivaram a classificação — decisão auditável sem reler log. */
    signals: z.array(nonEmpty).min(1),
  })
  .strict();
export type ProviderTerminalFailure = z.infer<typeof ProviderTerminalFailure>;

/**
 * O que a CLI OBSERVOU de limite durante o run — não o que a tarefa consumiu.
 * O nome é deliberado: a primeira observação pode chegar depois da primeira
 * chamada, e a janela é da conta inteira, não desta tarefa. Fica FORA de
 * BillingRecord porque limite de uso e equivalência estimada em dólar são
 * métricas diferentes e não devem ser lidas na mesma linha.
 */
export const RateLimitObservation = z
  .object({
    /** Ordem de chegada no stream, 1-based. */
    sequence: z.number().int().positive(),
    status: z.string().nullable(),
    /** Normalizado de rate_limit_type/rateLimitType; a forma crua fica em `raw`. */
    rate_limit_type: z.string().nullable(),
    /** Valor RAW emitido pela CLI, sem reescala. */
    utilization: z.number().nullable(),
    /** Escala ASSUMIDA para derivar o percentual — registrada, não escondida. */
    utilization_scale: z.enum(['fraction', 'percentage']).nullable(),
    utilization_percentage: z.number().nullable(),
    /**
     * Forma CRUA do reset: a CLI emite string ISO em algumas versões e epoch
     * numérico em outras (2.1.226). Converter exigiria adivinhar a unidade do
     * número, então o valor fica como veio e a janela é comparada por igualdade.
     */
    resets_at: z.union([z.string(), z.number()]).nullable(),
    session_id: z.string().nullable(),
    /** Overage é janela SEPARADA do limite normal; ausente em records anteriores. */
    overage_status: z.string().nullable().default(null),
    overage_resets_at: z.union([z.string(), z.number()]).nullable().default(null),
    is_using_overage: z.boolean().nullable().default(null),
    /** Mensagem crua, preservada como evidência: nada aqui é inventado. */
    raw: z.record(z.unknown()),
  })
  .strict();
export type RateLimitObservation = z.infer<typeof RateLimitObservation>;

/** Só existe com >=2 observações do mesmo tipo dentro da MESMA janela. */
export const RateLimitWindowDelta = z
  .object({
    rate_limit_type: nonEmpty,
    resets_at: z.union([nonEmpty, z.number()]),
    first_utilization_percentage: z.number(),
    last_utilization_percentage: z.number(),
    /** Delta ENTRE OBSERVAÇÕES em pontos percentuais, não consumo da tarefa. */
    observed_delta_pp: z.number(),
    observation_count: z.number().int().min(2),
  })
  .strict();
export type RateLimitWindowDelta = z.infer<typeof RateLimitWindowDelta>;

export const RateLimitObservations = z
  .object({
    source: z.enum(['claude_stream_json']),
    /** Lista vazia é resultado VÁLIDO: a CLI não promete evento em todo run. */
    observed: z.array(RateLimitObservation),
    window_deltas: z.array(RateLimitWindowDelta),
  })
  .strict();
export type RateLimitObservations = z.infer<typeof RateLimitObservations>;

/**
 * Medição da QUOTA DA ASSINATURA em volta do run, lida com `claude -p "/usage"`.
 *
 * É outra métrica, e por isso outro campo: `billing` guarda equivalência em
 * dólar de preço de API, `rate_limit_observations` guarda o que a CLI observou
 * DURANTE o run, e isto aqui guarda o percentual da assinatura ANTES e DEPOIS.
 * Nenhum dos três pode ser lido como se fosse o outro.
 */
export const SUBSCRIPTION_USAGE_PROBE_REASON_CODES = [
  'OK',
  /** O probe não foi executado (perfil não-Claude, ou run abortado antes). */
  'NOT_RUN',
  /** Erro técnico: a CLI não devolveu result legível. Nada foi medido. */
  'PROBE_FAILED',
  /** O result não prova custo/tokens/turno zero — pode ter havido inferência. */
  'ZERO_INFERENCE_UNVERIFIED',
  /** Contrato de segurança OK, mas o texto do /usage não pôde ser lido. */
  'PARSE_ERROR',
] as const;
export const SubscriptionUsageProbeReasonCode = z.enum(SUBSCRIPTION_USAGE_PROBE_REASON_CODES);
export type SubscriptionUsageProbeReasonCode = z.infer<typeof SubscriptionUsageProbeReasonCode>;

export const SubscriptionUsageProbe = z
  .object({
    /** `true` só quando os dois cabeçalhos do /usage foram extraídos. */
    available: z.boolean(),
    /** `true` só com prova positiva de custo, tokens, turnos e modelUsage zerados. */
    zero_inference_verified: z.boolean(),
    reason_code: SubscriptionUsageProbeReasonCode,
    reason: z.string().nullable(),
    /** Evidência do texto lido — o conteúdo em si não é copiado para o record. */
    result_text_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    command: nonEmpty,
    exit_code: z.number().int().nullable(),
  })
  .strict();
export type SubscriptionUsageProbe = z.infer<typeof SubscriptionUsageProbe>;

export const SUBSCRIPTION_USAGE_WINDOW_REASON_CODES = [
  'OK',
  /** A janela virou entre os dois probes: subtrair compararia janelas distintas. */
  'RATE_LIMIT_WINDOW_RESET',
  /** Um dos probes não produziu leitura utilizável. */
  'MEASUREMENT_UNAVAILABLE',
  /**
   * Os rótulos diferem e pelo menos um não pôde ser interpretado. Não há prova
   * de reset nem prova de mesma janela — a métrica falha fechada.
   */
  'WINDOW_LABEL_UNPARSEABLE',
  /**
   * Mesma janela, mas o percentual DESCEU. O valor bruto é preservado como veio;
   * este código existe para que o fato apareça em vez de ser clampado a zero.
   */
  'OBSERVED_DELTA_NEGATIVE',
] as const;
export const SubscriptionUsageWindowReasonCode = z.enum(SUBSCRIPTION_USAGE_WINDOW_REASON_CODES);
export type SubscriptionUsageWindowReasonCode = z.infer<typeof SubscriptionUsageWindowReasonCode>;

/** Como a identidade da janela foi decidida — torna a decisão auditável. */
export const SUBSCRIPTION_USAGE_WINDOW_MATCH_METHODS = [
  /** Os dois rótulos são byte-a-byte iguais. */
  'exact',
  /** Rótulos diferentes que representam o mesmo instante dentro da tolerância de exibição. */
  'display_tolerance',
  /** Rótulos representam instantes distintos (ou fusos distintos): a janela virou. */
  'mismatch',
  /** Pelo menos um rótulo não casou com o formato conhecido do /usage. */
  'unparseable',
] as const;
export const SubscriptionUsageWindowMatchMethod = z.enum(SUBSCRIPTION_USAGE_WINDOW_MATCH_METHODS);
export type SubscriptionUsageWindowMatchMethod = z.infer<typeof SubscriptionUsageWindowMatchMethod>;

export const SubscriptionUsageWindow = z
  .object({
    before_used_pct: z.number().nullable(),
    after_used_pct: z.number().nullable(),
    /** Rótulo de reset EXATAMENTE como o /usage escreveu — identidade da janela. */
    before_reset_label: z.string().nullable(),
    after_reset_label: z.string().nullable(),
    same_window: z.boolean(),
    /**
     * Delta OBSERVADO em pontos percentuais (`after - before`), não convertido em
     * token nem em dólar. O nome é mantido por compatibilidade com os records já
     * gravados. Nunca é clampado: negativo é registrado como negativo.
     * `null` sempre que a janela não puder ser comparada.
     */
    consumed_pp: z.number().nullable(),
    /**
     * Como `same_window` foi decidido. `null` nos records gravados antes deste
     * campo existir — ausência é ausência, não é `exact`.
     */
    window_match_method: SubscriptionUsageWindowMatchMethod.nullable().default(null),
    reason_code: SubscriptionUsageWindowReasonCode,
  })
  .strict();
export type SubscriptionUsageWindow = z.infer<typeof SubscriptionUsageWindow>;

export const SubscriptionUsage = z
  .object({
    source: z.literal('claude_print_usage'),
    probe_contract: z
      .object({ before: SubscriptionUsageProbe, after: SubscriptionUsageProbe })
      .strict(),
    five_hour: SubscriptionUsageWindow,
    seven_day_all_models: SubscriptionUsageWindow,
  })
  .strict();
export type SubscriptionUsage = z.infer<typeof SubscriptionUsage>;

export const LaunchRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    profile_id: nonEmpty,
    /** Evidência efetiva do run; ausente em records legados worker/full. */
    execution_policy: ExecutionPolicy.default(LEGACY_EXECUTION_POLICY),
    argv: z.array(nonEmpty).min(1),
    process: ProcessIdentity,
    /** Identificador único do lançamento, propagado no env para a auditoria. */
    launch_id: z.string().uuid(),
    /** Descendentes vivos encontrados e mortos no fim da sessão. */
    survivors_killed: z.array(SurvivorProcess).default([]),
    /** Descendentes que resistiram ao SIGKILL: sessão contaminada. */
    survivors_remaining: z.array(SurvivorProcess).default([]),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime().nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    /** O que o perfil conseguiu de fato controlar — não o que pretendia. */
    controlled: z.record(z.union([z.boolean(), z.string(), z.number()])),
    /** `null` só em LaunchRecord gravado antes da política de cobrança. */
    billing: BillingRecord.nullable().default(null),
    /**
     * `null` quando o perfil não usa stream-json: só esse transporte carrega
     * `rate_limit_event`. `null` NÃO significa "nenhum limite observado" — para
     * isso existe `observed: []` dentro do objeto.
     */
    rate_limit_observations: RateLimitObservations.nullable().default(null),
    /**
     * `null` quando o perfil não é Claude de assinatura — só ali o probe roda.
     * Records anteriores à medição continuam válidos sem o campo: ausência NÃO
     * é medição zerada, e nada histórico é reescrito para preenchê-la.
     */
    subscription_usage: SubscriptionUsage.nullable().default(null),
    /**
     * `null` quando o `result` não declarou término por falha do provider — o
     * que inclui todo perfil que não fala stream-json. `null` NÃO significa
     * "provider saudável": significa que não houve declaração a registrar.
     */
    provider_failure: ProviderTerminalFailure.nullable().default(null),
  })
  .strict();
export type LaunchRecord = z.infer<typeof LaunchRecord>;
export type LaunchRecordInput = z.input<typeof LaunchRecord>;

/**
 * Binding durável e append-only entre um attempt do harness e sua única
 * materialização canônica. O binding não contém métricas: aponta para o
 * RunRecord selado que continua sendo a fonte de verdade.
 */
export const ProjectHistoryBinding = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    binding_key_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    target_repo_root: nonEmpty,
    runtime_dir: nonEmpty,
    task_id: identifier,
    attempt: z.number().int().positive(),
    launch_id: z.string().uuid(),
    attempt_role: z.enum(['initial', 'repair', 'escalation']),
    execution_episode_id: nonEmpty,
    episode_attempt_ordinal: z.number().int().positive(),
    initial_profile_id: nonEmpty,
    initial_profile_fingerprint_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    canonical_trial_id: identifier,
    canonical_run_id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
    bound_at: z.string().datetime(),
  })
  .strict();
export type ProjectHistoryBinding = z.infer<typeof ProjectHistoryBinding>;

export const ATTEMPT_ABANDONMENT_REASON_CODES = [
  'WORKER_ENVIRONMENT_BLOCKED',
  'WORKER_REPORTED_FAILURE',
] as const;
export const AttemptAbandonmentReasonCode = z.enum(ATTEMPT_ABANDONMENT_REASON_CODES);
export type AttemptAbandonmentReasonCode = z.infer<typeof AttemptAbandonmentReasonCode>;

export const AttemptAbandonmentRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    base_sha: shaHex,
    process: ProcessIdentity,
    launch_classification: z.enum(['FINISHED', 'TIMED_OUT', 'INFRA_ERROR']),
    exit_code: z.number().int().nullable(),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    reason: nonEmpty,
    previous_diagnostics: z.string().nullable(),
    candidate_commit: z.literal(null),
    working_tree_clean: z.literal(true),
    head_sha: shaHex,
    report_present: z.boolean(),
    handoff_present: z.boolean(),
    reason_code: AttemptAbandonmentReasonCode.optional(),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    handoff_draft_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    source_report_result: z.literal('FAILURE').optional(),
    source_base_sha: shaHex.optional(),
    abandoned_at: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const metadata = [
      record.reason_code,
      record.report_sha256,
      record.handoff_draft_sha256,
      record.source_report_result,
      record.source_base_sha,
    ];
    const hasMetadata = metadata.some((value) => value !== undefined);
    const hasCompleteMetadata = metadata.every((value) => value !== undefined);
    if (hasMetadata || record.report_present || record.handoff_present) {
      if (!record.report_present || !record.handoff_present || !hasCompleteMetadata) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'output de infraestrutura exige report, handoff e metadados completos',
        });
      }
    }
  });
export type AttemptAbandonmentRecord = z.infer<typeof AttemptAbandonmentRecord>;

/**
 * Dono do lock do harness. `pid` sozinho não basta — o kernel reusa PIDs, e um
 * lock órfão precisa ser distinguível de um lock vivo por coincidência de PID.
 */
export const HarnessLock = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    pid: z.number().int().positive(),
    proc_start_ticks: z.number().int().nonnegative(),
    command: nonEmpty,
    acquired_at: z.string().datetime(),
  })
  .strict();
export type HarnessLock = z.infer<typeof HarnessLock>;

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
    /** Ausente em evidence histórica anterior aos validation logs. */
    validation_evidence: z.array(ValidationEvidence).optional(),
    observed_at: z.string().datetime(),
  })
  .strict();
export type OrchestratorEvidence = z.infer<typeof OrchestratorEvidence>;

/**
 * Um fechamento gravado é sempre veredito, nunca estado operacional: `READY`,
 * `RUNNING` ou `INFRA_ERROR` num CompletionRecord seriam evidência inválida
 * de que a tarefa foi fechada.
 */
export const ClosedStatus = z.enum(['PASS', 'FAIL']);
export type ClosedStatus = z.infer<typeof ClosedStatus>;

export const CompletionRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    status: ClosedStatus,
    report: AgentCompletionReport.nullable(),
    orchestrator_evidence: OrchestratorEvidence,
    report_matches_evidence: z.boolean(),
    discrepancies: z.array(nonEmpty),
    /** Ausente apenas em records legados, que equivalem a normal/worker. */
    finalization_mode: z.enum(['normal', 'recovered']).optional(),
    /** Ausente apenas em records legados, que equivalem a worker. */
    commit_origin: z.enum(['worker', 'orchestrator', 'orchestrator_recovery']).optional(),
    recovery_source_attempt: z.number().int().positive().optional(),
    recovery_record_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    orchestrated_finalization_attempt: z.number().int().positive().optional(),
    orchestrated_finalization_record_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    revalidated_after_validation_failure: z.literal(true).optional(),
    revalidation_attempt: z.number().int().positive().optional(),
    revalidation_sequence: z.number().int().positive().optional(),
    revalidation_record_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    closed_at: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const recovered =
      record.finalization_mode === 'recovered' || record.commit_origin === 'orchestrator_recovery';
    if (
      recovered &&
      (record.finalization_mode !== 'recovered' || record.commit_origin !== 'orchestrator_recovery')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recovered exige finalization_mode e commit_origin correspondentes',
      });
    }
    if (recovered && record.recovery_source_attempt === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recovered exige recovery_source_attempt',
      });
    }
    if (recovered && record.recovery_record_sha256 === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'recovered exige recovery_record_sha256',
      });
    }
    if (
      !recovered &&
      (record.recovery_source_attempt !== undefined || record.recovery_record_sha256 !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'metadados de recovery só existem em recovered finalization',
      });
    }
    const orchestrated = record.commit_origin === 'orchestrator';
    const revalidationMetadata = [
      record.revalidated_after_validation_failure,
      record.revalidation_attempt,
      record.revalidation_sequence,
      record.revalidation_record_sha256,
    ];
    const revalidated = revalidationMetadata.some((value) => value !== undefined);
    if (revalidated && revalidationMetadata.some((value) => value === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'revalidation exige flag, attempt, sequence e record hash',
      });
    }
    if (orchestrated && record.finalization_mode !== 'normal') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'commit_origin orchestrator exige finalization_mode normal',
      });
    }
    if (
      orchestrated &&
      !revalidated &&
      (record.orchestrated_finalization_attempt === undefined ||
        record.orchestrated_finalization_record_sha256 === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'normal orchestrator exige finalization record e attempt',
      });
    }
    if (
      (!orchestrated || revalidated) &&
      (record.orchestrated_finalization_attempt !== undefined ||
        record.orchestrated_finalization_record_sha256 !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'metadados de orchestrated finalization exigem commit_origin orchestrator',
      });
    }
    if (revalidated && !orchestrated) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'revalidation exige finalization normal com commit_origin orchestrator',
      });
    }
  });
export type CompletionRecord = z.infer<typeof CompletionRecord>;

/**
 * Fechamento aceito não é um arquivo, é um conjunto: CompletionRecord +
 * HandoffRecord selado. O manifesto é escrito por ÚLTIMO e amarra os dois
 * pelo hash canônico — sua existência é o que prova que o fechamento
 * terminou, e não parou no meio. Sem ele, o dev-recover não promove PASS.
 */
export const CloseManifest = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    accepted_commit: shaHex,
    completion_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    handoff_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sealed_at: z.string().datetime(),
  })
  .strict();
export type CloseManifest = z.infer<typeof CloseManifest>;

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
    /**
     * HEAD no momento do dev-init: a base legítima da PRIMEIRA tarefa, antes
     * de existir qualquer accepted_commit. `null` só em state construído fora
     * de um repositório (testes de unidade).
     */
    baseline_sha: shaHex.nullable().default(null),
    /** Único HEAD autorizado a servir de base para a próxima tarefa. */
    authorized_head_sha: shaHex.nullable().default(null),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    tasks: z.array(TaskState).min(1),
  })
  .strict();
export type DevelopmentState = z.infer<typeof DevelopmentState>;

// ---------------------------------------------------------------------------
// Checkpoint de manutenção (.dev/maintenance/*.json) — NÃO versionado
// ---------------------------------------------------------------------------

export const MaintenanceCommit = z
  .object({
    sha: shaHex,
    parent_sha: shaHex,
    changed_files: z.array(nonEmpty),
  })
  .strict();
export type MaintenanceCommit = z.infer<typeof MaintenanceCommit>;

/**
 * Discriminador de adoção. Ausência em records históricos ≡ `maintenance`.
 * `plan_extension` autoriza exatamente um commit que só toca `dev/plan.yaml`
 * sob as regras append-only do `dev-adopt-plan`; `maintenance_range` sela uma
 * faixa linear de manutenção validada como unidade.
 */
export const AdoptionKind = z.enum([
  'maintenance',
  'plan_extension',
  'maintenance_range',
]);
export type AdoptionKind = z.infer<typeof AdoptionKind>;

export const MaintenanceRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    previous_authorized_head_sha: shaHex,
    adopted_head_sha: shaHex,
    commits: z.array(MaintenanceCommit).min(1),
    changed_files: z.array(nonEmpty),
    validation_results: z.array(ValidationResult).length(4),
    working_tree_clean: z.literal(true),
    bootstrap_range: z.boolean(),
    reason: nonEmpty,
    adopted_at: z.string().datetime(),
    /** Ausente em records históricos; equivalente a `maintenance`. */
    adoption_kind: AdoptionKind.optional(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const kind = record.adoption_kind ?? 'maintenance';
    if (
      kind === 'maintenance' &&
      !record.bootstrap_range &&
      record.commits.length !== 1
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MaintenanceRecord normal exige exatamente um commit',
      });
    }
    if (kind === 'plan_extension') {
      if (record.bootstrap_range) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan_extension não admite bootstrap_range',
        });
      }
      if (
        record.commits.length !== 1 ||
        JSON.stringify(record.changed_files) !== JSON.stringify(['dev/plan.yaml']) ||
        JSON.stringify(record.commits[0]?.changed_files) !== JSON.stringify(['dev/plan.yaml'])
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'plan_extension exige exatamente um commit só com dev/plan.yaml',
        });
      }
    }
    if (kind === 'maintenance_range') {
      if (record.bootstrap_range) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'maintenance_range não admite bootstrap_range',
        });
      }
      if (record.commits.length < 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'maintenance_range exige pelo menos dois commits',
        });
      }
      if (
        record.changed_files.includes('dev/plan.yaml') ||
        record.commits.some((commit) => commit.changed_files.includes('dev/plan.yaml'))
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'maintenance_range não admite dev/plan.yaml',
        });
      }
    }
    let expectedParent = record.previous_authorized_head_sha;
    for (const commit of record.commits) {
      if (commit.parent_sha !== expectedParent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cadeia de manutenção divergente em ${commit.sha}`,
        });
      }
      expectedParent = commit.sha;
    }
    if (record.adopted_head_sha !== expectedParent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'adopted_head_sha não é o último commit da cadeia',
      });
    }
    const aggregate = [...new Set(record.commits.flatMap((commit) => commit.changed_files))].sort();
    if (JSON.stringify(record.changed_files) !== JSON.stringify(aggregate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'changed_files agregado não corresponde aos commits',
      });
    }
    if (record.validation_results.some((result) => result.exit_code !== 0 || result.timed_out)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MaintenanceRecord contém validação malsucedida',
      });
    }
    const expectedValidations = [
      ['pnpm', 'typecheck'],
      ['pnpm', 'build'],
      ['pnpm', 'test'],
      [
        'git',
        'diff',
        '--check',
        `${record.previous_authorized_head_sha}..${record.adopted_head_sha}`,
      ],
    ];
    if (
      record.validation_results.some(
        (result, index) =>
          JSON.stringify(result.argv) !== JSON.stringify(expectedValidations[index]),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MaintenanceRecord não contém as validações obrigatórias na ordem esperada',
      });
    }
  });
export type MaintenanceRecord = z.infer<typeof MaintenanceRecord>;

export const CommitMessage = z.string().superRefine((message, ctx) => {
  if (message.trim() === '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'commit-message não pode ser vazio' });
  }
  if (/\r|\n/.test(message)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'commit-message deve ter uma linha' });
  }
  if (Buffer.byteLength(message, 'utf8') > 200) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'commit-message excede 200 bytes' });
  }
});

// ---------------------------------------------------------------------------
// Finalização normal do orquestrador (.dev/finalizations/<task>/attempt-N.json)
// ---------------------------------------------------------------------------

/**
 * Exigência de review INDEPENDENTE amarrada ao candidate preparado. Vive
 * dentro do `OrchestratedFinalizationRecord` porque a pergunta "este candidate
 * precisa de reviewer?" tem que sobreviver ao processo que o preparou: quem
 * retomar a finalização depois de um crash — `recover`, um novo
 * `dev-run-plan`, um `dev-close` — precisa saber disso sem control plane em
 * memória. Campo OPCIONAL: sua ausência significa "nenhuma review exigida", que
 * é exatamente o histórico de todo record gravado antes desta manutenção.
 */
export const CandidateReviewRequirement = z
  .object({
    required: z.literal(true),
    reviewer_profile_id: nonEmpty,
    diversity_requirement: nonEmpty,
    /** De onde veio a exigência; nunca um default silencioso do harness. */
    policy_provenance: nonEmpty,
  })
  .strict();
export type CandidateReviewRequirement = z.infer<typeof CandidateReviewRequirement>;

export const OrchestratedFinalizationRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    base_sha: shaHex,
    profile_id: nonEmpty,
    execution_policy: ExecutionPolicy,
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    handoff_draft_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    report_result: z.literal('SUCCESS'),
    /** O candidate não pertence ao conhecimento nem ao report do worker. */
    report_candidate_commit: z.literal(null),
    commit_message: CommitMessage,
    changed_files: z.array(nonEmpty).min(1),
    validation_results: z.array(ValidationResult).min(1),
    validation_evidence: z.array(ValidationEvidence).optional(),
    patch_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    candidate_commit: shaHex,
    commit_origin: z.literal('orchestrator'),
    /**
     * Presente = o candidate está PREPARADO e VALIDADO, mas ainda NÃO aceito:
     * a promoção depende de um `CandidateReviewRecord` ACCEPT ligado a ele.
     */
    review_requirement: CandidateReviewRequirement.optional(),
    finalized_at: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.execution_policy.commit_owner !== 'orchestrator') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OrchestratedFinalizationRecord exige policy orchestrator',
      });
    }
    if (record.validation_results.some((result) => result.exit_code !== 0 || result.timed_out)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OrchestratedFinalizationRecord contém validação malsucedida',
      });
    }
    const sorted = [...new Set(record.changed_files)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(record.changed_files)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'changed_files deve ser único e ordenado',
      });
    }
  });
export type OrchestratedFinalizationRecord = z.infer<typeof OrchestratedFinalizationRecord>;

// ---------------------------------------------------------------------------
// Review independente do candidate validado
// (.dev/reviews/<task>/attempt-<n>/review.json) — NÃO versionado
// ---------------------------------------------------------------------------

/**
 * Prova ESTRUTURAL de que o reviewer decidiu num contexto fresco e somente
 * leitura. O mecanismo é o argv efetivamente lançado (dev/lib/project-roles.ts),
 * nunca uma frase do prompt — é por isso que o argv inteiro é evidência.
 */
export const ReviewerInvocationProvenance = z
  .object({
    role: z.literal('reviewer'),
    workspace_access: z.literal('READ_ONLY'),
    read_only_mechanism: nonEmpty,
    argv: z.array(nonEmpty).min(1),
    diversity_requirement: nonEmpty,
    /** Processo NOVO por review: nenhuma sessão é compartilhada com o implementer. */
    fresh_context: z.literal(true),
  })
  .strict();
export type ReviewerInvocationProvenance = z.infer<typeof ReviewerInvocationProvenance>;

/**
 * Veredito DURÁVEL da review independente sobre UM candidate preparado.
 * Append-only e amarrado ao candidate por três hashes: o SHA do commit, o hash
 * canônico do `OrchestratedFinalizationRecord` e o hash canônico dos resultados
 * da validação oficial. Um veredito que não amarra a esses três não decide nada
 * sobre este candidate.
 *
 * Existe em disco — e não só na memória do control plane — porque um REJECT
 * precisa continuar bloqueando depois que o processo termina: rerodar o mesmo
 * comando sem intervenção humana não pode esquecer a reprovação.
 */
/**
 * Como o reviewer resolveu UM item de `what_i_did_not_check` do implementer.
 * Só existem dois desfechos, e os dois exigem texto: ou o reviewer justifica
 * por que a lacuna é aceitável, ou ela vira pergunta aberta registrada.
 * "looks good" não é nenhum dos dois.
 */
export const REVIEW_GAP_DISPOSITIONS = ['accepted_with_justification', 'open_question'] as const;
export const ReviewGapDisposition = z.enum(REVIEW_GAP_DISPOSITIONS);
export type ReviewGapDisposition = z.infer<typeof ReviewGapDisposition>;

export const ReviewedHandoffGap = z
  .object({
    /** Texto EXATO do item declarado pelo implementer; é a chave do pareamento. */
    gap: nonEmpty,
    disposition: ReviewGapDisposition,
    /** Justificativa (accepted) ou a pergunta em aberto (open_question). */
    note: z.string().min(1).max(240),
  })
  .strict();
export type ReviewedHandoffGap = z.infer<typeof ReviewedHandoffGap>;

/**
 * O que o reviewer declara ter AUDITADO, por referência a coisas concretas.
 * Adaptado da cobertura de gate do jcode: um veredito que não nomeia o que
 * olhou não é auditável, e não é a mesma coisa que um veredito que olhou.
 */
export const CandidateReviewCoverage = z
  .object({
    /** Arquivos do candidate efetivamente auditados. */
    files: z.array(nonEmpty).max(50),
    /** Validações oficiais lidas, pelo argv exato que o orquestrador rodou. */
    validations: z.array(z.array(nonEmpty).min(1)).max(20),
    /** Aspectos comportamentais nomeados — curtos, não é raciocínio. */
    behaviors: z.array(z.string().min(1).max(160)).max(10),
    /** Endereçamento item a item das lacunas declaradas pelo implementer. */
    handoff_gaps: z.array(ReviewedHandoffGap).max(5),
  })
  .strict();
export type CandidateReviewCoverage = z.infer<typeof CandidateReviewCoverage>;

export const CandidateReviewRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    candidate_sha: shaHex,
    finalization_record_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    validation_results_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    reviewer_profile_id: nonEmpty,
    reviewer_invocation: ReviewerInvocationProvenance,
    /**
     * `what_i_did_not_check` do handoff v2 do implementer, DERIVADO pelo
     * orquestrador — nunca fornecido pelo reviewer. É contra esta lista que a
     * cobertura é conferida. Ausente = handoff v1 ou draft sem lacunas
     * declaradas (UNKNOWN), e nesse caso não há o que endereçar.
     */
    implementer_gaps: z.array(nonEmpty).max(5).optional(),
    /** Declarada pelo reviewer. OBRIGATÓRIA para um ACCEPT válido. */
    coverage: CandidateReviewCoverage.optional(),
    decision: z.enum(['ACCEPT', 'REJECT']),
    reason: nonEmpty,
    decided_at: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    const declared = record.implementer_gaps ?? [];
    const addressed = record.coverage?.handoff_gaps ?? [];
    const addressedGaps = addressed.map((entry) => entry.gap);
    if (new Set(addressedGaps).size !== addressedGaps.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'cobertura endereça a mesma lacuna mais de uma vez',
      });
    }
    for (const gap of addressedGaps) {
      if (!declared.includes(gap)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `cobertura endereça lacuna não declarada pelo implementer: ${gap}`,
        });
      }
    }

    // O gate é ESTRUTURAL e só vale para ACCEPT: um REJECT continua sendo um
    // veredito legítimo sem cobertura, porque ele não promove nada.
    if (record.decision !== 'ACCEPT') return;
    if (record.coverage === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ACCEPT exige coverage declarada; ausência de prova não é aceite',
      });
      return;
    }
    if (record.coverage.files.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ACCEPT exige ao menos um arquivo auditado na coverage',
      });
    }
    if (record.coverage.validations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ACCEPT exige ao menos uma validação oficial referenciada na coverage',
      });
    }
    for (const gap of declared) {
      if (!addressedGaps.includes(gap)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ACCEPT deixa lacuna do implementer sem endereçamento: ${gap}`,
        });
      }
    }
  });
export type CandidateReviewRecord = z.infer<typeof CandidateReviewRecord>;

// ---------------------------------------------------------------------------
// Revalidação de FAIL por validation oficial
// (.dev/revalidations/<task>/attempt-<n>/revalidation-<sequence>.json)
// ---------------------------------------------------------------------------

/**
 * Em que momento o binding foi derivado. O binding NUNCA afirma que o
 * fingerprint existia no instante histórico do FAIL — ele afirma quando foi
 * observado, e é por isso que a proveniência é um campo e não um detalhe:
 *
 * - `derived_at_official_validation_failure`: derivado pelo próprio
 *   finalization, no instante em que a validation oficial reprovou o attempt.
 *   É o caminho normal desde que o FAIL passou a nascer selado.
 * - `derived_during_revalidation_preflight`: derivado depois, no preflight de
 *   uma revalidation auditada. Único valor existente antes desta correção.
 * - `derived_during_failed_attempt_recovery`: derivado depois, ao arquivar um
 *   FAIL LEGADO que ficou sem binding porque o finalization da época não o
 *   materializava. Marca o record como recuperado por compatibilidade, não
 *   como contemporâneo do FAIL.
 *
 * Enum append-only: bytes gravados com o valor antigo continuam parseando.
 */
export const FailedAttemptSourceProvenance = z.enum([
  'derived_at_official_validation_failure',
  'derived_during_revalidation_preflight',
  'derived_during_failed_attempt_recovery',
]);
export type FailedAttemptSourceProvenance = z.infer<typeof FailedAttemptSourceProvenance>;

export const RevalidationSourceBinding = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    source_base_sha: shaHex,
    original_completion_path: nonEmpty,
    original_completion_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    handoff_draft_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    changed_files: z.array(nonEmpty).min(1),
    derived_patch_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    fingerprint_observed_at: z.string().datetime({ offset: true }),
    fingerprint_provenance: FailedAttemptSourceProvenance,
  })
  .strict()
  .superRefine((binding, ctx) => {
    const sorted = [...new Set(binding.changed_files)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(binding.changed_files)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'changed_files do source binding deve ser único e ordenado',
      });
    }
  });
export type RevalidationSourceBinding = z.infer<typeof RevalidationSourceBinding>;

/**
 * Motivos pelos quais uma validation oficial malsucedida pode ser reexecutada
 * sobre o MESMO patch:
 *
 * - `NONDETERMINISTIC_VALIDATION`: o gate oficial não é função só do patch.
 * - `HARNESS_VALIDATION_DEFECT`: o patch do worker permaneceu byte-idêntico,
 *   mas a baseline/harness usada pela validation oficial continha um defeito
 *   posteriormente corrigido por uma manutenção adotada.
 *
 * A ordem é append-only: records históricos gravados com o primeiro código
 * continuam parseando sem alteração nenhuma.
 */
export const REVALIDATION_REASON_CODES = [
  'NONDETERMINISTIC_VALIDATION',
  'HARNESS_VALIDATION_DEFECT',
] as const;
export const RevalidationReasonCode = z.enum(REVALIDATION_REASON_CODES);
export type RevalidationReasonCode = z.infer<typeof RevalidationReasonCode>;

export const OrchestratedRevalidationRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    sequence: z.number().int().positive(),
    outcome: z.enum(['PASS', 'FAIL']),
    reason_code: RevalidationReasonCode,
    reason: nonEmpty,
    source_binding_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    source_base_sha: shaHex,
    finalization_base_sha: shaHex,
    original_completion_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    handoff_draft_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    patch_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    original_validation_results: z.array(ValidationResult).min(1),
    revalidation_results: z.array(ValidationResult).min(1),
    validation_evidence: z.array(ValidationEvidence).min(1),
    changed_files: z.array(nonEmpty).min(1),
    commit_message: CommitMessage,
    candidate_commit: shaHex.nullable(),
    candidate_tree_sha: shaHex.nullable(),
    commit_origin: z.literal('orchestrator'),
    working_tree_clean: z.boolean(),
    revalidated_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, ctx) => {
    const failedOriginal = record.original_validation_results.some(
      (result) => result.exit_code !== 0 || result.timed_out,
    );
    if (!failedOriginal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'revalidation exige validation oficial original malsucedida',
      });
    }
    const failedNew = record.revalidation_results.some(
      (result) => result.exit_code !== 0 || result.timed_out,
    );
    if (record.outcome === 'PASS') {
      if (record.candidate_commit === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PASS exige candidate_commit' });
      }
      if (record.candidate_tree_sha === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PASS exige candidate_tree_sha' });
      }
      if (failedNew) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PASS contém validação malsucedida' });
      }
      if (!record.working_tree_clean) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'PASS exige working tree limpa' });
      }
    } else {
      if (record.candidate_commit !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAIL não admite candidate_commit' });
      }
      if (record.candidate_tree_sha !== null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAIL não admite candidate_tree_sha' });
      }
      if (!failedNew) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAIL exige validação malsucedida' });
      }
      if (record.working_tree_clean) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'FAIL preserva patch na working tree' });
      }
    }
    if (record.validation_evidence.length !== record.revalidation_results.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'validation_evidence deve corresponder a revalidation_results',
      });
    }
    for (let index = 0; index < record.revalidation_results.length; index += 1) {
      const result = record.revalidation_results[index];
      const evidence = record.validation_evidence[index];
      if (
        result &&
        evidence &&
        (JSON.stringify(result.argv) !== JSON.stringify(evidence.argv) ||
          result.exit_code !== evidence.exit_code ||
          result.timed_out !== evidence.timed_out ||
          result.duration_ms !== evidence.duration_ms)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `validation_evidence diverge do resultado na posição ${index}`,
        });
      }
    }
    const sorted = [...new Set(record.changed_files)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(record.changed_files)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'changed_files deve ser único e ordenado',
      });
    }
  });
export type OrchestratedRevalidationRecord = z.infer<typeof OrchestratedRevalidationRecord>;

export const RevalidationCheckpoint = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    sequence: z.number().int().positive(),
    reason_code: RevalidationReasonCode,
    reason: nonEmpty,
    source_binding_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    source_base_sha: shaHex,
    finalization_base_sha: shaHex,
    original_completion_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    handoff_draft_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    patch_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    original_validation_results: z.array(ValidationResult).min(1),
    revalidation_results: z.array(ValidationResult).min(1),
    validation_evidence: z.array(ValidationEvidence).min(1),
    changed_files: z.array(nonEmpty).min(1),
    commit_message: CommitMessage,
    staged_tree_sha: shaHex,
    checkpointed_at: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((checkpoint, ctx) => {
    if (checkpoint.revalidation_results.some((result) => result.exit_code !== 0 || result.timed_out)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'checkpoint só pode conter validações bem-sucedidas',
      });
    }
    if (checkpoint.validation_evidence.length !== checkpoint.revalidation_results.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'checkpoint evidence diverge dos resultados',
      });
    }
  });
export type RevalidationCheckpoint = z.infer<typeof RevalidationCheckpoint>;

// ---------------------------------------------------------------------------
// Finalização recuperada (.dev/recoveries/<task>/attempt-<n>.json)
// ---------------------------------------------------------------------------

export const RecoveredFinalizationRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    source_attempt: z.number().int().positive(),
    source_base_sha: shaHex,
    finalization_base_sha: shaHex,
    abandonment_record_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    report_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    handoff_draft_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    source_report_result: z.literal('FAILURE'),
    reason_code: AttemptAbandonmentReasonCode,
    reason: nonEmpty,
    commit_message: CommitMessage,
    changed_files: z.array(nonEmpty).min(1),
    validation_results: z.array(ValidationResult).min(1),
    validation_evidence: z.array(ValidationEvidence).optional(),
    candidate_commit: shaHex,
    commit_origin: z.literal('orchestrator_recovery'),
    working_tree_clean: z.literal(true),
    finalized_at: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.validation_results.some((result) => result.exit_code !== 0 || result.timed_out)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'RecoveredFinalizationRecord contém validação malsucedida',
      });
    }
    const sorted = [...new Set(record.changed_files)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(record.changed_files)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'changed_files deve ser único e ordenado',
      });
    }
  });
export type RecoveredFinalizationRecord = z.infer<typeof RecoveredFinalizationRecord>;

// ---------------------------------------------------------------------------
// Attempt rejeitado pela validation oficial
// (.dev/failed-attempts/<task>/attempt-<n>/…)
// ---------------------------------------------------------------------------

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Como o arquivo chegou à working tree do worker, relativo ao base autorizado.
 * Os códigos espelham `git diff --name-status`, e não a porcelain do status:
 * o bundle preservado descreve base -> árvore do worker, não index -> disco.
 */
export const PRESERVED_CHANGE_STATUSES = [
  'added',
  'copied',
  'deleted',
  'modified',
  'renamed',
  'type_changed',
] as const;
export const PreservedChangeStatus = z.enum(PRESERVED_CHANGE_STATUSES);
export type PreservedChangeStatus = z.infer<typeof PreservedChangeStatus>;

export const PreservedChangeFile = z
  .object({
    path: nonEmpty,
    status: PreservedChangeStatus,
    /** Origem de um rename/copy; `null` nos demais status. */
    old_path: nonEmpty.nullable(),
    /** Modo git na árvore do worker (`100644`, `100755`, `120000`); `null` se removido. */
    mode: z.string().regex(/^[0-7]{6}$/).nullable(),
    size_bytes: z.number().int().nonnegative().nullable(),
    sha256: sha256Hex.nullable(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const removed = file.status === 'deleted';
    if (removed && (file.mode !== null || file.size_bytes !== null || file.sha256 !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${file.path}: removido não tem conteúdo` });
    }
    if (!removed && (file.mode === null || file.size_bytes === null || file.sha256 === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${file.path}: conteúdo preservado ausente` });
    }
    const renamed = file.status === 'renamed' || file.status === 'copied';
    if (renamed === (file.old_path === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${file.path}: old_path só existe em rename/copy` });
    }
  });
export type PreservedChangeFile = z.infer<typeof PreservedChangeFile>;

/**
 * Manifesto do change bundle preservado. Ele existe para responder, depois que
 * a working tree foi limpa para o próximo attempt, o que a solução rejeitada
 * mudou e como reconstruí-la — o patch reaplica sobre `base_sha`.
 */
export const PreservedChangeBundleManifest = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    base_sha: shaHex,
    changed_files: z.array(nonEmpty).min(1),
    files: z.array(PreservedChangeFile).min(1),
    patch_file: nonEmpty,
    patch_sha256: sha256Hex,
    patch_size_bytes: z.number().int().nonnegative(),
    /** Fingerprint da working tree observada no instante da preservação. */
    patch_fingerprint: sha256Hex,
    captured_at: z.string().datetime(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const sorted = [...new Set(manifest.changed_files)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(manifest.changed_files)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'changed_files deve ser único e ordenado' });
    }
    // Todo caminho tocado precisa estar em changed_files, incluindo a origem de
    // um rename: sem isso o reset limparia só metade do par e deixaria resíduo.
    const declared = new Set(manifest.changed_files);
    for (const file of manifest.files) {
      for (const touched of [file.path, file.old_path]) {
        if (touched !== null && !declared.has(touched)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `arquivo tocado fora de changed_files: ${touched}`,
          });
        }
      }
    }
  });
export type PreservedChangeBundleManifest = z.infer<typeof PreservedChangeBundleManifest>;

/**
 * Motivos pelos quais um attempt inteiro é arquivado e a tarefa volta a READY.
 * Append-only: novos códigos entram no fim, records antigos continuam parseando.
 *
 * `OFFICIAL_VALIDATION_FAILURE` NÃO é nondeterminismo nem defeito do harness —
 * é o orquestrador rejeitando uma solução que o worker declarou pronta.
 */
export const VALIDATION_FAILED_ATTEMPT_REASON_CODES = ['OFFICIAL_VALIDATION_FAILURE'] as const;
export const ValidationFailedAttemptReasonCode = z.enum(VALIDATION_FAILED_ATTEMPT_REASON_CODES);
export type ValidationFailedAttemptReasonCode = z.infer<typeof ValidationFailedAttemptReasonCode>;

export const PreservedChangeBundleRef = z
  .object({
    /** Caminhos relativos ao devDir — o record é evidência portável. */
    manifest_path: nonEmpty,
    manifest_sha256: sha256Hex,
    patch_path: nonEmpty,
    patch_sha256: sha256Hex,
    patch_size_bytes: z.number().int().nonnegative(),
  })
  .strict();
export type PreservedChangeBundleRef = z.infer<typeof PreservedChangeBundleRef>;

/**
 * Attempt cuja solução foi REJEITADA pela validation oficial do orquestrador.
 *
 * Os três campos redundantes no topo existem para que ninguém precise inferir a
 * história: o worker reportou SUCCESS, o report não trouxe candidate, e o
 * veredito foi do orquestrador. Isto não é falha de infraestrutura e não é
 * nondeterminismo — a solução foi medida e reprovada.
 */
export const ValidationFailedAttemptRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    source_base_sha: shaHex,
    profile_id: nonEmpty,
    worker_self_reported_result: z.literal('SUCCESS'),
    report_candidate_commit: z.literal(null),
    orchestrator_verdict: z.literal('REJECTED_BY_OFFICIAL_VALIDATION'),
    finalization_mode: z.literal('normal'),
    launch_record_sha256: sha256Hex,
    original_completion_sha256: sha256Hex,
    report_sha256: sha256Hex,
    handoff_draft_sha256: sha256Hex,
    source_binding_sha256: sha256Hex,
    patch_fingerprint: sha256Hex,
    changed_files: z.array(nonEmpty).min(1),
    original_validation_results: z.array(ValidationResult).min(1),
    /** Ausente somente quando o FAIL é anterior aos validation logs. */
    original_validation_evidence: z.array(ValidationEvidence).optional(),
    change_bundle: PreservedChangeBundleRef,
    reason_code: ValidationFailedAttemptReasonCode,
    reason: nonEmpty,
    archived_at: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (!record.original_validation_results.some((r) => r.exit_code !== 0 || r.timed_out)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'attempt arquivado exige validation oficial malsucedida',
      });
    }
    const sorted = [...new Set(record.changed_files)].sort();
    if (JSON.stringify(sorted) !== JSON.stringify(record.changed_files)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'changed_files deve ser único e ordenado' });
    }
  });
export type ValidationFailedAttemptRecord = z.infer<typeof ValidationFailedAttemptRecord>;

/**
 * Motivos pelos quais um attempt é arquivado SEM solução nenhuma para preservar.
 * Append-only, como os demais códigos.
 */
export const INFRA_FAILED_ATTEMPT_REASON_CODES = ['PROVIDER_TERMINAL_FAILURE'] as const;
export const InfraFailedAttemptReasonCode = z.enum(INFRA_FAILED_ATTEMPT_REASON_CODES);
export type InfraFailedAttemptReasonCode = z.infer<typeof InfraFailedAttemptReasonCode>;

/** Cópia byte-idêntica de um arquivo de evidência, com hash e tamanho. */
export const ArchivedEvidenceFile = z
  .object({
    /** Caminho relativo ao devDir — o record é evidência portável. */
    path: nonEmpty,
    /** Origem de onde os bytes foram copiados, também relativa ao devDir. */
    source_path: nonEmpty,
    sha256: sha256Hex,
    size_bytes: z.number().int().nonnegative(),
  })
  .strict();
export type ArchivedEvidenceFile = z.infer<typeof ArchivedEvidenceFile>;

/**
 * Attempt encerrado por FALHA DE INFRAESTRUTURA do provider, antes de o
 * protocolo do worker completar.
 *
 * Distinto de `ValidationFailedAttemptRecord` de propósito: lá existe uma
 * solução que foi medida e reprovada; aqui não existe solução nenhuma — não há
 * patch, não há candidate e não há `AgentCompletionReport`. Confundir os dois
 * apagaria a única evidência de que nada chegou a ser produzido.
 *
 * O consumo real observado vai preservado como veio (`billing`,
 * `subscription_usage`): zero permanece zero, e um incidente futuro com consumo
 * parcial continuará mostrando o consumo que houve.
 */
export const InfraFailedAttemptRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    source_base_sha: shaHex,
    profile_id: nonEmpty,
    process: ProcessIdentity,
    launch_id: z.string().uuid(),
    launch_classification: z.literal('INFRA_ERROR'),
    launch_record_sha256: sha256Hex,
    exit_code: z.number().int().nullable(),
    /** Timeout tem diagnóstico próprio e precedência: aqui é sempre `false`. */
    timed_out: z.literal(false),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    provider_failure: ProviderTerminalFailure,
    /**
     * `stdout_stream` significa que o LaunchRecord é anterior ao campo e a
     * falha foi derivada do stdout preservado do próprio attempt. Classificação
     * feita depois do fato não pode se passar pela do lançamento.
     */
    provider_failure_source: z.enum(['launch_record', 'stdout_stream']),
    billing: BillingRecord.nullable(),
    subscription_usage: SubscriptionUsage.nullable(),
    rate_limit_observations: RateLimitObservations.nullable(),
    /** Sem report e sem handoff: o protocolo do worker não chegou a começar. */
    worker_output_present: z.literal(false),
    candidate_commit: z.literal(null),
    working_tree_clean: z.literal(true),
    head_sha: shaHex,
    evidence: z.array(ArchivedEvidenceFile).min(1),
    reason_code: InfraFailedAttemptReasonCode,
    reason: nonEmpty,
    archived_at: z.string().datetime(),
  })
  .strict();
export type InfraFailedAttemptRecord = z.infer<typeof InfraFailedAttemptRecord>;

/** Conteúdo individual do patch preservado para auditoria byte a byte. */
export const ProtocolInvalidPatchFile = z
  .object({
    path: nonEmpty,
    /** Código XY do `git status --porcelain=v1`. */
    git_status: z.string().regex(/^[ MADRCUT?!]{2}$/),
    content_state: z.enum(['ARCHIVED', 'ABSENT']),
    /** Caminho relativo ao devDir; ausente somente quando não há conteúdo atual. */
    archive_path: nonEmpty.nullable(),
    size_bytes: z.number().int().nonnegative().nullable(),
    sha256: sha256Hex.nullable(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const metadata = [file.archive_path, file.size_bytes, file.sha256];
    const allPresent = metadata.every((value) => value !== null);
    const allAbsent = metadata.every((value) => value === null);
    if (file.content_state === 'ARCHIVED' && !allPresent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${file.path}: conteúdo arquivado incompleto` });
    }
    if (file.content_state === 'ABSENT' && !allAbsent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${file.path}: marcador de ausência contém bytes` });
    }
  });
export type ProtocolInvalidPatchFile = z.infer<typeof ProtocolInvalidPatchFile>;

/**
 * Attempt cujo worker terminou com SUCCESS/PASS, mas declarou os dois arquivos
 * de protocol I/O dentro de `changed_files`. Não há veredito de capability nem
 * de validation oficial: o output de protocolo é que tornou o fechamento
 * impossível, e os bytes originais ficam preservados antes de qualquer limpeza.
 */
export const ProtocolInvalidAttemptRecord = z
  .object({
    schema_version: z.literal(DEV_SCHEMA_VERSION),
    task_id: identifier,
    attempt: z.number().int().positive(),
    classification: z.literal('PROTOCOL_OUTPUT_INVALID'),
    reason_code: z.literal('PROTOCOL_OUTPUT_INVALID'),
    reason: nonEmpty,
    source_base_sha: shaHex,
    head_sha: shaHex,
    authorized_head_sha: shaHex,
    profile_id: nonEmpty,
    execution_policy: ExecutionPolicy,
    process: ProcessIdentity,
    launch_id: z.string().uuid(),
    launch_record: ArchivedEvidenceFile,
    worker_self_reported_result: z.literal('SUCCESS'),
    handoff_result: z.literal('PASS'),
    report_candidate_commit: z.literal(null),
    state_candidate_commit: z.literal(null),
    state_accepted_commit: z.literal(null),
    protocol_invalid_paths: z.array(nonEmpty).length(2),
    changed_files: z.array(nonEmpty).min(1),
    actual_patch_matches_normalized_report: z.literal(true),
    patch_fingerprint: sha256Hex,
    patch_files: z.array(ProtocolInvalidPatchFile).min(1),
    change_bundle: PreservedChangeBundleRef,
    report: ArchivedEvidenceFile,
    handoff_draft: ArchivedEvidenceFile,
    capability_verdict: z.literal(null),
    official_validation_verdict: z.literal(null),
    attempts_preserved: z.number().int().positive(),
    archived_at: z.string().datetime(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (
      record.execution_policy.commit_owner !== 'orchestrator' ||
      record.execution_policy.official_validation_owner !== 'orchestrator'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'protocol-invalid recovery exige ownership do orquestrador',
      });
    }
    if (
      record.source_base_sha !== record.head_sha ||
      record.source_base_sha !== record.authorized_head_sha
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'protocol-invalid recovery exige base, HEAD e authorized head idênticos',
      });
    }
    const expectedProtocolPaths = [
      `.dev-inbox/${record.task_id}/handoff-draft.json`,
      `.dev-inbox/${record.task_id}/report.json`,
    ];
    if (JSON.stringify(record.protocol_invalid_paths) !== JSON.stringify(expectedProtocolPaths)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'protocol_invalid_paths deve conter somente o par do inbox da task',
      });
    }
    const sortedFiles = [...new Set(record.changed_files)].sort();
    if (JSON.stringify(record.changed_files) !== JSON.stringify(sortedFiles)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'changed_files deve ser único e ordenado' });
    }
    const patchPaths = record.patch_files.map((file) => file.path);
    if (JSON.stringify(patchPaths) !== JSON.stringify(record.changed_files)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'patch_files deve cobrir changed_files na mesma ordem',
      });
    }
    if (record.attempts_preserved !== record.attempt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'attempts_preserved deve manter o número histórico do attempt',
      });
    }
  });
export type ProtocolInvalidAttemptRecord = z.infer<typeof ProtocolInvalidAttemptRecord>;

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
