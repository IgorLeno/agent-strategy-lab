import { readFile } from 'node:fs/promises';
import { canonicalSha256 } from './canonical.js';
import type { ProcessIdentity } from './schemas.js';

/**
 * PID sozinho não identifica processo: o kernel reusa PIDs. `starttime`
 * (campo 22 de /proc/<pid>/stat, em ticks desde o boot) desempata — o par
 * (pid, starttime) é único enquanto a máquina não reinicia.
 *
 * Linux-only, coerente com o suporte declarado do MVP (POSIX/Linux).
 */
export async function readProcStartTicks(pid: number): Promise<number> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  // O comm (campo 2) pode conter espaços e parênteses; corte após o último ')'.
  const afterComm = raw.slice(raw.lastIndexOf(')') + 2);
  const fields = afterComm.split(' ');
  const starttime = fields[19]; // campo 22 do stat = índice 19 depois do comm
  if (starttime === undefined) throw new Error(`/proc/${pid}/stat sem campo starttime`);
  const parsed = Number.parseInt(starttime, 10);
  if (!Number.isFinite(parsed)) throw new Error(`starttime inválido para pid ${pid}: ${starttime}`);
  return parsed;
}

/**
 * Sentinela de `proc_start_ticks` para processo que já não existia no instante
 * da captura. Não é um starttime plausível: nenhum processo observável pelo
 * harness nasce no tick 0 do boot.
 */
export const PROCESS_GONE_START_TICKS = 0;

/**
 * `null` quando o processo já não existe. Um worker que morre no mesmo instante
 * do spawn — comando inexistente, por exemplo — é desfecho legítimo do
 * lançamento, e chegar tarde demais em /proc não pode transformar isso em
 * crash do launcher: o término precisa continuar sendo classificável.
 */
async function readProcStartTicksIfAlive(pid: number): Promise<number | null> {
  try {
    return await readProcStartTicks(pid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw error;
  }
}

export async function captureProcessIdentity(
  pid: number,
  pgid: number,
  argv: readonly string[],
  startedAt: string = new Date().toISOString(),
): Promise<ProcessIdentity> {
  return {
    pid,
    pgid,
    started_at: startedAt,
    proc_start_ticks: (await readProcStartTicksIfAlive(pid)) ?? PROCESS_GONE_START_TICKS,
    command_sha256: canonicalSha256(argv),
  };
}

/** true quando o processo registrado ainda existe — mesmo pid E mesmo starttime. */
export async function isSameProcessAlive(identity: ProcessIdentity): Promise<boolean> {
  // Identidade capturada depois do término não descreve processo nenhum; o pid
  // pode ter sido reusado, e comparar com a sentinela afirmaria vida alheia.
  if (identity.proc_start_ticks === PROCESS_GONE_START_TICKS) return false;
  try {
    return (await readProcStartTicks(identity.pid)) === identity.proc_start_ticks;
  } catch {
    return false;
  }
}
