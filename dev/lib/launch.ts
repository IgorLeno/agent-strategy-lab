import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import {
  AccessContractError,
  accessContractFacts,
  deriveWorkerAccessContract,
  deriveWorkerIo,
  ensureAccessContractRoots,
  translateAccessContract,
  verifyEffectiveAccess,
} from './access-contract.js';
import {
  assertNoApiCredentials,
  buildBillingRecord,
  extractUsageEstimate,
  runBillingPreflight,
  usageEstimateOf,
  type CommandRunner,
  type CredentialProbe,
} from './billing.js';
import {
  providerTerminalFailure,
  rateLimitWindowDeltas,
  readClaudeStream,
  streamContractViolation,
  usesClaudeStreamJson,
  type ClaudeProviderFailure,
  type ClaudeStreamReading,
} from './claude-stream.js';
import {
  NOT_RUN_OUTCOME,
  buildSubscriptionUsage,
  probeClaudeUsage,
  type ClaudeUsageProbeOutcome,
  type UsageCommandRunner,
} from './claude-usage.js';
import {
  ActivityObserver,
  type ActivityObserverOptions,
  type WorkerActivityTelemetry,
} from './activity-observer.js';
import { executionPolicyOf } from './execution-policy.js';
import { machineSafetyCeiling } from './machine-safety.js';
import { InboxArtifactError, releaseInboxForLaunch } from './inbox-artifacts.js';
import type { HarnessPaths } from './paths.js';
import { killSurvivors } from './process-audit.js';
import { captureProcessIdentity } from './process-identity.js';
import {
  assertNoForbiddenFlags,
  buildEnvironment,
  deriveControlledFacts,
  resolveProfileArgv,
  type LauncherProfile,
} from './profile.js';
import { buildWorkerPrompt } from './prompt.js';
import { ensureTaskInbox, writeLaunchRecord } from './records.js';
import { WorkerSupervisor, type TerminationCause } from './termination.js';
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
  /**
   * Encolhe o TETO DE SEGURANÇA DE MÁQUINA — usado só por testes, para que o
   * failsafe possa ser exercitado em segundos em vez de em horas. Não é budget
   * de task e não deriva de nada que o planner tenha estimado.
   */
  readonly machineSafetyCeilingSecondsOverride?: number;
  /** Thresholds OBSERVACIONAIS de atividade; testes os encolhem. */
  readonly activityObserverOptions?: ActivityObserverOptions;
  /** Chamado assim que a identidade do processo é conhecida, antes da espera. */
  readonly onStarted?: (identity: ProcessIdentity) => Promise<void>;
  /**
   * Entrega o supervisor do worker VIVO ao chamador: é por aqui que passa o
   * cancelamento explícito, que `killSurvivors` (pós-término) nunca ofereceu.
   */
  readonly onSupervisor?: (supervisor: WorkerSupervisor) => void;
  /** Observação de stall — persistir/telemetrar. NUNCA encerra o worker. */
  readonly onStallSuspected?: (telemetry: WorkerActivityTelemetry) => void;
  /** Injetado pelos testes para provar a credencial sem chamar CLI de verdade. */
  readonly credentialRunner?: CommandRunner;
  /** Injetado pelos testes para medir a quota sem chamar CLI de verdade. */
  readonly usageRunner?: UsageCommandRunner;
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
 * Recusa de PREFLIGHT: nada foi lançado, nenhum token foi gasto. Não é veredito
 * sobre o worker — a tarefa não pode ir para FAIL por causa disto.
 */
export class BillingPreflightError extends LaunchError {
  constructor(reason: string) {
    super(`preflight de cobrança recusou o lançamento — ${reason}`);
    this.name = 'BillingPreflightError';
  }
}

/**
 * Recusa de PROVENIÊNCIA: o inbox da tarefa tem output de worker que este
 * lançamento não pode sobrescrever sem destruir evidência. Nada foi lançado e
 * nenhum token foi gasto — não é veredito sobre o worker.
 */
