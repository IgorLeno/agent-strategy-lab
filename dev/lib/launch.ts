import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { TIMEOUT_EXIT_CODE } from './exec.js';
import type { HarnessPaths } from './paths.js';
import { killSurvivors } from './process-audit.js';
import { captureProcessIdentity } from './process-identity.js';
import {
  assertNoForbiddenFlags,
  buildEnvironment,
  deriveControlledFacts,
  type LauncherProfile,
} from './profile.js';
import { buildWorkerPrompt } from './prompt.js';
import {
  ensureTaskInbox,
  handoffDraftPath,
  packetPath,
  reportPath,
  writeLaunchRecord,
} from './records.js';
import {
  DEV_SCHEMA_VERSION,
  type LaunchRecord,
  type ProcessIdentity,
  type TaskPacket,
} from './schemas.js';

export interface LaunchInput {
  readonly paths: HarnessPaths;
  readonly profile: LauncherProfile;
  readonly packet: TaskPacket;
  /** Sobrescreve o timeout do perfil — usado só por testes. */
  readonly timeoutSecondsOverride?: number;
  /** Chamado assim que a identidade do processo é conhecida, antes da espera. */
  readonly onStarted?: (identity: ProcessIdentity) => Promise<void>;
}

export interface LaunchOutcome {
  readonly record: LaunchRecord;
  /** Classificação do término, consumida pelo dev-launch para mover o state. */
  readonly classification: 'FINISHED' | 'TIMED_OUT' | 'INFRA_ERROR';
  readonly reason: string;
}

export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchError';
  }
}

/**
 * Um processo NOVO por microtarefa. `detached: true` cria sessão própria
 * (setsid), então o pgid é conhecido e a árvore inteira pode ser encerrada.
 *
 * A ordem importa: `timeout` DENTRO da sessão nova, nunca `timeout setsid ...`
 * — setsid ali criaria uma sessão fora do grupo que o timeout sinaliza, e o
 * worker sobreviveria ao próprio limite.
 */
