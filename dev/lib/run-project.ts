import { access, readFile } from 'node:fs/promises';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { writeFileAtomic } from './atomic.js';
import type { HarnessPaths } from './paths.js';
import {
  loadProjectRunAuthorization,
  ProjectAuthorizationError,
  type ProjectRunAuthorizationFile,
} from './project-authorization.js';
import {
  createLaunchedPlanningWorker,
  createProviderRoleInvocationPort,
  runReviewedPath,
} from './project-orchestrate.js';
import { collectProjectLaunchFacts } from './project-preflight.js';
import { loadProfileFromCatalog, type LauncherProfile } from './profile.js';
import { loadPlan } from './plan.js';
import { PlanSetupError, runPlan, type PlanRunResult } from './run-plan.js';
import { inspectRepository, type ProjectInspection } from '../../src/inspection/index.js';
import type { LabProgressListener } from './lab-progress.js';
import {
  ExecutionAuthorizationScope,
  ProjectIntakeRequest,
  executionAuthorizationScopeSha256,
  projectIntakeSha256,
} from '../../src/intake/index.js';
import type { PlanningWorkerPort } from '../../src/planner/draft.js';
import { projectImplementationPlan } from '../../src/planner/generate.js';

export interface EnsureGeneratedProjectPlanInput {
  readonly paths: HarnessPaths;
  readonly intake: ProjectIntakeRequest;
  readonly authorizationScope: ExecutionAuthorizationScope;
  readonly inspect?: (repoRoot: string) => Promise<ProjectInspection>;
  readonly planningWorker: () => Promise<PlanningWorkerPort>;
  readonly onProgress?: LabProgressListener;
  /** Só para evidência de falha: qual profile o planner usaria. */
  readonly plannerProfileId?: string;
}

