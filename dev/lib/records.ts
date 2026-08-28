import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, writeJsonOnce } from './atomic.js';
import { sha256Hex } from './canonical.js';
import type { HarnessPaths } from './paths.js';
import {
  AgentCompletionReport,
  AdditionalRepairAuthorizationConsumptionRecord,
  AdditionalRepairAuthorizationRecord,
  ProviderExpansionAuthorizationRecord,
  AttemptAbandonmentRecord,
  CandidateReviewRecord,
  CloseManifest,
  CompletionRecord,
  InfraFailedAttemptRecord,
  LaunchRecord,
  ProjectHistoryBinding,
  MaintenanceRecord,
  OrchestratedRevalidationRecord,
  OrchestratedFinalizationRecord,
  PlannedWorkAdoptionRecord,
  PreservedChangeBundleManifest,
  ProtocolInvalidAttemptRecord,
  ReviewParseFailureRecord,
  ReviewRejectedAttemptRecord,
  ReviewRejectionClassificationRecord,
  RevalidationCheckpoint,
  RevalidationSourceBinding,
  RecoveredFinalizationRecord,
  ValidationFailedAttemptRecord,
  type HandoffDraft,
  type HandoffRecord,
  type LaunchRecordInput,
  type TaskPacket,
  parseHandoffDraft,
  parseHandoffRecord,
  parseTaskPacket,
} from './schemas.js';

export function packetPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.packetsDir, `${taskId}.json`);
}

export function handoffPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.handoffsDir, `${taskId}.json`);
}

/** Inbox da tarefa: o único diretório que o worker recebe para escrita. */
export function taskInboxDir(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.inboxDir, taskId);
}

export function handoffDraftPath(paths: HarnessPaths, taskId: string): string {
  return path.join(taskInboxDir(paths, taskId), 'handoff-draft.json');
}

/** O worker escreve nesses caminhos, então eles precisam existir antes do launch. */
export async function ensureTaskInbox(paths: HarnessPaths, taskId: string): Promise<void> {
  await mkdir(taskInboxDir(paths, taskId), { recursive: true });
}

export function launchRecordPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.logsDir, `${taskId}.launch.json`);
}

export function projectHistoryBindingPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  launchId: string,
): string {
  return path.join(
    paths.projectHistoryBindingsDir,
    taskId,
    `attempt-${attempt}-${launchId}.json`,
  );
}

export function reportPath(paths: HarnessPaths, taskId: string): string {
  return path.join(taskInboxDir(paths, taskId), 'report.json');
}

/**
 * Intent append-only de liberação do inbox: prova durável de que a release
 * daquele par já foi autorizada (archive completo conferido) antes do primeiro
 * `rm`. Sem este arquivo, um meio par no slot corrente permanece ambíguo.
 */
export function inboxReleaseIntentPath(paths: HarnessPaths, taskId: string): string {
  return path.join(taskInboxDir(paths, taskId), 'inbox-release.intent.json');
}

export function completionPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.completionsDir, `${taskId}.completion.json`);
}

/** Escrito por último num fechamento aceito: existir = o bundle está completo. */
export function closeManifestPath(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.completionsDir, `${taskId}.close-manifest.json`);
}

export function maintenanceRecordPath(paths: HarnessPaths, adoptedHeadSha: string): string {
  return path.join(paths.maintenanceDir, `${adoptedHeadSha}.json`);
}

/**
 * Record de uma adoção de planned work, indexado pelo head que ela autoriza —
 * mesma convenção do MaintenanceRecord, para que o passo de avanço da base seja
 * uma busca por `previous_authorized_head_sha` nas duas famílias.
 */
export function plannedWorkAdoptionPath(
  paths: HarnessPaths,
  adoptedHeadSha: string,
): string {
  return path.join(paths.plannedWorkAdoptionsDir, `${adoptedHeadSha}.json`);
}

/**
 * Evidence externa da revalidação de UMA tarefa adotada. Fica ao lado do record
 * (e não em `validation-logs/<task>/attempt-N`) porque não houve attempt: o
 * diretório de attempts descreve execuções do harness, e uma adoção não é uma.
 */
export function plannedWorkAdoptionEvidenceDir(
  paths: HarnessPaths,
  adoptedHeadSha: string,
  taskId: string,
): string {
  return path.join(paths.plannedWorkAdoptionsDir, adoptedHeadSha, taskId);
}

