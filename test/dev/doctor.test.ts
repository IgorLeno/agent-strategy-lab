import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_CREDENTIAL_VARIABLES, apiCredentialNamesIn } from '../../dev/lib/billing.js';
import {
  CODEX_APPROVED_MODELS,
  claudeReasoningEffort,
  codexReasoningEffort,
  diagnose,
  flagsOf,
  helpInvocation,
  uncoveredValidationCommands,
  type Check,
} from '../../dev/lib/doctor.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { buildEnvironment, loadProfile, type LauncherProfile } from '../../dev/lib/profile.js';
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
/** Plano REAL do repositório: a allow list versionada é conferida contra ele. */
let repoPlan: LoadedPlan;

const FAKE_CLI_DIR = path.join(REPO_ROOT, 'fixtures', 'fake-clis');
const FAKE_API_SECRET = 'sk-test-nao-deve-chegar-ao-worker';

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  repoPlan = await loadPlan(resolveHarnessPaths(REPO_ROOT).planFile);
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

function codexProfile(
  id: string,
  reasoning?: string,
  ignoreUserConfig = true,
  model = 'gpt-5.6-sol',
): string {
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
    `  - ${model}`,
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

  it('v2 prova policy orchestrator e não exige identidade Git no worker', async () => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: 'codex-build-worker-subscription-high-v2',
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report).toMatchObject({
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
      sandbox: 'workspace-write',
      session_persistence: 'ephemeral',
      reasoning_effort: 'high',
      credential_source: 'chatgpt_subscription',
      ok: true,
    });
    expect(find(report.checks, 'execution policy')).toMatchObject({ status: 'PASS' });
    expect(find(report.checks, 'identidade Git')).toMatchObject({
      status: 'SKIP',
      detail: expect.stringMatching(/harness.*fora do sandbox/i),
    });
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

  it.each(['none', 'low', 'medium', 'xhigh', 'max'])(
    'reasoning %s é reconhecido como ele mesmo, não normalizado para high',
    async (reasoning) => {
      const id = `codex-${reasoning}-v1`;
      await writeProfile(id, codexProfile(id, reasoning));

      const report = await diagnose({
        repoRoot: sandbox.root,
        profileId: id,
        loaded,
        env: fakeCodexEnv(),
      });

      expect(report.reasoning_effort).toBe(reasoning);
      expect(report.reasoning_effort_source).toBe('codex_config_override');
      expect(find(report.checks, 'reasoning effort')).toMatchObject({
        status: 'PASS',
        detail: expect.stringContaining(reasoning),
      });
    },
  );

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

// ---------------------------------------------------------------------------
// Modelo e reasoning effort como DIMENSÕES EXPERIMENTAIS
// ---------------------------------------------------------------------------

const CODEX_BASELINE = 'codex-build-worker-subscription-high-v2';
const CLAUDE_BASELINE = 'claude-build-worker-subscription-v2';

const CODEX_EXPERIMENTS = [
  { id: CODEX_BASELINE, model: 'gpt-5.6-sol', effort: 'high' },
  { id: 'codex-build-worker-subscription-sol-medium-v2', model: 'gpt-5.6-sol', effort: 'medium' },
  { id: 'codex-build-worker-subscription-terra-high-v2', model: 'gpt-5.6-terra', effort: 'high' },
  {
    id: 'codex-build-worker-subscription-terra-medium-v2',
    model: 'gpt-5.6-terra',
    effort: 'medium',
  },
  { id: 'codex-build-worker-subscription-luna-medium-v2', model: 'gpt-5.6-luna', effort: 'medium' },
] as const;

const CLAUDE_EXPERIMENTS = [
  { id: 'claude-build-worker-subscription-opus5-high-v3', model: 'claude-opus-5', effort: 'high' },
  {
    id: 'claude-build-worker-subscription-opus5-medium-v3',
    model: 'claude-opus-5',
    effort: 'medium',
  },
  {
    id: 'claude-build-worker-subscription-sonnet5-high-v3',
    model: 'claude-sonnet-5',
    effort: 'high',
  },
  {
    id: 'claude-build-worker-subscription-sonnet5-medium-v3',
    model: 'claude-sonnet-5',
    effort: 'medium',
  },
] as const;

const CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5'];

function fakeClaudeEnv(): NodeJS.ProcessEnv {
  return {
    PATH: `${FAKE_CLI_DIR}:${process.env['PATH'] ?? ''}`,
    HOME: '/home/test-user',
    ANTHROPIC_API_KEY: FAKE_API_SECRET,
  };
}

/** Tudo o que NÃO é dimensão experimental: precisa ser idêntico ao baseline. */
function nonExperimentalFields(profile: LauncherProfile): Record<string, unknown> {
  const { id, argv, notes, control_markers, ...rest } = profile;
  void id;
  void argv;
  void notes;
  void control_markers;
  return rest;
}

/** Argv com modelo e effort apagados: o que sobra tem de ser igual ao baseline. */
function argvWithoutCodexExperiment(argv: readonly string[]): string[] {
  return argv.map((token) => {
    if (CODEX_APPROVED_MODELS.includes(token)) return '<model>';
    return token.startsWith('model_reasoning_effort=') ? '<effort>' : token;
  });
}

function argvWithoutClaudeExperiment(argv: readonly string[]): string[] {
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--effort') {
      index += 1;
      continue;
    }
    remaining.push(CLAUDE_MODELS.includes(token) ? '<model>' : token);
  }
  return remaining;
}

