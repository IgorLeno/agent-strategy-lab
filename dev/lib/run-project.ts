import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { writeFileAtomic } from './atomic.js';
import {
  createPlanningEvidenceSink,
  planningEvidenceReport,
} from './planning-evidence.js';
import type { HarnessPaths } from './paths.js';
import {
  loadProjectRunAuthorization,
  ProjectAuthorizationError,
  type ProjectRunAuthorizationFile,
} from './project-authorization.js';
import {
  createLaunchedDeliberationWorker,
  createLaunchedPlanningWorker,
  createProviderRoleInvocationPort,
  runReviewedPath,
  type ReviewedPathDeliberation,
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
import type {
  DeliberationDiversity,
  DeliberatorAssignment,
  PlanDeliberationArtifact,
} from '../../src/planner/deliberation.js';
import { capabilityInputOf } from './project-run.js';
import { capabilityOf } from '../../src/routing/index.js';

export interface EnsureGeneratedProjectPlanInput {
  readonly paths: HarnessPaths;
  readonly intake: ProjectIntakeRequest;
  readonly authorizationScope: ExecutionAuthorizationScope;
  readonly inspect?: (repoRoot: string) => Promise<ProjectInspection>;
  readonly planningWorker: () => Promise<PlanningWorkerPort>;
  readonly onProgress?: LabProgressListener;
  /** Só para evidência de falha: qual profile o planner usaria. */
  readonly plannerProfileId?: string;
  /** Lazy como o planner: `max_turns: 0` não constrói porta nem chama provider. */
  readonly deliberation?: () => Promise<ReviewedPathDeliberation>;
}

export interface EnsuredGeneratedProjectPlan {
  readonly origin: 'GENERATED' | 'REUSED';
  readonly planFile: string;
  readonly taskCount: number;
  /** `null` quando a deliberação não foi pedida ou o plano foi reusado. */
  readonly deliberation: PlanDeliberationArtifact | null;
  readonly deliberationArtifactFile: string | null;
}

export const PROJECT_DELIBERATION_ARTIFACT = 'deliberation.json';

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
    return {
      origin: 'REUSED',
      planFile: input.paths.planFile,
      taskCount: loaded.plan.tasks.length,
      deliberation: null,
      deliberationArtifactFile: null,
    };
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
  const deliberation = input.deliberation === undefined ? undefined : await input.deliberation();
  // Evidência por tentativa do planner. Criar o sink não escreve nada: só uma
  // invocação real do worker cria diretório — inclusive quando ela é rejeitada
  // e nenhum PlanFile chega a existir.
  const planningEvidence = createPlanningEvidenceSink(input.paths.planningEvidenceDir);
  const planned = await runReviewedPath({
    intake: input.intake,
    inspection,
    authorizationScope: input.authorizationScope,
    planningWorker: await input.planningWorker(),
    onPlanningAttempt: planningEvidence.observer,
    ...(deliberation === undefined
      ? {}
      : {
          deliberation: {
            ...deliberation,
            onTurn: (turn) => {
              input.onProgress?.({
                stage: 'DELIBERATING',
                detail: `turn=${turn.turn} profile=${turn.profile_id} decision=${turn.decision ?? 'UNAVAILABLE'}`,
                deliberation: {
                  turn: turn.turn,
                  max_turns: deliberation.maxTurns,
                  profile_id: turn.profile_id,
                  provider: turn.provider,
                  model: turn.model,
                  decision: turn.decision ?? 'REVISE',
                  converged: turn.converged,
                },
              });
            },
          },
        }),
  });
  if (planned.outcome !== 'PLANNED') {
    const details =
      planned.outcome === 'REJECTED' || planned.outcome === 'DECOMPOSITION_REQUIRED'
        ? planned.stage + ': ' + planned.issues.join('; ')
        : 'planning recusado';
    // Evidência operacional da falha: stage, profile e — o que faltava quando
    // uma run real morreu em SCHEMA_NORMALIZATION — o ARTIFACT exato de cada
    // tentativa. O draft nunca é despejado no terminal: só o caminho dele.
    throw new PlanSetupError(
      'planning worker/gates recusaram o projeto: ' +
        details +
        '\nstage=' +
        (planned.outcome === 'REJECTED' || planned.outcome === 'DECOMPOSITION_REQUIRED'
          ? planned.stage
          : 'PLANNING_WORKER') +
        (input.plannerProfileId === undefined ? '' : ' planner_profile=' + input.plannerProfileId) +
        '\nevidence: ' + input.paths.devDir +
        '\n' + planningEvidenceReport(planningEvidence.attempts()) +
        '\nNenhum PlanFile foi persistido e o executor não foi chamado.',
    );
  }

  // A versão FINAL é o que vira PlanFile. Só depois dela o lifecycle normal de
  // implementação começa — deliberador nenhum tocou no repositório até aqui.
  let deliberationArtifactFile: string | null = null;
  if (planned.deliberation !== null) {
    deliberationArtifactFile = path.join(
      path.dirname(input.paths.planFile),
      PROJECT_DELIBERATION_ARTIFACT,
    );
    await writeFileAtomic(
      deliberationArtifactFile,
      `${JSON.stringify(planned.deliberation, null, 2)}\n`,
    );
    input.onProgress?.({
      stage: 'PLAN_SEALED',
      detail:
        `turns=${planned.deliberation.actual_turns}/${planned.deliberation.requested_max_turns} ` +
        `${planned.deliberation.convergence_status}`,
    });
  }

  const projection = projectImplementationPlan(planned.plan);
  await writeFileAtomic(input.paths.planFile, stringifyYaml(projection));
  input.onProgress?.({
    stage: 'PLAN_READY',
    detail: `origin=GENERATED tasks=${projection.tasks.length}`,
  });
  return {
    origin: 'GENERATED',
    planFile: input.paths.planFile,
    taskCount: projection.tasks.length,
    deliberation: planned.deliberation,
    deliberationArtifactFile,
  };
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

/**
 * Deliberação pedida pelo humano. `max_turns: 0` (ou ausência) preserva o
 * comportamento anterior: nenhum deliberador é construído nem chamado.
 */
export interface ProjectDeliberationRequest {
  readonly maxTurns: number;
  readonly diversity: DeliberationDiversity;
}

/**
 * Profiles elegíveis ao PAPEL de deliberação: os mesmos da policy autorizada,
 * filtrados por compatibilidade com o papel de planning. Nenhum profile novo é
 * inventado e nenhum de fora da policy entra.
 */
async function deliberatorAssignmentsOf(
  paths: HarnessPaths,
  authorization: ProjectRunAuthorizationFile,
): Promise<{ readonly assignments: readonly DeliberatorAssignment[]; readonly profiles: Map<string, LauncherProfile> }> {
  const assignments: DeliberatorAssignment[] = [];
  const profiles = new Map<string, LauncherProfile>();
  for (const entry of [...authorization.profile_policy.profiles].sort(
    (left, right) => left.capability_rank - right.capability_rank,
  )) {
    let profile: LauncherProfile;
    try {
      profile = await loadProfileFromCatalog(paths.profileCatalogRoot, entry.id);
    } catch {
      // Profile ilegível não vira deliberador silencioso nem derruba a run:
      // ele simplesmente não entra na lista de candidatos.
      continue;
    }
    if (!authorization.billing.allowed_billing_modes.includes(profile.billing_mode)) continue;
    const capability = capabilityOf(capabilityInputOf(profile));
    if (capability.role_compatibility.planner.value !== true) continue;
    profiles.set(profile.id, profile);
    assignments.push({
      profile_id: profile.id,
      provider: capability.agent,
      model: capability.model,
    });
  }
  return { assignments, profiles };
}

export interface ProjectRunInput {
  readonly paths: HarnessPaths;
  readonly intake: ProjectIntakeRequest;
  readonly authorizationFile: string;
  readonly plannerProfileId?: string;
  readonly deliberation?: ProjectDeliberationRequest;
  readonly maxIterations: number;
  readonly autonomy?: 'routine';
  readonly machineSafetyCeilingOverride?: string;
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

  const deliberationRequest = input.deliberation;
  const ensured = await ensureGeneratedProjectPlan({
    paths: input.paths,
    intake: ProjectIntakeRequest.parse(input.intake),
    authorizationScope,
    plannerProfileId,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(deliberationRequest === undefined || deliberationRequest.maxTurns === 0
      ? {}
      : {
          deliberation: async (): Promise<ReviewedPathDeliberation> => {
            const { assignments, profiles } = await deliberatorAssignmentsOf(
              input.paths,
              authorization,
            );
            // Uma porta por profile: cada turno é processo NOVO, read-only,
            // com o preflight de credencial e cobrança do próprio profile.
            const ports = new Map<string, Awaited<ReturnType<typeof buildDeliberationPort>>>();
            async function buildDeliberationPort(profile: LauncherProfile) {
              const facts = await collectProjectLaunchFacts({
                paths: input.paths,
                profile,
                homeNamespace: 'deliberator-homes',
              });
              return createLaunchedDeliberationWorker({
                paths: input.paths,
                profile,
                scope: authorizationScope,
                providerEnabled: true,
                dryRun: false,
                credential: facts.credential,
                quota: facts.quota,
                port: createProviderRoleInvocationPort(),
              });
            }
            return {
              maxTurns: deliberationRequest.maxTurns,
              diversity: deliberationRequest.diversity,
              deliberators: assignments,
              humanRequest: input.intake.user_request,
              worker: {
                async invoke(invocation) {
                  // O turno corrente identifica o profile pela sequência que
                  // `selectDeliberators` já fixou deterministicamente.
                  const assignment = assignments[(invocation.turn - 1) % Math.max(1, assignments.length)];
                  const profile = assignment === undefined ? undefined : profiles.get(assignment.profile_id);
                  if (profile === undefined) {
                    return {
                      outcome: 'INVOCATION_FAILED',
                      failure: {
                        code: 'NO_DELIBERATOR_PROFILE',
                        message: 'nenhum profile da policy é compatível com o papel de deliberação',
                      },
                    };
                  }
                  let worker = ports.get(profile.id);
                  if (worker === undefined) {
                    worker = await buildDeliberationPort(profile);
                    ports.set(profile.id, worker);
                  }
                  return worker.invoke(invocation);
                },
              },
            };
          },
        }),
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
    ...(input.machineSafetyCeilingOverride === undefined ? {} : { machineSafetyCeilingOverride: input.machineSafetyCeilingOverride }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
  });
  return {
    payload: {
      ...executed.payload,
      generated_plan: {
        origin: ensured.origin,
        file: ensured.planFile,
        planner_profile_id: plannerProfileId,
        ...(ensured.deliberation === null
          ? {}
          : {
              deliberation: {
                artifact_file: ensured.deliberationArtifactFile,
                requested_max_turns: ensured.deliberation.requested_max_turns,
                actual_turns: ensured.deliberation.actual_turns,
                convergence_status: ensured.deliberation.convergence_status,
                final_plan_sha256: ensured.deliberation.final_plan_sha256,
                stop_reason: ensured.deliberation.stop_reason,
              },
            }),
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
