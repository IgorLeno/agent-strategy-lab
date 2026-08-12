import {
  changedFiles,
  gitOrThrow,
  headSha,
  isAncestor,
  isWorkingTreeClean,
  parentShas,
} from './git.js';
import {
  assertAllowedMaintenanceFiles,
  maintenanceChainBetween,
  resolveAdoptionKind,
} from './maintenance.js';
import type { HarnessPaths } from './paths.js';
import type { DevelopmentState, MaintenanceRecord } from './schemas.js';

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

/**
 * Como o HEAD atual se relaciona com a base HISTÓRICA do attempt encerrado.
 *
 * - `plain`: base do attempt, base autorizada e HEAD são o mesmo commit;
 * - `pending_maintenance`: um commit de manutenção AINDA NÃO adotado sobre a base;
 * - `adopted_maintenance`: a base autorizada avançou além da base do attempt, e
 *   toda a diferença está explicada por MaintenanceRecords adotados.
 */
export type AttemptRecoveryHeadMode = 'plain' | 'pending_maintenance' | 'adopted_maintenance';

export interface AttemptRecoveryHeadInput {
  readonly paths: HarnessPaths;
  /** `base_sha` histórico do attempt — nunca reescrito por este caminho. */
  readonly baseSha: string;
  readonly authorizedHeadSha: string | null;
  readonly allowPendingMaintenance: boolean;
  readonly label: string;
}

export interface AttemptRecoveryHead {
  readonly headSha: string;
  readonly mode: AttemptRecoveryHeadMode;
  /** Records que explicam `base_sha` → `authorized_head_sha`; vazio nos outros modos. */
  readonly adoptedChain: readonly MaintenanceRecord[];
}

/**
 * Manutenção adotada não pode tornar irrecuperável um attempt anterior a ela.
 *
 * O caso real da M50: o attempt nasceu em A, morreu por falha de infraestrutura
 * do provider, e enquanto ninguém o arquivava a manutenção auditada avançou a
 * base autorizada de A até C. O attempt continua sendo de A — reescrever seu
 * `base_sha` seria fabricar história —, mas `assertAttemptHead` só conhecia
 * HEAD == base_sha e a exceção de UM commit pendente, e recusava para sempre.
 *
 * A diferença entre a base do attempt e o HEAD só é legítima quando alguém já
 * respondeu integralmente por ela: `maintenanceChainBetween` é a única fonte
 * dessa prova, e ela já verifica cada record contra o Git (parent único,
 * `changed_files` idênticos, allowlist de manutenção). Descendência não é
 * argumento: um descendente qualquer pode carregar trabalho externo que
 * ninguém auditou, então ancestralidade é conferida como fail-fast e a cadeia
 * completa é a condição.
 *
 * Política conservadora para este caminho: só `maintenance` e
 * `maintenance_range`. Atravessar `plan_extension` mudaria o próprio plano por
 * baixo de um attempt histórico — decisão de quem lê o plano, não deste guard.
 */
export async function assertAttemptRecoveryHead(
  input: AttemptRecoveryHeadInput,
): Promise<AttemptRecoveryHead> {
  const { paths, authorizedHeadSha: authorized } = input;
  const legacy = async (mode: AttemptRecoveryHeadMode): Promise<AttemptRecoveryHead> => ({
    headSha: await assertAttemptHead({
      repoRoot: paths.repoRoot,
      baseSha: input.baseSha,
      authorizedHeadSha: authorized,
      allowPendingMaintenance: input.allowPendingMaintenance,
      label: input.label,
    }),
    mode,
    adoptedChain: [],
  });

  // Manutenção pendente e base intocada continuam sob o contrato antigo, letra
  // por letra: ampliá-lo aqui mudaria silenciosamente outros encerramentos.
  if (input.allowPendingMaintenance) return legacy('pending_maintenance');
  if (authorized === null || authorized === input.baseSha) return legacy('plain');

  const head = await headSha(paths.repoRoot);
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    throw new AttemptHeadError(`working tree suja; ${input.label} recusado`);
  }
  if (head !== authorized) {
    throw new AttemptHeadError(`HEAD ${head} diverge de authorized_head_sha ${authorized}`);
  }
  if (!(await isAncestor(paths.repoRoot, input.baseSha, authorized))) {
    throw new AttemptHeadError(
      `base_sha ${input.baseSha} não é ancestral da base autorizada ${authorized}`,
    );
  }

  let chain: readonly MaintenanceRecord[];
  try {
    chain = await maintenanceChainBetween(paths, input.baseSha, authorized);
  } catch (error) {
    throw new AttemptHeadError(
      `manutenção adotada não explica a diferença entre base_sha ${input.baseSha} e ` +
        `authorized_head_sha ${authorized}: ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
  for (const record of chain) assertRecoverableAdoption(record);
  return { headSha: head, mode: 'adopted_maintenance', adoptedChain: chain };
}

function assertRecoverableAdoption(record: MaintenanceRecord): void {
  const kind = resolveAdoptionKind(record);
  switch (kind) {
    case 'maintenance':
    case 'maintenance_range':
      return;
    case 'plan_extension':
      throw new AttemptHeadError(
        `cadeia de manutenção contém plan_extension (${record.adopted_head_sha}); ` +
          'recuperação de attempt histórico recusada',
      );
    default: {
      const unreachable: never = kind;
      throw new AttemptHeadError(`adoption_kind desconhecido: ${String(unreachable)}`);
    }
  }
}
