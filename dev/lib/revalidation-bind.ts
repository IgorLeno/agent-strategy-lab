import { readFile } from 'node:fs/promises';
import {
  FailedAttemptSourceError,
  materializeFailedAttemptSource,
} from './failed-attempt-source.js';
import type { HarnessPaths } from './paths.js';
import { completionPath } from './records.js';
import type { RevalidationSourceBinding as RevalidationSourceBindingType } from './schemas.js';
import { getTaskState, readState } from './state.js';

export class RevalidationBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevalidationBindError';
  }
}

export interface BindRevalidationSourceInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly now?: () => string;
}

export interface BindRevalidationSourceResult {
  readonly binding: RevalidationSourceBindingType;
  readonly bindingPath: string;
  readonly originalCompletionPath: string;
  readonly alreadyBound: boolean;
}

/**
 * Sela a fonte de um FAIL para revalidação auditada.
 *
 * Desde que o finalization passou a materializar o binding no instante do FAIL
 * (`failed-attempt-source.ts`), este comando quase sempre encontra a fonte já
 * publicada e só a reconfere — o que é exatamente o que se quer de um
 * preflight. Ele continua existindo porque um FAIL LEGADO, anterior àquela
 * correção, ainda precisa de alguém que derive o binding a partir da evidence
 * que sobrou.
 *
 * Selar não é revalidar: aqui nenhuma validation roda, o state não muda, o HEAD
 * não muda e nenhum provider é chamado. Só evidência é publicada, write-once.
 */
export async function bindRevalidationSource(
  input: BindRevalidationSourceInput,
): Promise<BindRevalidationSourceResult> {
  const { paths, taskId } = input;
  const state = await readState(paths);
  const task = getTaskState(state, taskId);
  if (task.status !== 'FAIL') {
    throw new RevalidationBindError(`bind exige tarefa FAIL, encontrada ${task.status}`);
  }
  if (task.attempts < 1) throw new RevalidationBindError('FAIL sem attempt');
  if (task.candidate_commit !== null || task.accepted_commit !== null) {
    throw new RevalidationBindError('FAIL não pode ter candidate/accepted commit no state');
  }
  if (task.base_sha === null) throw new RevalidationBindError('FAIL sem base_sha no state');
  if (state.authorized_head_sha === null) {
    throw new RevalidationBindError('authorized_head_sha ausente');
  }

  let completionBytes: Buffer;
  try {
    completionBytes = await readFile(completionPath(paths, taskId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RevalidationBindError('CompletionRecord ausente');
    }
    throw error;
  }

  try {
    const published = await materializeFailedAttemptSource({
      paths,
      taskId,
      attempt: task.attempts,
      completionBytes,
      stateBaseSha: task.base_sha,
      expectedHeadSha: state.authorized_head_sha,
      provenance: 'derived_during_revalidation_preflight',
      ...(input.now === undefined ? {} : { now: input.now }),
    });
    return {
      binding: published.binding,
      bindingPath: published.bindingPath,
      originalCompletionPath: published.originalCompletionPath,
      alreadyBound: published.alreadyBound,
    };
  } catch (error) {
    // A fronteira do comando continua sendo RevalidationBindError: quem chama
    // dev-revalidation-bind não deveria precisar conhecer o helper interno.
    if (error instanceof FailedAttemptSourceError) {
      throw new RevalidationBindError(error.message);
    }
    throw error;
  }
}
