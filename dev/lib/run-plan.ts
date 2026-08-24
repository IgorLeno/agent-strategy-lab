import { GitError, headSha } from './git.js';
import { initializeHarnessRuntime } from './init-runtime.js';
import { runOrchestrate } from './orchestrate.js';
import {
  loadProjectRunAuthorization,
  ProjectAuthorizationError,
  type LoadedProjectRunAuthorization,
} from './project-authorization.js';
import { createProjectControlPlane, type ProjectControlPlane } from './project-run.js';
import { exitCodeForOrchestrationStop } from './orchestration-termination.js';
import type { HarnessPaths } from './paths.js';
import type { LabProgressListener } from './lab-progress.js';
import { loadPlan, type LoadedPlan } from './plan.js';
import { loadProfileFromCatalog, profileProvenance, type ProfileProvenance } from './profile.js';
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
  /**
   * Profile da invocação. Continua obrigatório sem `--authorization`; com uma
   * profile policy autorizada ele é opcional, porque a escolha passa a ser do
   * control plane dentro da policy.
   */
  readonly profileId?: string;
  /** Caminho do `agentlab-run.yaml`; presente, liga o lifecycle universal. */
  readonly authorizationFile?: string;
  readonly dryRun: boolean;
  readonly maxIterations: number;
  readonly autonomy?: 'routine';
  readonly machineSafetyCeilingOverride?: string;
  readonly verbose?: boolean;
  readonly onProgress?: LabProgressListener;
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

async function requireProfile(catalogRoot: string, profileId: string): Promise<ProfileProvenance> {
  const provenance = profileProvenance(catalogRoot, profileId);
  try {
    await loadProfileFromCatalog(catalogRoot, profileId);
  } catch (error) {
    throw new PlanSetupError(
      `perfil ${profileId} recusado antes de qualquer provider spawn: ${describeError(error)}\n` +
        `Catálogo consultado: ${provenance.catalog_root} (arquivo ${provenance.source_file})\n` +
        'Nenhum attempt foi consumido. Nenhum state autoritativo foi alterado.\n' +
        'Ação segura: informar um --profile existente no catálogo do Agent Strategy Lab (ou --profile-root).',
    );
  }
  return provenance;
}

