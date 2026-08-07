import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalSha256 } from '../envelope/index.js';
import { queueFileWrite } from './jsonl.js';

export const MANIFEST_FILE_NAME = 'manifest.json';
export const LEDGER_FILE_NAME = 'ledger.jsonl';

/** Um artifact selado, sempre identificado por caminho relativo à seção. */
export interface ManifestArtifact {
  readonly path: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

export interface SectionManifest {
  readonly schema_version: 1;
  /** Caminho da seção relativo à raiz do run: `execution`, `scores/<id>`, ... */
  readonly section: string;
  readonly created_at: string;
  readonly artifacts: readonly ManifestArtifact[];
  readonly digest_sha256: string;
}

export interface LedgerEntry {
  readonly schema_version: 1;
  readonly sequence: number;
  readonly section: string;
  readonly digest_sha256: string;
  readonly artifact_count: number;
  readonly appended_at: string;
  /** sha256 da linha anterior do ledger; null só na primeira entrada. */
  readonly previous_entry_sha256: string | null;
}

export interface SectionManifestOptions {
  readonly section: string;
  readonly now?: Date;
}

export interface WrittenSectionManifest {
  readonly manifestPath: string;
  readonly manifest: SectionManifest;
}

/**
 * Percorre a seção e descreve cada artifact com caminho relativo, tamanho e
 * sha256. O `manifest.json` da própria seção é excluído: ele é a prova, não
 * um artifact provado.
 */
export async function buildSectionManifest(
  sectionDir: string,
  options: SectionManifestOptions,
): Promise<SectionManifest> {
  const section = normalizeSection(options.section);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('now deve ser uma data válida');
  }

  const collected = await collectArtifacts(sectionDir, '');
  // A ordenação por caminho torna o digest independente da ordem de leitura do
  // diretório, que o sistema de arquivos não garante.
  const artifacts = collected.sort(compareByPath);

  return {
    schema_version: 1,
    section,
    created_at: now.toISOString(),
    artifacts,
    digest_sha256: aggregateDigest(section, artifacts),
  };
}

/**
 * Escreve o manifest da seção. A criação exclusiva impede que uma seção já
 * selada seja re-selada por cima da prova anterior.
 */
export async function writeSectionManifest(
  sectionDir: string,
  options: SectionManifestOptions,
): Promise<WrittenSectionManifest> {
  const manifest = await buildSectionManifest(sectionDir, options);
  const manifestPath = path.join(sectionDir, MANIFEST_FILE_NAME);

  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`manifest da seção já existe: ${manifest.section}`, { cause: error });
    }
    throw error;
  }

  return { manifestPath, manifest };
}

/**
 * Acrescenta uma entrada ao ledger do run. Cada adição é uma linha nova
 * encadeada ao sha256 da linha anterior — nenhuma entrada anterior é reescrita,
 * e editar uma delas quebra o encadeamento.
 */
export async function appendLedgerEntry(
  runDir: string,
  manifest: SectionManifest,
  options: { readonly now?: Date } = {},
): Promise<LedgerEntry> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('now deve ser uma data válida');
  }

  const ledgerPath = path.join(runDir, LEDGER_FILE_NAME);

  // A leitura da última linha e o append precisam ser atômicos entre si, senão
  // dois appends concorrentes encadeariam a mesma entrada anterior.
  return queueFileWrite(ledgerPath, async () => {
    const previous = await readLastLedgerLine(ledgerPath);
    const entry: LedgerEntry = {
      schema_version: 1,
      sequence: previous === null ? 1 : previous.entry.sequence + 1,
      section: manifest.section,
      digest_sha256: manifest.digest_sha256,
      artifact_count: manifest.artifacts.length,
      appended_at: now.toISOString(),
      previous_entry_sha256: previous === null ? null : ledgerLineSha256(previous.line),
    };

    await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return entry;
  });
}

/** sha256 dos bytes exatos de uma linha do ledger, sem o newline final. */
export function ledgerLineSha256(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

function aggregateDigest(section: string, artifacts: readonly ManifestArtifact[]): string {
  return canonicalSha256({ schema_version: 1, section, artifacts });
}

async function collectArtifacts(
  sectionDir: string,
  relativeDir: string,
): Promise<ManifestArtifact[]> {
  const absoluteDir = relativeDir === '' ? sectionDir : path.join(sectionDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const artifacts: ManifestArtifact[] = [];

  for (const entry of entries) {
    const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;

    if (entry.isDirectory()) {
      artifacts.push(...(await collectArtifacts(sectionDir, relativePath)));
      continue;
    }

    if (!entry.isFile()) {
      throw new Error(`artifact não é um arquivo regular: ${relativePath}`);
    }

    if (relativePath === MANIFEST_FILE_NAME) continue;

    const { sha256, sizeBytes } = await hashFile(path.join(sectionDir, relativePath));
    artifacts.push({ path: relativePath, size_bytes: sizeBytes, sha256 });
  }

  return artifacts;
}

async function hashFile(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    const bytes = chunk as Buffer;
    sizeBytes += bytes.byteLength;
    hash.update(bytes);
  }

  return { sha256: hash.digest('hex'), sizeBytes };
}

async function readLastLedgerLine(
  ledgerPath: string,
): Promise<{ line: string; entry: LedgerEntry } | null> {
  let content: string;
  try {
    content = await readFile(ledgerPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }

  const lines = content.split('\n').filter((line) => line !== '');
  const line = lines.at(-1);
  if (line === undefined) return null;

  const parsed = JSON.parse(line) as unknown;
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as LedgerEntry).sequence !== 'number'
  ) {
    throw new Error(`última entrada do ledger é inválida: ${ledgerPath}`);
  }

  return { line, entry: parsed as LedgerEntry };
}

function normalizeSection(section: string): string {
  const normalized = section.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (normalized === '' || normalized.split('/').some((segment) => segment === '..')) {
    throw new TypeError(`seção inválida: ${section}`);
  }
  return normalized;
}

function compareByPath(left: ManifestArtifact, right: ManifestArtifact): number {
  if (left.path === right.path) return 0;
  return left.path < right.path ? -1 : 1;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
