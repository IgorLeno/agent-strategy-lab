import { copyFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { headSha } from '../../dev/lib/git.js';
import {
  detailIteration,
  summarizeIteration,
  summarizeSubscriptionUsage,
  summarizeUsageWindow,
  type IterationInput,
} from '../../dev/lib/orchestrate-report.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { readLaunchRecord } from '../../dev/lib/records.js';
import type {
  LaunchRecord,
  SubscriptionUsage,
  SubscriptionUsageWindow,
} from '../../dev/lib/schemas.js';
import { buildInitialState, ensureRuntimeDirs, writeState } from '../../dev/lib/state.js';
import { REPO_ROOT, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

/**
 * Contrato de APRESENTAÇÃO dos comandos operacionais.
 *
 * A saída padrão existe para acompanhar uma implementação: perfil efetivo,
 * veredito, tempo do worker, equivalência em dólar e quota. O detalhe continua
 * inteiro nos records — `--verbose` só o traz de volta para a tela.
 *
 * NENHUM teste deste arquivo chama provider de verdade: a CLI Claude é o
 * fixture que já imita `auth status`, o probe `/usage` e o transporte
 * `stream-json`.
 */

const STREAM_PROFILE_ID = 'claude-output-stream-v1';
const FAKE_CLI_DIR = path.join(REPO_ROOT, 'fixtures', 'fake-clis');

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let originalPath: string | undefined;

/** Perfil de assinatura com modelo e effort fixados — as dimensões do experimento. */
const STREAM_PROFILE_YAML = `
id: ${STREAM_PROFILE_ID}
agent: claude
billing_mode: subscription_only
environment_mode: real-world
commit_owner: orchestrator
official_validation_owner: orchestrator
worker_validation_policy: targeted
argv:
  - claude-provider
  - --print
  - --output-format
  - stream-json
  - --verbose
  - --model
  - claude-sonnet-5
  - --effort
  - medium
prompt_delivery: argv
forbidden_flags:
  - --bare
env_allowlist:
  - PATH
  - HOME
  - LANG
  - LC_ALL
env_extra:
  AGENTLAB_FAKE_STREAM: same-window
control_markers: {}
notes:
  - 'Fixture: imita transporte, credencial e probe; não fala com provider nenhum.'
`;

async function writeProfile(id: string, lines: readonly string[]): Promise<void> {
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${id}.yaml`),
    `${lines.join('\n')}\n`,
    'utf8',
  );
}

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  await copyFile(
    path.join(REPO_ROOT, 'fixtures', 'fake-claude-stream.mjs'),
    path.join(sandbox.root, 'fixtures', 'fake-claude-stream.mjs'),
  );
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${STREAM_PROFILE_ID}.yaml`),
    STREAM_PROFILE_YAML,
    'utf8',
  );
  await runGit(sandbox.root, ['add', '-A']);
  await runGit(sandbox.root, ['commit', '-q', '-m', 'fixture do provider']);

  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(
    paths,
    buildInitialState(loaded.plan, loaded.planSha256, {
      baselineSha: await headSha(paths.repoRoot),
    }),
  );

  originalPath = process.env['PATH'];
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

function devEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    AGENTLAB_DEV_DIR: sandbox.devDir,
    PATH: `${FAKE_CLI_DIR}:${originalPath ?? ''}`,
    ...extra,
  };
}

function doctor(args: readonly string[]) {
  return runDevCli('dev-doctor.ts', ['--repo', sandbox.root, ...args]);
}

function orchestrate(profileId: string, extra: readonly string[] = [], mode?: string) {
  return runDevCli(
    'dev-orchestrate.ts',
    ['--repo', sandbox.root, '--profile', profileId, ...extra],
    mode === undefined ? devEnv() : devEnv({ AGENTLAB_FAKE_MODE: mode }),
  );
}

// ---------------------------------------------------------------------------
// dev-doctor
// ---------------------------------------------------------------------------

