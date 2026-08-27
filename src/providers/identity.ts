/**
 * IDENTIDADE NORMALIZADA DE UM PERFIL DE EXECUÇÃO.
 *
 * O harness nasceu com um campo só — `agent` — significando ao mesmo tempo
 * qual executável roda, com quem ele fala, quem paga e de qual franquia sai o
 * consumo. Enquanto existiam apenas `claude` e `codex` as quatro respostas
 * coincidiam, e a coincidência passava por design. Com OpenCode elas deixam de
 * coincidir: o MESMO executável fala com três upstreams diferentes, com três
 * mecanismos de autenticação, dois modos de cobrança e três pools de quota.
 *
 * Por isso as dimensões são campos separados, e não um enum combinado. Um enum
 * `opencode_go_deepseek_apikey_subscription` voltaria a esconder exatamente o
 * que este módulo existe para expor — e obrigaria a editar código toda vez que
 * um modelo novo aparecesse.
 *
 * As duas invariantes que este módulo IMPÕE (não apenas documenta):
 *
 *   1. AUTH != BILLING. `api_key` não implica `metered_api`. A chave do
 *      OpenCode Go autentica uma ASSINATURA de valor fixo; tratá-la como
 *      cobrança por uso inverteria a proteção de billing do laboratório.
 *
 *   2. SCAFFOLD != PROVIDER != POOL. `codex_cli -> openai` e
 *      `opencode -> openai` autenticados na mesma conta ChatGPT consomem o
 *      MESMO `openai_chatgpt_subscription`. Contá-los como capacidade
 *      independente é o erro que a diversidade de provider existe para evitar.
 */
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

/**
 * QUAL EXECUTÁVEL roda. É a dimensão que o argv versionado prova, e a única
 * que o launcher precisa conhecer para montar o processo.
 */
export const ExecutionScaffold = z.enum(['claude_code', 'codex_cli', 'opencode', 'fake']);
export type ExecutionScaffold = z.infer<typeof ExecutionScaffold>;

/**
 * COM QUEM o scaffold fala. É a identidade que a política de diversidade deve
 * usar — dois scaffolds diferentes apontando para o mesmo upstream não são
 * duas opiniões independentes.
 *
 * `opencode_go` e `openrouter` são serviços distintos com contratos comerciais
 * distintos, ainda que ambos revendam modelos de terceiros: o que importa aqui
 * é de quem o Lab compra, porque é isso que decide quota e cobrança.
 */
export const UpstreamProvider = z.enum([
  'anthropic',
  'openai',
  'opencode_go',
  'openrouter',
  /** Worker falso: não fala com upstream nenhum. */
  'none',
]);
export type UpstreamProvider = z.infer<typeof UpstreamProvider>;

/**
 * COMO a credencial é apresentada. Deliberadamente separado de cobrança: o
 * mecanismo de autenticação não determina quem paga nem como.
 */
export const AuthMethod = z.enum([
  /** Login OAuth do Claude Code contra claude.ai. */
  'anthropic_subscription_oauth',
  /** "Sign in with ChatGPT" — usado por Codex CLI e por OpenCode/OpenAI. */
  'chatgpt_oauth',
  /** Chave de API. NÃO diz nada sobre modo de cobrança — ver `BillingMode`. */
  'api_key',
  'none',
]);
export type AuthMethod = z.infer<typeof AuthMethod>;

/**
 * QUEM PAGA e COMO.
 *
 * `subscription` — franquia de valor fixo já contratada. Executar consome
 * franquia; não gera cobrança incremental.
 *
 * `metered_api` — cada token é dinheiro incremental. Exige autorização
 * explícita de run, sempre, mesmo quando a credencial já existe.
 */
export const BillingMode = z.enum(['subscription', 'metered_api', 'not_applicable']);
export type BillingMode = z.infer<typeof BillingMode>;

/**
 * DE QUAL FRANQUIA sai o consumo. É a chave de deduplicação de capacidade:
 * dois perfis com o mesmo pool nunca são somados como capacidade independente.
 */
export const QuotaPool = z.enum([
  'anthropic_subscription',
  'openai_chatgpt_subscription',
  'opencode_go_subscription',
  'openrouter_balance',
  'none',
]);
export type QuotaPool = z.infer<typeof QuotaPool>;

/**
 * COMBINAÇÕES LEGAIS, enumeradas.
 *
 * Uma tabela explícita, e não uma regra derivada, porque cada linha é um fato
 * comercial observado nesta máquina — não uma consequência lógica de outra
 * coisa. A linha `opencode_go` é a razão de o módulo existir: `api_key` com
 * `subscription`, que a regra antiga ("chave => API") tornaria impossível de
 * representar sem enfraquecer a proteção de cobrança.
 */
interface ProviderContract {
  readonly provider: UpstreamProvider;
  readonly auth_method: AuthMethod;
  readonly billing_mode: BillingMode;
  readonly quota_pool: QuotaPool;
  /** Scaffolds que sabem falar com este upstream. */
  readonly scaffolds: readonly ExecutionScaffold[];
  readonly rationale: string;
}