export class InboxProvenanceError extends LaunchError {
  constructor(reason: string) {
    super(`inbox recusou o lançamento — ${reason}`);
    this.name = 'InboxProvenanceError';
  }
}

/**
 * Recusa da MEDIÇÃO, não do worker: o probe `/usage` de baseline não provou ter
 * rodado sem inferência, então ele mesmo pode ter consumido franquia. Nada foi
 * lançado; a tarefa não vai para FAIL por causa disto.
 */
export class UsageMeasurementSafetyError extends LaunchError {
  constructor(reason: string) {
    super(`medição de quota recusou o lançamento — ${reason}`);
    this.name = 'UsageMeasurementSafetyError';
  }
}

/**
 * Um processo NOVO por microtarefa. `detached: true` cria sessão própria
 * (setsid), então o pgid é conhecido e a árvore inteira pode ser encerrada.
 *
 * O worker NÃO recebe deadline derivado da task. A duração prevista de uma
 * tarefa deixou de ter autoridade operacional: ela é hipótese, não permissão,
 * e um coding worker que ultrapassa a própria previsão continua trabalhando.
 *
 * O que existe no lugar é de outra grandeza: um MACHINE_SAFETY_CEILING de
 * infraestrutura, que não conhece planner, estimativa nem profile, e cuja
 * única função é garantir que nenhum processo deste harness seja imortal.
 */
