import type { ValidatedCandidateAcceptancePolicy } from './candidate-review.js';
import {
  changedFiles,
  commitExists,
  headSha,
  isWorkingTreeClean,
  parentSha,
} from './git.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import {
  DEV_SCHEMA_VERSION,
  measureProtocolArtifacts,
  sealHandoff,
  type AgentCompletionReport,
  type CompletionRecord,
  type DevelopmentState,
  type HandoffRecord,
  type LaunchRecord,
  type OrchestratorEvidence,
  type ProtocolArtifactBytes,
  type TaskPacket,
  type ValidationEvidence,
  type ValidationResult,
} from './schemas.js';
import {
  readHandoffDraft,
  readLaunchRecord,
  readPacket,
  readReport,
  readCompletion,
  writeCloseManifest,
  writeCompletion,
  writeHandoff,
} from './records.js';
import { canonicalSha256 } from './canonical.js';
import { ZodError } from 'zod';
import { getTaskState, readState, withTaskState, writeState } from './state.js';
import { runOfficialValidation } from './validation-evidence.js';

/**
 * Caminhos que nunca entram num commit aceito: o runtime do harness e o inbox
 * do worker (ambos fora do Git de qualquer forma) e a definição autoritativa
 * das tarefas — um worker que reescreve o próprio plano invalida o protocolo.
 */
const OUT_OF_SCOPE_PATHS = ['.dev/', '.dev-inbox/', 'dev/plan.yaml'];

export type CloseKind = 'PASS' | 'FAIL' | 'PENDING';

export interface CloseOutcome {
  readonly kind: CloseKind;
  readonly taskId: string;
  readonly reason: string;
  readonly completion: CompletionRecord | null;
  readonly handoff: HandoffRecord | null;
  readonly discrepancies: readonly string[];
}

export interface CloseInput {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly taskId: string;
  readonly now?: () => string;
  /**
   * Autoridade de review independente do fechamento orchestrator-owned.
   * Ignorada no fechamento worker-owned, que não possui candidate preparado
   * pelo orquestrador para revisar.
   */
  readonly acceptance?: ValidatedCandidateAcceptancePolicy;
}

interface Guard {
  readonly reason: string;
}

/** Guarda operacional incompleta: retry é legítimo, a tarefa não vira FAIL. */
function pending(reason: string): Guard {
  return { reason };
}

/**
 * "ausente ou inválido" não diz nada a quem precisa corrigir — e a sessão que
 * escreveu o arquivo já morreu. O motivo do rejeito precisa nomear o campo.
 */
