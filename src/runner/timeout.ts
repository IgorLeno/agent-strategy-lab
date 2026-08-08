/**
 * Escalada de sinal do timeout (M23), redirecionada ao process group inteiro
 * (M24A) e confirmada pid a pid depois do kill (M24B).
 *
 * `startProcess` inicia o alvo como líder de um group novo — ver o comentário
 * de `spawn.ts`. Um sinal mandado só ao pid do alvo não alcança um
 * descendente que ele tenha criado (um processo filho que ele mesmo
 * spawnou, sem `setsid` próprio, herda esse group); mandado a `-pgid`, o
 * kernel entrega a todo processo daquele group — pai e descendentes — e a
 * nenhum outro, porque é assim que `kill(2)` resolve um pid negativo.
 *
 * O `exit` do processo alvo é o que desarma os timers, não o envio do sinal:
 * um SIGTERM aceito e um SIGTERM ignorado só se distinguem por o processo ter
 * saído ou não, e só o evento diz isso. Cancelar pelo envio do sinal armaria
 * o SIGKILL mesmo quando o SIGTERM já bastou.
 *
 * O `-pgid` do kill não cobre um descendente que escapou do group antes do
 * sinal chegar (o próprio `setsid`, por exemplo). Por isso a foto da árvore é
 * tirada (`listDescendantPids`, em `process-group.ts`) no instante de cada
 * sinal — antes dele, não depois — e é essa foto, pid a pid, que
 * `confirmCleanup` cobra depois que o alvo sai.
 */

import type { ChildProcess } from 'node:child_process';

import { confirmGroupCleanup, listDescendantPids } from './process-group.js';

export interface TimeoutEscalation {
  /** `true` quando o timeout venceu e este módulo mandou o SIGTERM inicial. */
  readonly timedOut: () => boolean;
  /**
   * Confirma que ninguém sobrou da foto tirada no kill. Resolve na hora
   * quando não houve timeout (nenhum sinal foi mandado, nada para
   * confirmar); rejeita com `ProcessGroupSurvivorError` quando o prazo de
   * confirmação vence com alguém da foto ainda vivo ou incerto.
   */
  readonly confirmCleanup: () => Promise<void>;
}

/**
 * Arma o SIGTERM de `timeoutMs` ao group `pgid` e, se `child` seguir vivo
 * depois da graça, o SIGKILL da escalada. `timeoutMs` ausente desarma tudo.
 * `cleanupConfirmTimeoutMs` é o teto de `confirmCleanup`; ausente, usa o
 * default de `process-group.ts`.
 */
export function scheduleTimeoutEscalation(
  child: ChildProcess,
  pgid: number,
  timeoutMs: number | undefined,
  gracePeriodMs: number,
  cleanupConfirmTimeoutMs?: number,
): TimeoutEscalation {
  if (timeoutMs === undefined) {
    return { timedOut: () => false, confirmCleanup: () => Promise.resolve() };
  }

  let timedOut = false;
  let sigtermTimer: NodeJS.Timeout | undefined;
  let sigkillTimer: NodeJS.Timeout | undefined;
  const survivorCandidates = new Set<number>([pgid]);

  const snapshotCandidates = (): void => {
    for (const pid of listDescendantPids(pgid)) survivorCandidates.add(pid);
  };

  sigtermTimer = setTimeout(() => {
    sigtermTimer = undefined;
    timedOut = true;
    snapshotCandidates();
    killGroup(pgid, 'SIGTERM');
    sigkillTimer = setTimeout(() => {
      sigkillTimer = undefined;
      snapshotCandidates();
      killGroup(pgid, 'SIGKILL');
    }, gracePeriodMs);
  }, timeoutMs);

  // `once`: o processo só sai uma vez. Isso corre depois de qualquer timer que
  // já tenha disparado no mesmo instante, então limpar aqui nunca reabre um
  // timer que já mandou seu sinal.
  child.once('exit', () => {
    if (sigtermTimer !== undefined) clearTimeout(sigtermTimer);
    if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
  });

  return {
    timedOut: () => timedOut,
    confirmCleanup: () =>
      timedOut
        ? confirmGroupCleanup(pgid, [...survivorCandidates], cleanupConfirmTimeoutMs)
        : Promise.resolve(),
  };
}

/**
 * `-pgid` manda `signal` a todo o process group. `ESRCH` — group já vazio —
 * não é erro deste módulo: é a corrida normal entre o timer da escalada e um
 * processo que termina por conta própria entre um tick e outro.
 */
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}
