import { spawn } from 'node:child_process';
import type { BillingRecord } from './schemas.js';

/**
 * Política de cobrança do laboratório.
 *
 *   assinatura não é API;
 *   estimativa em dólares não é cobrança;
 *   fonte de credencial desconhecida bloqueia o run.
 *
 * Todo run real usa a assinatura do usuário — Claude Pro via login/OAuth do
 * Claude Code, ChatGPT Plus via "Sign in with ChatGPT" do Codex. Nenhum run
 * pode cair em Anthropic API, OpenAI API, créditos de Console ou cobrança por
 * chave, nem por acidente e nem como fallback.
 */

// ---------------------------------------------------------------------------
// Variáveis que forçam (ou desviam) autenticação por API
// ---------------------------------------------------------------------------

/**
 * Nomes verificados contra os binários instalados nesta máquina
 * (Claude Code 2.1.223, codex-cli 0.146.0): todos aparecem literalmente no
 * executável, ou seja, a CLI os reconhece. Basta uma delas chegar ao processo
 * do worker para que o run deixe de ser "assinatura" — por isso a lista é
 * usada como bloqueio, não como aviso.
 *
 * `CODEX_HOME` NÃO entra: é diretório de configuração, não credencial.
 */
export const API_CREDENTIAL_VARIABLES: readonly string[] = [
  // Claude Code
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // Codex
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_ORGANIZATION',
  // Defensiva: não aparece literalmente no binário instalado, mas é a variável
  // padrão do SDK da OpenAI para desviar destino de cobrança.
  'OPENAI_BASE_URL',
];

const API_CREDENTIAL_SET = new Set(API_CREDENTIAL_VARIABLES);

/** Só NOMES são devolvidos — valor de credencial nunca sai daqui. */
export function apiCredentialNamesIn(names: Iterable<string>): string[] {
  return [...new Set([...names].filter((name) => API_CREDENTIAL_SET.has(name)))].sort();
}

export class BillingPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingPolicyError';
  }
}

/**
 * Guarda de ambiente. A allowlist do perfil já filtra o que passa, mas isso é
 * intenção declarada: aqui se confere o ambiente FINAL, depois de `env_extra`
 * e de qualquer variável que o launcher acrescente.
 */
