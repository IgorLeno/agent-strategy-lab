import { readFile } from 'node:fs/promises';
import { jsonBytes, writeFileAtomic } from './atomic.js';
import { canonicalJson, canonicalSha256, sha256Hex } from './canonical.js';
import {
  lookupCandidateReview,
  type CandidateReviewLookup,
  type ValidatedCandidateAcceptancePolicy,
} from './candidate-review.js';
import type { CloseOutcome } from './close.js';
import { materializeFailedAttemptSource } from './failed-attempt-source.js';
import {
  changedFiles,
  commitExists,
  commitTree,
  gitOrThrow,
  headSha,
  isWorkingTreeClean,
  parentShas,
  patchFingerprint,
  recordedCommitMessage,
  restoreStagedFiles,
  stageFiles,
  stagedFiles,
  workingTreeFiles,
  writeTree,
} from './git.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { isSameProcessAlive } from './process-identity.js';
import {
  completionPath,
  handoffDraftPath,
  originalCompletionEvidencePath,
  readCloseManifest,
  readCompletion,
  readHandoff,
  readLaunchRecord,
  readOrchestratedFinalization,
  readPacket,
  readRevalidationSourceBinding,
  reportPath,
  writeCloseManifest,
  writeCompletion,
  writeHandoff,
  writeOrchestratedFinalization,
} from './records.js';
import {
  AgentCompletionReport,
  CommitMessage,
  CompletionRecord,
  DEV_SCHEMA_VERSION,
  OrchestratedFinalizationRecord,
  parseHandoffDraft,
  sealHandoff,
  type AgentCompletionReport as AgentCompletionReportType,
  type CompletionRecord as CompletionRecordType,
  type DevelopmentState,
  type HandoffDraft,
  type HandoffRecord,
  type LaunchRecord,
  type OrchestratedFinalizationRecord as OrchestratedFinalizationRecordType,
  type OrchestratorEvidence,
  type TaskPacket,
  type ValidationCommand,
  type ValidationEvidence,
  type ValidationResult,
} from './schemas.js';
import { getTaskState, readState, withTaskState, writeState } from './state.js';
import { runOfficialValidation } from './validation-evidence.js';

export class OrchestratedFinalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrchestratedFinalizationError';
  }
}

export type OrchestratedValidationRunner = (
  command: ValidationCommand,
  cwd: string,
) => Promise<ValidationResult>;

export interface FinalizeOrchestratedInput {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly taskId: string;
  readonly validationRunner?: OrchestratedValidationRunner;
  readonly now?: () => string;
  readonly afterCommitCreated?: (candidate: string) => Promise<void>;
  readonly afterFinalizationWritten?: (
    record: OrchestratedFinalizationRecordType,
  ) => Promise<void>;
  readonly afterCompletionWritten?: (completion: CompletionRecordType) => Promise<void>;
  /** Ponto de crash injetado pelos testes, entre selar a fonte do FAIL e publicá-lo. */
  readonly afterFailSourceSealed?: (completion: CompletionRecordType) => Promise<void>;
  /**
   * Autoridade de review independente. Ausente (todo uso histórico e todo
   * fechamento sem control plane), o candidate validado é aceito no mesmo
   * passo, exatamente como sempre foi. Presente, ela decide se este candidate
   * PODE virar PASS — e a promoção só acontece depois do ACCEPT durável.
   */
  readonly acceptance?: ValidatedCandidateAcceptancePolicy;
}

interface SourceEvidence {
  readonly packet: TaskPacket;
  readonly launch: LaunchRecord;
  readonly report: AgentCompletionReportType;
  readonly reportSha256: string;
  readonly handoff: HandoffDraft;
  readonly handoffSha256: string;
  readonly files: string[];
}

const HARNESS_GIT_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: 'Agent Strategy Lab Harness',
  GIT_AUTHOR_EMAIL: 'harness@agent-strategy-lab.invalid',
  GIT_COMMITTER_NAME: 'Agent Strategy Lab Harness',
  GIT_COMMITTER_EMAIL: 'harness@agent-strategy-lab.invalid',
};

