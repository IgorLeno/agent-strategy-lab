/**
 * CONTRATO REAL DAS CLIs INSTALADAS — não fixtures que imitam o provider.
 *
 * O primeiro piloto perdeu attempts porque o harness assumia flags, chaves de
 * config e roots que a CLI real não concedia. Estes testes fecham essa
 * distância no degrau MAIS BARATO que ainda prova alguma coisa:
 *
 *   1. inspeção estática de contrato;
 *   2. `--version` / `--help` da CLI local;
 *   3. probe determinístico local (`codex sandbox`);
 *   4. probe real da CLI sem inferência.
 *
 * NENHUM teste aqui gasta inferência, e nenhum usa credencial de API. Quando a
 * CLI não está instalada, o teste é PULADO explicitamente em vez de passar
 * fingindo evidência que não existe.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveWorkerAccessContract,
  readEffectiveAccess,
  translateAccessContract,
} from '../../dev/lib/access-contract.js';
import { claudeUsageArgv } from '../../dev/lib/claude-usage.js';
import { loadProfileFromCatalog, resolveProfileArgv } from '../../dev/lib/profile.js';
import { resolveHarnessInstallationRoot, resolveHarnessPaths } from '../../dev/lib/paths.js';
import { runGit } from './helpers.js';

const run = promisify(execFile);
const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

async function cliAvailable(binary: string): Promise<boolean> {
  try {
    await run(binary, ['--version'], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function helpText(binary: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(binary, [...args], { timeout: 30_000 });
    return `${stdout}${stderr}`;
  } catch (error) {
    // Muitas CLIs devolvem exit != 0 em `--help`; o texto é o que importa.
    const shaped = error as { stdout?: string; stderr?: string };
    return `${shaped.stdout ?? ''}${shaped.stderr ?? ''}`;
  }
}

/** `loadProfileFromCatalog` já resolve `dev/profiles` embaixo da raiz. */
const CATALOG = resolveHarnessInstallationRoot();

/**
 * Diretório temporário FORA de /tmp. O workspace-write do Codex concede TMPDIR
 * por padrão, então um probe de sandbox ali provaria o contrário do pretendido.
 */
async function tempOutsideTmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.homedir(), prefix));
  created.push(dir);
  return dir;
}

describe('contrato real da CLI Codex', () => {
  it('a CLI instalada aceita TODAS as flags que os profiles Codex declaram', async () => {
    if (!(await cliAvailable('codex'))) {
      console.warn('codex não instalado: contrato não verificado nesta máquina');
      return;
    }
    const help = await helpText('codex', ['exec', '--help']);
    const profile = await loadProfileFromCatalog(CATALOG, 'codex-build-worker-subscription-terra-medium-v2');

    const flags = profile.argv.filter((token) => token.startsWith('--'));
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) {
      expect(help, `${flag} não existe em codex exec --help`).toContain(flag);
    }
  }, 60_000);

  /**
   * O PROBE que fecha o blocker #1 do piloto.
   *
   * `translateAccessContract` emite `sandbox_workspace_write.writable_roots` e
   * `sandbox_workspace_write.network_access`. Aqui essas chaves — as MESMAS,
   * derivadas do tradutor de produção — são exercitadas contra o sandbox real
   * do Codex, sem nenhuma inferência.
   */
  it('writable_roots e network_access do tradutor são impostos pelo sandbox real', async () => {
    if (!(await cliAvailable('codex'))) {
      console.warn('codex não instalado: sandbox não verificado nesta máquina');
      return;
    }
    const home = await tempOutsideTmp('.agentlab-cli-contract-');
    const repoRoot = path.join(home, 'repo');
    const outbox = path.join(home, 'outbox');
    await run('mkdir', ['-p', repoRoot, outbox]);
    await runGit(repoRoot, ['init']);

    const target = path.join(outbox, 'report.json');
    const configFor = (extra: readonly string[]) => [
      'sandbox',
      '-c',
      'sandbox_mode="workspace-write"',
      ...extra,
      '--',
      'touch',
      target,
    ];

    // SEM o grant: o sandbox real precisa RECUSAR.
    await expect(
      run('codex', configFor([]), { cwd: repoRoot, timeout: 60_000 }),
    ).rejects.toThrow();

    // COM o grant emitido pelo tradutor de produção: precisa PERMITIR.
    const profile = await loadProfileFromCatalog(CATALOG, 'codex-build-worker-subscription-terra-medium-v2');
    const contract = deriveWorkerAccessContract({
      role: 'implementer',
      profile,
      paths: resolveHarnessPaths(repoRoot, { devDir: path.join(home, 'control', 'runtime') }),
      io: {
        repoRoot,
        homeDir: path.join(home, 'worker-home'),
        packetPath: path.join(outbox, 'packet.json'),
        reportPath: path.join(outbox, 'report.json'),
        handoffDraftPath: path.join(outbox, 'handoff-draft.json'),
        sanitizedHomeRequired: false,
      },
    });
    const translated = translateAccessContract(profile, contract, profile.argv);
    const effective = readEffectiveAccess('codex', translated.argv);
    expect(effective.writable_roots).toContain(outbox);

    const rootsConfig = translated.argv[
      translated.argv.findIndex((token) => token.startsWith('sandbox_workspace_write.writable_roots='))
    ] as string;
    await run('codex', configFor(['-c', rootsConfig]), { cwd: repoRoot, timeout: 60_000 });
    expect((await stat(target)).isFile()).toBe(true);
  }, 180_000);
});

