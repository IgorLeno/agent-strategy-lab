import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { captureProcess } from '../../src/runner/index.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentlab-timeout-test-'));
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

// Prazos generosos de propósito, e não um detalhe de estilo: sob `pnpm test`
// completo, com toda a suíte spawnando processo em paralelo, o próprio
// startup do Node filho (fork+exec até a primeira linha JS rodar, que é
// quando `process.on("SIGTERM", ...)` é registrado) compete por CPU e pode
// passar de 300ms. Um timeout curto manda o SIGTERM ANTES do processo acabar
// de registrar o handler que o ignora — o processo morre pela ação padrão do
// SIGTERM, e o teste veria exatamente o sintoma que existe para pegar
// (SIGTERM no lugar do SIGKILL da escalada) por uma razão que não tem nada a
// ver com a escalada em si. A asserção de tempo mínimo abaixo não fica mais
// frágil por isso: ela só falha se a escalada ocorrer CEDO demais, o que os
// timers reais nunca fazem.
const TIMEOUT_MS = 2_000;
const GRACE_PERIOD_MS = 500;

describe('captureProcess — timeout com SIGTERM e escalada SIGKILL', () => {
  it('mata por SIGKILL, após a graça, um processo que ignora SIGTERM', async () => {
    const cwd = await temporaryRoot();
    const started = Date.now();

    const result = await captureProcess({
      argv: nodeArgv('process.on("SIGTERM", () => {});' + 'setInterval(() => {}, 1000);'),
      cwd,
      logDir: cwd,
      timeoutMs: TIMEOUT_MS,
      gracePeriodMs: GRACE_PERIOD_MS,
    });
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGKILL');
    expect(result.timedOut).toBe(true);
    // Sem a graça inteira o SIGKILL não teria motivo para existir.
    expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS + GRACE_PERIOD_MS - 50);
  });

  it('mata por SIGTERM um processo que aceita o sinal, sem esperar a graça', async () => {
    const cwd = await temporaryRoot();
    const started = Date.now();

    const result = await captureProcess({
      argv: nodeArgv('setInterval(() => {}, 1000);'),
      cwd,
      logDir: cwd,
      timeoutMs: TIMEOUT_MS,
      gracePeriodMs: 10_000,
    });
    const elapsed = Date.now() - started;

    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(result.timedOut).toBe(true);
    // Um SIGTERM aceito não deveria ter esperado a graça de 10s inteira.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('marca timedOut como false quando o processo termina dentro do prazo', async () => {
    const cwd = await temporaryRoot();

    const result = await captureProcess({
      argv: nodeArgv('process.exit(0)'),
      cwd,
      logDir: cwd,
      timeoutMs: 10_000,
      gracePeriodMs: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  it('sem timeoutMs, comportamento idêntico ao de antes do M23', async () => {
    const cwd = await temporaryRoot();

    const result = await captureProcess({
      argv: nodeArgv('process.exit(0)'),
      cwd,
      logDir: cwd,
    });

    expect(result.timedOut).toBe(false);
  });

  it('preserva a evidência parcial escrita antes do kill', async () => {
    const cwd = await temporaryRoot();

    const result = await captureProcess({
      argv: nodeArgv(
        'process.on("SIGTERM", () => {});' +
          'process.stdout.write("antes-do-kill\\n", () => {' +
          '  setInterval(() => {}, 1000);' +
          '});',
      ),
      cwd,
      logDir: cwd,
      timeoutMs: TIMEOUT_MS,
      gracePeriodMs: GRACE_PERIOD_MS,
    });

    expect(result.signal).toBe('SIGKILL');
    expect(result.timedOut).toBe(true);
    expect(await readFile(result.stdout.path, 'utf8')).toBe('antes-do-kill\n');
    expect(result.stdout.bytesWritten).toBe('antes-do-kill\n'.length);
  });
});
