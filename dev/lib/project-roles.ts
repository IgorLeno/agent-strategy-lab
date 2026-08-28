/**
 * Roles ESTRUTURAIS do lifecycle universal (M84).
 *
 * "Estrutural" quer dizer: a fronteira do role vive no argv e nas settings
 * versionadas que o launcher usa, nunca numa frase do prompt. Um planner ou
 * reviewer que decida ignorar o texto continua sem conseguir escrever, porque
 * o mecanismo é o mesmo que já existia para Codex (`--sandbox read-only`),
 * agora generalizado para Claude por um arquivo de settings versionado.
 *
 * Este módulo é PURO sobre profiles e argv: não lança processo, não fala com
 * provider e não decide policy de review. Ele responde duas perguntas
 * separadas — qual argv o role recebe e se o timeout de um ValidationCommand
 * cabe no contrato de ValidationCommand. Nenhuma delas conhece previsão de
 * duração de task: ela deixou de ter autoridade operacional.
 */

import path from 'node:path';

import { PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS } from '../../src/planner/generate.js';
import {
  mutationStructurallyDenied,
  openCodePermissionEnv,
  openCodePermissionFor,
  OPENCODE_PERMISSION_VARIABLE,
  type OpenCodePermissionConfig,
} from './opencode-scaffold.js';
import {
  assertNoForbiddenFlags,
  resolveProfileArgv,
  type LauncherProfile,
} from './profile.js';

export const PROJECT_WORKER_ROLES = ['planner', 'implementer', 'reviewer'] as const;
export type ProjectWorkerRole = (typeof PROJECT_WORKER_ROLES)[number];

/** Planner e reviewer NUNCA mutam o repositório alvo; implementer muta só o workspace autorizado. */
export const READ_ONLY_PROJECT_ROLES: readonly ProjectWorkerRole[] = ['planner', 'reviewer'];

export function roleRequiresReadOnly(role: ProjectWorkerRole): boolean {
  return READ_ONLY_PROJECT_ROLES.includes(role);
}

/** Settings versionadas: é ELAS que negam mutação, não o prompt. */
export const CLAUDE_READ_ONLY_SETTINGS_FILE = path.join(
  'dev',
  'profiles',
  'claude-reviewer-readonly.settings.json',
);

export const CLAUDE_READ_ONLY_PERMISSION_MODE = 'plan';

export const CODEX_READ_ONLY_MECHANISM =
  'argv Codex: o único --sandbox workspace-write é convertido para read-only antes do spawn';

/**
 * Mecanismo estrutural do worker FALSO. É argv, não prompt: o fixture recusa
 * qualquer mutação quando recebe esta flag e devolve apenas o veredito. Existe
 * porque o role de reviewer precisa ser exercitável de ponta a ponta sem
 * chamar provider real — sem ele, nenhum teste consegue provar que a review
 * aconteceu em contexto fresco e somente-leitura.
 */
export const FAKE_READ_ONLY_FLAG = '--agentlab-read-only';

export const FAKE_READ_ONLY_MECHANISM =
  `argv do worker falso: ${FAKE_READ_ONLY_FLAG} faz o fixture recusar escrita, commit e validação oficial antes de qualquer efeito`;

export const CLAUDE_READ_ONLY_MECHANISM =
  `argv Claude: --settings passa a apontar para ${CLAUDE_READ_ONLY_SETTINGS_FILE} (deny de Edit/Write/NotebookEdit e de todo comando de mutação) e --permission-mode passa a ${CLAUDE_READ_ONLY_PERMISSION_MODE}, com --setting-sources project excluindo settings pessoais`;

/**
 * O mecanismo do OpenCode NÃO está no argv: está em `OPENCODE_PERMISSION`, que
 * a CLI mescla por último sobre a configuração global e a de projeto. A CLI
 * levanta `DeniedError` antes de publicar o pedido de permissão, então `--auto`
 * — que só responde pedidos publicados — não tem o que responder, e a
 * ferramenta negada sequer aparece no toolset do modelo.
 */
