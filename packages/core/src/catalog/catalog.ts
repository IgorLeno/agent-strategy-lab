/**
 * CATÁLOGO DE MODELOS: o que o router pode escolher, agrupado por tier.
 *
 * Substitui o `CapabilityPrior` dos perfis antigos e o tier por regex de nome
 * de modelo de `src/routing/router.ts`. O tier é DECLARADO aqui; o planner marca
 * o tier de cada step e o router só escolhe dentro dele.
 *
 * Só entra perfil de assinatura. Perfil `metered_api` (OpenRouter) é recusado
 * no carregamento: o roteamento automático nunca pode gastar dinheiro por
 * token, e recusar aqui é mais simples do que lembrar de filtrar depois.
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import {
  ExecutionScaffold,
  UpstreamProvider,
  providerIdentityOf,
  requiresExplicitSpendAuthorization,
  type ProviderIdentity,
} from '../providers/identity.js';

/**
 * Sete tiers, do mais exigente ao mais barato (catálogo do usuário,
 * 2026-10-07). O planner marca o tier de cada step; o router só escolhe
 * dentro dele.
 */
export const TIERS = ['frontier', 'expert', 'advanced', 'balanced', 'core', 'fast', 'economy'] as const;
export const Tier = z.enum(TIERS);
export type Tier = z.infer<typeof Tier>;

/** Step sem tier no `plan.md`: o do meio da escala. */
export const DEFAULT_TIER: Tier = 'balanced';

/**
 * Nomes da escala antiga de três tiers, aceitos em planos já escritos.
 * `economy` continua existindo e passa a ser o tier 7.
 */
export const TIER_ALIASES: Readonly<Record<string, Tier>> = {
  premium: 'frontier',
  standard: 'balanced',
};

/** Tier canônico de um nome (canônico ou alias); `null` se desconhecido. */
export function tierOf(name: string): Tier | null {
  const parsed = Tier.safeParse(name);
  if (parsed.success) return parsed.data;
  return TIER_ALIASES[name] ?? null;
}

const nonEmpty = z.string().trim().min(1);

export const ModelProfileInput = z
  .object({
    id: nonEmpty,
    scaffold: ExecutionScaffold,
    provider: UpstreamProvider,
    /** Modelo como o scaffold o endereça (`claude-opus-5`, `opencode-go/glm-5.3`). */
    model: nonEmpty,
    /** Reasoning effort; `null` quando o scaffold não tem a dimensão ou o perfil não a fixa. */
    effort: nonEmpty.nullable(),
    /** Aceita os aliases da escala antiga, como o `plan.md`. */
    tier: z.preprocess((value) => (typeof value === 'string' ? (tierOf(value) ?? value) : value), Tier),
    /** Ordem de custo relativa dentro do catálogo: menor é mais barato. Só desempata. */
    cost_rank: z.number().int().nonnegative(),
  })
  .strict();
export type ModelProfileInput = z.infer<typeof ModelProfileInput>;

