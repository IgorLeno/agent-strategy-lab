import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { acquireInstanceLock, processStartTime } from '../src/daemon/instance-lock.js';

let file: string;

beforeEach(async () => {
  file = path.join(await mkdtemp(path.join(os.tmpdir(), 'asl-lock-')), 'daemon.lock');
});

/** Processo vivo de outro pid, para simular um segundo daemon. */
function sleeper(): Promise<{ pid: number; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return new Promise((resolve) => {
    child.once('spawn', () =>
      resolve({
        pid: child.pid as number,
        stop: () =>
          new Promise((done) => {
            child.once('exit', () => done());
            child.kill();
          }),
      }),
    );
  });
}

describe('lock de instância (pid + starttime)', () => {
  it('lê o starttime do próprio processo e não acha pid inexistente', () => {
    expect(processStartTime(process.pid)).toMatch(/^\d+$/);
    expect(processStartTime(2 ** 22 + 7)).toBeNull();
  });

  it('dono vivo bloqueia; release libera', async () => {
    const other = await sleeper();
    try {
      const first = acquireInstanceLock(file, other.pid);
      expect(first.ok).toBe(true);
      const second = acquireInstanceLock(file);
      expect(second).toEqual({ ok: false, owner: { pid: other.pid, starttime: processStartTime(other.pid) } });
      if (first.ok) first.release();
      expect(acquireInstanceLock(file).ok).toBe(true);
    } finally {
      await other.stop();
    }
  });

  it('dono morto é órfão e o lock é retomado', async () => {
    const other = await sleeper();
    const taken = acquireInstanceLock(file, other.pid);
    expect(taken.ok).toBe(true);
    await other.stop();
    const mine = acquireInstanceLock(file);
    expect(mine.ok).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: process.pid });
  });

  it('pid reciclado (mesmo pid, starttime diferente) não conta como dono', async () => {
    await writeFile(file, JSON.stringify({ pid: process.pid, starttime: '1' }));
    expect(acquireInstanceLock(file).ok).toBe(true);
  });

  it('arquivo ilegível de crash no meio da escrita é tratado como órfão', async () => {
    await writeFile(file, '{"pid": 12');
    expect(acquireInstanceLock(file).ok).toBe(true);
  });

  it('release não apaga lock de outro dono', async () => {
    const mine = acquireInstanceLock(file);
    expect(mine.ok).toBe(true);
    await writeFile(file, JSON.stringify({ pid: 1, starttime: processStartTime(1) }));
    if (mine.ok) mine.release();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: 1 });
  });
});
