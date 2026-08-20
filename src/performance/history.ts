/**
 * Leitor somente-leitura de `data/runs/`: agrupa runs por trial (via
 * `index-record.json`), ordena por run_id ULID (ordem cronológica de
 * attempt) e deriva, para cada run, os fatos de attempt (M45) e o
 * `RunPerformanceRecord` (M46) correspondente.
 *
 * A derivação NUNCA escolhe evidência "mais recente": um run pode ter N
 * evaluations e N scores selados, e só a `EvaluationSelection` fornecida
 * pelo chamador diz qual evaluation_id/score_id conta. Sem seleção para um
 * run, o attempt entra como não avaliado — nunca com um outcome inventado.
 *
 * Nenhuma escrita em disco acontece aqui.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { EvaluationOutcome, QualificationStatus } from '../core/enums.js';
import type { ExecutionEnvelopeManifest } from '../envelope/index.js';
import { EvaluationRecord, ExecutionMetrics, ExecutionRecord } from '../schemas/execution-record.js';
import { RunInterventionsRecord, type InterventionRecord } from '../schemas/intervention.js';
import { QualificationRecord, ScoreRecord } from '../schemas/evaluation-record.js';
import { QuotaUsage } from '../schemas/quota-usage.js';
import { RunPerformanceRecord } from '../schemas/performance.js';
import {
  RUN_RECORD_FILE_NAME,
  verifyRunIntegrity,
  type RunHistoryContextV1,
  type RunRecord,
} from '../storage/index.js';
import { AttemptRole, deriveAttemptFacts, type AttemptFacts, type InferenceEvidence } from './attempt-facts.js';
import type { AttemptHistory } from './derive-performance.js';

const EVALUATIONS_DIR = 'evaluations';
const SCORES_DIR = 'scores';
const EXECUTION_DIR = 'execution';
const EXECUTION_ENVELOPE_FILE_NAME = 'execution-envelope.json';
const EXECUTION_RECORD_FILE_NAME = 'execution-record.json';
const QUOTA_USAGE_FILE_NAME = 'quota-usage.json';
const EVALUATION_RECORD_FILE_NAME = 'evaluation-record.json';
const SCORE_RECORD_FILE_NAME = 'score-record.json';
const INTERVENTIONS_FILE_NAME = 'interventions.json';
const QUALIFICATION_RECORD_FILE_NAME = 'qualification-record.json';

/** Referências pinadas para um run: nunca inferidas, sempre fornecidas pelo chamador. */
export interface EvaluationSelectionEntry {
  readonly evaluation_id: string;
  readonly score_id: string | null;
}

/** run_id -> seleção pinada. Um run ausente aqui não tem evaluation/score escolhidos. */
export type EvaluationSelection = Readonly<Record<string, EvaluationSelectionEntry>>;

/** Um run que não entrou na história por evidência ausente, inválida ou adulterada. */
export interface ExcludedRun {
  readonly run_id: string;
  readonly reason: string;
}

export interface RunReadResult {
  readonly run_id: string;
  readonly trial_id: string;
  readonly history_context: RunHistoryContextV1 | null;
  readonly facts: AttemptFacts;
  readonly performance: RunPerformanceRecord;
}

export interface TrialHistoryResult {
  readonly history: AttemptHistory;
  readonly runs: readonly RunReadResult[];
  readonly excludedRuns: readonly ExcludedRun[];
}

/** Enumera os evaluation_id selados sob `<runDir>/evaluations/` — sem escolher nenhum. */
export async function listEvaluations(runDir: string): Promise<string[]> {
  return listSectionIds(path.join(runDir, EVALUATIONS_DIR));
}

/** Enumera os score_id selados sob `<runDir>/scores/` — sem escolher nenhum. */
export async function listScores(runDir: string): Promise<string[]> {
  return listSectionIds(path.join(runDir, SCORES_DIR));
}

