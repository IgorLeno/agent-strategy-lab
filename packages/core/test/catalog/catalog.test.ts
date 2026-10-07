import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  DEFAULT_CATALOG,
  buildCatalog,
  parseCatalogYaml,
  TIERS,
  profilesOfTier,
  tierOf,
  type Tier,
} from '../../src/catalog/catalog.js';

describe('catálogo de modelos', () => {
  it('catálogo padrão: 7 tiers da tabela do usuário, mais barato primeiro dentro do tier', () => {
    // Ordem em que o router tenta (cost_rank crescente).
    const order = (tier: Tier) =>
      [...profilesOfTier(DEFAULT_CATALOG, tier)].sort((a, b) => a.cost_rank - b.cost_rank).map((profile) => profile.id);
    expect(order('frontier')).toEqual(['codex-sol-6-high', 'claude-opus-5.5-medium', 'claude-sonnet-5.5-high']);
    expect(order('expert')).toEqual(['opencode-go-deepseek-v4.1-flash', 'codex-sol-6-medium', 'claude-sonnet-5.5-medium']);
    expect(order('advanced')).toEqual(['opencode-go-qwen3.8-max', 'codex-sol-6-low', 'claude-sonnet-5.5-low']);
    expect(order('balanced')).toEqual(['opencode-go-glm-5.3', 'opencode-go-deepseek-v4-pro', 'codex-luna-6-max']);
    expect(order('core')).toEqual(['opencode-go-kimi-k2.7-code', 'opencode-go-qwen3.8-flash', 'codex-luna-6-high']);
    expect(order('fast')).toEqual(['opencode-go-glm-5.3-flash', 'opencode-go-minimax-m3', 'codex-luna-6-medium']);
    expect(order('economy')).toEqual(['opencode-go-mimo-v2.6-flash', 'opencode-go-longcat-2.0', 'codex-luna-6-low']);
    expect(DEFAULT_CATALOG).toHaveLength(21);
  });

  it('todo tier mais exigente custa mais que qualquer perfil de tier abaixo', () => {
    for (let index = 1; index < TIERS.length; index += 1) {
      const above = profilesOfTier(DEFAULT_CATALOG, TIERS[index - 1] as Tier).map((profile) => profile.cost_rank);
      const below = profilesOfTier(DEFAULT_CATALOG, TIERS[index] as Tier).map((profile) => profile.cost_rank);
      expect(Math.min(...above)).toBeGreaterThan(Math.max(...below));
    }
  });

  it('nomes antigos de tier viram aliases; desconhecido é null', () => {
    expect(tierOf('premium')).toBe('frontier');
    expect(tierOf('standard')).toBe('balanced');
    expect(tierOf('economy')).toBe('economy');
    expect(tierOf('core')).toBe('core');
    expect(tierOf('ultra')).toBeNull();
  });

  it('todo perfil padrão é assinatura, com pool derivado do contrato', () => {
    for (const profile of DEFAULT_CATALOG) {
      expect(profile.identity.billing_mode).toBe('subscription');
    }
    const codex = DEFAULT_CATALOG.find((profile) => profile.id === 'codex-sol-6-medium');
    expect(codex?.identity.quota_pool).toBe('openai_chatgpt_subscription');
  });

  it('recusa perfil que cobra por uso', () => {
    expect(() =>
      buildCatalog([
        { id: 'or', scaffold: 'opencode', provider: 'openrouter', model: 'openrouter/x', effort: null, tier: 'economy', cost_rank: 0 },
      ]),
    ).toThrow(/cobra por uso/);
  });

  it('recusa scaffold que não fala com o provider e id repetido', () => {
    expect(() =>
      buildCatalog([
        { id: 'x', scaffold: 'claude_code', provider: 'openai', model: 'gpt', effort: null, tier: 'economy', cost_rank: 0 },
      ]),
    ).toThrow(CatalogError);
    const entry = { id: 'dup', scaffold: 'codex_cli', provider: 'openai', model: 'gpt', effort: null, tier: 'economy', cost_rank: 0 };
    expect(() => buildCatalog([entry, entry])).toThrow(/repetido/);
  });

  it('lê catálogo de YAML', () => {
    const catalog = parseCatalogYaml(
      [
        'profiles:',
        '  - id: glm',
        '    scaffold: opencode',
        '    provider: opencode_go',
        '    model: opencode-go/glm-5.3',
        '    effort: null',
        '    tier: standard',
        '    cost_rank: 1',
      ].join('\n'),
    );
    expect(catalog.map((profile) => profile.identity.quota_pool)).toEqual(['opencode_go_subscription']);
    expect(() => parseCatalogYaml('outra: coisa')).toThrow(/profiles/);
  });
});
