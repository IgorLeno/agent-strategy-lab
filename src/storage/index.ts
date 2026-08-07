import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  resolveDataDir,
  type DataDirectoryConfig,
} from '../project/index.js';

export { appendJsonLine } from './jsonl.js';
export {
  appendLedgerEntry,
  buildSectionManifest,
  ledgerLineSha256,
  writeSectionManifest,
  LEDGER_FILE_NAME,
  MANIFEST_FILE_NAME,
  type LedgerEntry,
  type ManifestArtifact,
  type SectionManifest,
  type SectionManifestOptions,
  type WrittenSectionManifest,
} from './manifest.js';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_ULID_TIMESTAMP = 2 ** 48 - 1;
const RUN_ID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export interface RunMetadata {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly created_at: string;
}

export interface CreateRunDirectoryOptions {
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly now?: Date;
}

export interface RunDirectory {
  readonly runId: string;
  readonly dataDir: string;
  readonly runDir: string;
  readonly executionDir: string;
  readonly metadataPath: string;
  readonly metadata: RunMetadata;
}

/** Gera um ULID canônico, cuja ordenação lexicográfica preserva o timestamp. */
export function generateRunId(timestamp: number = Date.now()): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_ULID_TIMESTAMP) {
    throw new RangeError(`timestamp de ULID fora do intervalo: ${timestamp}`);
  }

  return encodeTimestamp(timestamp) + encodeRandomness(randomBytes(10));
}

/**
 * Cria a raiz imutável de um run e sua metadata inicial. A criação exclusiva
 * do diretório do run impede que um id já existente seja sobrescrito.
 */
export async function createRunDirectory(
  options: CreateRunDirectoryOptions = {},
): Promise<RunDirectory> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError('now deve ser uma data válida');
  }

  const runId = options.runId ?? generateRunId(now.getTime());
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new TypeError(`runId deve ser um ULID canônico: ${runId}`);
  }

  const dataDir = resolveDataDir({
    ...(options.labRoot === undefined ? {} : { labRoot: options.labRoot }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const runsDir = path.join(dataDir, 'runs');
  const runDir = path.join(runsDir, runId);
  const executionDir = path.join(runDir, 'execution');
  const metadataPath = path.join(runDir, 'metadata.json');
  const metadata: RunMetadata = {
    schema_version: 1,
    run_id: runId,
    created_at: now.toISOString(),
  };

  await mkdir(runsDir, { recursive: true });
  try {
    await mkdir(runDir);
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') {
      throw new Error(`run directory já existe: ${runId}`, { cause: error });
    }
    throw error;
  }

  try {
    await mkdir(executionDir);
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }

  return { runId, dataDir, runDir, executionDir, metadataPath, metadata };
}

function encodeTimestamp(timestamp: number): string {
  let remaining = timestamp;
  let encoded = '';
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD_BASE32[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandomness(bytes: Uint8Array): string {
  let buffer = 0;
  let bitsInBuffer = 0;
  let encoded = '';

  for (const byte of bytes) {
    buffer = buffer * 256 + byte;
    bitsInBuffer += 8;

    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5;
      const divisor = 2 ** bitsInBuffer;
      const alphabetIndex = Math.floor(buffer / divisor);
      encoded += CROCKFORD_BASE32[alphabetIndex];
      buffer %= divisor;
    }
  }

  return encoded;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
