import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_CREDENTIAL_VARIABLES } from '../../dev/lib/billing.js';
import {
  codexReasoningEffort,
  diagnose,
  flagsOf,
  helpInvocation,
  uncoveredValidationCommands,
  type Check,
} from '../../dev/lib/doctor.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { buildEnvironment, loadProfile } from '../../dev/lib/profile.js';
import {
  REPO_ROOT,
  buildTestProcessEnvironment,
  makeSandboxRepo,
  runDevCli,
  runGit,
  type CliResult,
  type Sandbox,
} from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

const FAKE_CLI_DIR = path.join(REPO_ROOT, 'fixtures', 'fake-clis');
const FAKE_API_SECRET = 'sk-test-nao-deve-chegar-ao-worker';

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

/** Escreve um perfil no sandbox — o doctor lê do repositório, como em produção. */
async function writeProfile(id: string, body: string): Promise<void> {
  await writeFile(path.join(sandbox.root, 'dev', 'profiles', `${id}.yaml`), body, 'utf8');
}

function fakeCodexEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${FAKE_CLI_DIR}:${process.env['PATH'] ?? ''}`,
    HOME: '/home/test-user',
    CODEX_HOME: '/home/test-user/.codex-real',
    OPENAI_API_KEY: FAKE_API_SECRET,
    CODEX_API_KEY: FAKE_API_SECRET,
  };
}

function codexProfile(id: string, reasoning?: string, ignoreUserConfig = true): string {
  const argv = [
    '  - codex',
    '  - exec',
    '  - --json',
    '  - --strict-config',
    ...(ignoreUserConfig ? ['  - --ignore-user-config'] : []),
    '  - --sandbox',
    '  - workspace-write',
    '  - --ephemeral',
    '  - --ignore-rules',
    '  - --model',
    '  - gpt-5.6-sol',
    ...(reasoning === undefined
      ? []
      : ['  - --config', `  - 'model_reasoning_effort="${reasoning}"'`]),
    "  - '-'",
  ];
  return [
    `id: ${id}`,
    'agent: codex',
    'billing_mode: subscription_only',
    'environment_mode: real-world',
    'instruction_environment: sanitized_user_home',
    'argv:',
    ...argv,
    'prompt_delivery: stdin',
    'timeout_seconds: 1800',
    'forbidden_flags: [resume, fork, --last, --session-id]',
    'env_allowlist: [PATH, CODEX_HOME]',
    'env_extra:',
    "  GIT_AUTHOR_NAME: 'Agent Strategy Lab Worker'",
    "  GIT_AUTHOR_EMAIL: 'agent-strategy-lab@localhost'",
    "  GIT_COMMITTER_NAME: 'Agent Strategy Lab Worker'",
    "  GIT_COMMITTER_EMAIL: 'agent-strategy-lab@localhost'",
  ].join('\n');
}

function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

function runFakeWorker(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'fixtures', 'fake-worker.mjs'), ...args], {
      cwd: sandbox.root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function incidentEnvironment(): Promise<{
  readonly env: NodeJS.ProcessEnv;
  readonly report: string;
  readonly draft: string;
}> {
  const packet = path.join(sandbox.devDir, 'task-packets', 'T1.json');
  const report = path.join(sandbox.root, '.dev-inbox', 'T1', 'report.json');
  const draft = path.join(sandbox.root, '.dev-inbox', 'T1', 'handoff-draft.json');
  await mkdir(path.dirname(packet), { recursive: true });
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(
    packet,
    JSON.stringify({ task_id: 'T1', title: 'regressão de isolamento', validation: [] }),
    'utf8',
  );
  return {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      LANG: 'agentlab-parent-lang',
      AGENTLAB_REPO_ROOT: sandbox.root,
      AGENTLAB_TASK_PACKET_PATH: packet,
      AGENTLAB_REPORT_PATH: report,
      AGENTLAB_HANDOFF_DRAFT_PATH: draft,
      AGENTLAB_TASK_ID: 'T1',
      AGENTLAB_LAUNCH_ID: 'test-parent-launch',
      AGENTLAB_FAKE_MODE: 'success',
    },
    report,
    draft,
  };
}

describe('isolamento do ambiente dos subprocessos de teste', () => {
  it('herda só a allowlist e aplica overrides AGENTLAB depois da sanitização', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/parent/bin',
      HOME: '/parent/home',
      LANG: 'parent-lang',
      AGENTLAB_REPO_ROOT: '/repo-real-que-não-pode-vazar',
      QUALQUER_OUTRA: 'fora-da-allowlist',
    };
    for (const name of API_CREDENTIAL_VARIABLES) source[name] = 'test-only-placeholder';

    expect(
      buildTestProcessEnvironment(
        { AGENTLAB_DEV_DIR: '/sandbox/.dev', AGENTLAB_FAKE_MODE: 'failure' },
        source,
      ),
    ).toEqual({
      PATH: '/parent/bin',
      HOME: '/parent/home',
      LANG: 'parent-lang',
      AGENTLAB_DEV_DIR: '/sandbox/.dev',
      AGENTLAB_FAKE_MODE: 'failure',
    });
  });

  it('runDevCli não repassa AGENTLAB herdada e preserva override explícito exatamente', async () => {
    const result = await runDevCli(
      '../../test/dev/env-probe.ts',
      [],
      { AGENTLAB_DEV_DIR: '/sandbox/explicit-dev-dir' },
      {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        LANG: 'agentlab-controlled-parent',
        AGENTLAB_REPO_ROOT: '/repo-real-que-não-pode-vazar',
        AGENTLAB_FAKE_MODE: 'success',
      },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      agentlabNames: ['AGENTLAB_DEV_DIR'],
      devDir: '/sandbox/explicit-dev-dir',
      lang: 'agentlab-controlled-parent',
    });
  });
});

describe('fake worker introspectivo', () => {
  it('--help ignora ambiente AGENTLAB completo e não produz efeitos', async () => {
    const incident = await incidentEnvironment();
    const headBefore = (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const statusBefore = (await runGit(sandbox.root, ['status', '--porcelain'])).stdout;

    const result = await runFakeWorker(['--help'], incident.env);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/fake-worker/);
    expect(await exists(path.join(sandbox.root, 'src', 't1.txt'))).toBe(false);
    expect((await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect((await runGit(sandbox.root, ['status', '--porcelain'])).stdout).toBe(statusBefore);
    expect(await exists(incident.report)).toBe(false);
    expect(await exists(incident.draft)).toBe(false);
  });
});

describe('leitura do argv do perfil', () => {
  it('flagsOf pega só flags, normalizando --flag=valor', () => {
    expect(flagsOf(['claude', '--print', '--model', 'opus', '--settings=x.json'])).toEqual([
      '--print',
      '--model',
      '--settings',
    ]);
  });

  it('helpInvocation preserva o subcomando antes da primeira flag', () => {
    expect(helpInvocation(['codex', 'exec', '--json', '-'])).toEqual({
      command: 'codex',
      args: ['exec', '--help'],
    });
    expect(helpInvocation(['claude', '--print'])).toEqual({ command: 'claude', args: ['--help'] });
  });

  it('reasoning só é comprovado com exatamente um override válido', () => {
    const high = 'model_reasoning_effort="high"';
    expect(codexReasoningEffort(['codex', '--config', high])).toBe('high');
    expect(codexReasoningEffort(['codex'])).toBeNull();
    expect(codexReasoningEffort(['codex', '--config', high, '--config', high])).toBeNull();
    expect(
      codexReasoningEffort([
        'codex',
        '--config',
        high,
        '--config',
        'model_reasoning_effort="high',
      ]),
    ).toBeNull();
    expect(codexReasoningEffort(['codex', '--config', 'model_reasoning_effort'])).toBeNull();
  });
});

describe('cobertura das validações pela allow list', () => {
  it('regra com prefixo cobre o comando do plano', () => {
    expect(uncoveredValidationCommands(loaded, ['Bash(true)'])).toEqual([]);
    expect(uncoveredValidationCommands(loaded, ['Bash(pnpm test:*)'])).toEqual(['true']);
  });

  it('allow list vazia deixa tudo descoberto', () => {
    expect(uncoveredValidationCommands(loaded, [])).toEqual(['true']);
  });
});

describe('dev-doctor', () => {
  it('perfil falso passa sem exigir política nem modelo', async () => {
    const report = await diagnose({ repoRoot: sandbox.root, profileId: 'fake-worker-v1', loaded });
    expect(report.ok).toBe(true);
    expect(find(report.checks, 'modelo').status).toBe('SKIP');
    expect(find(report.checks, 'fonte da credencial').status).toBe('SKIP');
    expect(find(report.checks, 'modo de cobrança').status).toBe('SKIP');
  });

  it('flag que a CLI instalada não reconhece reprova antes de qualquer gasto', async () => {
    await writeProfile(
      'inventado-v1',
      [
        'id: inventado-v1',
        'agent: fake',
        "argv: [node, '--flag-que-nao-existe-em-lugar-nenhum']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH]',
      ].join('\n'),
    );

    const report = await diagnose({ repoRoot: sandbox.root, profileId: 'inventado-v1', loaded });
    expect(report.ok).toBe(false);
    expect(find(report.checks, 'flags').status).toBe('FAIL');
    expect(find(report.checks, 'flags').detail).toMatch(/--flag-que-nao-existe/);
  });

  it('perfil Claude sem política versionada reprova', async () => {
    await writeProfile(
      'claude-sem-policy-v1',
      [
        'id: claude-sem-policy-v1',
        'agent: claude',
        'billing_mode: subscription_only',
        "argv: [node, '--print']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH]',
      ].join('\n'),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: 'claude-sem-policy-v1',
      loaded,
    });
    expect(report.ok).toBe(false);
    // Sem --settings o worker dependeria das permissões pessoais da máquina.
    expect(find(report.checks, 'política de permissões').status).toBe('FAIL');
    expect(find(report.checks, 'modelo').status).toBe('FAIL');
    expect(find(report.checks, 'settings pessoais').status).toBe('WARN');
  });

  it('comando de validação fora da allow list reprova', async () => {
    await writeProfile(
      'claude-policy-curta-v1',
      [
        'id: claude-policy-curta-v1',
        'agent: claude',
        'billing_mode: subscription_only',
        "argv: [node, '--print', '--settings', 'dev/profiles/curta.settings.json', '--model', 'x']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH]',
      ].join('\n'),
    );
    await writeFile(
      path.join(sandbox.root, 'dev', 'profiles', 'curta.settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(git status:*)'], deny: [] } }),
      'utf8',
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: 'claude-policy-curta-v1',
      loaded,
    });
    expect(report.ok).toBe(false);
    expect(find(report.checks, 'validações do plano').detail).toMatch(/sem regra allow: true/);
  });

  it('--bare é recusado em perfil de assinatura: a flag força auth por API', async () => {
    await writeProfile(
      'claude-bare-v1',
      [
        'id: claude-bare-v1',
        'agent: claude',
        'billing_mode: subscription_only',
        "argv: [node, '--print', '--bare', '--settings', 'dev/profiles/curta.settings.json', '--model', 'x']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH]',
      ].join('\n'),
    );
    await writeFile(
      path.join(sandbox.root, 'dev', 'profiles', 'curta.settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(true)'], deny: [] } }),
      'utf8',
    );

    // Recusa no carregamento, não no relatório: perfil assim não deveria nem
    // chegar a ser diagnosticado.
    await expect(
      diagnose({ repoRoot: sandbox.root, profileId: 'claude-bare-v1', loaded }),
    ).rejects.toThrow(/força autenticação por API/);
  });

  it('perfil de assinatura com chave de API na allowlist é recusado no carregamento', async () => {
    await writeProfile(
      'claude-com-chave-v1',
      [
        'id: claude-com-chave-v1',
        'agent: claude',
        'billing_mode: subscription_only',
        "argv: [node, '--print', '--model', 'x']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH, ANTHROPIC_API_KEY]',
      ].join('\n'),
    );

    await expect(
      diagnose({ repoRoot: sandbox.root, profileId: 'claude-com-chave-v1', loaded }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('perfil Codex Sol High por assinatura', () => {
  it('prova modelo, reasoning, cobrança, credencial e opções pela CLI falsa', async () => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: 'codex-build-worker-subscription-high-v1',
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report).toMatchObject({
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
      billing_mode: 'subscription_only',
      credential_source: 'chatgpt_subscription',
      environment_mode: 'real-world',
      instruction_environment: 'sanitized_user_home',
      sandbox: 'workspace-write',
      session_persistence: 'ephemeral',
      user_config_ignored: true,
      execpolicy_rules_ignored: true,
      ok: true,
    });
    expect(find(report.checks, 'flags').status).toBe('PASS');
    expect(find(report.checks, 'modelo').detail).toBe('gpt-5.6-sol');
    expect(find(report.checks, 'reasoning effort').detail).toMatch(/high/);
    expect(find(report.checks, 'sandbox').status).toBe('PASS');
    expect(find(report.checks, 'persistência da sessão').status).toBe('PASS');
    expect(find(report.checks, 'HOME de instruções').status).toBe('PASS');
    expect(find(report.checks, 'identidade Git').status).toBe('PASS');
    expect(find(report.checks, 'variáveis de API').status).toBe('PASS');
    expect(find(report.checks, 'binário').detail).toContain('fake-clis');
  });

  it('perfil build-worker Codex sem sandbox explícito falha no doctor', async () => {
    const id = 'codex-build-worker-sem-sandbox-v1';
    await writeProfile(
      id,
      codexProfile(id, 'high').replace('  - --sandbox\n  - workspace-write\n', ''),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.sandbox).toBe('unknown');
    expect(find(report.checks, 'sandbox').status).toBe('FAIL');
  });

  it('sandbox read-only é recusado para build-worker Codex', async () => {
    const id = 'codex-build-worker-read-only-v1';
    await writeProfile(id, codexProfile(id, 'high').replace('workspace-write', 'read-only'));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.sandbox).toBe('read-only');
    expect(find(report.checks, 'sandbox').detail).toMatch(/workspace-write/);
  });

  it('sandbox full access é recusado para build-worker Codex', async () => {
    const id = 'codex-build-worker-full-access-v1';
    await writeProfile(
      id,
      codexProfile(id, 'high').replace('workspace-write', 'danger-full-access'),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.sandbox).toBe('danger-full-access');
    expect(find(report.checks, 'sandbox').status).toBe('FAIL');
  });

  it('--dangerously-bypass-approvals-and-sandbox é recusado no carregamento', async () => {
    const id = 'codex-build-worker-bypass-v1';
    await writeProfile(
      id,
      codexProfile(id, 'high').replace(
        "  - '-'",
        "  - --dangerously-bypass-approvals-and-sandbox\n  - '-'",
      ),
    );

    await expect(loadProfile(sandbox.root, id)).rejects.toThrow(/dangerously-bypass/);
  });

  it('--ephemeral é obrigatório para build-worker Codex', async () => {
    const id = 'codex-build-worker-persistente-v1';
    await writeProfile(id, codexProfile(id, 'high').replace('  - --ephemeral\n', ''));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.session_persistence).toBe('persistent');
    expect(find(report.checks, 'persistência da sessão').status).toBe('FAIL');
  });

  it('--ignore-rules é obrigatório no perfil lean', async () => {
    const id = 'codex-build-worker-com-rules-v1';
    await writeProfile(id, codexProfile(id, 'high').replace('  - --ignore-rules\n', ''));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.execpolicy_rules_ignored).toBe(false);
    expect(find(report.checks, 'regras de execpolicy').status).toBe('FAIL');
  });

  it('HOME sanitizado não herda ~/.agents e CODEX_HOME preserva a autenticação', async () => {
    const profile = await loadProfile(REPO_ROOT, 'codex-build-worker-subscription-high-v1');
    const sanitizedHome = '/runtime/homes/codex-high';
    const env = buildEnvironment(profile, fakeCodexEnv(), { sanitizedHome });

    expect(env['HOME']).toBe(sanitizedHome);
    expect(env['HOME']).not.toBe(fakeCodexEnv()['HOME']);
    expect(env['CODEX_HOME']).toBe('/home/test-user/.codex-real');
    expect(env['GIT_AUTHOR_NAME']).toBe('Agent Strategy Lab Worker');
    expect(env['GIT_COMMITTER_EMAIL']).toBe('agent-strategy-lab@localhost');
  });

  it('CODEX_HOME efetivo deriva do HOME real sem copiar configuração', async () => {
    const profile = await loadProfile(REPO_ROOT, 'codex-build-worker-subscription-high-v1');
    const env = buildEnvironment(
      profile,
      { PATH: '/bin', HOME: '/home/real-user' },
      { sanitizedHome: '/runtime/sanitized' },
    );

    expect(env['HOME']).toBe('/runtime/sanitized');
    expect(env['CODEX_HOME']).toBe('/home/real-user/.codex');
  });

  it('doctor falha fechado quando não pode separar HOME e CODEX_HOME', async () => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: 'codex-build-worker-subscription-high-v1',
      loaded,
      env: { PATH: `${FAKE_CLI_DIR}:${process.env['PATH'] ?? ''}` },
    });

    expect(report.ok).toBe(false);
    expect(find(report.checks, 'HOME de instruções').status).toBe('FAIL');
    expect(find(report.checks, 'fonte da credencial').status).toBe('FAIL');
  });

  it('doctor bloqueia build-worker sem identidade Git determinística', async () => {
    const id = 'codex-build-worker-sem-identidade-v1';
    const withoutIdentity = codexProfile(id, 'high')
      .split('\n')
      .filter((line) => !line.includes('GIT_'))
      .join('\n')
      .replace(/env_extra:\s*$/, 'env_extra: {}');
    await writeProfile(id, withoutIdentity);

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(find(report.checks, 'identidade Git').status).toBe('FAIL');
  });

  it('reasoning ausente falha fechado no doctor', async () => {
    await writeProfile('codex-sem-reasoning-v1', codexProfile('codex-sem-reasoning-v1'));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: 'codex-sem-reasoning-v1',
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('unknown');
    expect(find(report.checks, 'reasoning effort').status).toBe('FAIL');
  });

  it.each(['medium', 'xhigh'])('reasoning %s não é aceito como high', async (reasoning) => {
    const id = `codex-${reasoning}-v1`;
    await writeProfile(id, codexProfile(id, reasoning));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe(reasoning);
    expect(find(report.checks, 'reasoning effort').status).toBe('FAIL');
  });

  it('high sem --ignore-user-config falha por depender de configuração implícita', async () => {
    const id = 'codex-high-config-implicita-v1';
    await writeProfile(id, codexProfile(id, 'high', false));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('high');
    expect(find(report.checks, 'reasoning effort').detail).toMatch(/--ignore-user-config/);
  });

  it('high válido junto de override malformado falha como reasoning não comprovado', async () => {
    const id = 'codex-high-duplicado-malformado-v1';
    const body = codexProfile(id, 'high').replace(
      "  - '-'",
      "  - --config\n  - 'model_reasoning_effort=\"high'\n  - '-'",
    );
    await writeProfile(id, body);

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('unknown');
    expect(find(report.checks, 'reasoning effort').status).toBe('FAIL');
  });

  it('autenticação por API continua bloqueada sem chamar Codex real', async () => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: 'codex-build-worker-subscription-high-v1',
      loaded,
      env: fakeCodexEnv(),
      credentialRunner: async () => ({ code: 0, output: 'Logged in using an API key\n' }),
    });

    expect(report.ok).toBe(false);
    expect(report.credential_source).toBe('api');
    expect(find(report.checks, 'fonte da credencial').status).toBe('FAIL');
  });

  it('OPENAI_API_KEY e CODEX_API_KEY não chegam ao ambiente do perfil High', async () => {
    const profile = await loadProfile(REPO_ROOT, 'codex-build-worker-subscription-high-v1');
    const env = buildEnvironment(profile, fakeCodexEnv(), {
      sanitizedHome: '/runtime/homes/codex-high',
    });

    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
    expect(JSON.stringify(env)).not.toContain(FAKE_API_SECRET);
  });

  it('perfil legado segue válido, mas não é classificado como High', async () => {
    const legacy = await loadProfile(REPO_ROOT, 'codex-build-worker-subscription-v1');
    expect(legacy.id).toBe('codex-build-worker-subscription-v1');

    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: legacy.id,
      loaded,
      env: fakeCodexEnv(),
    });
    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('unknown');
    expect(find(report.checks, 'reasoning effort').status).toBe('FAIL');
  });
});

describe('dev-doctor CLI', () => {
  it('não reproduz o incidente com AGENTLAB herdado apontando para sandbox válido', async () => {
    const incident = await incidentEnvironment();
    const headBefore = (await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim();
    const statusBefore = (await runGit(sandbox.root, ['status', '--porcelain'])).stdout;

    const result = await runDevCli(
      'dev-doctor.ts',
      ['--repo', sandbox.root, '--profile', 'fake-worker-v1'],
      {},
      incident.env,
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
    expect(await exists(path.join(sandbox.root, 'src', 't1.txt'))).toBe(false);
    expect((await runGit(sandbox.root, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(headBefore);
    expect((await runGit(sandbox.root, ['status', '--porcelain'])).stdout).toBe(statusBefore);
    expect(await exists(incident.report)).toBe(false);
    expect(await exists(incident.draft)).toBe(false);
  });

  it('exit 0 no perfil falso e 3 quando há FAIL', async () => {
    const ok = await runDevCli('dev-doctor.ts', ['--repo', sandbox.root, '--profile', 'fake-worker-v1']);
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect((JSON.parse(ok.stdout) as { ok: boolean }).ok).toBe(true);

    await writeProfile(
      'quebrado-v1',
      [
        'id: quebrado-v1',
        'agent: claude',
        'billing_mode: subscription_only',
        "argv: [node, '--print']",
        'prompt_delivery: argv',
        'timeout_seconds: 30',
        'forbidden_flags: []',
        'env_allowlist: [PATH]',
      ].join('\n'),
    );
    const bad = await runDevCli('dev-doctor.ts', ['--repo', sandbox.root, '--profile', 'quebrado-v1']);
    expect(bad.exitCode).toBe(3);
  });
});