export async function launchWorker(input: LaunchInput): Promise<LaunchOutcome> {
  const { paths, profile, packet } = input;
  const timeoutSeconds = input.timeoutSecondsOverride ?? profile.timeout_seconds;

  const io = {
    repoRoot: paths.repoRoot,
    packetPath: packetPath(paths, packet.task_id),
    reportPath: reportPath(paths, packet.task_id),
    handoffDraftPath: handoffDraftPath(paths, packet.task_id),
  };
  const prompt = buildWorkerPrompt(packet, io);
  await ensureTaskInbox(paths, packet.task_id);

  const agentArgv =
    profile.prompt_delivery === 'argv' ? [...profile.argv, prompt] : [...profile.argv];
  assertNoForbiddenFlags(profile, agentArgv);

  const argv = [
    'timeout',
    '--signal=TERM',
    `--kill-after=${profile.kill_after_seconds}s`,
    `${timeoutSeconds}s`,
    ...agentArgv,
  ];

  // Tag única por lançamento: filhos herdam o environment, então ela permite
  // reconhecer descendente que escapou do process group via setsid.
  const launchId = randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...buildEnvironment(profile),
    AGENTLAB_LAUNCH_ID: launchId,
    AGENTLAB_TASK_ID: packet.task_id,
    AGENTLAB_REPO_ROOT: paths.repoRoot,
    AGENTLAB_TASK_PACKET_PATH: io.packetPath,
    AGENTLAB_REPORT_PATH: io.reportPath,
    AGENTLAB_HANDOFF_DRAFT_PATH: io.handoffDraftPath,
  };

  const stdoutLog = createWriteStream(path.join(paths.logsDir, `${packet.task_id}.stdout.log`));
  const stderrLog = createWriteStream(path.join(paths.logsDir, `${packet.task_id}.stderr.log`));
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const child = spawn(argv[0] as string, argv.slice(1), {
    cwd: paths.repoRoot,
    env,
    detached: true, // sessão própria: pgid conhecido, árvore encerrável
    stdio: [profile.prompt_delivery === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  const spawnFailure = await new Promise<Error | null>((resolve) => {
    child.once('error', resolve);
    child.once('spawn', () => resolve(null));
  });
  if (spawnFailure || child.pid === undefined) {
    stdoutLog.end();
    stderrLog.end();
    throw new LaunchError(`falha ao lançar worker: ${spawnFailure?.message ?? 'sem pid'}`);
  }

  const identity = await captureProcessIdentity(child.pid, child.pid, argv, startedAt);
  child.stdout?.pipe(stdoutLog);
  child.stderr?.pipe(stderrLog);
  if (profile.prompt_delivery === 'stdin' && child.stdin) {
    child.stdin.end(prompt, 'utf8');
  }

  const base: Omit<
    LaunchRecord,
    | 'finished_at'
    | 'duration_ms'
    | 'exit_code'
    | 'timed_out'
    | 'survivors_killed'
    | 'survivors_remaining'
  > = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: packet.task_id,
    profile_id: profile.id,
    argv,
    process: identity,
    launch_id: launchId,
    started_at: startedAt,
    controlled: deriveControlledFacts(profile, agentArgv, env),
  };

  // Registra o lançamento antes de esperar: um crash do orquestrador aqui
  // deixa rastro do processo que ficou solto, em vez de um estado mudo.
  await writeLaunchRecord(paths, {
    ...base,
    finished_at: null,
    duration_ms: null,
    exit_code: null,
    timed_out: false,
    survivors_killed: [],
    survivors_remaining: [],
  });
  await input.onStarted?.(identity);

  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (code, sig) => resolve({ exitCode: code, signal: sig }));
  });
  stdoutLog.end();
  stderrLog.end();

  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - startedAtMs;
  const timedOut = classifyTimeout(exitCode, durationMs, timeoutSeconds);

  // O pai ter morrido não prova sessão encerrada: filho vivo continua mexendo
  // no repositório enquanto a próxima tarefa roda.
  const cleanup = await killSurvivors({
    launchId,
    pgid: identity.pgid,
    ignorePids: [process.pid, process.ppid],
  });

  const record: LaunchRecord = {
    ...base,
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: durationMs,
    exit_code: exitCode,
    timed_out: timedOut,
    survivors_killed: [...cleanup.killed],
    survivors_remaining: [...cleanup.remaining],
  };
  await writeLaunchRecord(paths, record);

  if (cleanup.remaining.length > 0) {
    const detail = cleanup.remaining.map((survivor) => `${survivor.pid} (${survivor.command})`);
    return {
      record,
      classification: 'INFRA_ERROR',
      reason: `descendente do worker sobreviveu ao SIGKILL: ${detail.join(', ')}`,
    };
  }
  if (timedOut) {
    return { record, classification: 'TIMED_OUT', reason: `worker excedeu ${timeoutSeconds}s` };
  }
  if (exitCode !== null && LAUNCH_FAILURE_EXIT_CODES.has(exitCode)) {
    return {
      record,
      classification: 'INFRA_ERROR',
      reason: `o comando do perfil não pôde ser executado (exit ${exitCode})`,
    };
  }
  if (exitCode === null) {
    return {
      record,
      classification: 'INFRA_ERROR',
      reason: `worker encerrado por sinal ${signal ?? 'desconhecido'} sem exit code`,
    };
  }
  return { record, classification: 'FINISHED', reason: `worker saiu com exit ${exitCode}` };
}

/**
 * Exit codes que o próprio `timeout` reserva para falha de invocação:
 * 125 o timeout falhou, 126 comando não executável, 127 comando inexistente.
 * Nenhum deles é veredito sobre o agente — é o launcher que não conseguiu rodar.
 */
const LAUNCH_FAILURE_EXIT_CODES = new Set([125, 126, 127]);

/**
 * Sem `--foreground`, o `timeout` sinaliza o próprio process group — e como
 * SIGKILL não pode ser ignorado, ele morre junto. Nesse caminho não existe
 * exit 124 para ler: chega exit null com SIGKILL, ou 137. Por isso a duração
 * decorrida entra na decisão, em vez de confiar só no exit code.
 */
export function classifyTimeout(
  exitCode: number | null,
  durationMs: number,
  timeoutSeconds: number,
): boolean {
  if (exitCode === TIMEOUT_EXIT_CODE) return true;
  const exceeded = durationMs >= timeoutSeconds * 1000;
  return exceeded && (exitCode === null || exitCode === 128 + 9);
}
