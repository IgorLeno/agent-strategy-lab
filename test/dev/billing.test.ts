import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  API_CREDENTIAL_VARIABLES,
  UNVERIFIABLE_CREDENTIAL_MESSAGE,
  apiCredentialNamesIn,
  buildBillingRecord,
  extractUsageEstimate,
  probeCredentialSource,
  runBillingPreflight,
} from '../../dev/lib/billing.js';
import { DEFAULT_WORKER_PROFILE_ID } from '../../dev/lib/defaults.js';
import { diagnose, type Check } from '../../dev/lib/doctor.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { buildEnvironment, loadProfile } from '../../dev/lib/profile.js';
import { readLaunchRecord, writePacket } from '../../dev/lib/records.js';
import { BillingRecord } from '../../dev/lib/schemas.js';
import { buildInitialState, ensureRuntimeDirs, getTaskState, readState, writeState } from '../../dev/lib/state.js';
import { REPO_ROOT, commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

/**
 * Política verificada aqui: assinatura não é API; estimativa em dólares não é
 * cobrança; fonte de credencial desconhecida bloqueia o run.
 *
 * NENHUM teste deste arquivo chama Claude ou Codex de verdade. As CLIs falsas
 * de `fixtures/fake-clis` entram na frente do PATH e respondem só a `--help` e
 * ao comando de status; qualquer tentativa de run sai com erro.
 */

const FAKE_CLI_DIR = path.join(REPO_ROOT, 'fixtures', 'fake-clis');

/** Valor que nunca pode aparecer em saída, log ou record. */
const FAKE_SECRET = 'sk-ant-VALOR-FALSO-QUE-NAO-PODE-VAZAR';

/** Commit que gravou os artifacts do S15 — a referência histórica intocável. */
const S15_COMMIT = '38a41e2';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

function find(checks: readonly Check[], name: string): Check {
  const found = checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`check ausente: ${name}`);
  return found;
}

function fakeCliEnv(scenario: string): NodeJS.ProcessEnv {
  return {
    PATH: `${FAKE_CLI_DIR}:${process.env['PATH'] ?? ''}`,
    AGENTLAB_FAKE_AUTH: scenario,
  };
}

async function writeProfile(id: string, lines: readonly string[]): Promise<void> {
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', `${id}.yaml`),
    lines.join('\n'),
    'utf8',
  );
}

/** Perfil de assinatura que aponta para a CLI falsa. */
async function writeFakeClaudeProfile(id = 'claude-fixture-v1'): Promise<string> {
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', 'fixture.settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(true)'], deny: [] } }),
    'utf8',
  );
  await writeProfile(id, [
    `id: ${id}`,
    'agent: claude',
    'billing_mode: subscription_only',
    'environment_mode: real-world',
    "argv: [claude, '--print', '--model', 'modelo-fixo', '--settings', 'dev/profiles/fixture.settings.json', '--setting-sources', 'project']",
    'prompt_delivery: argv',
    'timeout_seconds: 30',
    'forbidden_flags: []',
    'env_allowlist: [PATH, AGENTLAB_FAKE_AUTH]',
  ]);
  return id;
}

async function writeFakeCodexProfile(id = 'codex-fixture-v1'): Promise<string> {
  await writeProfile(id, [
    `id: ${id}`,
    'agent: codex',
    'billing_mode: subscription_only',
    'environment_mode: real-world',
    "argv: [codex, exec, '--json', '--strict-config', '--model', 'modelo-fixo', '-']",
    'prompt_delivery: stdin',
    'timeout_seconds: 30',
    'forbidden_flags: []',
    'env_allowlist: [PATH, AGENTLAB_FAKE_AUTH]',
  ]);
  return id;
}

// ---------------------------------------------------------------------------
// Perfis: a política é recusada no carregamento, não corrigida em silêncio
// ---------------------------------------------------------------------------

