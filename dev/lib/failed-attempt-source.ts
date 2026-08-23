import { readFile } from 'node:fs/promises';
import { writeFileOnce } from './atomic.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { headSha, patchFingerprint, stagedFiles, workingTreeFiles } from './git.js';
import type { HarnessPaths } from './paths.js';
import {
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
  type FailedAttemptSourceProvenance,
  type RevalidationSourceBinding as RevalidationSourceBindingType,
  type ValidationCommand,
  type ValidationResult,
} from './schemas.js';

/**
 * A FONTE de um attempt reprovado pela validation oficial: quais bytes de
 * patch, de report e de evidence foram medidos e reprovados.
 *
 * Por que um helper único, e por que ele mora fora de `revalidate.ts`:
 *
 * `RevalidationSourceBinding` nasceu dentro da revalidation auditada, mas
 * nenhum campo dele é sobre revalidar — são `task_id`, `attempt`,
 * `source_base_sha`, os hashes de completion/report/handoff, os
 * `changed_files` e o fingerprint do patch. Isso é o snapshot da solução
 * rejeitada, e é exatamente o mesmo artifact que `dev-retry-failed` precisa
 * para arquivar um FAIL legítimo. Duplicar a derivação em uma abstração
 * paralela criaria duas verdades sobre os mesmos bytes; renomear o record
 * quebraria os records históricos já gravados. Então o record continua com o
 * nome que tem, e o que passa a ser compartilhado é a DERIVAÇÃO.
 *
 * O binding também deixa de ser um passo manual. Um FAIL oficial já nasce
 * selado (`derived_at_official_validation_failure`), porque um FAIL que não
 * pode ser nem revalidado nem reparado é um beco sem saída auditável — foi
 * assim que o M39B ficou preso.
 *
 * Fail-closed: toda precondição é conferida ANTES de qualquer escrita.
 * Idempotente: republicar com os mesmos fatos é aceito; com fatos diferentes é
 * recusado. Append-only: nada aqui sobrescreve evidência já publicada.
 */
export class FailedAttemptSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FailedAttemptSourceError';
  }
}

export interface DeriveFailedAttemptSourceInput {
  readonly paths: HarnessPaths;
  readonly taskId: string;
  readonly attempt: number;
  /**
   * Bytes do CompletionRecord FAIL. Vêm do slot corrente quando ele já existe,
   * e do record recém-construído quando o finalization ainda não o gravou — o
   * hash publicado tem que ser o dos bytes que vão de fato para o disco.
   */
  readonly completionBytes: Buffer;
  /** `base_sha` da task no state. O binding recusa qualquer divergência. */
  readonly stateBaseSha: string;
  /**
   * Commit contra o qual o fingerprint pode ser observado.
   *
   * Não é sempre `source_base_sha`, e a diferença é o ponto: no instante do
   * FAIL o HEAD ainda É a base do attempt, e exigir isso é o que torna o
   * fingerprint contemporâneo. Depois, uma manutenção adotada pode ter movido
   * o authorized head sem tocar no patch rejeitado — e aí a observação
   * honesta é contra o head atual, que é o que a working tree de fato tem como
   * referência. Quem chama declara qual dos dois vale; o helper nunca aceita
   * "qualquer HEAD".
   */
  readonly expectedHeadSha: string;
  readonly provenance: FailedAttemptSourceProvenance;
  readonly now?: () => string;
}

export interface DerivedFailedAttemptSource {
  readonly binding: RevalidationSourceBindingType;
  readonly files: readonly string[];
  readonly patchFingerprint: string;
  readonly reportBytes: Buffer | null;
  readonly handoffBytes: Buffer | null;
}

export interface PublishedFailedAttemptSource extends DerivedFailedAttemptSource {
  readonly bindingPath: string;
  readonly originalCompletionPath: string;
  readonly alreadyBound: boolean;
}

/** Nota do worker: ausente é UNKNOWN, nunca fonte impossível de derivar. */
async function readOptional(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Nota malformada vira `null`, do mesmo jeito que nota ausente. */
function tryParse<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

async function readRequired(file: string, label: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FailedAttemptSourceError(`${label} ausente`);
    }
    throw error;
  }
}