async function listSectionIds(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Constrói a história de attempts de um trial a partir de `data/runs/`.
 * Runs com evidência ausente/inválida/adulterada são reportados em
 * `excludedRuns` e nunca entram em `history.attempts` nem em `runs`.
 */
export async function readTrialHistory(
  runsDir: string,
  trialId: string,
  selection: EvaluationSelection = {},
): Promise<TrialHistoryResult> {
  const runIds = await listRunDirectories(runsDir);
  const excludedRuns: ExcludedRun[] = [];
  const matched: { runId: string; runDir: string; record: RunRecord }[] = [];

  for (const runId of runIds) {
    const runDir = path.join(runsDir, runId);
    const read = await readRunRecord(runDir);
    if (read === null) continue;
    if (read.run.trial_id !== trialId) continue;
    matched.push({ runId, runDir, record: read });
  }

  matched.sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));

  const runs: RunReadResult[] = [];
  let taskId: string | null = null;

  for (const { runId, runDir, record } of matched) {
    taskId ??= record.task.id;

    const integrity = await verifyRunIntegrity(runDir);
    if (!integrity.ok) {
      excludedRuns.push({
        run_id: runId,
        reason: `integridade violada: ${integrity.violations.map((violation) => violation.kind).join(', ')}`,
      });
      continue;
    }

    const result = await readRun(runDir, runId, record, selection[runId] ?? null);
    if (result.status === 'EXCLUDED') {
      excludedRuns.push({ run_id: runId, reason: result.reason });
      continue;
    }

    runs.push(result.run);
  }

  return {
    history: {
      task_id: taskId ?? '',
      trial_id: trialId,
      attempts: runs.map((run) => run.facts),
    },
    runs,
    excludedRuns,
  };
}

type RunReadOutcome = { status: 'OK'; run: RunReadResult } | { status: 'EXCLUDED'; reason: string };

async function readRun(
  runDir: string,
  runId: string,
  record: RunRecord,
  selection: EvaluationSelectionEntry | null,
): Promise<RunReadOutcome> {
  const envelope = await readJson<ExecutionEnvelopeManifest>(
    path.join(runDir, EXECUTION_DIR, EXECUTION_ENVELOPE_FILE_NAME),
  );
  if (envelope === undefined) return { status: 'EXCLUDED', reason: 'execution-envelope.json ausente' };
  if (envelope === null) return { status: 'EXCLUDED', reason: 'execution-envelope.json não é JSON válido' };

  const executionRead = await readJson<unknown>(
    path.join(runDir, EXECUTION_DIR, EXECUTION_RECORD_FILE_NAME),
  );
  if (executionRead === undefined) return { status: 'EXCLUDED', reason: 'execution-record.json ausente' };
  if (executionRead === null) return { status: 'EXCLUDED', reason: 'execution-record.json não é JSON válido' };
  const executionParsed = ExecutionRecord.safeParse(executionRead);
  if (!executionParsed.success) {
    return { status: 'EXCLUDED', reason: 'execution-record.json não corresponde ao schema ExecutionRecord' };
  }
  const executionRecord = executionParsed.data;

  const evaluation = await readSelectedEvaluation(runDir, selection);
  if (evaluation.status === 'EXCLUDED') return evaluation;

  const score = await readSelectedScore(runDir, selection);
  if (score.status === 'EXCLUDED') return score;

  const quota = await readQuotaUsage(runDir);
  if (quota.status === 'EXCLUDED') return quota;

  const interventions = await readInterventions(runDir);
  if (interventions.status === 'EXCLUDED') return interventions;

  const inferenceEvidence = deriveInferenceEvidence(executionRecord.metrics);
  const facts = deriveAttemptFacts({
    execution_status: executionRecord.status,
    evaluation_outcome: evaluation.record === null ? null : evaluation.record.outcome,
    attempt_role: AttemptRole.UNKNOWN,
    interventions: interventions.value,
    inference_evidence: inferenceEvidence,
  });

  const performance = RunPerformanceRecord.parse({
    schema_version: 1,
    identity: {
      task_id: record.task.id,
      taxonomy: {
        task_class: envelope.task_spec.task_class,
        difficulty: envelope.task_spec.difficulty,
      },
      stack: envelope.task_spec.stack,
      agent_cli: envelope.agent_profile.cli,
      model: envelope.agent_profile.model,
      reasoning_effort: deriveReasoningEffort(envelope.agent_profile.flags),
      strategy: { name: envelope.strategy.name, version: envelope.strategy.version },
      environment_profile: {
        id: envelope.environment_profile.id,
        mode: envelope.environment_profile.mode,
      },
      execution_envelope_sha256: executionRecord.execution_envelope_sha256,
      evaluation_envelope_sha256: evaluation.record?.evaluation_envelope_sha256 ?? null,
      evaluation_id: selection?.evaluation_id ?? null,
      score_id: selection?.score_id ?? null,
    },
    quality: {
      execution_status: executionRecord.status,
      evaluation_outcome: evaluation.record?.outcome ?? EvaluationOutcome.NOT_EVALUATED,
      qualification_status:
        score.qualification?.status ??
        (score.record === null ? QualificationStatus.UNSCORABLE : QualificationStatus.QUALIFIED),
      score_profile_id: score.record?.score_profile_id ?? null,
      score_profile_version: score.record?.score_profile_version ?? null,
      sub_scores: score.record?.sub_scores ?? null,
      coverage: score.record?.coverage ?? null,
    },
    facts: {
      had_inference: facts.had_inference,
      attempt_role: facts.attempt_role,
      interventions: facts.interventions,
    },
    cost: {
      duration_ms: executionRecord.duration_ms,
      tokens: deriveTokenMetrics(executionRecord.metrics),
      api_equivalent_usd: executionRecord.metrics.api_equivalent_usd ?? notRecordedMetric(),
      quota_usage: quota.value,
    },
  });

  return {
    status: 'OK',
    run: {
      run_id: runId,
      trial_id: record.trial.id,
      history_context: record.history_context ?? null,
      facts,
      performance,
    },
  };
}

