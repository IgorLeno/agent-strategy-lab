/**
 * NORMALIZAÇÃO de um perfil do control plane para `ProviderIdentity`.
 *
 * O contrato de compatibilidade é o ponto inteiro deste arquivo: perfis Claude
 * e Codex já gravados não declaram provider, auth, pool nem nada disso, e
 * continuam válidos. A identidade deles é DERIVADA, deterministicamente, dos
 * dois campos que sempre existiram (`agent`, `billing_mode`) mais o modelo já
 * lido do argv versionado.
 *
 * A derivação nunca INVENTA autorização. Quando um perfil legado descreve uma
 * combinação que não existe na tabela de contratos — cobrança por API contra um
 * upstream que o Lab não contratou —, o resultado é `unmappable` com motivo, e
 * o caminho legado continua governando aquele perfil intocado. Silenciosamente
 * inventar um contrato para ele mudaria a autorização de cobrança de um perfil
 * histórico, que é exatamente o que a migração não pode fazer.
 *
 * `src` não importa `dev`: a entrada abaixo espelha estruturalmente
 * `LauncherProfile` de propósito, e quem alimenta é o control plane.
 */
import {
  providerIdentityOf,
  UpstreamProvider,
  type ExecutionScaffold,
  type ProviderIdentity,
} from './identity.js';

/** Espelha `LauncherProfile['agent']`. É o SCAFFOLD, e só ele. */
export type LegacyAgent = 'claude' | 'codex' | 'opencode' | 'fake';

/** Espelha `LauncherProfile['billing_mode']`, preservado verbatim. */
export type LegacyBillingMode = 'subscription_only' | 'api' | 'not_applicable';

export interface ProfileIdentityInput {
  readonly profile_id: string;
  readonly agent: LegacyAgent;
  readonly billing_mode: LegacyBillingMode;
  /** Modelo lido do argv versionado (`--model`); `unknown`/`not_applicable` quando não pinado. */
  readonly model: string;
  /**
   * Upstream DECLARADO pelo perfil. Obrigatório para `opencode`, onde o mesmo
   * executável fala com três upstreams e o scaffold não determina nada.
   * Ausente nos perfis legados, onde o scaffold determina o upstream.
   */
  readonly declared_provider?: string | undefined;
}

export const SCAFFOLD_BY_AGENT: Readonly<Record<LegacyAgent, ExecutionScaffold>> = {
  claude: 'claude_code',
  codex: 'codex_cli',
  opencode: 'opencode',
  fake: 'fake',
};

export type ProfileIdentityResolution =
  | { readonly outcome: 'IDENTIFIED'; readonly identity: ProviderIdentity }
  | { readonly outcome: 'UNMAPPABLE'; readonly reason: string };

/**
 * Upstream implícito de um scaffold de provider único. `opencode` NÃO aparece
 * aqui de propósito: inferir upstream para ele seria adivinhar de quem o Lab
 * está comprando, e essa resposta muda cobrança e pool.
 */
const IMPLICIT_PROVIDER: Partial<Record<LegacyAgent, UpstreamProvider>> = {
  claude: 'anthropic',
  codex: 'openai',
  fake: 'none',
};

export function resolveProfileIdentity(input: ProfileIdentityInput): ProfileIdentityResolution {
  const scaffold = SCAFFOLD_BY_AGENT[input.agent];

  if (input.declared_provider !== undefined) {
    const declared = UpstreamProvider.safeParse(input.declared_provider);
    if (!declared.success) {
      return {
        outcome: 'UNMAPPABLE',
        reason: `${input.profile_id}: provider declarado "${input.declared_provider}" não é um upstream conhecido`,
      };
    }
    return identify(input, scaffold, declared.data, 'profile.provider declarado no perfil versionado');
  }

  if (input.agent === 'opencode') {
    return {
      outcome: 'UNMAPPABLE',
      reason:
        `${input.profile_id}: perfil opencode precisa declarar o upstream (provider), ` +
        'porque o mesmo executável fala com upstreams de cobrança e pool diferentes',
    };
  }

  // Um perfil legado de cobrança por API descreve um upstream metered que o
  // Lab não contratou. Ele NÃO é remapeado: continua exatamente como estava.
  if (input.billing_mode === 'api') {
    return {
      outcome: 'UNMAPPABLE',
      reason:
        `${input.profile_id}: billing_mode=api em perfil legado não corresponde a nenhum contrato ` +
        'de upstream declarado; a semântica legada é preservada sem remapear autorização de cobrança',
    };
  }

  const provider = IMPLICIT_PROVIDER[input.agent];
  if (provider === undefined) {
    return {
      outcome: 'UNMAPPABLE',
      reason: `${input.profile_id}: agente ${input.agent} não tem upstream implícito`,
    };
  }
  return identify(
    input,
    scaffold,
    provider,
    `normalização legada: agent=${input.agent} + billing_mode=${input.billing_mode}`,
  );
}

function identify(
  input: ProfileIdentityInput,
  scaffold: ExecutionScaffold,
  provider: UpstreamProvider,
  provenance: string,
): ProfileIdentityResolution {
  try {
    return {
      outcome: 'IDENTIFIED',
      identity: providerIdentityOf({
        execution_scaffold: scaffold,
        provider,
        model: input.model,
        provenance,
      }),
    };
  } catch (error) {
    return {
      outcome: 'UNMAPPABLE',
      reason: `${input.profile_id}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Coerência entre a identidade normalizada e o `billing_mode` LEGADO do perfil.
 *
 * A migração não pode trocar quem paga. Um perfil declarado `subscription_only`
 * que normalizasse para `metered_api` viraria cobrança por uso sem ninguém ter
 * autorizado; o inverso esconderia gasto real atrás de uma palavra de
 * assinatura. Ambos são recusados aqui, antes de qualquer execução.
 */
export function legacyBillingAgrees(
  legacy: LegacyBillingMode,
  identity: ProviderIdentity,
): { readonly agrees: boolean; readonly reason: string } {
  const expected: Record<LegacyBillingMode, ProviderIdentity['billing_mode']> = {
    subscription_only: 'subscription',
    api: 'metered_api',
    not_applicable: 'not_applicable',
  };
  const want = expected[legacy];
  return want === identity.billing_mode
    ? { agrees: true, reason: `billing_mode legado ${legacy} == ${identity.billing_mode} normalizado` }
    : {
        agrees: false,
        reason:
          `billing_mode legado ${legacy} mapearia para ${want}, mas o contrato de ` +
          `${identity.provider} é ${identity.billing_mode}: migração não pode trocar quem paga`,
      };
}
