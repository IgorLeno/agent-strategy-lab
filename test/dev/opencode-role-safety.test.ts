import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './helpers.js';
import { loadProfileFromCatalog, LauncherProfile } from '../../dev/lib/profile.js';
import {
  mutationStructurallyDenied,
  openCodePermissionEnv,
  openCodePermissionFor,
  OPENCODE_PERMISSION_VARIABLE,
  parseOpenCodeModel,
  declaredProviderAgrees,
  resolveAction,
} from '../../dev/lib/opencode-scaffold.js';
import {
  assertReadOnlyArgv,
  buildRoleArgv,
  RoleOverlayError,
} from '../../dev/lib/project-roles.js';
import { readEffectiveAccess } from '../../dev/lib/access-contract.js';

async function opencodeProfileIds(): Promise<string[]> {
  const entries = await readdir(path.join(REPO_ROOT, 'dev', 'profiles'));
  return entries
    .filter((entry) => entry.startsWith('opencode-') && entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length))
    .sort();
}

const profileFor = (id: string) => loadProfileFromCatalog(REPO_ROOT, id);

/**
 * A fronteira do OpenCode NÃO está no argv: está na permissão que o Lab
 * escreve. Estes testes verificam o OBJETO que vai ser enviado, resolvido pela
 * mesma regra da CLI (`findLast` sobre as chaves) — nunca por presença de
 * chave, que aprovaria uma tabela onde um curinga posterior reabrisse a
 * ferramenta.
 */