async function describeRead<T>(
  read: () => Promise<T | null>,
): Promise<{ value: T | null; problem: string }> {
  try {
    const value = await read();
    return { value, problem: value === null ? 'ausente' : 'ok' };
  } catch (error) {
    if (error instanceof ZodError) {
      const detail = error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
        .join('; ');
      return { value: null, problem: `inválido — ${detail}` };
    }
    return { value: null, problem: `ilegível — ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function closeTask(input: CloseInput): Promise<CloseOutcome> {
  const { paths, loaded, taskId } = input;
  const now = input.now ?? (() => new Date().toISOString());
  let state = await readState(paths);
  const task = getTaskState(state, taskId);
  const planTask = loaded.byId.get(taskId);
  if (!planTask) throw new Error(`tarefa ausente no plano: ${taskId}`);

  // Idempotência: fechar de novo uma tarefa já aceita não revalida nem re-sela.
  if (task.status === 'PASS') {
    const existing = await readCompletion(paths, taskId);
    return {
      kind: 'PASS',
      taskId,
      reason: 'já fechada anteriormente',
      completion: existing,
      handoff: null,
      discrepancies: [],
    };
  }
  if (task.status !== 'RUNNING') {
    return outcome('PENDING', taskId, `tarefa está ${task.status}, não RUNNING`, null, null, []);
  }

  // Fechamento em andamento é estado legítimo e repetível.
  state = withTaskState(state, taskId, { phase: 'FINALIZING' });
  await writeState(paths, state);

  const packet = await readPacket(paths, taskId).catch(() => null);
  if (!packet) return await stayPending(paths, state, taskId, 'task packet ausente ou inválido');

  const reportRead = await describeRead(() => readReport(paths, taskId));
  const report = reportRead.value;
  if (!report) {
    return await stayPending(paths, state, taskId, `AgentCompletionReport ${reportRead.problem}`);
  }
  if (report.task_id !== taskId) {
    return await stayPending(paths, state, taskId, `report pertence a outra tarefa: ${report.task_id}`);
  }

  const draftRead = await describeRead(() => readHandoffDraft(paths, taskId));
  const draft = draftRead.value;
  if (!draft) return await stayPending(paths, state, taskId, `HandoffDraft ${draftRead.problem}`);
  // Draft de outra tarefa nunca é aceito: o task_id do record decide o arquivo
  // de destino, então um draft mentiroso sobrescreveria o handoff alheio.
  if (draft.task_id !== taskId) {
    return await stayPending(paths, state, taskId, `handoff draft pertence a outra tarefa: ${draft.task_id}`);
  }

  const launch = await readLaunchRecord(paths, taskId).catch(() => null);

  const guard = await checkGit(paths, packet, report);
  if ('reason' in guard) return await stayPending(paths, state, taskId, guard.reason);

  const { candidate, changed } = guard;
  const discrepancies = compareReportWithEvidence(report, draft.result, changed);

  // Worker declarou falha: não há o que revalidar, e o fluxo para.
  if (report.self_reported_result === 'FAILURE') {
    const evidence = buildEvidence({
      taskId,
      packet,
      candidate,
      accepted: null,
      changed,
      revalidation: [],
      observedAt: now(),
      launch,
    });
    return await finishFail(
      paths,
      state,
      taskId,
      'worker reportou falha explícita',
      report,
      evidence,
      discrepancies,
      measureProtocolArtifacts(packet, draft),
      now,
    );
  }

  const revalidation: ValidationResult[] = [];
  const validationEvidence: ValidationEvidence[] = [];
  for (const command of packet.validation) {
    const execution = await runOfficialValidation({
      paths,
      taskId,
      attempt: task.attempts,
      command,
    });
    revalidation.push(execution.result);
    validationEvidence.push(execution.evidence);
  }
  const failed = revalidation.filter((result) => result.exit_code !== 0 || result.timed_out);

  if (failed.length > 0) {
    const evidence = buildEvidence({
      taskId,
      packet,
      candidate,
      accepted: null,
      changed,
      revalidation,
      validationEvidence,
      observedAt: now(),
      launch,
    });
    const detail = failed.map((result) => `${result.argv.join(' ')} -> exit ${result.exit_code}`).join('; ');
    return await finishFail(
      paths,
      state,
      taskId,
      `validação obrigatória falhou na re-execução: ${detail}`,
      report,
      evidence,
      discrepancies,
      measureProtocolArtifacts(packet, draft),
      now,
    );
  }

  // Só aqui candidate vira accepted — o worker nunca escreve esse campo.
  const timestamp = now();
  const evidence = buildEvidence({
    taskId,
    packet,
    candidate,
    accepted: candidate,
    changed,
    revalidation,
    validationEvidence,
    observedAt: timestamp,
    launch,
  });
  const completion: CompletionRecord = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: taskId,
    status: 'PASS',
    report,
    orchestrator_evidence: evidence,
    report_matches_evidence: discrepancies.length === 0,
    discrepancies: [...discrepancies],
    finalization_mode: 'normal',
    commit_origin: 'worker',
    protocol_artifact_bytes: measureProtocolArtifacts(packet, draft),
    closed_at: timestamp,
  };
  // Selado campo a campo, nunca por spread do draft: tudo que o orquestrador
  // sabe de fato (task_id, resultado, commit, arquivos, validações) vem da
  // evidência; do worker só sobrevive o que é opinião dele — decisões, lições,
  // sugestão de próximos arquivos e, num draft v2, as lacunas que ele
  // reconhece. A fronteira inteira vive em `sealHandoff`.
  const handoff: HandoffRecord = sealHandoff(draft, {
    task_id: taskId,
    result: 'PASS',
    changed_files: changed,
    validations: revalidation,
    accepted_commit: candidate,
    sealed_at: timestamp,
  });

  // Ordem deliberada: os dois records primeiro, o manifesto por último. Um
  // crash antes do manifesto deixa o fechamento visivelmente incompleto, e o
  // dev-recover se recusa a promover PASS — em vez de aceitar meia evidência.
  await writeCompletion(paths, completion);
  await writeHandoff(paths, handoff);
  await writeCloseManifest(paths, {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: taskId,
    accepted_commit: candidate,
    completion_sha256: canonicalSha256(completion),
    handoff_sha256: canonicalSha256(handoff),
    sealed_at: timestamp,
  });
  state = withTaskState(state, taskId, {
    status: 'PASS',
    phase: null,
    accepted_commit: candidate,
    candidate_commit: candidate,
    diagnostics: null,
    finished_at: timestamp,
  });
  state = { ...state, authorized_head_sha: candidate };
  await writeState(paths, state);

  return outcome('PASS', taskId, 'aceita', completion, handoff, discrepancies);
}

// ---------------------------------------------------------------------------

function outcome(
  kind: CloseKind,
  taskId: string,
  reason: string,
  completion: CompletionRecord | null,
  handoff: HandoffRecord | null,
  discrepancies: readonly string[],
): CloseOutcome {
  return { kind, taskId, reason, completion, handoff, discrepancies };
}

async function stayPending(
  paths: HarnessPaths,
  state: DevelopmentState,
  taskId: string,
  reason: string,
): Promise<CloseOutcome> {
  await writeState(paths, withTaskState(state, taskId, { diagnostics: reason }));
  return outcome('PENDING', taskId, reason, null, null, []);
}

async function finishFail(
  paths: HarnessPaths,
  state: DevelopmentState,
  taskId: string,
  reason: string,
  report: AgentCompletionReport,
  evidence: OrchestratorEvidence,
  discrepancies: readonly string[],
  protocolArtifactBytes: ProtocolArtifactBytes,
  now: () => string,
): Promise<CloseOutcome> {
  const timestamp = now();
  const completion: CompletionRecord = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: taskId,
    status: 'FAIL',
    report,
    orchestrator_evidence: evidence,
    report_matches_evidence: discrepancies.length === 0,
    discrepancies: [...discrepancies],
    finalization_mode: 'normal',
    commit_origin: 'worker',
    protocol_artifact_bytes: protocolArtifactBytes,
    closed_at: timestamp,
  };
  await writeCompletion(paths, completion);
  await writeState(
    paths,
    withTaskState(state, taskId, {
      status: 'FAIL',
      phase: null,
      candidate_commit: evidence.candidate_commit,
      diagnostics: reason,
      finished_at: timestamp,
    }),
  );
  // Handoff NÃO é selado em FAIL: não há trabalho aceito para transmitir.
  return outcome('FAIL', taskId, reason, completion, null, discrepancies);
}

async function checkGit(
  paths: HarnessPaths,
  packet: TaskPacket,
  report: AgentCompletionReport,
): Promise<Guard | { candidate: string; changed: string[] }> {
  if (!(await isWorkingTreeClean(paths.repoRoot))) {
    return pending('working tree suja — o worker deve deixar tudo commitado');
  }

  const candidate = await headSha(paths.repoRoot);
  if (candidate === packet.base_sha) {
    return pending('nenhum candidate commit: HEAD ainda está no base SHA');
  }
  if (!(await commitExists(paths.repoRoot, candidate))) {
    return pending(`candidate commit não localizado: ${candidate}`);
  }
  if (report.candidate_commit !== null && report.candidate_commit !== candidate) {
    return pending(
      `commit reportado (${report.candidate_commit}) não é o HEAD (${candidate}) — commit não localizado`,
    );
  }

  // "Pertence à tarefa" = exatamente um commit sobre o base SHA aceito.
  const parent = await parentSha(paths.repoRoot, candidate);
  if (parent !== packet.base_sha) {
    return pending(
      `candidate commit não parte do base SHA do packet (pai=${parent ?? 'nenhum'}, base=${packet.base_sha})`,
    );
  }

  const changed = await changedFiles(paths.repoRoot, candidate);
  const outOfScope = changed.filter((file) =>
    OUT_OF_SCOPE_PATHS.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
  if (outOfScope.length > 0) {
    return pending(`commit toca caminhos fora do escopo: ${outOfScope.join(', ')}`);
  }

  return { candidate, changed };
}

interface EvidenceInput {
  readonly taskId: string;
  readonly packet: TaskPacket;
  readonly candidate: string | null;
  readonly accepted: string | null;
  readonly changed: readonly string[];
  readonly revalidation: readonly ValidationResult[];
  readonly validationEvidence?: readonly ValidationEvidence[];
  readonly observedAt: string;
  readonly launch: LaunchRecord | null;
}

/**
 * Evidência é sempre derivada pelo orquestrador — duração, exit code e
 * identidade de processo vêm do LaunchRecord, nunca do relato do worker.
 */
function buildEvidence(input: EvidenceInput): OrchestratorEvidence {
  return {
    task_id: input.taskId,
    base_sha: input.packet.base_sha,
    candidate_commit: input.candidate,
    accepted_commit: input.accepted,
    changed_files: [...input.changed],
    working_tree_clean: true,
    process: input.launch?.process ?? null,
    duration_ms: input.launch?.duration_ms ?? 0,
    exit_code: input.launch?.exit_code ?? null,
    timed_out: input.launch?.timed_out ?? false,
    revalidation: [...input.revalidation],
    ...(input.validationEvidence === undefined
      ? {}
      : { validation_evidence: [...input.validationEvidence] }),
    observed_at: input.observedAt,
  };
}

function compareReportWithEvidence(
  report: AgentCompletionReport,
  draftResult: 'PASS' | 'FAIL',
  changed: readonly string[],
): string[] {
  const discrepancies: string[] = [];
  if (report.candidate_commit === null) {
    discrepancies.push('report não declarou candidate_commit');
  }
  const reported = [...report.changed_files].sort();
  const actual = [...changed].sort();
  if (reported.join('\n') !== actual.join('\n')) {
    discrepancies.push(
      `arquivos alterados divergem — reportado [${reported.join(', ')}], real [${actual.join(', ')}]`,
    );
  }
  const expectedResult = report.self_reported_result === 'SUCCESS' ? 'PASS' : 'FAIL';
  if (draftResult !== expectedResult) {
    discrepancies.push(`handoff draft diz ${draftResult} mas o report diz ${report.self_reported_result}`);
  }
  return discrepancies;
}