export const PROVIDER_CONTRACTS: readonly ProviderContract[] = [
  {
    provider: 'anthropic',
    auth_method: 'anthropic_subscription_oauth',
    billing_mode: 'subscription',
    quota_pool: 'anthropic_subscription',
    scaffolds: ['claude_code'],
    rationale:
      'Claude Code autenticado em claude.ai (authMethod=claude.ai, apiProvider=firstParty) consome a franquia da assinatura Claude',
  },
  {
    provider: 'openai',
    auth_method: 'chatgpt_oauth',
    billing_mode: 'subscription',
    quota_pool: 'openai_chatgpt_subscription',
    scaffolds: ['codex_cli', 'opencode'],
    rationale:
      'Codex CLI e OpenCode/openai usam "Sign in with ChatGPT" — MESMA conta, MESMO pool; provado experimentalmente pelo probe wham/usage reagindo ao consumo de Codex',
  },
  {
    provider: 'opencode_go',
    auth_method: 'api_key',
    billing_mode: 'subscription',
    quota_pool: 'opencode_go_subscription',
    scaffolds: ['opencode'],
    rationale:
      'a chave do OpenCode Go autentica uma ASSINATURA de valor fixo: chave nunca implica cobrança por uso',
  },
  {
    provider: 'openrouter',
    auth_method: 'api_key',
    billing_mode: 'metered_api',
    quota_pool: 'openrouter_balance',
    scaffolds: ['opencode'],
    rationale:
      'OpenRouter cobra por token contra saldo pré-pago: cada execução é dinheiro incremental e exige autorização explícita de run',
  },
  {
    provider: 'none',
    auth_method: 'none',
    billing_mode: 'not_applicable',
    quota_pool: 'none',
    scaffolds: ['fake'],
    rationale: 'worker falso não fala com provider nenhum e não consome franquia de ninguém',
  },
];

export class ProviderIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderIdentityError';
  }
}

/**
 * Identidade completa de um perfil. `capability` é um PRIOR conservador de
 * partida — nunca resultado de benchmark. Perfil novo entra subamostrado, e é
 * a história que decide depois.
 */
export const ProviderIdentity = z
  .object({
    schema_version: z.literal(1),
    execution_scaffold: ExecutionScaffold,
    provider: UpstreamProvider,
    /** Identidade do modelo COMO O SCAFFOLD A ENDEREÇA (ex.: `opencode-go/glm-5.3`). */
    model: nonEmpty,
    auth_method: AuthMethod,
    billing_mode: BillingMode,
    quota_pool: QuotaPool,
    /** Como esta identidade foi obtida: declaração do perfil ou normalização de perfil legado. */
    provenance: nonEmpty,
  })
  .strict()
  .superRefine((identity, ctx) => {
    const reject = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    const contract = PROVIDER_CONTRACTS.find((entry) => entry.provider === identity.provider);
    if (contract === undefined) {
      reject(`provider ${identity.provider} não tem contrato declarado`);
      return;
    }
    if (!contract.scaffolds.includes(identity.execution_scaffold)) {
      reject(
        `scaffold ${identity.execution_scaffold} não fala com ${identity.provider} ` +
          `(scaffolds conhecidos: ${contract.scaffolds.join(', ')})`,
      );
    }
    if (identity.auth_method !== contract.auth_method) {
      reject(
        `auth_method ${identity.auth_method} contradiz o contrato de ${identity.provider} ` +
          `(${contract.auth_method}): ${contract.rationale}`,
      );
    }
    if (identity.billing_mode !== contract.billing_mode) {
      reject(
        `billing_mode ${identity.billing_mode} contradiz o contrato de ${identity.provider} ` +
          `(${contract.billing_mode}): ${contract.rationale}`,
      );
    }
    if (identity.quota_pool !== contract.quota_pool) {
      reject(
        `quota_pool ${identity.quota_pool} contradiz o contrato de ${identity.provider} ` +
          `(${contract.quota_pool}): ${contract.rationale}`,
      );
    }
  });
export type ProviderIdentity = z.infer<typeof ProviderIdentity>;

/**
 * Contrato comercial de um upstream. Existe para que o resto do produto NUNCA
 * derive auth/billing/pool por conta própria — quem precisa da resposta chama
 * aqui, e uma linha nova na tabela chega a todos os consumidores de uma vez.
 */
export function providerContractOf(provider: UpstreamProvider): ProviderContract {
  const contract = PROVIDER_CONTRACTS.find((entry) => entry.provider === provider);
  if (contract === undefined) {
    throw new ProviderIdentityError(`provider desconhecido: ${provider}`);
  }
  return contract;
}

/**
 * Constrói a identidade a partir de scaffold + provider + model, derivando
 * auth/billing/pool do contrato. É o caminho preferido: quem declara um perfil
 * escolhe COM QUEM fala e QUAL modelo, nunca reescreve as consequências
 * comerciais dessa escolha.
 */
export function providerIdentityOf(input: {
  readonly execution_scaffold: ExecutionScaffold;
  readonly provider: UpstreamProvider;
  readonly model: string;
  readonly provenance: string;
}): ProviderIdentity {
  const contract = providerContractOf(input.provider);
  return ProviderIdentity.parse({
    schema_version: 1,
    execution_scaffold: input.execution_scaffold,
    provider: input.provider,
    model: input.model,
    auth_method: contract.auth_method,
    billing_mode: contract.billing_mode,
    quota_pool: contract.quota_pool,
    provenance: input.provenance,
  });
}

/**
 * Perfis que compartilham pool. `none` nunca compartilha nada: um worker falso
 * não é capacidade, e agrupá-lo com outro `none` sugeriria que sim.
 */
export function sharesQuotaPool(left: ProviderIdentity, right: ProviderIdentity): boolean {
  return left.quota_pool !== 'none' && left.quota_pool === right.quota_pool;
}

/**
 * Cobrança incremental exige autorização explícita de run — SEMPRE, mesmo com
 * credencial válida presente. Existência de credencial nunca é autorização
 * para gastar.
 */
export function requiresExplicitSpendAuthorization(identity: ProviderIdentity): boolean {
  return identity.billing_mode === 'metered_api';
}
