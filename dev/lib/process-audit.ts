import { readFile, readdir } from 'node:fs/promises';

/**
 * Auditoria de descendentes do worker.
 *
 * "Processo novo por tarefa" não vale nada se o processo anterior deixou
 * filhos vivos: eles continuam mexendo no repositório enquanto a próxima
 * sessão roda. Encerrar o pai não basta — o teste de vazamento antigo só
 * provava que o pai morreu.
 *
 * Dois sinais, porque nenhum sozinho cobre o caso real:
 *
 * 1. **process group** — filhos comuns herdam o pgid do worker, que é
 *    conhecido (o launcher usa `detached: true`, então pgid = pid do worker).
 * 2. **tag de ambiente** — um filho que chama `setsid` sai do grupo e some do
 *    sinal 1. Mas ele herda o environment, então `AGENTLAB_LAUNCH_ID`, único
 *    por lançamento, continua em `/proc/<pid>/environ`.
 *
 * Limite conhecido e não coberto: processo que troca o próprio environment
 * (exec com env limpo, daemon que sanitiza) escapa dos dois sinais. Garantia
 * completa exige cgroup ou PID namespace — fora do escopo da Fase S.
 */
export interface SurvivorProcess {
  readonly pid: number;
  readonly command: string;
  /** Como foi encontrado: útil para saber se o filho escapou do grupo. */
  readonly matched_by: 'process_group' | 'launch_tag';
}

export interface AuditInput {
  readonly launchId: string;
  readonly pgid: number;
  /** PIDs a ignorar — o próprio orquestrador e seus ancestrais. */
  readonly ignorePids?: readonly number[];
}

async function readProcessGroupId(pid: number): Promise<number | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    // comm (campo 2) pode conter espaços e parênteses: corte após o último ')'.
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    const pgrp = fields[2]; // campo 5 do stat = índice 2 depois do comm
    const parsed = pgrp === undefined ? Number.NaN : Number.parseInt(pgrp, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function hasLaunchTag(pid: number, launchId: string): Promise<boolean> {
  try {
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8');
    return environ.split('\0').includes(`AGENTLAB_LAUNCH_ID=${launchId}`);
  } catch {
    // Processo de outro usuário ou que já morreu: não é descendente auditável.
    return false;
  }
}

async function readCommand(pid: number): Promise<string> {
  try {
    const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
    const argv = cmdline.split('\0').filter((part) => part !== '');
    if (argv.length > 0) return argv.join(' ');
  } catch {
    // cai no comm abaixo
  }
  try {
    const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')'));
  } catch {
    return '<desconhecido>';
  }
}

export async function findSurvivors(input: AuditInput): Promise<SurvivorProcess[]> {
  const ignore = new Set([process.pid, ...(input.ignorePids ?? [])]);
  const entries = await readdir('/proc');
  const survivors: SurvivorProcess[] = [];

  for (const entry of entries) {
    const pid = Number.parseInt(entry, 10);
    if (!Number.isInteger(pid) || `${pid}` !== entry || ignore.has(pid)) continue;

    const inGroup = (await readProcessGroupId(pid)) === input.pgid;
    const tagged = inGroup ? false : await hasLaunchTag(pid, input.launchId);
    if (!inGroup && !tagged) continue;

    survivors.push({
      pid,
      command: await readCommand(pid),
      matched_by: inGroup ? 'process_group' : 'launch_tag',
    });
  }
  return survivors;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface CleanupResult {
  readonly killed: readonly SurvivorProcess[];
  /** Sobreviventes que resistiram ao SIGKILL — nunca deveria acontecer. */
  readonly remaining: readonly SurvivorProcess[];
}

/**
 * SIGKILL direto, sem SIGTERM: o worker já terminou e o timeout externo já
 * sinalizou o grupo. O que sobrevive a isso é vazamento, não trabalho em
 * andamento — e não pode atravessar para a próxima sessão.
 *
 * Mata apenas o que a TAG confirma. Pgid é sinal de detecção, não de posse: o
 * kernel recicla PIDs, e um processo alheio pode acabar num grupo cujo id
 * coincide com o do worker já encerrado. Matar por coincidência derrubaria
 * processo de terceiro. Sobrevivente identificado só pelo grupo é relatado —
 * e relatar já basta para classificar a sessão como contaminada.
 */
export async function killSurvivors(input: AuditInput): Promise<CleanupResult> {
  const found = await findSurvivors(input);
  const killed = found.filter((survivor) => survivor.matched_by === 'launch_tag');
  for (const survivor of killed) {
    try {
      process.kill(survivor.pid, 'SIGKILL');
    } catch {
      // ESRCH: morreu entre a auditoria e o sinal. Fim desejado do mesmo jeito.
    }
  }
  const unkillable = found.filter((survivor) => survivor.matched_by === 'process_group');
  if (killed.length === 0) return { killed, remaining: unkillable };

  // O kernel só remove o processo da tabela depois do reap; algumas iterações
  // curtas evitam relatar zumbi transitório como sobrevivente.
  let remaining = killed;
  for (let attempt = 0; attempt < 10 && remaining.length > 0; attempt += 1) {
    await sleep(50);
    remaining = await findSurvivors(input);
  }
  return { killed, remaining };
}
