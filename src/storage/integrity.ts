import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  hashArtifactFile,
  ledgerLineSha256,
  normalizeSectionPath,
  sectionDigestSha256,
  LEDGER_FILE_NAME,
  MANIFEST_FILE_NAME,
  type LedgerEntry,
  type ManifestArtifact,
  type SectionManifest,
} from './manifest.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type IntegrityViolationKind =
  /** O run não tem ledger: nada pode ser provado sobre ele. */
  | 'LEDGER_MISSING'
  /** Uma linha do ledger não é uma entrada bem formada. */
  | 'LEDGER_ENTRY_INVALID'
  /** As sequências não formam 1..n contínuo — alguma linha sumiu ou foi inserida. */
  | 'LEDGER_SEQUENCE_BROKEN'
  /** O encadeamento sha256 quebrou: uma entrada anterior foi editada ou removida. */
  | 'LEDGER_CHAIN_BROKEN'
  /** A entrada do ledger não descreve o manifest que está na seção. */
  | 'LEDGER_MANIFEST_MISMATCH'
  /** A seção registrada no ledger não existe mais no run. */
  | 'SECTION_MISSING'
  /** Uma seção tem manifest próprio mas nenhuma entrada no ledger. */
  | 'SECTION_UNRECORDED'
  | 'MANIFEST_MISSING'
  | 'MANIFEST_INVALID'
  /** O digest do manifest não corresponde à lista de artifacts que ele declara. */
  | 'MANIFEST_DIGEST_MISMATCH'
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_MODIFIED'
  /** Arquivo presente na seção que o manifest não lista. */
  | 'ARTIFACT_UNEXPECTED';

export interface IntegrityViolation {
  readonly kind: IntegrityViolationKind;
  /** Seção afetada; null nas violações do ledger da raiz do run. */
  readonly section: string | null;
  /** Artifact afetado, relativo à seção; null quando a violação não é de um artifact. */
  readonly artifact: string | null;
  readonly detail: string;
}

export interface RunIntegrityReport {
  readonly ok: boolean;
  readonly runDir: string;
  /** Seções verificadas, na ordem em que o ledger as registrou. */
  readonly sections: readonly string[];
  readonly verifiedArtifacts: number;
  readonly violations: readonly IntegrityViolation[];
}

/**
 * Reverifica um run inteiro a partir do que está no disco: reconstrói o
 * encadeamento do ledger, recalcula o digest de cada manifest e refaz o sha256
 * de cada artifact. Nada é comparado contra estado em memória — a verificação
 * vale para um run lido bem depois de encerrado.
 *
 * A verificação nunca lança por adulteração: toda divergência vira violação no
 * relatório, para que um run corrompido possa ser descrito em vez de só falhar.
 */
export async function verifyRunIntegrity(runDir: string): Promise<RunIntegrityReport> {
  const violations: IntegrityViolation[] = [];
  const lines = await readLedgerLines(path.join(runDir, LEDGER_FILE_NAME));

  if (lines === null) {
    violations.push(
      violation('LEDGER_MISSING', null, null, `run sem ${LEDGER_FILE_NAME}: ${runDir}`),
    );
    return { ok: false, runDir, sections: [], verifiedArtifacts: 0, violations };
  }

  const entries = verifyLedgerChain(lines, violations);
  const sections: string[] = [];
  let verifiedArtifacts = 0;

  for (const entry of entries) {
    sections.push(entry.section);
    verifiedArtifacts += await verifySection(runDir, entry, violations);
  }

  await reportUnrecordedSections(runDir, new Set(sections), violations);

  return { ok: violations.length === 0, runDir, sections, verifiedArtifacts, violations };
}

/**
 * Confere sequência e encadeamento de cada linha e devolve as entradas bem
 * formadas. O hash esperado é recalculado sobre os bytes da linha anterior:
 * editar uma entrada antiga muda esses bytes e quebra a linha seguinte.
 */
function verifyLedgerChain(
  lines: readonly string[],
  violations: IntegrityViolation[],
): LedgerEntry[] {
  const entries: LedgerEntry[] = [];

  for (const [index, line] of lines.entries()) {
    const entry = parseLedgerEntry(line);
    if (entry === null) {
      violations.push(
        violation('LEDGER_ENTRY_INVALID', null, null, `linha ${index + 1} do ledger é inválida`),
      );
      continue;
    }

    if (entry.sequence !== index + 1) {
      violations.push(
        violation(
          'LEDGER_SEQUENCE_BROKEN',
          entry.section,
          null,
          `linha ${index + 1} do ledger declara sequence ${entry.sequence}`,
        ),
      );
    }

    const expectedPrevious = index === 0 ? null : ledgerLineSha256(lines[index - 1] ?? '');
    if (entry.previous_entry_sha256 !== expectedPrevious) {
      violations.push(
        violation(
          'LEDGER_CHAIN_BROKEN',
          entry.section,
          null,
          `linha ${index + 1} do ledger não encadeia a anterior: esperado ${
            expectedPrevious ?? 'null'
          }, encontrado ${entry.previous_entry_sha256 ?? 'null'}`,
        ),
      );
    }

    entries.push(entry);
  }

  return entries;
}

