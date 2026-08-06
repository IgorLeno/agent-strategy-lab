import { headSha, isWorkingTreeClean } from './git.js';
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
  const accepted = state.tasks
    .filter((task) => task.status === 'PASS' && task.accepted_commit !== null)
    .sort((a, b) => (a.finished_at ?? '').localeCompare(b.finished_at ?? ''));
  const last = accepted[accepted.length - 1];
  // Sem nenhuma tarefa aceita, a base legítima é o baseline registrado no
  // dev-init. `null` só acontece em state construído fora de um repositório.
  return last?.accepted_commit ?? state.baseline_sha;
}

/** Devolve o motivo do bloqueio, ou `null` quando a base está íntegra. */
export async function checkProgressionBase(
  paths: HarnessPaths,
  state: DevelopmentState,
): Promise<string | null> {
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    return 'working tree suja — a próxima tarefa precisa partir de uma base limpa';
  }

  const expected = expectedBaseSha(state);
  if (expected === null) return null;

  const head = await headSha(paths.repoRoot);
  if (head !== expected) {
    return `HEAD (${head}) não é a base esperada (${expected}) — houve trabalho fora do harness`;
  }
  return null;
}
