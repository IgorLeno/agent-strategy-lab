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
    proc_start_ticks: await readProcStartTicks(pid),
    command_sha256: canonicalSha256(argv),
  };
}

/** true quando o processo registrado ainda existe — mesmo pid E mesmo starttime. */
export async function isSameProcessAlive(identity: ProcessIdentity): Promise<boolean> {
  try {
    return (await readProcStartTicks(identity.pid)) === identity.proc_start_ticks;
  } catch {
    return false;
  }
}