/** Verifica uma seção registrada no ledger; devolve quantos artifacts conferiu. */
async function verifySection(
  runDir: string,
  entry: LedgerEntry,
  violations: IntegrityViolation[],
): Promise<number> {
  const sectionDir = path.join(runDir, entry.section);
  if (!(await isDirectory(sectionDir))) {
    violations.push(
      violation(
        'SECTION_MISSING',
        entry.section,
        null,
        `seção registrada no ledger não existe no run: ${entry.section}`,
      ),
    );
    return 0;
  }

  const read = await readSectionManifest(path.join(sectionDir, MANIFEST_FILE_NAME));
  if (read.status === 'MISSING') {
    violations.push(
      violation(
        'MANIFEST_MISSING',
        entry.section,
        null,
        `seção registrada no ledger não tem ${MANIFEST_FILE_NAME}`,
      ),
    );
    return 0;
  }
  if (read.status === 'INVALID') {
    violations.push(violation('MANIFEST_INVALID', entry.section, null, read.detail));
    return 0;
  }

  const { manifest } = read;
  if (manifest.section !== entry.section) {
    violations.push(
      violation(
        'MANIFEST_INVALID',
        entry.section,
        null,
        `manifest declara outra seção: ${manifest.section}`,
      ),
    );
    return 0;
  }

  if (sectionDigestSha256(manifest.section, manifest.artifacts) !== manifest.digest_sha256) {
    violations.push(
      violation(
        'MANIFEST_DIGEST_MISMATCH',
        entry.section,
        null,
        'digest do manifest não corresponde à lista de artifacts que ele declara',
      ),
    );
  }

  if (
    manifest.digest_sha256 !== entry.digest_sha256 ||
    manifest.artifacts.length !== entry.artifact_count
  ) {
    violations.push(
      violation(
        'LEDGER_MANIFEST_MISMATCH',
        entry.section,
        null,
        `entrada ${entry.sequence} do ledger não descreve o manifest da seção: ledger tem digest ${entry.digest_sha256} com ${entry.artifact_count} artifacts, manifest tem ${manifest.digest_sha256} com ${manifest.artifacts.length}`,
      ),
    );
  }

  await verifyArtifacts(sectionDir, manifest, violations);
  return manifest.artifacts.length;
}

async function verifyArtifacts(
  sectionDir: string,
  manifest: SectionManifest,
  violations: IntegrityViolation[],
): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const hashed = await hashArtifactIfPresent(path.join(sectionDir, artifact.path));
    if (hashed === null) {
      violations.push(
        violation(
          'ARTIFACT_MISSING',
          manifest.section,
          artifact.path,
          `artifact listado no manifest não está no disco: ${artifact.path}`,
        ),
      );
      continue;
    }

    // O sha256 é o que detecta troca de conteúdo do mesmo tamanho — reordenar
    // linhas de um JSONL, por exemplo, preserva size_bytes e muda o hash.
    if (hashed.sha256 !== artifact.sha256 || hashed.sizeBytes !== artifact.size_bytes) {
      violations.push(
        violation(
          'ARTIFACT_MODIFIED',
          manifest.section,
          artifact.path,
          `artifact diverge do manifest: esperado sha256 ${artifact.sha256} com ${artifact.size_bytes} bytes, encontrado ${hashed.sha256} com ${hashed.sizeBytes} bytes`,
        ),
      );
    }
  }

  const listed = new Set(manifest.artifacts.map((artifact) => artifact.path));
  for (const relativePath of await listSectionFiles(sectionDir, '')) {
    if (listed.has(relativePath)) continue;
    violations.push(
      violation(
        'ARTIFACT_UNEXPECTED',
        manifest.section,
        relativePath,
        `arquivo presente na seção selada e ausente do manifest: ${relativePath}`,
      ),
    );
  }
}

/**
 * Procura seções seladas que o ledger não registra. Um diretório com
 * `manifest.json` é a raiz de uma seção: a busca para nele, porque o que está
 * abaixo já é responsabilidade daquele manifest.
 */
