/**
 * Persistência de evidência de PLANEJAMENTO no runtime da run.
 *
 * Existe por uma falha concreta: uma run real morreu em
 * `SCHEMA_NORMALIZATION` e o runtime apontado como evidência não continha
 * nem o draft rejeitado nem as issues — não havia como saber o que o planner
 * tinha devolvido. Aqui o dono do filesystem é o RUNTIME: o pipeline puro de
 * `src/planner` só emite `PlanningAttemptRecord` e nunca conhece um caminho.
 *
 * Layout, uma pasta por tentativa OBSERVADA no runtime:
 *
 *   planning/attempt-01/invocation-metadata.json
 *   planning/attempt-01/result.json
 *   planning/attempt-01/draft.json          (só quando houve draft)
 *   planning/attempt-01/validation.json     (só quando houve validação)
 *   planning/attempt-02/revision-request.json
 *   ...
 *
 * APPEND-ONLY de verdade: a pasta da tentativa é reivindicada com um `mkdir`
 * não recursivo — que é atômico e falha com EEXIST — então uma tentativa
 * posterior (inclusive de uma re-execução no mesmo runtime) nunca sobrescreve
 * a evidência de uma anterior; ela ganha o próximo índice livre. Os arquivos
 * dentro da pasta usam `writeJsonOnce`, a mesma convenção append-only dos
 * demais artifacts do harness.
 *
 * O que NÃO é persistido: credencial, token, chave de API, ambiente de
 * processo e qualquer interno de provider. Só o contrato estruturado de
 * entrada/saída do planner e o veredito determinístico.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { writeJsonOnce } from './atomic.js';
import type {
  PlanningAttemptObserver,
  PlanningAttemptRecord,
} from '../../src/planner/generate.js';

export const PLANNING_EVIDENCE_DIR_NAME = 'planning';
export const PLANNING_INVOCATION_METADATA_FILE = 'invocation-metadata.json';
export const PLANNING_REVISION_REQUEST_FILE = 'revision-request.json';
export const PLANNING_RESULT_FILE = 'result.json';
export const PLANNING_DRAFT_FILE = 'draft.json';
export const PLANNING_VALIDATION_FILE = 'validation.json';

/** Teto defensivo de índices: um runtime não acumula tentativas sem fim. */
const MAX_ATTEMPT_SLOTS = 999;

export interface PersistedPlanningAttempt {
  /** Índice da pasta no runtime, monotônico e append-only. */
  readonly sequence: number;
  readonly directory: string;
  readonly attempt: 1 | 2;
  readonly kind: PlanningAttemptRecord['kind'];
  readonly invocation_outcome: PlanningAttemptRecord['invocation']['outcome'];
  readonly validation_outcome: 'AUTHORIZED' | 'REJECTED' | null;
  readonly rejected_stage: string | null;
  /** Arquivos efetivamente escritos, em caminho absoluto. */
  readonly files: readonly string[];
}

export interface PlanningEvidenceSink {
  /** Raiz `<runtime>/project/planning`. */
  readonly directory: string;
  readonly observer: PlanningAttemptObserver;
  /** Tentativas já persistidas, na ordem em que aconteceram. */
  attempts(): readonly PersistedPlanningAttempt[];
}

