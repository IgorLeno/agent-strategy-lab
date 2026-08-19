import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkProgressionBase, expectedBaseSha } from '../../dev/lib/base-guard.js';
import { headSha } from '../../dev/lib/git.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { writePacket } from '../../dev/lib/records.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: await headSha(sandbox.root) }),
  );
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

function orchestrate(mode: string, extra: readonly string[] = []) {
  return runDevCli(
    'dev-orchestrate.ts',
    ['--repo', sandbox.root, '--profile', 'fake-worker-v1', ...extra],
    { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: mode },
  );
}

describe('base da próxima tarefa', () => {
  it('base íntegra no início: HEAD é o baseline e a árvore está limpa', async () => {
    expect(await checkProgressionBase(paths, await readState(paths))).toBeNull();
  });

  it('árvore suja bloqueia', async () => {
    await writeFile(path.join(sandbox.root, 'residuo.txt'), 'trabalho solto\n', 'utf8');
    expect(await checkProgressionBase(paths, await readState(paths))).toMatch(/working tree suja/);
  });

  it('commit externo entre sessões bloqueia: HEAD deixa de ser a base esperada', async () => {
    await writeFile(path.join(sandbox.root, 'externo.txt'), 'feito fora do harness\n', 'utf8');
    await commitAll(sandbox.root, 'commit manual fora do harness');

    const violation = await checkProgressionBase(paths, await readState(paths));
    expect(violation).toMatch(/não é a base esperada/);
    expect(violation).toMatch(/trabalho fora do harness/);
  });

  it('depois de uma tarefa aceita, a base esperada é o último accepted_commit', async () => {
    const accepted = await commitAll(sandbox.root, 'trabalho da T1');
    const state = {
      ...withTaskState(await readState(paths), 'T1', {
        status: 'PASS',
        phase: null,
        accepted_commit: accepted,
        candidate_commit: accepted,
        finished_at: '2026-08-05T12:00:00.000Z',
      }),
      authorized_head_sha: accepted,
    };

    expect(expectedBaseSha(state)).toBe(accepted);
    await writeState(paths, state);
    expect(await checkProgressionBase(paths, await readState(paths))).toBeNull();
  });

  it('usa authorized_head_sha sem inferir novamente a base pelas tarefas', async () => {
    const authorized = (await readState(paths)).authorized_head_sha;
    await mkdir(path.join(sandbox.root, 'docs'), { recursive: true });
    await writeFile(path.join(sandbox.root, 'docs', 'maintenance.md'), 'checkpoint pendente\n');
    const accepted = await commitAll(sandbox.root, 'commit ainda não autorizado');
    const state = {
      ...withTaskState(await readState(paths), 'T1', {
        status: 'PASS',
        phase: null,
        accepted_commit: accepted,
        candidate_commit: accepted,
        finished_at: '2026-08-05T12:00:00.000Z',
      }),
      authorized_head_sha: authorized,
    };

    expect(expectedBaseSha(state)).toBe(authorized);
    expect(await checkProgressionBase(paths, state)).toMatch(/não é a base esperada/);
  });

  it('state sem baseline não inventa base: só exige árvore limpa', async () => {
    const semBaseline = buildInitialState(loaded.plan, loaded.planSha256);
    expect(expectedBaseSha(semBaseline)).toBeNull();
    expect(await checkProgressionBase(paths, semBaseline)).toBeNull();
  });
});

describe('base divergente para o fluxo', () => {
  it('dev-orchestrate para no pre-flight sem mudar o status da tarefa', async () => {
    await writeFile(path.join(sandbox.root, 'externo.txt'), 'trabalho externo\n', 'utf8');
    await commitAll(sandbox.root, 'commit manual entre sessões');

    const result = await orchestrate('success');
    expect(result.exitCode).toBe(9);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      reason: string;
      iteration_count: number;
      preflight: { status: string; blocker: string };
    };
    // Commit externo não é manutenção adotável: o pre-flight recusa antes de o
    // loop chegar à guarda de base, e nenhum provider é lançado.
    expect(summary.stopped_by).toBe('PREFLIGHT_BLOCKED');
    expect(summary.preflight.status).toBe('BLOCKED');
    expect(summary.preflight.blocker).toBe('MAINTENANCE_BLOCKED');
    expect(summary.reason).toMatch(/fora do escopo de manutenção/);
    expect(summary.iteration_count).toBe(0);

    // Divergência de base é problema do repositório, não veredito da tarefa.
    const state = await readState(paths);
    expect(state.tasks.map((task) => task.status)).toEqual(['READY', 'READY']);
  }, 60_000);

  it('a guarda do loop continua parando em BASE_DIVERGED com --skip-preflight', async () => {
    await writeFile(path.join(sandbox.root, 'externo.txt'), 'trabalho externo\n', 'utf8');
    await commitAll(sandbox.root, 'commit manual entre sessões');

    const result = await orchestrate('success', ['--skip-preflight']);
    expect(result.exitCode).toBe(9);
    const summary = JSON.parse(result.stdout) as { stopped_by: string; reason: string };
    expect(summary.stopped_by).toBe('BASE_DIVERGED');
    expect(summary.reason).toMatch(/não é a base esperada/);
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['READY', 'READY']);
  }, 60_000);

  it('árvore suja para o fluxo antes de gerar packet', async () => {
    await writeFile(path.join(sandbox.root, 'residuo.txt'), 'não commitado\n', 'utf8');

    const result = await orchestrate('success');
    expect(result.exitCode).toBe(9);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      preflight: { blocker: string; next: { ready_to_launch: boolean } };
    };
    expect(summary.stopped_by).toBe('PREFLIGHT_BLOCKED');
    expect(summary.preflight.blocker).toBe('DIRTY_WORKTREE');
    expect(summary.preflight.next.ready_to_launch).toBe(false);
    expect((await readState(paths)).tasks[0]?.status).toBe('READY');
  }, 60_000);

  it('dev-launch recusa packet cuja base não é mais o HEAD', async () => {
    const before = await orchestrate('success', ['--max-iterations', '1']);
    expect(before.exitCode).toBe(0);

    // Packet da T2 persistido com a base de agora; o commit externo seguinte
    // é exatamente o cenário de "trabalho entrou entre duas sessões".
    await writePacket(
      paths,
      buildTaskPacket({
        task: loaded.byId.get('T2')!,
        baseSha: await headSha(sandbox.root),
        previousHandoff: null,
      }),
    );

    await writeFile(path.join(sandbox.root, 'externo.txt'), 'externo\n', 'utf8');
    await commitAll(sandbox.root, 'commit externo depois do packet');

    const launched = await runDevCli(
      'dev-launch.ts',
      ['--repo', sandbox.root, '--profile', 'fake-worker-v1', '--task', 'T2'],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'success' },
    );
    expect(launched.exitCode).toBe(1);
    expect(launched.stderr).toMatch(/base inválida|base_sha/);
    expect((await readState(paths)).tasks[1]?.status).toBe('READY');
  }, 60_000);
});
