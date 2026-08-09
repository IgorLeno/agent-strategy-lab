/**
 * `agentlab evaluate`: avalia um run já selado sem depender de nenhum estado
 * em memória do `run` que o produziu — só lê `execution/` do disco.
 *
 * Fronteira: nenhum clone do agente é reaberto aqui. O evaluator recria a
 * árvore a partir do `base_sha` e do `changes.patch` que `execution/` já
 * capturou, exatamente como `EvaluatorWorkspace` documenta. Rodar de novo
 * sobre o mesmo run com um `evaluationId` novo cria `evaluations/<novo-id>/`
 * e não toca em nenhuma avaliação anterior — mesma garantia de `runEvaluation`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExecutionEnvelopeManifest } from '../envelope/index.js';
import {
  createEvaluatorWorkspace,
  runEvaluation,
  type EvaluationRun,
  type GraderSpec,
} from '../evaluator/index.js';
import type { EnvironmentProfile, EvaluationPlan } from '../schemas/index.js';
import { ExecutionRecord } from '../schemas/index.js';
import { CHANGES_PATCH_FILE_NAME, disposeClone } from '../workspace/index.js';
import { CHANGES_DIR_NAME, EXECUTION_RECORD_FILE_NAME } from './run-execute.js';
import { EXECUTION_ENVELOPE_FILE_NAME } from './run-prepare.js';

export interface EvaluateRunOptions {
  /** Raiz do run já selado — a mesma pasta que `prepareRun`/`executeRun` produziram. */
  readonly runDir: string;
  readonly evaluationId: string;
  /** Repo-alvo do clone descartável do evaluator — só é lido. */
  readonly sourceRepo: string;
  readonly evaluationPlan: EvaluationPlan;
  readonly graders: Readonly<Record<string, GraderSpec>>;
  readonly evaluatorEnvironment: EnvironmentProfile;
  /** Diretório onde o clone do evaluator é criado; default: `os.tmpdir()`. */
  readonly parentDir?: string;
  readonly now?: Date;
}

export interface EvaluatedRun extends EvaluationRun {
  readonly evaluationId: string;
}

/**
 * Recria o clone do evaluator a partir de `execution/` do run e roda os
 * graders sobre ele, selando `evaluations/<evaluationId>/`.
 *
 * O clone do evaluator é sempre descartado, inclusive quando `runEvaluation`
 * falha — o mesmo padrão de `executeRun` para o clone do agente.
 */
export async function evaluateRun(options: EvaluateRunOptions): Promise<EvaluatedRun> {
  const executionDir = path.join(options.runDir, 'execution');
  const executionRecord = await readExecutionRecord(executionDir);
  const executionEnvelope = await readExecutionEnvelope(executionDir);
  const patchPath = path.join(executionDir, CHANGES_DIR_NAME, CHANGES_PATCH_FILE_NAME);

  const workspace = await createEvaluatorWorkspace({
    sourceRepo: options.sourceRepo,
    baseSha: executionEnvelope.base_sha,
    ...(options.parentDir === undefined ? {} : { parentDir: options.parentDir }),
    patchPath,
    evaluationPlan: options.evaluationPlan,
  });

  try {
    const run = await runEvaluation({
      workspace,
      evaluationId: options.evaluationId,
      runDir: options.runDir,
      executionManifestSha256: executionRecord.execution_envelope_sha256,
      evaluatorEnvironment: options.evaluatorEnvironment,
      graders: options.graders,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return { evaluationId: options.evaluationId, ...run };
  } finally {
    await disposeClone(workspace.clone);
  }
}

async function readExecutionRecord(executionDir: string): Promise<ExecutionRecord> {
  const raw = await readFile(path.join(executionDir, EXECUTION_RECORD_FILE_NAME), 'utf8');
  return ExecutionRecord.parse(JSON.parse(raw));
}

async function readExecutionEnvelope(executionDir: string): Promise<ExecutionEnvelopeManifest> {
  const raw = await readFile(path.join(executionDir, EXECUTION_ENVELOPE_FILE_NAME), 'utf8');
  return JSON.parse(raw) as ExecutionEnvelopeManifest;
}