export async function launchWorker(input: LaunchInput): Promise<LaunchOutcome> {
  const { paths, profile, packet } = input;
  const ceiling = machineSafetyCeiling({
    overrideSeconds: input.machineSafetyCeilingSecondsOverride,
  });
  const executionPolicy = executionPolicyOf(profile);

  // ANTES de qualquer efeito — inclusive antes do preflight de cobrança: o
  // worker escreve num slot por tarefa, e um artifact de attempt anterior
  // parado ali seria sobrescrito sem deixar rastro. Só sai daqui inbox limpo
  // ou par já preservado no archive do attempt dono.
  try {
    await releaseInboxForLaunch(paths, packet.task_id);
  } catch (error) {
    if (error instanceof InboxArtifactError) throw new InboxProvenanceError(error.message);
    throw error;
  }

  // UMA derivação por lançamento alimenta env, prompt, sandbox do provider e
  // preflight. Enquanto forem quatro derivações independentes, elas voltam a
  // divergir — foi exatamente esse drift que deixou o worker com caminhos que
  // o sandbox não concedia.
  const io = deriveWorkerIo(paths, profile, packet.task_id);
  const contract = deriveWorkerAccessContract({ role: 'implementer', profile, paths, io });
  // Diretório declarado no contrato precisa EXISTIR antes de o sandbox tentar
  // concedê-lo; inclui o inbox da tarefa, que o worker escreve.
  await ensureAccessContractRoots(contract);
  await ensureTaskInbox(paths, packet.task_id);

  // Tag única por lançamento: filhos herdam o environment, então ela permite
  // reconhecer descendente que escapou do process group via setsid.
  const launchId = randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...buildEnvironment(profile, process.env, { sanitizedHome: io.homeDir }),
    AGENTLAB_LAUNCH_ID: launchId,
    AGENTLAB_TASK_ID: packet.task_id,
    AGENTLAB_REPO_ROOT: paths.repoRoot,
    AGENTLAB_TASK_PACKET_PATH: io.packetPath,
    AGENTLAB_REPORT_PATH: io.reportPath,
    AGENTLAB_HANDOFF_DRAFT_PATH: io.handoffDraftPath,
  };

  const prompt = buildWorkerPrompt(packet, io, executionPolicy);
  const resolvedArgv = resolveProfileArgv(profile.argv, {
    catalogRoot: paths.profileCatalogRoot,
    workerCwd: paths.repoRoot,
  });

  // TRADUÇÃO + PROVA do contrato antes de qualquer chamada ao provider. Um
  // mismatch mecânico entre o que o Agent Lab exige e o que o sandbox concede
  // falha AQUI, com zero launch e zero token — não depois de o worker terminar
  // sem conseguir escrever o protocolo.
  const translation = translateAccessContract(profile, contract, resolvedArgv);
  const agentArgv =
    profile.prompt_delivery === 'argv' ? [...translation.argv, prompt] : [...translation.argv];
  assertNoForbiddenFlags(profile, agentArgv);
  const accessProof = await verifyEffectiveAccess({
    paths,
    profile,
    contract,
    io,
    argv: agentArgv,
    env,
  });

  // Guarda crítica de cobrança ANTES de qualquer efeito: nenhum processo nasce,
  // nenhum arquivo do inbox é criado, nenhum token é gasto se a fonte da
  // credencial não for a assinatura do usuário.
  assertNoApiCredentials('ambiente do worker', env);
  const preflight = await runBillingPreflight({
    agent: profile.agent,
    billingMode: profile.billing_mode,
    binary: profile.argv[0] as string,
    env,
    orchestratorEnv: process.env,
    ...(input.credentialRunner ? { runner: input.credentialRunner } : {}),
  });
  if (!preflight.ok) throw new BillingPreflightError(preflight.refusal ?? 'motivo não informado');

  // Baseline da quota da assinatura, DEPOIS do preflight e ANTES do spawn. Um
  // probe que não prova inferência zero pode ter gastado franquia: nesse caso o
  // worker não nasce, e o valor não é registrado como baseline válido.
  const measuresUsage = usesSubscriptionUsageProbe(profile);
  const usageBefore = measuresUsage
    ? await probeClaudeUsage({
        binary: profile.argv[0] as string,
        env,
        cwd: paths.repoRoot,
        ...(input.usageRunner ? { runner: input.usageRunner } : {}),
      })
    : NOT_RUN_OUTCOME;
  if (usageBefore.unsafe) {
    throw new UsageMeasurementSafetyError(usageBefore.probe.reason ?? 'motivo não informado');
  }

  // O argv é o do AGENTE, sem wrapper de deadline. Enquanto `timeout <N>s ...`
  // estava aqui, o número que encerrava o worker vinha da previsão da task —
  // era o task deadline, apenas escondido numa camada de processo.
  const argv = [...agentArgv];

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

  // Um comando inexistente faz o `timeout` sair no mesmo instante do spawn: o
  // 'close' já teria sido emitido antes dos awaits abaixo (identidade, record,
  // onStarted). Instalado só depois, o listener perderia o evento e a espera
  // pelo término nunca resolveria — top-level await pendurado, exit 13 em vez
  // do INFRA_ERROR real. Por isso o observador nasce junto com o processo.
  const termination = observeTermination(child);

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

  // OBSERVAÇÃO AO VIVO. O listener 'data' convive com o `pipe` para o arquivo:
  // ambos recebem o MESMO chunk, então nenhum byte do log é consumido, movido
  // ou truncado, e os parsers post-hoc continuam lendo exatamente o que liam.
  // O que é observado é o TIMESTAMP do chunk, nunca o seu conteúdo.
  const activity = new ActivityObserver({
    startedAtMs,
    ...(input.activityObserverOptions ?? {}),
    ...(input.onStallSuspected ? { onStallSuspected: input.onStallSuspected } : {}),
  });
  child.stdout?.on('data', (chunk: Buffer) => activity.record('stdout', chunk.length));
  child.stderr?.on('data', (chunk: Buffer) => activity.record('stderr', chunk.length));
  child.stdout?.pipe(stdoutLog);
  child.stderr?.pipe(stderrLog);
  activity.start();

  // SUPERVISÃO do worker VIVO. `killSurvivors` roda depois do término e varre
  // descendentes; ele nunca teve como pedir o fim de um worker em execução.
  const supervisor = new WorkerSupervisor({
    pid: child.pid,
    pgid: identity.pgid,
    // `kill_after_seconds` continua sendo a GRAÇA ENTRE O PEDIDO E O SIGKILL —
    // nunca a duração máxima da task.
    gracePeriodMs: profile.kill_after_seconds * 1_000,
    exited: termination,
  });
  supervisor.armMachineSafetyCeiling(ceiling.seconds * 1_000, ceiling.provenance);
  input.onSupervisor?.(supervisor);

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
    | 'billing'
    | 'rate_limit_observations'
    | 'subscription_usage'
    | 'provider_failure'
    | 'machine_safety_ceiling'
    | 'termination_cause'
    | 'termination_request'
    | 'activity'
  > = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: packet.task_id,
    profile_id: profile.id,
    execution_policy: executionPolicy,
    argv,
    process: identity,
    launch_id: launchId,
    started_at: startedAt,
    controlled: {
      ...deriveControlledFacts(profile, agentArgv, env),
      ...accessContractFacts(accessProof),
    },
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
    billing: billingOf(profile, preflight.credential, '', null),
    rate_limit_observations: null,
    // O baseline já existe e vai gravado agora: se o orquestrador cair durante
    // a espera, o diagnóstico do probe não se perde junto.
    subscription_usage: measuresUsage
      ? buildSubscriptionUsage(usageBefore, NOT_RUN_OUTCOME)
      : null,
    machine_safety_ceiling: { ...ceiling },
    termination_cause: null,
    termination_request: null,
    activity: null,
  });
  await input.onStarted?.(identity);

  const { exitCode, signal } = await termination;
  supervisor.disarm();
  const activityTelemetry = activity.stop();
  const terminationRequest = await supervisor.settled();
  stdoutLog.end();
  stderrLog.end();
  // Sem esperar o flush, o stdout lido logo abaixo pode terminar numa linha
  // pela metade — e, num perfil stream-json, uma linha truncada é violação de
  // contrato. Falha de escrita do log não derruba o lançamento.
  await Promise.all([finished(stdoutLog), finished(stderrLog)]).catch(() => {});

  // Marcado ANTES do probe final: a duração do run é do worker, e somar a
  // medição a ela contaminaria a série de tempos com o custo da observação.
  const finishedAtMs = Date.now();
  const durationMs = finishedAtMs - startedAtMs;

  // Medição final imediatamente depois do término do worker: o que entra na
  // conta é o consumo da execução Claude, não o tempo de validação oficial ou
  // de qualquer passo local que venha depois. Falha aqui é OBSERVACIONAL —
  // nunca rerroda o provider e nunca transforma run bom em veredito ruim.
  const usageAfter: ClaudeUsageProbeOutcome = measuresUsage
    ? await probeClaudeUsage({
        binary: profile.argv[0] as string,
        env,
        cwd: paths.repoRoot,
        ...(input.usageRunner ? { runner: input.usageRunner } : {}),
      })
    : NOT_RUN_OUTCOME;

  // `timed_out` deixou de significar "a task estourou o tempo previsto": não
  // existe mais tempo previsto com autoridade. Ele agora significa "uma
  // AUTORIDADE EXTERNA encerrou este processo antes do término espontâneo", e
  // qual autoridade foi fica em `termination_cause`.
  const timedOut = terminationRequest !== null;

  // O pai ter morrido não prova sessão encerrada: filho vivo continua mexendo
  // no repositório enquanto a próxima tarefa roda.
  const cleanup = await killSurvivors({
    launchId,
    pgid: identity.pgid,
    ignorePids: [process.pid, process.ppid],
  });

  // Um único read do stdout serve aos dois consumidores: o perfil json lê a
  // cauda (semântica inalterada) e o perfil stream-json lê o arquivo inteiro,
  // porque um evento de limite pode ter chegado bem antes do fim.
  const stdout = await readStdoutLog(path.join(paths.logsDir, `${packet.task_id}.stdout.log`));
  const stream = usesClaudeStreamJson(profile.agent, profile.argv)
    ? readClaudeStream(stdout)
    : null;

  // A falha terminal do provider é lida SEMPRE, mesmo quando outro diagnóstico
  // vence a classificação: ela é evidência do run, não só um veredito.
  const providerFailure = stream ? providerTerminalFailure(stream.result) : null;

  const record: LaunchRecord = {
    ...base,
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: durationMs,
    exit_code: exitCode,
    timed_out: timedOut,
    survivors_killed: [...cleanup.killed],
    survivors_remaining: [...cleanup.remaining],
    billing: billingOf(profile, preflight.credential, stdout, stream),
    rate_limit_observations: stream
      ? {
          source: 'claude_stream_json',
          observed: [...stream.observations],
          window_deltas: rateLimitWindowDeltas(stream.observations),
        }
      : null,
    subscription_usage: measuresUsage ? buildSubscriptionUsage(usageBefore, usageAfter) : null,
    provider_failure:
      providerFailure === null ? null : { ...providerFailure, signals: [...providerFailure.signals] },
    machine_safety_ceiling: { ...ceiling },
    termination_cause: terminationRequest?.cause ?? null,
    termination_request:
      terminationRequest === null
        ? null
        : { ...terminationRequest, signals_sent: [...terminationRequest.signals_sent] },
    activity: { ...activityTelemetry, provenance: [...activityTelemetry.provenance] },
  };
  await writeLaunchRecord(paths, record);

  const { classification, reason } = classifyTermination({
    terminationCause: terminationRequest?.cause ?? null,
    terminationDetail: terminationRequest?.detail ?? null,
    exitCode,
    signal,
    survivorsRemaining: cleanup.remaining,
    streamViolation: stream ? streamContractViolation(stream) : null,
    providerFailure,
  });
  return { record, classification, reason };
}