export interface EnsuredGeneratedProjectPlan {
  readonly origin: 'GENERATED' | 'REUSED';
  readonly planFile: string;
  readonly taskCount: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertReusableSource(
  paths: HarnessPaths,
  intake: ProjectIntakeRequest,
  authorizationScope: ExecutionAuthorizationScope,
  source: Awaited<ReturnType<typeof loadPlan>>['plan']['generated_from'],
): void {
  if (source === undefined) {
    throw new PlanSetupError(
      'o artifact existente em ' +
        paths.planFile +
        ' não declara generated_from; ele não será substituído nem regenerado silenciosamente.',
    );
  }
  const expectedIntake = projectIntakeSha256(intake);
  const expectedAuthorization = executionAuthorizationScopeSha256(authorizationScope);
  if (
    source.intake_sha256 !== expectedIntake ||
    source.authorization_scope_sha256 !== expectedAuthorization
  ) {
    throw new PlanSetupError(
      'o artifact gerado existente diverge do intake ou do authorization scope atuais.\n' +
        'O plano preservado não foi regenerado. Use outro --runtime-dir para uma nova run.',
    );
  }
}

async function runtimeStateExists(paths: HarnessPaths): Promise<boolean> {
  try {
    await access(paths.stateFile);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Único ponto de persistência do glue v0.1. O factory do planner é lazy:
 * restart com artifact válido não coleta fatos, não constrói porta e não
 * chama provider.
 */
export async function ensureGeneratedProjectPlan(
  input: EnsureGeneratedProjectPlanInput,
): Promise<EnsuredGeneratedProjectPlan> {
  try {
    const loaded = await loadPlan(input.paths.planFile);
    assertReusableSource(input.paths, input.intake, input.authorizationScope, loaded.plan.generated_from);
    input.onProgress?.({
      stage: 'PLAN_READY',
      detail: `origin=REUSED tasks=${loaded.plan.tasks.length}`,
    });
    return { origin: 'REUSED', planFile: input.paths.planFile, taskCount: loaded.plan.tasks.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof PlanSetupError) throw error;
      throw new PlanSetupError(
        'artifact de plano gerado ilegível em ' + input.paths.planFile + ': ' + describe(error),
      );
    }
  }

  if (await runtimeStateExists(input.paths)) {
    throw new PlanSetupError(
      'runtime existente sem o artifact de plano gerado em ' +
        input.paths.planFile +
        '.\nO planner não foi chamado e o runtime não foi alterado.',
    );
  }

  input.onProgress?.({ stage: 'PLANNING' });
  const inspect = input.inspect ?? ((repoRoot: string) => inspectRepository({ repoRoot }));
  const inspection = await inspect(input.paths.repoRoot);
  const planned = await runReviewedPath({
    intake: input.intake,
    inspection,
    authorizationScope: input.authorizationScope,
    planningWorker: await input.planningWorker(),
  });
  if (planned.outcome !== 'PLANNED') {
    const details =
      planned.outcome === 'REJECTED' || planned.outcome === 'DECOMPOSITION_REQUIRED'
        ? planned.stage + ': ' + planned.issues.join('; ')
        : 'planning recusado';
    // Evidência operacional da falha: stage, profile e runtime, para que o
    // usuário saiba ONDE parou e onde inspecionar sem abrir o código.
    throw new PlanSetupError(
      'planning worker/gates recusaram o projeto: ' +
        details +
        '\nstage=' +
        (planned.outcome === 'REJECTED' || planned.outcome === 'DECOMPOSITION_REQUIRED'
          ? planned.stage
          : 'PLANNING_WORKER') +
        (input.plannerProfileId === undefined ? '' : ' planner_profile=' + input.plannerProfileId) +
        '\nevidence: ' + input.paths.devDir +
        '\nNenhum PlanFile foi persistido e o executor não foi chamado.',
    );
  }

  const projection = projectImplementationPlan(planned.plan);
  await writeFileAtomic(input.paths.planFile, stringifyYaml(projection));
  input.onProgress?.({
    stage: 'PLAN_READY',
    detail: `origin=GENERATED tasks=${projection.tasks.length}`,
  });
  return { origin: 'GENERATED', planFile: input.paths.planFile, taskCount: projection.tasks.length };
}

function executionScopeOf(authorization: ProjectRunAuthorizationFile): ExecutionAuthorizationScope {
  return ExecutionAuthorizationScope.parse({
    schema_version: 1,
    requested_scope: authorization.requested_scope,
    autonomous_execution_boundary: authorization.autonomous_execution_boundary,
    human_gated_capabilities: authorization.human_gated_capabilities,
  });
}

function plannerProfileIdOf(
  authorization: ProjectRunAuthorizationFile,
  requested: string | undefined,
): string {
  const ranked = [...authorization.profile_policy.profiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  );
  if (requested !== undefined) {
    if (!ranked.some((entry) => entry.id === requested)) {
      throw new PlanSetupError(
        '--planner-profile ' +
          requested +
          ' não pertence à profile policy ' +
          authorization.profile_policy.id +
          '.',
      );
    }
    return requested;
  }
  const first = ranked[0];
  if (first === undefined) {
    throw new PlanSetupError('profile policy não declara profile elegível para o planner.');
  }
  return first.id;
}

async function loadPlannerProfile(
  paths: HarnessPaths,
  authorization: ProjectRunAuthorizationFile,
  profileId: string,
): Promise<LauncherProfile> {
  let profile: LauncherProfile;
  try {
    profile = await loadProfileFromCatalog(paths.profileCatalogRoot, profileId);
  } catch (error) {
    throw new PlanSetupError('planner profile ' + profileId + ' recusado: ' + describe(error));
  }
  if (!authorization.billing.allowed_billing_modes.includes(profile.billing_mode)) {
    throw new PlanSetupError(
      'planner profile ' + profileId + ' usa billing_mode fora da autorização da run.',
    );
  }
  const capabilityAgent = profile.test_double_of?.agent ?? profile.agent;
  if (
    !authorization.profile_policy.allowed_providers.includes(profile.agent) &&
    !authorization.profile_policy.allowed_providers.includes(capabilityAgent)
  ) {
    throw new PlanSetupError(
      'planner profile ' + profileId + ' usa provider fora da profile policy autorizada.',
    );
  }
  return profile;
}

export interface ProjectRunInput {
  readonly paths: HarnessPaths;
  readonly intake: ProjectIntakeRequest;
  readonly authorizationFile: string;
  readonly plannerProfileId?: string;
  readonly maxIterations: number;
  readonly autonomy?: 'routine';
  readonly timeoutOverride?: string;
  readonly verbose?: boolean;
  readonly onProgress?: LabProgressListener;
}

/** Glue de release: planeja/persiste uma vez e delega ao executor existente. */
export async function runProject(input: ProjectRunInput): Promise<PlanRunResult> {
  let loadedAuthorization: Awaited<ReturnType<typeof loadProjectRunAuthorization>>;
  try {
    loadedAuthorization = await loadProjectRunAuthorization(input.authorizationFile);
  } catch (error) {
    throw error instanceof ProjectAuthorizationError
      ? new PlanSetupError(error.message)
      : error;
  }
  const authorization = loadedAuthorization.file;
  const authorizationScope = executionScopeOf(authorization);
  const plannerProfileId = plannerProfileIdOf(authorization, input.plannerProfileId);

  const ensured = await ensureGeneratedProjectPlan({
    paths: input.paths,
    intake: ProjectIntakeRequest.parse(input.intake),
    authorizationScope,
    plannerProfileId,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    planningWorker: async () => {
      const profile = await loadPlannerProfile(input.paths, authorization, plannerProfileId);
      const facts = await collectProjectLaunchFacts({
        paths: input.paths,
        profile,
        homeNamespace: 'planner-homes',
      });
      input.onProgress?.({ stage: 'PLANNER_RUNNING', detail: profile.id });
      return createLaunchedPlanningWorker({
        paths: input.paths,
        profile,
        scope: authorizationScope,
        providerEnabled: true,
        dryRun: false,
        credential: facts.credential,
        quota: facts.quota,
        workerRuntimeBudgetMs:
          authorization.work_units.default.resource_envelope.duration_ms.maximum,
        port: createProviderRoleInvocationPort(),
      });
    },
  });

  const executed = await runPlan({
    paths: input.paths,
    authorizationFile: loadedAuthorization.source_file,
    dryRun: false,
    maxIterations: input.maxIterations,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
    ...(input.timeoutOverride === undefined ? {} : { timeoutOverride: input.timeoutOverride }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
  });
  return {
    payload: {
      ...executed.payload,
      generated_plan: {
        origin: ensured.origin,
        file: ensured.planFile,
        planner_profile_id: plannerProfileId,
      },
    },
    exitCode: executed.exitCode,
  };
}

export async function loadProjectIntakeRequest(file: string): Promise<ProjectIntakeRequest> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new PlanSetupError('project intake ilegível em ' + file + ': ' + describe(error));
  }
  try {
    return ProjectIntakeRequest.parse(parseYaml(raw));
  } catch (error) {
    throw new PlanSetupError('project intake inválido em ' + file + ': ' + describe(error));
  }
}
