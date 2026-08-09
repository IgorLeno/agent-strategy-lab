/**
 * `agentlab score`: pontua uma avaliação já selada de um run, sem depender de
 * nenhum estado em memória do `evaluate` que a produziu — só lê `execution/` e
 * `evaluations/<evaluationId>/` do disco.
 *
 * Fronteira: nenhum clone é reaberto aqui. `scoreRunV1` já é puro (M29); este
 * módulo só lê os records de entrada e materializa `scores/<score-id>/`.
 * Rodar de novo sobre a mesma avaliação com um `scoreId` novo cria
 * `scores/<novo-id>/` e não toca em nenhum score anterior — mesma garantia de
 * `evaluateRun`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExecutionEnvelopeManifest } from '../envelope/index.js';
import { scoreRunV1, type ScoreProfileV1Result } from '../scorer/index.js';
import { EvaluationRecord, ExecutionRecord } from '../schemas/index.js';
import { sealScore, type SealedSection } from '../storage/index.js';
import { EXECUTION_RECORD_FILE_NAME } from './run-execute.js';
import { EVALUATION_RECORD_FILE_NAME } from '../evaluator/index.js';
import { EXECUTION_ENVELOPE_FILE_NAME } from './run-prepare.js';

/** Nome do arquivo do ScoreRecord dentro de `scores/<id>/`. */
export const SCORE_RECORD_FILE_NAME = 'score-record.json';
/** Nome do arquivo do QualificationRecord dentro de `scores/<id>/`. */
export const QUALIFICATION_RECORD_FILE_NAME = 'qualification-record.json';

export interface ScoreRunOptions {
  /** Raiz do run já selado — a mesma pasta que `prepareRun`/`executeRun` produziram. */
  readonly runDir: string;
  readonly evaluationId: string;
  readonly scoreId: string;
  readonly now?: Date;
}

export interface ScoredRun extends ScoreProfileV1Result {
  readonly scoreId: string;
  readonly sealed: SealedSection;
}

/**
 * Lê `execution/` e `evaluations/<evaluationId>/` do run, roda o perfil de
 * score v1 e sela `scores/<scoreId>/`.
 */
export async function scoreRun(options: ScoreRunOptions): Promise<ScoredRun> {
  const executionDir = path.join(options.runDir, 'execution');
  const executionRecord = await readExecutionRecord(executionDir);
  const executionEnvelope = await readExecutionEnvelope(executionDir);
  const evaluationRecord = await readEvaluationRecord(options.runDir, options.evaluationId);

  const { score, qualification } = scoreRunV1({
    executionRecord,
    evaluationRecord,
    budgets: executionEnvelope.budgets,
  });

  await materializeScoreSection(options.runDir, options.scoreId, score, qualification);
  const sealed = await sealScore(options.runDir, options.scoreId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return { scoreId: options.scoreId, score, qualification, sealed };
}

async function readExecutionRecord(executionDir: string): Promise<ExecutionRecord> {
  const raw = await readFile(path.join(executionDir, EXECUTION_RECORD_FILE_NAME), 'utf8');
  return ExecutionRecord.parse(JSON.parse(raw));
}

async function readExecutionEnvelope(executionDir: string): Promise<ExecutionEnvelopeManifest> {
  const raw = await readFile(path.join(executionDir, EXECUTION_ENVELOPE_FILE_NAME), 'utf8');
  return JSON.parse(raw) as ExecutionEnvelopeManifest;
}

async function readEvaluationRecord(runDir: string, evaluationId: string): Promise<EvaluationRecord> {
  const recordPath = path.join(runDir, 'evaluations', evaluationId, EVALUATION_RECORD_FILE_NAME);
  const raw = await readFile(recordPath, 'utf8');
  return EvaluationRecord.parse(JSON.parse(raw));
}

/**
 * Materializa `scores/<id>/` com o ScoreRecord e o QualificationRecord —
 * escrita exclusiva: rodar de novo com o mesmo `scoreId` falha em vez de
 * sobrescrever a evidência já selada.
 */
async function materializeScoreSection(
  runDir: string,
  scoreId: string,
  score: ScoreProfileV1Result['score'],
  qualification: ScoreProfileV1Result['qualification'],
): Promise<void> {
  const sectionDir = path.join(runDir, 'scores', scoreId);
  await mkdir(sectionDir, { recursive: true });

  await writeFile(
    path.join(sectionDir, SCORE_RECORD_FILE_NAME),
    `${JSON.stringify(score, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  await writeFile(
    path.join(sectionDir, QUALIFICATION_RECORD_FILE_NAME),
    `${JSON.stringify(qualification, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
}