describe('OpenCode — fronteira de role estrutural', () => {
  it('planner nega toda ferramenta de mutação', () => {
    const permission = openCodePermissionFor('planner');
    expect(mutationStructurallyDenied(permission)).toBe(true);
    for (const tool of ['edit', 'write', 'patch', 'apply_patch', 'bash']) {
      expect(resolveAction(permission, tool)).toBe('deny');
    }
  });

  it('reviewer nega toda ferramenta de mutação', () => {
    const permission = openCodePermissionFor('reviewer');
    expect(mutationStructurallyDenied(permission)).toBe(true);
    expect(resolveAction(permission, 'edit')).toBe('deny');
    expect(resolveAction(permission, 'external_directory')).toBe('deny');
  });

  it('read-only não é cegueira: leitura, busca e listagem continuam possíveis', () => {
    for (const role of ['planner', 'reviewer'] as const) {
      const permission = openCodePermissionFor(role);
      for (const tool of ['read', 'glob', 'grep', 'list', 'lsp']) {
        expect(resolveAction(permission, tool)).toBe('allow');
      }
    }
  });

  it('ferramenta desconhecida em role read-only cai no catch-all deny', () => {
    const permission = openCodePermissionFor('reviewer');
    // Uma ferramenta que esta versão do Lab não conhece não ganha acesso por
    // omissão; o default `ask` da CLI travaria um processo não interativo.
    expect(resolveAction(permission, 'ferramenta_inventada_no_futuro')).toBe('deny');
  });

  it('implementer pode editar, mas só dentro do workspace autorizado', () => {
    const permission = openCodePermissionFor('implementer');
    expect(resolveAction(permission, 'edit')).toBe('allow');
    expect(resolveAction(permission, 'write')).toBe('allow');
    // É esta chave que transforma "só mexa no diretório certo" em fronteira.
    expect(resolveAction(permission, 'external_directory')).toBe('deny');
  });

  it('implementer NÃO pode commitar nem dar push: o commit é do orquestrador', () => {
    const permission = openCodePermissionFor('implementer');
    expect(resolveAction(permission, 'bash', 'git commit -m "x"')).toBe('deny');
    expect(resolveAction(permission, 'bash', 'git push origin main')).toBe('deny');
    // Inspecionar histórico continua liberado: ler não muta.
    expect(resolveAction(permission, 'bash', 'git log --oneline')).toBe('allow');
    expect(resolveAction(permission, 'bash', 'git diff')).toBe('allow');
  });

  it('implementer nega comandos destrutivos de sistema de arquivos', () => {
    const permission = openCodePermissionFor('implementer');
    for (const command of ['rm -rf /', 'sudo rm x', 'git reset --hard HEAD~1', 'git clean -fdx']) {
      expect(resolveAction(permission, 'bash', command)).toBe('deny');
    }
  });

  it('implementer deixa ferramenta desconhecida em `ask`, não em `allow`', () => {
    const permission = openCodePermissionFor('implementer');
    // `ask` num processo não interativo não concede nada; ele impede que uma
    // ferramenta nova entre em uso silenciosamente.
    expect(resolveAction(permission, 'ferramenta_inventada_no_futuro')).toBe('ask');
  });

  it('a permissão é escrita por INTEIRO no ambiente do lançamento', () => {
    const env = openCodePermissionEnv('reviewer');
    const permission = JSON.parse(env[OPENCODE_PERMISSION_VARIABLE] as string) as Record<
      string,
      unknown
    >;
    // A mescla da CLI é por chave: uma chave omitida herdaria o que estiver na
    // configuração global do usuário.
    expect(Object.keys(permission)).toContain('*');
    expect(permission['edit']).toBe('deny');
    // O Lab também recusa a configuração de projeto do repositório ALVO, que
    // vive dentro do que o worker pode modificar.
    expect(env['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1');
  });
});

describe('OpenCode — overlay de role no lançamento', () => {
  it('planner e reviewer saem com a permissão read-only no ambiente', async () => {
    const profile = await profileFor('opencode-go-deepseek-v4-flash-v1');
    for (const role of ['planner', 'reviewer'] as const) {
      const overlay = buildRoleArgv(profile, { role, prompt: 'packet' });
      expect(overlay.workspace_access).toBe('READ_ONLY');
      expect(overlay.env[OPENCODE_PERMISSION_VARIABLE]).toBeDefined();
      expect(() => assertReadOnlyArgv(role, 'opencode', overlay.argv, overlay.env)).not.toThrow();
      // A garantia é do mecanismo, não de uma frase do prompt.
      expect(overlay.mechanism).toContain(OPENCODE_PERMISSION_VARIABLE);
      expect(overlay.mechanism).not.toMatch(/prompt/i);
    }
  });

  it('implementer sai com mutação limitada ao workspace autorizado', async () => {
    const profile = await profileFor('opencode-go-deepseek-v4-flash-v1');
    const overlay = buildRoleArgv(profile, { role: 'implementer', prompt: 'packet' });
    expect(overlay.workspace_access).toBe('MUTATION_IN_AUTHORIZED_WORKSPACE');
    expect(overlay.mechanism).toContain('external_directory=deny');
    const permission = JSON.parse(
      overlay.env[OPENCODE_PERMISSION_VARIABLE] as string,
    ) as Record<string, unknown>;
    expect(permission['external_directory']).toBe('deny');
  });

  it('lançamento SEM a variável de permissão é recusado como não read-only', () => {
    expect(() => assertReadOnlyArgv('reviewer', 'opencode', ['opencode', 'run'], {})).toThrow(
      RoleOverlayError,
    );
  });

  it('permissão que reabre mutação por curinga posterior é recusada', () => {
    const env = {
      [OPENCODE_PERMISSION_VARIABLE]: JSON.stringify({ edit: 'deny', '*': 'allow' }),
    };
    // `findLast` faria o `*` vencer o `edit`; uma checagem por presença de
    // chave aprovaria esta tabela.
    expect(() => assertReadOnlyArgv('reviewer', 'opencode', ['opencode', 'run'], env)).toThrow(
      RoleOverlayError,
    );
  });

  it('`--auto` no argv lançado é recusado mesmo com permissão correta', () => {
    const env = openCodePermissionEnv('reviewer');
    expect(() =>
      assertReadOnlyArgv('reviewer', 'opencode', ['opencode', 'run', '--auto'], env),
    ).toThrow(RoleOverlayError);
  });

  it('permissão ilegível é recusada: a CLI a descartaria com um aviso', () => {
    expect(() =>
      assertReadOnlyArgv('reviewer', 'opencode', ['opencode', 'run'], {
        [OPENCODE_PERMISSION_VARIABLE]: 'nao-e-json',
      }),
    ).toThrow(RoleOverlayError);
  });
});

describe('OpenCode — contrato de acesso', () => {
  it('a fronteira declarada é sandbox de filesystem do provider', () => {
    const effective = readEffectiveAccess('opencode', ['opencode', 'run', '--dir', '/work']);
    expect(effective.enforcement).toBe('PROVIDER_FILESYSTEM_SANDBOX');
    expect(effective.writable_roots).toEqual(['/work']);
    expect(effective.mechanism).toContain('external_directory=deny');
  });

  it('rede não é declarada restringível: o argv não prova isso', () => {
    const effective = readEffectiveAccess('opencode', ['opencode', 'run']);
    expect(effective.network_restrictable).toBe(false);
  });
});

describe('catálogo de perfis OpenCode', () => {
  it('todo perfil declara upstream, e o upstream concorda com o modelo', async () => {
    for (const id of await opencodeProfileIds()) {
      const profile = await profileFor(id);
      expect(profile.agent).toBe('opencode');
      expect(profile.provider).toBeDefined();
      const model = profile.argv[profile.argv.indexOf('--model') + 1] as string;
      const agreement = declaredProviderAgrees(profile.provider!, model);
      expect(agreement.agrees, `${id}: ${agreement.reason}`).toBe(true);
    }
  });

  it('nenhum perfil OpenCode aceita `--auto`', async () => {
    for (const id of await opencodeProfileIds()) {
      const profile = await profileFor(id);
      expect(profile.argv).not.toContain('--auto');
      expect(profile.forbidden_flags).toContain('--auto');
    }
  });

  it('perfis OpenRouter são de cobrança por uso e carregam `api` no id', async () => {
    const metered = (await opencodeProfileIds()).filter((id) => id.includes('openrouter'));
    expect(metered.length).toBeGreaterThan(0);
    for (const id of metered) {
      const profile = await profileFor(id);
      expect(profile.provider).toBe('openrouter');
      expect(profile.billing_mode).toBe('api');
      // O nome é a única defesa que sobrevive a quem escolhe o perfil no shell.
      expect(id).toMatch(/(^|-)api(-|$)/);
    }
  });

  it('perfis OpenCode Go são de ASSINATURA, apesar de a auth ser por chave', async () => {
    const go = (await opencodeProfileIds()).filter((id) => id.startsWith('opencode-go-'));
    expect(go.length).toBeGreaterThan(0);
    for (const id of go) {
      const profile = await profileFor(id);
      expect(profile.provider).toBe('opencode_go');
      expect(profile.billing_mode).toBe('subscription_only');
      expect(id).not.toMatch(/(^|-)api(-|$)/);
    }
  });

  it('todo perfil OpenCode declara um prior de capacidade com justificativa', async () => {
    for (const id of await opencodeProfileIds()) {
      const profile = await profileFor(id);
      expect(profile.capability_prior).toBeDefined();
      expect(profile.capability_prior?.rationale.length).toBeGreaterThan(10);
    }
  });

  it('nenhum perfil OpenCode carrega credencial no ambiente', async () => {
    for (const id of await opencodeProfileIds()) {
      const raw = await readFile(
        path.join(REPO_ROOT, 'dev', 'profiles', `${id}.yaml`),
        'utf8',
      );
      expect(raw).not.toMatch(/sk-[a-zA-Z0-9]/);
      expect(raw).not.toMatch(/API_KEY/);
    }
  });
});

describe('modelo endereçado pelo OpenCode', () => {
  it('prefixo do modelo identifica o upstream', () => {
    expect(parseOpenCodeModel('opencode-go/glm-5.3').provider).toBe('opencode_go');
    expect(parseOpenCodeModel('openai/gpt-5.6-sol').provider).toBe('openai');
    expect(parseOpenCodeModel('openrouter/z-ai/glm-4.7-flash').provider).toBe('openrouter');
  });

  it('prefixo desconhecido é erro, não palpite', () => {
    // Adivinhar de quem o Lab compra decidiria cobrança e pool.
    expect(() => parseOpenCodeModel('provider-novo/modelo')).toThrow();
    expect(() => parseOpenCodeModel('sem-barra')).toThrow();
  });

  it('perfil que rotula assinatura apontando para modelo cobrado por uso é recusado', () => {
    const agreement = declaredProviderAgrees('opencode_go', 'openrouter/qwen/qwen3-coder');
    expect(agreement.agrees).toBe(false);
    expect(agreement.reason).toContain('cobrança e pool');
  });

  it('perfil opencode sem provider declarado não passa no schema', () => {
    const parsed = LauncherProfile.safeParse({
      id: 'opencode-sem-provider-v1',
      agent: 'opencode',
      billing_mode: 'subscription_only',
      argv: ['opencode', 'run', '--model', 'opencode-go/glm-5.3'],
      prompt_delivery: 'argv',
      forbidden_flags: [],
      env_allowlist: ['PATH'],
      capability_prior: { tier: 'economy', model_cost_rank: 0, rationale: 'teste' },
    });
    expect(parsed.success).toBe(false);
  });

  it('perfil OpenRouter declarado como assinatura não passa no schema', () => {
    const parsed = LauncherProfile.safeParse({
      id: 'opencode-openrouter-api-v1',
      agent: 'opencode',
      provider: 'openrouter',
      // Mentira: cobrança por uso rotulada como assinatura.
      billing_mode: 'subscription_only',
      argv: ['opencode', 'run', '--model', 'openrouter/qwen/qwen3-coder'],
      prompt_delivery: 'argv',
      forbidden_flags: [],
      env_allowlist: ['PATH'],
      capability_prior: { tier: 'economy', model_cost_rank: 0, rationale: 'teste' },
    });
    expect(parsed.success).toBe(false);
  });
});
