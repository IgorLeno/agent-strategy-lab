import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFileOnce } from './atomic.js';
import { sha256Hex } from './canonical.js';
import type { HarnessPaths } from './paths.js';
import {
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  handoffDraftPath,
  readValidationFailedAttempt,
  reportPath,
} from './records.js';

/**
 * Isolamento por attempt do output do worker.
 *
 * O worker escreve em caminhos ESTÁVEIS por tarefa (`.dev-inbox/<task>/report.json`
 * e `handoff-draft.json`), e o attempt seguinte recebe os mesmos caminhos. Sem
 * uma cópia durável por attempt, o output do attempt N continua no slot corrente
 * depois que ele é arquivado — e passa a ser indistinguível do output do attempt
 * N+1. Foi exatamente esse o incidente: um par report/handoff de um attempt
 * reprovado pela validation bloqueou a recuperação de um attempt seguinte que
 * morreu por falha de infraestrutura, porque o harness não sabia de quem era.
 *
 * A regra deste módulo: os bytes são preservados no diretório do attempt DONO
 * antes de o slot corrente ser liberado, e a única autoridade sobre a posse é
 * criptográfica — os hashes declarados no record daquele attempt. Timestamp,
 * `changed_files` e semelhança textual não provam nada e não são consultados.
 */
export class InboxArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxArtifactError';
  }
}

export interface InboxArtifactPair {
  readonly report: Buffer;
  readonly handoff: Buffer;
}

export interface CurrentInboxArtifacts {
  readonly report: Buffer | null;
  readonly handoff: Buffer | null;
}

/** Hashes que o record do attempt dono declara para o par. */
export interface InboxArtifactHashes {
  readonly reportSha256: string;
  readonly handoffDraftSha256: string;
}

export interface ArchivedInboxArtifacts {
  readonly reportPath: string;
  readonly handoffPath: string;
  readonly bytes: InboxArtifactPair;
}

async function readIfPresent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readCurrentInboxArtifacts(
  paths: HarnessPaths,
  taskId: string,
): Promise<CurrentInboxArtifacts> {
  const [report, handoff] = await Promise.all([
    readIfPresent(reportPath(paths, taskId)),
    readIfPresent(handoffDraftPath(paths, taskId)),
  ]);
  return { report, handoff };
}

function assertHashes(bytes: InboxArtifactPair, expected: InboxArtifactHashes, label: string): void {
  if (sha256Hex(bytes.report) !== expected.reportSha256) {
    throw new InboxArtifactError(`${label}: report.json diverge de report_sha256 do attempt`);
  }
  if (sha256Hex(bytes.handoff) !== expected.handoffDraftSha256) {
    throw new InboxArtifactError(
      `${label}: handoff-draft.json diverge de handoff_draft_sha256 do attempt`,
    );
  }
}

/**
 * Publica os bytes do par dentro do attempt dono. Append-only: republicar com
 * bytes idênticos é aceito, com bytes diferentes é recusado.
 *
 * Os hashes são conferidos DUAS vezes — antes de escrever, contra os bytes
 * recebidos, e depois de escrever, contra o que ficou no disco. A segunda
 * conferência é o que autoriza liberar o slot corrente: até ela passar, a única
 * cópia viva daquela evidência ainda é o inbox.
 */