function mismatchPayload(
  input: PlanRunInput,
  profileId: string,
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
    profile_id: profileId,
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

function assertGeneratedPlanBase(
  loaded: LoadedPlan,
  existing: DevelopmentState | 'missing',
  head: string,
): void {
  const source = loaded.plan.generated_from;
  if (source === undefined) return;
  const actualBase = existing === 'missing' ? head : existing.baseline_sha;
  const actualLabel = existing === 'missing' ? 'HEAD' : 'runtime baseline_sha';
  if (source.base_revision_sha !== actualBase) {
    throw new PlanSetupError(
      'generated_from.base_revision_sha ' +
        source.base_revision_sha +
        ' diverge do ' +
        actualLabel +
        ' ' +
        actualBase +
        '.\nO plano gerado não foi regenerado nem o runtime alterado. Nenhum provider foi chamado.',
    );
  }
}

/**
 * Coordinator ergonômico sobre init + orchestrate. Não possui loop próprio de
 * seleção, repair, recovery, launch, close, evidence ou billing.
 */
export async function runPlan(input: PlanRunInput): Promise<PlanRunResult> {
  const { paths, dryRun } = input;
  const head = await requireGitRepo(paths.repoRoot);
  const existing = await readExistingState(paths);
  const runtimeExists = existing !== 'missing';
  const loaded = await loadRequestedPlan(paths, runtimeExists);
  assertGeneratedPlanBase(loaded, existing, head);

  let authorization: LoadedProjectRunAuthorization | null = null;
  if (input.authorizationFile !== undefined) {
    try {
      authorization = await loadProjectRunAuthorization(input.authorizationFile);
    } catch (error) {
      throw error instanceof ProjectAuthorizationError
        ? new PlanSetupError(error.message)
        : error;
    }
  }

  const profileId = resolveInvocationProfileId(input, authorization);
  const profile = await requireProfile(paths.profileCatalogRoot, profileId);

  if (existing !== 'missing' && existing.plan_sha256 !== loaded.planSha256) {
    return {
      payload: {
        ...mismatchPayload(input, profileId, loaded, existing.plan_sha256, existing.authorized_head_sha ?? head),
        profile,
      },
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

  const context: Record<string, unknown> = {
    repo: paths.repoRoot,
    plan_file: paths.planFile,
    plan_sha256: loaded.planSha256,
    runtime_dir: paths.devDir,
    profile_id: profileId,
    profile,
    base_sha: existing === 'missing' ? head : (existing.authorized_head_sha ?? head),
    runtime_state: runtimeState,
    next_task: nextTask,
  };

  async function buildControlPlane(): Promise<ProjectControlPlane | null> {
    if (authorization === null) return null;
    try {
      return await createProjectControlPlane({
        paths,
        loaded,
        authorization: authorization.file,
        authorizationFile: authorization.source_file,
      });
    } catch (error) {
      throw error instanceof ProjectAuthorizationError
        ? new PlanSetupError(error.message)
        : error;
    }
  }

  if (dryRun) {
    const runtimeStatus =
      runtimeState === 'ALL_DONE'
        ? 'ALL_DONE'
        : runtimeState === 'NEW' || runtimeState === 'RESUMABLE'
          ? 'READY'
          : 'BLOCKED';

    // Sem `--authorization` o dry-run continua sendo exatamente o que sempre
    // foi: inspeção de runtime e seleção da próxima task, nada mais.
    if (authorization === null) {
      return {
        payload: {
          status: runtimeStatus,
          dry_run: true,
          provider_called: false,
          authoritative_mutation: false,
          ...context,
        },
        exitCode: runtimeStatus === 'BLOCKED' ? 9 : 0,
      };
    }

    // Com autorização, o dry-run PRÉ-VISUALIZA o control plane universal pela
    // mesma avaliação que o runtime real consome. O control plane é
    // construído aqui — carregar e recusar profiles fora da policy é leitura,
    // não mutação — e nada além disso acontece: nenhum runtime é inicializado,
    // nenhum attempt é consumido, nenhum provider é chamado.
    const previewPlane = await buildControlPlane();
    const preview =
      runtimeStatus === 'ALL_DONE' || previewPlane === null
        ? null
        : await previewPlane.previewNextAction({ taskId: nextTask });
    const status =
      preview === null ? runtimeStatus : preview.status === 'READY' ? 'READY' : 'HUMAN_REQUIRED';

    return {
      payload: {
        status,
        dry_run: true,
        provider_called: false,
        authoritative_mutation: false,
        ...context,
        ...(preview === null ? {} : { project_lifecycle_preview: preview }),
        ...(previewPlane === null ? {} : { project_lifecycle: previewPlane.snapshot() }),
      },
      exitCode: status === 'READY' || status === 'ALL_DONE' ? 0 : 9,
    };
  }

  let initialized = false;
  if (runtimeState === 'NEW') {
    const init = await initializeHarnessRuntime(paths);
    initialized = true;
    context['base_sha'] = init.baseline_sha;
  }

  const controlPlane = await buildControlPlane();

  const orchestrated = await runOrchestrate({
    paths,
    loaded,
    profileId,
    maxIterations: input.maxIterations,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.machineSafetyCeilingOverride === undefined ? {} : { machineSafetyCeilingOverride: input.machineSafetyCeilingOverride }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(controlPlane === null ? {} : { controlPlane }),
  });

  return {
    payload: {
      ...context,
      dry_run: false,
      provider_called: orchestrated.iterationCount > 0,
      initialized,
      run_kind: runtimeState === 'NEW' ? 'NEW' : 'RESUMED',
      ...orchestrated.payload,
      ...(controlPlane === null ? {} : { project_lifecycle: controlPlane.snapshot() }),
    },
    exitCode: exitCodeForOrchestrationStop(orchestrated.stop),
  };
}

/**
 * Sem autorização, `--profile` continua obrigatório e é o único profile da
 * invocação. Com autorização, a policy é a fonte: `--profile` vira opcional e,
 * quando informado, precisa pertencer à policy — nunca a amplia.
 */
function resolveInvocationProfileId(
  input: PlanRunInput,
  authorization: LoadedProjectRunAuthorization | null,
): string {
  if (authorization === null) {
    if (input.profileId === undefined) {
      throw new PlanSetupError(
        '--profile é obrigatório sem --authorization.\n' +
          'Uso: pnpm dev-run-plan --repo <path> --plan <plan.yaml> --profile <id>',
      );
    }
    return input.profileId;
  }
  const ranked = [...authorization.file.profile_policy.profiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  );
  const first = ranked[0];
  if (first === undefined) {
    throw new PlanSetupError(
      `profile policy ${authorization.file.profile_policy.id} não declara nenhum profile elegível.`,
    );
  }
  if (input.profileId === undefined) return first.id;
  if (!ranked.some((entry) => entry.id === input.profileId)) {
    throw new PlanSetupError(
      `--profile ${input.profileId} não pertence à profile policy ${authorization.file.profile_policy.id} ` +
        `(${ranked.map((entry) => entry.id).join(', ')}).\n` +
        'A policy nunca é ampliada implicitamente. Nenhum provider foi chamado.',
    );
  }
  return input.profileId;
}
