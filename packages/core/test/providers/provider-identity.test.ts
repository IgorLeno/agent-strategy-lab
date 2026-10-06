// Portado de test/providers/provider-identity.test.ts (2052cca), sem a normalização de perfil legado.
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_CONTRACTS,
  ProviderIdentity,
  providerContractOf,
  providerIdentityOf,
  requiresExplicitSpendAuthorization,
  sharesQuotaPool,
} from '../../src/providers/identity.js';

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