export function isForbiddenOrchestratedPath(file: string): boolean {
  if (file === 'dev/plan.yaml') return true;
  return ['.dev', '.dev-inbox', '.claude', '.agents', '.codex'].some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`),
  );
}

function exactFiles(files: readonly string[], label: string): string[] {
  const sorted = [...files].sort();
  if (sorted.length === 0) throw new OrchestratedFinalizationError(`${label} está vazio`);
  if (new Set(sorted).size !== sorted.length) {
    throw new OrchestratedFinalizationError(`${label} contém duplicatas`);
  }
  return sorted;
}

function assertExactFiles(actual: readonly string[], expected: readonly string[]): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new OrchestratedFinalizationError(
      `arquivos reais divergem do report: real [${left.join(', ')}], report [${right.join(', ')}]`,
    );
  }
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OrchestratedFinalizationError(`${label} ausente`);
    }
    throw error;
  }
}

function parseJson<T>(file: string, bytes: Buffer, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new OrchestratedFinalizationError(
      `${file} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadSource(input: FinalizeOrchestratedInput): Promise<SourceEvidence> {
  const packet = await readPacket(input.paths, input.taskId);
  if (!packet) throw new OrchestratedFinalizationError('TaskPacket ausente');
  const planTask = input.loaded.byId.get(input.taskId);
  if (!planTask) throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  if (canonicalJson(packet.validation) !== canonicalJson(planTask.validation)) {
    throw new OrchestratedFinalizationError('validações do TaskPacket divergem do plano autoritativo');
  }
  const launch = await readLaunchRecord(input.paths, input.taskId);
  if (!launch) throw new OrchestratedFinalizationError('LaunchRecord ausente');
  if (launch.task_id !== input.taskId) {
    throw new OrchestratedFinalizationError(`LaunchRecord pertence a ${launch.task_id}`);
  }
  if (launch.finished_at === null || launch.duration_ms === null) {
    throw new OrchestratedFinalizationError('LaunchRecord não está finalizado');
  }
  if (launch.survivors_remaining.length > 0 || (await isSameProcessAlive(launch.process))) {
    throw new OrchestratedFinalizationError('processo do worker ainda está vivo');
  }
  if (launch.execution_policy.commit_owner !== 'orchestrator') {
    throw new OrchestratedFinalizationError('LaunchRecord não pertence ao modo orchestrator-owned');
  }

  const reportFile = reportPath(input.paths, input.taskId);
  const handoffFile = handoffDraftPath(input.paths, input.taskId);
  const [reportBytes, handoffBytes] = await Promise.all([
    readRequired(reportFile, 'AgentCompletionReport'),
    readRequired(handoffFile, 'HandoffDraft'),
  ]);
  const report = parseJson(reportFile, reportBytes, (value) => AgentCompletionReport.parse(value));
  const handoff = parseJson(handoffFile, handoffBytes, parseHandoffDraft);
  for (const [label, taskId] of [
    ['TaskPacket', packet.task_id],
    ['AgentCompletionReport', report.task_id],
    ['HandoffDraft', handoff.task_id],
  ] as const) {
    if (taskId !== input.taskId) {
      throw new OrchestratedFinalizationError(`${label} pertence a outra tarefa: ${taskId}`);
    }
  }
  if (report.candidate_commit !== null) {
    throw new OrchestratedFinalizationError('report.candidate_commit deve ser null');
  }
  const expectedDraftResult = report.self_reported_result === 'SUCCESS' ? 'PASS' : 'FAIL';
  if (handoff.result !== expectedDraftResult) {
    throw new OrchestratedFinalizationError('resultado do HandoffDraft diverge do report');
  }
  const files = exactFiles(report.changed_files, 'report.changed_files');
  const forbidden = files.find(isForbiddenOrchestratedPath);
  if (forbidden) throw new OrchestratedFinalizationError(`caminho proibido: ${forbidden}`);
  return {
    packet,
    launch,
    report,
    reportSha256: sha256Hex(reportBytes),
    handoff,
    handoffSha256: sha256Hex(handoffBytes),
    files,
  };
}

function commitMessageFor(input: FinalizeOrchestratedInput): string {
  const task = input.loaded.byId.get(input.taskId);
  if (!task) throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  return CommitMessage.parse(`feat(${task.id}): ${task.title}`);
}

async function runOfficialValidations(
  input: FinalizeOrchestratedInput,
  packet: TaskPacket,
  attempt: number,
): Promise<{ results: ValidationResult[]; evidence: ValidationEvidence[] }> {
  const commands = input.loaded.byId.get(input.taskId)?.validation;
  if (!commands) throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  const results: ValidationResult[] = [];
  const validationEvidence: ValidationEvidence[] = [];
  if (canonicalJson(commands) !== canonicalJson(packet.validation)) {
    throw new OrchestratedFinalizationError('validações do packet não correspondem ao plano');
  }
  for (const command of commands) {
    const execution = input.validationRunner
      ? { result: await input.validationRunner(command, input.paths.repoRoot), evidence: null }
      : await runOfficialValidation({
          paths: input.paths,
          taskId: input.taskId,
          attempt,
          command,
        });
    const result = execution.result;
    if (canonicalJson(result.argv) !== canonicalJson(command.argv)) {
      throw new OrchestratedFinalizationError('validation runner retornou argv divergente');
    }
    results.push(result);
    if (execution.evidence) validationEvidence.push(execution.evidence);
  }
  return { results, evidence: validationEvidence };
}

async function cachedDiffCheck(
  input: FinalizeOrchestratedInput,
  attempt: number,
) {
  return runOfficialValidation({
    paths: input.paths,
    taskId: input.taskId,
    attempt,
    command: { argv: ['git', 'diff', '--cached', '--check'], timeout_seconds: 300 },
  });
}

async function committedDiffCheck(
  input: FinalizeOrchestratedInput,
  attempt: number,
  base: string,
  candidate: string,
){
  const argv = ['git', 'diff', '--check', `${base}..${candidate}`];
  return runOfficialValidation({
    paths: input.paths,
    taskId: input.taskId,
    attempt,
    command: { argv, timeout_seconds: 300 },
  });
}

async function assertCandidate(
  paths: HarnessPaths,
  candidate: string,
  base: string,
  files: readonly string[],
  message: string,
  expectedTree?: string,
): Promise<void> {
  if (!(await commitExists(paths.repoRoot, candidate))) {
    throw new OrchestratedFinalizationError(`candidate não existe: ${candidate}`);
  }
  const parents = await parentShas(paths.repoRoot, candidate);
  if (parents.length !== 1 || parents[0] !== base) {
    throw new OrchestratedFinalizationError('candidate não tem exatamente o base como único parent');
  }
  assertExactFiles(await changedFiles(paths.repoRoot, candidate), files);
  if ((await recordedCommitMessage(paths.repoRoot, candidate)) !== message) {
    throw new OrchestratedFinalizationError('mensagem do candidate diverge da mensagem derivada');
  }
  if (expectedTree !== undefined && (await commitTree(paths.repoRoot, candidate)) !== expectedTree) {
    throw new OrchestratedFinalizationError('tree do candidate diverge do conteúdo validado e staged');
  }
}

function evidence(
  source: SourceEvidence,
  validations: readonly ValidationResult[],
  timestamp: string,
  candidate: string | null,
  accepted: string | null,
  clean: boolean,
  validationEvidence: readonly ValidationEvidence[] = [],
): OrchestratorEvidence {
  return {
    task_id: source.packet.task_id,
    base_sha: source.packet.base_sha,
    candidate_commit: candidate,
    accepted_commit: accepted,
    changed_files: [...source.files],
    working_tree_clean: clean,
    process: source.launch.process,
    duration_ms: source.launch.duration_ms ?? 0,
    exit_code: source.launch.exit_code,
    timed_out: source.launch.timed_out,
    revalidation: [...validations],
    ...(validationEvidence.length === 0
      ? {}
      : { validation_evidence: [...validationEvidence] }),
    observed_at: timestamp,
  };
}

function discrepancies(source: SourceEvidence): string[] {
  const result: string[] = [];
  if (canonicalJson([...source.handoff.changed_files].sort()) !== canonicalJson(source.files)) {
    result.push('changed_files do HandoffDraft diverge dos arquivos reais');
  }
  return result;
}

function closeOutcome(
  kind: 'PASS' | 'FAIL' | 'PENDING',
  taskId: string,
  reason: string,
  completion: CompletionRecordType | null,
  handoff: HandoffRecord | null,
  differences: readonly string[] = [],
): CloseOutcome {
  return { kind, taskId, reason, completion, handoff, discrepancies: differences };
}

async function stayPending(
  paths: HarnessPaths,
  state: DevelopmentState,
  taskId: string,
  reason: string,
): Promise<CloseOutcome> {
  await writeState(paths, withTaskState(state, taskId, { diagnostics: reason }));
  return closeOutcome('PENDING', taskId, reason, null, null);
}

/**
 * Um FAIL cuja fonte precisa ficar selada: a solução foi ENTREGUE pelo worker e
 * REPROVADA pelo gate oficial. É o único desfecho em que sobra um patch
 * rejeitado no disco e uma intervenção humana possível depois — revalidação
 * auditada ou reparo por `dev-retry-failed`.
 *
 * Os outros FAILs não qualificam e não devem qualificar: worker FAILURE tem
 * `dev-retry`, e um FAIL por HEAD/index/fingerprint que se moveram durante o
 * gate não tem validation reprovada nenhuma para revalidar ou reparar.
 */
function failNeedsSourceBinding(
  source: SourceEvidence,
  validations: readonly ValidationResult[],
): boolean {
  if (source.report.self_reported_result !== 'SUCCESS') return false;
  return validations.some((result) => result.exit_code !== 0 || result.timed_out);
}

async function finishFail(
  input: FinalizeOrchestratedInput,
  state: DevelopmentState,
  source: SourceEvidence,
  reason: string,
  validations: readonly ValidationResult[],
  validationEvidence: readonly ValidationEvidence[] = [],
): Promise<CloseOutcome> {
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const differences = discrepancies(source);
  const completion: CompletionRecordType = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    status: 'FAIL',
    report: source.report,
    orchestrator_evidence: evidence(
      source,
      validations,
      timestamp,
      null,
      null,
      false,
      validationEvidence,
    ),
    report_matches_evidence: differences.length === 0,
    discrepancies: differences,
    finalization_mode: 'normal',
    closed_at: timestamp,
  };

  // Ordem deliberada: a fonte é selada ANTES de o veredito existir no slot
  // corrente e antes de o state ir para FAIL.
  //
  // O motivo é o incidente que esta ordem existe para não repetir: gravar
  // `status = FAIL` junto com um CompletionRecord oficial e um patch rejeitado,
  // sem o binding, produz uma tarefa que nenhuma intervenção suportada
  // consegue mais tocar. Selar primeiro significa que todo estado observável
  // depois de um crash é retomável: ou a fonte ainda não existe e o attempt
  // inteiro se repete, ou ela existe e a selagem converge para os MESMOS bytes
  // (`adoptSealedFail`).
  //
  // Os bytes do binding são derivados de `jsonBytes` — exatamente os que
  // `writeCompletion` vai gravar —, e não de uma segunda serialização: o hash
  // publicado tem que ser o do arquivo que existe no fim.
  const completionBytes = jsonBytes(CompletionRecord.parse(completion));
  if (failNeedsSourceBinding(source, validations)) {
    await materializeFailedAttemptSource({
      paths: input.paths,
      taskId: input.taskId,
      attempt: getTaskState(state, input.taskId).attempts,
      completionBytes,
      stateBaseSha: source.packet.base_sha,
      // No instante do FAIL o HEAD ainda é a base do attempt: é isso que faz
      // deste fingerprint o único contemporâneo da solução reprovada.
      expectedHeadSha: source.packet.base_sha,
      provenance: 'derived_at_official_validation_failure',
      now: () => timestamp,
    });
    await input.afterFailSourceSealed?.(completion);
  }

  await writeCompletion(input.paths, completion);
  await writeState(
    input.paths,
    withTaskState(state, input.taskId, {
      status: 'FAIL',
      phase: null,
      candidate_commit: null,
      accepted_commit: null,
      diagnostics: reason,
      finished_at: timestamp,
    }),
  );
  return closeOutcome('FAIL', input.taskId, reason, completion, null, differences);
}