export function attemptAbandonmentPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(paths.attemptsDir, taskId, `${attempt}-abandoned.json`);
}

export function recoveryRecordPath(
  paths: HarnessPaths,
  taskId: string,
  sourceAttempt: number,
): string {
  return path.join(paths.recoveriesDir, taskId, `attempt-${sourceAttempt}.json`);
}

export function orchestratedFinalizationPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(paths.finalizationsDir, taskId, `attempt-${attempt}.json`);
}

/**
 * Um veredito por (task, attempt): o candidate de um attempt é único, e um
 * segundo veredito para o mesmo attempt seria uma segunda decisão sobre a
 * mesma coisa. Attempts diferentes têm diretórios diferentes.
 */
export function candidateReviewPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(paths.reviewsDir, taskId, `attempt-${attempt}`, 'review.json');
}

export function unparseableReviewEvidencePath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  stdoutSha256: string,
): string {
  return path.join(
    paths.reviewsDir,
    taskId,
    `attempt-${attempt}`,
    `unparseable-invocation-${stdoutSha256}.json`,
  );
}

export function reviewRejectionClassificationPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(
    paths.reviewsDir,
    taskId,
    `attempt-${attempt}`,
    'rejection-classification.json',
  );
}

export function revalidationAttemptDir(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(paths.revalidationsDir, taskId, `attempt-${attempt}`);
}

export function sourceBindingPath(paths: HarnessPaths, taskId: string, attempt: number): string {
  return path.join(revalidationAttemptDir(paths, taskId, attempt), 'source-binding.json');
}

export function originalCompletionEvidencePath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(revalidationAttemptDir(paths, taskId, attempt), 'original-completion.fail.json');
}

export function revalidationRecordPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): string {
  return path.join(
    revalidationAttemptDir(paths, taskId, attempt),
    `revalidation-${sequence}.json`,
  );
}

export function revalidationCheckpointPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): string {
  return path.join(
    revalidationAttemptDir(paths, taskId, attempt),
    `revalidation-${sequence}.checkpoint.json`,
  );
}

export function failedAttemptDir(paths: HarnessPaths, taskId: string, attempt: number): string {
  return path.join(paths.failedAttemptsDir, taskId, `attempt-${attempt}`);
}

export function additionalRepairTaskDir(paths: HarnessPaths, taskId: string): string {
  return path.join(paths.additionalRepairAuthorizationsDir, taskId);
}

export function additionalRepairGrantPath(
  paths: HarnessPaths,
  taskId: string,
  grantSha256: string,
): string {
  return path.join(additionalRepairTaskDir(paths, taskId), `grant-${grantSha256}.json`);
}

export function additionalRepairConsumptionPath(
  paths: HarnessPaths,
  taskId: string,
  grantSha256: string,
  attempt: number,
): string {
  return path.join(
    additionalRepairTaskDir(paths, taskId),
    `consumed-${grantSha256}-attempt-${attempt}.json`,
  );
}

export function validationFailedAttemptPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'validation-failed-attempt.json');
}

export function reviewRejectedAttemptPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'review-rejected-attempt.json');
}

/**
 * Bytes exatos do CompletionRecord FAIL que foi reprovado neste attempt.
 * Append-only, dentro do diretório do próprio attempt: o slot corrente
 * (`completionPath`) precisa ficar livre para o CompletionRecord do PRÓXIMO
 * attempt, e um FAIL histórico parado lá bloquearia a selagem seguinte.
 */
export function failedAttemptCompletionPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'completion.fail.json');
}

/**
 * Bytes EXATOS do `AgentCompletionReport` que o worker deixou no inbox neste
 * attempt. O inbox é um slot por tarefa (`reportPath`), reusado pelo attempt
 * seguinte: sem esta cópia, o output do attempt N sobrevive no caminho corrente
 * e pode ser lido como se fosse do attempt N+1.
 */
export function failedAttemptReportPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'report.json');
}

/** Bytes exatos do `HandoffDraft` do attempt, pelo mesmo motivo do report. */
export function failedAttemptHandoffDraftPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'handoff-draft.json');
}

/**
 * Attempt encerrado por falha de infraestrutura do provider. Mora no diretório
 * do próprio attempt, ao lado da evidência de um attempt reprovado pela
 * validation: o diretório é "tudo o que sobrou deste attempt", e o nome do
 * arquivo é que diz qual foi o desfecho.
 */
