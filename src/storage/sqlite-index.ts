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
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

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

  close(): void {
    this.db.close();
  }
}
