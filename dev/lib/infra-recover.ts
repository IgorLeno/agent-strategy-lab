import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeFileOnce } from './atomic.js';
import {
  assertAttemptRecoveryHead,
  type AttemptRecoveryHead,
  type AttemptRecoveryHeadMode,
} from './base-guard.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import {
  STREAM_JSON_OUTPUT_FORMAT,
  claudeOutputFormat,
  providerTerminalFailure,
  readClaudeStream,
  streamContractViolation,
  type ClaudeProviderFailure,
} from './claude-stream.js';
import { stagedFiles } from './git.js';
import {
  InboxArtifactError,
  archiveInboxArtifacts,
  findStaleInboxOwner,
  readCurrentInboxArtifacts,
  releaseCurrentInboxArtifacts,
  tryFinishPendingInboxRelease,
  type InboxArtifactPair,
  type InboxReleaseHooks,
  type StaleInboxOwner,
} from './inbox-artifacts.js';
import type { HarnessPaths } from './paths.js';
import { isSameProcessAlive } from './process-identity.js';
import {
  completionPath,
  infraAttemptEvidencePath,
  infraFailedAttemptPath,
  launchRecordPath,
  readInfraFailedAttempt,
  readLaunchRecord,
  writeInfraFailedAttempt,
} from './records.js';
import {
  DEV_SCHEMA_VERSION,
  InfraFailedAttemptRecord,
  type ArchivedEvidenceFile,
  type DevelopmentState,
  type LaunchRecord,
  type ProviderTerminalFailure,
  type TaskState,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';

/**
 * Recuperação auditável de um attempt que morreu por FALHA DE INFRAESTRUTURA
 * do provider, antes de o protocolo do worker completar.
 *
 * A distinção que este módulo existe para preservar: não há solução. Não há
 * patch, não há candidate commit e não há `AgentCompletionReport` — a sessão
 * terminou com o provider declarando erro terminal no próprio `result`. Tratar
 * isso como FAIL de capacidade atribuiria ao worker um veredito que ninguém
 * mediu; tratar como fechamento pendente pediria eternamente um report que
 * nunca vai existir.
 *
 * Nenhum provider é chamado aqui. O comando arquiva a evidência do attempt e
 * devolve a tarefa a READY sem mexer em `attempts`: a repetição continua sendo
 * decisão do usuário, e o attempt arquivado permanece na história como
 * infraestrutura, não como tentativa reprovada.
 */
export class InfraRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfraRecoveryError';
  }
}

export interface InfraRecoveryInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly reason: string;
  readonly allowPendingMaintenance?: boolean;
  readonly now?: () => string;
  /** Ponto de crash injetado pelos testes, entre migrar o inbox stale e a evidência. */
  readonly afterStaleInboxMigrated?: () => Promise<void>;
  /** Hooks da liberação do inbox — fronteira entre os dois `rm` dos slots. */
  readonly inboxReleaseHooks?: InboxReleaseHooks;
  /** Ponto de crash injetado pelos testes, entre evidência e record. */
  readonly afterEvidenceArchived?: () => Promise<void>;
  /** Ponto de crash injetado pelos testes, entre record e state. */
  readonly afterRecordWritten?: (record: InfraFailedAttemptRecord) => Promise<void>;
}

export interface InfraRecoveryResult {
  readonly record: InfraFailedAttemptRecord;
  readonly recordPath: string;
  readonly state: DevelopmentState;
  /** `true` quando o record já existia e esta execução apenas convergiu. */
  readonly alreadyArchived: boolean;
  /**
   * Como o HEAD se relacionava com a base histórica do attempt; `null` na
   * retomada de uma tarefa já READY, em que nada foi reavaliado.
   */
  readonly headMode: AttemptRecoveryHeadMode | null;
  /** Manutenções adotadas atravessadas para permitir a recuperação, em ordem. */
  readonly adoptedMaintenance: readonly string[];
  /**
   * Attempt anterior a que o par stale do inbox pertencia, quando esta execução
   * o preservou e liberou os slots; `null` quando o inbox já estava limpo.
   */
  readonly staleInboxOwnerAttempt: number | null;
}

