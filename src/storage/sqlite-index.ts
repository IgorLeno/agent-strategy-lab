/**
 * Índice SQLite de runs, trials e tasks: derivado e descartável, nunca fonte
 * de verdade. A evidência em disco (manifest, ledger, envelopes) é quem prova
 * o que aconteceu; este índice só existe para tornar consultas rápidas — pode
 * ser apagado e reconstruído a qualquer momento sem perder nada.
 *
 * `node:sqlite` (`DatabaseSync`), não `better-sqlite3`: o pacote não é
 * instalável neste ambiente (sandbox sem acesso à rede) e o runtime já traz
 * um driver SQLite síncrono equivalente, com tipos em `@types/node`.
 *
 * Carregado via `createRequire` em vez de `import` estático: `node:sqlite`
 * ainda é experimental e não consta na lista de builtins que o resolver do
 * Vite/vite-node reconhece, então um `import` direto quebra sob Vitest
 * tentando resolver "sqlite" como pacote npm.
 */
import type { Dirent } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { verifyRunIntegrity, type IntegrityViolation } from './integrity.js';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

export const RUN_INDEX_SCHEMA_VERSION = 1;

export interface TaskIndexRow {
  readonly id: string;
  readonly task_class: string;
  readonly difficulty: string;
  readonly description: string;
}

export interface TrialIndexRow {
  readonly id: string;
  readonly task_id: string;
  readonly agent_id: string;
  readonly strategy_name: string;
  readonly status: string;
}

export interface RunIndexRow {
  readonly run_id: string;
  readonly trial_id: string;
  readonly run_dir: string;
  readonly created_at: string;
  readonly status: string | null;
}

/**
 * Link versionado entre um run homogêneo e o lifecycle maior da work unit.
 * A seleção é uma decisão explícita do writer; leitores nunca escolhem o
 * evaluation/score "mais recente".
 */
export interface RunHistoryContextV1 {
  readonly schema_version: 1;
  readonly execution_episode_id: string;
  readonly episode_attempt_ordinal: number;
  readonly work_definition_fingerprint_sha256: string;
  readonly initial_profile_id: string;
  readonly initial_profile_fingerprint_sha256: string;
  readonly observed_had_inference?: {
    readonly value: boolean;
    readonly provenance: string;
  };
  readonly selection: {
    readonly evaluation_id: string;
    readonly score_id: string | null;
  };
}

/**
 * Nome do arquivo, na raiz do run, que registra tudo que o índice precisa para
 * reindexar aquele run sem depender do banco: task, trial e run. É a
 * contrapartida em disco de `insertTask`/`insertTrial`/`insertRun` — sem ele,
 * o rebuild não teria de onde ler, e o índice deixaria de ser reconstruível.
 */
export const RUN_RECORD_FILE_NAME = 'index-record.json';

/** Registro em disco de um run indexado: fonte que `rebuild` relê. */
export interface RunRecord {
  readonly task: TaskIndexRow;
  readonly trial: TrialIndexRow;
  readonly run: RunIndexRow;
  readonly history_context?: RunHistoryContextV1;
}

/** Resultado da reindexação de um único run durante o rebuild. */
export interface RunRebuildResult {
  readonly runId: string;
  readonly runDir: string;
  /** false quando o run não tem `index-record.json` legível: nada foi indexado a partir dele. */
  readonly indexed: boolean;
  readonly integrityOk: boolean;
  readonly violations: readonly IntegrityViolation[];
  readonly detail: string | null;
}

/** Relatório completo de uma reconstrução do índice a partir de `data/runs/`. */
export interface RebuildReport {
  readonly runsScanned: number;
  readonly runsIndexed: number;
  readonly results: readonly RunRebuildResult[];
}

export interface DiscoveredRunRecord {
  readonly runDir: string;
  readonly record: RunRecord;
}

/**
 * Descoberta canônica e somente-leitura a partir dos RunRecords reconstruíveis.
 * Records ausentes ou inválidos não são promovidos a catálogo paralelo.
 */