export const OPENCODE_READ_ONLY_MECHANISM =
  `env ${OPENCODE_PERMISSION_VARIABLE}: objeto de permissão COMPLETO do Lab nega edit/write/patch/apply_patch/bash e external_directory; a CLI recusa antes de perguntar, e o toolset visível perde as ferramentas negadas`;

export const OPENCODE_IMPLEMENTER_MECHANISM =
  `env ${OPENCODE_PERMISSION_VARIABLE}: mutação concedida e LIMITADA ao worktree por external_directory=deny; git commit/push negados porque o commit pertence ao orquestrador`;

export const IMPLEMENTER_MUTATION_MECHANISM =
  'argv do profile inalterado; a mutação fica contida no workspace autorizado passado como cwd do launcher';

export class RoleOverlayError extends Error {
  constructor(
    readonly role: ProjectWorkerRole,
    message: string,
  ) {
    super(`role ${role}: ${message}`);
    this.name = 'RoleOverlayError';
  }
}

export type RoleWorkspaceAccess = 'READ_ONLY' | 'MUTATION_IN_AUTHORIZED_WORKSPACE';

export interface RoleArgvOverlay {
  readonly role: ProjectWorkerRole;
  readonly profile_id: string;
  readonly argv: readonly string[];
  /**
   * Variáveis que o LANÇAMENTO precisa somar ao ambiente para que a fronteira
   * exista. Vazio nos scaffolds cuja fronteira é argv; para OpenCode é AQUI que
   * a fronteira mora, e ignorar este campo lançaria um role sem restrição.
   */
  readonly env: Readonly<Record<string, string>>;
  readonly workspace_access: RoleWorkspaceAccess;
  /** Mecanismo estrutural que sustenta `workspace_access`; nunca "o prompt pede". */
  readonly mechanism: string;
}

function singleFlagIndex(argv: readonly string[], flag: string): number {
  const indexes = argv.flatMap((token, index) => (token === flag ? [index] : []));
  return indexes.length === 1 ? (indexes[0] as number) : -1;
}

function applyCodexReadOnly(role: ProjectWorkerRole, argv: string[]): void {
  const sandboxIndex = singleFlagIndex(argv, '--sandbox');
  if (sandboxIndex < 0 || argv[sandboxIndex + 1] !== 'workspace-write') {
    throw new RoleOverlayError(
      role,
      'profile Codex precisa declarar exatamente um --sandbox workspace-write para ser convertido em read-only',
    );
  }
  argv[sandboxIndex + 1] = 'read-only';
}

function applyFakeReadOnly(role: ProjectWorkerRole, argv: string[]): void {
  if (argv.includes(FAKE_READ_ONLY_FLAG)) {
    throw new RoleOverlayError(
      role,
      `argv do worker falso já declara ${FAKE_READ_ONLY_FLAG}; o overlay não duplica a fronteira`,
    );
  }
  argv.push(FAKE_READ_ONLY_FLAG);
}

function applyClaudeReadOnly(role: ProjectWorkerRole, argv: string[]): void {
  const settingsIndex = singleFlagIndex(argv, '--settings');
  if (settingsIndex < 0 || argv[settingsIndex + 1] === undefined) {
    throw new RoleOverlayError(
      role,
      'profile Claude precisa declarar exatamente um --settings para receber o overlay read-only versionado',
    );
  }
  const sourcesIndex = singleFlagIndex(argv, '--setting-sources');
  if (sourcesIndex < 0 || argv[sourcesIndex + 1] !== 'project') {
    throw new RoleOverlayError(
      role,
      'overlay read-only exige --setting-sources project: settings pessoais anulariam a restrição',
    );
  }
  const permissionIndex = singleFlagIndex(argv, '--permission-mode');
  if (permissionIndex < 0 || argv[permissionIndex + 1] === undefined) {
    throw new RoleOverlayError(
      role,
      'profile Claude precisa declarar exatamente um --permission-mode para receber o overlay read-only',
    );
  }
  argv[settingsIndex + 1] = CLAUDE_READ_ONLY_SETTINGS_FILE;
  argv[permissionIndex + 1] = CLAUDE_READ_ONLY_PERMISSION_MODE;
}