const EVIDENCE_SOURCES = [
  { name: 'launch.infra.json', source: (paths: HarnessPaths, taskId: string) => launchRecordPath(paths, taskId) },
  {
    name: 'stdout.log',
    source: (paths: HarnessPaths, taskId: string) =>
      path.join(paths.logsDir, `${taskId}.stdout.log`),
  },
  {
    name: 'stderr.log',
    source: (paths: HarnessPaths, taskId: string) =>
      path.join(paths.logsDir, `${taskId}.stderr.log`),
  },
] as const;

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function relativeToDev(paths: HarnessPaths, file: string): string {
  return path.relative(paths.devDir, file).split(path.sep).join('/');
}

/**
 * Copia os bytes exatos de cada arquivo de evidência para dentro do attempt.
 * Append-only: repetir com os mesmos bytes é aceito, com bytes diferentes é
 * recusado — o log do attempt seguinte não pode se passar por este.
 */
async function archiveEvidence(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<ArchivedEvidenceFile[]> {
  const archived: ArchivedEvidenceFile[] = [];
  for (const entry of EVIDENCE_SOURCES) {
    const source = entry.source(paths, taskId);
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new InfraRecoveryError(`evidência do attempt ausente: ${relativeToDev(paths, source)}`);
    }
    const destination = infraAttemptEvidencePath(paths, taskId, attempt, entry.name);
    try {
      await writeFileOnce(destination, bytes);
    } catch (error) {
      throw new InfraRecoveryError(
        `evidência arquivada diverge da atual (${entry.name}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    archived.push({
      path: relativeToDev(paths, destination),
      source_path: relativeToDev(paths, source),
      sha256: sha256Hex(bytes),
      size_bytes: bytes.byteLength,
    });
  }
  return archived;
}

/** Confere que a evidência já publicada continua íntegra e do tamanho declarado. */
async function assertArchivedEvidence(
  paths: HarnessPaths,
  record: InfraFailedAttemptRecord,
): Promise<void> {
  for (const file of record.evidence) {
    const absolute = path.join(paths.devDir, file.path);
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new InfraRecoveryError(`evidência arquivada sumiu: ${file.path}`);
    }
    if (sha256Hex(bytes) !== file.sha256 || bytes.byteLength !== file.size_bytes) {
      throw new InfraRecoveryError(`evidência arquivada foi alterada: ${file.path}`);
    }
  }
}

/**
 * Par report/handoff que sobrou no inbox e comprovadamente pertence a um
 * ValidationFailedAttempt ANTERIOR — não ao attempt de infra que está sendo
 * recuperado agora.
 */
interface StaleInbox {
  readonly owner: StaleInboxOwner;
  readonly bytes: InboxArtifactPair;
}

interface InfraSource {
  readonly attempt: number;
  readonly task: TaskState;
  readonly launch: LaunchRecord;
  readonly launchSha256: string;
  readonly providerFailure: ProviderTerminalFailure;
  readonly providerFailureSource: 'launch_record' | 'stdout_stream';
  readonly baseSha: string;
  readonly headSha: string;
  readonly headMode: AttemptRecoveryHeadMode;
  /** `adopted_head_sha` de cada manutenção que explica base → HEAD, em ordem. */
  readonly adoptedMaintenance: readonly string[];
  /** `null` quando o inbox está limpo — o caso normal de uma falha de infra. */
  readonly staleInbox: StaleInbox | null;
}

/**
 * De quem é o output que está no inbox.
 *
 * Output DESTE attempt significa que o protocolo do worker COMEÇOU, e aquele
 * caminho é do dev-retry: continua recusado. O que este classificador
 * acrescenta é o caso em que o par não é deste attempt nenhum — ele é a sobra
 * de um ValidationFailedAttempt anterior no caminho compartilhado do inbox, e
 * bloquear a recuperação por causa dele seria atribuir a um attempt output que
 * outro produziu.
 *
 * A prova é criptográfica e completa ou não existe: os DOIS hashes precisam
 * bater com o MESMO record anterior. Timestamp, `changed_files` e semelhança de
 * conteúdo não são consultados — meia prova é ambiguidade, e ambiguidade recusa.
 */
async function classifyInbox(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<StaleInbox | null> {
  const current = await readCurrentInboxArtifacts(paths, taskId);
  if (current.report === null && current.handoff === null) {
    // Intent residual: release já tinha terminado os dois slots.
    try {
      await tryFinishPendingInboxRelease(paths, taskId);
    } catch (error) {
      if (error instanceof InboxArtifactError) throw new InfraRecoveryError(error.message);
      throw error;
    }
    return null;
  }
  if (current.report === null || current.handoff === null) {
    // Meio par só converge quando há prova durável de release autorizada.
    try {
      if (await tryFinishPendingInboxRelease(paths, taskId)) return null;
    } catch (error) {
      if (error instanceof InboxArtifactError) throw new InfraRecoveryError(error.message);
      throw error;
    }
    if (current.handoff === null) {
      throw new InfraRecoveryError('AgentCompletionReport presente; recuperação de infra recusada');
    }
    throw new InfraRecoveryError('HandoffDraft presente; recuperação de infra recusada');
  }

  const bytes = { report: current.report, handoff: current.handoff };
  const owner = await findStaleInboxOwner(paths, taskId, bytes, attempt - 1);
  if (owner === null) {
    throw new InfraRecoveryError(
      'output do worker presente no inbox sem pertencer comprovadamente a um attempt ' +
        'anterior; recuperação de infra recusada',
    );
  }
  return { owner, bytes };
}

/**
 * Preserva o par stale no attempt DONO e só então libera os slots correntes.
 * Append-only e idempotente: repetir com os mesmos bytes converge, com bytes
 * diferentes é recusado. Nada é escrito no attempt de infra — ele não produziu
 * output nenhum, e copiar o report do attempt anterior para dentro dele seria
 * fabricar uma solução que nunca existiu.
 */
async function migrateStaleInbox(
  paths: HarnessPaths,
  taskId: string,
  stale: StaleInbox,
  hooks?: InboxReleaseHooks,
): Promise<void> {
  try {
    await archiveInboxArtifacts({
      paths,
      taskId,
      attempt: stale.owner.attempt,
      bytes: stale.bytes,
      expected: stale.owner.hashes,
    });
    await releaseCurrentInboxArtifacts(paths, taskId, stale.owner, hooks);
  } catch (error) {
    if (error instanceof InboxArtifactError) throw new InfraRecoveryError(error.message);
    throw error;
  }
}

/**
 * Precondições fail-closed, todas conferidas ANTES de qualquer escrita. Cada
 * uma existe para impedir que este caminho apague um desfecho diferente:
 * timeout, sobrevivente e solução em disco têm tratamento próprio, e nenhum
 * deles pode entrar aqui disfarçado de falha de provider.
 */
async function loadInfraSource(
  input: InfraRecoveryInput,
  state: DevelopmentState,
): Promise<InfraSource> {
  const { paths, taskId } = input;
  const task = getTaskState(state, taskId);

  const recoverable =
    (task.status === 'RUNNING' && task.phase === 'FINALIZING') || task.status === 'INFRA_ERROR';
  if (!recoverable) {
    throw new InfraRecoveryError(
      `dev-recover-infra exige RUNNING/FINALIZING ou INFRA_ERROR, encontrada ${task.status}${
        task.phase === null ? '' : `/${task.phase}`
      }`,
    );
  }
  if (task.attempts < 1) throw new InfraRecoveryError('tentativa sem número de attempt');
  if (task.candidate_commit !== null) throw new InfraRecoveryError('candidate_commit precisa ser null');
  if (task.accepted_commit !== null) throw new InfraRecoveryError('accepted_commit precisa ser null');
  if (!task.process) throw new InfraRecoveryError('processo registrado ausente');
  if (await isSameProcessAlive(task.process)) {
    throw new InfraRecoveryError('processo registrado ainda está vivo');
  }
  const otherRunning = state.tasks.find(
    (candidate) => candidate.id !== taskId && candidate.status === 'RUNNING',
  );
  if (otherRunning) throw new InfraRecoveryError(`outra tarefa RUNNING: ${otherRunning.id}`);
  if (!task.base_sha) throw new InfraRecoveryError('base_sha ausente na tentativa');

  const launchBytes = await readFile(launchRecordPath(paths, taskId)).catch(() => null);
  if (launchBytes === null) throw new InfraRecoveryError('LaunchRecord ausente');
  const launch = await readLaunchRecord(paths, taskId).catch((error: unknown) => {
    throw new InfraRecoveryError(
      `LaunchRecord inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!launch) throw new InfraRecoveryError('LaunchRecord ausente');
  if (launch.task_id !== taskId) {
    throw new InfraRecoveryError(`LaunchRecord pertence a ${launch.task_id}`);
  }
  if (launch.finished_at === null) throw new InfraRecoveryError('LaunchRecord ainda não foi finalizado');
  if (canonicalJson(launch.process) !== canonicalJson(task.process)) {
    throw new InfraRecoveryError('processo do LaunchRecord diverge do state');
  }

  // Precedência preservada: timeout e sobrevivente são diagnósticos próprios e
  // não podem ser reescritos como falha de provider.
  if (launch.timed_out) throw new InfraRecoveryError('attempt encerrado por timeout — use dev-retry');
  if (launch.survivors_remaining.length > 0) {
    throw new InfraRecoveryError('attempt deixou descendente vivo — investigue antes de recuperar');
  }
  const providerFailure =
    launch.provider_failure === null
      ? await deriveProviderFailureFromStdout(paths, taskId, launch)
      : { failure: launch.provider_failure, source: 'launch_record' as const };

  // Output do worker DESTE attempt significa que o protocolo COMEÇOU: aquele
  // caminho é do dev-retry, que sabe amarrar report e handoff à evidência. Só
  // um par provadamente herdado de um attempt anterior passa daqui.
  const staleInbox = await classifyInbox(paths, taskId, task.attempts);
  if (await exists(completionPath(paths, taskId))) {
    throw new InfraRecoveryError('CompletionRecord presente; recuperação de infra recusada');
  }

  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new InfraRecoveryError('index contém mudanças staged');
  }
  let head: AttemptRecoveryHead;
  try {
    head = await assertAttemptRecoveryHead({
      paths,
      baseSha: task.base_sha,
      authorizedHeadSha: state.authorized_head_sha,
      allowPendingMaintenance: input.allowPendingMaintenance === true,
      label: 'dev-recover-infra',
    });
  } catch (error) {
    throw new InfraRecoveryError(error instanceof Error ? error.message : String(error));
  }

  return {
    attempt: task.attempts,
    task,
    launch,
    launchSha256: sha256Hex(launchBytes),
    providerFailure: providerFailure.failure,
    providerFailureSource: providerFailure.source,
    // A base do attempt é a HISTÓRICA; o head é o REAL do instante da
    // recuperação. Igualar os dois fingiria que o attempt nasceu na base nova.
    baseSha: task.base_sha,
    headSha: head.headSha,
    headMode: head.mode,
    adoptedMaintenance: head.adoptedChain.map((record) => record.adopted_head_sha),
    staleInbox,
  };
}

/**
 * LaunchRecord gravado ANTES de o harness saber classificar falha de provider
 * não tem o campo — e reescrevê-lo à mão seria fabricar evidência. A derivação
 * sai do stdout PRESERVADO do próprio attempt, que é a fonte crua de onde o
 * launcher passou a ler, e só é aceita quando o transporte está íntegro:
 * argv declarando stream-json, exatamente um `result` e nenhuma linha inválida.
 *
 * A origem fica registrada no record: uma classificação derivada depois do fato
 * não pode se passar por uma que o próprio lançamento produziu.
 */
async function deriveProviderFailureFromStdout(
  paths: HarnessPaths,
  taskId: string,
  launch: LaunchRecord,
): Promise<{ failure: ProviderTerminalFailure; source: 'stdout_stream' }> {
  const refuse = (detail: string): never => {
    throw new InfraRecoveryError(
      `LaunchRecord não declara falha terminal do provider e o stdout não a prova: ${detail}`,
    );
  };

  if (claudeOutputFormat(launch.argv) !== STREAM_JSON_OUTPUT_FORMAT) {
    refuse('o argv do lançamento não declarou stream-json');
  }
  const stdout = await readFile(path.join(paths.logsDir, `${taskId}.stdout.log`), 'utf8').catch(
    () => null,
  );
  if (stdout === null) refuse('stdout do attempt ausente');

  const reading = readClaudeStream(stdout as string);
  const violation = streamContractViolation(reading);
  if (violation) refuse(violation);

  const failure = providerTerminalFailure(reading.result);
  if (!failure) refuse('o result do stream declarou término normal');
  const declared = failure as ClaudeProviderFailure;
  return {
    failure: { ...declared, signals: [...declared.signals] },
    source: 'stdout_stream',
  };
}

function buildRecord(
  source: InfraSource,
  evidence: readonly ArchivedEvidenceFile[],
  reason: string,
  timestamp: string,
): InfraFailedAttemptRecord {
  const launch = source.launch;
  return InfraFailedAttemptRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: launch.task_id,
    attempt: source.attempt,
    source_base_sha: source.baseSha,
    profile_id: launch.profile_id,
    process: launch.process,
    launch_id: launch.launch_id,
    launch_classification: 'INFRA_ERROR',
    launch_record_sha256: source.launchSha256,
    exit_code: launch.exit_code,
    timed_out: false,
    started_at: launch.started_at,
    finished_at: launch.finished_at,
    provider_failure: source.providerFailure,
    provider_failure_source: source.providerFailureSource,
    billing: launch.billing,
    subscription_usage: launch.subscription_usage,
    rate_limit_observations: launch.rate_limit_observations,
    worker_output_present: false,
    candidate_commit: null,
    working_tree_clean: true,
    head_sha: source.headSha,
    evidence: [...evidence],
    reason_code: 'PROVIDER_TERMINAL_FAILURE',
    reason,
    archived_at: timestamp,
  });
}