function parseJson<T>(label: string, bytes: Buffer, parse: (input: unknown) => T): T {
  try {
    return parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new FailedAttemptSourceError(
      `${label} inválido: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Dois bindings descrevem a MESMA fonte quando todos os fatos observados
 * coincidem. `fingerprint_observed_at` e `fingerprint_provenance` dizem quando
 * e por qual caminho a observação aconteceu — um FAIL selado no finalization e
 * depois reconferido no preflight de uma revalidation é o mesmo patch, e
 * recusá-lo por causa do carimbo transformaria replay legítimo em erro.
 */
function sameObservedFacts(
  left: RevalidationSourceBindingType,
  right: RevalidationSourceBindingType,
): boolean {
  const facts = (binding: RevalidationSourceBindingType) => ({
    ...binding,
    fingerprint_observed_at: '',
    fingerprint_provenance: '',
  });
  return canonicalJson(facts(left)) === canonicalJson(facts(right));
}

/**
 * Um FAIL só é fonte de reparo/revalidation quando a validation OFICIAL do
 * packet foi de fato executada e reprovou. Os resultados registrados têm que
 * começar pelos comandos do packet, na ordem, e podem trazer depois as
 * conferências que o próprio orquestrador acrescenta ao gate (hoje o
 * `git diff --check`) — recusar esse sufixo mandaria o FAIL de diff-check para
 * o mesmo beco sem saída que esta correção existe para fechar.
 */
function assertOfficialValidationFailed(
  results: readonly ValidationResult[],
  commands: readonly ValidationCommand[],
): void {
  if (results.length < commands.length) {
    throw new FailedAttemptSourceError('validation oficial não corresponde ao TaskPacket');
  }
  for (let index = 0; index < commands.length; index += 1) {
    if (canonicalJson(results[index]?.argv) !== canonicalJson(commands[index]?.argv)) {
      throw new FailedAttemptSourceError('validation oficial diverge do TaskPacket');
    }
  }
  if (!results.some((result) => result.exit_code !== 0 || result.timed_out)) {
    throw new FailedAttemptSourceError('FAIL sem validation oficial malsucedida');
  }
}

/**
 * Deriva o binding a partir de evidência objetiva já existente: nada aqui vem
 * de parâmetro narrativo, e nenhum valor é aceito sem ser conferido contra os
 * bytes em disco.
 */
export async function deriveFailedAttemptSource(
  input: DeriveFailedAttemptSourceInput,
): Promise<DerivedFailedAttemptSource> {
  const { paths, taskId, attempt } = input;
  if (attempt < 1) throw new FailedAttemptSourceError('FAIL sem attempt');

  const completion = parseJson('CompletionRecord', input.completionBytes, (value) =>
    CompletionRecord.parse(value),
  );
  if (completion.task_id !== taskId) {
    throw new FailedAttemptSourceError(`CompletionRecord pertence a ${completion.task_id}`);
  }
  if (completion.status !== 'FAIL') {
    throw new FailedAttemptSourceError('CompletionRecord não é FAIL');
  }
  if (completion.finalization_mode !== 'normal') {
    throw new FailedAttemptSourceError('CompletionRecord.finalization_mode deve ser normal');
  }
  const evidence = completion.orchestrator_evidence;
  if (evidence.candidate_commit !== null || evidence.accepted_commit !== null) {
    throw new FailedAttemptSourceError('orchestrator evidence candidate/accepted deve ser null');
  }

  const packet = await readPacket(paths, taskId);
  if (!packet) throw new FailedAttemptSourceError('TaskPacket ausente');
  // A NOTA do worker entra no binding por hash quando existe. Ela NÃO é
  // pré-condição: um FAIL oficial sobre material real precisa ficar reparável
  // mesmo que o worker não tenha escrito a nota, ou a tenha escrito fora do
  // contrato. O que qualifica a fonte é objetivo — houve patch entregue e o
  // gate oficial reprovou.
  const reportBytes = await readOptional(reportPath(paths, taskId));
  const handoffBytes = await readOptional(handoffDraftPath(paths, taskId));
  const report =
    reportBytes === null
      ? null
      : tryParse(() => AgentCompletionReport.parse(JSON.parse(reportBytes.toString('utf8'))));
  const handoff =
    handoffBytes === null
      ? null
      : tryParse(() => parseHandoffDraft(JSON.parse(handoffBytes.toString('utf8'))));

  if (packet.task_id !== taskId) {
    throw new FailedAttemptSourceError('evidence pertence a outra tarefa');
  }
  // Worker FAILURE tem caminho próprio (dev-retry): reusar este apagaria a
  // única distinção que importa — a de que a solução foi entregue e REPROVADA.
  // Nota AUSENTE não é FAILURE declarado e não sai por aqui.
  if (report !== null && report.self_reported_result !== 'SUCCESS') {
    throw new FailedAttemptSourceError('fonte de FAIL oficial exige worker report SUCCESS');
  }
  if (evidence.base_sha !== packet.base_sha || evidence.base_sha !== input.stateBaseSha) {
    throw new FailedAttemptSourceError('base_sha diverge entre completion, packet e state');
  }
  assertOfficialValidationFailed(evidence.revalidation, packet.validation);

  // AUTORIDADE: o material preservado é o que o orquestrador derivou do Git no
  // fechamento, não o que o worker declarou.
  const files = [...new Set(evidence.changed_files)].sort();
  if (files.length === 0) {
    throw new FailedAttemptSourceError('orchestrator evidence sem changed_files');
  }
  const forbidden = files.find(isForbiddenRevalidationPath);
  if (forbidden) throw new FailedAttemptSourceError(`caminho proibido: ${forbidden}`);

  // O HandoffDraft entra no binding só por hash, então sem uma conferência ele
  // seria o único artifact substituível sem deixar rastro. Isto NÃO é a nota
  // vetando o candidate: é integridade de evidência já selada — quando o
  // CompletionRecord registrou que o draft batia com o material real, o draft
  // em disco ainda tem que bater. Fail-closed permanece.
  if (
    handoff !== null &&
    completion.report_matches_evidence &&
    canonicalJson([...new Set(handoff.changed_files)].sort()) !== canonicalJson(files)
  ) {
    throw new FailedAttemptSourceError('HandoffDraft diverge do que o FAIL registrou');
  }

  // O fingerprint é relativo ao HEAD: derivá-lo contra um commit que o chamador
  // não declarou descreveria um patch que ninguém mediu.
  const head = await headSha(paths.repoRoot);
  if (head !== input.expectedHeadSha) {
    throw new FailedAttemptSourceError(
      `HEAD ${head} diverge do commit esperado ${input.expectedHeadSha}`,
    );
  }
  if ((await stagedFiles(paths.repoRoot)).length > 0) {
    throw new FailedAttemptSourceError('index contém mudanças staged');
  }
  const actual = await workingTreeFiles(paths.repoRoot);
  if (canonicalJson(actual) !== canonicalJson(files)) {
    throw new FailedAttemptSourceError(
      `working tree diverge do material preservado: real [${actual.join(', ')}], ` +
        `preservado [${files.join(', ')}]`,
    );
  }
  const fingerprint = await patchFingerprint(paths.repoRoot);

  return {
    binding: RevalidationSourceBinding.parse({
      schema_version: DEV_SCHEMA_VERSION,
      task_id: taskId,
      attempt,
      source_base_sha: evidence.base_sha,
      original_completion_path: 'original-completion.fail.json',
      original_completion_sha256: sha256Hex(input.completionBytes),
      ...(reportBytes === null ? {} : { report_sha256: sha256Hex(reportBytes) }),
      ...(handoffBytes === null ? {} : { handoff_draft_sha256: sha256Hex(handoffBytes) }),
      changed_files: files,
      derived_patch_fingerprint: fingerprint,
      fingerprint_observed_at: (input.now ?? (() => new Date().toISOString()))(),
      fingerprint_provenance: input.provenance,
    }),
    files,
    patchFingerprint: fingerprint,
    reportBytes,
    handoffBytes,
  };
}

/**
 * Publica a fonte, nesta ordem e sem estado intermediário irrecuperável:
 *
 * 1. os bytes exatos do CompletionRecord FAIL, append-only;
 * 2. o binding, que aponta para eles por hash.
 *
 * O archive vem primeiro porque o binding só é conferível contra bytes que já
 * existem. Um crash entre os dois deixa o archive publicado e o binding
 * ausente — a retomada republica os mesmos bytes (aceito) e completa o
 * binding, sem duplicar nem divergir.
 */
export async function publishFailedAttemptSource(
  paths: HarnessPaths,
  derived: DerivedFailedAttemptSource,
  completionBytes: Buffer,
): Promise<PublishedFailedAttemptSource> {
  const { binding } = derived;
  if (sha256Hex(completionBytes) !== binding.original_completion_sha256) {
    throw new FailedAttemptSourceError('bytes do CompletionRecord divergem do binding derivado');
  }
  const archiveFile = originalCompletionEvidencePath(paths, binding.task_id, binding.attempt);
  try {
    await writeFileOnce(archiveFile, completionBytes);
  } catch (error) {
    throw new FailedAttemptSourceError(
      `archive do CompletionRecord FAIL diverge do já selado: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const existing = await readRevalidationSourceBinding(paths, binding.task_id, binding.attempt);
  if (existing) {
    if (!sameObservedFacts(existing, binding)) {
      throw new FailedAttemptSourceError('RevalidationSourceBinding já selado diverge do observado');
    }
    return {
      ...derived,
      binding: existing,
      bindingPath: sourceBindingPath(paths, binding.task_id, binding.attempt),
      originalCompletionPath: archiveFile,
      alreadyBound: true,
    };
  }
  await writeRevalidationSourceBinding(paths, binding);
  return {
    ...derived,
    bindingPath: sourceBindingPath(paths, binding.task_id, binding.attempt),
    originalCompletionPath: archiveFile,
    alreadyBound: false,
  };
}

/** Deriva e publica em um passo — o que os três produtores de FAIL chamam. */
export async function materializeFailedAttemptSource(
  input: DeriveFailedAttemptSourceInput,
): Promise<PublishedFailedAttemptSource> {
  const derived = await deriveFailedAttemptSource(input);
  return publishFailedAttemptSource(input.paths, derived, input.completionBytes);
}