export interface TerminationFacts {
  /** `null` quando o worker terminou sozinho; nenhuma autoridade pediu o fim. */
  readonly terminationCause: TerminationCause | null;
  readonly terminationDetail: string | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly survivorsRemaining: readonly { readonly pid: number; readonly command: string }[];
  /** `null` quando o perfil não fala stream-json ou o transporte veio íntegro. */
  readonly streamViolation: string | null;
  readonly providerFailure: ClaudeProviderFailure | null;
}

/**
 * PRECEDÊNCIA dos diagnósticos, do mais objetivo ao mais interpretado:
 *
 * 1. sobrevivente ao SIGKILL — a sessão contaminou a máquina;
 * 2. término pedido por uma autoridade externa (hoje: o failsafe de máquina ou
 *    um cancelamento explícito) — nunca mais um deadline derivado da task;
 * 3. exit code do próprio launcher (125/126/127) e término por sinal;
 * 4. contrato do transporte violado — o stdout não é legível;
 * 5. falha terminal declarada pelo provider.
 *
 * A falha do provider vem por último porque os itens acima podem PRODUZI-LA:
 * um worker morto por timeout também deixa result truncado ou com erro, e
 * classificar isso como "provider caiu" trocaria a causa pelo sintoma. Ainda
 * assim ela precede FINISHED — sessão que terminou por erro do provider nunca
 * pode seguir para um fechamento que exige `AgentCompletionReport`, porque o
 * protocolo do worker não chegou a completar.
 */