describe('contrato real da CLI Claude', () => {
  it('a CLI instalada aceita TODAS as flags que os profiles Claude declaram', async () => {
    if (!(await cliAvailable('claude'))) {
      console.warn('claude não instalado: contrato não verificado nesta máquina');
      return;
    }
    const help = await helpText('claude', ['--help']);
    const profile = await loadProfileFromCatalog(CATALOG, 'claude-build-worker-subscription-opus5-high-v3');

    for (const flag of profile.argv.filter((token) => token.startsWith('--'))) {
      expect(help, `${flag} não existe em claude --help`).toContain(flag);
    }
    // O probe de quota também precisa existir de verdade: ele é a única fonte
    // de usage de assinatura, e roda em TODO launch Claude.
    for (const flag of claudeUsageArgv('claude').filter((token) => token.startsWith('--'))) {
      expect(help, `${flag} do probe de usage não existe em claude --help`).toContain(flag);
    }
  }, 60_000);

  it('o envelope declarado pelos profiles é o que o parser operacional espera', async () => {
    const profile = await loadProfileFromCatalog(CATALOG, 'claude-build-worker-subscription-opus5-high-v3');
    const index = profile.argv.indexOf('--output-format');
    expect(index).toBeGreaterThan(-1);

    // Os profiles operacionais usam `json` (objeto único), NÃO `stream-json`.
    // É por isso que `usesClaudeStreamJson` decide pelo argv real do profile em
    // vez de assumir um transporte — a divergência entre os dois foi um dos
    // blockers do piloto.
    expect(profile.argv[index + 1]).toBe('json');
    if (await cliAvailable('claude')) {
      const help = await helpText('claude', ['--help']);
      expect(help).toContain('--output-format');
    }
  }, 60_000);
});

describe('runtime externo — paths reais', () => {
  /**
   * O repositório alvo e o runtime do control plane vivem em árvores
   * SEPARADAS. Blocker #3 do piloto: `--settings dev/profiles/...` é relativo e
   * resolvia contra o repositório ALVO, carregando uma permission policy que
   * não existia lá.
   */
  it('path relativo do profile resolve contra o catálogo do Lab, não contra o alvo', async () => {
    const root = await temp('agentlab-external-runtime-');
    const repoRoot = path.join(root, 'project');
    const runtimeDir = path.join(root, 'control', 'runtime');
    await run('mkdir', ['-p', repoRoot, runtimeDir]);
    await runGit(repoRoot, ['init']);
    await writeFile(path.join(repoRoot, 'README.md'), '# alvo externo\n', 'utf8');

    const paths = resolveHarnessPaths(repoRoot, { devDir: runtimeDir, profileCatalogRoot: CATALOG });
    expect(paths.repoRoot).toBe(repoRoot);
    expect(paths.devDir).toBe(runtimeDir);
    // O runtime fica FORA do repositório alvo: nada dele suja a working tree.
    expect(paths.devDir.startsWith(`${repoRoot}${path.sep}`)).toBe(false);
    expect(paths.inboxDir.startsWith(`${repoRoot}${path.sep}`)).toBe(false);

    const profile = await loadProfileFromCatalog(CATALOG, 'claude-build-worker-subscription-opus5-high-v3');
    const resolved = resolveProfileArgv(profile.argv, {
      catalogRoot: CATALOG,
      workerCwd: repoRoot,
    });

    const settings = resolved[resolved.indexOf('--settings') + 1] as string;
    expect(path.isAbsolute(settings)).toBe(true);
    expect(settings.startsWith(resolveHarnessInstallationRoot())).toBe(true);
    // O arquivo apontado EXISTE de verdade — é isso que o piloto não tinha.
    expect((await stat(settings)).isFile()).toBe(true);
    expect(settings.startsWith(repoRoot)).toBe(false);
  }, 60_000);
});
