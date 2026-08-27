/**
 * OPEN CODE COMO SCAFFOLD DE EXECUÇÃO DO LAB.
 *
 * ## Fronteira de role, estrutural
 *
 * Planner e reviewer são READ-ONLY. Isso NÃO é pedido no prompt: é imposto pelo
 * mecanismo de permissão da própria CLI, verificado contra o binário instalado
 * (1.18.23).
 *
 * O que foi lido no binário, e é o motivo de o desenho ser este:
 *
 *   `Permission.ask` avalia a regra ANTES de publicar qualquer pedido:
 *   `action === "deny"` levanta `DeniedError` na hora. O evento
 *   `permission.asked` — o único que `--auto` responde — nunca chega a existir
 *   para uma permissão negada. Portanto `deny` não é contornável por `--auto`,
 *   e a fronteira do Lab não depende da configuração global do usuário.
 *
 *   `Permission.disabled` remove do toolset visível toda ferramenta cuja regra
 *   resolvida seja `pattern:"*"` + `action:"deny"`. A ferramenta negada não é
 *   recusada depois de escolhida: ela não é oferecida.
 *
 *   `Permission.fromConfig` transforma o objeto de configuração numa lista de
 *   regras na ORDEM DAS CHAVES, e `evaluate` usa `findLast`. A última regra que
 *   casa vence. Por isso o catch-all `*` vem PRIMEIRO neste arquivo e as
 *   liberações específicas vêm depois — inverter a ordem liberaria tudo.
 *
 *   Sem regra que case, o default é `ask`. Um `ask` num processo não
 *   interativo trava; e travar não é o mesmo que negar. Por isso toda role
 *   fecha com um catch-all explícito em vez de contar com o default.
 *
 * ## Como a configuração chega
 *
 * `OPENCODE_PERMISSION` é lido pelo carregador de configuração e mesclado por
 * ÚLTIMO, sobre a configuração global e a de projeto. A mescla é por chave, e é
 * exatamente por isso que o Lab escreve o objeto COMPLETO: uma chave que o Lab
 * omitisse continuaria valendo o que o usuário tiver configurado. A
 * configuração global do usuário não é lida como garantia, não é modificada, e
 * não precisa estar de nenhum jeito específico.
 */
import type { UpstreamProvider } from '../../src/providers/index.js';

/** Role do worker na perspectiva da fronteira de permissão. */
export type OpenCodeRole = 'planner' | 'implementer' | 'reviewer';

export type OpenCodePermissionAction = 'allow' | 'ask' | 'deny';

/**
 * Ferramentas de LEITURA que planner e reviewer precisam. Inspecionar código,
 * buscar, listar e ler diff/log continuam possíveis: read-only é sobre mutação,
 * não sobre cegueira.
 */
const READ_ONLY_ALLOWED: readonly string[] = ['read', 'glob', 'grep', 'list', 'lsp', 'todowrite'];

/**
 * Ferramentas de MUTAÇÃO negadas em role read-only. Enumeradas além do
 * catch-all porque a lista documenta a intenção e sobrevive a uma futura
 * mudança na semântica do curinga.
 */
const MUTATION_TOOLS: readonly string[] = ['edit', 'write', 'patch', 'apply_patch', 'bash'];

/**
 * Comandos de shell autorizados ao implementer, por prefixo. `git commit` e
 * `git push` NÃO estão aqui: o ownership de commit é do orquestrador, e uma
 * regra de permissão que os liberasse contradiria a execution policy.
 */
export interface OpenCodePermissionConfig {
  readonly [key: string]: OpenCodePermissionAction | Record<string, OpenCodePermissionAction>;
}

/**
 * Padrões de bash estruturalmente negados ao implementer.
 *
 * `git commit`/`git push` porque o commit pertence ao orquestrador. Os
 * destrutivos porque nenhuma tarefa do Lab precisa deles e o custo de um
 * engano é irreversível. `git log`, `git diff`, `git status` continuam
 * liberados: inspecionar histórico não muta nada.
 */
const IMPLEMENTER_DENIED_COMMANDS: readonly string[] = [
  'git commit*',
  'git push*',
  'git reset --hard*',
  'git clean*',
  'rm -rf*',
  'sudo*',
  'shutdown*',
  'reboot*',
  'mkfs*',
  'dd if=*',
];

/**
 * Permissão do Lab para uma role. Objeto COMPLETO: nenhuma chave é deixada para
 * a configuração do usuário decidir.
 *
 * A ordem das chaves é significativa (`findLast` vence). O catch-all `*` é a
 * primeira chave; tudo depois dele é exceção deliberada.
 */
