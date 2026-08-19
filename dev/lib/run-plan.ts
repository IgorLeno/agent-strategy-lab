import { GitError, headSha } from './git.js';
import { initializeHarnessRuntime } from './init-runtime.js';
import { runOrchestrate } from './orchestrate.js';
import { exitCodeForOrchestrationStop } from './orchestration-termination.js';
import type { HarnessPaths } from './paths.js';
import { loadPlan, type LoadedPlan } from './plan.js';
import { loadProfile } from './profile.js';
import type { DevelopmentState } from './schemas.js';
import { selectNextTask } from './select.js';
import { buildInitialState, readState } from './state.js';

/**
 * Falha de setup do `dev-run-plan`: nada de provider, attempt ou state novo.
 * O CLI imprime a mensagem e sai 1.
 */
export class PlanSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanSetupError';
  }
}

export type RuntimeStateKind = 'NEW' | 'RESUMABLE' | 'ALL_DONE' | 'INCOMPATIBLE';

export interface PlanRunInput {
  readonly paths: HarnessPaths;
  readonly profileId: string;
  readonly dryRun: boolean;
  readonly maxIterations: number;
  readonly autonomy?: 'routine';
  readonly timeoutOverride?: string;
  readonly verbose?: boolean;
}

export interface PlanRunResult {
  readonly payload: Record<string, unknown>;
  readonly exitCode: number;
}

const MISMATCH_OPTIONS = [
  'usar outro --runtime-dir',
  'revisar o runtime existente',
  'realizar uma operação explícita de adoção/reset fora deste comando',
] as const;

