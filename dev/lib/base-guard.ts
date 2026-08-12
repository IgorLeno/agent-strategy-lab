import { changedFiles, gitOrThrow, headSha, isWorkingTreeClean, parentShas } from './git.js';
import { assertAllowedMaintenanceFiles } from './maintenance.js';
import type { HarnessPaths } from './paths.js';
import type { DevelopmentState } from './schemas.js';

/**
 * Guarda da BASE da próxima tarefa.
 *
 * O `base_sha` do packet saía direto do HEAD atual, sem confirmar que o HEAD
 * ainda é o último commit aceito e que a árvore está limpa. Trabalho externo
 * entre duas sessões — commit manual, merge, arquivo não commitado — entrava
 * silenciosamente na base da tarefa seguinte e contaminava a evidência: o
 * dev-close exige exatamente um commit sobre o base_sha, então tudo que veio
 * antes passaria como se fosse trabalho do worker.
 *
 * Isto é sobre PROGRESSÃO, não sobre recuperação: o dev-recover continua sem
 * exigir árvore limpa, porque reconciliar fechamento histórico não pode
 * depender do estado atual do checkout.
 */
export function expectedBaseSha(state: DevelopmentState): string | null {
  return state.authorized_head_sha;
}

export type ProgressionBaseBlocker = 'DIRTY_WORKTREE' | 'BASE_DIVERGED';

export interface ProgressionBaseCheck {
  readonly blocker: ProgressionBaseBlocker | null;
  readonly reason: string | null;
}

/** Inspeção estruturada compartilhada pela guarda e pelas views operacionais. */
export async function inspectProgressionBase(
  paths: HarnessPaths,
  state: DevelopmentState,
): Promise<ProgressionBaseCheck> {
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    return {
      blocker: 'DIRTY_WORKTREE',
      reason: 'working tree suja — a próxima tarefa precisa partir de uma base limpa',
    };
  }

  const expected = expectedBaseSha(state);
  if (expected === null) return { blocker: null, reason: null };

  const head = await headSha(paths.repoRoot);
  if (head !== expected) {
    return {
      blocker: 'BASE_DIVERGED',
      reason: `HEAD (${head}) não é a base esperada (${expected}) — houve trabalho fora do harness`,
    };
  }
  return { blocker: null, reason: null };
}

/** Devolve o motivo do bloqueio, ou `null` quando a base está íntegra. */
export async function checkProgressionBase(
  paths: HarnessPaths,
  state: DevelopmentState,
): Promise<string | null> {
  return (await inspectProgressionBase(paths, state)).reason;
}

export class AttemptHeadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptHeadError';
  }
}

export interface AttemptHeadGuardInput {
  readonly repoRoot: string;
  /** `base_sha` do attempt que está sendo encerrado. */
  readonly baseSha: string;
  readonly authorizedHeadSha: string | null;
  /**
   * Libera EXATAMENTE um commit de manutenção sobre o `base_sha`: é o caso em
   * que o próprio harness foi consertado para conseguir encerrar o attempt.
   */
  readonly allowPendingMaintenance: boolean;
  /** Nome da operação, usado só na recusa por árvore suja. */
  readonly label: string;
}

/**
 * Guarda de HEAD comum a todo encerramento de attempt sem solução aceita
 * (`dev-retry`, `dev-recover-infra`).
 *
 * Encerrar um attempt não pode acontecer sobre um repositório que mudou por
 * fora: o record afirma `working_tree_clean` e `head_sha`, e essas duas
 * afirmações precisam ser verdadeiras no instante em que são gravadas.
 */
export async function assertAttemptHead(input: AttemptHeadGuardInput): Promise<string> {
  const head = await headSha(input.repoRoot);
  if (!(await isWorkingTreeClean(input.repoRoot))) {
    throw new AttemptHeadError(`working tree suja; ${input.label} recusado`);
  }

  if (!input.allowPendingMaintenance) {
    if (head !== input.baseSha) {
      throw new AttemptHeadError(`HEAD ${head} diverge do base_sha ${input.baseSha}`);
    }
    const count = Number(
      (await gitOrThrow(input.repoRoot, ['rev-list', '--count', `${input.baseSha}..HEAD`])).trim(),
    );
    if (count !== 0) throw new AttemptHeadError('existe commit sobre o base_sha');
    return head;
  }

  if (input.authorizedHeadSha !== input.baseSha) {
    throw new AttemptHeadError('base_sha da tentativa diverge de authorized_head_sha');
  }
  const count = Number(
    (await gitOrThrow(input.repoRoot, ['rev-list', '--count', `${input.baseSha}..HEAD`])).trim(),
  );
  if (count !== 1) {
    throw new AttemptHeadError(
      `--allow-pending-maintenance exige exatamente um commit; encontrados ${count}`,
    );
  }
  const parents = await parentShas(input.repoRoot, head);
  if (parents.length !== 1 || parents[0] !== input.baseSha) {
    throw new AttemptHeadError(
      'commit de manutenção não é filho direto do base_sha e authorized_head_sha',
    );
  }
  assertAllowedMaintenanceFiles(await changedFiles(input.repoRoot, head));
  return head;
}
