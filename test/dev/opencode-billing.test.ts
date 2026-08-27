import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './helpers.js';
import { loadProfileFromCatalog } from '../../dev/lib/profile.js';
import {
  API_BILLING_AUTHORIZATION_VALUE,
  API_BILLING_AUTHORIZATION_VARIABLE,
  buildBillingRecord,
  expectedSubscriptionSource,
  probeCredentialSource,
  runBillingPreflight,
  type CommandRunner,
} from '../../dev/lib/billing.js';

const profileFor = (id: string) => loadProfileFromCatalog(REPO_ROOT, id);

const ESC = String.fromCharCode(27);

/**
 * Saida REAL do `opencode providers list`, com as sequencias ANSI que a CLI
 * emite. Nenhuma credencial aparece nela: a CLI imprime nome e tipo, e e so
 * isso que o probe consome.
 */
const PROVIDERS_LIST_OUTPUT = [
  `${ESC}[0m`,
  `┌  Credentials ${ESC}[90m~/.local/share/opencode/auth.json`,
  '│',
  `●  OpenAI ${ESC}[90moauth`,
  '│',
  `●  OpenCode Go ${ESC}[90mapi`,
  '│',
  `●  OpenRouter ${ESC}[90mapi`,
  '│',
  '└  3 credentials',
].join('\n');

function runnerReturning(output: string): CommandRunner {
  return async () => ({ code: 0, output });
}

const BASE_ENV = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;

describe('probe de credencial do OpenCode', () => {
  it('reconhece OAuth do OpenAI como assinatura ChatGPT, nao como API', async () => {
    const probe = await probeCredentialSource({
      agent: 'opencode',
      provider: 'openai',
      binary: 'opencode',
      env: BASE_ENV,
      runner: runnerReturning(PROVIDERS_LIST_OUTPUT),
    });
    expect(probe.verified).toBe(true);
    expect(probe.source).toBe('opencode_chatgpt_subscription');
    expect(probe.source).not.toBe('api');
  });

  it('reconhece a chave do OpenCode Go como ASSINATURA, nao como cobranca por uso', async () => {
    const probe = await probeCredentialSource({
      agent: 'opencode',
      provider: 'opencode_go',
      binary: 'opencode',
      env: BASE_ENV,
      runner: runnerReturning(PROVIDERS_LIST_OUTPUT),
    });
    expect(probe.verified).toBe(true);
    // A regra antiga ("chave => API") daria `api` aqui e recusaria uma
    // assinatura legitima.
    expect(probe.source).toBe('opencode_go_subscription_key');
    expect(probe.source).not.toBe('api');
  });

  it('reconhece a chave do OpenRouter como cobranca POR USO', async () => {
    const probe = await probeCredentialSource({
      agent: 'opencode',
      provider: 'openrouter',
      binary: 'opencode',
      env: BASE_ENV,
      runner: runnerReturning(PROVIDERS_LIST_OUTPUT),
    });
    expect(probe.source).toBe('openrouter_metered_key');
  });

  it('credencial de um upstream nao prova a de outro', async () => {
    const probe = await probeCredentialSource({
      agent: 'opencode',
      provider: 'opencode_go',
      binary: 'opencode',
      env: BASE_ENV,
      runner: runnerReturning('●  OpenRouter api\n└  1 credentials'),
    });
    expect(probe.verified).toBe(false);
    expect(probe.source).toBe('unknown');
  });

  it('OpenAI autenticado por chave NAO e aceito como assinatura', async () => {
    const probe = await probeCredentialSource({
      agent: 'opencode',
      provider: 'openai',
      binary: 'opencode',
      env: BASE_ENV,
      runner: runnerReturning('●  OpenAI api'),
    });
    // Assinatura nao e comprovavel por chave; aceitar aqui trocaria o destino
    // da cobranca sem ninguem notar.
    expect(probe.source).toBe('api');
  });

  it('nenhum segredo atravessa para o resultado do probe', async () => {
    const probe = await probeCredentialSource({
      agent: 'opencode',
      provider: 'openrouter',
      binary: 'opencode',
      env: BASE_ENV,
      runner: runnerReturning(`${PROVIDERS_LIST_OUTPUT}\nsk-or-v1-SEGREDO-FALSO`),
    });
    expect(JSON.stringify(probe)).not.toContain('sk-or');
    expect(JSON.stringify(probe)).not.toContain('SEGREDO');
  });

  it('a fonte esperada depende do upstream, nao so do scaffold', () => {
    expect(expectedSubscriptionSource('opencode', 'openai')).toBe('opencode_chatgpt_subscription');
    expect(expectedSubscriptionSource('opencode', 'opencode_go')).toBe(
      'opencode_go_subscription_key',
    );
    // Perfis legados continuam resolvendo pelo scaffold, como sempre.
    expect(expectedSubscriptionSource('claude')).toBe('claude_subscription_oauth');
    expect(expectedSubscriptionSource('codex')).toBe('chatgpt_subscription');
  });
});

