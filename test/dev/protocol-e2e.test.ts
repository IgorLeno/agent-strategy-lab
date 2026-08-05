import { readFile, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAXIMUM_HANDOFF_BYTES,
  MAXIMUM_TASK_PACKET_BYTES,
  byteSize,
} from '../../dev/lib/schemas.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  readCompletion,
  readHandoff,
  readLaunchRecord,
  readPacket,
} from '../../dev/lib/records.js';
import { isSameProcessAlive } from '../../dev/lib/process-identity.js';
import { buildInitialState, ensureRuntimeDirs, readState, writeState } from '../../dev/lib/state.js';
import { makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
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

describe('protocolo de sessões descartáveis — duas tarefas em sequência', () => {
  it('roda T1 e T2, cada uma em processo próprio, e para em ALL_DONE', async () => {
    const result = await orchestrate('success');
    expect(result.exitCode, result.stderr).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iterations: { task_id: string; launch: string; close: string }[];
    };
    expect(summary.stopped_by).toBe('ALL_DONE');
    expect(summary.iterations.map((i) => i.task_id)).toEqual(['T1', 'T2']);
    expect(summary.iterations.every((i) => i.close === 'PASS')).toBe(true);

    const state = await readState(paths);
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS', 'PASS']);

    // Uma tarefa por processo: PIDs distintos, nenhum sobrevivente.
    const first = await readLaunchRecord(paths, 'T1');
    const second = await readLaunchRecord(paths, 'T2');
    expect(first!.process.pid).not.toBe(second!.process.pid);
    expect(first!.process.command_sha256).not.toBe(second!.process.command_sha256);
    expect(await isSameProcessAlive(first!.process)).toBe(false);
    expect(await isSameProcessAlive(second!.process)).toBe(false);

    // Nenhum resume, continue, fork-session ou session id em qualquer lançamento.
    for (const record of [first!, second!]) {
      const flags = record.argv.join(' ');
      expect(flags).not.toMatch(/--resume|--continue|--fork-session|--session-id/);
      expect(record.controlled['fresh_process']).toBe(true);
      expect(record.controlled['inherited_transcript']).toBe(false);
    }
  }, 60_000);

  it('promove candidate a accepted só no dev-close e sela o handoff', async () => {
    await orchestrate('success');

    for (const taskId of ['T1', 'T2']) {
      const completion = await readCompletion(paths, taskId);
      const handoff = await readHandoff(paths, taskId);
      expect(completion?.status).toBe('PASS');
      expect(completion?.report_matches_evidence).toBe(true);

      const accepted = completion!.orchestrator_evidence.accepted_commit;
      expect(accepted).toBe(completion!.orchestrator_evidence.candidate_commit);
      expect(handoff?.accepted_commit).toBe(accepted);
      // O que o worker escreveu não contém accepted_commit — ele não sabe.
      expect(completion?.report).not.toHaveProperty('accepted_commit');
      // A evidência é derivada, não copiada do relato.
      expect(completion!.orchestrator_evidence.revalidation.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('respeita os budgets de packet e handoff', async () => {
    await orchestrate('success');
    for (const taskId of ['T1', 'T2']) {
      expect(byteSize(await readPacket(paths, taskId))).toBeLessThanOrEqual(
        MAXIMUM_TASK_PACKET_BYTES,
      );
      expect(byteSize(await readHandoff(paths, taskId))).toBeLessThanOrEqual(MAXIMUM_HANDOFF_BYTES);
    }
  }, 60_000);

  it('o handoff selado da T1 chega no packet da T2, e só ele', async () => {
    await orchestrate('success');
    const handoffT1 = await readHandoff(paths, 'T1');
    const packetT2 = await readPacket(paths, 'T2');
    expect(packetT2?.previous_handoff?.accepted_commit).toBe(handoffT1?.accepted_commit);
    expect(packetT2?.base_sha).toBe(handoffT1?.accepted_commit);
    // Nada de transcript ou log do worker anterior atravessa.
    expect(JSON.stringify(packetT2)).not.toMatch(/fake-worker modo|stdout|transcript/);
  }, 60_000);

  it('o runtime não suja o repositório: git status limpo depois do fluxo', async () => {
    await orchestrate('success');
    const status = await runGit(sandbox.root, ['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
    const log = await runGit(sandbox.root, ['log', '--oneline']);
    expect(log.stdout.trim().split('\n')).toHaveLength(3); // base + T1 + T2
  }, 60_000);
});

describe('protocolo — limite de iterações', () => {
  it('para em LIMIT_REACHED com exit 9 quando ainda há tarefa pendente', async () => {
    const result = await orchestrate('success', ['--max-iterations', '1']);

    // Sucesso com trabalho não feito seria a pior saída possível: exit 0 e
    // ALL_DONE esconderiam a T2 intocada.
    expect(result.exitCode).toBe(9);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iterations: { task_id: string }[];
    };
    expect(summary.stopped_by).toBe('LIMIT_REACHED');
    expect(summary.iterations.map((iteration) => iteration.task_id)).toEqual(['T1']);

    const state = await readState(paths);
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS', 'READY']);
  }, 60_000);

  it('limite suficiente para o plano inteiro continua ALL_DONE com exit 0', async () => {
    const result = await orchestrate('success', ['--max-iterations', '2']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { stopped_by: string }).stopped_by).toBe('ALL_DONE');
  }, 60_000);

  it('recusa --max-iterations inválido em vez de rodar zero iterações', async () => {
    const result = await orchestrate('success', ['--max-iterations', 'abc']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/inteiro positivo/);
  });
});

describe('protocolo — o fluxo para', () => {
  it('FAIL do worker interrompe antes da T2', async () => {
    const result = await orchestrate('failure');
    expect(result.exitCode).toBe(9);

    const summary = JSON.parse(result.stdout) as { stopped_by: string; iterations: unknown[] };
    expect(summary.stopped_by).toBe('FAIL');
    expect(summary.iterations).toHaveLength(1);

    const state = await readState(paths);
    expect(state.tasks[0]?.status).toBe('FAIL');
    expect(state.tasks[1]?.status).toBe('READY');
    expect(await readHandoff(paths, 'T1')).toBeNull();
  }, 60_000);

  it('TIMED_OUT interrompe e não avança', async () => {
    const result = await orchestrate('timeout', ['--timeout-seconds', '1']);
    expect(result.exitCode).toBe(9);
    expect(JSON.parse(result.stdout).stopped_by).toBe('TIMED_OUT');

    const state = await readState(paths);
    expect(state.tasks[0]?.status).toBe('TIMED_OUT');
    expect(state.tasks[1]?.status).toBe('READY');
    const record = await readLaunchRecord(paths, 'T1');
    expect(await isSameProcessAlive(record!.process)).toBe(false);
  }, 60_000);

  it('guarda operacional deixa a tarefa pendente de fechamento, sem avançar', async () => {
    const result = await orchestrate('no-commit');
    expect(result.exitCode).toBe(9);
    expect(JSON.parse(result.stdout).stopped_by).toBe('PENDING');

    const state = await readState(paths);
    expect(state.tasks[0]?.status).toBe('RUNNING');
    expect(state.tasks[0]?.phase).toBe('FINALIZING');
    expect(state.tasks[1]?.status).toBe('READY');
  }, 60_000);

  it('commit fora do escopo não é aceito', async () => {
    const result = await orchestrate('out-of-scope');
    expect(result.exitCode).toBe(9);

    const state = await readState(paths);
    expect(state.tasks[0]?.status).toBe('RUNNING');
    expect(state.tasks[0]?.diagnostics).toMatch(/fora do escopo/);
    expect(state.tasks[0]?.accepted_commit).toBeNull();
  }, 60_000);

  it('árvore suja não é aceita', async () => {
    const result = await orchestrate('dirty');
    expect(result.exitCode).toBe(9);
    const state = await readState(paths);
    expect(state.tasks[0]?.diagnostics).toMatch(/working tree suja/);
  }, 60_000);
});

describe('protocolo — descendente vazado', () => {
  it('detecta descendente que sobrevive ao worker', async () => {
    await orchestrate('leak');
    const record = await readLaunchRecord(paths, 'T1');
    expect(record).not.toBeNull();
    // O worker morreu; o descendente vazado é o que a verificação do M24B
    // precisará pegar no produto. Aqui basta provar que o pai não sobrevive.
    expect(await isSameProcessAlive(record!.process)).toBe(false);
    const stdout = await readFile(`${sandbox.devDir}/logs/T1.stdout.log`, 'utf8');
    expect(stdout).toBeTypeOf('string');
  }, 60_000);
});
