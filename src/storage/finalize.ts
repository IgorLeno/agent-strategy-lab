import { stat } from 'node:fs/promises';
import path from 'node:path';

import {
  appendLedgerEntry,
  normalizeSectionPath,
  writeSectionManifest,
  type LedgerEntry,
  type SectionManifest,
} from './manifest.js';

export const EXECUTION_SECTION = 'execution';
export const EVALUATIONS_SECTION_PREFIX = 'evaluations';
export const SCORES_SECTION_PREFIX = 'scores';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface SealSectionOptions {
  readonly now?: Date;
}

export interface SealedSection {
  /** Caminho da seção relativo à raiz do run, já normalizado. */
  readonly section: string;
  readonly sectionDir: string;
  readonly manifestPath: string;
  readonly manifest: SectionManifest;
  readonly ledgerEntry: LedgerEntry;
}

/**
 * Sela uma seção do run: escreve o manifest dentro da própria seção e registra
 * uma entrada nova no ledger da raiz. Nenhum manifest de outra seção é lido ou
 * reescrito, e o ledger só cresce — por isso `evaluations/` e `scores/` são
 * adições posteriores e não exigem tocar em `execution/`.
 *
 * Selar a mesma seção duas vezes falha: o manifest é criado com exclusividade e
 * a segunda tentativa para antes de chegar ao ledger.
 */
export async function sealSection(
  runDir: string,
  section: string,
  options: SealSectionOptions = {},
): Promise<SealedSection> {
  const normalized = normalizeSectionPath(section);
  const sectionDir = path.join(runDir, normalized);
  await assertSectionDirectory(sectionDir, normalized);

  const { manifestPath, manifest } = await writeSectionManifest(sectionDir, {
    section: normalized,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  let ledgerEntry: LedgerEntry;
  try {
    ledgerEntry = await appendLedgerEntry(runDir, manifest, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    // O manifest fica no disco de propósito: ele descreve o que existia no
    // momento da selagem. Apagá-lo destruiria a prova, e a seção sem entrada no
    // ledger é justamente o que a verificação de integridade precisa enxergar.
    throw new Error(`seção selada mas não registrada no ledger: ${normalized}`, { cause: error });
  }

  return { section: normalized, sectionDir, manifestPath, manifest, ledgerEntry };
}

/**
 * Sela `execution/` — exatamente uma vez por run. A segunda chamada falha em vez
 * de sobrescrever o manifest que prova a execução.
 */
export async function finalizeExecution(
  runDir: string,
  options: SealSectionOptions = {},
): Promise<SealedSection> {
  return sealSection(runDir, EXECUTION_SECTION, options);
}

/** Sela `evaluations/<id>/` como adição posterior à execução já selada. */
export async function sealEvaluation(
  runDir: string,
  evaluationId: string,
  options: SealSectionOptions = {},
): Promise<SealedSection> {
  return sealSection(
    runDir,
    `${EVALUATIONS_SECTION_PREFIX}/${assertIdentifier(evaluationId, 'evaluationId')}`,
    options,
  );
}

/** Sela `scores/<id>/` como adição posterior à avaliação já selada. */
export async function sealScore(
  runDir: string,
  scoreId: string,
  options: SealSectionOptions = {},
): Promise<SealedSection> {
  return sealSection(
    runDir,
    `${SCORES_SECTION_PREFIX}/${assertIdentifier(scoreId, 'scoreId')}`,
    options,
  );
}

async function assertSectionDirectory(sectionDir: string, section: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(sectionDir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new Error(`seção não existe no run: ${section}`, { cause: error });
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(`seção não é um diretório: ${section}`);
  }
}

function assertIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`${field} deve ser alfanumérico com - ou _: ${value}`);
  }
  return value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