/**
 * Planner e reviewer não podem possuir commit nem validação oficial: um role
 * que pudesse commitar não seria read-only por mais que o sandbox negasse
 * edição de arquivo.
 */
function assertReadOnlyOwnership(role: ProjectWorkerRole, profile: LauncherProfile): void {
  if (profile.commit_owner !== 'orchestrator' || profile.official_validation_owner !== 'orchestrator') {
    throw new RoleOverlayError(
      role,
      `profile ${profile.id} possui ownership de commit ou de validação oficial; role read-only exige ambos no orquestrador`,
    );
  }
}

/**
 * Deriva o argv final do role. `prompt` entra conforme `prompt_delivery`, como
 * no launcher — o overlay não muda a forma de entrega, só a fronteira.
 */
export function buildRoleArgv(
  profile: LauncherProfile,
  input: { readonly role: ProjectWorkerRole; readonly prompt: string },
): RoleArgvOverlay {
  const argv = profile.prompt_delivery === 'argv' ? [...profile.argv, input.prompt] : [...profile.argv];

  if (!roleRequiresReadOnly(input.role)) {
    assertNoForbiddenFlags(profile, argv);
    return {
      role: input.role,
      profile_id: profile.id,
      argv,
      env: profile.agent === 'opencode' ? openCodePermissionEnv('implementer') : {},
      workspace_access: 'MUTATION_IN_AUTHORIZED_WORKSPACE',
      mechanism:
        profile.agent === 'opencode' ? OPENCODE_IMPLEMENTER_MECHANISM : IMPLEMENTER_MUTATION_MECHANISM,
    };
  }

  assertReadOnlyOwnership(input.role, profile);
  let mechanism: string;
  switch (profile.agent) {
    case 'codex':
      applyCodexReadOnly(input.role, argv);
      mechanism = CODEX_READ_ONLY_MECHANISM;
      break;
    case 'claude':
      applyClaudeReadOnly(input.role, argv);
      mechanism = CLAUDE_READ_ONLY_MECHANISM;
      break;
    case 'opencode':
      // Nada a alterar no argv: a fronteira do OpenCode é a permissão, e ela
      // entra pelo ambiente. Provar aqui que o objeto realmente nega mutação
      // impede que uma futura mudança na tabela de permissão passe silenciosa.
      assertOpenCodeReadOnlyPermission(input.role);
      mechanism = OPENCODE_READ_ONLY_MECHANISM;
      break;
    case 'fake':
      applyFakeReadOnly(input.role, argv);
      mechanism = FAKE_READ_ONLY_MECHANISM;
      break;
    default:
      throw new RoleOverlayError(
        input.role,
        `agente ${profile.agent} não possui mecanismo estrutural de read-only`,
      );
  }

  assertNoForbiddenFlags(profile, argv);
  return {
    role: input.role,
    profile_id: profile.id,
    argv,
    env: profile.agent === 'opencode' ? openCodePermissionEnv(input.role) : {},
    workspace_access: 'READ_ONLY',
    mechanism,
  };
}

/**
 * A permissão que o Lab vai escrever nega mutação DE FATO?
 *
 * A checagem resolve cada ferramenta pela mesma regra da CLI (`findLast` sobre
 * as chaves) em vez de conferir presença de chave: uma tabela onde um curinga
 * posterior reabrisse `edit` passaria numa checagem ingênua e falha aqui.
 */