async function permissionsOf(profileId: string): Promise<unknown> {
  const profile = await loadProfile(REPO_ROOT, profileId);
  const file = profile.argv[profile.argv.indexOf('--settings') + 1] as string;
  return JSON.parse(await readFile(path.join(REPO_ROOT, file), 'utf8')) as unknown;
}

function claudeProfile(
  id: string,
  argvExtra: readonly string[],
  markers: readonly string[] = [],
): string {
  return [
    `id: ${id}`,
    'agent: claude',
    'billing_mode: subscription_only',
    'environment_mode: real-world',
    'commit_owner: orchestrator',
    'official_validation_owner: orchestrator',
    'worker_validation_policy: targeted',
    'argv:',
    '  - claude',
    '  - --print',
    '  - --model',
    '  - claude-opus-5',
    ...argvExtra.map((token) => `  - ${token}`),
    '  - --settings',
    '  - dev/profiles/experimento.settings.json',
    '  - --setting-sources',
    '  - project',
    'prompt_delivery: argv',
    'timeout_seconds: 1800',
    'forbidden_flags: [--resume, --continue, --fork-session, --session-id, --bare]',
    'env_allowlist: [PATH, HOME]',
    'control_markers:',
    '  model_pinned: --model',
    ...markers.map((marker) => `  ${marker}`),
  ].join('\n');
}

async function writeExperimentSettings(): Promise<void> {
  await writeFile(
    path.join(sandbox.root, 'dev', 'profiles', 'experimento.settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(true)'], deny: [] } }),
    'utf8',
  );
}

describe('perfis históricos permanecem semanticamente imutáveis', () => {
  it('Codex Sol/high v2 mantém argv, marcadores e políticas exatamente', async () => {
    const profile = await loadProfile(REPO_ROOT, CODEX_BASELINE);

    expect(profile.argv).toEqual([
      'codex',
      'exec',
      '--json',
      '--strict-config',
      '--ignore-user-config',
      '--sandbox',
      'workspace-write',
      '--ephemeral',
      '--ignore-rules',
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="high"',
      '-',
    ]);
    expect(profile.control_markers).toEqual({
      strict_config: '--strict-config',
      user_config_ignored: '--ignore-user-config',
      event_stream: '--json',
      model_pinned: '--model',
      reasoning_pinned: '--config',
      session_persistence: '--ephemeral',
      execpolicy_rules_ignored: '--ignore-rules',
    });
    expect(profile.billing_mode).toBe('subscription_only');
    expect(profile.instruction_environment).toBe('sanitized_user_home');
  });

  it('Claude v2 continua SEM --effort: nada de pinar effort retroativamente', async () => {
    const profile = await loadProfile(REPO_ROOT, CLAUDE_BASELINE);

    expect(profile.argv).toEqual([
      'claude',
      '--print',
      '--output-format',
      'json',
      '--model',
      'claude-opus-5',
      '--settings',
      'dev/profiles/claude-build-worker.settings.json',
      '--setting-sources',
      'project',
      '--permission-mode',
      'acceptEdits',
      '--strict-mcp-config',
      '--no-session-persistence',
    ]);
    expect(profile.argv).not.toContain('--effort');
    expect(Object.values(profile.control_markers)).not.toContain('--effort');
    expect(claudeReasoningEffort(profile.argv)).toEqual({ pinning: 'unpinned', effort: null });
  });
});

