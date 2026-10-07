/**
 * Daemon único por máquina (visão §6.7, LESSONS 2026-08-05 S10): lock de
 * criação exclusiva com identidade de processo. pid sozinho não basta — o
 * kernel recicla pids; pid + starttime distingue dono vivo de órfão.
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface LockOwner {
  readonly pid: number;
  /** Campo 22 de /proc/<pid>/stat (ticks desde o boot). */
  readonly starttime: string;
}

export type LockResult =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly owner: LockOwner };

/** `null` quando o processo não existe (ou /proc não está disponível). */
export function processStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // `comm` (campo 2) pode ter espaços e parênteses: corta no último ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  // Depois de `comm`, o campo 3 é o índice 0; o 22 é o índice 19.
  return fields[19] ?? null;
}

function readOwner(file: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockOwner>;
    return typeof parsed.pid === 'number' && typeof parsed.starttime === 'string'
      ? { pid: parsed.pid, starttime: parsed.starttime }
      : null;
  } catch {
    return null;
  }
}

function isAlive(owner: LockOwner): boolean {
  return processStartTime(owner.pid) === owner.starttime;
}

export function acquireInstanceLock(file: string, pid: number = process.pid): LockResult {
  const starttime = processStartTime(pid);
  if (starttime === null) throw new Error(`não foi possível ler o starttime do pid ${pid}`);
  const mine: LockOwner = { pid, starttime };
  const content = JSON.stringify(mine);

  // Duas voltas: a segunda só acontece depois de remover um lock órfão.
  for (let round = 0; round < 2; round += 1) {
    try {
      writeFileSync(file, content, { flag: 'wx' });
      return {
        ok: true,
        release: () => {
          const owner = readOwner(file);
          if (owner !== null && owner.pid === mine.pid && owner.starttime === mine.starttime) unlinkSync(file);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = readOwner(file);
    if (owner !== null && isAlive(owner)) return { ok: false, owner };
    // Órfão (ou arquivo ilegível de um crash no meio da escrita): remove e tenta de novo.
    // Se outro processo vencer a corrida, o `wx` da segunda volta falha e ele é o dono.
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const owner = readOwner(file);
  if (owner !== null) return { ok: false, owner };
  throw new Error(`lock ${file} disputado e ilegível`);
}
