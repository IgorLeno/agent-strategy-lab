import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { findSurvivors, killSurvivors } from '../../dev/lib/process-audit.js';

const spawned: number[] = [];

afterEach(() => {
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // já morto
    }
  }
});

/** `detached` reproduz o filho que chama setsid e escapa do process group. */
function spawnTagged(launchId: string, detached: boolean): number {
  const child = spawn('sleep', ['30'], {
    detached,
    stdio: 'ignore',
    env: { ...process.env, AGENTLAB_LAUNCH_ID: launchId },
  });
  child.unref();
  spawned.push(child.pid!);
  return child.pid!;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

describe('auditoria de descendentes', () => {
  it('encontra filho pela tag de ambiente mesmo fora do process group', async () => {
    const launchId = randomUUID();
    const pid = spawnTagged(launchId, true);
    await settle();

    // pgid inexistente: só a tag pode encontrar esse processo.
    const survivors = await findSurvivors({ launchId, pgid: 999_999 });
    const found = survivors.find((survivor) => survivor.pid === pid);
    expect(found?.matched_by).toBe('launch_tag');
    expect(found?.command).toMatch(/sleep/);
  });

  it('encontra filho pelo process group herdado', async () => {
    const launchId = randomUUID();
    const pid = spawnTagged(launchId, false);
    await settle();

    // Sem detached, o filho fica no grupo de quem o lançou (este processo).
    const survivors = await findSurvivors({ launchId, pgid: process.pid, ignorePids: [] });
    expect(survivors.map((survivor) => survivor.pid)).toContain(pid);
  });

  it('mata os sobreviventes e confirma que nada resta', async () => {
    const launchId = randomUUID();
    const pid = spawnTagged(launchId, true);
    await settle();

    const result = await killSurvivors({ launchId, pgid: pid });
    expect(result.killed.map((survivor) => survivor.pid)).toContain(pid);
    expect(result.remaining).toEqual([]);
    expect(await findSurvivors({ launchId, pgid: pid })).toEqual([]);
  });

  it('lançamento sem descendente vivo não reporta nada', async () => {
    const result = await killSurvivors({ launchId: randomUUID(), pgid: 999_999 });
    expect(result.killed).toEqual([]);
    expect(result.remaining).toEqual([]);
  });

  it('não confunde lançamentos diferentes: a tag é única', async () => {
    const mine = randomUUID();
    const other = randomUUID();
    spawnTagged(other, true);
    await settle();

    expect(await findSurvivors({ launchId: mine, pgid: 999_999 })).toEqual([]);
  });
});