/**
 * Intervenções humanas do attempt. O artifact só existe quando o writer pôde
 * PROVAR o conjunto observado: lista vazia é prova positiva de zero, ausência
 * continua sendo desconhecimento e artifact corrompido falha fechado — nunca
 * vira zero.
 */
async function readInterventions(
  runDir: string,
): Promise<
  | { status: 'OK'; value: readonly InterventionRecord[] | null }
  | { status: 'EXCLUDED'; reason: string }
> {
  const read = await readJson<unknown>(path.join(runDir, EXECUTION_DIR, INTERVENTIONS_FILE_NAME));
  if (read === undefined) return { status: 'OK', value: null };
  if (read === null) return { status: 'EXCLUDED', reason: 'interventions.json não é JSON válido' };
  const parsed = RunInterventionsRecord.safeParse(read);
  if (!parsed.success) {
    return { status: 'EXCLUDED', reason: 'interventions.json não corresponde ao schema RunInterventionsRecord' };
  }
  return { status: 'OK', value: parsed.data.interventions };
}

async function readSelectedEvaluation(
  runDir: string,
  selection: EvaluationSelectionEntry | null,
): Promise<{ status: 'OK'; record: EvaluationRecord | null } | { status: 'EXCLUDED'; reason: string }> {
  if (selection === null) return { status: 'OK', record: null };

  const filePath = path.join(runDir, EVALUATIONS_DIR, selection.evaluation_id, EVALUATION_RECORD_FILE_NAME);
  const read = await readJson<unknown>(filePath);
  if (read === undefined) {
    return { status: 'EXCLUDED', reason: `evaluation pinada ausente: ${selection.evaluation_id}` };
  }
  if (read === null) {
    return { status: 'EXCLUDED', reason: `evaluation pinada não é JSON válido: ${selection.evaluation_id}` };
  }
  const parsed = EvaluationRecord.safeParse(read);
  if (!parsed.success) {
    return { status: 'EXCLUDED', reason: `evaluation pinada não corresponde ao schema: ${selection.evaluation_id}` };
  }
  return { status: 'OK', record: parsed.data };
}

async function readSelectedScore(
  runDir: string,
  selection: EvaluationSelectionEntry | null,
): Promise<
  | { status: 'OK'; record: ScoreRecord | null; qualification: QualificationRecord | null }
  | { status: 'EXCLUDED'; reason: string }
> {
  if (selection === null || selection.score_id === null) {
    return { status: 'OK', record: null, qualification: null };
  }

  const filePath = path.join(runDir, SCORES_DIR, selection.score_id, SCORE_RECORD_FILE_NAME);
  const read = await readJson<unknown>(filePath);
  if (read === undefined) {
    return { status: 'EXCLUDED', reason: `score pinado ausente: ${selection.score_id}` };
  }
  if (read === null) {
    return { status: 'EXCLUDED', reason: `score pinado não é JSON válido: ${selection.score_id}` };
  }
  const parsed = ScoreRecord.safeParse(read);
  if (!parsed.success) {
    return { status: 'EXCLUDED', reason: `score pinado não corresponde ao schema: ${selection.score_id}` };
  }
  const qualificationPath = path.join(
    runDir,
    SCORES_DIR,
    selection.score_id,
    QUALIFICATION_RECORD_FILE_NAME,
  );
  const qualificationRead = await readJson<unknown>(qualificationPath);
  if (qualificationRead === null) {
    return { status: 'EXCLUDED', reason: `qualification pinada não é JSON válido: ${selection.score_id}` };
  }
  if (qualificationRead === undefined) {
    // Compatibilidade histórica: scores anteriores a QualificationRecord no
    // artifact continuam com a semântica v1 já existente.
    return { status: 'OK', record: parsed.data, qualification: null };
  }
  const qualification = QualificationRecord.safeParse(qualificationRead);
  if (!qualification.success) {
    return { status: 'EXCLUDED', reason: `qualification pinada não corresponde ao schema: ${selection.score_id}` };
  }
  return { status: 'OK', record: parsed.data, qualification: qualification.data };
}