export function classifyTermination(facts: TerminationFacts): {
  classification: LaunchOutcome['classification'];
  reason: string;
} {
  if (facts.survivorsRemaining.length > 0) {
    const detail = facts.survivorsRemaining.map(
      (survivor) => `${survivor.pid} (${survivor.command})`,
    );
    return {
      classification: 'INFRA_ERROR',
      reason: `descendente do worker sobreviveu ao SIGKILL: ${detail.join(', ')}`,
    };
  }
  // TIMED_OUT é PRESERVADO como classificação: records e state históricos
  // continuam legíveis, e o control plane continua parando o fluxo. O que
  // mudou é a causa — nomeada explicitamente em vez de implícita num limite
  // de duração de task.
  if (facts.terminationCause !== null) {
    return {
      classification: 'TIMED_OUT',
      reason: `worker encerrado por ${facts.terminationCause}: ${facts.terminationDetail ?? 'sem detalhe'}`,
    };
  }
  if (facts.exitCode !== null && LAUNCH_FAILURE_EXIT_CODES.has(facts.exitCode)) {
    return {
      classification: 'INFRA_ERROR',
      reason: `o comando do perfil não pôde ser executado (exit ${facts.exitCode})`,
    };
  }
  if (facts.exitCode === null) {
    return {
      classification: 'INFRA_ERROR',
      reason: `worker encerrado por sinal ${facts.signal ?? 'desconhecido'} sem exit code`,
    };
  }
  if (facts.streamViolation) {
    return {
      classification: 'INFRA_ERROR',
      reason: `contrato do transporte stream-json violado: ${facts.streamViolation}`,
    };
  }
  if (facts.providerFailure) {
    return {
      classification: 'INFRA_ERROR',
      reason: providerFailureReason(facts.providerFailure),
    };
  }
  return { classification: 'FINISHED', reason: `worker saiu com exit ${facts.exitCode}` };
}

