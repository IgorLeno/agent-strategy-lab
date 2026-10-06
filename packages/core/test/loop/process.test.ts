import { describe, expect, it } from 'vitest';

import { runProcess } from '../../src/loop/process.js';

const ENV = { PATH: process.env['PATH'] ?? '/usr/bin' };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runProcess', () => {
  it('entrega stdin, captura stdout/stderr e emite linhas na ordem', async () => {
    const lines: string[] = [];
    const result = await runProcess({
      argv: ['sh', '-c', 'cat; echo fim; echo erro >&2'],
      cwd: process.cwd(),
      env: ENV,
      stdin: 'a\nb\n',
      timeoutMs: 10_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(['a', 'b', 'fim']);
    expect(result.stderr).toBe('erro\n');
    expect(result.timedOut).toBe(false);
  });

  it('timeout encerra o grupo inteiro, inclusive neto em background', async () => {
    const result = await runProcess({
      argv: ['sh', '-c', 'sleep 30 & echo $!; wait'],
      cwd: process.cwd(),
      env: ENV,
      timeoutMs: 300,
      killGraceMs: 200,
    });
    expect(result.timedOut).toBe(true);
    const grandchild = Number(result.stdout.trim());
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(grandchild)).toBe(false);
  });

  it('aborto externo encerra o processo', async () => {
    const controller = new AbortController();
    const pending = runProcess({
      argv: ['sleep', '30'],
      cwd: process.cwd(),
      env: ENV,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it('binário ausente vira spawnError, não exceção', async () => {
    const result = await runProcess({
      argv: ['binario-que-nao-existe-asl'],
      cwd: process.cwd(),
      env: ENV,
      timeoutMs: 5_000,
    });
    expect(result.spawnError).toMatch(/ENOENT/);
  });
});