function assertOpenCodeReadOnlyPermission(role: ProjectWorkerRole): void {
  const permission = openCodePermissionFor(role as 'planner' | 'reviewer');
  if (!mutationStructurallyDenied(permission)) {
    throw new RoleOverlayError(
      role,
      'a permissão OpenCode do Lab não nega toda ferramenta de mutação: o role não seria read-only',
    );
  }
}

/**
 * Prova DEPOIS DO FATO que o argv efetivamente lançado carrega o overlay —
 * consumida pelo reviewer, cuja decisão só vale se o contexto foi read-only.
 */
export function assertReadOnlyArgv(
  role: ProjectWorkerRole,
  agent: LauncherProfile['agent'],
  argv: readonly string[],
  /**
   * Ambiente EFETIVO do lançamento. Obrigatório para OpenCode, cuja fronteira
   * não está no argv: provar read-only ali sem olhar o ambiente aprovaria um
   * lançamento sem restrição nenhuma.
   */
  env: Readonly<Record<string, string | undefined>> = {},
  /**
   * Quando o argv já passou pela resolução de recursos do profile, a prova
   * deriva o settings esperado pela MESMA resolução canônica.
   */
  profileResolution?: { readonly catalogRoot: string; readonly workerCwd: string },
): void {
  if (agent === 'codex') {
    const index = singleFlagIndex(argv, '--sandbox');
    if (index < 0 || argv[index + 1] !== 'read-only') {
      throw new RoleOverlayError(role, 'argv lançado não prova sandbox Codex read-only');
    }
    return;
  }
  if (agent === 'claude') {
    const settingsIndex = singleFlagIndex(argv, '--settings');
    const sourcesIndex = singleFlagIndex(argv, '--setting-sources');
    const permissionIndex = singleFlagIndex(argv, '--permission-mode');
    const expectedSettings = profileResolution
      ? resolveProfileArgv([CLAUDE_READ_ONLY_SETTINGS_FILE], profileResolution)[0]
      : CLAUDE_READ_ONLY_SETTINGS_FILE;
    if (
      settingsIndex < 0 ||
      argv[settingsIndex + 1] !== expectedSettings ||
      sourcesIndex < 0 ||
      argv[sourcesIndex + 1] !== 'project' ||
      permissionIndex < 0 ||
      argv[permissionIndex + 1] !== CLAUDE_READ_ONLY_PERMISSION_MODE
    ) {
      throw new RoleOverlayError(role, 'argv lançado não prova overlay read-only Claude');
    }
    return;
  }
  if (agent === 'opencode') {
    const raw = env[OPENCODE_PERMISSION_VARIABLE];
    if (raw === undefined) {
      throw new RoleOverlayError(
        role,
        `ambiente lançado não define ${OPENCODE_PERMISSION_VARIABLE}: sem ele a CLI cai no default e o role não é read-only`,
      );
    }
    let permission: OpenCodePermissionConfig;
    try {
      permission = JSON.parse(raw) as OpenCodePermissionConfig;
    } catch {
      throw new RoleOverlayError(role, `${OPENCODE_PERMISSION_VARIABLE} não é JSON: a CLI o descartaria com um aviso`);
    }
    if (!mutationStructurallyDenied(permission)) {
      throw new RoleOverlayError(
        role,
        `${OPENCODE_PERMISSION_VARIABLE} lançado não nega toda ferramenta de mutação`,
      );
    }
    if (argv.some((token) => token === '--auto' || token.startsWith('--auto='))) {
      throw new RoleOverlayError(role, 'argv lançado carrega --auto: autorização do Lab não é delegada à CLI');
    }
    return;
  }
  if (agent === 'fake') {
    if (argv.filter((token) => token === FAKE_READ_ONLY_FLAG).length !== 1) {
      throw new RoleOverlayError(role, 'argv lançado não prova overlay read-only do worker falso');
    }
    return;
  }
  throw new RoleOverlayError(role, `agente ${agent} não possui mecanismo estrutural de read-only`);
}