/**
 * Retomada de um FAIL cuja fonte já foi selada mas cujo veredito não chegou ao
 * state — o crash entre `materializeFailedAttemptSource` e `writeState`.
 *
 * O attempt já terminou e já foi medido: reexecutar o gate aqui poderia
 * produzir um veredito diferente do que está selado e, no limite, promover a
 * PASS um attempt que tem um FAIL oficial arquivado. Então a retomada não
 * reavalia nada — republica os bytes já selados e converge.
 */
async function adoptSealedFail(
  input: FinalizeOrchestratedInput,
  state: DevelopmentState,
  attempt: number,
): Promise<CloseOutcome | null> {
  const binding = await readRevalidationSourceBinding(input.paths, input.taskId, attempt);
  if (!binding) return null;

  const archiveFile = originalCompletionEvidencePath(input.paths, input.taskId, attempt);
  const archived = await readFile(archiveFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (archived === null) {
    throw new OrchestratedFinalizationError(
      `source binding do attempt ${attempt} existe sem ${archiveFile}`,
    );
  }
  if (sha256Hex(archived) !== binding.original_completion_sha256) {
    throw new OrchestratedFinalizationError('CompletionRecord FAIL selado diverge do source binding');
  }
  const completion = parseJson(archiveFile, archived, (value) => CompletionRecord.parse(value));
  if (completion.task_id !== input.taskId || completion.status !== 'FAIL') {
    throw new OrchestratedFinalizationError('CompletionRecord FAIL selado pertence a outro desfecho');
  }

  const failed = completion.orchestrator_evidence.revalidation.find(
    (result) => result.exit_code !== 0 || result.timed_out,
  );
  const reason = failed
    ? `validação oficial falhou: ${failed.argv.join(' ')} (exit ${
        failed.exit_code ?? 'null'
      }) — selagem do FAIL retomada`
    : 'selagem do FAIL retomada';

  // Bytes idênticos aos selados: o slot corrente não pode divergir do archive.
  await writeFileAtomic(completionPath(input.paths, input.taskId), archived.toString('utf8'));
  await writeState(
    input.paths,
    withTaskState(state, input.taskId, {
      status: 'FAIL',
      phase: null,
      candidate_commit: null,
      accepted_commit: null,
      diagnostics: reason,
      finished_at: completion.closed_at,
    }),
  );
  return closeOutcome('FAIL', input.taskId, reason, completion, null, completion.discrepancies);
}

function deterministicCompletion(
  record: OrchestratedFinalizationRecordType,
  source: SourceEvidence,
): CompletionRecordType {
  const differences = discrepancies(source);
  return {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: record.task_id,
    status: 'PASS',
    report: source.report,
    orchestrator_evidence: evidence(
      source,
      record.validation_results,
      record.finalized_at,
      record.candidate_commit,
      record.candidate_commit,
      true,
      record.validation_evidence ?? [],
    ),
    report_matches_evidence: differences.length === 0,
    discrepancies: differences,
    finalization_mode: 'normal',
    commit_origin: 'orchestrator',
    orchestrated_finalization_attempt: record.attempt,
    orchestrated_finalization_record_sha256: canonicalSha256(record),
    closed_at: record.finalized_at,
  };
}

/**
 * Do draft do worker sobrevive SOMENTE opinião; todo fato vem do
 * `OrchestratedFinalizationRecord`, que por sua vez veio do change bundle, da
 * validação oficial e do commit do orquestrador. `sealHandoff` é a única
 * implementação dessa fronteira, e é ela que decide se o record sai v1 ou v2.
 */
function deterministicHandoff(
  record: OrchestratedFinalizationRecordType,
  source: SourceEvidence,
): HandoffRecord {
  return sealHandoff(source.handoff, {
    task_id: record.task_id,
    result: 'PASS',
    changed_files: record.changed_files,
    validations: record.validation_results,
    accepted_commit: record.candidate_commit,
    sealed_at: record.finalized_at,
  });
}

async function assertOrWrite<T>(
  label: string,
  existing: T | null,
  expected: T,
  write: () => Promise<void>,
): Promise<void> {
  if (existing === null) {
    await write();
    return;
  }
  if (canonicalJson(existing) !== canonicalJson(expected)) {
    throw new OrchestratedFinalizationError(`${label} existente diverge do finalization record`);
  }
}

export async function verifyOrchestratedFinalizationRecord(
  input: FinalizeOrchestratedInput,
  record: OrchestratedFinalizationRecordType,
): Promise<SourceEvidence> {
  OrchestratedFinalizationRecord.parse(record);
  const source = await loadSource(input);
  if (
    record.task_id !== input.taskId ||
    record.base_sha !== source.packet.base_sha ||
    record.profile_id !== source.launch.profile_id ||
    canonicalJson(record.execution_policy) !== canonicalJson(source.launch.execution_policy) ||
    record.report_sha256 !== source.reportSha256 ||
    record.handoff_draft_sha256 !== source.handoffSha256
  ) {
    throw new OrchestratedFinalizationError('OrchestratedFinalizationRecord diverge das fontes');
  }
  assertExactFiles(record.changed_files, source.files);
  await assertCandidate(
    input.paths,
    record.candidate_commit,
    record.base_sha,
    record.changed_files,
    record.commit_message,
  );
  if (!(await isWorkingTreeClean(input.paths.repoRoot)) || (await stagedFiles(input.paths.repoRoot)).length > 0) {
    throw new OrchestratedFinalizationError('candidate existe, mas checkout ou index não está limpo');
  }
  return source;
}

/**
 * Guarda ÚNICA e obrigatória da fronteira "candidate validado -> PASS aceito".
 *
 * Fica aqui, e não no chamador, porque `sealOrchestratedFinalization` é o
 * gargalo por onde passam TODOS os promotores: a finalização normal, a
 * retomada de finalização e o `recover`. Um candidate que exige review não
 * pode ser selado por nenhum deles sem um ACCEPT durável amarrado a ele —
 * inclusive por um `dev-recover` rodado por um humano que não sabe da review.
 */
async function assertCandidateReviewAccepted(
  input: FinalizeOrchestratedInput,
  record: OrchestratedFinalizationRecordType,
): Promise<void> {
  const lookup = await lookupCandidateReview(input.paths, record);
  if (lookup.status === 'NOT_REQUIRED' || lookup.status === 'ACCEPTED') return;
  throw new OrchestratedFinalizationError(
    `candidate ${record.candidate_commit} exige review independente e não pode ser selado ` +
      `(${lookup.status}): ${lookup.reason}`,
  );
}

export async function sealOrchestratedFinalization(
  input: FinalizeOrchestratedInput,
  record: OrchestratedFinalizationRecordType,
): Promise<{ completion: CompletionRecordType; handoff: HandoffRecord }> {
  await assertCandidateReviewAccepted(input, record);
  const source = await verifyOrchestratedFinalizationRecord(input, record);
  const completion = deterministicCompletion(record, source);
  const handoff = deterministicHandoff(record, source);
  await assertOrWrite(
    'CompletionRecord',
    await readCompletion(input.paths, input.taskId),
    completion,
    () => writeCompletion(input.paths, completion),
  );
  await input.afterCompletionWritten?.(completion);
  await assertOrWrite(
    'HandoffRecord',
    await readHandoff(input.paths, input.taskId),
    handoff,
    () => writeHandoff(input.paths, handoff),
  );
  const manifest = {
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    accepted_commit: record.candidate_commit,
    completion_sha256: canonicalSha256(completion),
    handoff_sha256: canonicalSha256(handoff),
    sealed_at: record.finalized_at,
  } as const;
  await assertOrWrite(
    'CloseManifest',
    await readCloseManifest(input.paths, input.taskId),
    manifest,
    () => writeCloseManifest(input.paths, manifest),
  );
  return { completion, handoff };
}

async function promoteState(
  input: FinalizeOrchestratedInput,
  record: OrchestratedFinalizationRecordType,
): Promise<void> {
  const state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  if (task.status !== 'RUNNING' && task.status !== 'PASS') {
    throw new OrchestratedFinalizationError(`state ${task.status} não pode ser promovido a PASS`);
  }
  let updated = withTaskState(state, input.taskId, {
    status: 'PASS',
    phase: null,
    candidate_commit: record.candidate_commit,
    accepted_commit: record.candidate_commit,
    diagnostics: null,
    finished_at: record.finalized_at,
  });
  updated = { ...updated, authorized_head_sha: record.candidate_commit };
  await writeState(input.paths, updated);
}

/**
 * Metade da ACEITAÇÃO. Recebe um candidate já preparado e validado e conclui —
 * ou não conclui — a promoção. Nada aqui reexecuta validação, refaz commit ou
 * relança worker: o candidate é exatamente o mesmo em toda retomada.
 *
 * Idempotente por construção: `sealOrchestratedFinalization` converge para os
 * mesmos bytes e `promoteState` aceita uma tarefa já PASS. Um crash em
 * qualquer ponto depois do ACCEPT durável é retomável promovendo o MESMO
 * candidate, sem novo implementer e sem novo reviewer.
 */
async function acceptValidatedCandidate(
  input: FinalizeOrchestratedInput,
  state: DevelopmentState,
  record: OrchestratedFinalizationRecordType,
  passReason: string,
): Promise<CloseOutcome> {
  const lookup = await lookupCandidateReview(input.paths, record);
  if (lookup.status !== 'NOT_REQUIRED' && lookup.status !== 'ACCEPTED') {
    if (input.acceptance === undefined) {
      // Sem autoridade de review não existe quem possa decidir: o candidate
      // fica preparado e preservado, a tarefa não é aceita e a próxima não é
      // liberada. É o caminho de um `dev-close` avulso sobre um candidate que
      // pertence a uma run com review exigida.
      return stayPending(
        input.paths,
        state,
        input.taskId,
        `candidate ${record.candidate_commit} não foi aceito pela review independente: ${lookup.reason}`,
      );
    }
    // O veredito durável já publicado é reexaminado pela AUTORIDADE, não aqui:
    // é ela que sabe que um REJECT não se reabre por automação e que produz o
    // gate humano correspondente.
    const decision = await input.acceptance.review({ taskId: input.taskId, record });
    if (decision.outcome === 'BLOCKED') {
      return stayPending(
        input.paths,
        state,
        input.taskId,
        `candidate ${record.candidate_commit} não foi aceito pela review independente ` +
          `(${decision.code}): ${decision.reason}`,
      );
    }
    // Um ACCEPT em memória não promove nada: o que promove é o veredito
    // DURÁVEL amarrado a este candidate. Sem ele publicado, a aceitação não
    // sobreviveria a um crash — e é justamente a sobrevivência que a fronteira
    // existe para garantir.
    const published = await lookupCandidateReview(input.paths, record);
    if (published.status !== 'ACCEPTED') {
      return stayPending(
        input.paths,
        state,
        input.taskId,
        `autoridade de review devolveu ACCEPT sem veredito durável amarrado ao candidate ` +
          `${record.candidate_commit}: ${published.reason}`,
      );
    }
  }

  const sealed = await sealOrchestratedFinalization(input, record);
  await promoteState(input, record);
  return closeOutcome(
    'PASS',
    input.taskId,
    passReason,
    sealed.completion,
    sealed.handoff,
    sealed.completion.discrepancies,
  );
}

export type PendingAcceptanceStatus = 'NONE' | 'PROMOTED' | 'BLOCKED';

export interface PendingAcceptanceResolution {
  readonly status: PendingAcceptanceStatus;
  readonly taskId: string | null;
  readonly candidateCommit: string | null;
  readonly reason: string;
}

/**
 * Retomada da fronteira de aceitação entre PROCESSOS.
 *
 * Um candidate preparado que aguarda review é trabalho legítimo em curso, não
 * incidente: quem reabre o runtime precisa concluí-lo — pedindo o veredito que
 * falta, promovendo o ACCEPT que já existe, ou parando no REJECT que já foi
 * publicado — ANTES de qualquer seleção de tarefa nova. É isso que faz um
 * REJECT sobreviver ao fim do processo em vez de ser esquecido no rerun.
 *
 * Só age sobre candidate que DECLARA review exigida. Todo o resto do fluxo de
 * retomada continua sendo do `recover`/preflight, intocado.
 */
export type PendingAcceptanceInspection =
  | { readonly status: 'NONE'; readonly reason: string }
  | {
      readonly status: 'PENDING';
      readonly taskId: string;
      readonly attempt: number;
      readonly candidateCommit: string;
      readonly record: OrchestratedFinalizationRecordType;
      readonly state: DevelopmentState;
      /** Veredito durável já publicado sobre ESTE candidate, se existir. */
      readonly review: CandidateReviewLookup;
    };

/**
 * LEITURA da fronteira de aceitação — quem está esperando decisão, e qual
 * veredito durável já existe sobre ele. Zero efeito: nenhuma promoção, nenhum
 * reviewer, nenhuma escrita.
 *
 * Separada de `resumePendingAcceptance` porque a mesma pergunta é feita por
 * dois consumidores com direitos diferentes: a retomada, que pode promover ou
 * bloquear, e o dry-run, que só pode relatar. Um dry-run que respondesse
 * "READY" com um REJECT durável em disco estaria prevendo um launch que o
 * runtime real jamais faria.
 */
export async function inspectPendingAcceptance(input: {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
}): Promise<PendingAcceptanceInspection> {
  let state: DevelopmentState;
  try {
    state = await readState(input.paths);
  } catch {
    return { status: 'NONE', reason: 'runtime ainda não tem state autoritativo' };
  }
  const pending = state.tasks.find(
    (task) => task.status === 'RUNNING' && task.phase === 'FINALIZING' && task.attempts > 0,
  );
  if (pending === undefined) return { status: 'NONE', reason: 'nenhuma finalização pendente' };
  if (!input.loaded.byId.has(pending.id)) {
    return { status: 'NONE', reason: `${pending.id} não existe no plano carregado` };
  }

  const record = await readOrchestratedFinalization(input.paths, pending.id, pending.attempts).catch(
    () => null,
  );
  if (record === null) {
    return { status: 'NONE', reason: `${pending.id} não tem candidate preparado neste attempt` };
  }
  if (record.review_requirement === undefined) {
    return {
      status: 'NONE',
      reason: `candidate de ${pending.id} não exige review independente`,
    };
  }

  return {
    status: 'PENDING',
    taskId: pending.id,
    attempt: pending.attempts,
    candidateCommit: record.candidate_commit,
    record,
    state,
    review: await lookupCandidateReview(input.paths, record),
  };
}

export async function resumePendingAcceptance(input: {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly acceptance: ValidatedCandidateAcceptancePolicy;
  readonly now?: () => string;
}): Promise<PendingAcceptanceResolution> {
  const inspected = await inspectPendingAcceptance(input);
  if (inspected.status === 'NONE') {
    return { status: 'NONE', taskId: null, candidateCommit: null, reason: inspected.reason };
  }
  const pending = { id: inspected.taskId };
  const state = inspected.state;
  const record = inspected.record;

  const outcome = await acceptValidatedCandidate(
    {
      paths: input.paths,
      loaded: input.loaded,
      taskId: pending.id,
      acceptance: input.acceptance,
      ...(input.now === undefined ? {} : { now: input.now }),
    },
    state,
    record,
    'candidate retomado e aceito pela review independente',
  );
  return {
    status: outcome.kind === 'PASS' ? 'PROMOTED' : 'BLOCKED',
    taskId: pending.id,
    candidateCommit: record.candidate_commit,
    reason: outcome.reason,
  };
}

export async function finalizeOrchestratedTask(
  input: FinalizeOrchestratedInput,
): Promise<CloseOutcome> {
  let state = await readState(input.paths);
  const task = getTaskState(state, input.taskId);
  if (!input.loaded.byId.has(input.taskId)) {
    throw new OrchestratedFinalizationError(`tarefa ausente no plano: ${input.taskId}`);
  }
  const existing =
    task.attempts > 0
      ? await readOrchestratedFinalization(input.paths, input.taskId, task.attempts)
      : null;
  if (existing) {
    return acceptValidatedCandidate(
      input,
      state,
      existing,
      task.status === 'PASS' ? 'já fechada anteriormente' : 'selagem retomada',
    );
  }
  if (task.status === 'PASS') {
    throw new OrchestratedFinalizationError('PASS sem OrchestratedFinalizationRecord correspondente');
  }
  if (task.status !== 'RUNNING' || task.phase !== 'FINALIZING') {
    return stayPending(
      input.paths,
      state,
      input.taskId,
      `tarefa está ${task.status}/${task.phase ?? 'sem fase'}, não RUNNING/FINALIZING`,
    );
  }
  if (state.tasks.some((candidate) => candidate.id !== input.taskId && candidate.status === 'RUNNING')) {
    return stayPending(input.paths, state, input.taskId, 'outra tarefa está RUNNING');
  }

  // Simétrico ao replay do OrchestratedFinalizationRecord acima: um FAIL cuja
  // fonte já está selada é uma decisão publicada deste attempt, e a retomada a
  // conclui em vez de reabrir o gate.
  if (task.attempts > 0) {
    const adopted = await adoptSealedFail(input, state, task.attempts);
    if (adopted) return adopted;
  }

  let source: SourceEvidence;
  try {
    source = await loadSource(input);
  } catch (error) {
    return stayPending(
      input.paths,
      state,
      input.taskId,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (source.packet.base_sha !== task.base_sha || source.packet.base_sha !== state.authorized_head_sha) {
    return stayPending(input.paths, state, input.taskId, 'base SHA do packet/state não é autorizada');
  }
  if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
    return stayPending(input.paths, state, input.taskId, 'index contém mudanças staged prévias');
  }

  // A exigência de review é resolvida ANTES de o candidate ser gravado: é ela
  // que torna o record "preparado e validado, ainda não aceito", e ela precisa
  // estar dentro do próprio record para sobreviver ao processo.
  const reviewRequirement = input.acceptance?.requirementFor(input.taskId) ?? null;

  const message = commitMessageFor(input);
  let currentHead = await headSha(input.paths.repoRoot);
  if (currentHead !== source.packet.base_sha) {
    try {
      if (!(await isWorkingTreeClean(input.paths.repoRoot))) {
        throw new OrchestratedFinalizationError('HEAD avançou e working tree não está limpa');
      }
      await assertCandidate(
        input.paths,
        currentHead,
        source.packet.base_sha,
        source.files,
        message,
      );
      const validationBatch = await runOfficialValidations(input, source.packet, task.attempts);
      const validationResults = validationBatch.results;
      const validationEvidence = validationBatch.evidence;
      const diffExecution = await committedDiffCheck(
        input,
        task.attempts,
        source.packet.base_sha,
        currentHead,
      );
      validationResults.push(diffExecution.result);
      validationEvidence.push(diffExecution.evidence);
      const failed = validationResults.find((result) => result.exit_code !== 0 || result.timed_out);
      if (failed) {
        throw new OrchestratedFinalizationError(
          `validação do candidate retomado falhou: ${failed.argv.join(' ')}`,
        );
      }
      const record = OrchestratedFinalizationRecord.parse({
        schema_version: DEV_SCHEMA_VERSION,
        task_id: input.taskId,
        attempt: task.attempts,
        base_sha: source.packet.base_sha,
        profile_id: source.launch.profile_id,
        execution_policy: source.launch.execution_policy,
        report_sha256: source.reportSha256,
        handoff_draft_sha256: source.handoffSha256,
        report_result: 'SUCCESS',
        report_candidate_commit: null,
        commit_message: message,
        changed_files: source.files,
        validation_results: validationResults,
        validation_evidence: validationEvidence,
        patch_fingerprint: sha256Hex(await commitTree(input.paths.repoRoot, currentHead)),
        candidate_commit: currentHead,
        commit_origin: 'orchestrator',
        ...(reviewRequirement === null ? {} : { review_requirement: reviewRequirement }),
        finalized_at: (input.now ?? (() => new Date().toISOString()))(),
      });
      await writeOrchestratedFinalization(input.paths, record);
      await input.afterFinalizationWritten?.(record);
      return await acceptValidatedCandidate(input, state, record, 'candidate retomado e aceito');
    } catch (error) {
      return stayPending(
        input.paths,
        state,
        input.taskId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  let actualFiles: string[];
  try {
    actualFiles = await workingTreeFiles(input.paths.repoRoot);
    assertExactFiles(actualFiles, source.files);
    if (actualFiles.length === 0) throw new OrchestratedFinalizationError('working tree sem alterações');
  } catch (error) {
    return stayPending(
      input.paths,
      state,
      input.taskId,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (source.report.self_reported_result === 'FAILURE') {
    return finishFail(input, state, source, 'worker reportou FAILURE', []);
  }

  const fingerprintBefore = await patchFingerprint(input.paths.repoRoot);
  const validationBatch = await runOfficialValidations(input, source.packet, task.attempts);
  const validationResults = validationBatch.results;
  const validationEvidence = validationBatch.evidence;
  const fingerprintAfter = await patchFingerprint(input.paths.repoRoot);
  const stagedByValidation = await stagedFiles(input.paths.repoRoot);
  if (stagedByValidation.length > 0) {
    await restoreStagedFiles(input.paths.repoRoot, stagedByValidation);
  }
  const failed = validationResults.find((result) => result.exit_code !== 0 || result.timed_out);
  if (failed) {
    return finishFail(
      input,
      state,
      source,
      `validação oficial falhou: ${failed.argv.join(' ')} (exit ${failed.exit_code ?? 'null'})`,
      validationResults,
      validationEvidence,
    );
  }
  if (fingerprintBefore !== fingerprintAfter) {
    return finishFail(
      input,
      state,
      source,
      'patch fingerprint mudou durante as validações oficiais',
      validationResults,
      validationEvidence,
    );
  }
  if (stagedByValidation.length > 0) {
    return finishFail(
      input,
      state,
      source,
      'index mudou durante as validações e foi restaurado',
      validationResults,
      validationEvidence,
    );
  }
  currentHead = await headSha(input.paths.repoRoot);
  if (currentHead !== source.packet.base_sha) {
    return finishFail(
      input,
      state,
      source,
      'HEAD mudou durante as validações',
      validationResults,
      validationEvidence,
    );
  }
  if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
    return finishFail(
      input,
      state,
      source,
      'index mudou durante as validações',
      validationResults,
      validationEvidence,
    );
  }
  try {
    assertExactFiles(await workingTreeFiles(input.paths.repoRoot), source.files);
  } catch (error) {
    return finishFail(
      input,
      state,
      source,
      error instanceof Error ? error.message : String(error),
      validationResults,
      validationEvidence,
    );
  }

  await stageFiles(input.paths.repoRoot, source.files);
  try {
    assertExactFiles(await stagedFiles(input.paths.repoRoot), source.files);
    const diffExecution = await cachedDiffCheck(input, task.attempts);
    const diffCheck = diffExecution.result;
    validationResults.push(diffCheck);
    validationEvidence.push(diffExecution.evidence);
    if (diffCheck.exit_code !== 0 || diffCheck.timed_out) {
      await restoreStagedFiles(input.paths.repoRoot, source.files);
      if ((await stagedFiles(input.paths.repoRoot)).length > 0) {
        throw new OrchestratedFinalizationError('falha ao restaurar index após cached diff-check');
      }
      return finishFail(
        input,
        state,
        source,
        'git diff --cached --check falhou; index restaurado',
        validationResults,
        validationEvidence,
      );
    }
    const stagedTree = await writeTree(input.paths.repoRoot);
    await gitOrThrow(input.paths.repoRoot, ['commit', '-m', message], HARNESS_GIT_IDENTITY);
    currentHead = await headSha(input.paths.repoRoot);
    await input.afterCommitCreated?.(currentHead);
    await assertCandidate(
      input.paths,
      currentHead,
      source.packet.base_sha,
      source.files,
      message,
      stagedTree,
    );
  } catch (error) {
    if ((await headSha(input.paths.repoRoot)) === source.packet.base_sha) {
      await restoreStagedFiles(input.paths.repoRoot, source.files).catch(() => undefined);
    }
    throw error;
  }
  if (!(await isWorkingTreeClean(input.paths.repoRoot)) || (await stagedFiles(input.paths.repoRoot)).length > 0) {
    throw new OrchestratedFinalizationError('candidate não deixou working tree e index limpos');
  }

  const record = OrchestratedFinalizationRecord.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: input.taskId,
    attempt: task.attempts,
    base_sha: source.packet.base_sha,
    profile_id: source.launch.profile_id,
    execution_policy: source.launch.execution_policy,
    report_sha256: source.reportSha256,
    handoff_draft_sha256: source.handoffSha256,
    report_result: 'SUCCESS',
    report_candidate_commit: null,
    commit_message: message,
    changed_files: source.files,
    validation_results: validationResults,
    validation_evidence: validationEvidence,
    patch_fingerprint: fingerprintBefore,
    candidate_commit: currentHead,
    commit_origin: 'orchestrator',
    ...(reviewRequirement === null ? {} : { review_requirement: reviewRequirement }),
    finalized_at: (input.now ?? (() => new Date().toISOString()))(),
  });
  await writeOrchestratedFinalization(input.paths, record);
  await input.afterFinalizationWritten?.(record);
  return await acceptValidatedCandidate(input, state, record, 'aceita');
}
