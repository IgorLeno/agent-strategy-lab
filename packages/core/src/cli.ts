/**
 * CLI headless do core: `asl run`, `asl status`, `asl ledger`.
 *
 * Ctrl+C uma vez pede pausa (o step corrente termina); duas vezes mata o step
 * agora, que fica `interrupted` no ledger.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import type { PermissionMode } from './adapters/invocation.js';
import { DEFAULT_CATALOG, parseCatalogYaml } from './catalog/catalog.js';
import type { GitMode } from './git/git.js';
import { Ledger } from './ledger/ledger.js';
import { PlanLoop, type Continuity, type LoopEvent } from './loop/loop.js';

const USAGE = `uso:
  asl run --project <dir> [--plan .asl/plan.md] [--mode plan|edit|auto]
          [--continuity step|phase|continuous] [--git direct|branch|worktree]
          [--gate "<comando>"] [--allow "<prefixo>"]... [--retries N]
          [--step-timeout-min N] [--catalog <arquivo.yaml>] [--ledger <arquivo.db>]
  asl status [--ledger <arquivo.db>]
  asl ledger [--ledger <arquivo.db>]`;

function defaultLedgerPath(): string {
  const base = process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'asl', 'ledger.db');
}

function oneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`--${flag} deve ser ${allowed.join(' | ')} (recebido: ${value})`);
}

function nonNegativeInt(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${flag} deve ser inteiro >= 0 (recebido: ${value})`);
  return parsed;
}

function describe(event: LoopEvent): string | null {
  switch (event.type) {
    case 'plan_started':
      return `plano em ${event.workspace.dir} (branch ${event.workspace.branch}, base ${event.workspace.baseSha.slice(0, 8)})`;
    case 'step_started':
      return `\n▶ ${event.step.id} [${event.step.tier}] ${event.step.title}`;
    case 'attempt_started':
      return `  tentativa ${event.attemptNo}: ${event.profileId} (${event.model})`;
    case 'transcript':
      return event.event?.type === 'message' && event.event.role === 'assistant'
        ? `  │ ${event.event.text.split('\n')[0]?.slice(0, 160) ?? ''}`
        : null;
    case 'attempt_finished':
      return event.outcome === 'success' ? null : `  ✗ ${event.outcome}: ${event.error?.split('\n')[0] ?? ''}`;
    case 'step_finished':
      return event.status === 'done' ? `  ✓ commit ${event.commitSha?.slice(0, 8) ?? '(sem mudança)'}` : '  ✗ step falhou';
    case 'paused':
      return `\n⏸ pausado: ${event.reason}${event.detail === null ? '' : ` — ${event.detail.split('\n')[0]}`}`;
    case 'plan_done':
      return '\n✔ plano concluído';
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      project: { type: 'string' },
      plan: { type: 'string', default: '.asl/plan.md' },
      mode: { type: 'string', default: 'edit' },
      continuity: { type: 'string', default: 'continuous' },
      git: { type: 'string', default: 'branch' },
      gate: { type: 'string' },
      allow: { type: 'string', multiple: true, default: [] },
      retries: { type: 'string', default: '2' },
      'step-timeout-min': { type: 'string', default: '60' },
      catalog: { type: 'string' },
      ledger: { type: 'string', default: defaultLedgerPath() },
    },
  });
  if (values.project === undefined) throw new Error('--project é obrigatório');
  const catalog =
    values.catalog === undefined ? DEFAULT_CATALOG : parseCatalogYaml(await readFile(values.catalog, 'utf8'));
  const settings = {
    repo: values.project,
    planRelPath: values.plan,
    mode: oneOf<PermissionMode>(values.mode, ['plan', 'edit', 'auto'], 'mode'),
    continuity: oneOf<Continuity>(values.continuity, ['step', 'phase', 'continuous'], 'continuity'),
    gitMode: oneOf<GitMode>(values.git, ['direct', 'branch', 'worktree'], 'git'),
    gateCommand: values.gate ?? null,
    allowedCommands: values.allow,
    maxRetries: nonNegativeInt(values.retries, 'retries'),
    stepTimeoutMs: Math.max(1, nonNegativeInt(values['step-timeout-min'], 'step-timeout-min')) * 60_000,
  };
  const ledger = new Ledger(values.ledger);
  const loop = new PlanLoop({
    ...settings,
    catalog,
    ledger,
    sourceEnv: process.env,
    onEvent: (event) => {
      const line = describe(event);
      if (line !== null) console.log(line);
    },
  });

  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts === 1) {
      console.log('\n(pausa pedida: o step corrente termina; Ctrl+C de novo mata agora)');
      loop.requestPause();
    } else {
      loop.abortNow();
    }
  });

  try {
    const result = await loop.run();
    return result.status === 'done' ? 0 : result.status === 'paused' ? 2 : 130;
  } finally {
    ledger.close();
  }
}

function status(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { ledger: { type: 'string', default: defaultLedgerPath() } } });
  const ledger = new Ledger(values.ledger);
  try {
    for (const plan of ledger.plans()) {
      const steps = ledger.stepsOf(plan.id);
      const done = steps.filter((step) => step.status === 'done').length;
      console.log(`${plan.status.padEnd(7)} ${plan.repo} ${plan.plan_rel_path} [${plan.slug}] ${done}/${steps.length} steps — ${plan.workspace_dir} (${plan.branch})`);
    }
  } finally {
    ledger.close();
  }
  return 0;
}

function ledgerReport(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { ledger: { type: 'string', default: defaultLedgerPath() } } });
  const ledger = new Ledger(values.ledger);
  try {
    for (const plan of ledger.plans()) {
      console.log(`\n${plan.repo} [${plan.slug}]`);
      for (const step of ledger.stepsOf(plan.id)) {
        for (const attempt of ledger.attemptsOf(step.id)) {
          const seconds = attempt.duration_ms === null ? '?' : (attempt.duration_ms / 1000).toFixed(1);
          console.log(
            `  ${step.step_id.padEnd(6)} #${attempt.attempt_no} ${attempt.model.padEnd(28)} ${String(attempt.outcome).padEnd(15)} ${seconds.padStart(7)}s  tokens=${attempt.tokens_total ?? '?'}`,
          );
        }
      }
    }
  } finally {
    ledger.close();
  }
  return 0;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'run') return run(rest);
  if (command === 'status') return status(rest);
  if (command === 'ledger') return ledgerReport(rest);
  console.error(USAGE);
  return 64;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