export function assertNoApiCredentials(context: string, env: NodeJS.ProcessEnv): void {
  const found = apiCredentialNamesIn(Object.keys(env));
  if (found.length > 0) {
    throw new BillingPolicyError(
      `${context}: variável de autenticação por API no ambiente do worker: ${found.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Prova da fonte da credencial — comandos LOCAIS e não pagos
// ---------------------------------------------------------------------------

export type CredentialSource =
  | 'claude_subscription_oauth'
  | 'chatgpt_subscription'
  | 'api'
  | 'unknown'
  | 'not_applicable';

/** Texto exigido pela política quando a fonte não pode ser provada. */
export const UNVERIFIABLE_CREDENTIAL_MESSAGE = 'FAIL: credential source could not be verified';

export interface CredentialProbe {
  readonly source: CredentialSource;
  /** Frase curta e SEM segredo: nada de token, chave, e-mail ou id de org. */
  readonly detail: string;
  /** `true` só quando a CLI provou assinatura; ausência de chave não prova. */
  readonly verified: boolean;
  /** Comando local usado, para auditoria do que foi consultado. */
  readonly command: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ code: number | null; output: string }>;

export const spawnRunner: CommandRunner = (command, args, env) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => resolve({ code: null, output }));
    child.on('close', (code) => resolve({ code, output }));
  });

interface ClaudeAuthStatus {
  readonly loggedIn?: unknown;
  readonly authMethod?: unknown;
  readonly apiProvider?: unknown;
  readonly subscriptionType?: unknown;
}

/**
 * `claude auth status --json` é local e gratuito: lê a sessão já autenticada e
 * não faz turno de modelo. A resposta traz e-mail e id de organização — nada
 * disso é copiado para o detalhe do probe.
 */
async function probeClaude(
  binary: string,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<CredentialProbe> {
  const command = `${binary} auth status --json`;
  const { output } = await runner(binary, ['auth', 'status', '--json'], env);

  let status: ClaudeAuthStatus;
  try {
    status = JSON.parse(output.trim()) as ClaudeAuthStatus;
  } catch {
    return {
      source: 'unknown',
      detail: '`auth status --json` não respondeu JSON',
      verified: false,
      command,
    };
  }

  const authMethod = typeof status.authMethod === 'string' ? status.authMethod : '';
  const apiProvider = typeof status.apiProvider === 'string' ? status.apiProvider : '';
  const subscription = typeof status.subscriptionType === 'string' ? status.subscriptionType : '';

  if (status.loggedIn !== true) {
    return { source: 'unknown', detail: 'CLI não está autenticada', verified: false, command };
  }
  if (authMethod === 'claude.ai' && apiProvider === 'firstParty' && subscription !== '') {
    return {
      source: 'claude_subscription_oauth',
      detail: `authMethod=${authMethod} · apiProvider=${apiProvider} · subscriptionType=${subscription}`,
      verified: true,
      command,
    };
  }
  if (/api|key|token|console|bedrock|vertex|foundry/i.test(`${authMethod} ${apiProvider}`)) {
    return {
      source: 'api',
      detail: `authMethod=${authMethod || '?'} · apiProvider=${apiProvider || '?'}`,
      verified: true,
      command,
    };
  }
  return {
    source: 'unknown',
    detail: `authMethod=${authMethod || '?'} · apiProvider=${apiProvider || '?'} não identificam assinatura`,
    verified: false,
    command,
  };
}

/**
 * `codex login status` é local e gratuito. A saída é texto ("Logged in using
 * ChatGPT"), então o reconhecimento é por frase — e o texto bruto NÃO é
 * repassado, porque versões podem incluir a conta na mesma linha.
 */
async function probeCodex(
  binary: string,
  env: NodeJS.ProcessEnv,
  runner: CommandRunner,
): Promise<CredentialProbe> {
  const command = `${binary} login status`;
  const { output } = await runner(binary, ['login', 'status'], env);
  const text = output.trim();

  if (/logged in using chatgpt/i.test(text)) {
    return {
      source: 'chatgpt_subscription',
      detail: 'login status reporta conta ChatGPT',
      verified: true,
      command,
    };
  }
  if (/api key/i.test(text)) {
    return { source: 'api', detail: 'login status reporta API key', verified: true, command };
  }
  if (/not logged in/i.test(text) || text === '') {
    return { source: 'unknown', detail: 'CLI não está autenticada', verified: false, command };
  }
  return {
    source: 'unknown',
    detail: 'login status não identifica a fonte da credencial',
    verified: false,
    command,
  };
}

export interface ProbeInput {
  readonly agent: 'claude' | 'codex' | 'fake';
  /** Binário do PERFIL: prova a credencial do mesmo executável que vai rodar. */
  readonly binary: string;
  /** Ambiente do worker: a prova precisa valer para o processo que vai nascer. */
  readonly env: NodeJS.ProcessEnv;
  readonly runner?: CommandRunner;
}

export async function probeCredentialSource(input: ProbeInput): Promise<CredentialProbe> {
  const runner = input.runner ?? spawnRunner;
  if (input.agent === 'fake') {
    return {
      source: 'not_applicable',
      detail: 'worker falso não fala com provider nenhum',
      verified: false,
      command: '(nenhum)',
    };
  }
  return input.agent === 'claude'
    ? probeClaude(input.binary, input.env, runner)
    : probeCodex(input.binary, input.env, runner);
}

/** Fonte de credencial que a política aceita para cada agente. */
export function expectedSubscriptionSource(agent: 'claude' | 'codex'): CredentialSource {
  return agent === 'claude' ? 'claude_subscription_oauth' : 'chatgpt_subscription';
}

// ---------------------------------------------------------------------------
// Preflight: repetido antes de CADA lançamento, não só no doctor
// ---------------------------------------------------------------------------

/**
 * Autorização manual para perfis de cobrança por API. Não existe fallback
 * automático: sem esta variável explícita no ambiente do ORQUESTRADOR (não do
 * worker), perfil `billing_mode: api` é recusado.
 */
export const API_BILLING_AUTHORIZATION_VARIABLE = 'AGENTLAB_ALLOW_API_BILLING';
export const API_BILLING_AUTHORIZATION_VALUE = 'eu-autorizo-cobranca-por-api';

export interface PreflightInput {
  readonly agent: 'claude' | 'codex' | 'fake';
  readonly billingMode: 'subscription_only' | 'api' | 'not_applicable';
  readonly binary: string;
  /** Ambiente FINAL do worker, já filtrado pela allowlist do perfil. */
  readonly env: NodeJS.ProcessEnv;
  /** Ambiente do orquestrador — só para ler a autorização manual. */
  readonly orchestratorEnv?: NodeJS.ProcessEnv;
  readonly runner?: CommandRunner;
}

export interface PreflightOutcome {
  readonly ok: boolean;
  /** Motivo da recusa; `null` quando liberado. */
  readonly refusal: string | null;
  readonly credential: CredentialProbe;
}

/**
 * Guarda crítica de cobrança, repetida ANTES do spawn. Recusar aqui não é
 * veredito sobre o worker: nenhum processo nasceu, nenhuma tarefa falhou.
 */
export async function runBillingPreflight(input: PreflightInput): Promise<PreflightOutcome> {
  const notProbed: CredentialProbe = {
    source: 'unknown',
    detail: 'não consultado',
    verified: false,
    command: '(nenhum)',
  };

  if (input.agent === 'fake') {
    // Worker falso não fala com provider nenhum: não há o que cobrar. A guarda
    // de ambiente continua valendo, para que o saneamento seja demonstrável.
    const leaked = apiCredentialNamesIn(Object.keys(input.env));
    const credential: CredentialProbe = {
      source: 'not_applicable',
      detail: 'worker falso não fala com provider nenhum',
      verified: false,
      command: '(nenhum)',
    };
    return leaked.length > 0
      ? {
          ok: false,
          refusal: `variável de autenticação por API no ambiente do worker: ${leaked.join(', ')}`,
          credential,
        }
      : { ok: true, refusal: null, credential };
  }

  if (input.billingMode !== 'subscription_only') {
    const authorized =
      input.billingMode === 'api' &&
      (input.orchestratorEnv ?? {})[API_BILLING_AUTHORIZATION_VARIABLE] ===
        API_BILLING_AUTHORIZATION_VALUE;
    if (!authorized) {
      return {
        ok: false,
        refusal:
          `billing_mode=${input.billingMode}: só perfil subscription_only roda sem autorização ` +
          `manual (${API_BILLING_AUTHORIZATION_VARIABLE}=${API_BILLING_AUTHORIZATION_VALUE})`,
        credential: notProbed,
      };
    }
  }

  const leaked = apiCredentialNamesIn(Object.keys(input.env));
  if (leaked.length > 0) {
    return {
      ok: false,
      refusal: `variável de autenticação por API no ambiente do worker: ${leaked.join(', ')}`,
      credential: notProbed,
    };
  }

  const credential = await probeCredentialSource({
    agent: input.agent,
    binary: input.binary,
    env: input.env,
    ...(input.runner ? { runner: input.runner } : {}),
  });

  if (input.billingMode === 'subscription_only') {
    const expected = expectedSubscriptionSource(input.agent);
    if (credential.source === 'api') {
      return {
        ok: false,
        refusal: `fonte da credencial é API (${credential.detail}) — perfil exige assinatura`,
        credential,
      };
    }
    if (credential.source !== expected || !credential.verified) {
      // Ausência de chave NÃO prova assinatura: sem prova positiva, recusa.
      return {
        ok: false,
        refusal: `${UNVERIFIABLE_CREDENTIAL_MESSAGE} (${credential.detail})`,
        credential,
      };
    }
  }

  return { ok: true, refusal: null, credential };
}

// ---------------------------------------------------------------------------
// Custo: equivalência estimada ≠ cobrança
// ---------------------------------------------------------------------------

export interface ProviderUsageEstimate {
  /** O que a CLI estima em preço de API. NÃO é valor cobrado. */
  readonly estimated_api_equivalent_usd: number | null;
  readonly turns: number | null;
}

function usageFrom(value: unknown): ProviderUsageEstimate | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const cost = record['total_cost_usd'];
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return null;
  const turns = record['num_turns'];
  return {
    estimated_api_equivalent_usd: cost,
    turns: typeof turns === 'number' ? turns : null,
  };
}

/**
 * Lê a estimativa que a CLI emite no próprio stdout (`--output-format json` no
 * Claude, JSONL no Codex). Tudo aqui é ESTIMATIVA por preço de API sobre
 * tokens: com assinatura, o run consome a franquia incluída, e o número não
 * corresponde a nenhuma cobrança adicional.
 */
const EMPTY_USAGE: ProviderUsageEstimate = { estimated_api_equivalent_usd: null, turns: null };

/**
 * Mesma leitura, a partir de UM objeto já parseado — a mensagem `type=result`
 * do stream-json. O contrato é o mesmo do objeto único de `--output-format
 * json`: `total_cost_usd` e `num_turns` saem do mesmo lugar semântico.
 */
export function usageEstimateOf(value: unknown): ProviderUsageEstimate {
  return usageFrom(value) ?? EMPTY_USAGE;
}

export function extractUsageEstimate(stdout: string): ProviderUsageEstimate {
  const empty = EMPTY_USAGE;
  const text = stdout.trim();
  if (text === '') return empty;

  try {
    const whole = usageFrom(JSON.parse(text));
    if (whole) return whole;
  } catch {
    // Não é um objeto único: cai para a leitura linha a linha (JSONL).
  }

  let last: ProviderUsageEstimate | null = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;
    try {
      const found = usageFrom(JSON.parse(trimmed));
      if (found) last = found;
    } catch {
      // Linha que não é JSON não é erro: o stdout mistura formatos.
    }
  }
  return last ?? empty;
}

export interface BillingRecordInput {
  readonly mode: 'subscription_only' | 'api' | 'not_applicable';
  readonly credentialSource: CredentialSource;
  /** `true` quando o run de fato aconteceu com a assinatura do usuário. */
  readonly consumedAllowance: boolean;
  readonly estimate: ProviderUsageEstimate;
}

/**
 * `actual_incremental_charge_usd` fica `null` por construção: não existe fonte
 * de faturamento autoritativa acoplada ao harness, e inferir `0` seria a mesma
 * mentira que chamar a estimativa de cobrança.
 */
export function buildBillingRecord(input: BillingRecordInput): BillingRecord {
  return {
    mode: input.mode,
    credential_source: input.credentialSource,
    included_allowance_consumed: input.consumedAllowance,
    provider_estimated_api_equivalent_usd: input.estimate.estimated_api_equivalent_usd,
    actual_incremental_charge_usd: null,
    authoritative_billing_verified: false,
  };
}

/** Rótulo obrigatório em relatório de terminal: o número é equivalência. */
export const ESTIMATED_COST_LABEL = 'custo equivalente estimado (preço de API), não custo pago';