// ---------------------------------------------------------------------------
// Runtime do worker — SEM deadline derivado da task.
// ---------------------------------------------------------------------------

/**
 * O que existia aqui era `resolveWorkerRuntimeBudget`: uma previsão de duração
 * comparada com `LauncherProfile.timeout_seconds`, capaz de recusar o profile
 * (`BUDGET_UNSUPPORTED`) e, quando aceita, virar o wall-clock deadline do
 * worker. As duas coisas foram removidas: a previsão não é autorização, e a
 * duração de uma task não é limite operacional.
 *
 * O que ficou é de outra grandeza — o teto de segurança de MÁQUINA. Ele não
 * conhece profile, planner, envelope nem dificuldade; não entra em routing;
 * não recusa nada; e só existe para que nenhum processo do harness seja
 * imortal. `machineSafetyCeiling()` é sua única fonte.
 */

// ---------------------------------------------------------------------------
// Timeout de ValidationCommand — grandeza SEPARADA, bound próprio.
// ---------------------------------------------------------------------------

/** Saídas oferecidas quando um timeout de validação não cabe no seu contrato. */
export const BUDGET_UNSUPPORTED_NEXT_STEPS = [
  'TRY_ANOTHER_PROFILE',
  'RECONFIGURE_RUNTIME',
  'REPLAN',
  'HUMAN_REQUIRED',
] as const;

export interface ValidationCommandTimeoutBound {
  readonly kind: 'VALIDATION_COMMAND_TIMEOUT_BOUND';
  readonly maximum_seconds: number;
  readonly provenance: string;
}

export const VALIDATION_COMMAND_TIMEOUT_BOUND: ValidationCommandTimeoutBound = {
  kind: 'VALIDATION_COMMAND_TIMEOUT_BOUND',
  maximum_seconds: PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS,
  provenance: 'ValidationCommand.timeout_seconds (src/planner/task.ts) + teto de projeção do PlanFile',
};

export type ValidationCommandTimeoutCheck =
  | { readonly outcome: 'ACCEPTED'; readonly timeout_seconds: number; readonly bound: ValidationCommandTimeoutBound }
  | {
      readonly outcome: 'BUDGET_UNSUPPORTED';
      readonly timeout_seconds: number;
      readonly violated_bound: ValidationCommandTimeoutBound;
      readonly allowed_next_steps: typeof BUDGET_UNSUPPORTED_NEXT_STEPS;
      readonly reason: string;
    };

/**
 * Checa o timeout de UM comando de validação contra o contrato de
 * `ValidationCommand`. Não recebe profile, não conhece previsão de runtime
 * e nunca tira `min` entre as duas grandezas: um comando de validação longo
 * não encolhe o runtime do worker, e um runtime curto não invalida o comando.
 */
export function checkValidationCommandTimeout(timeoutSeconds: number): ValidationCommandTimeoutCheck {
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    timeoutSeconds > VALIDATION_COMMAND_TIMEOUT_BOUND.maximum_seconds
  ) {
    return {
      outcome: 'BUDGET_UNSUPPORTED',
      timeout_seconds: Number.isSafeInteger(timeoutSeconds) ? timeoutSeconds : 0,
      violated_bound: VALIDATION_COMMAND_TIMEOUT_BOUND,
      allowed_next_steps: BUDGET_UNSUPPORTED_NEXT_STEPS,
      reason: `timeout de ValidationCommand (${timeoutSeconds}s) fora do bound ${VALIDATION_COMMAND_TIMEOUT_BOUND.kind} (${VALIDATION_COMMAND_TIMEOUT_BOUND.maximum_seconds}s, ${VALIDATION_COMMAND_TIMEOUT_BOUND.provenance})`,
    };
  }
  return {
    outcome: 'ACCEPTED',
    timeout_seconds: timeoutSeconds,
    bound: VALIDATION_COMMAND_TIMEOUT_BOUND,
  };
}