export function infraFailedAttemptPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'infra-failed-attempt.json');
}

export function protocolInvalidDir(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'protocol-invalid');
}

export function protocolInvalidAttemptPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(protocolInvalidDir(paths, taskId, attempt), 'protocol-invalid-attempt.json');
}

export function protocolInvalidEvidencePath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  name: 'launch.json',
): string {
  return path.join(protocolInvalidDir(paths, taskId, attempt), name);
}

export function protocolInvalidPatchFilePath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  file: string,
): string {
  return path.join(protocolInvalidDir(paths, taskId, attempt), 'files', file);
}

/**
 * Cópias byte-idênticas do que `.dev/logs/<task>.*` continha no attempt.
 * Aquele slot é do lançamento MAIS RECENTE: um novo attempt o sobrescreve, e
 * sem a cópia a evidência do incidente desapareceria na primeira retentativa.
 */
export function infraAttemptEvidencePath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  name: 'launch.infra.json' | 'stdout.log' | 'stderr.log' | 'completion.misclassified.json',
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), name);
}

export function preservedBundleManifestPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'changes-manifest.json');
}

export function preservedBundlePatchPath(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): string {
  return path.join(failedAttemptDir(paths, taskId, attempt), 'changes.patch');
}

export async function nextRevalidationSequence(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(revalidationAttemptDir(paths, taskId, attempt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 1;
    throw error;
  }
  let maximum = 0;
  for (const name of names) {
    const match = /^revalidation-(\d+)\.json$/.exec(name);
    if (match?.[1]) maximum = Math.max(maximum, Number(match[1]));
  }
  return maximum + 1;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

const writeJson = writeJsonAtomic;

export async function readOptional<T>(
  file: string,
  parse: (input: unknown) => T,
): Promise<T | null> {
  try {
    return parse(await readJson(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export const readPacket = (paths: HarnessPaths, taskId: string): Promise<TaskPacket | null> =>
  readOptional(packetPath(paths, taskId), parseTaskPacket);

export const writePacket = (paths: HarnessPaths, packet: TaskPacket): Promise<void> =>
  writeJson(packetPath(paths, packet.task_id), parseTaskPacket(packet));

export const readHandoff = (paths: HarnessPaths, taskId: string): Promise<HandoffRecord | null> =>
  readOptional(handoffPath(paths, taskId), parseHandoffRecord);

export const writeHandoff = (paths: HarnessPaths, record: HandoffRecord): Promise<void> =>
  writeJson(handoffPath(paths, record.task_id), parseHandoffRecord(record));

export const readHandoffDraft = (
  paths: HarnessPaths,
  taskId: string,
): Promise<HandoffDraft | null> => readOptional(handoffDraftPath(paths, taskId), parseHandoffDraft);

export const readReport = (
  paths: HarnessPaths,
  taskId: string,
): Promise<AgentCompletionReport | null> =>
  readOptional(reportPath(paths, taskId), (input) => AgentCompletionReport.parse(input));

export const writeCompletion = (
  paths: HarnessPaths,
  record: CompletionRecord,
): Promise<void> =>
  writeJson(completionPath(paths, record.task_id), CompletionRecord.parse(record));

export const readLaunchRecord = (
  paths: HarnessPaths,
  taskId: string,
): Promise<LaunchRecord | null> =>
  readOptional(launchRecordPath(paths, taskId), (input) => LaunchRecord.parse(input));

export const writeLaunchRecord = (paths: HarnessPaths, record: LaunchRecordInput): Promise<void> =>
  writeJson(launchRecordPath(paths, record.task_id), LaunchRecord.parse(record));

export const readProjectHistoryBinding = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  launchId: string,
): Promise<ProjectHistoryBinding | null> =>
  readOptional(projectHistoryBindingPath(paths, taskId, attempt, launchId), (input) =>
    ProjectHistoryBinding.parse(input),
  );

export const writeProjectHistoryBinding = (
  paths: HarnessPaths,
  binding: ProjectHistoryBinding,
): Promise<void> =>
  writeJsonOnce(
    projectHistoryBindingPath(
      paths,
      binding.task_id,
      binding.attempt,
      binding.launch_id,
    ),
    ProjectHistoryBinding.parse(binding),
  );

export const readCompletion = (
  paths: HarnessPaths,
  taskId: string,
): Promise<CompletionRecord | null> =>
  readOptional(completionPath(paths, taskId), (input) => CompletionRecord.parse(input));

export const readCloseManifest = (
  paths: HarnessPaths,
  taskId: string,
): Promise<CloseManifest | null> =>
  readOptional(closeManifestPath(paths, taskId), (input) => CloseManifest.parse(input));

export const writeCloseManifest = (
  paths: HarnessPaths,
  manifest: CloseManifest,
): Promise<void> =>
  writeJson(closeManifestPath(paths, manifest.task_id), CloseManifest.parse(manifest));

export const readMaintenanceRecord = (
  paths: HarnessPaths,
  adoptedHeadSha: string,
): Promise<MaintenanceRecord | null> =>
  readOptional(maintenanceRecordPath(paths, adoptedHeadSha), (input) =>
    MaintenanceRecord.parse(input),
  );

export const writeMaintenanceRecord = (
  paths: HarnessPaths,
  record: MaintenanceRecord,
): Promise<void> =>
  writeJson(maintenanceRecordPath(paths, record.adopted_head_sha), MaintenanceRecord.parse(record));

export const readPlannedWorkAdoption = (
  paths: HarnessPaths,
  adoptedHeadSha: string,
): Promise<PlannedWorkAdoptionRecord | null> =>
  readOptional(plannedWorkAdoptionPath(paths, adoptedHeadSha), (input) =>
    PlannedWorkAdoptionRecord.parse(input),
  );

/** Append-only: uma adoção publicada nunca é reescrita com outro conteúdo. */
export const writePlannedWorkAdoption = (
  paths: HarnessPaths,
  record: PlannedWorkAdoptionRecord,
): Promise<void> =>
  writeJsonOnce(
    plannedWorkAdoptionPath(paths, record.adopted_head_sha),
    PlannedWorkAdoptionRecord.parse(record),
  );

export async function listPlannedWorkAdoptionShas(
  paths: HarnessPaths,
): Promise<string[]> {
  try {
    return (await readdir(paths.plannedWorkAdoptionsDir))
      .filter((file) => file.endsWith('.json'))
      .map((file) => path.basename(file, '.json'))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export const readAttemptAbandonment = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<AttemptAbandonmentRecord | null> =>
  readOptional(attemptAbandonmentPath(paths, taskId, attempt), (input) =>
    AttemptAbandonmentRecord.parse(input),
  );

export const writeAttemptAbandonment = (
  paths: HarnessPaths,
  record: AttemptAbandonmentRecord,
): Promise<void> =>
  writeJson(
    attemptAbandonmentPath(paths, record.task_id, record.attempt),
    AttemptAbandonmentRecord.parse(record),
  );

export const readRecoveredFinalization = (
  paths: HarnessPaths,
  taskId: string,
  sourceAttempt: number,
): Promise<RecoveredFinalizationRecord | null> =>
  readOptional(recoveryRecordPath(paths, taskId, sourceAttempt), (input) =>
    RecoveredFinalizationRecord.parse(input),
  );

export const writeRecoveredFinalization = (
  paths: HarnessPaths,
  record: RecoveredFinalizationRecord,
): Promise<void> =>
  writeJson(
    recoveryRecordPath(paths, record.task_id, record.source_attempt),
    RecoveredFinalizationRecord.parse(record),
  );

export const readOrchestratedFinalization = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<OrchestratedFinalizationRecord | null> =>
  readOptional(orchestratedFinalizationPath(paths, taskId, attempt), (input) =>
    OrchestratedFinalizationRecord.parse(input),
  );

export const writeOrchestratedFinalization = (
  paths: HarnessPaths,
  record: OrchestratedFinalizationRecord,
): Promise<void> =>
  writeJson(
    orchestratedFinalizationPath(paths, record.task_id, record.attempt),
    OrchestratedFinalizationRecord.parse(record),
  );

export const readCandidateReview = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<CandidateReviewRecord | null> =>
  readOptional(candidateReviewPath(paths, taskId, attempt), (input) =>
    CandidateReviewRecord.parse(input),
  );

/** Append-only: um veredito publicado nunca é reescrito com outro conteúdo. */
export const writeCandidateReview = (
  paths: HarnessPaths,
  record: CandidateReviewRecord,
): Promise<void> =>
  writeJsonOnce(
    candidateReviewPath(paths, record.task_id, record.attempt),
    CandidateReviewRecord.parse(record),
  );

export const readReviewRejectionClassification = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<ReviewRejectionClassificationRecord | null> =>
  readOptional(reviewRejectionClassificationPath(paths, taskId, attempt), (input) =>
    ReviewRejectionClassificationRecord.parse(input),
  );

export const writeReviewRejectionClassification = (
  paths: HarnessPaths,
  record: ReviewRejectionClassificationRecord,
): Promise<void> =>
  writeJsonOnce(
    reviewRejectionClassificationPath(paths, record.task_id, record.attempt),
    ReviewRejectionClassificationRecord.parse(record),
  );

export const writeReviewParseFailure = async (
  paths: HarnessPaths,
  record: ReviewParseFailureRecord,
): Promise<string> => {
  const parsed = ReviewParseFailureRecord.parse(record);
  const file = unparseableReviewEvidencePath(
    paths,
    parsed.task_id,
    parsed.attempt,
    sha256Hex(parsed.stdout),
  );
  await writeJsonOnce(file, parsed);
  return file;
};

export const listAdditionalRepairAuthorizationFiles = async (
  paths: HarnessPaths,
  taskId: string,
): Promise<readonly string[]> => {
  try {
    return await readdir(additionalRepairTaskDir(paths, taskId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

export const readAdditionalRepairAuthorizationGrant = (
  paths: HarnessPaths,
  taskId: string,
  grantSha256: string,
): Promise<AdditionalRepairAuthorizationRecord | null> =>
  readOptional(additionalRepairGrantPath(paths, taskId, grantSha256), (input) =>
    AdditionalRepairAuthorizationRecord.parse(input),
  );

export const writeAdditionalRepairAuthorizationGrant = async (
  paths: HarnessPaths,
  record: AdditionalRepairAuthorizationRecord,
  grantSha256: string,
): Promise<string> => {
  const parsed = AdditionalRepairAuthorizationRecord.parse(record);
  const file = additionalRepairGrantPath(paths, parsed.task_id, grantSha256);
  await writeJsonOnce(file, parsed);
  return file;
};

export const writeAdditionalRepairAuthorizationConsumption = async (
  paths: HarnessPaths,
  record: AdditionalRepairAuthorizationConsumptionRecord,
): Promise<string> => {
  const parsed = AdditionalRepairAuthorizationConsumptionRecord.parse(record);
  const file = additionalRepairConsumptionPath(
    paths,
    parsed.task_id,
    parsed.grant_sha256,
    parsed.consumed_by_attempt,
  );
  await writeJsonOnce(file, parsed);
  return file;
};

export function providerExpansionGrantPath(paths: HarnessPaths, grantSha256: string): string {
  return path.join(paths.providerExpansionAuthorizationsDir, `grant-${grantSha256}.json`);
}

export const listProviderExpansionAuthorizationFiles = async (
  paths: HarnessPaths,
): Promise<readonly string[]> => {
  try {
    return await readdir(paths.providerExpansionAuthorizationsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

export const writeProviderExpansionAuthorizationGrant = async (
  paths: HarnessPaths,
  record: ProviderExpansionAuthorizationRecord,
  grantSha256: string,
): Promise<string> => {
  const parsed = ProviderExpansionAuthorizationRecord.parse(record);
  const file = providerExpansionGrantPath(paths, grantSha256);
  await writeJsonOnce(file, parsed);
  return file;
};


export const readRevalidationSourceBinding = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<RevalidationSourceBinding | null> =>
  readOptional(sourceBindingPath(paths, taskId, attempt), (input) =>
    RevalidationSourceBinding.parse(input),
  );

export const writeRevalidationSourceBinding = (
  paths: HarnessPaths,
  binding: RevalidationSourceBinding,
): Promise<void> =>
  writeJsonOnce(
    sourceBindingPath(paths, binding.task_id, binding.attempt),
    RevalidationSourceBinding.parse(binding),
  );

export const readOrchestratedRevalidation = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): Promise<OrchestratedRevalidationRecord | null> =>
  readOptional(revalidationRecordPath(paths, taskId, attempt, sequence), (input) =>
    OrchestratedRevalidationRecord.parse(input),
  );

export const writeOrchestratedRevalidation = (
  paths: HarnessPaths,
  record: OrchestratedRevalidationRecord,
): Promise<void> =>
  writeJsonOnce(
    revalidationRecordPath(paths, record.task_id, record.attempt, record.sequence),
    OrchestratedRevalidationRecord.parse(record),
  );

export const readRevalidationCheckpoint = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  sequence: number,
): Promise<RevalidationCheckpoint | null> =>
  readOptional(revalidationCheckpointPath(paths, taskId, attempt, sequence), (input) =>
    RevalidationCheckpoint.parse(input),
  );

export const writeRevalidationCheckpoint = (
  paths: HarnessPaths,
  checkpoint: RevalidationCheckpoint,
): Promise<void> =>
  writeJsonOnce(
    revalidationCheckpointPath(
      paths,
      checkpoint.task_id,
      checkpoint.attempt,
      checkpoint.sequence,
    ),
    RevalidationCheckpoint.parse(checkpoint),
  );

export const readValidationFailedAttempt = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<ValidationFailedAttemptRecord | null> =>
  readOptional(validationFailedAttemptPath(paths, taskId, attempt), (input) =>
    ValidationFailedAttemptRecord.parse(input),
  );

export const writeValidationFailedAttempt = (
  paths: HarnessPaths,
  record: ValidationFailedAttemptRecord,
): Promise<void> =>
  writeJsonOnce(
    validationFailedAttemptPath(paths, record.task_id, record.attempt),
    ValidationFailedAttemptRecord.parse(record),
  );

export const readReviewRejectedAttempt = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<ReviewRejectedAttemptRecord | null> =>
  readOptional(reviewRejectedAttemptPath(paths, taskId, attempt), (input) =>
    ReviewRejectedAttemptRecord.parse(input),
  );

export const writeReviewRejectedAttempt = (
  paths: HarnessPaths,
  record: ReviewRejectedAttemptRecord,
): Promise<void> =>
  writeJsonOnce(
    reviewRejectedAttemptPath(paths, record.task_id, record.attempt),
    ReviewRejectedAttemptRecord.parse(record),
  );

export const readInfraFailedAttempt = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<InfraFailedAttemptRecord | null> =>
  readOptional(infraFailedAttemptPath(paths, taskId, attempt), (input) =>
    InfraFailedAttemptRecord.parse(input),
  );

export const writeInfraFailedAttempt = (
  paths: HarnessPaths,
  record: InfraFailedAttemptRecord,
): Promise<void> =>
  writeJsonOnce(
    infraFailedAttemptPath(paths, record.task_id, record.attempt),
    InfraFailedAttemptRecord.parse(record),
  );

export const readProtocolInvalidAttempt = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<ProtocolInvalidAttemptRecord | null> =>
  readOptional(protocolInvalidAttemptPath(paths, taskId, attempt), (input) =>
    ProtocolInvalidAttemptRecord.parse(input),
  );

export const writeProtocolInvalidAttempt = (
  paths: HarnessPaths,
  record: ProtocolInvalidAttemptRecord,
): Promise<void> =>
  writeJsonOnce(
    protocolInvalidAttemptPath(paths, record.task_id, record.attempt),
    ProtocolInvalidAttemptRecord.parse(record),
  );

export const readPreservedBundleManifest = (
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<PreservedChangeBundleManifest | null> =>
  readOptional(preservedBundleManifestPath(paths, taskId, attempt), (input) =>
    PreservedChangeBundleManifest.parse(input),
  );

export const writePreservedBundleManifest = (
  paths: HarnessPaths,
  manifest: PreservedChangeBundleManifest,
): Promise<void> =>
  writeJsonOnce(
    preservedBundleManifestPath(paths, manifest.task_id, manifest.attempt),
    PreservedChangeBundleManifest.parse(manifest),
  );

export async function listOrchestratedRevalidations(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
): Promise<OrchestratedRevalidationRecord[]> {
  let names: string[];
  try {
    names = await readdir(revalidationAttemptDir(paths, taskId, attempt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const sequences = names
    .map((name) => /^revalidation-(\d+)\.json$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => left - right);
  return Promise.all(
    sequences.map(async (sequence) => {
      const record = await readOrchestratedRevalidation(paths, taskId, attempt, sequence);
      if (!record) throw new Error(`revalidation-${sequence}.json desapareceu durante leitura`);
      return record;
    }),
  );
}
