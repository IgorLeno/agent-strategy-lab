import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HarnessPaths } from './paths.js';
import { readProcStartTicks } from './process-identity.js';
import { DEV_SCHEMA_VERSION, HarnessLock } from './schemas.js';

/**
 * Exclusão mútua entre comandos que MUDAM o estado do harness.
 *
 * `state.json` já era escrito com tmp + rename, o que evita arquivo parcial —
 * mas não evita corrida: dois orquestradores podiam ler `M01 READY` ao mesmo
 * tempo, gerar packet, lançar dois workers e sobrescrever o state um do outro.
 * Isso quebra a garantia central do protocolo: uma tarefa = exatamente uma
 * sessão. O lock cobre a transição READY -> RUNNING inteira.
 *
 * `dev-next` NÃO pega o lock: ele é somente leitura por definição.
 */
export class LockBusyError extends Error {
  constructor(readonly owner: HarnessLock) {
    super(
      `harness ocupado: pid ${owner.pid} (${owner.command}) segura o lock desde ${owner.acquired_at}`,
    );
    this.name = 'LockBusyError';
  }
}

export interface LockHandle {
  readonly file: string;
  readonly owner: HarnessLock;
  release: () => Promise<void>;
}

export function lockPath(paths: HarnessPaths): string {
  return path.join(paths.devDir, 'orchestrator.lock');
}

async function isOwnerAlive(owner: HarnessLock): Promise<boolean> {
  try {
    return (await readProcStartTicks(owner.pid)) === owner.proc_start_ticks;
  } catch {
    return false;
  }
}

async function readOwner(file: string): Promise<HarnessLock | null> {
  try {
    return HarnessLock.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    // Lock ilegível é lock quebrado, e lock quebrado não protege nada:
    // tratado como órfão para que o harness não fique travado para sempre.
    return null;
  }
}

/**
 * `wx` falha se o arquivo existe — a criação exclusiva é o que serializa os
 * processos. Lock órfão (dono morto ou arquivo ilegível) é removido e a
 * criação é tentada de novo UMA vez: quem perder a corrida encontra um dono
 * vivo e recebe LockBusyError, em vez de roubar o lock de novo em loop.
 */
export async function acquireLock(paths: HarnessPaths, command: string): Promise<LockHandle> {
  const file = lockPath(paths);
  await mkdir(path.dirname(file), { recursive: true });
  const owner: HarnessLock = {
    schema_version: DEV_SCHEMA_VERSION,
    pid: process.pid,
    proc_start_ticks: await readProcStartTicks(process.pid),
    command,
    acquired_at: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(file, `${JSON.stringify(owner, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      return { file, owner, release: () => release(file, owner) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readOwner(file);
      if (existing && (await isOwnerAlive(existing))) throw new LockBusyError(existing);
      await unlink(file).catch(() => {});
    }
  }

  const existing = await readOwner(file);
  throw new LockBusyError(existing ?? owner);
}

async function release(file: string, owner: HarnessLock): Promise<void> {
  const current = await readOwner(file);
  // Só o dono remove: se outro processo já roubou um lock considerado órfão,
  // apagar aqui derrubaria a proteção dele.
  if (current && current.pid === owner.pid && current.acquired_at === owner.acquired_at) {
    await unlink(file).catch(() => {});
  }
}

export async function withHarnessLock<T>(
  paths: HarnessPaths,
  command: string,
  body: () => Promise<T>,
): Promise<T> {
  const handle = await acquireLock(paths, command);
  try {
    return await body();
  } finally {
    await handle.release();
  }
}
