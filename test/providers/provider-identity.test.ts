import { describe, expect, it } from 'vitest';

import {
  PROVIDER_CONTRACTS,
  ProviderIdentity,
  providerContractOf,
  providerIdentityOf,
  requiresExplicitSpendAuthorization,
  resolveProfileIdentity,
  legacyBillingAgrees,
  sharesQuotaPool,
} from '../../src/providers/index.js';

/**
 * Estes testes existem porque um campo só — `agent` — significava scaffold,
 * provider, cobrança e pool ao mesmo tempo. Cada `it` abaixo trava uma das
 * confusões que o campo único permitia.
 */
describe('identidade de provider — dimensões separadas', () => {
  it('scaffold, provider, modelo, auth, cobrança e pool são campos distintos', () => {
    const identity = providerIdentityOf({
      execution_scaffold: 'opencode',
      provider: 'opencode_go',
      model: 'opencode-go/deepseek-v4-flash',
      provenance: 'teste',
    });
    expect(identity.execution_scaffold).toBe('opencode');
    expect(identity.provider).toBe('opencode_go');
    expect(identity.model).toBe('opencode-go/deepseek-v4-flash');
    expect(identity.auth_method).toBe('api_key');
    expect(identity.billing_mode).toBe('subscription');
    expect(identity.quota_pool).toBe('opencode_go_subscription');
  });

  it('chave de API do OpenCode Go NÃO implica cobrança por uso', () => {
    const go = providerContractOf('opencode_go');
    expect(go.auth_method).toBe('api_key');
    // A implicação antiga ("chave => API") tornaria isto impossível.
    expect(go.billing_mode).toBe('subscription');
    expect(
      requiresExplicitSpendAuthorization(
        providerIdentityOf({
          execution_scaffold: 'opencode',
          provider: 'opencode_go',
          model: 'opencode-go/glm-5.3',
          provenance: 'teste',
        }),
      ),
    ).toBe(false);
  });

  it('chave de API do OpenRouter permanece cobrança por uso e exige autorização', () => {
    const identity = providerIdentityOf({
      execution_scaffold: 'opencode',
      provider: 'openrouter',
      model: 'openrouter/z-ai/glm-4.7-flash',
      provenance: 'teste',
    });
    expect(identity.auth_method).toBe('api_key');
    expect(identity.billing_mode).toBe('metered_api');
    expect(identity.quota_pool).toBe('openrouter_balance');
    expect(requiresExplicitSpendAuthorization(identity)).toBe(true);
  });

  it('OpenAI via OpenCode cai no MESMO pool que o Codex', () => {
    const codex = providerIdentityOf({
      execution_scaffold: 'codex_cli',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      provenance: 'teste',
    });
    const opencode = providerIdentityOf({
      execution_scaffold: 'opencode',
      provider: 'openai',
      model: 'openai/gpt-5.6-sol',
      provenance: 'teste',
    });
    expect(codex.quota_pool).toBe('openai_chatgpt_subscription');
    expect(opencode.quota_pool).toBe('openai_chatgpt_subscription');
    // Scaffolds diferentes, MESMA franquia: nunca capacidade independente.
    expect(codex.execution_scaffold).not.toBe(opencode.execution_scaffold);
    expect(sharesQuotaPool(codex, opencode)).toBe(true);
  });

  it('pools diferentes não são compartilhados, e `none` nunca compartilha', () => {
    const go = providerIdentityOf({
      execution_scaffold: 'opencode',
      provider: 'opencode_go',
      model: 'opencode-go/glm-5.3',
      provenance: 'teste',
    });
    const anthropic = providerIdentityOf({
      execution_scaffold: 'claude_code',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      provenance: 'teste',
    });
    const fake = providerIdentityOf({
      execution_scaffold: 'fake',
      provider: 'none',
      model: 'not_applicable',
      provenance: 'teste',
    });
    expect(sharesQuotaPool(go, anthropic)).toBe(false);
    // Dois workers falsos não são "a mesma franquia": não são franquia nenhuma.
    expect(sharesQuotaPool(fake, fake)).toBe(false);
  });

  it('recusa contradizer o contrato comercial de um upstream', () => {
    const invalid = ProviderIdentity.safeParse({
      schema_version: 1,
      execution_scaffold: 'opencode',
      provider: 'opencode_go',
      model: 'opencode-go/glm-5.3',
      auth_method: 'api_key',
      // Mentira: a assinatura Go viraria cobrança por uso.
      billing_mode: 'metered_api',
      quota_pool: 'opencode_go_subscription',
      provenance: 'teste',
    });
    expect(invalid.success).toBe(false);
  });

  it('recusa um scaffold que não fala com o upstream declarado', () => {
    const invalid = ProviderIdentity.safeParse({
      schema_version: 1,
      execution_scaffold: 'claude_code',
      provider: 'openrouter',
      model: 'openrouter/qwen/qwen3-coder',
      auth_method: 'api_key',
      billing_mode: 'metered_api',
      quota_pool: 'openrouter_balance',
      provenance: 'teste',
    });
    expect(invalid.success).toBe(false);
  });

  it('todo contrato declarado é internamente consistente', () => {
    for (const contract of PROVIDER_CONTRACTS) {
      for (const scaffold of contract.scaffolds) {
        const identity = providerIdentityOf({
          execution_scaffold: scaffold,
          provider: contract.provider,
          model: 'modelo-de-teste',
          provenance: 'teste',
        });
        expect(identity.auth_method).toBe(contract.auth_method);
        expect(identity.billing_mode).toBe(contract.billing_mode);
        expect(identity.quota_pool).toBe(contract.quota_pool);
      }
    }
  });
});