describe('perfis novos de modelo e effort', () => {
  it.each(CODEX_EXPERIMENTS.filter((experiment) => experiment.id !== CODEX_BASELINE))(
    '$id só difere do baseline Codex em modelo e effort',
    async ({ id }) => {
      const baseline = await loadProfile(REPO_ROOT, CODEX_BASELINE);
      const profile = await loadProfile(REPO_ROOT, id);

      expect(nonExperimentalFields(profile)).toEqual(nonExperimentalFields(baseline));
      expect(argvWithoutCodexExperiment(profile.argv)).toEqual(
        argvWithoutCodexExperiment(baseline.argv),
      );
      expect(profile.control_markers).toEqual(baseline.control_markers);
    },
  );

  it.each(CLAUDE_EXPERIMENTS)(
    '$id só difere do baseline Claude em modelo e no pinning do effort',
    async ({ id }) => {
      const baseline = await loadProfile(REPO_ROOT, CLAUDE_BASELINE);
      const profile = await loadProfile(REPO_ROOT, id);

      expect(nonExperimentalFields(profile)).toEqual(nonExperimentalFields(baseline));
      expect(argvWithoutClaudeExperiment(profile.argv)).toEqual(
        argvWithoutClaudeExperiment(baseline.argv),
      );
      expect(profile.control_markers).toEqual({
        ...baseline.control_markers,
        reasoning_effort_pinned: '--effort',
      });
    },
  );

  it.each(CLAUDE_EXPERIMENTS)('$id usa as MESMAS settings e permissões do v2', async ({ id }) => {
    expect(await permissionsOf(id)).toEqual(await permissionsOf(CLAUDE_BASELINE));
  });

  it.each([...CODEX_EXPERIMENTS, ...CLAUDE_EXPERIMENTS])(
    '$id é subscription_only, sem variável nem flag de API',
    async ({ id }) => {
      const profile = await loadProfile(REPO_ROOT, id);

      expect(profile.billing_mode).toBe('subscription_only');
      expect(
        apiCredentialNamesIn([...profile.env_allowlist, ...Object.keys(profile.env_extra)]),
      ).toEqual([]);
      for (const token of profile.argv) {
        expect(API_CREDENTIAL_VARIABLES).not.toContain(token);
        expect(['--bare', '--api-key', '--with-api-key', '--with-access-token']).not.toContain(
          token,
        );
      }
    },
  );

  it.each([...CODEX_EXPERIMENTS, ...CLAUDE_EXPERIMENTS])(
    '$id mantém execution policy orchestrator/orchestrator/targeted e as flags de continuidade proibidas',
    async ({ id }) => {
      const profile = await loadProfile(REPO_ROOT, id);
      const baseline = await loadProfile(
        REPO_ROOT,
        profile.agent === 'codex' ? CODEX_BASELINE : CLAUDE_BASELINE,
      );

      expect(profile.commit_owner).toBe('orchestrator');
      expect(profile.official_validation_owner).toBe('orchestrator');
      expect(profile.worker_validation_policy).toBe('targeted');
      expect(profile.forbidden_flags).toEqual(baseline.forbidden_flags);
    },
  );
});

describe('doctor reconhece cada combinação de modelo e effort', () => {
  it.each(CODEX_EXPERIMENTS)('$id é reportado como $model / $effort', async (experiment) => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: experiment.id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report).toMatchObject({
      model: experiment.model,
      reasoning_effort: experiment.effort,
      reasoning_effort_source: 'codex_config_override',
      billing_mode: 'subscription_only',
      credential_source: 'chatgpt_subscription',
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
      sandbox: 'workspace-write',
      session_persistence: 'ephemeral',
      user_config_ignored: true,
      execpolicy_rules_ignored: true,
      ok: true,
    });
    expect(find(report.checks, 'modelo').detail).toBe(experiment.model);
    expect(find(report.checks, 'reasoning effort').status).toBe('PASS');
  });

  it.each(CLAUDE_EXPERIMENTS)('$id é reportado como $model / $effort', async (experiment) => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: experiment.id,
      loaded: repoPlan,
      env: fakeClaudeEnv(),
    });

    expect(report).toMatchObject({
      model: experiment.model,
      reasoning_effort: experiment.effort,
      reasoning_effort_source: 'claude_effort_flag',
      billing_mode: 'subscription_only',
      credential_source: 'claude_subscription_oauth',
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
      ok: true,
    });
    expect(find(report.checks, 'modelo').detail).toBe(experiment.model);
    expect(find(report.checks, 'reasoning effort')).toMatchObject({
      status: 'PASS',
      detail: expect.stringContaining(experiment.effort),
    });
    expect(find(report.checks, 'política de permissões').status).toBe('PASS');
    expect(find(report.checks, 'settings pessoais').status).toBe('PASS');
    expect(find(report.checks, 'validações do plano').status).toBe('PASS');
    expect(find(report.checks, 'variáveis de API').status).toBe('PASS');
  });

  it('Claude v2 histórico continua válido e é reportado como unpinned, nunca high', async () => {
    const report = await diagnose({
      repoRoot: REPO_ROOT,
      profileId: CLAUDE_BASELINE,
      loaded: repoPlan,
      env: fakeClaudeEnv(),
    });

    expect(report).toMatchObject({
      model: 'claude-opus-5',
      reasoning_effort: 'unpinned',
      reasoning_effort_source: 'unpinned',
      credential_source: 'claude_subscription_oauth',
      ok: true,
    });
    expect(find(report.checks, 'reasoning effort')).toMatchObject({
      status: 'WARN',
      detail: expect.stringContaining('unpinned'),
    });
    expect(find(report.checks, 'reasoning effort').detail).not.toMatch(/\bhigh\b/);
  });
});

