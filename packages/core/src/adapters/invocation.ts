/**
 * ARGV/ENV/STDIN DE UM STEP, por scaffold e modo de permissão.
 *
 * Os três modos (decisão Q1, 2026-10-06), num processo SEM humano:
 *
 *   plan  — só leitura. Nada muda no disco.
 *   edit  — edita arquivos e roda só os comandos da allowlist do projeto.
 *   auto  — qualquer shell, exceto commit/push e comandos destrutivos.
 *
 * "Pedir permissão" não existe aqui: um pedido num processo não interativo
 * trava o step. Por isso todo scaffold é configurado para NEGAR o que não está
 * liberado, nunca para perguntar (`--permission-prompts none` no Claude,
 * catch-all `deny` no OpenCode).
 *
 * Commit e push pertencem ao loop, não ao agente: os três modos os negam.
 *
 * Função pura: não resolve binário, não lê `process.env` sozinha, não faz
 * spawn. O ambiente de origem entra explícito.
 */
import type { ModelProfile } from '../catalog/catalog.js';
import type { AdapterInvocation } from './contract.js';
import {
  OPENCODE_DISABLE_PROJECT_CONFIG_VARIABLE,
  OPENCODE_PERMISSION_VARIABLE,
  type OpenCodePermissionAction,
  type OpenCodePermissionConfig,
} from './opencode-scaffold.js';

export type PermissionMode = 'plan' | 'edit' | 'auto';

/**
 * Flags que o core NUNCA emite. Retomar sessão quebra o "processo novo por
 * step"; `--bare` força cobrança por API no Claude; pular permissões anula os
 * modos.
 */
export const FORBIDDEN_FLAGS: readonly string[] = [
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--fork-session',
  '--session-id',
  '--bare',
  '--api-key',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--with-api-key',
  '--with-access-token',
  '--auto',
  '--session',
  '--fork',
];

/**
 * Variáveis que desviam a CLI de assinatura para cobrança por API. Lista de
 * `dev/lib/billing.ts` (verificada contra os binários em 2026-08), mais a
 * chave do OpenRouter. São REMOVIDAS do ambiente do step, não só avisadas.
 */
export const API_CREDENTIAL_VARIABLES: readonly string[] = [
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
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_ORGANIZATION',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
];

/** Comandos de shell negados em `edit` e `auto`, como prefixos. */
export const DENIED_COMMAND_PREFIXES: readonly string[] = [
  'git commit',
  'git push',
  'git reset',
  'git clean',
  'git checkout',
  'git rebase',
  'git merge',
  'git tag',
  'git remote',
  'rm -rf',
  'sudo',
  'shutdown',
  'reboot',
  'mkfs',
  'dd if=',
];

