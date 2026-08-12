import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { headSha } from '../../dev/lib/git.js';
import { LockBusyError, acquireLock, lockPath, withHarnessLock } from '../../dev/lib/lock.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { buildInitialState, ensureRuntimeDirs, writeState } from '../../dev/lib/state.js';
import { makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  // Igual ao que o dev-init grava: o pre-flight do dev-orchestrate recusa state
  // sem base autorizada, e o teste de concorrência precisa do fluxo real.
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: await headSha(sandbox.root) }),
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

describe('lock do harness', () => {
  it('segundo acquire encontra o lock ocupado', async () => {
    const first = await acquireLock(paths, 'dev-orchestrate');
    await expect(acquireLock(paths, 'dev-close')).rejects.toBeInstanceOf(LockBusyError);
    await first.release();
    // Liberado, o próximo comando entra normalmente.
    await (await acquireLock(paths, 'dev-close')).release();
  });

  it('lock de processo morto é órfão e pode ser reclamado', async () => {
    await writeFile(
      lockPath(paths),
      JSON.stringify({
        schema_version: 1,
        pid: 999_999,
        proc_start_ticks: 1,
        command: 'dev-orchestrate',
        acquired_at: '2026-08-05T12:00:00.000Z',
      }),
      'utf8',
    );

    const handle = await acquireLock(paths, 'dev-orchestrate');
    expect(handle.owner.pid).toBe(process.pid);
    await handle.release();
  });

  it('lock ilegível não trava o harness para sempre', async () => {
    await writeFile(lockPath(paths), 'não é json', 'utf8');
    const handle = await acquireLock(paths, 'dev-close');
    await handle.release();
  });

  it('libera o lock mesmo quando o corpo falha', async () => {
    await expect(
      withHarnessLock(paths, 'dev-close', async () => {
        throw new Error('falha no meio do fechamento');
      }),
    ).rejects.toThrow(/falha no meio/);

    await expect(readFile(lockPath(paths), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('release não derruba lock de outro dono', async () => {
    const stale = await acquireLock(paths, 'dev-orchestrate');
    await rm(lockPath(paths), { force: true });
    const other = await acquireLock(paths, 'dev-close');

    await stale.release();
    // O lock que sobrou é o do outro dono, intacto.
    const owner = JSON.parse(await readFile(lockPath(paths), 'utf8')) as { acquired_at: string };
    expect(owner.acquired_at).toBe(other.owner.acquired_at);
    await other.release();
  });
});

describe('lock — CLIs que mudam estado', () => {
  it('dev-close sai com 10 enquanto outro comando segura o lock', async () => {
    const held = await acquireLock(paths, 'dev-orchestrate');
    try {
      const run = await runDevCli('dev-close.ts', ['--repo', sandbox.root, '--task', 'T1'], {
        AGENTLAB_DEV_DIR: sandbox.devDir,
      });
      expect(run.exitCode).toBe(10);
      expect(run.stderr).toMatch(/harness ocupado/);
    } finally {
      await held.release();
    }
  });

  it('dois dev-orchestrate simultâneos: um roda, o outro recusa', async () => {
    const args = ['--repo', sandbox.root, '--profile', 'fake-worker-v1'];
    const env = { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'success' };
    const [a, b] = await Promise.all([
      runDevCli('dev-orchestrate.ts', args, env),
      runDevCli('dev-orchestrate.ts', args, env),
    ]);

    const codes = [a.exitCode, b.exitCode].sort();
    // Um dos dois é recusado pelo lock; o outro conduz o fluxo até o fim.
    expect(codes).toContain(10);
    expect(codes.filter((code) => code === 10)).toHaveLength(1);
    const busy = a.exitCode === 10 ? a : b;
    expect(busy.stderr).toMatch(/harness ocupado/);
  });
});
