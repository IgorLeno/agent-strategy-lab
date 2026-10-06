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

export const Tier = z.enum(['economy', 'standard', 'premium']);
export type Tier = z.infer<typeof Tier>;

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
    tier: Tier,
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
 * Catálogo padrão aprovado em 2026-10-06 (plano, decisão Q2). Modelos e flags
 * vêm dos perfis já verificados em `dev/profiles/`.
 */
export const DEFAULT_CATALOG: readonly ModelProfile[] = buildCatalog([
  { id: 'claude-opus-5-high', scaffold: 'claude_code', provider: 'anthropic', model: 'claude-opus-5', effort: 'high', tier: 'premium', cost_rank: 7 },
  { id: 'codex-sol-high', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-5.6-sol', effort: 'high', tier: 'premium', cost_rank: 6 },
  { id: 'claude-sonnet-5-medium', scaffold: 'claude_code', provider: 'anthropic', model: 'claude-sonnet-5', effort: 'medium', tier: 'standard', cost_rank: 4 },
  { id: 'codex-sol-medium', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-5.6-sol', effort: 'medium', tier: 'standard', cost_rank: 5 },
  { id: 'opencode-go-glm-5.3', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/glm-5.3', effort: null, tier: 'standard', cost_rank: 3 },
  { id: 'codex-luna-medium', scaffold: 'codex_cli', provider: 'openai', model: 'gpt-5.6-luna', effort: 'medium', tier: 'economy', cost_rank: 2 },
  { id: 'opencode-go-deepseek-v4-flash', scaffold: 'opencode', provider: 'opencode_go', model: 'opencode-go/deepseek-v4-flash', effort: null, tier: 'economy', cost_rank: 1 },
]);

export function profilesOfTier(catalog: readonly ModelProfile[], tier: Tier): readonly ModelProfile[] {
  return catalog.filter((profile) => profile.tier === tier);
}