export async function listRunRecords(runsDir: string): Promise<DiscoveredRunRecord[]> {
  const records: DiscoveredRunRecord[] = [];
  for (const runId of await listRunDirectories(runsDir)) {
    const runDir = path.join(runsDir, runId);
    const read = await readRunRecord(runDir);
    if (read.status === 'OK') records.push({ runDir, record: read.record });
  }
  return records;
}

/**
 * Levanta quando o arquivo do índice já existe com uma `schema_version`
 * diferente da esperada. Como o índice é descartável, a recuperação é apagar
 * o arquivo e reconstruir — nunca migrar dados que só existem nele.
 */
export class RunIndexSchemaVersionError extends Error {
  constructor(
    public readonly found: number,
    public readonly expected: number,
  ) {
    super(
      `versão do schema do índice incompatível: encontrada ${found}, esperada ${expected}`,
    );
    this.name = 'RunIndexSchemaVersionError';
  }
}

/** Índice SQLite de runs, trials e tasks. Toda escrita e leitura é síncrona. */
export class RunIndex {
  private constructor(private readonly db: DatabaseSyncType) {}

  /**
   * Abre (ou cria) o arquivo do índice e garante o schema. Se o arquivo já
   * tiver uma `schema_version` diferente da atual, falha em vez de migrar
   * silenciosamente — o índice inteiro pode ser apagado e reconstruído a
   * partir da evidência em disco.
   */
  static open(dbPath: string): RunIndex {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT
    `);

    const existing = db
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get('schema_version') as { value: string } | undefined;

    if (existing === undefined) {
      db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(RUN_INDEX_SCHEMA_VERSION),
      );
    } else if (Number(existing.value) !== RUN_INDEX_SCHEMA_VERSION) {
      const found = Number(existing.value);
      db.close();
      throw new RunIndexSchemaVersionError(found, RUN_INDEX_SCHEMA_VERSION);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_class TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        description TEXT NOT NULL
      ) STRICT
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS trials (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        agent_id TEXT NOT NULL,
        strategy_name TEXT NOT NULL,
        status TEXT NOT NULL
      ) STRICT
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        trial_id TEXT NOT NULL REFERENCES trials(id),
        run_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT
      ) STRICT
    `);