describe('perfis subscription-only', () => {
  it('perfil Claude de assinatura recusa chave de API na allowlist', async () => {
    await writeProfile('claude-vazado-v1', [
      'id: claude-vazado-v1',
      'agent: claude',
      'billing_mode: subscription_only',
      "argv: [claude, '--print', '--model', 'x']",
      'prompt_delivery: argv',
      'timeout_seconds: 30',
      'forbidden_flags: []',
      'env_allowlist: [PATH, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN]',
    ]);
    await expect(loadProfile(sandbox.root, 'claude-vazado-v1')).rejects.toThrow(
      /ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN/,
    );
  });

  it('perfil Codex de assinatura recusa OPENAI_API_KEY', async () => {
    await writeProfile('codex-vazado-v1', [
      'id: codex-vazado-v1',
      'agent: codex',
      'billing_mode: subscription_only',
      "argv: [codex, exec, '--model', 'x', '-']",
      'prompt_delivery: stdin',
      'timeout_seconds: 30',
      'forbidden_flags: []',
      'env_allowlist: [PATH, OPENAI_API_KEY]',
    ]);
    await expect(loadProfile(sandbox.root, 'codex-vazado-v1')).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it('perfil de agente real precisa declarar o modo de cobrança', async () => {
    await writeProfile('claude-sem-billing-v1', [
      'id: claude-sem-billing-v1',
      'agent: claude',
      "argv: [claude, '--print', '--model', 'x']",
      'prompt_delivery: argv',
      'timeout_seconds: 30',
      'forbidden_flags: []',
      'env_allowlist: [PATH]',
    ]);
    await expect(loadProfile(sandbox.root, 'claude-sem-billing-v1')).rejects.toThrow(
      /precisa declarar billing_mode/,
    );
  });

  it('perfil de cobrança por API precisa dizer isso no próprio nome', async () => {
    await writeProfile('claude-discreto-v1', [
      'id: claude-discreto-v1',
      'agent: claude',
      'billing_mode: api',
      "argv: [claude, '--print', '--model', 'x']",
      'prompt_delivery: argv',
      'timeout_seconds: 30',
      'forbidden_flags: []',
      'env_allowlist: [PATH, ANTHROPIC_API_KEY]',
    ]);
    await expect(loadProfile(sandbox.root, 'claude-discreto-v1')).rejects.toThrow(
      /precisa ter `api` no id/,
    );
  });

  it('os perfis versionados de assinatura não deixam passar variável de API', async () => {
    for (const id of ['claude-build-worker-subscription-v1', 'codex-build-worker-subscription-v1']) {
      const profile = await loadProfile(REPO_ROOT, id);
      expect(profile.billing_mode).toBe('subscription_only');
      expect(apiCredentialNamesIn(profile.env_allowlist)).toEqual([]);
      expect(apiCredentialNamesIn(Object.keys(profile.env_extra))).toEqual([]);
      // Modelo fixado e continuidade proibida continuam valendo.
      expect(profile.argv).toContain('--model');
      expect(profile.forbidden_flags.length).toBeGreaterThan(0);
    }
  });

  it('os perfis de assinatura são o padrão de dev-launch, dev-orchestrate e dev-doctor', async () => {
    const padrao = await loadProfile(REPO_ROOT, DEFAULT_WORKER_PROFILE_ID);
    expect(padrao.billing_mode).toBe('subscription_only');
    expect(DEFAULT_WORKER_PROFILE_ID).toMatch(/subscription/);

    for (const cli of ['dev-launch.ts', 'dev-orchestrate.ts', 'dev-doctor.ts']) {
      const source = await readFile(path.join(REPO_ROOT, 'dev', 'cli', cli), 'utf8');
      expect(source, cli).toMatch(/DEFAULT_PROFILE = DEFAULT_WORKER_PROFILE_ID/);
      // Nenhum default escondido de outro perfil.
      expect(source, cli).not.toMatch(/DEFAULT_PROFILE = '/);
    }
  });
});

// ---------------------------------------------------------------------------
// Ambiente do worker
// ---------------------------------------------------------------------------

describe('saneamento do ambiente', () => {
  it('nenhuma variável de API chega ao worker, mesmo definida no processo pai', async () => {
    const profile = await loadProfile(REPO_ROOT, 'claude-build-worker-subscription-v1');
    const parent: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/x' };
    for (const name of API_CREDENTIAL_VARIABLES) parent[name] = FAKE_SECRET;

    const env = buildEnvironment(profile, parent);
    expect(apiCredentialNamesIn(Object.keys(env))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(FAKE_SECRET);
  });

  it('o preflight recusa se uma variável de API chegar ao ambiente final', async () => {
    const outcome = await runBillingPreflight({
      agent: 'claude',
      billingMode: 'subscription_only',
      binary: path.join(FAKE_CLI_DIR, 'claude'),
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: FAKE_SECRET },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toMatch(/ANTHROPIC_API_KEY/);
    // O motivo cita o NOME, nunca o valor.
    expect(outcome.refusal).not.toContain(FAKE_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Prova da fonte da credencial — só com CLI falsa
// ---------------------------------------------------------------------------

describe('probe de credencial', () => {
  const binary = (name: string) => path.join(FAKE_CLI_DIR, name);

  it('reconhece assinatura Claude e não repassa e-mail nem id de organização', async () => {
    const probe = await probeCredentialSource({
      agent: 'claude',
      binary: binary('claude'),
      env: fakeCliEnv('subscription'),
    });
    expect(probe.source).toBe('claude_subscription_oauth');
    expect(probe.verified).toBe(true);
    expect(probe.detail).not.toMatch(/@|orgId/);
  });

  it('reconhece assinatura ChatGPT no Codex', async () => {
    const probe = await probeCredentialSource({
      agent: 'codex',
      binary: binary('codex'),
      env: fakeCliEnv('subscription'),
    });
    expect(probe.source).toBe('chatgpt_subscription');
    expect(probe.verified).toBe(true);
  });

  it('classifica API como API nos dois agentes', async () => {
    for (const agent of ['claude', 'codex'] as const) {
      const probe = await probeCredentialSource({
        agent,
        binary: binary(agent),
        env: fakeCliEnv('api'),
      });
      expect(probe.source, agent).toBe('api');
    }
  });

  it('resposta irreconhecível, deslogada ou fora de formato vira unknown', async () => {
    for (const scenario of ['unknown', 'logged_out', 'garbage']) {
      const probe = await probeCredentialSource({
        agent: 'claude',
        binary: binary('claude'),
        env: fakeCliEnv(scenario),
      });
      expect(probe.source, scenario).toBe('unknown');
      expect(probe.verified, scenario).toBe(false);
    }
  });

  it('preflight sem chave nenhuma no ambiente ainda assim recusa fonte desconhecida', async () => {
    // Ausência de chave NÃO é prova de assinatura.
    const outcome = await runBillingPreflight({
      agent: 'claude',
      billingMode: 'subscription_only',
      binary: binary('claude'),
      env: fakeCliEnv('unknown'),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toContain(UNVERIFIABLE_CREDENTIAL_MESSAGE);
  });

  it('preflight recusa perfil que não é subscription_only sem autorização manual', async () => {
    const outcome = await runBillingPreflight({
      agent: 'claude',
      billingMode: 'api',
      binary: binary('claude'),
      env: fakeCliEnv('subscription'),
      orchestratorEnv: {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toMatch(/AGENTLAB_ALLOW_API_BILLING/);
  });
});

// ---------------------------------------------------------------------------
// dev-doctor
// ---------------------------------------------------------------------------

describe('dev-doctor e a fonte da credencial', () => {
  it('passa com fixture de assinatura — e é a CLI falsa que responde', async () => {
    const id = await writeFakeClaudeProfile();
    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCliEnv('subscription'),
    });

    expect(find(report.checks, 'fonte da credencial').status).toBe('PASS');
    expect(find(report.checks, 'modo de cobrança').status).toBe('PASS');
    expect(find(report.checks, 'variáveis de API').status).toBe('PASS');
    expect(report.billing_mode).toBe('subscription_only');
    expect(report.environment_mode).toBe('real-world');
    // Prova de que nenhuma CLI real foi consultada.
    expect(find(report.checks, 'binário').detail).toContain('fake-clis');
    expect(find(report.checks, 'versão da CLI').detail).toContain('9.9.9');
  });

  it('reprova quando a autenticação efetiva é API', async () => {
    const id = await writeFakeClaudeProfile();
    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCliEnv('api'),
    });
    expect(report.ok).toBe(false);
    expect(find(report.checks, 'fonte da credencial').status).toBe('FAIL');
    expect(find(report.checks, 'fonte da credencial').detail).toMatch(/API/);
  });

  it('reprova quando a fonte não pode ser provada, com a mensagem exigida', async () => {
    const id = await writeFakeClaudeProfile();
    for (const scenario of ['unknown', 'logged_out', 'garbage']) {
      const report = await diagnose({
        repoRoot: sandbox.root,
        profileId: id,
        loaded,
        env: fakeCliEnv(scenario),
      });
      expect(report.ok, scenario).toBe(false);
      expect(find(report.checks, 'fonte da credencial').detail, scenario).toContain(
        UNVERIFIABLE_CREDENTIAL_MESSAGE,
      );
    }
  });

  it('reprova Codex autenticado por API key', async () => {
    const id = await writeFakeCodexProfile();
    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCliEnv('api'),
    });
    expect(report.ok).toBe(false);
    expect(find(report.checks, 'fonte da credencial').status).toBe('FAIL');
  });

  it('não imprime valor de chave, mesmo com a chave definida no ambiente', async () => {
    const id = await writeFakeClaudeProfile();
    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: { ...fakeCliEnv('subscription'), ANTHROPIC_API_KEY: FAKE_SECRET },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(FAKE_SECRET);
    // A chave existe no shell, mas não entra no ambiente do worker.
    expect(find(report.checks, 'variáveis de API').status).toBe('PASS');
    expect(find(report.checks, 'variáveis de API').detail).toMatch(/ficam de fora/);
  });
});

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

describe('preflight do launcher', () => {
  async function prepareSandboxTask(profileLines: readonly string[], id: string): Promise<void> {
    await writeProfile(id, profileLines);
    await writeFile(
      path.join(sandbox.root, 'dev', 'profiles', 'fixture.settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(true)'], deny: [] } }),
      'utf8',
    );
    // Perfil é arquivo versionado: a guarda de base exige árvore limpa.
    await commitAll(sandbox.root, 'perfil de teste');
    await ensureRuntimeDirs(paths);
    await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
    await writePacket(
      paths,
      buildTaskPacket({
        task: loaded.byId.get('T1')!,
        baseSha: await headSha(paths.repoRoot),
        previousHandoff: null,
      }),
    );
  }

  const FIXTURE_PROFILE = (id: string) => [
    `id: ${id}`,
    'agent: claude',
    'billing_mode: subscription_only',
    'environment_mode: real-world',
    "argv: [claude, '--print', '--model', 'modelo-fixo', '--settings', 'dev/profiles/fixture.settings.json']",
    'prompt_delivery: argv',
    'timeout_seconds: 30',
    'forbidden_flags: []',
    'env_allowlist: [PATH, AGENTLAB_FAKE_AUTH]',
  ];

  it('não lança o worker quando a fonte da credencial é API — e não marca FAIL', async () => {
    const id = 'claude-preflight-v1';
    await prepareSandboxTask(FIXTURE_PROFILE(id), id);

    const result = await runDevCli(
      'dev-launch.ts',
      ['--repo', sandbox.root, '--profile', id, '--task', 'T1'],
      { ...fakeCliEnv('api'), AGENTLAB_DEV_DIR: sandbox.devDir, ANTHROPIC_API_KEY: FAKE_SECRET },
    );

    expect(result.exitCode, `${result.stdout}|${result.stderr}`).toBe(8);
    const output = JSON.parse(result.stdout) as { classification: string; reason: string };
    expect(output.classification).toBe('INFRA_ERROR');
    expect(output.reason).toMatch(/preflight de cobrança/);

    // Recusa de cobrança não é veredito sobre o worker: nunca FAIL.
    const task = getTaskState(await readState(paths), 'T1');
    expect(task.status).toBe('INFRA_ERROR');
    expect(task.status).not.toBe('FAIL');

    // Nenhum processo nasceu: sem log de sessão, sem inbox, sem LaunchRecord.
    expect(await readLaunchRecord(paths, 'T1')).toBeNull();
    const logs = await runGit(sandbox.root, ['status', '--porcelain']);
    expect(logs.stdout.trim()).toBe('');
    expect(result.stdout).not.toContain(FAKE_SECRET);
  });

  it('não lança quando a fonte é desconhecida', async () => {
    const id = 'claude-preflight-v2';
    await prepareSandboxTask(FIXTURE_PROFILE(id), id);

    const result = await runDevCli(
      'dev-launch.ts',
      ['--repo', sandbox.root, '--profile', id, '--task', 'T1'],
      { ...fakeCliEnv('logged_out'), AGENTLAB_DEV_DIR: sandbox.devDir },
    );
    expect(result.exitCode).toBe(8);
    expect(JSON.parse(result.stdout).reason).toContain(UNVERIFIABLE_CREDENTIAL_MESSAGE);
    expect(await readLaunchRecord(paths, 'T1')).toBeNull();
  });

  it('o relatório do dev-launch fala em equivalência estimada, não em custo pago', async () => {
    await ensureRuntimeDirs(paths);
    await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
    await writePacket(
      paths,
      buildTaskPacket({
        task: loaded.byId.get('T1')!,
        baseSha: await headSha(paths.repoRoot),
        previousHandoff: null,
      }),
    );

    const result = await runDevCli(
      'dev-launch.ts',
      ['--repo', sandbox.root, '--profile', 'fake-worker-v1', '--task', 'T1'],
      { AGENTLAB_DEV_DIR: sandbox.devDir, AGENTLAB_FAKE_MODE: 'success' },
    );
    expect(result.exitCode, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      billing: Record<string, unknown>;
      billing_note: string;
    };
    expect(output.billing).toHaveProperty('provider_estimated_api_equivalent_usd');
    expect(output.billing).toHaveProperty('actual_incremental_charge_usd', null);
    expect(output.billing).toHaveProperty('authoritative_billing_verified', false);
    expect(output.billing).not.toHaveProperty('cost_usd');
    // O rótulo diz o que o número é (equivalência estimada) e o que ele não é.
    expect(output.billing_note).toMatch(/^custo equivalente estimado/);
    expect(output.billing_note).toMatch(/não custo pago$/);

    const record = await readLaunchRecord(paths, 'T1');
    expect(record?.billing?.mode).toBe('not_applicable');
  });
});

// ---------------------------------------------------------------------------
// Semântica de custo
// ---------------------------------------------------------------------------

describe('custo: equivalência estimada ≠ cobrança', () => {
  it('lê a estimativa do stdout da CLI sem chamá-la', () => {
    const claudeOutput = JSON.stringify({
      type: 'result',
      total_cost_usd: 0.532,
      num_turns: 21,
    });
    expect(extractUsageEstimate(claudeOutput)).toEqual({
      estimated_api_equivalent_usd: 0.532,
      turns: 21,
    });

    const jsonl = ['{"type":"item"}', 'linha solta', '{"total_cost_usd":0.1,"num_turns":3}'].join(
      '\n',
    );
    expect(extractUsageEstimate(jsonl).estimated_api_equivalent_usd).toBe(0.1);
    expect(extractUsageEstimate('').estimated_api_equivalent_usd).toBeNull();
    expect(extractUsageEstimate('sem json aqui').estimated_api_equivalent_usd).toBeNull();
  });

  it('cobrança efetiva não é inferida: fica null sem fonte autoritativa', () => {
    const record = buildBillingRecord({
      mode: 'subscription_only',
      credentialSource: 'claude_subscription_oauth',
      consumedAllowance: true,
      estimate: { estimated_api_equivalent_usd: 1.6238, turns: 37 },
    });
    expect(record.provider_estimated_api_equivalent_usd).toBe(1.6238);
    expect(record.actual_incremental_charge_usd).toBeNull();
    expect(record.authoritative_billing_verified).toBe(false);
    expect(record.included_allowance_consumed).toBe(true);
  });

  it('valor cobrado sem fonte autoritativa é rejeitado pelo schema', () => {
    expect(() =>
      BillingRecord.parse({
        mode: 'subscription_only',
        credential_source: 'claude_subscription_oauth',
        included_allowance_consumed: true,
        provider_estimated_api_equivalent_usd: 1.62,
        actual_incremental_charge_usd: 1.62,
        authoritative_billing_verified: false,
      }),
    ).toThrow(/estimativa da CLI não é cobrança/);
  });
});

// ---------------------------------------------------------------------------
// Compatibilidade histórica
// ---------------------------------------------------------------------------

describe('artifacts históricos do S15', () => {
  it('permanecem byte a byte iguais ao commit que os gravou', async () => {
    const file = 'docs/S15-run-real.md';
    const historical = await runGit(REPO_ROOT, ['show', `${S15_COMMIT}:${file}`]);
    expect(historical.exitCode, historical.stderr).toBe(0);
    const current = await readFile(path.join(REPO_ROOT, file), 'utf8');
    expect(current).toBe(historical.stdout);
  });
});