describe('dev-doctor: saída padrão enxuta', () => {
  it('não despeja os checks que passaram', async () => {
    const result = await doctor(['--profile', 'fake-worker-v1']);
    expect(result.exitCode, result.stderr).toBe(0);

    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).not.toHaveProperty('checks');
    // Nem por outro nome: nenhum check PASS atravessa a saída padrão.
    expect(result.stdout).not.toContain('"status"');
    expect(result.stdout).not.toContain('PASS');
    expect(Object.keys(report).sort()).toEqual([
      'agent',
      'billing_mode',
      'credential_source',
      'failures',
      'model',
      'ok',
      'profile_id',
      'reasoning_effort',
      'warnings',
    ]);
  });

  it('mantém o warning do ambiente sem --verbose', async () => {
    const result = await doctor(['--profile', 'fake-worker-v1']);
    const report = JSON.parse(result.stdout) as { ok: boolean; warnings: string[] };

    expect(report.ok).toBe(true);
    // WARN é fato do ambiente: some junto com os PASS e ninguém mais o vê.
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.join('\n')).toMatch(/HOME/);
  });

  it('mantém o detalhe acionável do FAIL sem --verbose', async () => {
    await writeProfile('quebrado-v1', [
      'id: quebrado-v1',
      'agent: claude',
      'billing_mode: subscription_only',
      "argv: [node, '--print']",
      'prompt_delivery: argv',
      'forbidden_flags: []',
      'env_allowlist: [PATH]',
    ]);

    const result = await doctor(['--profile', 'quebrado-v1']);
    expect(result.exitCode).toBe(3);

    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failures: { name: string; status: string; detail: string }[];
    };
    expect(report.ok).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
    for (const failure of report.failures) {
      expect(failure.status).toBe('FAIL');
      // Descobrir POR QUE falhou não pode exigir uma segunda execução.
      expect(failure.detail.length).toBeGreaterThan(0);
    }
  });

  it('--verbose devolve o relatório inteiro, com os checks', async () => {
    const result = await doctor(['--profile', 'fake-worker-v1', '--verbose']);
    expect(result.exitCode, result.stderr).toBe(0);

    const report = JSON.parse(result.stdout) as {
      checks: { name: string; status: string }[];
      warnings: string[];
      failures: unknown[];
      model: string;
    };
    expect(report.checks.length).toBeGreaterThan(5);
    expect(report.checks.some((entry) => entry.status === 'PASS')).toBe(true);
    // Verbose ACRESCENTA: o resumo continua legível no mesmo payload.
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.failures).toEqual([]);
    expect(report.model).toBe('not_applicable');
  });

  it('--verbose antes do positional não engole o nome do perfil', async () => {
    const result = await doctor(['--verbose', 'fake-worker-v1']);
    expect(result.exitCode, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { profile_id: string }).profile_id).toBe('fake-worker-v1');
  });
});

// ---------------------------------------------------------------------------
// dev-orchestrate — projeções puras
// ---------------------------------------------------------------------------

function usageWindow(patch: Partial<SubscriptionUsageWindow> = {}): SubscriptionUsageWindow {
  return {
    before_used_pct: 82,
    after_used_pct: 87,
    before_reset_label: 'Aug 9, 7am',
    after_reset_label: 'Aug 9, 7am',
    same_window: true,
    consumed_pp: 5,
    window_match_method: 'exact',
    reason_code: 'OK',
    ...patch,
  };
}

const USAGE: SubscriptionUsage = {
  source: 'claude_print_usage',
  probe_contract: {
    before: {
      available: true,
      zero_inference_verified: true,
      reason_code: 'OK',
      reason: null,
      result_text_sha256: 'a'.repeat(64),
      command: 'claude /usage',
      exit_code: 0,
    },
    after: {
      available: true,
      zero_inference_verified: true,
      reason_code: 'OK',
      reason: null,
      result_text_sha256: 'b'.repeat(64),
      command: 'claude /usage',
      exit_code: 0,
    },
  },
  five_hour: usageWindow(),
  seven_day_all_models: usageWindow({ before_used_pct: 74, after_used_pct: 74, consumed_pp: 0 }),
};

function launchRecord(patch: Partial<LaunchRecord> = {}): LaunchRecord {
  return {
    schema_version: 1,
    task_id: 'T1',
    profile_id: STREAM_PROFILE_ID,
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    argv: ['claude', '--print'],
    process: { pid: 1234, pgid: 1234, started_at: '2026-08-09T00:00:00.000Z', command: 'claude' },
    launch_id: '11111111-2222-3333-4444-555555555555',
    survivors_killed: [],
    survivors_remaining: [],
    started_at: '2026-08-09T00:00:00.000Z',
    finished_at: '2026-08-09T00:02:48.300Z',
    duration_ms: 168_300,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: {
      mode: 'subscription_only',
      credential_source: 'claude_subscription_oauth',
      included_allowance_consumed: true,
      provider_estimated_api_equivalent_usd: 0.9016,
      actual_incremental_charge_usd: null,
      authoritative_billing_verified: false,
    },
    rate_limit_observations: null,
    subscription_usage: USAGE,
    provider_failure: null,
    ...patch,
  } as LaunchRecord;
}

