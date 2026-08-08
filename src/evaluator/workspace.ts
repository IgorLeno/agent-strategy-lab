/**
 * Workspace do evaluator: um clone INDEPENDENTE do mesmo base SHA usado pelo
 * agente, com o `changes.patch` reaplicado por cima. O workspace do agente já
 * foi descartado quando o evaluator entra em cena — este módulo nunca abre o
 * clone do agente, só recria a árvore dele a partir do patch capturado.
 *
 * O EvaluationPlan é materializado SÓ aqui, e dentro de `.git/` — fora da
 * working tree. É a fronteira do módulo: qualquer coisa que trate a working
 * tree como material do agente (bundle, log, artefato do run) não pode
 * enxergar o plano por acidente, e o plano nunca chega perto do clone em que
 * o agente rodou.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvaluationPlan } from '../schemas/index.js';
import { gitOrThrow } from '../workspace/clone.js';
import {
  assertWithinClone,
  createDisposableClone,
  disposeClone,
  type CreateDisposableCloneOptions,
  type DisposableClone,
} from '../workspace/index.js';

/** Nome do arquivo do plano dentro de `.git/` do clone do evaluator. */
export const EVALUATION_PLAN_FILE_NAME = 'agentlab-evaluation-plan.json';

export interface CreateEvaluatorWorkspaceOptions extends CreateDisposableCloneOptions {
  /** `changes.patch` capturado do workspace do agente, reaplicado aqui. */
  readonly patchPath: string;
  /** Contrato privado de avaliação — nunca visto pelo agente. */
  readonly evaluationPlan: EvaluationPlan;
}

export interface EvaluatorWorkspace {
  readonly clone: DisposableClone;
  readonly evaluationPlan: EvaluationPlan;
  /** Caminho, dentro de `.git/` do clone, onde o plano foi escrito. */
  readonly evaluationPlanPath: string;
}

/**
 * Cria o clone do evaluator, reaplica o patch e grava o plano.
 *
 * Qualquer falha nesses passos descarta o clone antes de propagar o erro — não
 * existe workspace do evaluator meio criado sobrevivendo ao erro, do mesmo
 * jeito que o clone do agente em `createDisposableClone`.
 */
export async function createEvaluatorWorkspace(
  options: CreateEvaluatorWorkspaceOptions,
): Promise<EvaluatorWorkspace> {
  const { patchPath, evaluationPlan, ...cloneOptions } = options;
  const clone = await createDisposableClone(cloneOptions);

  try {
    await gitOrThrow(clone.clonePath, ['apply', '--binary', patchPath]);
    const evaluationPlanPath = await assertWithinClone(
      clone,
      path.join(clone.gitDir, EVALUATION_PLAN_FILE_NAME),
    );
    await writeFile(evaluationPlanPath, `${JSON.stringify(evaluationPlan, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { clone, evaluationPlan, evaluationPlanPath };
  } catch (error) {
    await disposeClone(clone);
    throw error;
  }
}

/**
 * Cria o workspace do evaluator, entrega ao `run` e o descarta — inclusive
 * quando o `run` falha. Espelha `withDisposableClone` do workspace do agente.
 */
export async function withEvaluatorWorkspace<T>(
  options: CreateEvaluatorWorkspaceOptions,
  run: (workspace: EvaluatorWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await createEvaluatorWorkspace(options);
  try {
    return await run(workspace);
  } finally {
    await disposeClone(workspace.clone);
  }
}