describe('normalização de perfil legado', () => {
  it('perfil Claude legado continua mapeando para a assinatura Anthropic', () => {
    const resolved = resolveProfileIdentity({
      profile_id: 'claude-build-worker-subscription-v2',
      agent: 'claude',
      billing_mode: 'subscription_only',
      model: 'claude-sonnet-5',
    });
    expect(resolved.outcome).toBe('IDENTIFIED');
    if (resolved.outcome !== 'IDENTIFIED') throw new Error('esperava IDENTIFIED');
    expect(resolved.identity.provider).toBe('anthropic');
    expect(resolved.identity.billing_mode).toBe('subscription');
    expect(resolved.identity.quota_pool).toBe('anthropic_subscription');
    expect(legacyBillingAgrees('subscription_only', resolved.identity).agrees).toBe(true);
  });

  it('perfil Codex legado continua mapeando para a assinatura ChatGPT', () => {
    const resolved = resolveProfileIdentity({
      profile_id: 'codex-build-worker-subscription-sol-medium-v2',
      agent: 'codex',
      billing_mode: 'subscription_only',
      model: 'gpt-5.6-sol',
    });
    if (resolved.outcome !== 'IDENTIFIED') throw new Error('esperava IDENTIFIED');
    expect(resolved.identity.execution_scaffold).toBe('codex_cli');
    expect(resolved.identity.provider).toBe('openai');
    expect(resolved.identity.auth_method).toBe('chatgpt_oauth');
    expect(resolved.identity.quota_pool).toBe('openai_chatgpt_subscription');
  });

  it('perfil falso mapeia para upstream nenhum', () => {
    const resolved = resolveProfileIdentity({
      profile_id: 'fake-worker-v1',
      agent: 'fake',
      billing_mode: 'not_applicable',
      model: 'not_applicable',
    });
    if (resolved.outcome !== 'IDENTIFIED') throw new Error('esperava IDENTIFIED');
    expect(resolved.identity.provider).toBe('none');
    expect(resolved.identity.billing_mode).toBe('not_applicable');
  });

  it('perfil legado de cobrança por API NÃO ganha contrato inventado', () => {
    const resolved = resolveProfileIdentity({
      profile_id: 'claude-api-worker-v1',
      agent: 'claude',
      billing_mode: 'api',
      model: 'claude-sonnet-5',
    });
    // Inventar um upstream metered aqui mudaria a autorização de cobrança de um
    // perfil histórico — exatamente o que a migração não pode fazer.
    expect(resolved.outcome).toBe('UNMAPPABLE');
  });

  it('perfil opencode sem upstream declarado é recusado, não adivinhado', () => {
    const resolved = resolveProfileIdentity({
      profile_id: 'opencode-sem-provider',
      agent: 'opencode',
      billing_mode: 'subscription_only',
      model: 'opencode-go/glm-5.3',
    });
    expect(resolved.outcome).toBe('UNMAPPABLE');
    if (resolved.outcome !== 'UNMAPPABLE') throw new Error('esperava UNMAPPABLE');
    expect(resolved.reason).toContain('precisa declarar o upstream');
  });

  it('migração não pode trocar quem paga', () => {
    const identity = providerIdentityOf({
      execution_scaffold: 'opencode',
      provider: 'openrouter',
      model: 'openrouter/qwen/qwen3-coder',
      provenance: 'teste',
    });
    // Um perfil rotulado assinatura que normalizasse para cobrança por uso
    // gastaria dinheiro sem ninguém ter autorizado.
    expect(legacyBillingAgrees('subscription_only', identity).agrees).toBe(false);
    expect(legacyBillingAgrees('api', identity).agrees).toBe(true);
  });
});