    return new RunIndex(db);
  }

  /** Insere ou atualiza uma task — reconstrução do índice deve ser idempotente. */
  insertTask(row: TaskIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, task_class, difficulty, description)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_class = excluded.task_class,
           difficulty = excluded.difficulty,
           description = excluded.description`,
      )
      .run(row.id, row.task_class, row.difficulty, row.description);
  }

  getTask(id: string): TaskIndexRow | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return (row as TaskIndexRow | undefined) ?? null;
  }

  /** Insere ou atualiza um trial. `task_id` precisa existir em `tasks`. */
  insertTrial(row: TrialIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO trials (id, task_id, agent_id, strategy_name, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           task_id = excluded.task_id,
           agent_id = excluded.agent_id,
           strategy_name = excluded.strategy_name,
           status = excluded.status`,
      )
      .run(row.id, row.task_id, row.agent_id, row.strategy_name, row.status);
  }

  getTrial(id: string): TrialIndexRow | null {
    const row = this.db.prepare('SELECT * FROM trials WHERE id = ?').get(id);
    return (row as TrialIndexRow | undefined) ?? null;
  }

  /** Insere ou atualiza um run. `trial_id` precisa existir em `trials`. */
  insertRun(row: RunIndexRow): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, trial_id, run_dir, created_at, status)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           trial_id = excluded.trial_id,
           run_dir = excluded.run_dir,
           created_at = excluded.created_at,
           status = excluded.status`,
      )
      .run(row.run_id, row.trial_id, row.run_dir, row.created_at, row.status);
  }

  getRun(runId: string): RunIndexRow | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    return (row as RunIndexRow | undefined) ?? null;
  }

  /** Runs de um trial, mais recentes primeiro. */
  listRunsForTrial(trialId: string): readonly RunIndexRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE trial_id = ? ORDER BY created_at DESC')
      .all(trialId) as unknown as RunIndexRow[];
  }

  /** Trials de uma task. */
  listTrialsForTask(taskId: string): readonly TrialIndexRow[] {
    return this.db.prepare('SELECT * FROM trials WHERE task_id = ?').all(taskId) as unknown as TrialIndexRow[];
  }

  /**
   * Indexa um run e, antes disso, grava o mesmo registro em disco na raiz do
   * run. É o único caminho de escrita que este módulo expõe para task/trial/run
   * juntos, exatamente para que nada entre no índice sem também existir no
   * disco — o rebuild relê esse mesmo arquivo.
   */
  async indexRun(runDir: string, record: RunRecord): Promise<void> {
    if (record.trial.task_id !== record.task.id) {
      throw new TypeError(
        `trial.task_id (${record.trial.task_id}) não corresponde a task.id (${record.task.id})`,
      );
    }
    if (record.run.trial_id !== record.trial.id) {
      throw new TypeError(
        `run.trial_id (${record.run.trial_id}) não corresponde a trial.id (${record.trial.id})`,
      );
    }

    await writeFile(
      path.join(runDir, RUN_RECORD_FILE_NAME),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    );

    this.insertTask(record.task);
    this.insertTrial(record.trial);
    this.insertRun(record.run);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Apaga o arquivo do índice (se existir) e o reconstrói do zero varrendo
   * `runsDir`: cada subdiretório com `index-record.json` legível é reindexado a
   * partir dele. A integridade de cada run é reverificada e entra no relatório
   * — uma run com evidência corrompida continua reportada, nunca some
   * silenciosamente do resultado.
   *
   * Como cada run é lido só do próprio disco e os inserts são upsert, rodar o
   * rebuild de novo sobre o mesmo `runsDir` produz o mesmo conteúdo: o rebuild
   * é idempotente por construção, não por um caso especial.
   */
  static async rebuild(dbPath: string, runsDir: string): Promise<{ index: RunIndex; report: RebuildReport }> {
    await rm(dbPath, { force: true });

    const index = RunIndex.open(dbPath);
    const results: RunRebuildResult[] = [];

    for (const runId of await listRunDirectories(runsDir)) {
      const runDir = path.join(runsDir, runId);
      const read = await readRunRecord(runDir);
      const integrity = await verifyRunIntegrity(runDir);

      if (read.status === 'MISSING') {
        results.push({
          runId,
          runDir,
          indexed: false,
          integrityOk: integrity.ok,
          violations: integrity.violations,
          detail: `run sem ${RUN_RECORD_FILE_NAME}: nada para indexar`,
        });
        continue;
      }
      if (read.status === 'INVALID') {
        results.push({
          runId,
          runDir,
          indexed: false,
          integrityOk: integrity.ok,
          violations: integrity.violations,
          detail: read.detail,
        });
        continue;
      }

      index.insertTask(read.record.task);
      index.insertTrial(read.record.trial);
      index.insertRun(read.record.run);
      results.push({
        runId,
        runDir,
        indexed: true,
        integrityOk: integrity.ok,
        violations: integrity.violations,
        detail: null,
      });
    }

    return {
      index,
      report: {
        runsScanned: results.length,
        runsIndexed: results.filter((result) => result.indexed).length,
        results,
      },
    };
  }
}

async function listRunDirectories(runsDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    // ENOENT e ENOTDIR descrevem o MESMO fato observável: não há diretório de
    // runs, logo não há run registrada. Nenhum dos dois é "zero runs medidas" —
    // é ausência de medição, e quem consome trata como tal.
    if (isNodeError(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

type RunRecordRead =
  | { readonly status: 'OK'; readonly record: RunRecord }
  | { readonly status: 'MISSING' }
  | { readonly status: 'INVALID'; readonly detail: string };

async function readRunRecord(runDir: string): Promise<RunRecordRead> {
  let content: string;
  try {
    content = await readFile(path.join(runDir, RUN_RECORD_FILE_NAME), 'utf8');
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
    return { status: 'INVALID', detail: `${RUN_RECORD_FILE_NAME} não é JSON válido` };
  }

  const record = asRunRecord(parsed);
  if (record === null) {
    return { status: 'INVALID', detail: `${RUN_RECORD_FILE_NAME} não tem a forma de um RunRecord` };
  }

  return { status: 'OK', record };
}

function asRunRecord(value: unknown): RunRecord | null {
  if (!isRecord(value)) return null;

  const task = asTaskIndexRow(value['task']);
  const trial = asTrialIndexRow(value['trial']);
  const run = asRunIndexRow(value['run']);
  const historyContext = asRunHistoryContext(value['history_context']);
  if (task === null || trial === null || run === null) return null;
  if (historyContext === null) return null;
  if (trial.task_id !== task.id || run.trial_id !== trial.id) return null;

  return {
    task,
    trial,
    run,
    ...(historyContext === undefined ? {} : { history_context: historyContext }),
  };
}

function asRunHistoryContext(value: unknown): RunHistoryContextV1 | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value['schema_version'] !== 1) return null;
  const selection = value['selection'];
  if (!isRecord(selection)) return null;
  const executionEpisodeId = value['execution_episode_id'];
  const ordinal = value['episode_attempt_ordinal'];
  const workFingerprint = value['work_definition_fingerprint_sha256'];
  const initialProfileId = value['initial_profile_id'];
  const initialFingerprint = value['initial_profile_fingerprint_sha256'];
  const evaluationId = selection['evaluation_id'];
  const scoreId = selection['score_id'];
  const observedInference = value['observed_had_inference'];
  if (
    typeof executionEpisodeId !== 'string' || executionEpisodeId.length === 0 ||
    !Number.isInteger(ordinal) || (ordinal as number) < 1 ||
    !isSha256(workFingerprint) ||
    typeof initialProfileId !== 'string' || initialProfileId.length === 0 ||
    !isSha256(initialFingerprint) ||
    typeof evaluationId !== 'string' || evaluationId.length === 0 ||
    !(scoreId === null || typeof scoreId === 'string') ||
    !isObservedInference(observedInference)
  ) {
    return null;
  }
  return {
    schema_version: 1,
    execution_episode_id: executionEpisodeId,
    episode_attempt_ordinal: ordinal as number,
    work_definition_fingerprint_sha256: workFingerprint,
    initial_profile_id: initialProfileId,
    initial_profile_fingerprint_sha256: initialFingerprint,
    ...(observedInference === undefined ? {} : { observed_had_inference: observedInference }),
    selection: { evaluation_id: evaluationId, score_id: scoreId },
  };
}

function isObservedInference(
  value: unknown,
): value is RunHistoryContextV1['observed_had_inference'] {
  return value === undefined || (
    isRecord(value) &&
    typeof value['value'] === 'boolean' &&
    typeof value['provenance'] === 'string' &&
    value['provenance'].length > 0
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function asTaskIndexRow(value: unknown): TaskIndexRow | null {
  if (!isRecord(value)) return null;
  const { id, task_class, difficulty, description } = value;
  if (
    typeof id !== 'string' ||
    typeof task_class !== 'string' ||
    typeof difficulty !== 'string' ||
    typeof description !== 'string'
  ) {
    return null;
  }
  return { id, task_class, difficulty, description };
}

function asTrialIndexRow(value: unknown): TrialIndexRow | null {
  if (!isRecord(value)) return null;
  const { id, task_id, agent_id, strategy_name, status } = value;
  if (
    typeof id !== 'string' ||
    typeof task_id !== 'string' ||
    typeof agent_id !== 'string' ||
    typeof strategy_name !== 'string' ||
    typeof status !== 'string'
  ) {
    return null;
  }
  return { id, task_id, agent_id, strategy_name, status };
}

function asRunIndexRow(value: unknown): RunIndexRow | null {
  if (!isRecord(value)) return null;
  const { run_id, trial_id, run_dir, created_at, status } = value;
  if (
    typeof run_id !== 'string' ||
    typeof trial_id !== 'string' ||
    typeof run_dir !== 'string' ||
    typeof created_at !== 'string' ||
    !(status === null || typeof status === 'string')
  ) {
    return null;
  }
  return { run_id, trial_id, run_dir, created_at, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