/** Reivindica atomicamente a próxima pasta livre; nunca reusa uma existente. */
async function claimAttemptDirectory(root: string): Promise<{ sequence: number; directory: string }> {
  await mkdir(root, { recursive: true });
  for (let sequence = 1; sequence <= MAX_ATTEMPT_SLOTS; sequence += 1) {
    const directory = path.join(root, `attempt-${String(sequence).padStart(2, '0')}`);
    try {
      await mkdir(directory);
      return { sequence, directory };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error(
    `evidência de planejamento excedeu ${MAX_ATTEMPT_SLOTS} tentativas em ${root}; nada foi sobrescrito`,
  );
}

/**
 * O draft é UNTRUSTED: ele pode não ser serializável. Preservar o fato de que
 * não deu para serializá-lo é evidência melhor do que gravar um arquivo
 * inválido em silêncio.
 */
function draftBytes(draft: unknown): { readonly serializable: true } | { readonly serializable: false; readonly reason: string } {
  try {
    const encoded = JSON.stringify(draft, null, 2);
    return encoded === undefined
      ? { serializable: false, reason: 'draft não é serializável em JSON (undefined)' }
      : { serializable: true };
  } catch (error) {
    return {
      serializable: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Cria o sink de evidência para um runtime. Construí-lo não escreve nada: só
 * uma tentativa REAL do planning worker cria pasta.
 */
export function createPlanningEvidenceSink(root: string): PlanningEvidenceSink {
  const persisted: PersistedPlanningAttempt[] = [];

  const observer: PlanningAttemptObserver = async (record) => {
    const { sequence, directory } = await claimAttemptDirectory(root);
    const files: string[] = [];

    async function publish(name: string, value: unknown): Promise<void> {
      const file = path.join(directory, name);
      await writeJsonOnce(file, value);
      files.push(file);
    }

    const invocation = record.invocation;
    const identified = invocation.outcome === 'DRAFT_RETURNED' || invocation.outcome === 'INVOCATION_FAILED';
    await publish(PLANNING_INVOCATION_METADATA_FILE, {
      schema_version: 1,
      sequence,
      attempt: record.attempt,
      kind: record.kind,
      role: record.identity.role,
      workspace_access: record.identity.workspace_access,
      packet_id: record.identity.packet_id,
      instruction_sha256: record.identity.instruction_sha256,
      intake_sha256: record.identity.intake_sha256,
      inspection_sha256: record.identity.inspection_sha256,
      authorization_scope_sha256: record.identity.authorization_scope_sha256,
      base_revision_sha: record.identity.base_revision_sha,
      invocation_outcome: invocation.outcome,
      invocation_id: identified ? invocation.invocation_id : null,
      provider_id: identified ? invocation.provider_id : null,
      model: identified ? invocation.model : null,
      previous_rejected_stage: record.revision_request?.previous_stage ?? null,
    });

    if (record.revision_request !== null) {
      await publish(PLANNING_REVISION_REQUEST_FILE, {
        schema_version: 1,
        ...record.revision_request,
      });
    }

    // O draft sai do envelope de resultado e vira arquivo próprio: `result.json`
    // continua pequeno e legível, e o draft cru fica inspecionável sozinho.
    let draftFile: string | null = null;
    let draftUnserializable: string | null = null;
    if (invocation.outcome === 'DRAFT_RETURNED') {
      const encodable = draftBytes(invocation.draft);
      if (encodable.serializable) {
        await publish(PLANNING_DRAFT_FILE, invocation.draft);
        draftFile = PLANNING_DRAFT_FILE;
      } else {
        draftUnserializable = encodable.reason;
      }
    }

    await publish(PLANNING_RESULT_FILE, {
      schema_version: 1,
      outcome: invocation.outcome,
      ...(identified
        ? {
            invocation_id: invocation.invocation_id,
            provider_id: invocation.provider_id,
            model: invocation.model,
          }
        : {}),
      ...(invocation.outcome === 'INVOCATION_FAILED' ? { failure: invocation.failure } : {}),
      ...(invocation.outcome === 'INVOCATION_ERROR' || invocation.outcome === 'MALFORMED_RESULT'
        ? { issues: invocation.issues }
        : {}),
      draft_file: draftFile,
      ...(draftUnserializable === null ? {} : { draft_unserializable: draftUnserializable }),
    });

    if (record.validation !== null) {
      await publish(PLANNING_VALIDATION_FILE, {
        schema_version: 1,
        outcome: record.validation.outcome,
        rejected_stage: record.validation.rejected_stage,
        issues: record.validation.issues,
        ...(draftFile === null ? {} : { draft_file: draftFile }),
      });
    }

    persisted.push({
      sequence,
      directory,
      attempt: record.attempt,
      kind: record.kind,
      invocation_outcome: invocation.outcome,
      validation_outcome: record.validation?.outcome ?? null,
      rejected_stage: record.validation?.rejected_stage ?? null,
      files,
    });
  };

  return {
    directory: root,
    observer,
    attempts: () => persisted,
  };
}

/**
 * Linhas de evidência para o relatório de falha do operador: apontam o
 * ARTIFACT que produziu a rejeição, não a raiz genérica do runtime. O draft
 * nunca é despejado no terminal — só o caminho dele.
 */
export function planningEvidenceReport(attempts: readonly PersistedPlanningAttempt[]): string {
  if (attempts.length === 0) {
    return 'planning evidence: nenhuma tentativa do planning worker chegou a acontecer.';
  }
  const lines = attempts.map((attempt) => {
    const verdict =
      attempt.validation_outcome === null
        ? attempt.invocation_outcome
        : attempt.validation_outcome === 'REJECTED'
          ? `REJECTED@${attempt.rejected_stage ?? 'UNKNOWN'}`
          : 'AUTHORIZED';
    const artifacts = attempt.files.map((file) => path.basename(file)).join(', ');
    return `  attempt-${String(attempt.sequence).padStart(2, '0')} (${attempt.kind}, ${verdict}): ${attempt.directory} [${artifacts}]`;
  });
  return ['planning evidence (draft e issues preservados, um diretório por tentativa):', ...lines].join('\n');
}
