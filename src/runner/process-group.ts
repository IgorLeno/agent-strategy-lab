/**
 * Confirmação de que um process group morto ficou mesmo vazio (M24B).
 *
 * `kill(-pgid, signal)` (M24A, em `timeout.ts`) alcança todo processo que
 * ainda pertence ao group — mas um descendente pode escapar dele antes do
 * sinal chegar, chamando o próprio `setsid`/`detached` e virando líder de um
 * group novo. Esse processo nunca é atingido por `-pgid`, e "o group original
 * ficou vazio" não é a mesma coisa que "nada sobrou do que o run criou".
 *
 * Por isso a confirmação aqui não pergunta ao group — pergunta a cada pid.
 * `listDescendantPids` tira uma foto da árvore (via `/proc`, PPID a PPID)
 * antes do sinal ser mandado, e essa foto é o que `confirmGroupCleanup`
 * verifica depois: cada pid dela precisa estar morto, não importa em que
 * group ele tenha acabado.
 *
 * A verificação é por polling curto até um teto, nunca um `sleep` único: o
 * veredito "limpo" chega assim que o último pid da foto sai, não depois de
 * um tempo fixo escolhido a dedo. Só o estouro do teto — com alguém da foto
 * ainda vivo, ou um erro que impede saber se está — vira
 * `ProcessGroupSurvivorError`. Essa distinção é o que impede um cleanup
 * apenas presumido de virar `COMPLETED` silencioso.
 */

import { readFileSync, readdirSync } from 'node:fs';

const PROC_DIR = '/proc';

/** Intervalo entre sondagens. Curto o bastante para não atrasar o veredito de sucesso. */
const POLL_INTERVAL_MS = 20;

/** Teto de espera pela confirmação, quando quem chama não escolhe um. */
export const DEFAULT_CONFIRM_CLEANUP_TIMEOUT_MS = 2_000;

/**
 * Todo pid cujo PPID, seguido group acima a partir de `/proc`, chega a
 * `rootPid` — descendentes diretos e indiretos, na foto do instante em que
 * é chamada. Ausência de `/proc` (plataforma sem ele) devolve lista vazia:
 * quem chama ainda tem o pgid como sinal a mandar, só perde a cobertura
 * extra desta função.
 */
export function listDescendantPids(rootPid: number): number[] {
  let entries: string[];
  try {
    entries = readdirSync(PROC_DIR);
  } catch {
    return [];
  }

  const childrenOf = new Map<number, number[]>();
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid)) continue;
    const ppid = readPpid(pid);
    if (ppid === null) continue;
    const siblings = childrenOf.get(ppid);
    if (siblings) siblings.push(pid);
    else childrenOf.set(ppid, [pid]);
  }

  const descendants: number[] = [];
  const queue = [...(childrenOf.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) continue;
    descendants.push(pid);
    queue.push(...(childrenOf.get(pid) ?? []));
  }
  return descendants;
}

/** PPID de `/proc/<pid>/stat`. `null` quando o pid já não existe mais para ler. */
function readPpid(pid: number): number | null {
  try {
    const stat = readFileSync(`${PROC_DIR}/${pid}/stat`, 'utf8');
    // O campo `comm` vem entre parênteses e pode conter espaço; o resto da
    // linha é espaço-separado a partir do `)` de fechamento.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim();
    const ppid = Number(afterComm.split(/\s+/)[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * `true` quando não dá para afirmar que `pid` morreu: ou o kernel ainda o
 * conhece, ou a sondagem falhou por um motivo que não é "não existe mais"
 * (`EPERM`, por exemplo) — e um erro de sondagem não confirma morte nenhuma.
 */
function isUnconfirmedDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Ninguém sobrou do que o run criou: cleanup do process group não confirmado.
 *
 * Existe para ser distinguível de um exit code ou sinal do processo alvo — o
 * run que esbarra nisto é `INFRA_ERROR`, porque a evidência não garante que o
 * workspace ficou livre do que o run mexeu.
 */
export class ProcessGroupSurvivorError extends Error {
  readonly pgid: number;
  readonly survivors: readonly number[];

  constructor(pgid: number, survivors: readonly number[]) {
    super(
      `cleanup do process group ${pgid} não confirmado: sobrevivente(s) pid ${survivors.join(', ')}`,
    );
    this.name = new.target.name;
    this.pgid = pgid;
    this.survivors = [...survivors];
  }
}

/**
 * Sonda `candidatePids` até nenhum restar vivo (nem incerto), ou até
 * `timeoutMs` vencer com alguém ainda sobrando — o que rejeita com
 * `ProcessGroupSurvivorError`. Resolve assim que a foto inteira estiver
 * confirmada morta, sem esperar o teto quando isso acontece antes dele.
 */
export async function confirmGroupCleanup(
  pgid: number,
  candidatePids: readonly number[],
  timeoutMs: number = DEFAULT_CONFIRM_CLEANUP_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const survivors = candidatePids.filter(isUnconfirmedDead);
    if (survivors.length === 0) return;

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ProcessGroupSurvivorError(pgid, survivors);

    await delay(Math.min(POLL_INTERVAL_MS, remaining));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