/** Reabre a tarefa para um NOVO attempt. `attempts` nunca diminui. */
async function reopenTask(
  paths: HarnessPaths,
  record: InfraFailedAttemptRecord,
): Promise<DevelopmentState> {
  const state = await readState(paths);
  const task = getTaskState(state, record.task_id);
  if (task.status === 'READY') return state;
  if (task.attempts < record.attempt) {
    throw new InfraRecoveryError('attempts regrediu durante a recuperação');
  }
  const next = withTaskState(state, record.task_id, {
    status: 'READY',
    phase: null,
    process: null,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics:
      `attempt ${record.attempt} encerrado por falha de infraestrutura do provider ` +
      `(${record.provider_failure.signals.join(', ')}) — evidência arquivada`,
    started_at: null,
    finished_at: null,
  });
  await writeState(paths, next);
  return readState(paths);
}

/**
 * Ordem transacional: evidência primeiro, record depois, state por último.
 *
 * Um crash entre evidência e record deixa cópias idênticas às fontes, e a
 * repetição converge; um crash entre record e state deixa a tarefa como estava,
 * e a repetição encontra o record já publicado e só conclui o que faltou.
 */
export async function recoverInfraAttempt(
  input: InfraRecoveryInput,
): Promise<InfraRecoveryResult> {
  const reason = input.reason.trim();
  if (reason === '') throw new InfraRecoveryError('--reason é obrigatório');
  const { paths, taskId } = input;
  const now = input.now ?? (() => new Date().toISOString());

  const state = await readState(paths);
  const task = getTaskState(state, taskId);

  // Retomada: o record append-only deste attempt já está publicado e a tarefa
  // já voltou a READY. O que resta é provar que a evidência continua íntegra.
  if (task.status === 'READY') {
    const archived = await readInfraFailedAttempt(paths, taskId, task.attempts);
    if (!archived) {
      throw new InfraRecoveryError('tarefa READY sem InfraFailedAttemptRecord correspondente');
    }
    if (archived.reason !== reason) {
      throw new InfraRecoveryError('InfraFailedAttemptRecord já gravado diverge do reason solicitado');
    }
    await assertArchivedEvidence(paths, archived);
    return {
      record: archived,
      recordPath: infraFailedAttemptPath(paths, taskId, archived.attempt),
      state,
      alreadyArchived: true,
      headMode: null,
      adoptedMaintenance: [],
      staleInboxOwnerAttempt: null,
    };
  }

  const source = await loadInfraSource(input, state);
  const existing = await readInfraFailedAttempt(paths, taskId, source.attempt);

  // Antes de tudo: o par stale herdado do attempt anterior vai para o archive
  // DELE e sai do caminho compartilhado. Um crash entre preservar e liberar
  // converge na repetição, porque o archive é append-only e a classificação
  // seguinte encontra o inbox limpo.
  if (source.staleInbox) {
    await migrateStaleInbox(paths, taskId, source.staleInbox, input.inboxReleaseHooks);
  }
  await input.afterStaleInboxMigrated?.();

  const evidence = await archiveEvidence(paths, taskId, source.attempt);
  await input.afterEvidenceArchived?.();

  const record = existing ?? buildRecord(source, evidence, reason, now());
  if (existing) {
    const expected = buildRecord(source, evidence, reason, existing.archived_at);
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new InfraRecoveryError('InfraFailedAttemptRecord já gravado diverge da evidência atual');
    }
  } else {
    await writeInfraFailedAttempt(paths, record);
  }
  await input.afterRecordWritten?.(record);

  const nextState = await reopenTask(paths, record);
  return {
    record,
    recordPath: infraFailedAttemptPath(paths, taskId, record.attempt),
    state: nextState,
    alreadyArchived: existing !== null,
    headMode: source.headMode,
    adoptedMaintenance: source.adoptedMaintenance,
    staleInboxOwnerAttempt: source.staleInbox?.owner.attempt ?? null,
  };
}