function iterationInput(patch: Partial<IterationInput> = {}): IterationInput {
  return {
    taskId: 'M38',
    attempt: 1,
    launch: 'FINISHED',
    close: 'PASS',
    reason: 'validações oficiais passaram',
    record: launchRecord(),
    ...patch,
  };
}

describe('resumo da iteração: quota, tempo e dólar', () => {
  it('mostra onde a janela está e quanto ela andou', () => {
    const summary = summarizeIteration(iterationInput());

    expect(summary.subscription_usage).toEqual({
      five_hour: { current_used_pct: 87, consumed_pp: 5 },
      seven_day_all_models: { current_used_pct: 74, consumed_pp: 0 },
    });
    // Tempo do worker, não do ciclo inteiro do orquestrador.
    expect(summary.implementation_duration_ms).toBe(168_300);
    expect(summary.implementation_duration_seconds).toBe(168.3);
    expect(summary.api_equivalent_usd).toBe(0.9016);
  });

  it('medição indisponível fica null com o motivo, sem número inventado', () => {
    const window = summarizeUsageWindow(
      usageWindow({
        after_used_pct: null,
        consumed_pp: null,
        reason_code: 'MEASUREMENT_UNAVAILABLE',
      }),
    );
    expect(window).toEqual({
      current_used_pct: null,
      consumed_pp: null,
      reason_code: 'MEASUREMENT_UNAVAILABLE',
    });
  });

  it('perfil sem probe não ganha quota fabricada', () => {
    expect(summarizeSubscriptionUsage(null)).toBeNull();
    const summary = summarizeIteration(
      iterationInput({ record: launchRecord({ subscription_usage: null }) }),
    );
    expect(summary.subscription_usage).toBeNull();
  });

  it('falha terminal do provider aparece resumida, sem --verbose', () => {
    const summary = summarizeIteration(
      iterationInput({
        launch: 'INFRA_ERROR',
        close: null,
        reason: 'falha terminal do provider',
        record: launchRecord({
          provider_failure: {
            is_error: true,
            terminal_reason: 'api_error',
            api_error_status: 500,
            subtype: 'error_during_execution',
            num_turns: 0,
            message: 'API Error: Unable to connect to API (ENOTFOUND)',
            message_sha256: 'c'.repeat(64),
            signals: ['is_error', 'subtype'],
          },
        }),
      }),
    );

    expect(summary.result).toBe('INFRA_ERROR');
    expect(summary.provider_failure).toEqual({
      terminal_reason: 'api_error',
      api_error_status: 500,
      message: 'API Error: Unable to connect to API (ENOTFOUND)',
    });
    // O resumo não carrega hash nem lista de sinais: isso está no record.
    expect(summary.provider_failure).not.toHaveProperty('message_sha256');
    expect(summary.provider_failure).not.toHaveProperty('signals');
  });

  it('--verbose acrescenta sem redefinir: os campos do resumo continuam iguais', () => {
    const input = iterationInput();
    const summary = summarizeIteration(input);
    const detail = detailIteration(input);

    for (const [key, value] of Object.entries(summary)) {
      expect(detail[key], key).toEqual(value);
    }
    expect(detail['launch']).toBe('FINISHED');
    expect(detail['close']).toBe('PASS');
    expect(detail['subscription_usage_record']).toEqual(USAGE);
    expect(detail['provider_estimated_api_equivalent_usd']).toBe(0.9016);
  });

  it('REPAIR manual não recebe metadados de reparo automático', () => {
    const detail = detailIteration(iterationInput({ attemptKind: 'REPAIR' }));

    expect(detail['attempt_kind']).toBe('REPAIR');
    expect(detail).not.toHaveProperty('automatic_repair');
    expect(detail).not.toHaveProperty('repair_source_attempt');
    expect(detail).not.toHaveProperty('automatic_repair_consumed');
  });

  it('REPAIR automático reporta somente o fato e o attempt fonte', () => {
    const detail = detailIteration(
      iterationInput({
        attemptKind: 'REPAIR',
        automaticRepair: true,
        repairSourceAttempt: 1,
      }),
    );

    expect(detail).toMatchObject({
      automatic_repair: true,
      repair_source_attempt: 1,
    });
    expect(detail).not.toHaveProperty('automatic_repair_consumed');
  });

  it('REPAIR automático com INFRA_ERROR não inventa consumo capability', () => {
    const detail = detailIteration(
      iterationInput({
        attemptKind: 'REPAIR',
        automaticRepair: true,
        repairSourceAttempt: 1,
        launch: 'INFRA_ERROR',
        close: null,
      }),
    );

    expect(detail['automatic_repair']).toBe(true);
    expect(detail).not.toHaveProperty('automatic_repair_consumed');
  });
});