describe('preflight de cobranca com OpenCode', () => {
  it('perfil OpenCode Go passa sem autorizacao manual: e assinatura', async () => {
    const profile = await profileFor('opencode-go-deepseek-v4-flash-v1');
    const outcome = await runBillingPreflight({
      agent: profile.agent,
      provider: profile.provider,
      billingMode: profile.billing_mode,
      binary: 'opencode',
      env: BASE_ENV,
      orchestratorEnv: {},
      runner: runnerReturning(PROVIDERS_LIST_OUTPUT),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.credential.source).toBe('opencode_go_subscription_key');
  });

  it('perfil OpenRouter e RECUSADO sem autorizacao explicita de run', async () => {
    const profile = await profileFor('opencode-openrouter-glm-4.7-flash-api-v1');
    const outcome = await runBillingPreflight({
      agent: profile.agent,
      provider: profile.provider,
      billingMode: profile.billing_mode,
      binary: 'opencode',
      env: BASE_ENV,
      // A credencial EXISTE na maquina; ela nao e autorizacao para gastar.
      orchestratorEnv: {},
      runner: runnerReturning(PROVIDERS_LIST_OUTPUT),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toContain(API_BILLING_AUTHORIZATION_VARIABLE);
  });

  it('perfil OpenRouter e aceito com autorizacao explicita do humano', async () => {
    const profile = await profileFor('opencode-openrouter-glm-4.7-flash-api-v1');
    const outcome = await runBillingPreflight({
      agent: profile.agent,
      provider: profile.provider,
      billingMode: profile.billing_mode,
      binary: 'opencode',
      env: BASE_ENV,
      orchestratorEnv: {
        [API_BILLING_AUTHORIZATION_VARIABLE]: API_BILLING_AUTHORIZATION_VALUE,
      },
      runner: runnerReturning(PROVIDERS_LIST_OUTPUT),
    });
    expect(outcome.ok).toBe(true);
  });

  it('perfil OpenCode/OpenAI exige OAuth; chave de API nao o libera', async () => {
    const profile = await profileFor('opencode-openai-gpt-5.6-sol-v1');
    const outcome = await runBillingPreflight({
      agent: profile.agent,
      provider: profile.provider,
      billingMode: profile.billing_mode,
      binary: 'opencode',
      env: BASE_ENV,
      orchestratorEnv: {},
      runner: runnerReturning('●  OpenAI api'),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toContain('API');
  });

  it('variavel de credencial de API no ambiente do worker bloqueia antes do spawn', async () => {
    const profile = await profileFor('opencode-go-deepseek-v4-flash-v1');
    const outcome = await runBillingPreflight({
      agent: profile.agent,
      provider: profile.provider,
      billingMode: profile.billing_mode,
      binary: 'opencode',
      env: { ...BASE_ENV, OPENAI_API_KEY: 'valor-falso-de-teste' },
      orchestratorEnv: {},
      runner: runnerReturning(PROVIDERS_LIST_OUTPUT),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.refusal).toContain('OPENAI_API_KEY');
  });
});

describe('record de cobranca', () => {
  it('a chave do OpenCode Go e gravada como assinatura, nao como API', () => {
    const record = buildBillingRecord({
      mode: 'subscription_only',
      credentialSource: 'opencode_go_subscription_key',
      consumedAllowance: true,
      estimate: { estimated_api_equivalent_usd: 0.004, turns: 2 },
    });
    expect(record.mode).toBe('subscription_only');
    expect(record.credential_source).toBe('opencode_go_subscription_key');
    // Equivalencia estimada NAO e cobranca, e sem fonte autoritativa nao ha
    // cobranca observada nenhuma.
    expect(record.provider_estimated_api_equivalent_usd).toBe(0.004);
    expect(record.actual_incremental_charge_usd).toBeNull();
    expect(record.authoritative_billing_verified).toBe(false);
  });

  it('regressao: perfis legados Claude e Codex continuam carregando e validos', async () => {
    for (const id of [
      'claude-build-worker-subscription-sonnet5-medium-v3',
      'codex-build-worker-subscription-sol-medium-v2',
    ]) {
      const profile = await profileFor(id);
      expect(profile.billing_mode).toBe('subscription_only');
      // Perfis legados nao declaram upstream e continuam validos.
      expect(profile.provider).toBeUndefined();
      expect(profile.capability_prior).toBeUndefined();
    }
  });
});
