import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { captureProcess } from '../../src/runner/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-process-group-test-'));
  temporaryRoots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** argv de um node inline — o mesmo executável que roda os testes. */
function nodeArgv(source: string, ...args: string[]): string[] {
  return [process.execPath, '-e', source, ...args];
}

/** `true` enquanto o kernel ainda conhece `pid` — sonda via `kill(pid, 0)`. */
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

// Prazos generosos pelo mesmo motivo do timeout.test.ts: sob `pnpm test`
// completo, o startup do Node filho compete por CPU com o resto da suíte.
const TIMEOUT_MS = 2_000;
const GRACE_PERIOD_MS = 500;

describe('captureProcess — sinal ao process group (M24A)', () => {
  it('mata um descendente do processo alvo, não só o alvo', async () => {
    const cwd = await temporaryRoot();
    const pidFile = path.join(cwd, 'neto.pid');

    // O alvo cria um descendente (sem setsid próprio) que ignora SIGTERM. Se o
    // sinal fosse mandado só ao pid do alvo, esse descendente sobreviveria.
    const result = await captureProcess({
      argv: nodeArgv(
        `const { spawn } = require('node:child_process');` +
          `const fs = require('node:fs');` +
          `const neto = spawn(process.execPath, ['-e',` +
          `'process.on("SIGTERM", () => {});' +` +
          `'setInterval(() => {}, 1000);'` +
          `], { stdio: 'ignore' });` +
          `fs.writeFileSync(${JSON.stringify(pidFile)}, String(neto.pid));` +
          `process.on("SIGTERM", () => {});` +
          `setInterval(() => {}, 1000);`,
      ),
      cwd,
      logDir: cwd,
      timeoutMs: TIMEOUT_MS,
      gracePeriodMs: GRACE_PERIOD_MS,
    });

    expect(result.signal).toBe('SIGKILL');
    expect(result.timedOut).toBe(true);

    const netoPid = Number(await readFile(pidFile, 'utf8'));
    expect(Number.isInteger(netoPid)).toBe(true);
    expect(isAlive(netoPid)).toBe(false);
  });

  it('não manda o sinal a um processo fora do group criado', async () => {
    const cwd = await temporaryRoot();

    // Bystander num group próprio, alheio ao que `captureProcess` cria.
    const { spawn } = await import('node:child_process');
    const bystander = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
      { cwd, stdio: 'ignore', detached: true },
    );
    const bystanderPid = bystander.pid;
    if (bystanderPid === undefined) throw new Error('bystander não iniciou');

    try {
      const result = await captureProcess({
        argv: nodeArgv('process.on("SIGTERM", () => {});' + 'setInterval(() => {}, 1000);'),
        cwd,
        logDir: cwd,
        timeoutMs: TIMEOUT_MS,
        gracePeriodMs: GRACE_PERIOD_MS,
      });

      expect(result.signal).toBe('SIGKILL');
      expect(result.timedOut).toBe(true);
      expect(isAlive(bystanderPid)).toBe(true);
    } finally {
      process.kill(-bystanderPid, 'SIGKILL');
      await waitUntil(() => !isAlive(bystanderPid), 2_000);
    }
  });

  it('registra o pgid do process group na evidência do run', async () => {
    const cwd = await temporaryRoot();

    const result = await captureProcess({
      argv: nodeArgv('process.exit(0)'),
      cwd,
      logDir: cwd,
    });

    expect(Number.isInteger(result.pgid)).toBe(true);
    expect(result.pgid).toBeGreaterThan(0);
  });
});