// ---------------------------------------------------------------------------
// dev-orchestrate — CLI
// ---------------------------------------------------------------------------

describe('dev-orchestrate: saída padrão orientada ao resultado', () => {
  it('reporta perfil, veredito, tempo, dólar e quota da assinatura', async () => {
    const result = await orchestrate(STREAM_PROFILE_ID, ['--max-iterations', '1']);

    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      reason: string;
      profile_id: string;
      agent: string;
      model: string;
      reasoning_effort: string;
      iteration_count: number;
      iterations: {
        task_id: string;
        attempt: number;
        result: string;
        reason: string;
        implementation_duration_ms: number;
        implementation_duration_seconds: number;
        api_equivalent_usd: number | null;
        subscription_usage: {
          five_hour: { current_used_pct: number | null; consumed_pp: number | null };
          seven_day_all_models: { current_used_pct: number | null; consumed_pp: number | null };
        } | null;
      }[];
      total_api_equivalent_usd: number | null;
    };

    expect(output.profile_id).toBe(STREAM_PROFILE_ID);
    expect(output.agent).toBe('claude');
    expect(output.model).toBe('claude-sonnet-5');
    expect(output.reasoning_effort).toBe('medium');
    expect(output.stopped_by.length).toBeGreaterThan(0);
    expect(output.iteration_count).toBe(1);

    const [iteration] = output.iterations;
    expect(iteration?.task_id).toBe('T1');
    expect(iteration?.attempt).toBe(1);
    expect(iteration?.result.length).toBeGreaterThan(0);
    expect(iteration?.reason.length).toBeGreaterThan(0);
    expect(iteration?.implementation_duration_ms).toBeGreaterThan(0);
    expect(iteration?.implementation_duration_seconds).toBeGreaterThan(0);
    expect(iteration?.api_equivalent_usd).toBeCloseTo(0.4231, 4);
    expect(output.total_api_equivalent_usd).toBeCloseTo(0.4231, 4);
    // O fixture responde o mesmo /usage antes e depois: janela parada, delta 0.
    expect(iteration?.subscription_usage).toEqual({
      five_hour: { current_used_pct: 95, consumed_pp: 0 },
      seven_day_all_models: { current_used_pct: 67, consumed_pp: 0 },
    });
  }, 60_000);

  it('não despeja probe, hashes, rate limit bruto nem internals de processo', async () => {
    const result = await orchestrate(STREAM_PROFILE_ID, ['--max-iterations', '1']);

    for (const noise of [
      'probe_contract',
      'result_text_sha256',
      'zero_inference_verified',
      'before_reset_label',
      'window_match_method',
      'rate_limit_observations',
      'survivors_remaining',
      'launch_id',
      'message_sha256',
      'validation_results',
    ]) {
      expect(result.stdout, noise).not.toContain(noise);
    }

    const iteration = (JSON.parse(result.stdout) as { iterations: Record<string, unknown>[] })
      .iterations[0] as Record<string, unknown>;
    expect(iteration).not.toHaveProperty('process');
    expect(iteration).not.toHaveProperty('billing');
    expect(iteration).not.toHaveProperty('subscription_usage_record');
  }, 60_000);

  it('--verbose preserva o detalhe que a saída padrão deixa de fora', async () => {
    const result = await orchestrate(STREAM_PROFILE_ID, ['--max-iterations', '1', '--verbose']);

    const output = JSON.parse(result.stdout) as {
      reasoning_effort_source: string;
      total_provider_estimated_api_equivalent_usd: number | null;
      iterations: Record<string, unknown>[];
    };
    expect(output.reasoning_effort_source).toBe('claude_effort_flag');
    expect(output.total_provider_estimated_api_equivalent_usd).toBeCloseTo(0.4231, 4);

    const iteration = output.iterations[0] as Record<string, unknown>;
    expect(iteration['launch']).toBe('FINISHED');
    expect(iteration).toHaveProperty('close');
    expect(iteration).toHaveProperty('billing');
    expect(iteration).toHaveProperty('rate_limit_observations');
    expect(iteration).toHaveProperty('process');
    expect(iteration).toHaveProperty('exit_code');
    // O resumo continua no mesmo payload, com o mesmo significado.
    expect(iteration).toHaveProperty('api_equivalent_usd');
    expect(iteration['subscription_usage']).toEqual({
      five_hour: { current_used_pct: 95, consumed_pp: 0 },
      seven_day_all_models: { current_used_pct: 67, consumed_pp: 0 },
    });
  }, 60_000);

  it('perfil não-Claude continua válido, com quota nula', async () => {
    const result = await orchestrate('fake-worker-v1', ['--max-iterations', '1'], 'success');

    const output = JSON.parse(result.stdout) as {
      agent: string;
      model: string;
      iterations: { result: string; subscription_usage: null; api_equivalent_usd: number | null }[];
    };
    expect(output.agent).toBe('fake');
    expect(output.model).toBe('not_applicable');
    expect(output.iterations[0]?.result).toBe('PASS');
    expect(output.iterations[0]?.subscription_usage).toBeNull();
  }, 60_000);

  it('várias tarefas viram uma lista compacta, uma linha de veredito por tarefa', async () => {
    const result = await orchestrate('fake-worker-v1', ['--max-iterations', '2'], 'success');
    expect(result.exitCode, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      iteration_count: number;
      iterations: { task_id: string; attempt: number; result: string }[];
    };
    expect(output.iteration_count).toBe(2);
    expect(output.iterations.map((entry) => entry.task_id)).toEqual(['T1', 'T2']);
    expect(output.iterations.every((entry) => entry.result === 'PASS')).toBe(true);
    expect(output.iterations.every((entry) => entry.attempt === 1)).toBe(true);
  }, 60_000);

  it('PENDING mostra o motivo sem --verbose', async () => {
    const result = await orchestrate('fake-worker-v1', ['--max-iterations', '1'], 'no-commit');
    expect(result.exitCode).toBe(9);

    const output = JSON.parse(result.stdout) as {
      stopped_by: string;
      reason: string;
      iterations: { result: string; reason: string; attempt: number }[];
    };
    expect(output.stopped_by).toBe('PENDING');
    expect(output.reason.length).toBeGreaterThan(0);
    expect(output.iterations[0]?.result).toBe('PENDING');
    expect(output.iterations[0]?.reason.length).toBeGreaterThan(0);
    expect(output.iterations[0]?.attempt).toBe(1);
  }, 60_000);

  it('a escolha entre padrão e --verbose não muda nada gravado', async () => {
    const compact = await orchestrate('fake-worker-v1', ['--max-iterations', '1'], 'success');
    expect(compact.exitCode).toBe(0);
    const compactRecord = await readLaunchRecord(paths, 'T1');

    // Segundo sandbox: mesmo cenário, mesma tarefa, só o modo de saída muda.
    const other = await makeSandboxRepo();
    const otherPaths = resolveHarnessPaths(other.root);
    const otherLoaded = await loadPlan(otherPaths.planFile);
    await ensureRuntimeDirs(otherPaths);
    await writeState(
      otherPaths,
      buildInitialState(otherLoaded.plan, otherLoaded.planSha256, {
        baselineSha: await headSha(otherPaths.repoRoot),
      }),
    );
    const verbose = await runDevCli(
      'dev-orchestrate.ts',
      ['--repo', other.root, '--profile', 'fake-worker-v1', '--max-iterations', '1', '--verbose'],
      { AGENTLAB_DEV_DIR: other.devDir, AGENTLAB_FAKE_MODE: 'success' },
    );
    expect(verbose.exitCode).toBe(0);
    const verboseRecord = await readLaunchRecord(otherPaths, 'T1');

    // Tudo que não é identidade do processo, instante do run ou caminho do
    // sandbox (o prompt entra no `argv`) é idêntico nos dois modos.
    const stable = (record: LaunchRecord | null) => {
      const {
        process: _process,
        launch_id: _launchId,
        started_at: _startedAt,
        finished_at: _finishedAt,
        duration_ms: _durationMs,
        argv: _argv,
        // Telemetria de atividade é medição AO VIVO: timestamps e contagem de
        // chunks variam entre execuções por natureza, como a identidade do
        // processo. O que a regressão compara é o que a escolha de verbosidade
        // poderia mudar, e ela não muda observação nenhuma.
        activity: _activity,
        ...rest
      } = record as LaunchRecord;
      return rest;
    };
    expect(stable(verboseRecord)).toEqual(stable(compactRecord));

    await rm(other.root, { recursive: true, force: true });
  }, 90_000);
});