/**
 * `execution/quota-usage.json` é opcional: eras M1/históricas nunca o
 * escreveram. Ausência vira `null` com provenance `artifact_not_present` —
 * nunca janelas inventadas. Presente mas ilegível/fora do schema é reportado
 * como exclusão do run, nunca ignorado silenciosamente.
 */
async function readQuotaUsage(
  runDir: string,
): Promise<
  | { status: 'OK'; value: { value: QuotaUsage | null; provenance: string } }
  | { status: 'EXCLUDED'; reason: string }
> {
  const filePath = path.join(runDir, EXECUTION_DIR, QUOTA_USAGE_FILE_NAME);
  const read = await readJson<unknown>(filePath);
  if (read === undefined) {
    return { status: 'OK', value: { value: null, provenance: 'artifact_not_present' } };
  }
  if (read === null) {
    return { status: 'EXCLUDED', reason: 'quota-usage.json não é JSON válido' };
  }
  const parsed = QuotaUsage.safeParse(read);
  if (!parsed.success) {
    return { status: 'EXCLUDED', reason: 'quota-usage.json não corresponde ao schema QuotaUsage' };
  }
  return { status: 'OK', value: { value: parsed.data, provenance: 'quota_usage_artifact' } };
}

function deriveInferenceEvidence(metrics: ExecutionMetrics): InferenceEvidence {
  const tokens = metrics.tokens.value;
  if (tokens !== null && tokens > 0) {
    return { model_events_observed: true, zero_inference_proven: false };
  }
  if (tokens === 0) {
    return { model_events_observed: false, zero_inference_proven: true };
  }
  return { model_events_observed: false, zero_inference_proven: false };
}

function deriveTokenMetrics(metrics: ExecutionMetrics) {
  const input = metrics.input_tokens ?? notRecordedIntMetric();
  const cached = metrics.cached_input_tokens ?? notRecordedIntMetric();
  const fresh =
    input.value !== null && cached.value !== null
      ? { value: input.value - cached.value, provenance: 'derived_input_minus_cached' }
      : { value: null, provenance: 'insufficient_evidence' };

  return {
    total_tokens: metrics.tokens,
    input_tokens: input,
    cached_input_tokens: cached,
    fresh_input_tokens: fresh,
    output_tokens: metrics.output_tokens ?? notRecordedIntMetric(),
    reasoning_tokens: metrics.reasoning_tokens ?? notRecordedIntMetric(),
  };
}

function notRecordedIntMetric(): { value: number | null; provenance: string } {
  return { value: null, provenance: 'schema_v1_absent' };
}

function notRecordedMetric(): { value: number | null; provenance: string } {
  return { value: null, provenance: 'schema_v1_absent' };
}

const REASONING_EFFORT_FLAG = /^reasoning[-_]?effort[:=](.+)$/i;

function deriveReasoningEffort(flags: readonly string[]): { value: string | null; provenance: string } {
  for (const flag of flags) {
    const match = REASONING_EFFORT_FLAG.exec(flag);
    if (match?.[1] !== undefined && match[1].length > 0) {
      return { value: match[1], provenance: 'agent_profile_flag' };
    }
  }
  return { value: null, provenance: 'not_recorded' };
}

async function listRunDirectories(runsDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function readRunRecord(runDir: string): Promise<RunRecord | null> {
  const parsed = await readJson<RunRecord>(path.join(runDir, RUN_RECORD_FILE_NAME));
  return parsed ?? null;
}

/** undefined = arquivo ausente; null = presente mas ilegível/JSON inválido; valor = OK. */
async function readJson<T>(filePath: string): Promise<T | null | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EISDIR')) return undefined;
    throw error;
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
