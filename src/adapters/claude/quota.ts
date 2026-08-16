import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  QuotaObservationStatus,
  QuotaReasonCode,
  QuotaUsage,
  type QuotaWindow,
} from '../../schemas/index.js';

export const CLAUDE_QUOTA_FILE_NAME = 'quota-usage.json';
export const CLAUDE_QUOTA_PROMPT = '/usage';
export const CLAUDE_QUOTA_PROVENANCE = 'claude_print_usage_v1';
export const CLAUDE_QUOTA_MAX_BUDGET_USD = '0.000001';

const DISPLAY_TOLERANCE_SECONDS = 60;
const RESET_LABEL = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?(am|pm) \(([^()]+)\)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const CUMULATIVE_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335] as const;

export interface ClaudeQuotaWindowReading {
  readonly used_pct: number;
  /** Rótulo cru do reset: é a identidade observável da instância da janela. */
  readonly reset_label: string;
}

export interface ClaudeQuotaReading {
  readonly five_hour: ClaudeQuotaWindowReading;
  readonly seven_day_all_models: ClaudeQuotaWindowReading;
}

export interface ClaudeQuotaProbeOutcome {
  readonly status: QuotaObservationStatus;
  readonly reading: ClaudeQuotaReading | null;
  readonly reason: string | null;
  readonly provenance: string;
}

export type ClaudeQuotaCommandRunner = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
) => Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }>;

export interface ProbeClaudeQuotaOptions {
  readonly binary: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Injetado nos testes para que nenhum processo Claude real seja iniciado. */
  readonly runner?: ClaudeQuotaCommandRunner;
}

/** Invocation local e limitada usada exclusivamente para ler `/usage`. */
export function buildClaudeQuotaInvocation(binary: string): readonly string[] {
  return [
    binary,
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-budget-usd',
    CLAUDE_QUOTA_MAX_BUDGET_USD,
    '--tools',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    CLAUDE_QUOTA_PROMPT,
  ];
}

/**
 * Executa o probe e só aceita a leitura quando o result prova custo e uso de
 * modelo zero. Ausência de qualquer evidência vira UNAVAILABLE, nunca 0%.
 */
export async function probeClaudeQuota(
  options: ProbeClaudeQuotaOptions,
): Promise<ClaudeQuotaProbeOutcome> {
  const argv = buildClaudeQuotaInvocation(options.binary);
  const runner = options.runner ?? spawnClaudeQuotaCommand;
  let result: Awaited<ReturnType<ClaudeQuotaCommandRunner>>;
  try {
    result = await runner(argv[0] as string, argv.slice(1), options.env, options.cwd);
  } catch (error) {
    return unavailable(`probe falhou: ${errorMessage(error)}`, 'no_result');
  }

  const payload = readResult(result.stdout);
  if (payload === null) {
    const stderr = firstLine(result.stderr);
    return unavailable(
      `probe não devolveu result legível (exit ${result.exitCode ?? 'null'})${stderr === '' ? '' : `: ${stderr}`}`,
      'no_result',
    );
  }

  const resultText = typeof payload['result'] === 'string' ? payload['result'] : null;
  const digest = resultText === null ? 'no_result_text' : sha256(resultText);
  const violations = zeroInferenceViolations(payload, result.exitCode);
  if (violations.length > 0) {
    return unavailable(`probe não provou inferência zero: ${violations.join(', ')}`, digest);
  }

  const reading = resultText === null ? null : parseClaudeQuotaText(resultText);
  if (reading === null) {
    return unavailable('texto de /usage não contém as duas janelas esperadas', digest);
  }

  return {
    status: QuotaObservationStatus.OBSERVED,
    reading,
    reason: null,
    provenance: `${CLAUDE_QUOTA_PROVENANCE}:sha256:${digest}`,
  };
}

/** Converte os dois snapshots no contrato provider-neutral M44. */
export function buildClaudeQuotaUsage(
  before: ClaudeQuotaProbeOutcome,
  after: ClaudeQuotaProbeOutcome,
): QuotaUsage {
  const observed = before.reading !== null || after.reading !== null;
  const observationProvenance = JSON.stringify({
    source: CLAUDE_QUOTA_PROVENANCE,
    before: { provenance: before.provenance, reason: before.reason },
    after: { provenance: after.provenance, reason: after.reason },
  });

  if (!observed) {
    return QuotaUsage.parse({
      provider: 'claude',
      observation: {
        status: QuotaObservationStatus.UNAVAILABLE,
        reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
        provenance: observationProvenance,
      },
      windows: [],
    });
  }

  const windows = [
    measureWindow('five_hour', before.reading?.five_hour ?? null, after.reading?.five_hour ?? null),
    measureWindow(
      'seven_day_all_models',
      before.reading?.seven_day_all_models ?? null,
      after.reading?.seven_day_all_models ?? null,
    ),
  ];

  return QuotaUsage.parse({
    provider: 'claude',
    observation: {
      status: QuotaObservationStatus.OBSERVED,
      reason_code:
        before.reading !== null && after.reading !== null
          ? QuotaReasonCode.OK
          : QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
      provenance: observationProvenance,
    },
    windows,
  });
}

