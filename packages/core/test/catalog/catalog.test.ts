import { describe, expect, it } from 'vitest';

import {
  CatalogError,
  DEFAULT_CATALOG,
  buildCatalog,
  parseCatalogYaml,
  profilesOfTier,
} from '../../src/catalog/catalog.js';

describe('catálogo de modelos', () => {
  it('catálogo padrão segue a decisão Q2 por tier', () => {
    const ids = (tier: 'economy' | 'standard' | 'premium') =>
      profilesOfTier(DEFAULT_CATALOG, tier).map((profile) => profile.id).sort();
    expect(ids('premium')).toEqual(['claude-opus-5-high', 'codex-sol-high']);
    expect(ids('standard')).toEqual(['claude-sonnet-5-medium', 'codex-sol-medium', 'opencode-go-glm-5.3']);
    expect(ids('economy')).toEqual(['codex-luna-medium', 'opencode-go-deepseek-v4-flash']);
  });

  it('todo perfil padrão é assinatura, com pool derivado do contrato', () => {
    for (const profile of DEFAULT_CATALOG) {
      expect(profile.identity.billing_mode).toBe('subscription');
    }
    const codex = DEFAULT_CATALOG.find((profile) => profile.id === 'codex-sol-medium');
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
