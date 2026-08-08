/**
 * Orquestração da avaliação: roda os graders de comando do EvaluationPlan no
 * workspace do evaluator, decide o outcome e sela `evaluations/<id>/` como
 * seção própria do run.
 *
 * Grader obrigatório com FAIL força outcome FAIL — a mesma regra que o schema
 * `EvaluationRecord` já valida. Sem falha obrigatória, mas com algum grader
 * opcional em FAIL, o outcome é PARTIAL: nem PASS limpo, nem bloqueado pelo
 * obrigatório. Sem nenhuma falha, PASS.
 *
 * Reavaliar é só chamar esta função de novo com um `evaluationId` novo: cada
 * chamada sela sua própria seção via `sealEvaluation` (adição *pura*, nunca
 * reescrita) e a avaliação anterior não é tocada.
 */

import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EvaluationOutcome } from '../core/enums.js';
import {
  evaluationEnvelopeSha256,
  type EvaluationEnvelopeManifest,
} from '../envelope/index.js';
import type { EnvironmentProfile, EvaluationRecord, GraderResult } from '../schemas/index.js';
import { sealEvaluation, type SealedSection } from '../storage/index.js';
import { GRADER_ARTIFACTS_DIR_NAME, runCommandGrader, type CommandGraderRun } from './command-grader.js';
import type { EvaluatorWorkspace } from './workspace.js';

/** Nome do arquivo do EvaluationRecord dentro de `evaluations/<id>/`. */
export const EVALUATION_RECORD_FILE_NAME = 'evaluation-record.json';

/** Um grader de comando participante da avaliação. */
export interface GraderSpec {
  /** `argv[0]` é o executável, nunca uma linha para um shell montar. */
  readonly argv: readonly string[];
  /** Se um FAIL deste grader força o outcome da avaliação para FAIL. */
  readonly required: boolean;
  readonly version: string;
  readonly timeoutMs?: number;
  readonly gracePeriodMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface RunEvaluationOptions {
  /** Workspace do evaluator — clone com o patch do agente já aplicado e o EvaluationPlan gravado. */
  readonly workspace: EvaluatorWorkspace;
  readonly evaluationId: string;
  /** Raiz do run, a mesma de `createRunDirectory` — onde `evaluations/<id>/` é selada. */
  readonly runDir: string;
  readonly executionManifestSha256: string;
  readonly evaluatorEnvironment: EnvironmentProfile;
  readonly graders: Readonly<Record<string, GraderSpec>>;
  readonly now?: Date;
}

export interface EvaluationRun {
  readonly record: EvaluationRecord;
  readonly sealed: SealedSection;
  readonly graderRuns: Readonly<Record<string, CommandGraderRun>>;
}

/**
 * Roda todos os graders de `options.graders`, monta o `EvaluationRecord` e
 * sela a seção correspondente do run.
 *
 * Os graders rodam em sequência: são a mesma clone descartável do evaluator, e
 * rodar em paralelo faria dois processos disputarem a mesma working tree.
 */
export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationRun> {
  const graderIds = Object.keys(options.graders);
  if (graderIds.length === 0) {
    throw new TypeError('graders deve ter ao menos um grader');
  }

  const graderRuns: Record<string, CommandGraderRun> = {};
  for (const graderId of graderIds) {
    const spec = options.graders[graderId]!;
    graderRuns[graderId] = await runCommandGrader({
      clone: options.workspace.clone,
      graderId,
      argv: spec.argv,
      required: spec.required,
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      ...(spec.gracePeriodMs === undefined ? {} : { gracePeriodMs: spec.gracePeriodMs }),
      ...(spec.env === undefined ? {} : { env: spec.env }),
    });
  }

  const graderResults: Record<string, GraderResult> = {};
  const graderVersions: Record<string, string> = {};
  const evaluationCommands: Record<string, readonly string[]> = {};
  for (const graderId of graderIds) {
    graderResults[graderId] = graderRuns[graderId]!.result;
    graderVersions[graderId] = options.graders[graderId]!.version;
    evaluationCommands[graderId] = options.graders[graderId]!.argv;
  }

  const manifest: EvaluationEnvelopeManifest = {
    execution_manifest_sha256: options.executionManifestSha256,
    evaluation_plan: options.workspace.evaluationPlan,
    grader_versions: graderVersions,
    evaluator_environment: options.evaluatorEnvironment,
    evaluation_commands: evaluationCommands,
  };

  const record: EvaluationRecord = {
    evaluation_id: options.evaluationId,
    outcome: decideOutcome(graderResults),
    grader_results: graderResults,
    grader_versions: graderVersions,
    evaluation_envelope_sha256: evaluationEnvelopeSha256(manifest),
  };

  await materializeEvaluationSection(options, record);
  const sealed = await sealEvaluation(options.runDir, options.evaluationId, {
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return { record, sealed, graderRuns };
}

/**
 * `required` com FAIL vence sempre — o mesmo invariante que o schema
 * `EvaluationRecord` reforça na validação. Sem isso, um FAIL opcional ainda
 * marca PARTIAL: a avaliação não é um PASS limpo, mas nada obrigatório barrou.
 */
function decideOutcome(results: Readonly<Record<string, GraderResult>>): EvaluationOutcome {
  const values = Object.values(results);
  const requiredFailed = values.some(
    (result) => result.required && result.outcome === EvaluationOutcome.FAIL,
  );
  if (requiredFailed) return EvaluationOutcome.FAIL;

  const optionalFailed = values.some(
    (result) => !result.required && result.outcome === EvaluationOutcome.FAIL,
  );
  return optionalFailed ? EvaluationOutcome.PARTIAL : EvaluationOutcome.PASS;
}

/**
 * Materializa `evaluations/<id>/` fora do clone: o `EvaluationRecord` e os
 * `grader-artifacts/` que os graders escreveram dentro do `.git` do clone —
 * evidência que morreria junto com o clone descartável se ficasse só lá.
 */
async function materializeEvaluationSection(
  options: RunEvaluationOptions,
  record: EvaluationRecord,
): Promise<void> {
  const sectionDir = path.join(options.runDir, 'evaluations', options.evaluationId);
  await mkdir(sectionDir, { recursive: true });

  const artifactsSource = path.join(options.workspace.clone.gitDir, GRADER_ARTIFACTS_DIR_NAME);
  await cp(artifactsSource, path.join(sectionDir, GRADER_ARTIFACTS_DIR_NAME), { recursive: true });

  const recordPath = path.join(sectionDir, EVALUATION_RECORD_FILE_NAME);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}