/** Grava antes da selagem de execution/ e recusa sobrescrever evidência. */
export async function writeClaudeQuotaUsage(executionDir: string, usage: QuotaUsage): Promise<string> {
  const validated = QuotaUsage.parse(usage);
  const target = path.join(executionDir, CLAUDE_QUOTA_FILE_NAME);
  await writeFile(target, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return target;
}

export function parseClaudeQuotaText(text: string): ClaudeQuotaReading | null {
  const fiveHour = readWindow(text, /^\s*Current session:\s*([\d.]+)%\s*used\s*·\s*resets\s+(.+?)\s*$/m);
  const sevenDay = readWindow(
    text,
    /^\s*Current week \(all models\):\s*([\d.]+)%\s*used\s*·\s*resets\s+(.+?)\s*$/m,
  );
  return fiveHour === null || sevenDay === null
    ? null
    : { five_hour: fiveHour, seven_day_all_models: sevenDay };
}

function measureWindow(
  windowId: string,
  before: ClaudeQuotaWindowReading | null,
  after: ClaudeQuotaWindowReading | null,
): QuotaWindow {
  const provenance = JSON.stringify({
    source: CLAUDE_QUOTA_PROVENANCE,
    before_reset_label: before?.reset_label ?? null,
    after_reset_label: after?.reset_label ?? null,
  });
  if (before === null || after === null) {
    return {
      window_id: windowId,
      before_used_pct: before?.used_pct ?? null,
      after_used_pct: after?.used_pct ?? null,
      consumed_pp: null,
      same_window: null,
      reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
      provenance,
    };
  }

  const identity = compareResetLabels(before.reset_label, after.reset_label);
  if (identity === 'unparseable') {
    return {
      window_id: windowId,
      before_used_pct: before.used_pct,
      after_used_pct: after.used_pct,
      consumed_pp: null,
      same_window: false,
      reason_code: QuotaReasonCode.WINDOW_LABEL_UNPARSEABLE,
      provenance,
    };
  }
  if (identity === 'different') {
    return {
      window_id: windowId,
      before_used_pct: before.used_pct,
      after_used_pct: after.used_pct,
      consumed_pp: null,
      same_window: false,
      reason_code: QuotaReasonCode.RATE_LIMIT_WINDOW_RESET,
      provenance,
    };
  }

  const consumed = Number((after.used_pct - before.used_pct).toFixed(6));
  return {
    window_id: windowId,
    before_used_pct: before.used_pct,
    after_used_pct: after.used_pct,
    consumed_pp: consumed,
    same_window: true,
    reason_code: consumed < 0 ? QuotaReasonCode.OBSERVED_DELTA_NEGATIVE : QuotaReasonCode.OK,
    provenance,
  };
}

function compareResetLabels(before: string, after: string): 'same' | 'different' | 'unparseable' {
  if (before === after) return 'same';
  const left = parseResetLabel(before);
  const right = parseResetLabel(after);
  if (left === null || right === null) return 'unparseable';
  if (left.timezone !== right.timezone) return 'different';
  return Math.abs(left.secondsInYear - right.secondsInYear) <= DISPLAY_TOLERANCE_SECONDS
    ? 'same'
    : 'different';
}

function parseResetLabel(label: string): { readonly timezone: string; readonly secondsInYear: number } | null {
  const match = RESET_LABEL.exec(label.trim());
  if (match === null) return null;
  const month = MONTHS.indexOf(match[1] as (typeof MONTHS)[number]);
  const day = Number(match[2]);
  const hour12 = Number(match[3]);
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  const timezone = match[6]?.trim() ?? '';
  if (month < 0 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || minute > 59 || timezone === '') {
    return null;
  }
  const hour = match[5] === 'am' ? hour12 % 12 : (hour12 % 12) + 12;
  const days = (CUMULATIVE_DAYS[month] as number) + day - 1;
  return { timezone, secondsInYear: ((days * 24 + hour) * 60 + minute) * 60 };
}

function readWindow(text: string, pattern: RegExp): ClaudeQuotaWindowReading | null {
  const match = pattern.exec(text);
  const usedPct = Number(match?.[1]);
  const resetLabel = match?.[2]?.trim() ?? '';
  return Number.isFinite(usedPct) && resetLabel !== '' ? { used_pct: usedPct, reset_label: resetLabel } : null;
}

function zeroInferenceViolations(payload: Record<string, unknown>, exitCode: number | null): string[] {
  const violations: string[] = [];
  if (exitCode !== 0) violations.push(`exit_code=${exitCode ?? 'null'}`);
  if (payload['is_error'] === true) violations.push('is_error=true');
  if (payload['total_cost_usd'] !== 0) violations.push('total_cost_usd não é zero');
  if (payload['num_turns'] !== 0) violations.push('num_turns não é zero');
  const usage = payload['usage'];
  if (!isRecord(usage)) violations.push('usage ausente');
  else collectNonZeroNumbers(usage, 'usage', violations);
  const modelUsage = payload['modelUsage'] ?? payload['model_usage'];
  if (!isRecord(modelUsage) || Object.keys(modelUsage).length > 0) violations.push('modelUsage não é vazio');
  return violations;
}

function collectNonZeroNumbers(value: unknown, at: string, found: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value !== 0) found.push(`${at} não é zero`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectNonZeroNumbers(item, `${at}[${index}]`, found));
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) collectNonZeroNumbers(nested, `${at}.${key}`, found);
  }
}

function readResult(stdout: string): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  for (const candidate of [stdout.trim(), ...stdout.split('\n').map((line) => line.trim())]) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) result = parsed;
    } catch {
      // Ruído da CLI não torna uma linha JSON válida menos confiável.
    }
  }
  return result;
}

const spawnClaudeQuotaCommand: ClaudeQuotaCommandRunner = (command, args, env, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', (error) => resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}` }));
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });

function unavailable(reason: string, evidence: string): ClaudeQuotaProbeOutcome {
  return {
    status: QuotaObservationStatus.UNAVAILABLE,
    reading: null,
    reason,
    provenance: `${CLAUDE_QUOTA_PROVENANCE}:${evidence}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function firstLine(value: string): string {
  return (value.trim().split('\n')[0] ?? '').slice(0, 200);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