async function reportUnrecordedSections(
  runDir: string,
  recorded: ReadonlySet<string>,
  violations: IntegrityViolation[],
): Promise<void> {
  const pending: string[] = [''];

  while (pending.length > 0) {
    const relativeDir = pending.pop() ?? '';
    const entries = await readDirectory(relativeDir === '' ? runDir : path.join(runDir, relativeDir));
    if (entries === null) continue;

    const isSectionRoot =
      relativeDir !== '' &&
      entries.some((entry) => entry.isFile() && entry.name === MANIFEST_FILE_NAME);

    if (isSectionRoot) {
      if (!recorded.has(relativeDir)) {
        violations.push(
          violation(
            'SECTION_UNRECORDED',
            relativeDir,
            null,
            `seção selada sem entrada no ledger: ${relativeDir}`,
          ),
        );
      }
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      pending.push(relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`);
    }
  }
}

/** Caminhos relativos de todos os arquivos da seção, menos o próprio manifest. */
async function listSectionFiles(sectionDir: string, relativeDir: string): Promise<string[]> {
  const entries = await readDirectory(
    relativeDir === '' ? sectionDir : path.join(sectionDir, relativeDir),
  );
  if (entries === null) return [];

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...(await listSectionFiles(sectionDir, relativePath)));
      continue;
    }

    if (relativePath === MANIFEST_FILE_NAME) continue;
    files.push(relativePath);
  }

  return files;
}

async function readLedgerLines(ledgerPath: string): Promise<string[] | null> {
  let content: string;
  try {
    content = await readFile(ledgerPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EISDIR')) return null;
    throw error;
  }

  return content.split('\n').filter((line) => line !== '');
}

type ManifestRead =
  | { readonly status: 'OK'; readonly manifest: SectionManifest }
  | { readonly status: 'MISSING' }
  | { readonly status: 'INVALID'; readonly detail: string };

async function readSectionManifest(manifestPath: string): Promise<ManifestRead> {
  let content: string;
  try {
    content = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
      return { status: 'MISSING' };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: 'INVALID', detail: `${MANIFEST_FILE_NAME} não é JSON válido` };
  }

  const manifest = asSectionManifest(parsed);
  if (manifest === null) {
    return { status: 'INVALID', detail: `${MANIFEST_FILE_NAME} não tem a forma de um manifest` };
  }

  return { status: 'OK', manifest };
}

function asSectionManifest(value: unknown): SectionManifest | null {
  if (!isRecord(value)) return null;
  if (
    value['schema_version'] !== 1 ||
    typeof value['section'] !== 'string' ||
    safeSection(value['section']) === null ||
    typeof value['created_at'] !== 'string' ||
    !isSha256(value['digest_sha256']) ||
    !Array.isArray(value['artifacts'])
  ) {
    return null;
  }

  const artifacts: ManifestArtifact[] = [];
  for (const entry of value['artifacts'] as readonly unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry['path'] !== 'string' ||
      !isSafeArtifactPath(entry['path']) ||
      !isNonNegativeInteger(entry['size_bytes']) ||
      !isSha256(entry['sha256'])
    ) {
      return null;
    }
    artifacts.push({
      path: entry['path'],
      size_bytes: entry['size_bytes'],
      sha256: entry['sha256'],
    });
  }

  return {
    schema_version: 1,
    section: value['section'],
    created_at: value['created_at'],
    artifacts,
    digest_sha256: value['digest_sha256'],
  };
}

function parseLedgerEntry(line: string): LedgerEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const section = typeof parsed['section'] === 'string' ? safeSection(parsed['section']) : null;
  const previous = parsed['previous_entry_sha256'];

  if (
    parsed['schema_version'] !== 1 ||
    section === null ||
    !isNonNegativeInteger(parsed['sequence']) ||
    parsed['sequence'] < 1 ||
    !isSha256(parsed['digest_sha256']) ||
    !isNonNegativeInteger(parsed['artifact_count']) ||
    typeof parsed['appended_at'] !== 'string' ||
    !(previous === null || isSha256(previous))
  ) {
    return null;
  }

  return {
    schema_version: 1,
    sequence: parsed['sequence'],
    section,
    digest_sha256: parsed['digest_sha256'],
    artifact_count: parsed['artifact_count'],
    appended_at: parsed['appended_at'],
    previous_entry_sha256: previous === null ? null : (previous as string),
  };
}

async function hashArtifactIfPresent(
  filePath: string,
): Promise<{ sha256: string; sizeBytes: number } | null> {
  try {
    return await hashArtifactFile(filePath);
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'EISDIR')) return null;
    throw error;
  }
}

/** Lista um diretório; null quando ele não existe mais ou virou arquivo. */
async function readDirectory(directory: string): Promise<Dirent[] | null> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

/** Seção só é aceita se já vier normalizada: nada que escape da raiz do run. */
function safeSection(section: string): string | null {
  try {
    return normalizeSectionPath(section) === section ? section : null;
  } catch {
    return null;
  }
}

function isSafeArtifactPath(value: string): boolean {
  if (value === '' || value.includes('\\') || path.isAbsolute(value)) return false;
  return value
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function violation(
  kind: IntegrityViolationKind,
  section: string | null,
  artifact: string | null,
  detail: string,
): IntegrityViolation {
  return { kind, section, artifact, detail };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
