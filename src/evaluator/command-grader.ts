/**
 * Grader de comando: roda `argv` (sem shell) na working tree do clone do
 * evaluator e converte exit code em `GraderResult`. Reusa `captureProcess` do
 * runner — mesmo spawn sem shell, mesma captura redigida de stdout/stderr e
 * mesma escalada de sinal — só que com `logDir` sob `grader-artifacts/<id>/`
 * dentro do `.git` do clone, ao lado do `EVALUATION_PLAN_FILE_NAME`: evidência
 * do evaluator, fora da árvore que o patch do agente reconstituiu.
 *
 * Exit code 0 é PASS, qualquer outro (incluindo `null` — morto por sinal) é
 * FAIL. Timeout deste grader é reportado à parte, em `timedOut`: um grader que
 * estourou o prazo e um grader que rodou até o fim e falhou terminam os dois
 * em FAIL, mas são evidências diferentes, e `timedOut` é o que preserva a
 * diferença para quem monta o EvaluationRecord.
 */

import path from 'node:path';

import { EvaluationOutcome } from '../core/enums.js';
import type { GraderResult } from '../schemas/index.js';
import {
  captureProcess,
  type CapturedStream,
  type CaptureProcessOptions,
} from '../runner/index.js';
import { assertWithinClone, type DisposableClone } from '../workspace/index.js';

/** Diretório, dentro de `.git` do clone, em que os artefatos de todo grader são gravados. */
export const GRADER_ARTIFACTS_DIR_NAME = 'grader-artifacts';

const GRADER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface RunCommandGraderOptions {
  /** Clone do evaluator — working tree com o patch do agente já aplicado. */
  readonly clone: DisposableClone;
  /** Identificador do grader; nomeia o subdiretório de artefatos, então é validado como caminho. */
  readonly graderId: string;
  /** Comando avaliado: `argv[0]` é o executável, nunca uma linha para um shell montar. */
  readonly argv: readonly string[];
  /** Se um FAIL deste grader força o outcome da avaliação — carregado ao `GraderResult`, não decidido aqui. */
  readonly required: boolean;
  /** Prazo próprio deste grader, independente do timeout do run do agente. Ausente: sem timeout. */
  readonly timeoutMs?: number;
  readonly gracePeriodMs?: number;
  readonly cleanupConfirmTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CommandGraderArtifacts {
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
}

/** Desfecho auditável de um grader de comando: o `GraderResult` mais a evidência que o sustenta. */
export interface CommandGraderRun {
  readonly graderId: string;
  readonly result: GraderResult;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /**
   * `true` quando o prazo próprio deste grader venceu. Independente do
   * `outcome`: um FAIL por timeout e um FAIL por exit code não-zero carregam o
   * mesmo `outcome`, e é este campo que distingue os dois.
   */
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly artifacts: CommandGraderArtifacts;
}

/**
 * Executa `argv` no clone do evaluator e devolve o `CommandGraderRun`.
 *
 * Rejeita quando o comando não chega a iniciar (`ProcessSpawnError`) ou quando
 * a saída não pôde ser persistida (`ProcessCaptureError`) — nenhum dos dois é
 * um resultado do grader, e reportar um FAIL ali inventaria evidência sobre um
 * comando que nunca rodou até o fim.
 */
export async function runCommandGrader(
  options: RunCommandGraderOptions,
): Promise<CommandGraderRun> {
  const graderId = assertGraderId(options.graderId);
  const logDir = await assertWithinClone(
    options.clone,
    path.join(options.clone.gitDir, GRADER_ARTIFACTS_DIR_NAME, graderId),
  );

  const captureOptions: CaptureProcessOptions = {
    argv: options.argv,
    cwd: options.clone.clonePath,
    logDir,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.gracePeriodMs === undefined ? {} : { gracePeriodMs: options.gracePeriodMs }),
    ...(options.cleanupConfirmTimeoutMs === undefined
      ? {}
      : { cleanupConfirmTimeoutMs: options.cleanupConfirmTimeoutMs }),
  };

  const startedAt = Date.now();
  const capture = await captureProcess(captureOptions);
  const durationMs = Date.now() - startedAt;

  const outcome = capture.exitCode === 0 ? EvaluationOutcome.PASS : EvaluationOutcome.FAIL;

  return {
    graderId,
    result: { outcome, required: options.required },
    exitCode: capture.exitCode,
    signal: capture.signal,
    timedOut: capture.timedOut,
    durationMs,
    artifacts: { stdout: capture.stdout, stderr: capture.stderr },
  };
}

/**
 * `graderId` vira nome de diretório dentro de `.git` do clone — validado antes
 * de chegar ao `path.join`, e não depois pelo `assertWithinClone`, para que um
 * `..` no id produza um erro sobre o id e não sobre "caminho fora do clone".
 */
function assertGraderId(graderId: string): string {
  if (!GRADER_ID_PATTERN.test(graderId)) {
    throw new TypeError(`graderId deve ser alfanumérico com - ou _: ${graderId}`);
  }
  return graderId;
}