async function readExistingState(paths: HarnessPaths): Promise<DevelopmentState | 'missing'> {
  try {
    return await readState(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new PlanSetupError(
      `state do runtime ilegível em ${paths.stateFile}: ${detail}\n` +
        'State, history e evidência NÃO foram alterados.\n' +
        'Ação segura: inspecionar o runtime ou escolher outro --runtime-dir.',
    );
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function loadRequestedPlan(paths: HarnessPaths, runtimeExists: boolean): Promise<LoadedPlan> {
  try {
    return await loadPlan(paths.planFile);
  } catch (error) {
    const preserved = runtimeExists
      ? 'State, history e evidência do runtime existente foram preservados.'
      : 'Nenhum state autoritativo foi criado. Nenhum attempt foi consumido. Nenhum provider foi chamado.';
    throw new PlanSetupError(
      `PlanFile inválido em ${paths.planFile}: ${describeError(error)}\n` +
        `${preserved}\n` +
        'Ação segura: corrigir o YAML com o parser canônico e rerodar. Este comando não tem --force.',
    );
  }
}

async function requireGitRepo(repoRoot: string): Promise<string> {
  try {
    return await headSha(repoRoot);
  } catch (error) {
    const detail = error instanceof GitError ? error.message : describeError(error);
    throw new PlanSetupError(
      `repositório inválido em ${repoRoot}: ${detail}\n` +
        'Nenhum runtime foi criado e nenhum provider foi chamado.\n' +
        'Ação segura: apontar --repo para um git com HEAD.',
    );
  }
}

async function requireProfile(repoRoot: string, profileId: string): Promise<void> {
  try {
    await loadProfile(repoRoot, profileId);
  } catch (error) {
    throw new PlanSetupError(
      `perfil ${profileId} recusado antes de qualquer provider spawn: ${describeError(error)}\n` +
        'Nenhum attempt foi consumido. Nenhum state autoritativo foi alterado.\n' +
        'Ação segura: informar um --profile existente e autorizado neste repositório.',
    );
  }
}

function mismatchPayload(
  input: PlanRunInput,
  loaded: LoadedPlan,
  registeredPlanSha256: string,
  head: string,
): Record<string, unknown> {
  return {
    status: input.dryRun ? 'BLOCKED' : 'RUNTIME_PLAN_MISMATCH',
    reason: 'RUNTIME_PLAN_MISMATCH',
    dry_run: input.dryRun,
    provider_called: false,
    repo: input.paths.repoRoot,
    plan_file: input.paths.planFile,
    plan_sha256: loaded.planSha256,
    runtime_dir: input.paths.devDir,
    profile_id: input.profileId,
    base_sha: head,
    runtime_state: 'INCOMPATIBLE',
    next_task: null,
    registered_plan_sha256: registeredPlanSha256,
    requested_plan_sha256: loaded.planSha256,
    requested_plan_file: input.paths.planFile,
    preserved: ['runtime', 'state', 'history', 'evidence'],
    options: [...MISMATCH_OPTIONS],
  };
}

function inspectCompatibleRuntime(
  loaded: LoadedPlan,
  state: DevelopmentState,
): { readonly runtimeState: 'RESUMABLE' | 'ALL_DONE'; readonly nextTask: string | null } {
  const selection = selectNextTask(loaded, state);
  if (selection.status === 'ALL_DONE') {
    return { runtimeState: 'ALL_DONE', nextTask: null };
  }
  return {
    runtimeState: 'RESUMABLE',
    nextTask: selection.task?.id ?? null,
  };
}

/**
 * Coordinator ergonômico sobre init + orchestrate. Não possui loop próprio de
 * seleção, repair, recovery, launch, close, evidence ou billing.
 */
export async function runPlan(input: PlanRunInput): Promise<PlanRunResult> {
  const { paths, profileId, dryRun } = input;
  const head = await requireGitRepo(paths.repoRoot);
  const existing = await readExistingState(paths);
  const runtimeExists = existing !== 'missing';
  const loaded = await loadRequestedPlan(paths, runtimeExists);
  await requireProfile(paths.repoRoot, profileId);

  if (existing !== 'missing' && existing.plan_sha256 !== loaded.planSha256) {
    return {
      payload: mismatchPayload(input, loaded, existing.plan_sha256, existing.authorized_head_sha ?? head),
      exitCode: 9,
    };
  }

  let runtimeState: RuntimeStateKind;
  let nextTask: string | null;
  if (!runtimeExists) {
    const virtual = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: head });
    const selection = selectNextTask(loaded, virtual);
    runtimeState = 'NEW';
    nextTask = selection.task?.id ?? null;
  } else {
    const inspected = inspectCompatibleRuntime(loaded, existing);
    runtimeState = inspected.runtimeState;
    nextTask = inspected.nextTask;
  }

  const context = {
    repo: paths.repoRoot,
    plan_file: paths.planFile,
    plan_sha256: loaded.planSha256,
    runtime_dir: paths.devDir,
    profile_id: profileId,
    base_sha: existing === 'missing' ? head : (existing.authorized_head_sha ?? head),
    runtime_state: runtimeState,
    next_task: nextTask,
  };

  if (dryRun) {
    const status = runtimeState === 'ALL_DONE' ? 'ALL_DONE' : runtimeState === 'NEW' || runtimeState === 'RESUMABLE' ? 'READY' : 'BLOCKED';
    return {
      payload: {
        status,
        dry_run: true,
        provider_called: false,
        authoritative_mutation: false,
        ...context,
      },
      exitCode: status === 'BLOCKED' ? 9 : 0,
    };
  }

  let initialized = false;
  if (runtimeState === 'NEW') {
    const init = await initializeHarnessRuntime(paths);
    initialized = true;
    context.base_sha = init.baseline_sha;
  }

  const orchestrated = await runOrchestrate({
    paths,
    loaded,
    profileId,
    maxIterations: input.maxIterations,
    ...(input.timeoutOverride === undefined ? {} : { timeoutOverride: input.timeoutOverride }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
  });

  return {
    payload: {
      ...context,
      dry_run: false,
      provider_called: orchestrated.iterationCount > 0,
      initialized,
      run_kind: runtimeState === 'NEW' ? 'NEW' : 'RESUMED',
      ...orchestrated.payload,
    },
    exitCode: exitCodeForOrchestrationStop(orchestrated.stop),
  };
}