export interface InvocationRequest {
  readonly profile: ModelProfile;
  readonly mode: PermissionMode;
  readonly prompt: string;
  /** Prefixos de comando liberados em `edit` (gate, build, test, git de leitura). */
  readonly allowedCommands: readonly string[];
  /** Ambiente de origem explícito; credenciais de API são removidas dele. */
  readonly sourceEnv: Readonly<Record<string, string | undefined>>;
  /** Variáveis extras do loop (ex.: tag do step para auditoria de processo). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export class InvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvocationError';
  }
}

export function buildInvocation(request: InvocationRequest): AdapterInvocation {
  const env = stepEnvironment(request.sourceEnv, request.extraEnv ?? {});
  switch (request.profile.scaffold) {
    case 'claude_code':
      return { argv: claudeArgv(request), env, stdin: request.prompt };
    case 'codex_cli':
      return { argv: codexArgv(request), env, stdin: request.prompt };
    case 'opencode':
      return {
        argv: openCodeArgv(request),
        env: { ...env, ...openCodeModeEnv(request.mode, request.allowedCommands) },
      };
    case 'fake':
      throw new InvocationError('scaffold fake não tem invocação real; use o adapter de teste');
  }
}

function stepEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const blocked = new Set(API_CREDENTIAL_VARIABLES);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || blocked.has(name)) continue;
    env[name] = value;
  }
  return { ...env, CI: '1', ...extra };
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const CLAUDE_READ_TOOLS = ['Read', 'Glob', 'Grep'];
const CLAUDE_EDIT_TOOLS = ['Edit', 'Write'];
const CLAUDE_WEB_TOOLS = ['WebFetch', 'WebSearch'];

function claudeArgv(request: InvocationRequest): string[] {
  const { profile, mode } = request;
  const argv = [
    'claude',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    profile.model,
    ...(profile.effort === null ? [] : ['--effort', profile.effort]),
    // Settings pessoais (user/local) não governam o step; as do projeto alvo sim.
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    // Sem humano: o que pediria permissão é negado, e o step não trava.
    '--permission-prompts',
    'none',
  ];
  const denyBash = DENIED_COMMAND_PREFIXES.map((prefix) => `Bash(${prefix}:*)`);
  if (mode === 'plan') {
    return [...argv, '--permission-mode', 'plan', '--allowedTools', ...CLAUDE_READ_TOOLS];
  }
  if (mode === 'edit') {
    const allowedBash = request.allowedCommands.map((command) => `Bash(${command}:*)`);
    return [
      ...argv,
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      ...CLAUDE_READ_TOOLS,
      ...CLAUDE_EDIT_TOOLS,
      ...allowedBash,
      '--disallowedTools',
      ...denyBash,
      ...CLAUDE_WEB_TOOLS,
    ];
  }
  return [
    ...argv,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    ...CLAUDE_READ_TOOLS,
    ...CLAUDE_EDIT_TOOLS,
    ...CLAUDE_WEB_TOOLS,
    'Bash',
    '--disallowedTools',
    ...denyBash,
  ];
}

// ---------------------------------------------------------------------------
// Codex CLI
// ---------------------------------------------------------------------------

/**
 * O Codex não tem allowlist por comando: o limite é o sandbox. `edit` e `auto`
 * usam `workspace-write` (escrita só no workspace); `auto` libera rede dentro
 * dele. Divergência documentada da semântica Q1, não contornada.
 */
function codexArgv(request: InvocationRequest): string[] {
  const { profile, mode } = request;
  const sandbox = mode === 'plan' ? 'read-only' : 'workspace-write';
  return [
    'codex',
    'exec',
    '--json',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--sandbox',
    sandbox,
    '--model',
    profile.model,
    ...(profile.effort === null
      ? []
      : ['--config', `model_reasoning_effort="${profile.effort}"`]),
    ...(mode === 'auto' ? ['--config', 'sandbox_workspace_write.network_access=true'] : []),
    // Prompt pelo stdin: handoff com diff não cabe com folga num argumento.
    '-',
  ];
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

function openCodeArgv(request: InvocationRequest): string[] {
  const { profile } = request;
  return [
    'opencode',
    'run',
    '--format',
    'json',
    '--model',
    profile.model,
    ...(profile.effort === null ? [] : ['--variant', profile.effort]),
    request.prompt,
  ];
}

const OPENCODE_READ_TOOLS = ['read', 'glob', 'grep', 'list', 'lsp', 'todowrite'];
const OPENCODE_EDIT_TOOLS = ['edit', 'write', 'patch', 'apply_patch'];

/**
 * Objeto COMPLETO de permissão. A CLI resolve por `findLast` na ordem das
 * chaves (ver `opencode-scaffold.ts`): o catch-all `*` vem primeiro e é `deny`,
 * nunca `ask` — `ask` sem humano trava.
 */
export function openCodePermissionForMode(
  mode: PermissionMode,
  allowedCommands: readonly string[],
): OpenCodePermissionConfig {
  const config: Record<string, OpenCodePermissionAction | Record<string, OpenCodePermissionAction>> = {
    '*': 'deny',
  };
  for (const tool of OPENCODE_READ_TOOLS) config[tool] = 'allow';
  config['external_directory'] = 'deny';
  config['task'] = 'deny';
  if (mode === 'plan') {
    for (const tool of [...OPENCODE_EDIT_TOOLS, 'bash', 'webfetch', 'websearch']) config[tool] = 'deny';
    return config;
  }
  for (const tool of OPENCODE_EDIT_TOOLS) config[tool] = 'allow';
  const denied = DENIED_COMMAND_PREFIXES.map((prefix) => [`${prefix}*`, 'deny' as const]);
  if (mode === 'edit') {
    config['webfetch'] = 'deny';
    config['websearch'] = 'deny';
    config['bash'] = Object.fromEntries([
      ['*', 'deny' as const],
      ...allowedCommands.map((command) => [`${command}*`, 'allow' as const]),
      ...denied,
    ]) as Record<string, OpenCodePermissionAction>;
    return config;
  }
  config['webfetch'] = 'allow';
  config['websearch'] = 'allow';
  config['bash'] = Object.fromEntries([['*', 'allow' as const], ...denied]) as Record<
    string,
    OpenCodePermissionAction
  >;
  return config;
}

function openCodeModeEnv(
  mode: PermissionMode,
  allowedCommands: readonly string[],
): Record<string, string> {
  return {
    [OPENCODE_PERMISSION_VARIABLE]: JSON.stringify(openCodePermissionForMode(mode, allowedCommands)),
    // Config de projeto do repo alvo não governa a fronteira de permissão.
    [OPENCODE_DISABLE_PROJECT_CONFIG_VARIABLE]: '1',
  };
}