export interface ModelProfile extends ModelProfileInput {
  readonly identity: ProviderIdentity;
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** Valida identidade e cobrança de cada perfil e recusa ids repetidos. */
export function buildCatalog(inputs: readonly unknown[]): readonly ModelProfile[] {
  const seen = new Set<string>();
  return inputs.map((raw, index) => {
    const parsed = ModelProfileInput.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`);
      throw new CatalogError(`perfil #${index} inválido: ${issues.join('; ')}`);
    }
    const input = parsed.data;
    if (seen.has(input.id)) throw new CatalogError(`perfil repetido: ${input.id}`);
    seen.add(input.id);

    let identity: ProviderIdentity;
    try {
      identity = providerIdentityOf({
        execution_scaffold: input.scaffold,
        provider: input.provider,
        model: input.model,
        provenance: `catálogo:${input.id}`,
      });
    } catch (error) {
      throw new CatalogError(
        `perfil ${input.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (requiresExplicitSpendAuthorization(identity)) {
      throw new CatalogError(
        `perfil ${input.id} cobra por uso (${identity.provider}); o catálogo só aceita assinatura`,
      );
    }
    return { ...input, identity };
  });
}

/** Catálogo em YAML: `profiles: [...]`. */
export function parseCatalogYaml(text: string): readonly ModelProfile[] {
  const document: unknown = parseYaml(text);
  const profiles =
    typeof document === 'object' && document !== null && 'profiles' in document
      ? (document as { profiles: unknown }).profiles
      : undefined;
  if (!Array.isArray(profiles)) throw new CatalogError('catálogo YAML sem lista `profiles`');
  return buildCatalog(profiles);
}

/**
 * Catálogo padrão (2026-10-07, tabela do usuário em 7 tiers). O router tenta
 * o mais barato primeiro dentro do tier: `cost_rank` cresce do tier
 * `economy` ao `frontier` e, dentro de cada tier, OpenCode Go (franquia fixa)
 * < Codex < Claude; entre modelos OpenCode do mesmo tier vale a ordem da
 * tabela. `gpt-6.1-sol` da tabela é recusado pela conta Codex (400 "not
 * supported", verificado em 2026-10-07): `gpt-6-sol` ocupa as três vagas
 * até a conta aceitar. `claude-sonnet-5-5` responde normalmente, mas a CLI
 * 2.1.281 ainda imprime `unrecognized_model` no stderr (aviso, não falha).
 */
export const DEFAULT_CATALOG: readonly ModelProfile[] = buildCatalog([
  { id: 'claude-opus-5.5-medium', scaffold: 'claude_code', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', tier: 'frontier', cost_rank: 67 },
  { id: 'codex-sol-6-high', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-6-sol', effort: 'high', tier: 'frontier', cost_rank: 65 },
  { id: 'claude-sonnet-5.5-high', scaffold: 'claude_code', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'high', tier: 'frontier', cost_rank: 67 },
  { id: 'codex-sol-6-medium', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-6-sol', effort: 'medium', tier: 'expert', cost_rank: 55 },
  { id: 'claude-sonnet-5.5-medium', scaffold: 'claude_code', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', tier: 'expert', cost_rank: 57 },
  { id: 'opencode-go-deepseek-v4.1-flash', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/deepseek-v4.1-flash', effort: null, tier: 'expert', cost_rank: 50 },
  { id: 'codex-sol-6-low', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-6-sol', effort: 'low', tier: 'advanced', cost_rank: 45 },
  { id: 'claude-sonnet-5.5-low', scaffold: 'claude_code', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', tier: 'advanced', cost_rank: 47 },
  { id: 'opencode-go-qwen3.8-max', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/qwen3.8-max', effort: null, tier: 'advanced', cost_rank: 40 },
  { id: 'codex-luna-6-max', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-6-luna', effort: 'max', tier: 'balanced', cost_rank: 35 },
  { id: 'opencode-go-glm-5.3', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/glm-5.3', effort: null, tier: 'balanced', cost_rank: 30 },
  { id: 'opencode-go-deepseek-v4-pro', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/deepseek-v4-pro', effort: null, tier: 'balanced', cost_rank: 31 },
  { id: 'codex-luna-6-high', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-6-luna', effort: 'high', tier: 'core', cost_rank: 25 },
  { id: 'opencode-go-kimi-k2.7-code', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/kimi-k2.7-code', effort: null, tier: 'core', cost_rank: 20 },
  { id: 'opencode-go-qwen3.8-flash', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/qwen3.8-flash', effort: null, tier: 'core', cost_rank: 21 },
  { id: 'codex-luna-6-medium', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-6-luna', effort: 'medium', tier: 'fast', cost_rank: 15 },
  { id: 'opencode-go-glm-5.3-flash', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/glm-5.3-flash', effort: null, tier: 'fast', cost_rank: 10 },
  { id: 'opencode-go-minimax-m3', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/minimax-m3', effort: null, tier: 'fast', cost_rank: 11 },
  { id: 'codex-luna-6-low', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-6-luna', effort: 'low', tier: 'economy', cost_rank: 5 },
  { id: 'opencode-go-mimo-v2.6-flash', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/mimo-v2.6-flash', effort: null, tier: 'economy', cost_rank: 0 },
  { id: 'opencode-go-longcat-2.0', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/longcat-2.0', effort: null, tier: 'economy', cost_rank: 1 },
]);

export function profilesOfTier(catalog: readonly ModelProfile[], tier: Tier): readonly ModelProfile[] {
  return catalog.filter((profile) => profile.tier === tier);
}
