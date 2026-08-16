import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeQuotaInvocation,
  buildClaudeQuotaUsage,
  probeClaudeQuota,
  writeClaudeQuotaUsage,
  type ClaudeQuotaCommandRunner,
  type ClaudeQuotaProbeOutcome,
} from '../../src/adapters/index.js';
import { QuotaObservationStatus, QuotaReasonCode, QuotaUsage } from '../../src/schemas/index.js';

const FIVE_HOUR = 'Aug 16, 7am (America/Sao_Paulo)';
const SEVEN_DAY = 'Aug 18, 3am (America/Sao_Paulo)';
const roots: string[] = [];

function usageText(fiveHour: number, fiveHourReset = FIVE_HOUR, week = 70, weekReset = SEVEN_DAY): string {
  return `Current session: ${fiveHour}% used · resets ${fiveHourReset}\n` +
    `Current week (all models): ${week}% used · resets ${weekReset}\n`;
}

function result(text: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    is_error: false,
    total_cost_usd: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    result: text,
    ...overrides,
  });
}

function fakeRunner(...stdout: string[]): { runner: ClaudeQuotaCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: ClaudeQuotaCommandRunner = async (command, args) => {
    calls.push([command, ...args]);
    return { exitCode: 0, stdout: stdout.shift() ?? '', stderr: '' };
  };
  return { runner, calls };
}

function observed(fiveHour: number, reset = FIVE_HOUR): ClaudeQuotaProbeOutcome {
  return {
    status: QuotaObservationStatus.OBSERVED,
    reading: {
      five_hour: { used_pct: fiveHour, reset_label: reset },
      seven_day_all_models: { used_pct: 70, reset_label: SEVEN_DAY },
    },
    reason: null,
    provenance: 'fixture',
  };
}

const unavailable: ClaudeQuotaProbeOutcome = {
  status: QuotaObservationStatus.UNAVAILABLE,
  reading: null,
  reason: 'fixture indisponível',
  provenance: 'fixture:unavailable',
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Claude quota probe', () => {
  it('usa invocation limitada e um runner fake, sem consumo real', async () => {
    const fake = fakeRunner(result(usageText(29)));
    const outcome = await probeClaudeQuota({ binary: 'claude-fixture', env: {}, cwd: '/', runner: fake.runner });

    expect(outcome.status).toBe(QuotaObservationStatus.OBSERVED);
    expect(outcome.reading?.five_hour.used_pct).toBe(29);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual(buildClaudeQuotaInvocation('claude-fixture'));
    expect(fake.calls[0]).toContain('--max-budget-usd');
  });

  it('não aceita ausência nem inferência desconhecida como leitura zero', async () => {
    const missing = fakeRunner('not-json');
    const unsafe = fakeRunner(result(usageText(0), { total_cost_usd: 0.01 }));

    const noResult = await probeClaudeQuota({ binary: 'fixture', env: {}, cwd: '/', runner: missing.runner });
    const spent = await probeClaudeQuota({ binary: 'fixture', env: {}, cwd: '/', runner: unsafe.runner });

    expect(noResult).toMatchObject({ status: QuotaObservationStatus.UNAVAILABLE, reading: null });
    expect(spent).toMatchObject({ status: QuotaObservationStatus.UNAVAILABLE, reading: null });
    expect(spent.reason).toContain('inferência zero');
  });
});

describe('QuotaUsage Claude', () => {
  it('calcula delta somente dentro da mesma janela e preserva identidade/provenance', () => {
    const usage = buildClaudeQuotaUsage(observed(29), observed(35));
    const fiveHour = usage.windows.find((window) => window.window_id === 'five_hour');

    expect(QuotaUsage.parse(usage)).toEqual(usage);
    expect(fiveHour).toMatchObject({
      before_used_pct: 29,
      after_used_pct: 35,
      consumed_pp: 6,
      same_window: true,
      reason_code: QuotaReasonCode.OK,
    });
    expect(fiveHour?.provenance).toContain(FIVE_HOUR);
  });

  it('reset invalida delta; rótulos desconhecidos falham fechados', () => {
    const reset = buildClaudeQuotaUsage(observed(97), observed(3, 'Aug 16, 12pm (America/Sao_Paulo)'));
    const unknown = buildClaudeQuotaUsage(observed(40), observed(44, 'soon'));

    expect(reset.windows[0]).toMatchObject({
      before_used_pct: 97,
      after_used_pct: 3,
      consumed_pp: null,
      same_window: false,
      reason_code: QuotaReasonCode.RATE_LIMIT_WINDOW_RESET,
    });
    expect(unknown.windows[0]).toMatchObject({
      consumed_pp: null,
      same_window: false,
      reason_code: QuotaReasonCode.WINDOW_LABEL_UNPARSEABLE,
    });
  });

  it('probe parcial preserva before sem inventar after ou consumed_pp', () => {
    const usage = buildClaudeQuotaUsage(observed(41), unavailable);

    expect(usage.observation).toMatchObject({
      status: QuotaObservationStatus.OBSERVED,
      reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
    });
    expect(usage.windows[0]).toMatchObject({
      before_used_pct: 41,
      after_used_pct: null,
      consumed_pp: null,
      same_window: null,
      reason_code: QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
    });
  });

  it('dois probes indisponíveis produzem UNAVAILABLE com windows vazio', () => {
    const usage = buildClaudeQuotaUsage(unavailable, unavailable);

    expect(usage.observation.status).toBe(QuotaObservationStatus.UNAVAILABLE);
    expect(usage.observation.reason_code).toBe(QuotaReasonCode.MEASUREMENT_UNAVAILABLE);
    expect(usage.observation.provenance).toContain('fixture indisponível');
    expect(usage.windows).toEqual([]);
  });

  it('persiste execution/quota-usage.json válido sem sobrescrever evidência', async () => {
    const executionDir = await mkdtemp(path.join(os.tmpdir(), 'agentlab-claude-quota-'));
    roots.push(executionDir);
    const usage = buildClaudeQuotaUsage(observed(10), observed(12));

    const written = await writeClaudeQuotaUsage(executionDir, usage);
    expect(path.basename(written)).toBe('quota-usage.json');
    expect(QuotaUsage.parse(JSON.parse(await readFile(written, 'utf8')))).toEqual(usage);
    await expect(writeClaudeQuotaUsage(executionDir, usage)).rejects.toMatchObject({ code: 'EEXIST' });
  });
});
