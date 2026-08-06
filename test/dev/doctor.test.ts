import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diagnose,
  flagsOf,
  helpInvocation,
  uncoveredValidationCommands,
  type Check,
} from '../../dev/lib/doctor.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

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

/** Escreve um perfil no sandbox — o doctor lê do repositório, como em produção. */
async function writeProfile(id: string, body: string): Promise<void> {
  await writeFile(path.join(sandbox.root, 'dev', 'profiles', `${id}.yaml`), body, 'utf8');
}

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

describe('dev-doctor CLI', () => {
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
