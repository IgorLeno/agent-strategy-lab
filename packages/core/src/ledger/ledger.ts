/**
 * LEDGER: custo e estado por step, em SQLite.
 *
 * Tabela mutável comum, não evidência write-once. Responde duas perguntas:
 * "quanto custou" (tokens, modelo, tempo por tentativa) e "onde o plano parou"
 * (status de cada step, nota do último step, base do diff).
 *
 * Driver `node:sqlite` (DatabaseSync), como o índice do Lab antigo (ADR-0001).
 * O spike da Fase 2 decide se ele também serve dentro do Electron.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import type { PermissionMode } from '../adapters/invocation.js';
import type { Tier } from '../catalog/catalog.js';
import type { GitMode } from '../git/git.js';

// `createRequire` em vez de import estático, como em src/storage/sqlite-index.ts:
// o Vite remove o prefixo `node:` e tentaria resolver "sqlite" como pacote npm.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  plan_rel_path TEXT NOT NULL,
  slug TEXT NOT NULL,
  git_mode TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo, plan_rel_path, slug)
);
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  step_id TEXT NOT NULL,
  title TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  commit_sha TEXT,
  note TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (plan_id, step_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY,
  step_row_id INTEGER NOT NULL REFERENCES steps(id),
  attempt_no INTEGER NOT NULL,
  profile_id TEXT NOT NULL,
  scaffold TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  timed_out INTEGER,
  outcome TEXT,
  gate_exit_code INTEGER,
  tokens_total INTEGER,
  tokens_input INTEGER,
  tokens_cached_input INTEGER,
  tokens_output INTEGER,
  tokens_reasoning INTEGER,
  error TEXT
);
`;

export type PlanRunStatus = 'running' | 'paused' | 'done' | 'failed';
export type LedgerStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
export type AttemptOutcome =
  | 'success'
  | 'gate_failed'
  | 'agent_failed'
  | 'provider_failed'
  | 'spawn_failed'
  | 'commit_failed'
  | 'aborted';

export interface PlanRow {
  readonly id: number;
  readonly repo: string;
  readonly plan_rel_path: string;
  readonly slug: string;
  readonly git_mode: GitMode;
  readonly workspace_dir: string;
  readonly branch: string;
  readonly base_sha: string;
  readonly status: PlanRunStatus;
}

export interface StepRow {
  readonly id: number;
  readonly plan_id: number;
  readonly step_id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly status: LedgerStepStatus;
  readonly commit_sha: string | null;
  readonly note: string | null;
  readonly started_at: string | null;
  readonly finished_at: string | null;
}

export interface AttemptRow {
  readonly id: number;
  readonly step_row_id: number;
  readonly attempt_no: number;
  readonly profile_id: string;
  readonly scaffold: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string | null;
  readonly mode: PermissionMode;
  readonly duration_ms: number | null;
  readonly exit_code: number | null;
  readonly timed_out: number | null;
  readonly outcome: AttemptOutcome | null;
  readonly gate_exit_code: number | null;
  readonly tokens_total: number | null;
  readonly tokens_input: number | null;
  readonly tokens_cached_input: number | null;
  readonly tokens_output: number | null;
  readonly tokens_reasoning: number | null;
  readonly error: string | null;
}

export interface AttemptFinish {
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outcome: AttemptOutcome;
  readonly gateExitCode: number | null;
  readonly tokens: {
    readonly total: number;
    readonly input: number | null;
    readonly cached_input: number | null;
    readonly output: number | null;
    readonly reasoning: number | null;
  } | null;
  readonly error: string | null;
}

export class Ledger {
  private readonly db: DatabaseSyncType;
  private readonly now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.now = now;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > SCHEMA_VERSION) {
      throw new Error(`ledger em versão ${version}, mais nova que a suportada (${SCHEMA_VERSION})`);
    }
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  findPlan(repo: string, planRelPath: string, slug: string): PlanRow | null {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE repo = ? AND plan_rel_path = ? AND slug = ?')
      .get(repo, planRelPath, slug);
    return (row as PlanRow | undefined) ?? null;
  }

  /** Cria o registro do plano, ou atualiza o workspace de um plano retomado. */
  upsertPlan(input: Omit<PlanRow, 'id' | 'status'>): PlanRow {
    const stamp = this.stamp();
    this.db
      .prepare(
        `INSERT INTO plans (repo, plan_rel_path, slug, git_mode, workspace_dir, branch, base_sha, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
         ON CONFLICT (repo, plan_rel_path, slug) DO UPDATE SET
           git_mode = excluded.git_mode, workspace_dir = excluded.workspace_dir,
           branch = excluded.branch, status = 'running', updated_at = excluded.updated_at`,
      )
      .run(input.repo, input.plan_rel_path, input.slug, input.git_mode, input.workspace_dir, input.branch, input.base_sha, stamp, stamp);
    return this.findPlan(input.repo, input.plan_rel_path, input.slug) as PlanRow;
  }

  setPlanStatus(planId: number, status: PlanRunStatus): void {
    this.db.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?').run(status, this.stamp(), planId);
  }

  /** Garante a linha do step; título e tier acompanham edições do plano. */
  ensureStep(planId: number, step: { id: string; title: string; tier: Tier }): StepRow {
    this.db
      .prepare(
        `INSERT INTO steps (plan_id, step_id, title, tier, status) VALUES (?, ?, ?, ?, 'pending')
         ON CONFLICT (plan_id, step_id) DO UPDATE SET title = excluded.title, tier = excluded.tier`,
      )
      .run(planId, step.id, step.title, step.tier);
    return this.db.prepare('SELECT * FROM steps WHERE plan_id = ? AND step_id = ?').get(planId, step.id) as unknown as StepRow;
  }

  markStepRunning(stepRowId: number): void {
    this.db
      .prepare("UPDATE steps SET status = 'running', started_at = COALESCE(started_at, ?), finished_at = NULL WHERE id = ?")
      .run(this.stamp(), stepRowId);
  }

  finishStep(stepRowId: number, input: { status: LedgerStepStatus; commitSha?: string | null; note?: string | null }): void {
    this.db
      .prepare('UPDATE steps SET status = ?, commit_sha = ?, note = ?, finished_at = ? WHERE id = ?')
      .run(input.status, input.commitSha ?? null, input.note ?? null, this.stamp(), stepRowId);
  }

  /** Steps que ficaram `running` quando o processo morreu viram `interrupted`. */
  markInterrupted(planId: number): number {
    const result = this.db
      .prepare("UPDATE steps SET status = 'interrupted' WHERE plan_id = ? AND status = 'running'")
      .run(planId);
    return Number(result.changes);
  }

  /** Nota do último step concluído do plano, para o handoff. */
  lastNote(planId: number): string | null {
    const row = this.db
      .prepare(
        "SELECT note FROM steps WHERE plan_id = ? AND status = 'done' AND note IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1",
      )
      .get(planId) as { note: string } | undefined;
    return row?.note ?? null;
  }

  startAttempt(input: {
    stepRowId: number;
    profileId: string;
    scaffold: string;
    provider: string;
    model: string;
    effort: string | null;
    mode: PermissionMode;
  }): { id: number; attemptNo: number } {
    const previous = this.db
      .prepare('SELECT COALESCE(MAX(attempt_no), 0) AS n FROM attempts WHERE step_row_id = ?')
      .get(input.stepRowId) as { n: number };
    const attemptNo = previous.n + 1;
    const result = this.db
      .prepare(
        `INSERT INTO attempts (step_row_id, attempt_no, profile_id, scaffold, provider, model, effort, mode, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.stepRowId, attemptNo, input.profileId, input.scaffold, input.provider, input.model, input.effort, input.mode, this.stamp());
    return { id: Number(result.lastInsertRowid), attemptNo };
  }

  finishAttempt(attemptId: number, input: AttemptFinish): void {
    this.db
      .prepare(
        `UPDATE attempts SET finished_at = ?, duration_ms = ?, exit_code = ?, timed_out = ?, outcome = ?,
           gate_exit_code = ?, tokens_total = ?, tokens_input = ?, tokens_cached_input = ?,
           tokens_output = ?, tokens_reasoning = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        this.stamp(),
        input.durationMs,
        input.exitCode,
        input.timedOut ? 1 : 0,
        input.outcome,
        input.gateExitCode,
        input.tokens?.total ?? null,
        input.tokens?.input ?? null,
        input.tokens?.cached_input ?? null,
        input.tokens?.output ?? null,
        input.tokens?.reasoning ?? null,
        input.error,
        attemptId,
      );
  }

  stepsOf(planId: number): StepRow[] {
    return this.db.prepare('SELECT * FROM steps WHERE plan_id = ? ORDER BY id').all(planId) as unknown as StepRow[];
  }

  attemptsOf(stepRowId: number): AttemptRow[] {
    return this.db
      .prepare('SELECT * FROM attempts WHERE step_row_id = ? ORDER BY attempt_no')
      .all(stepRowId) as unknown as AttemptRow[];
  }

  plans(): PlanRow[] {
    return this.db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as unknown as PlanRow[];
  }
}
