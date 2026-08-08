import { readFile } from 'node:fs/promises';
import { writeFileOnce } from './atomic.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { patchFingerprint, stagedFiles, workingTreeFiles } from './git.js';
import type { HarnessPaths } from './paths.js';
import {
  completionPath,
  handoffDraftPath,
  originalCompletionEvidencePath,
  readPacket,
  readRevalidationSourceBinding,
  reportPath,
  sourceBindingPath,
  writeRevalidationSourceBinding,
} from './records.js';
import { isForbiddenRevalidationPath } from './revalidate.js';
import {
  AgentCompletionReport,
  CompletionRecord,
  DEV_SCHEMA_VERSION,
  RevalidationSourceBinding,
  parseHandoffDraft,
  type RevalidationSourceBinding as RevalidationSourceBindingType,
} from './schemas.js';
import { getTaskState, readState } from './state.js';

export class RevalidationBindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevalidationBindError';
  }
}

export interface BindRevalidationSourceInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly now?: () => string;
}

export interface BindRevalidationSourceResult {
  readonly binding: RevalidationSourceBindingType;
  readonly bindingPath: string;
  readonly originalCompletionPath: string;
  readonly alreadyBound: boolean;
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RevalidationBindError(`${label} ausente`);
    }
    throw error;
  }
}

