/**
 * Política de runtime: previsão sem autoridade, supervisão de processo com ela.
 *
 * O que estes casos protegem, em uma frase: a duração PREVISTA de uma task
 * deixou de encerrar qualquer coisa, e o que passou a encerrar é um failsafe de
 * infraestrutura que não conhece task nenhuma.
 */
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ActivityObserver,
  DEFAULT_IDLE_THRESHOLD_MS,
  DEFAULT_STALL_SUSPICION_MS,
  type WorkerActivityTelemetry,
} from '../../dev/lib/activity-observer.js';
import { decodeCodexEventStream, codexUsesEventStream } from '../../dev/lib/codex-transport.js';
import { headSha } from '../../dev/lib/git.js';
import { launchWorker } from '../../dev/lib/launch.js';
import {
  DEFAULT_MACHINE_SAFETY_CEILING_SECONDS,
  MACHINE_SAFETY_CEILING_ENV,
  MachineSafetyCeilingError,
  machineSafetyCeiling,
} from '../../dev/lib/machine-safety.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { loadProfile, type LauncherProfile } from '../../dev/lib/profile.js';
import { findSurvivors } from '../../dev/lib/process-audit.js';
import { isSameProcessAlive } from '../../dev/lib/process-identity.js';
import { readLaunchRecord, readStallSuspectedEvidence, stallSuspectedEvidencePath, taskInboxDir, writePacket } from '../../dev/lib/records.js';
import { LaunchRecord } from '../../dev/lib/schemas.js';
import {
  ACTIVE_TERMINATION_CAUSES,
  TERMINATION_CAUSES,
  WorkerSupervisor,
  terminationCauseOf,
} from '../../dev/lib/termination.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { launchTask } from '../../dev/lib/steps.js';
import { makeSandboxRepo, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let profile: LauncherProfile;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  profile = await loadProfile(sandbox.root, 'fake-worker-v1');
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

async function packetForT1() {
  const packet = buildTaskPacket({
    task: loaded.byId.get('T1')!,
    baseSha: await headSha(paths.repoRoot),
    previousHandoff: null,
  });
  await writePacket(paths, packet);
  return packet;
}

// ---------------------------------------------------------------------------
// MACHINE_SAFETY_CEILING — failsafe de infraestrutura, não budget de task.
// ---------------------------------------------------------------------------

describe('machine safety ceiling', () => {
  it('o default é policy operacional declarada, não duração ótima de task', () => {
    const ceiling = machineSafetyCeiling({ env: {} });
    expect(ceiling).toEqual({
      kind: 'MACHINE_SAFETY_CEILING',
      seconds: DEFAULT_MACHINE_SAFETY_CEILING_SECONDS,
      provenance: expect.stringContaining('policy operacional'),
    });
    // Não é o antigo deadline de 1800s com outro nome: é ordens de grandeza
    // maior, exatamente para não cortar execução saudável nenhuma.
    expect(ceiling.seconds).toBeGreaterThanOrEqual(12 * 3_600);
  });

  it('é configurável por ambiente, com proveniência explícita', () => {
    const ceiling = machineSafetyCeiling({ env: { [MACHINE_SAFETY_CEILING_ENV]: '3600' } });
    expect(ceiling.seconds).toBe(3_600);
    expect(ceiling.provenance).toContain(MACHINE_SAFETY_CEILING_ENV);
  });

  it('recusa valor não positivo em vez de matar o worker antes de ele existir', () => {
    expect(() => machineSafetyCeiling({ env: { [MACHINE_SAFETY_CEILING_ENV]: '-1' } })).toThrow(
      MachineSafetyCeilingError,
    );
    expect(() => machineSafetyCeiling({ env: { [MACHINE_SAFETY_CEILING_ENV]: 'abc' } })).toThrow(
      MachineSafetyCeilingError,
    );
  });

  it('não deriva de estimativa, envelope, dificuldade, planner ou profile', () => {
    // A assinatura da função é a prova estrutural: não existe parâmetro por
    // onde qualquer uma dessas grandezas pudesse entrar.
    const ceiling = machineSafetyCeiling({ env: {} });
    expect(Object.keys(ceiling).sort()).toEqual(['kind', 'provenance', 'seconds']);
    expect(JSON.stringify(ceiling)).not.toContain('estimated_duration');
    expect(JSON.stringify(ceiling)).not.toContain('resource_envelope');
    expect(JSON.stringify(ceiling)).not.toContain('profile');
  });
});

// ---------------------------------------------------------------------------
// Observação de atividade ao vivo — unidade, com relógio injetado.
// ---------------------------------------------------------------------------

describe('ActivityObserver — atividade bruta, nunca progresso semântico', () => {
  function fixedClock(start = 1_000_000) {
    let now = start;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('J — chunk de stdout atualiza last_activity e a fonte', () => {
    const clock = fixedClock();
    const observer = new ActivityObserver({ now: clock.now, idleThresholdMs: 100 });
    clock.advance(40);
    observer.record('stdout', 512);

    const snapshot = observer.snapshot();
    expect(snapshot.last_activity_source).toBe('stdout');
    expect(snapshot.stdout_chunks).toBe(1);
    expect(snapshot.stdout_bytes).toBe(512);
    expect(snapshot.state).toBe('RUNNING_ACTIVE');
    expect(snapshot.last_activity_at).toBe(new Date(1_000_040).toISOString());
  });

  it('K — chunk de stderr também conta como atividade, com fonte própria', () => {
    const clock = fixedClock();
    const observer = new ActivityObserver({ now: clock.now, idleThresholdMs: 100 });
    clock.advance(10);
    observer.record('stderr', 8);

    const snapshot = observer.snapshot();
    expect(snapshot.last_activity_source).toBe('stderr');
    expect(snapshot.stderr_chunks).toBe(1);
    expect(snapshot.stderr_bytes).toBe(8);
    expect(snapshot.stdout_chunks).toBe(0);
  });

  it('acumula o maior silêncio observado, que é o número a calibrar', () => {
    const clock = fixedClock();
    const observer = new ActivityObserver({ now: clock.now, idleThresholdMs: 100 });
    observer.record('stdout', 1);
    clock.advance(700);
    observer.record('stdout', 1);
    clock.advance(120);
    observer.record('stdout', 1);

    const snapshot = observer.snapshot();
    expect(snapshot.max_idle_ms).toBe(700);
  });

  it('M — silêncio acima do threshold marca STALL_SUSPECTED e o persiste', () => {
    const clock = fixedClock();
    const seen: WorkerActivityTelemetry[] = [];
    const observer = new ActivityObserver({
      now: clock.now,
      idleThresholdMs: 100,
      stallSuspicionMs: 500,
      onStallSuspected: (telemetry) => seen.push(telemetry),
    });
    observer.record('stdout', 1);
    clock.advance(600);
    const suspected = observer.poll();

    expect(suspected.state).toBe('STALL_SUSPECTED');
    expect(suspected.stall_suspected_at).not.toBeNull();
    expect(seen).toHaveLength(1);
    // N — a autoridade está declarada no próprio telemetry: observação apenas.
    expect(suspected.termination_authority).toBe('NONE_OBSERVATION_ONLY');
  });

  it('N — a suspeita é evidência durável, mas o estado volta a ATIVO quando o worker fala', () => {
    const clock = fixedClock();
    const observer = new ActivityObserver({
      now: clock.now,
      idleThresholdMs: 100,
      stallSuspicionMs: 500,
    });
    observer.record('stdout', 1);
    clock.advance(600);
    observer.poll();
    observer.record('stdout', 1);

    const resumed = observer.snapshot();
    expect(resumed.state).toBe('RUNNING_ACTIVE');
    // A suspeita NÃO é apagada: é ela que alimenta a calibração empírica.
    expect(resumed.stall_suspected_at).not.toBeNull();
  });

  it('a suspeita dispara UMA vez por run, não uma vez por poll', () => {
    const clock = fixedClock();
    let fired = 0;
    const observer = new ActivityObserver({
      now: clock.now,
      stallSuspicionMs: 100,
      onStallSuspected: () => {
        fired += 1;
      },
    });
    clock.advance(200);
    observer.poll();
    clock.advance(200);
    observer.poll();
    expect(fired).toBe(1);
  });

  it('a proveniência declara a fronteira semântica em vez de deixá-la implícita', () => {
    const observer = new ActivityObserver();
    const provenance = observer.snapshot().provenance.join(' ');
    expect(provenance).toContain('raw I/O activity != semantic progress');
    expect(provenance).toContain('sem autoridade de termination');
  });

  it('os thresholds default são OBSERVACIONAIS e ficam registrados no telemetry', () => {
    const snapshot = new ActivityObserver().snapshot();
    expect(snapshot.idle_threshold_ms).toBe(DEFAULT_IDLE_THRESHOLD_MS);
    expect(snapshot.stall_suspicion_threshold_ms).toBe(DEFAULT_STALL_SUSPICION_MS);
  });
});

// ---------------------------------------------------------------------------
// Supervisão: escada de sinais e causa de término.
// ---------------------------------------------------------------------------

describe('WorkerSupervisor', () => {
  it('processo que sai na graça recebe SIGTERM e NENHUM SIGKILL', async () => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const exited = new Promise<void>((resolve) => {
      release = resolve;
    });
    const supervisor = new WorkerSupervisor({
      pid: 1,
      pgid: 1,
      gracePeriodMs: 5_000,
      exited,
      signal: (_pgid, signal) => {
        sent.push(signal);
        release();
      },
    });

    const request = await supervisor.requestTermination('EXPLICIT_CANCELLATION', 'operador pediu');
    expect(sent).toEqual(['SIGTERM']);
    expect(request.signals_sent).toEqual(['SIGTERM']);
    expect(request.cause).toBe('EXPLICIT_CANCELLATION');
  });

  it('processo que ignora SIGTERM escala para SIGKILL depois da graça', async () => {
    const sent: string[] = [];
    const supervisor = new WorkerSupervisor({
      pid: 1,
      pgid: 1,
      gracePeriodMs: 30,
      exited: new Promise<void>(() => {}),
      signal: (_pgid, signal) => sent.push(signal),
    });

    const request = await supervisor.requestTermination('MACHINE_SAFETY_CEILING', 'teto atingido');
    expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(request.grace_period_ms).toBe(30);
  });

  it('um segundo pedido não dispara uma segunda escada sobre o mesmo grupo', async () => {
    const sent: string[] = [];
    const supervisor = new WorkerSupervisor({
      pid: 1,
      pgid: 1,
      gracePeriodMs: 20,
      exited: new Promise<void>(() => {}),
      signal: (_pgid, signal) => sent.push(signal),
    });

    const [first, second] = await Promise.all([
      supervisor.requestTermination('EXPLICIT_CANCELLATION', 'primeiro'),
      supervisor.requestTermination('MACHINE_SAFETY_CEILING', 'segundo'),
    ]);
    expect(sent).toEqual(['SIGTERM', 'SIGKILL']);
    expect(first).toBe(second);
    expect(first.detail).toBe('primeiro');
  });

  it('o teto armado pode ser desarmado sem encerrar nada', async () => {
    const sent: string[] = [];
    const supervisor = new WorkerSupervisor({
      pid: 1,
      pgid: 1,
      gracePeriodMs: 10,
      exited: new Promise<void>(() => {}),
      signal: (_pgid, signal) => sent.push(signal),
    });
    supervisor.armMachineSafetyCeiling(20, 'teste');
    supervisor.disarm();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sent).toEqual([]);
    expect(supervisor.terminationRequest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T/U — compatibilidade histórica de TIMED_OUT.
// ---------------------------------------------------------------------------

describe('TIMED_OUT — compatibilidade e proveniência da causa', () => {
  /** Record no formato ANTERIOR à política: sem nenhum campo de causa. */
  const HISTORICAL_TIMED_OUT = {
    schema_version: 1,
    task_id: 'T1',
    profile_id: 'claude-build-worker-subscription-v1',
    argv: ['timeout', '--signal=TERM', '--kill-after=10s', '1800s', 'claude', '--print'],
    process: {
      pid: 4242,
      pgid: 4242,
      started_at: '2026-08-01T10:00:00.000Z',
      proc_start_ticks: 998877,
      command_sha256: 'a'.repeat(64),
    },
    launch_id: '11111111-2222-4333-8444-555555555555',
    started_at: '2026-08-01T10:00:00.000Z',
    finished_at: '2026-08-01T10:30:00.000Z',
    duration_ms: 1_800_000,
    exit_code: null,
    timed_out: true,
    controlled: { fresh_process: true },
  };

  it('T — LaunchRecord histórico com TIMED_OUT continua parseável sem reescrita', () => {
    const parsed = LaunchRecord.parse(HISTORICAL_TIMED_OUT);
    expect(parsed.timed_out).toBe(true);
    // Os campos novos entram como ausência declarada, não como valor inventado.
    expect(parsed.termination_cause).toBeNull();
    expect(parsed.termination_request).toBeNull();
    expect(parsed.machine_safety_ceiling).toBeNull();
    expect(parsed.activity).toBeNull();
    // O argv histórico continua registrado exatamente como foi lançado.
    expect(parsed.argv[0]).toBe('timeout');
  });

  it('U — a causa distingue deadline de task LEGADO de failsafe de máquina', () => {
    const historical = LaunchRecord.parse(HISTORICAL_TIMED_OUT);
    expect(terminationCauseOf(historical)).toBe('LEGACY_TASK_DEADLINE');

    const modern = LaunchRecord.parse({
      ...HISTORICAL_TIMED_OUT,
      termination_cause: 'MACHINE_SAFETY_CEILING',
    });
    expect(terminationCauseOf(modern)).toBe('MACHINE_SAFETY_CEILING');

    const spontaneous = LaunchRecord.parse({ ...HISTORICAL_TIMED_OUT, timed_out: false });
    expect(terminationCauseOf(spontaneous)).toBeNull();
  });

  it('LEGACY_TASK_DEADLINE e STALL_GUARD existem para LER, não para produzir agora', () => {
    expect(TERMINATION_CAUSES).toContain('LEGACY_TASK_DEADLINE');
    expect(TERMINATION_CAUSES).toContain('STALL_GUARD');
    // Nesta fase, só failsafe de máquina e cancelamento explícito são ativos.
    expect([...ACTIVE_TERMINATION_CAUSES].sort()).toEqual([
      'EXPLICIT_CANCELLATION',
      'MACHINE_SAFETY_CEILING',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integração: worker real do fixture, sob o launcher real.
// ---------------------------------------------------------------------------

describe('launchWorker — observação ao vivo e failsafe (integração)', () => {
  it('J/K/L — stdout e stderr atualizam a telemetria E o log continua íntegro', async () => {
    const packet = await packetForT1();
    const outcome = await launchWorker({ paths, profile, packet });

    expect(outcome.classification).toBe('FINISHED');
    const activity = outcome.record.activity;
    expect(activity).not.toBeNull();
    expect(activity!.stdout_chunks).toBeGreaterThan(0);
    expect(activity!.stdout_bytes).toBeGreaterThan(0);
    expect(activity!.last_activity_at).not.toBeNull();
    expect(activity!.last_activity_source).toBe('stdout');
    expect(activity!.observation_started_at).toBe(outcome.record.started_at);

    // L — nenhum byte se perdeu para o observador: o arquivo tem pelo menos o
    // que a telemetria contou, e o conteúdo esperado continua lá.
    const { readFile } = await import('node:fs/promises');
    const stdoutLog = await readFile(
      path.join(paths.logsDir, `${packet.task_id}.stdout.log`),
      'utf8',
    );
    expect(Buffer.byteLength(stdoutLog, 'utf8')).toBe(activity!.stdout_bytes);
    expect(stdoutLog).toContain('AGENTLAB_WORKER_CWD=');
  }, 30_000);

  /**
   * O caso "processo travado" — separado do failsafe de máquina de propósito.
   *
   * O fixture fala, some por um intervalo longo e então TERMINA O TRABALHO. Se
   * a janela de suspeita tivesse autoridade de termination, este worker
   * saudável seria morto. A prova é que ele foi SUSPEITO e mesmo assim chegou
   * ao fim.
   */
  it('M/N — stall suspeito é observado e persistido, e NÃO encerra o worker', async () => {
    const packet = await packetForT1();
    const stallProfile: LauncherProfile = {
      ...profile,
      env_allowlist: [...profile.env_allowlist, 'AGENTLAB_FAKE_STALL_MS'],
      env_extra: { ...profile.env_extra, AGENTLAB_FAKE_MODE: 'stall' },
    };
    const observed: WorkerActivityTelemetry[] = [];

    const outcome = await launchWorker({
      paths,
      profile: stallProfile,
      packet,
      // Janela OBSERVACIONAL encolhida para o teste. Ela não tem autoridade:
      // é exatamente esse ponto que o caso prova.
      activityObserverOptions: { idleThresholdMs: 100, stallSuspicionMs: 300, pollIntervalMs: 25 },
      onStallSuspected: (telemetry) => observed.push(telemetry),
    });

    // Suspeita observada e persistida no record...
    expect(observed.length).toBeGreaterThan(0);
    expect(outcome.record.activity?.stall_suspected_at).not.toBeNull();
    expect(outcome.record.activity?.max_idle_ms).toBeGreaterThanOrEqual(300);
    expect(outcome.record.activity?.termination_authority).toBe('NONE_OBSERVATION_ONLY');

    // ...e o worker terminou o trabalho mesmo assim.
    expect(outcome.classification).toBe('FINISHED');
    expect(outcome.record.timed_out).toBe(false);
    expect(outcome.record.termination_cause).toBeNull();
    expect(outcome.record.termination_request).toBeNull();
    // STALL_GUARD não é produzido nesta fase observacional.
    expect(outcome.record.termination_cause).not.toBe('STALL_GUARD');
  }, 30_000);

  it('launchTask de produção persiste stall suspeito sem kill, FAIL, HUMAN_REQUIRED nem attempt extra', async () => {
    const packet = await packetForT1();
    const previousMode = process.env.AGENTLAB_FAKE_MODE;
    process.env.AGENTLAB_FAKE_MODE = 'stall';
    const before = getTaskState(await readState(paths), 'T1');

    try {
      const result = await launchTask(
        paths,
        packet,
        'fake-worker-v1',
        undefined,
        undefined,
        { idleThresholdMs: 100, stallSuspicionMs: 300, pollIntervalMs: 25 },
      );

      expect(result.classification).toBe('FINISHED');
      expect(result.outcome?.record.timed_out).toBe(false);
      expect(result.outcome?.record.termination_cause).toBeNull();
      expect(result.outcome?.record.termination_cause).not.toBe('STALL_GUARD');
      expect(result.outcome?.record.activity?.termination_authority).toBe('NONE_OBSERVATION_ONLY');
      expect(result.outcome?.record.activity?.stall_suspected_at).not.toBeNull();

      const evidence = await readStallSuspectedEvidence(paths, 'T1', 1);
      expect(evidence).not.toBeNull();
      expect(evidence?.kind).toBe('STALL_SUSPECTED');
      expect(evidence?.attempt).toBe(1);
      expect(evidence?.launch_id).toBe(result.outcome?.record.launch_id);
      expect(evidence?.effects).toEqual({
        kill: false,
        fail: false,
        human_required: false,
        attempt_consumed: false,
      });

      const after = getTaskState(await readState(paths), 'T1');
      expect(after.status).not.toBe('FAIL');
      expect(after.attempts).toBe(before.attempts + 1);
    } finally {
      if (previousMode === undefined) delete process.env.AGENTLAB_FAKE_MODE;
      else process.env.AGENTLAB_FAKE_MODE = previousMode;
    }
  }, 30_000);

  it('dois attempts da mesma task preservam stall de cada um sem atribuição stale', async () => {
    const firstPacket = await packetForT1();
    const previousMode = process.env.AGENTLAB_FAKE_MODE;
    process.env.AGENTLAB_FAKE_MODE = 'stall';
    const observer = { idleThresholdMs: 100, stallSuspicionMs: 300, pollIntervalMs: 25 };

    try {
      const first = await launchTask(paths, firstPacket, 'fake-worker-v1', undefined, undefined, observer);
      expect(first.classification).toBe('FINISHED');
      expect(first.outcome?.record.activity?.stall_suspected_at).not.toBeNull();
      const attempt1 = await readStallSuspectedEvidence(paths, 'T1', 1);
      expect(attempt1?.attempt).toBe(1);
      expect(attempt1?.launch_id).toBe(first.outcome?.record.launch_id);
      expect(attempt1?.effects.human_required).toBe(false);

      await rm(taskInboxDir(paths, 'T1'), { recursive: true, force: true });
      const afterFirst = await readState(paths);
      await writeState(
        paths,
        withTaskState(afterFirst, 'T1', {
          status: 'READY',
          phase: null,
          process: null,
          diagnostics: null,
          finished_at: null,
        }),
      );

      const secondPacket = await packetForT1();
      const second = await launchTask(paths, secondPacket, 'fake-worker-v1', undefined, undefined, observer);
      expect(second.classification).toBe('FINISHED');
      expect(second.outcome?.record.activity?.stall_suspected_at).not.toBeNull();
      const attempt2 = await readStallSuspectedEvidence(paths, 'T1', 2);
      expect(attempt2?.attempt).toBe(2);
      expect(attempt2?.launch_id).toBe(second.outcome?.record.launch_id);
      expect(attempt2?.launch_id).not.toBe(attempt1?.launch_id);
      expect(attempt2?.effects).toEqual({
        kill: false,
        fail: false,
        human_required: false,
        attempt_consumed: false,
      });

      const stillAttempt1 = await readStallSuspectedEvidence(paths, 'T1', 1);
      expect(stillAttempt1?.launch_id).toBe(attempt1?.launch_id);
      expect(stillAttempt1?.attempt).toBe(1);
      expect(second.outcome?.record.launch_id).not.toBe(stillAttempt1?.launch_id);

      await expect(access(path.join(paths.logsDir, 'T1.stall-suspected.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(stallSuspectedEvidencePath(paths, 'T1', 1)).toContain('T1.attempt-1.stall-suspected.json');
      expect(stallSuspectedEvidencePath(paths, 'T1', 2)).toContain('T1.attempt-2.stall-suspected.json');
    } finally {
      if (previousMode === undefined) delete process.env.AGENTLAB_FAKE_MODE;
      else process.env.AGENTLAB_FAKE_MODE = previousMode;
    }
  }, 30_000);

  it('E — o implementer não recebe deadline derivado da task em lugar nenhum', async () => {
    const packet = await packetForT1();
    const outcome = await launchWorker({ paths, profile, packet });

    // O argv[0] é o binário do AGENTE. O prompt entregue por argv contém a
    // palavra "timeout" (o packet declara `validation[].timeout_seconds`), e é
    // por isso que a asserção olha a POSIÇÃO do wrapper, não o texto inteiro.
    expect(outcome.record.argv[0]).toBe('node');
    expect(outcome.record.argv.slice(0, 4)).not.toContain('--kill-after');
    expect(outcome.record.argv.slice(0, 4).some((token) => /^\d+s$/.test(token))).toBe(false);
    // O único limite registrado é de MÁQUINA, e diz de onde veio.
    expect(outcome.record.machine_safety_ceiling?.kind).toBe('MACHINE_SAFETY_CEILING');
    expect(outcome.record.machine_safety_ceiling?.provenance).toContain('policy operacional');
    // G/H — previsão e observação são grandezas distintas: aqui persiste o
    // tempo OBSERVADO, que é fato do run.
    expect(outcome.record.duration_ms).toBeGreaterThan(0);
  }, 30_000);

  it('Q/R — a auditoria de sobreviventes continua funcional depois do failsafe', async () => {
    const packet = await packetForT1();
    const leakProfile: LauncherProfile = {
      ...profile,
      env_extra: { ...profile.env_extra, AGENTLAB_FAKE_MODE: 'leak' },
    };
    const outcome = await launchWorker({ paths, profile: leakProfile, packet });

    // O descendente vazado foi encontrado pela TAG e morto; nada restou.
    expect(outcome.record.survivors_killed.length).toBeGreaterThan(0);
    expect(outcome.record.survivors_killed.every((item) => item.matched_by === 'launch_tag')).toBe(
      true,
    );
    expect(outcome.record.survivors_remaining).toEqual([]);
    expect(
      await findSurvivors({ launchId: outcome.record.launch_id, pgid: outcome.record.process.pgid }),
    ).toEqual([]);
    expect(await isSameProcessAlive(outcome.record.process)).toBe(false);
  }, 30_000);

  it('o record persistido em disco carrega ceiling e activity, não só o retorno', async () => {
    const packet = await packetForT1();
    await launchWorker({ paths, profile, packet });

    const persisted = await readLaunchRecord(paths, packet.task_id);
    expect(persisted?.machine_safety_ceiling?.kind).toBe('MACHINE_SAFETY_CEILING');
    expect(persisted?.activity?.schema).toBe('WORKER_ACTIVITY_V1');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// V — a premissa factual sobre o transporte, corrigida.
// ---------------------------------------------------------------------------

describe('V — o transporte Codex JSONL É conhecido; o que faltava era observação AO VIVO', () => {
  const STREAM = [
    '{"type":"thread.started","thread_id":"th_1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"ok\\":true}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
  ].join('\n');

  it('o harness parseia thread.started/turn.started/item.completed/turn.completed', () => {
    expect(codexUsesEventStream(['codex', 'exec', '--json'])).toBe(true);
    expect(decodeCodexEventStream(STREAM)).toEqual({
      outcome: 'AGENT_MESSAGE',
      text: '{"ok":true}',
    });
  });

  it('turn.failed e error também são reconhecidos como término declarado', () => {
    expect(decodeCodexEventStream('{"type":"turn.failed","error":{"message":"upstream caiu"}}')).toEqual({
      outcome: 'TURN_FAILED',
      message: 'upstream caiu',
    });
    expect(decodeCodexEventStream('{"type":"error","message":"boom"}')).toEqual({
      outcome: 'TURN_FAILED',
      message: 'boom',
    });
  });

  it('o decoder é POST-HOC sobre string e não observa nada ao vivo', () => {
    // A assinatura prova a fronteira: ele recebe o stdout inteiro já lido.
    expect(decodeCodexEventStream.length).toBe(1);
    // A observação ao vivo é de OUTRO módulo, provider-neutro, e mede
    // timestamp de chunk — nunca conteúdo de evento.
    const observer = new ActivityObserver();
    observer.record('stdout', Buffer.byteLength(STREAM, 'utf8'));
    const snapshot = observer.snapshot();
    expect(snapshot.stdout_bytes).toBe(Buffer.byteLength(STREAM, 'utf8'));
    expect(JSON.stringify(snapshot)).not.toContain('turn.completed');
  });
});
