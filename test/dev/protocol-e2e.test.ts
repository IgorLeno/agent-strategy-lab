import { readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAXIMUM_HANDOFF_BYTES,
  MAXIMUM_TASK_PACKET_BYTES,
  byteSize,
  isHandoffRecordV2,
  readHandoffConfidence,
} from '../../dev/lib/schemas.js';
import { classifyRoutinePostLaunchIncident } from '../../dev/lib/routine-autonomy.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  readCompletion,
  readHandoff,
  readLaunchRecord,
  readPacket,
} from '../../dev/lib/records.js';
import { headSha } from '../../dev/lib/git.js';
import { findSurvivors } from '../../dev/lib/process-audit.js';
import { isSameProcessAlive } from '../../dev/lib/process-identity.js';
import { buildInitialState, ensureRuntimeDirs, readState, writeState } from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

const FOUR_TASK_PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: primeira tarefa
    objective: criar src/t1.txt
    initial_files: [README.md]
    acceptance: ['arquivo criado']
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: T2
    title: segunda tarefa
    blocked_by: [T1]
    objective: criar src/t2.txt
    acceptance: ['arquivo criado']
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: T3
    title: terceira tarefa
    blocked_by: [T2]
    objective: criar src/t3.txt
    acceptance: ['arquivo criado']
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: T4
    title: quarta tarefa
    blocked_by: [T3]
    objective: criar src/t4.txt
    acceptance: ['arquivo criado']
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
`;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  // Mesmo state que o dev-init produz: ele SEMPRE registra o HEAD como baseline,
  // e o pre-flight recusa base autorizada ausente.
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

describe('protocolo de sessões descartáveis — duas tarefas em sequência', () => {
  it('dev-orchestrate fecha profile orchestrator-owned sem commit do fake worker', async () => {
    await writeFile(
      `${sandbox.root}/dev/profiles/fake-orchestrator-v2.yaml`,
      [
        'id: fake-orchestrator-v2',
        'agent: fake',
        'commit_owner: orchestrator',
        'official_validation_owner: orchestrator',
        'worker_validation_policy: targeted',
        'argv: [node, fixtures/fake-worker.mjs]',
        'prompt_delivery: argv',
        'timeout_seconds: 60',
        'forbidden_flags: []',
        'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE]',
      ].join('\n'),
      'utf8',
    );
    const baseline = await commitAll(sandbox.root, 'fake orchestrator profile');
    await writeState(
      paths,
      buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }),
    );
    const result = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', 'fake-orchestrator-v2', '--max-iterations', '1'],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'orchestrator-success' },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).iterations[0].result).toBe('PASS');
    expect((await readCompletion(paths, 'T1'))?.commit_origin).toBe('orchestrator');
    expect((await readLaunchRecord(paths, 'T1'))?.execution_policy.commit_owner).toBe(
      'orchestrator',
    );
    expect((await readState(paths)).tasks.map((task) => task.status)).toEqual(['PASS', 'READY']);
  }, 60_000);

  it('roda T1 e T2, cada uma em processo próprio, e para em ALL_DONE', async () => {
    const result = await orchestrate('success');
    expect(result.exitCode, result.stderr).toBe(0);

    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iteration_count: number;
      iterations: { task_id: string; result: string }[];
    };
    expect(summary.stopped_by).toBe('ALL_DONE');
    expect(summary.iteration_count).toBe(2);
    expect(summary.iterations.map((i) => i.task_id)).toEqual(['T1', 'T2']);
    expect(summary.iterations.every((i) => i.result === 'PASS')).toBe(true);

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
  it('para em LIMIT_REACHED com exit 0 quando ainda há tarefa pendente', async () => {
    const result = await orchestrate('success', ['--max-iterations', '1']);

    // Exit 0 descreve a invocação; LIMIT_REACHED continua expondo a T2 intocada.
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      stopped_by: string;
      iterations: { task_id: string }[];
    };
    expect(summary.stopped_by).toBe('LIMIT_REACHED');
    expect(summary.iterations.map((iteration) => iteration.task_id)).toEqual(['T1']);

    const state = await readState(paths);
    expect(state.tasks.map((task) => task.status)).toEqual(['PASS', 'READY']);
  }, 60_000);

  it('três tasks concluídas e a quarta READY retornam LIMIT_REACHED com exit 0', async () => {
    const fixture = await makeSandboxRepo(FOUR_TASK_PLAN);
    try {
      const fixturePaths = resolveHarnessPaths(fixture.root);
      const fixturePlan = await loadPlan(fixturePaths.planFile);
      await ensureRuntimeDirs(fixturePaths);
      await writeState(
        fixturePaths,
        buildInitialState(fixturePlan.plan, fixturePlan.planSha256, {
          baselineSha: await headSha(fixture.root),
        }),
      );

      const result = await runDevCli(
        'dev-orchestrate.ts',
        ['--repo', fixture.root, '--profile', 'fake-worker-v1', '--max-iterations', '3'],
        { AGENTLAB_DEV_DIR: fixture.devDir, AGENTLAB_FAKE_MODE: 'success' },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout) as {
        stopped_by: string;
        reason: string;
        iteration_count: number;
        iterations: { task_id: string; result: string }[];
      };
      expect(summary).toMatchObject({
        stopped_by: 'LIMIT_REACHED',
        iteration_count: 3,
      });
      expect(summary.reason).toMatch(/T4.*pronta/i);
      expect(summary.iterations).toMatchObject([
        { task_id: 'T1', result: 'PASS' },
        { task_id: 'T2', result: 'PASS' },
        { task_id: 'T3', result: 'PASS' },
      ]);
      expect((await readState(fixturePaths)).tasks.map((task) => task.status)).toEqual([
        'PASS',
        'PASS',
        'PASS',
        'READY',
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
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
  it('mata o descendente que escapou do process group antes da próxima sessão', async () => {
    await orchestrate('leak');

    const record = await readLaunchRecord(paths, 'T1');
    expect(record).not.toBeNull();
    expect(await isSameProcessAlive(record!.process)).toBe(false);

    // O `sleep` do modo leak nasce com setsid: sai do process group e só é
    // reconhecível pela tag de ambiente do lançamento.
    expect(record!.survivors_killed.length).toBeGreaterThan(0);
    const leaked = record!.survivors_killed.find((survivor) => /sleep/.test(survivor.command));
    expect(leaked?.matched_by).toBe('launch_tag');
    expect(record!.survivors_remaining).toEqual([]);

    // Nenhum sobrevivente atravessa para a sessão seguinte.
    expect(await findSurvivors({ launchId: record!.launch_id, pgid: record!.process.pgid })).toEqual(
      [],
    );

    const stdout = await readFile(`${sandbox.devDir}/logs/T1.stdout.log`, 'utf8');
    expect(stdout).toBeTypeOf('string');
  }, 60_000);

  it('run limpo não reporta sobrevivente', async () => {
    await orchestrate('success', ['--max-iterations', '1']);
    const record = await readLaunchRecord(paths, 'T1');
    expect(record!.survivors_killed).toEqual([]);
    expect(record!.survivors_remaining).toEqual([]);
  }, 60_000);
});

describe('handoff v2 no protocolo real do worker', () => {
  /** Profile orchestrator-owned: o fixture não commita, o orquestrador commita. */
  async function useOrchestratorProfile(): Promise<void> {
    await writeFile(
      `${sandbox.root}/dev/profiles/fake-orchestrator-v2.yaml`,
      [
        'id: fake-orchestrator-v2',
        'agent: fake',
        'commit_owner: orchestrator',
        'official_validation_owner: orchestrator',
        'worker_validation_policy: targeted',
        'argv: [node, fixtures/fake-worker.mjs]',
        'prompt_delivery: argv',
        'timeout_seconds: 60',
        'forbidden_flags: []',
        'env_allowlist: [PATH, HOME, AGENTLAB_FAKE_MODE]',
      ].join('\n'),
      'utf8',
    );
    const baseline = await commitAll(sandbox.root, 'fake orchestrator profile');
    await writeState(
      paths,
      buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseline }),
    );
  }

  function orchestrateWith(mode: string) {
    return runDevCli(
      'dev-orchestrate.ts',
      ['--repo', sandbox.root, '--profile', 'fake-orchestrator-v2', '--max-iterations', '1'],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: mode },
    );
  }

  it('o fake worker produz draft v2 válido e o record selado é v2', async () => {
    await useOrchestratorProfile();
    const result = await orchestrateWith('orchestrator-success');
    expect(result.exitCode, result.stderr).toBe(0);

    const draft = JSON.parse(
      await readFile(`${sandbox.root}/.dev-inbox/T1/handoff-draft.json`, 'utf8'),
    ) as Record<string, unknown>;
    expect(draft['schema_version']).toBe(2);
    expect(draft['what_i_did_not_check']).toEqual([]);

    const handoff = await readHandoff(paths, 'T1');
    expect(handoff?.schema_version).toBe(2);
    if (handoff === null || !isHandoffRecordV2(handoff)) throw new Error('record v2 esperado');
    // [] sobrevive como afirmação positiva, e a opinião do worker fica no record.
    expect(handoff.what_i_did_not_check).toEqual([]);
    expect(readHandoffConfidence(handoff.confidence).level).toBe('HIGH');
    expect(byteSize(handoff)).toBeLessThanOrEqual(MAXIMUM_HANDOFF_BYTES);
  }, 60_000);

  // Sem what_i_did_not_check o draft v2 nem chega a ser um handoff: a
  // finalização fica PENDING e o incidente cai na recipe de protocolo que já
  // existe. Nenhuma classe de recovery nova foi criada para este caso.
  it('draft v2 sem what_i_did_not_check cai no caminho de protocolo existente', async () => {
    await useOrchestratorProfile();
    const result = await orchestrateWith('handoff-v2-invalid');

    expect(JSON.parse(result.stdout).iterations[0].result).toBe('PENDING');
    expect(result.stdout).toMatch(/what_i_did_not_check/);
    const state = await readState(paths);
    expect(state.tasks[0]?.status).toBe('RUNNING');
    expect(state.tasks[0]?.phase).toBe('FINALIZING');
    expect(await readHandoff(paths, 'T1')).toBeNull();
    expect(await readCompletion(paths, 'T1')).toBeNull();

    const triage = classifyRoutinePostLaunchIncident({
      phase: 'POST_LAUNCH',
      authorized_head_before: state.authorized_head_sha ?? '',
      task_id: 'T1',
      attempt: 1,
      profile_id: 'fake-orchestrator-v2',
      launch: 'FINISHED',
      close: 'PENDING',
      outcome: 'PENDING',
      reason: state.tasks[0]?.diagnostics ?? '',
      task_status: 'RUNNING',
      task_phase: 'FINALIZING',
      commit_owner: 'orchestrator',
      capability_verdict: false,
      official_validation_failure: false,
      evidence_paths: [],
    });
    expect(triage.recipe_id).toBe('protocol-output-recovery');
    expect(triage.action).toBe('RECOVER_PROTOCOL_OUTPUT');
  }, 60_000);
});
