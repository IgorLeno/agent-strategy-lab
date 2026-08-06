import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
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

/** pgid real do processo: worker do vitest não é líder de grupo, então não dá para supor. */
async function pgidOf(pid: number): Promise<number> {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  return Number.parseInt(raw.slice(raw.lastIndexOf(')') + 2).split(' ')[2] as string, 10);
}

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

  it('encontra filho pelo process group herdado, mesmo sem a tag do lançamento', async () => {
    const pid = spawnTagged(randomUUID(), false);
    await settle();

    // launchId diferente: só o grupo pode explicar a detecção.
    const survivors = await findSurvivors({ launchId: randomUUID(), pgid: await pgidOf(pid) });
    expect(survivors.find((survivor) => survivor.pid === pid)?.matched_by).toBe('process_group');
  });

  it('não mata quem foi achado só pelo grupo: pgid pode ser coincidência de PID reciclado', async () => {
    const pid = spawnTagged(randomUUID(), false);
    await settle();

    // Grupo bate, tag não: o processo é relatado, nunca morto.
    const result = await killSurvivors({ launchId: randomUUID(), pgid: await pgidOf(pid) });
    expect(result.killed).toEqual([]);
    expect(result.remaining.map((survivor) => survivor.pid)).toContain(pid);
    expect(process.kill(pid, 0)).toBe(true); // continua vivo
  });

  it('mata os sobreviventes e confirma que nada resta', async () => {
    const launchId = randomUUID();
    const pid = spawnTagged(launchId, true);
    await settle();

    // pgid inexistente: o kill precisa vir da tag, que é o sinal de posse.
    const result = await killSurvivors({ launchId, pgid: 999_999 });
    expect(result.killed.map((survivor) => survivor.pid)).toContain(pid);
    expect(result.remaining).toEqual([]);
    expect(await findSurvivors({ launchId, pgid: 999_999 })).toEqual([]);
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