export function openCodePermissionFor(role: OpenCodeRole): OpenCodePermissionConfig {
  if (role === 'implementer') {
    const config: Record<string, OpenCodePermissionAction | Record<string, OpenCodePermissionAction>> = {
      // Nada que o Lab não tenha considerado roda sem pedir. `ask` num
      // processo não interativo não concede: ele impede o uso silencioso de
      // uma ferramenta nova que esta versão do Lab não conhece.
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      list: 'allow',
      lsp: 'allow',
      todowrite: 'allow',
      // Mutação é o ponto do implementer — dentro do workspace autorizado, que
      // é imposto por `external_directory` abaixo, não por confiança.
      edit: 'allow',
      write: 'allow',
      patch: 'allow',
      apply_patch: 'allow',
      // Fora do workspace autorizado não há leitura nem escrita. É esta chave
      // que transforma "só mexa no diretório certo" em fronteira real.
      external_directory: 'deny',
      // Rede e subagente ficam fora: nenhum dos dois é necessário para
      // implementar uma work unit, e ambos ampliariam a superfície sem que a
      // autorização do run tivesse dito nada a respeito.
      webfetch: 'deny',
      websearch: 'deny',
      task: 'deny',
      // `bash` é um objeto de padrões, e `findLast` também vale DENTRO dele:
      // o catch-all `*` vem primeiro para que cada `deny` específico vença.
      bash: Object.fromEntries([
        ['*', 'allow' as const],
        ...IMPLEMENTER_DENIED_COMMANDS.map((pattern) => [pattern, 'deny' as const]),
      ]) as Record<string, OpenCodePermissionAction>,
    };
    return config;
  }

  // Planner e reviewer: mutação estruturalmente impossível.
  const readOnly: Record<string, OpenCodePermissionAction> = { '*': 'deny' };
  for (const tool of MUTATION_TOOLS) readOnly[tool] = 'deny';
  readOnly['external_directory'] = 'deny';
  readOnly['webfetch'] = 'deny';
  readOnly['websearch'] = 'deny';
  readOnly['task'] = 'deny';
  for (const tool of READ_ONLY_ALLOWED) readOnly[tool] = 'allow';
  return readOnly;
}

export const OPENCODE_PERMISSION_VARIABLE = 'OPENCODE_PERMISSION';

/** Variáveis que o Lab define para que o launch não dependa do ambiente do usuário. */
export const OPENCODE_DISABLE_PROJECT_CONFIG_VARIABLE = 'OPENCODE_DISABLE_PROJECT_CONFIG';

export function openCodePermissionEnv(role: OpenCodeRole): Record<string, string> {
  return {
    [OPENCODE_PERMISSION_VARIABLE]: JSON.stringify(openCodePermissionFor(role)),
    // Configuração de projeto do repositório ALVO não governa a fronteira do
    // Lab: ela vive no repositório que o worker está autorizado a modificar.
    [OPENCODE_DISABLE_PROJECT_CONFIG_VARIABLE]: '1',
  };
}

/**
 * Role read-only tem mutação estruturalmente negada?
 *
 * Verifica a configuração pela MESMA regra que a CLI usa (`findLast` sobre as
 * chaves na ordem em que aparecem), em vez de conferir presença de chave. Uma
 * checagem que só olhasse `config[tool] === 'deny'` aprovaria uma configuração
 * onde um curinga posterior reabrisse a ferramenta.
 */
export function mutationStructurallyDenied(config: OpenCodePermissionConfig): boolean {
  return MUTATION_TOOLS.every((tool) => resolveAction(config, tool) === 'deny');
}

/** Resolve a ação efetiva de uma permissão pela semântica de `findLast` da CLI. */
export function resolveAction(
  config: OpenCodePermissionConfig,
  permission: string,
  pattern = '*',
): OpenCodePermissionAction {
  let action: OpenCodePermissionAction = 'ask';
  for (const [key, value] of Object.entries(config)) {
    if (!globMatches(key, permission)) continue;
    if (typeof value === 'string') {
      action = value;
      continue;
    }
    for (const [rulePattern, ruleAction] of Object.entries(value)) {
      if (globMatches(rulePattern, pattern)) action = ruleAction;
    }
  }
  return action;
}

/** Curinga `*` simples, que é o que as chaves de permissão usam. */
function globMatches(rule: string, value: string): boolean {
  if (rule === '*') return true;
  if (!rule.includes('*')) return rule === value;
  const source = rule
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(value);
}

// ---------------------------------------------------------------------------
// Modelo: `provider/model` como o OpenCode o endereça
// ---------------------------------------------------------------------------

/**
 * Prefixo do `--model` do OpenCode -> upstream do Lab.
 *
 * Um perfil declara o upstream explicitamente; este mapa existe para CONFERIR
 * a declaração contra o modelo, não para substituí-la. Prefixo desconhecido é
 * erro: adivinhar de quem o Lab está comprando decidiria cobrança e pool.
 */
const OPENCODE_PROVIDER_PREFIX: Readonly<Record<string, UpstreamProvider>> = {
  'opencode-go': 'opencode_go',
  openai: 'openai',
  openrouter: 'openrouter',
};

