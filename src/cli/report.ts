/**
 * `agentlab report`: lê a evidência já selada de um run — `execution/`,
 * `evaluations/<evaluationId>/` e `scores/<scoreId>/` — e a renderiza para
 * terminal e para `--json`, sem reabrir nenhum clone nem recalcular nada.
 *
 * Fronteira: as três dimensões (execução, avaliação, qualificação) aparecem
 * SEPARADAS tanto no texto quanto no JSON — nunca fundidas em um único
 * número. Métrica ausente é sempre `null` com a `provenance` registrada,
 * nunca zero, que se confundiria com uma medição real.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { EVALUATION_RECORD_FILE_NAME } from '../evaluator/index.js';
import { EvaluationRecord, ExecutionRecord, QualificationRecord, ScoreRecord } from '../schemas/index.js';
import { EXECUTION_RECORD_FILE_NAME } from './run-execute.js';
import { QUALIFICATION_RECORD_FILE_NAME, SCORE_RECORD_FILE_NAME } from './score.js';

export interface ReportRunOptions {
  /** Raiz do run já selado — a mesma pasta que `prepareRun`/`executeRun` produziram. */
  readonly runDir: string;
  readonly evaluationId: string;
  readonly scoreId: string;
}

/** As três dimensões de um run, sempre reportadas separadamente. */
export interface RunReport {
  readonly execution: ExecutionRecord;
  readonly evaluation: EvaluationRecord;
  readonly score: ScoreRecord;
  readonly qualification: QualificationRecord;
}

/**
 * Lê `execution/`, `evaluations/<evaluationId>/` e `scores/<scoreId>/` do
 * run e monta o `RunReport`. Nenhum valor é recalculado — tudo já está
 * selado no disco pelas etapas anteriores (`run`, `evaluate`, `score`).
 */
export async function buildRunReport(options: ReportRunOptions): Promise<RunReport> {
  const executionDir = path.join(options.runDir, 'execution');
  const evaluationDir = path.join(options.runDir, 'evaluations', options.evaluationId);
  const scoreDir = path.join(options.runDir, 'scores', options.scoreId);

  const execution = await readRecord(
    path.join(executionDir, EXECUTION_RECORD_FILE_NAME),
    ExecutionRecord,
  );
  const evaluation = await readRecord(
    path.join(evaluationDir, EVALUATION_RECORD_FILE_NAME),
    EvaluationRecord,
  );
  const score = await readRecord(path.join(scoreDir, SCORE_RECORD_FILE_NAME), ScoreRecord);
  const qualification = await readRecord(
    path.join(scoreDir, QUALIFICATION_RECORD_FILE_NAME),
    QualificationRecord,
  );

  return { execution, evaluation, score, qualification };
}

async function readRecord<T>(filePath: string, schema: { parse(value: unknown): T }): Promise<T> {
  const raw = await readFile(filePath, 'utf8');
  return schema.parse(JSON.parse(raw));
}

/** Serialização estável para `--json`: mesmas três dimensões, sem achatar. */
export function formatRunReportJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Renderização para terminal, com execução, avaliação e qualificação em blocos separados. */
export function formatRunReportText(report: RunReport): string {
  const lines: string[] = [
    '== Execução ==',
    `status: ${report.execution.status}`,
    `exit_code: ${formatNullable(report.execution.exit_code)}`,
    `duration_ms: ${report.execution.duration_ms}`,
    `tokens: ${formatMetric(report.execution.metrics.tokens)}`,
    `changed_files: ${formatMetric(report.execution.metrics.changed_files)}`,
    '',
    '== Avaliação ==',
    `evaluation_id: ${report.evaluation.evaluation_id}`,
    `outcome: ${report.evaluation.outcome}`,
    ...Object.entries(report.evaluation.grader_results).map(
      ([graderId, result]) =>
        `  ${graderId}: ${result.outcome}${result.required ? ' (obrigatório)' : ' (opcional)'}`,
    ),
    '',
    '== Qualificação ==',
    `status: ${report.qualification.status}`,
    `justification: ${formatNullable(report.qualification.justification)}`,
    `score_profile: ${report.score.score_profile_id} (${report.score.score_profile_version})`,
    `coverage: ${report.score.coverage}`,
    ...Object.entries(report.score.sub_scores).map(
      ([dimension, subScore]) =>
        `  ${dimension}: ${formatNullable(subScore.value)} (weight ${subScore.weight}${subScore.required ? ', obrigatório' : ''})`,
    ),
  ];

  return `${lines.join('\n')}\n`;
}

function formatNullable(value: number | string | null): string {
  return value === null ? 'null' : String(value);
}

function formatMetric(metric: { readonly value: number | null; readonly provenance: string }): string {
  return `${formatNullable(metric.value)} (origem: ${metric.provenance})`;
}