describe('modelo e effort desconhecidos falham fechado', () => {
  it('modelo Codex fora dos aprovados reprova', async () => {
    const id = 'codex-modelo-desconhecido-v1';
    await writeProfile(id, codexProfile(id, 'high', true, 'gpt-5.6-plutao'));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.model).toBe('gpt-5.6-plutao');
    expect(find(report.checks, 'modelo')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('gpt-5.6-sol'),
    });
  });

  it('effort Codex fora dos aprovados reprova', async () => {
    const id = 'codex-effort-desconhecido-v1';
    await writeProfile(id, codexProfile(id, 'turbo'));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('turbo');
    expect(find(report.checks, 'reasoning effort')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('aprovados'),
    });
  });

  it('effort Codex duplicado é ambíguo e reprova mesmo com os dois valores válidos', async () => {
    const id = 'codex-effort-duplicado-v1';
    await writeProfile(
      id,
      codexProfile(id, 'high').replace(
        "  - '-'",
        "  - --config\n  - 'model_reasoning_effort=\"medium\"'\n  - '-'",
      ),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('unknown');
    expect(report.reasoning_effort_source).toBe('unknown');
    expect(find(report.checks, 'reasoning effort').status).toBe('FAIL');
  });

  it('modelo Codex duplicado reprova por não estar fixado de forma única', async () => {
    const id = 'codex-modelo-duplicado-v1';
    await writeProfile(
      id,
      codexProfile(id, 'high').replace(
        "  - '-'",
        '  - --model\n  - gpt-5.6-terra\n  - \'-\'',
      ),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeCodexEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.model).toBe('unknown');
    expect(find(report.checks, 'modelo').status).toBe('FAIL');
  });

  it('--effort duplicado no Claude reprova', async () => {
    const id = 'claude-effort-duplicado-v1';
    await writeExperimentSettings();
    await writeProfile(
      id,
      claudeProfile(id, ['--effort', 'high', '--effort', 'medium'], [
        'reasoning_effort_pinned: --effort',
      ]),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeClaudeEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('unknown');
    expect(report.reasoning_effort_source).toBe('unknown');
    expect(find(report.checks, 'reasoning effort')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('--effort'),
    });
  });

  it('perfil que declara pinning de effort mas não traz --effort reprova', async () => {
    const id = 'claude-effort-declarado-ausente-v1';
    await writeExperimentSettings();
    await writeProfile(id, claudeProfile(id, [], ['reasoning_effort_pinned: --effort']));

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeClaudeEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('unpinned');
    expect(find(report.checks, 'reasoning effort')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('control_marker'),
    });
  });

  it('effort Claude fora dos aprovados reprova', async () => {
    const id = 'claude-effort-desconhecido-v1';
    await writeExperimentSettings();
    await writeProfile(
      id,
      claudeProfile(id, ['--effort', 'turbo'], ['reasoning_effort_pinned: --effort']),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeClaudeEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('turbo');
    expect(find(report.checks, 'reasoning effort')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('aprovados'),
    });
  });

  it('effort Claude não é evidência quando settings pessoais entrariam junto', async () => {
    const id = 'claude-effort-com-settings-pessoais-v1';
    await writeExperimentSettings();
    await writeProfile(
      id,
      claudeProfile(id, ['--effort', 'high'], ['reasoning_effort_pinned: --effort']).replace(
        '  - project',
        '  - project,user',
      ),
    );

    const report = await diagnose({
      repoRoot: sandbox.root,
      profileId: id,
      loaded,
      env: fakeClaudeEnv(),
    });

    expect(report.ok).toBe(false);
    expect(report.reasoning_effort).toBe('high');
    expect(find(report.checks, 'reasoning effort')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('user'),
    });
  });

  it('effort do Claude vem só do argv: env e settings pessoais não são evidência', () => {
    expect(claudeReasoningEffort(['claude', '--print'])).toEqual({
      pinning: 'unpinned',
      effort: null,
    });
    expect(claudeReasoningEffort(['claude', '--effort', 'high'])).toEqual({
      pinning: 'pinned',
      effort: 'high',
    });
    expect(claudeReasoningEffort(['claude', '--effort=max'])).toEqual({
      pinning: 'pinned',
      effort: 'max',
    });
    expect(claudeReasoningEffort(['claude', '--effort', '--print'])).toEqual({
      pinning: 'ambiguous',
      effort: null,
    });
    expect(claudeReasoningEffort(['claude', '--effort', 'high', '--effort', 'low'])).toEqual({
      pinning: 'ambiguous',
      effort: null,
    });
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