export interface OpenCodeModelIdentity {
  readonly provider: UpstreamProvider;
  /** Modelo como o OpenCode o endereça, com prefixo (`opencode-go/glm-5.3`). */
  readonly addressed_model: string;
  /** Prefixo do OpenCode, preservado para auditoria do que foi pedido à CLI. */
  readonly opencode_provider: string;
}

export class OpenCodeModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenCodeModelError';
  }
}

export function parseOpenCodeModel(addressed: string): OpenCodeModelIdentity {
  const separator = addressed.indexOf('/');
  if (separator <= 0 || separator === addressed.length - 1) {
    throw new OpenCodeModelError(
      `modelo OpenCode precisa ter a forma provider/model: recebido "${addressed}"`,
    );
  }
  const prefix = addressed.slice(0, separator);
  const provider = OPENCODE_PROVIDER_PREFIX[prefix];
  if (provider === undefined) {
    throw new OpenCodeModelError(
      `prefixo de provider "${prefix}" não tem upstream declarado no Lab ` +
        `(conhecidos: ${Object.keys(OPENCODE_PROVIDER_PREFIX).sort().join(', ')})`,
    );
  }
  return { provider, addressed_model: addressed, opencode_provider: prefix };
}

/**
 * O upstream declarado pelo perfil bate com o que o modelo endereça?
 *
 * Declaração e modelo são duas afirmações independentes sobre a mesma coisa;
 * exigir que concordem pega o erro que nenhuma das duas pegaria sozinha —
 * um perfil rotulado `opencode_go` apontando para um modelo do OpenRouter
 * (assinatura virando cobrança por uso, sem ninguém notar).
 */
export function declaredProviderAgrees(
  declared: UpstreamProvider,
  addressed: string,
): { readonly agrees: boolean; readonly reason: string } {
  let identity: OpenCodeModelIdentity;
  try {
    identity = parseOpenCodeModel(addressed);
  } catch (error) {
    return { agrees: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return identity.provider === declared
    ? {
        agrees: true,
        reason: `provider declarado ${declared} == prefixo ${identity.opencode_provider} do modelo`,
      }
    : {
        agrees: false,
        reason:
          `provider declarado ${declared} contradiz o modelo ${addressed}, que endereça ` +
          `${identity.provider}: cobrança e pool seriam os do upstream errado`,
      };
}


// ---------------------------------------------------------------------------
// Telemetria por run, lida da saída MÁQUINA do `--format json`
// ---------------------------------------------------------------------------

/**
 * Consumo que o PRÓPRIO OpenCode reportou sobre este run.
 *
 * A fonte é o evento `step_finish` do `opencode run --format json`, que traz
 * `tokens` e `cost` por passo. Não é `opencode stats`: aquele é um agregado
 * LOCAL de todas as sessões do OpenCode na máquina, e não sabe distinguir este
 * run dos outros — usá-lo para atribuir consumo a uma task inventaria a
 * atribuição.
 *
 * Os campos são somados entre passos do MESMO run, que é a granularidade que a
 * saída oferece. Ausência permanece `null`: um run sem evento de passo não
 * consumiu "zero", ele não reportou.
 */
export interface OpenCodeRunUsage {
  readonly total_tokens: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  /** Equivalência em preço de API reportada pela CLI. NÃO é cobrança. */
  readonly reported_cost_usd: number | null;
}

const EMPTY_RUN_USAGE: OpenCodeRunUsage = {
  total_tokens: null,
  input_tokens: null,
  output_tokens: null,
  reasoning_tokens: null,
  cache_read_tokens: null,
  cache_write_tokens: null,
  reported_cost_usd: null,
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Soma que preserva a ausência: `null + null` continua `null`, não vira 0. */
function addObserved(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

export function openCodeRunUsageOf(stdout: string): OpenCodeRunUsage {
  let usage = EMPTY_RUN_USAGE;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Linha que não é JSON não é erro: a saída pode misturar formatos.
      continue;
    }
    const event = asRecord(parsed);
    if (event?.['type'] !== 'step_finish') continue;
    const part = asRecord(event['part']);
    if (part === null) continue;
    const tokens = asRecord(part['tokens']);
    const cache = tokens === null ? null : asRecord(tokens['cache']);
    usage = {
      total_tokens: addObserved(usage.total_tokens, finiteNumber(tokens?.['total'])),
      input_tokens: addObserved(usage.input_tokens, finiteNumber(tokens?.['input'])),
      output_tokens: addObserved(usage.output_tokens, finiteNumber(tokens?.['output'])),
      reasoning_tokens: addObserved(usage.reasoning_tokens, finiteNumber(tokens?.['reasoning'])),
      cache_read_tokens: addObserved(usage.cache_read_tokens, finiteNumber(cache?.['read'])),
      cache_write_tokens: addObserved(usage.cache_write_tokens, finiteNumber(cache?.['write'])),
      reported_cost_usd: addObserved(usage.reported_cost_usd, finiteNumber(part['cost'])),
    };
  }
  return usage;
}