export async function archiveInboxArtifacts(input: {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly attempt: number;
  readonly bytes: InboxArtifactPair;
  readonly expected: InboxArtifactHashes;
}): Promise<ArchivedInboxArtifacts> {
  const { paths, taskId, attempt } = input;
  assertHashes(input.bytes, input.expected, 'archive do output do worker');

  const reportFile = failedAttemptReportPath(paths, taskId, attempt);
  const handoffFile = failedAttemptHandoffDraftPath(paths, taskId, attempt);
  for (const [file, bytes] of [
    [reportFile, input.bytes.report],
    [handoffFile, input.bytes.handoff],
  ] as const) {
    try {
      await writeFileOnce(file, bytes);
    } catch (error) {
      throw new InboxArtifactError(
        `archive do output do worker diverge do já publicado: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const published = await readArchivedInboxArtifacts(paths, taskId, attempt, input.expected);
  if (published === null) {
    throw new InboxArtifactError('archive do output do worker sumiu logo após ser publicado');
  }
  return { reportPath: reportFile, handoffPath: handoffFile, bytes: published };
}

/**
 * Bytes já preservados do attempt, conferidos contra os hashes declarados.
 * `null` quando nenhum dos dois existe; um par incompleto é FAIL CLOSED.
 */
export async function readArchivedInboxArtifacts(
  paths: HarnessPaths,
  taskId: string,
  attempt: number,
  expected: InboxArtifactHashes,
): Promise<InboxArtifactPair | null> {
  const [report, handoff] = await Promise.all([
    readIfPresent(failedAttemptReportPath(paths, taskId, attempt)),
    readIfPresent(failedAttemptHandoffDraftPath(paths, taskId, attempt)),
  ]);
  if (report === null && handoff === null) return null;
  if (report === null || handoff === null) {
    throw new InboxArtifactError(
      `archive do output do worker incompleto no attempt ${attempt}: ${
        report === null ? 'report.json' : 'handoff-draft.json'
      } ausente`,
    );
  }
  const pair = { report, handoff };
  assertHashes(pair, expected, `archive do attempt ${attempt}`);
  return pair;
}

/**
 * Libera os slots correntes do inbox para o PRÓXIMO attempt. Só pode ser
 * chamado depois que o archive do attempt dono existe e foi conferido.
 */
export async function releaseCurrentInboxArtifacts(
  paths: HarnessPaths,
  taskId: string,
): Promise<{ readonly report: boolean; readonly handoff: boolean }> {
  const current = await readCurrentInboxArtifacts(paths, taskId);
  await rm(reportPath(paths, taskId), { force: true });
  await rm(handoffDraftPath(paths, taskId), { force: true });
  return { report: current.report !== null, handoff: current.handoff !== null };
}

/** Attempts com diretório em `.dev/failed-attempts/<task>`, do maior ao menor. */
async function archivedAttempts(paths: HarnessPaths, taskId: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(path.join(paths.failedAttemptsDir, taskId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .map((name) => /^attempt-(\d+)$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((left, right) => right - left);
}

export interface StaleInboxOwner {
  readonly attempt: number;
  readonly hashes: InboxArtifactHashes;
}

/**
 * Attempt a que um par de artifacts do inbox comprovadamente pertence.
 *
 * Autoridade única: os dois hashes do `ValidationFailedAttemptRecord` daquele
 * attempt. Os DOIS precisam bater com o MESMO record — meio par correspondente
 * é ambiguidade, e ambiguidade é recusa. `maxAttempt` limita a busca aos
 * attempts ANTERIORES ao corrente quando o chamador precisa dessa distinção.
 */
export type InboxLaunchDisposition = 'clean' | 'released_preserved_artifacts';

/**
 * Guarda de PROVENIÊNCIA antes de um novo attempt escrever no inbox.
 *
 * O worker recebe os mesmos caminhos a cada attempt, então começar um launch
 * sobre artifacts de outro attempt é o próprio defeito: o output novo ocuparia
 * o lugar do antigo sem que nada registrasse a troca. Três desfechos, todos
 * fail-closed por default:
 *
 * - inbox limpo: segue o fluxo normal;
 * - par comprovadamente de um attempt anterior E já preservado byte a byte no
 *   diretório dele: os slots são liberados, porque a evidência já está segura;
 * - qualquer outra coisa: RECUSA. Sem prova completa, apagar seria destruir
 *   evidência e sobrescrever seria falsificá-la.
 */
export async function releaseInboxForLaunch(
  paths: HarnessPaths,
  taskId: string,
): Promise<InboxLaunchDisposition> {
  const current = await readCurrentInboxArtifacts(paths, taskId);
  if (current.report === null && current.handoff === null) return 'clean';
  if (current.report === null || current.handoff === null) {
    throw new InboxArtifactError(
      `inbox de ${taskId} tem apenas ${current.report === null ? 'handoff-draft.json' : 'report.json'}` +
        ' — meio par não prova proveniência e o launch é recusado',
    );
  }

  const bytes = { report: current.report, handoff: current.handoff };
  const owner = await findStaleInboxOwner(paths, taskId, bytes);
  if (owner === null) {
    throw new InboxArtifactError(
      `inbox de ${taskId} contém output de worker sem attempt dono comprovado — launch recusado`,
    );
  }
  const preserved = await readArchivedInboxArtifacts(paths, taskId, owner.attempt, owner.hashes);
  if (preserved === null) {
    throw new InboxArtifactError(
      `inbox de ${taskId} pertence ao attempt ${owner.attempt}, ainda não preservado no archive` +
        ' dele — launch recusado',
    );
  }
  await releaseCurrentInboxArtifacts(paths, taskId);
  return 'released_preserved_artifacts';
}

export async function findStaleInboxOwner(
  paths: HarnessPaths,
  taskId: string,
  bytes: InboxArtifactPair,
  maxAttempt?: number,
): Promise<StaleInboxOwner | null> {
  const reportSha256 = sha256Hex(bytes.report);
  const handoffDraftSha256 = sha256Hex(bytes.handoff);
  for (const attempt of await archivedAttempts(paths, taskId)) {
    if (maxAttempt !== undefined && attempt > maxAttempt) continue;
    const record = await readValidationFailedAttempt(paths, taskId, attempt);
    if (!record) continue;
    if (record.report_sha256 !== reportSha256) continue;
    if (record.handoff_draft_sha256 !== handoffDraftSha256) continue;
    return { attempt, hashes: { reportSha256, handoffDraftSha256 } };
  }
  return null;
}