/** Motivo legível sem citar erro específico: o texto do provider entra como veio. */
export function providerFailureReason(failure: ClaudeProviderFailure): string {
  const detail = failure.message === null ? '' : `: ${failure.message.split('\n')[0] ?? ''}`;
  return (
    'sessão encerrada por falha terminal do provider antes de o protocolo do worker completar ' +
    `(${failure.signals.join(', ')})${detail}`
  );
}

/**
 * Só perfil Claude pago pela assinatura mede quota: `/usage` é comando da CLI
 * do Claude e reporta a franquia da conta. Perfil Codex, perfil falso e perfil
 * de cobrança por API não ganham chamada nenhuma — nem para registrar `null`.
 */
function usesSubscriptionUsageProbe(profile: LauncherProfile): boolean {
  return profile.agent === 'claude' && profile.billing_mode === 'subscription_only';
}

interface Termination {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * UM único listener de término, instalado no mesmo tick do spawn. Um segundo
 * observador (por exemplo em 'exit') poderia resolver com um resultado
 * diferente do 'close' — a espera precisa ter uma fonte só.
 */
function observeTermination(child: ChildProcess): Promise<Termination> {
  return new Promise((resolve) => {
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

/**
 * Para a varredura textual da estimativa só o fim do arquivo interessa (Claude
 * emite um objeto JSON final, Codex um stream JSONL). Varrer o arquivo inteiro
 * seria caro num run longo e não acrescentaria nada — no stream-json a leitura
 * é outra: lá a mensagem `result` é localizada por tipo, não por posição.
 */
const USAGE_TAIL_BYTES = 256 * 1024;

async function readStdoutLog(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    // Log ausente ou ilegível não invalida o lançamento: fica sem estimativa.
    return '';
  }
}

function usageTail(stdout: string): string {
  return stdout.length > USAGE_TAIL_BYTES ? stdout.slice(-USAGE_TAIL_BYTES) : stdout;
}

function billingOf(
  profile: LauncherProfile,
  credential: CredentialProbe,
  stdout: string,
  stream: ClaudeStreamReading | null,
): ReturnType<typeof buildBillingRecord> {
  return buildBillingRecord({
    mode: profile.billing_mode,
    credentialSource: credential.source,
    consumedAllowance: profile.billing_mode === 'subscription_only',
    // No stream-json a fonte autoritativa é a mensagem `result`, não a última
    // linha que por acaso tenha `total_cost_usd`.
    estimate: stream ? usageEstimateOf(stream.result) : extractUsageEstimate(usageTail(stdout)),
  });
}

/**
 * Exit codes convencionais de falha de INVOCAÇÃO — 125 falha do wrapper de
 * execução, 126 comando não executável, 127 comando inexistente. Nenhum deles
 * é veredito sobre o agente: é o lançamento que não conseguiu acontecer.
 */
const LAUNCH_FAILURE_EXIT_CODES = new Set([125, 126, 127]);