function parseJson<T>(label: string, bytes: Buffer, parse: (input: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new RevalidationBindError(
      `${label} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * O binding é o que dá continuidade auditável a um FAIL: ele prova, a partir
 * deste instante, quais bytes de patch e de evidence a revalidation vai
 * reexecutar. Não afirma que o fingerprint existia no instante histórico do
 * FAIL — daí `derived_during_revalidation_preflight`.
 *
 * Selar não é revalidar: aqui nenhuma validation roda, o state não muda, o HEAD
 * não muda e nenhum provider é chamado. Só evidência é publicada, write-once.
 */
export async function bindRevalidationSource(
  input: BindRevalidationSourceInput,
): Promise<BindRevalidationSourceResult> {
  const { paths, taskId } = input;
  const state = await readState(paths);
  const task = getTaskState(state, taskId);
  if (task.status !== 'FAIL') {
    throw new RevalidationBindError(`bind exige tarefa FAIL, encontrada ${task.status}`);
  }
  if (task.attempts < 1) throw new RevalidationBindError('FAIL sem attempt');
  if (task.candidate_commit !== null || task.accepted_commit !== null) {
    throw new RevalidationBindError('FAIL não pode ter candidate/accepted commit no state');
  }
  const attempt = task.attempts;

  const packet = await readPacket(paths, taskId);
  if (!packet) throw new RevalidationBindError('TaskPacket ausente');

  const completionFile = completionPath(paths, taskId);
  const [completionBytes, reportBytes, handoffBytes] = await Promise.all([
    readRequired(completionFile, 'CompletionRecord'),
    readRequired(reportPath(paths, taskId), 'AgentCompletionReport'),
    readRequired(handoffDraftPath(paths, taskId), 'HandoffDraft'),
  ]);
  const completion = parseJson('CompletionRecord', completionBytes, (value) =>
    CompletionRecord.parse(value),
  );
  const report = parseJson('AgentCompletionReport', reportBytes, (value) =>
    AgentCompletionReport.parse(value),
  );
  const handoff = parseJson('HandoffDraft', handoffBytes, parseHandoffDraft);

  if (completion.status !== 'FAIL') {
    throw new RevalidationBindError('CompletionRecord não é FAIL');
  }
  if (completion.finalization_mode !== 'normal') {
    throw new RevalidationBindError('bind exige finalization_mode normal');
  }
  if (report.self_reported_result !== 'SUCCESS') {
    throw new RevalidationBindError('bind exige worker report SUCCESS');
  }
  if (report.candidate_commit !== null) {
    throw new RevalidationBindError('report.candidate_commit deve ser null');
  }
  const evidence = completion.orchestrator_evidence;
  if (evidence.candidate_commit !== null || evidence.accepted_commit !== null) {
    throw new RevalidationBindError('orchestrator evidence candidate/accepted deve ser null');
  }
  if (
    completion.report === null ||
    canonicalJson(completion.report) !== canonicalJson(report)
  ) {
    throw new RevalidationBindError('report atual diverge do report preservado no FAIL');
  }
  if (report.task_id !== taskId || handoff.task_id !== taskId || packet.task_id !== taskId) {
    throw new RevalidationBindError('evidence pertence a outra tarefa');
  }
  if (evidence.base_sha !== packet.base_sha || evidence.base_sha !== task.base_sha) {
    throw new RevalidationBindError('base_sha diverge entre completion, packet e state');
  }

  // O FAIL precisa ter vindo do gate oficial, não de outra coisa: a validation
  // registrada tem que ser exatamente a do packet e conter ao menos uma falha.
  const official = evidence.revalidation;
  if (official.length !== packet.validation.length) {
    throw new RevalidationBindError('validation oficial não corresponde ao TaskPacket');
  }
  for (let index = 0; index < official.length; index += 1) {
    if (canonicalJson(official[index]?.argv) !== canonicalJson(packet.validation[index]?.argv)) {
      throw new RevalidationBindError('validation oficial diverge do TaskPacket');
    }
  }
  if (!official.some((result) => result.exit_code !== 0 || result.timed_out)) {
    throw new RevalidationBindError('bind exige validation oficial malsucedida');
  }

  const files = [...new Set(report.changed_files)].sort();
  if (files.length === 0) throw new RevalidationBindError('report.changed_files vazio');
  if (canonicalJson(files) !== canonicalJson([...new Set(evidence.changed_files)].sort())) {
    throw new RevalidationBindError('changed_files diverge entre report e orchestrator evidence');
  }
  const forbidden = files.find(isForbiddenRevalidationPath);
  if (forbidden) throw new RevalidationBindError(`caminho proibido: ${forbidden}`);

  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new RevalidationBindError('index contém mudanças staged');
  }
  const actual = await workingTreeFiles(paths.repoRoot);
  if (canonicalJson(actual) !== canonicalJson(files)) {
    throw new RevalidationBindError(
      `working tree diverge do report: real [${actual.join(', ')}], report [${files.join(', ')}]`,
    );
  }

  const binding = RevalidationSourceBinding.parse({
    schema_version: DEV_SCHEMA_VERSION,
    task_id: taskId,
    attempt,
    source_base_sha: evidence.base_sha,
    original_completion_path: 'original-completion.fail.json',
    original_completion_sha256: sha256Hex(completionBytes),
    report_sha256: sha256Hex(reportBytes),
    handoff_draft_sha256: sha256Hex(handoffBytes),
    changed_files: files,
    derived_patch_fingerprint: await patchFingerprint(paths.repoRoot),
    fingerprint_observed_at: (input.now ?? (() => new Date().toISOString()))(),
    fingerprint_provenance: 'derived_during_revalidation_preflight',
  });

  // Os bytes exatos do FAIL vêm antes do binding: o binding aponta para eles
  // por hash, e um archive publicado depois nunca poderia ser conferido.
  const archiveFile = originalCompletionEvidencePath(paths, taskId, attempt);
  try {
    await writeFileOnce(archiveFile, completionBytes);
  } catch (error) {
    throw new RevalidationBindError(
      `archive do CompletionRecord FAIL diverge do já selado: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const existing = await readRevalidationSourceBinding(paths, taskId, attempt);
  if (existing) {
    // Replay legítimo: o instante da observação muda, os fatos observados não.
    if (
      canonicalJson({ ...existing, fingerprint_observed_at: '' }) !==
      canonicalJson({ ...binding, fingerprint_observed_at: '' })
    ) {
      throw new RevalidationBindError('RevalidationSourceBinding já selado diverge do observado');
    }
    return {
      binding: existing,
      bindingPath: sourceBindingPath(paths, taskId, attempt),
      originalCompletionPath: archiveFile,
      alreadyBound: true,
    };
  }
  await writeRevalidationSourceBinding(paths, binding);
  return {
    binding,
    bindingPath: sourceBindingPath(paths, taskId, attempt),
    originalCompletionPath: archiveFile,
    alreadyBound: false,
  };
}
