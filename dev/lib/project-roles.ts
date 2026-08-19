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
 * provider e não decide policy de review. Ele responde três perguntas
 * separadas — qual argv o role recebe, se o worker runtime budget cabe no
 * bound de runtime, e se o timeout de um ValidationCommand cabe no contrato de
 * ValidationCommand. As duas últimas nunca se cruzam.
 */

import path from 'node:path';

import { PLAN_FILE_VALIDATION_TIMEOUT_CEILING_SECONDS } from '../../src/planner/generate.js';
import { assertNoForbiddenFlags, type LauncherProfile } from './profile.js';

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

export const CLAUDE_READ_ONLY_MECHANISM =
  `argv Claude: --settings passa a apontar para ${CLAUDE_READ_ONLY_SETTINGS_FILE} (deny de Edit/Write/NotebookEdit e de todo comando de mutação) e --permission-mode passa a ${CLAUDE_READ_ONLY_PERMISSION_MODE}, com --setting-sources project excluindo settings pessoais`;

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
      workspace_access: 'MUTATION_IN_AUTHORIZED_WORKSPACE',
      mechanism: IMPLEMENTER_MUTATION_MECHANISM,
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
    workspace_access: 'READ_ONLY',
    mechanism,
  };
}

/**
 * Prova DEPOIS DO FATO que o argv efetivamente lançado carrega o overlay —
 * consumida pelo reviewer, cuja decisão só vale se o contexto foi read-only.
 */
export function assertReadOnlyArgv(
  role: ProjectWorkerRole,
  agent: LauncherProfile['agent'],
  argv: readonly string[],
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
    const permissionIndex = singleFlagIndex(argv, '--permission-mode');
    if (
      settingsIndex < 0 ||
      argv[settingsIndex + 1] !== CLAUDE_READ_ONLY_SETTINGS_FILE ||
      permissionIndex < 0 ||
      argv[permissionIndex + 1] !== CLAUDE_READ_ONLY_PERMISSION_MODE
    ) {
      throw new RoleOverlayError(role, 'argv lançado não prova overlay read-only Claude');
    }
    return;
  }
  throw new RoleOverlayError(role, `agente ${agent} não possui mecanismo estrutural de read-only`);
}

// ---------------------------------------------------------------------------
// Worker runtime budget — bound do launcher/profile, e NADA MAIS.
// ---------------------------------------------------------------------------

/** Teto do próprio `LauncherProfile.timeout_seconds`: o launcher não representa mais que isso. */
export const LAUNCHER_RUNTIME_BOUND_SECONDS = 7_200;

export type WorkerRuntimeBoundSource = 'launcher' | 'profile_runtime';

export interface WorkerRuntimeBound {
  readonly kind: 'WORKER_RUNTIME_BOUND';
  readonly source: WorkerRuntimeBoundSource;
  readonly maximum_ms: number;
  readonly provenance: string;
}

/**
 * Os DOIS bounds da mesma grandeza (runtime do worker). Nenhum timeout de
 * validação entra aqui — misturar as grandezas é exatamente o erro que o
 * contrato de M78 proíbe.
 */
export function workerRuntimeBoundsOf(profile: LauncherProfile): readonly WorkerRuntimeBound[] {
  return [
    {
      kind: 'WORKER_RUNTIME_BOUND',
      source: 'launcher',
      maximum_ms: LAUNCHER_RUNTIME_BOUND_SECONDS * 1_000,
      provenance: 'LauncherProfile.timeout_seconds.max (dev/lib/profile.ts)',
    },
    {
      kind: 'WORKER_RUNTIME_BOUND',
      source: 'profile_runtime',
      maximum_ms: profile.timeout_seconds * 1_000,
      provenance: `${profile.id}.timeout_seconds`,
    },
  ];
}

export const BUDGET_UNSUPPORTED_NEXT_STEPS = [
  'TRY_ANOTHER_PROFILE',
  'RECONFIGURE_RUNTIME',
  'REPLAN',
  'HUMAN_REQUIRED',
] as const;

export type WorkerRuntimeBudgetResolution =
  | {
      readonly outcome: 'RESOLVED';
      /** Valor a passar como `timeoutSecondsOverride` do launcher — derivado por policy, não fixo. */
      readonly timeout_seconds_override: number;
      readonly requested_budget_ms: number;
      readonly checked_bounds: readonly WorkerRuntimeBound[];
      readonly provenance: readonly string[];
    }
  | {
      readonly outcome: 'BUDGET_UNSUPPORTED';
      readonly requested_budget_ms: number;
      readonly violated_bound: WorkerRuntimeBound;
      readonly checked_bounds: readonly WorkerRuntimeBound[];
      readonly allowed_next_steps: typeof BUDGET_UNSUPPORTED_NEXT_STEPS;
      readonly reason: string;
    };

/**
 * Promove o `timeoutSecondsOverride` que existia só para testes a valor
 * derivado por policy. O budget é validado SOMENTE contra os bounds de runtime
 * do launcher/profile: budget acima do bound não é reduzido em silêncio ao
 * bound (isso seria degradação disfarçada), vira `BUDGET_UNSUPPORTED` nomeando
 * o bound violado.
 */
export function resolveWorkerRuntimeBudget(input: {
  readonly profile: LauncherProfile;
  readonly budgetMs: number;
}): WorkerRuntimeBudgetResolution {
  const { budgetMs } = input;
  const bounds = workerRuntimeBoundsOf(input.profile);

  if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) {
    const violated = bounds[1] as WorkerRuntimeBound;
    return {
      outcome: 'BUDGET_UNSUPPORTED',
      requested_budget_ms: Number.isSafeInteger(budgetMs) ? budgetMs : 0,
      violated_bound: violated,
      checked_bounds: bounds,
      allowed_next_steps: BUDGET_UNSUPPORTED_NEXT_STEPS,
      reason: 'worker runtime budget não é um inteiro positivo representável; requer replan',
    };
  }

  const violated = bounds.find((bound) => budgetMs > bound.maximum_ms);
  if (violated) {
    return {
      outcome: 'BUDGET_UNSUPPORTED',
      requested_budget_ms: budgetMs,
      violated_bound: violated,
      checked_bounds: bounds,
      allowed_next_steps: BUDGET_UNSUPPORTED_NEXT_STEPS,
      reason: `worker runtime budget de ${budgetMs}ms excede o bound ${violated.source} (${violated.maximum_ms}ms, ${violated.provenance})`,
    };
  }

  return {
    outcome: 'RESOLVED',
    timeout_seconds_override: Math.max(1, Math.ceil(budgetMs / 1_000)),
    requested_budget_ms: budgetMs,
    checked_bounds: bounds,
    provenance: ['worker_runtime_budget', ...bounds.map((bound) => bound.provenance)],
  };
}

// ---------------------------------------------------------------------------
// Timeout de ValidationCommand — grandeza SEPARADA, bound próprio.
// ---------------------------------------------------------------------------

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
 * `ValidationCommand`. Não recebe profile, não conhece o worker runtime budget
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
