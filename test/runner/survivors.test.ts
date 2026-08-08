import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { captureProcess, ProcessGroupSurvivorError } from '../../src/runner/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-survivors-test-'));
  temporaryRoots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function nodeArgv(source: string, ...args: string[]): string[] {
  return [process.execPath, '-e', source, ...args];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!condition()) throw new Error('condição não satisfeita dentro do prazo');
}

const TIMEOUT_MS = 2_000;
const GRACE_PERIOD_MS = 500;
const CLEANUP_CONFIRM_TIMEOUT_MS = 300;

describe('captureProcess — confirmação de sobreviventes pós-kill (M24B)', () => {
  it('detecta um descendente que escapou do group e sobrevive ao pai, e não devolve resultado silencioso', async () => {
    const cwd = await temporaryRoot();
    const pidFile = path.join(cwd, 'fugitivo.pid');

    // O neto chama `detached: true` para virar líder do próprio group ANTES
    // do sinal chegar — escapa do `-pgid` mandado ao group do pai, então
    // sobrevive ao SIGKILL que mata o pai e o resto do group original.
    const runPromise = captureProcess({
      argv: nodeArgv(
        `const { spawn } = require('node:child_process');` +
          `const fs = require('node:fs');` +
          `const neto = spawn(process.execPath, ['-e',` +
          `'process.on("SIGTERM", () => {});' +` +
          `'setInterval(() => {}, 1000);'` +
          `], { stdio: 'ignore', detached: true });` +
          `neto.unref();` +
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(neto.pid));` +
          `process.on("SIGTERM", () => {});` +
          `setInterval(() => {}, 1000);`,
      ),
      cwd,
      logDir: cwd,
      timeoutMs: TIMEOUT_MS,
      gracePeriodMs: GRACE_PERIOD_MS,
      cleanupConfirmTimeoutMs: CLEANUP_CONFIRM_TIMEOUT_MS,
    });

    await expect(runPromise).rejects.toBeInstanceOf(ProcessGroupSurvivorError);

    const netoPid = Number(await readFile(pidFile, 'utf8'));
    expect(Number.isInteger(netoPid)).toBe(true);
    // O sobrevivente detectado precisa ser um sobrevivente de verdade: se já
    // estivesse morto, a rejeição não estaria provando cleanup não
    // confirmado, e sim um bug na sondagem.
    expect(isAlive(netoPid)).toBe(true);

    try {
      await runPromise;
      throw new Error('não deveria resolver');
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessGroupSurvivorError);
      expect((error as ProcessGroupSurvivorError).survivors).toContain(netoPid);
    } finally {
      process.kill(-netoPid, 'SIGKILL');
      await waitUntil(() => !isAlive(netoPid), 2_000);
    }
  });

  it('confirma o cleanup assim que o group esvazia, sem esperar o teto de confirmação', async () => {
    const cwd = await temporaryRoot();
    const generousConfirmTimeoutMs = 5_000;

    const started = Date.now();
    const result = await captureProcess({
      // Sem descendente fora do group: o próprio SIGKILL da escalada mata
      // tudo de uma vez, então a foto some no primeiro ciclo de sondagem.
      argv: nodeArgv('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'),
      cwd,
      logDir: cwd,
      timeoutMs: TIMEOUT_MS,
      gracePeriodMs: GRACE_PERIOD_MS,
      cleanupConfirmTimeoutMs: generousConfirmTimeoutMs,
    });
    const elapsedMs = Date.now() - started;

    expect(result.signal).toBe('SIGKILL');
    expect(result.timedOut).toBe(true);
    // TIMEOUT_MS + GRACE_PERIOD_MS é o tempo até o SIGKILL sair; o que sobra
    // até `elapsedMs` é só a confirmação. Se ela dependesse do teto generoso
    // em vez de sondagem, esse resto seria perto dele — não uma fração dele.
    const cleanupElapsedMs = elapsedMs - (TIMEOUT_MS + GRACE_PERIOD_MS);
    expect(cleanupElapsedMs).toBeLessThan(generousConfirmTimeoutMs / 2);
  });
});
