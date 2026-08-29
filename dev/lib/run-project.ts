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
import { collectCurrentLaunchFacts } from './project-preflight.js';
import {
  createProductionPoolCapacityProbe,
  planningDiversityProviderOf,
  quotaPoolOfProfile,
  type PoolCapacityProbe,
} from './pool-capacity-observer.js';
import { loadProfileFromCatalog, type LauncherProfile } from './profile.js';
import {
  createPlanningFailoverPort,
  isPlanningEligible,
  rankPlanningCandidates,
  selectPlanningProfile,
  type PlanningPolicyContext,
  type PlanningProfileSnapshot,
} from './planning-selection.js';
import { loadPlan } from './plan.js';
import { PlanSetupError, runPlan, type PlanRunResult } from './run-plan.js';
import { inspectRepository, type ProjectInspection } from '../../src/inspection/index.js';
import type { LabProgressListener } from './lab-progress.js';
import { resolveImpliedHumanGatedFromRuntime } from './human-gated-intent.js';
import {
  ExecutionAuthorizationScope,
  ProjectIntakeRequest,
  executionAuthorizationScopeSha256,
  projectIntakeSha256,
} from '../../src/intake/index.js';
import type { PlanningWorkerPort } from '../../src/planner/draft.js';
import { projectImplementationPlan } from '../../src/planner/generate.js';
import {
  selectDeliberators,
  type DeliberationDiversity,
  type DeliberatorAssignment,
  type PlanDeliberationArtifact,
} from '../../src/planner/deliberation.js';
import { capabilityInputOf } from './project-run.js';
import { capabilityOf, providerFactsOf } from '../../src/routing/index.js';

export interface EnsureGeneratedProjectPlanInput {
  readonly paths: HarnessPaths;
  readonly intake: ProjectIntakeRequest;
  readonly authorizationScope: ExecutionAuthorizationScope;
  readonly inspect?: (repoRoot: string) => Promise<ProjectInspection>;
  readonly planningWorker: () => Promise<PlanningWorkerPort>;
  readonly onProgress?: LabProgressListener;
  /** Só para evidência de falha: qual profile o planner usaria. */
  readonly plannerProfileId?: string | undefined;
  /** Lazy como o planner: `max_turns: 0` não constrói porta nem chama provider. */
  readonly deliberation?: () => Promise<ReviewedPathDeliberation>;
}

export interface EnsuredGeneratedProjectPlan {
  readonly origin: 'GENERATED' | 'REUSED';
  readonly planFile: string;
  readonly taskCount: number;
  /**
   * Planner que de fato originou o PlanFile. No REUSED vem do
   * `generated_from` persistido — nunca da seleção atual.
   */
  readonly planner_profile_id: string | null;
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
      planner_profile_id: loaded.plan.generated_from?.planner_profile_id ?? null,
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
  // Planner primeiro: o deliberador precisa saber quem planejou para preferir
  // um top-tier de outro provider. Resume nunca chega aqui.
  const planningWorker = await input.planningWorker();
  const deliberation = input.deliberation === undefined ? undefined : await input.deliberation();
  // Evidência por tentativa do planner. Criar o sink não escreve nada: só uma
  // invocação real do worker cria diretório — inclusive quando ela é rejeitada
  // e nenhum PlanFile chega a existir.
  const planningEvidence = createPlanningEvidenceSink(input.paths.planningEvidenceDir);
  const planned = await runReviewedPath({
    intake: input.intake,
    inspection,
    authorizationScope: input.authorizationScope,
    planningWorker,
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
    planner_profile_id: projection.generated_from.planner_profile_id ?? null,
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

function planningPolicyContextOf(
  authorization: ProjectRunAuthorizationFile,
): PlanningPolicyContext {
  return {
    allowed_providers: authorization.profile_policy.allowed_providers,
    allowed_billing_modes: authorization.billing.allowed_billing_modes,
    policy_profile_ids: authorization.profile_policy.profiles.map((entry) => entry.id),
  };
}

function planningSnapshotOf(
  profile: LauncherProfile,
  capabilityRank: number,
  facts: { readonly credential: { readonly availability: boolean | null }; readonly quota: { readonly availability: boolean | null } },
): PlanningProfileSnapshot {
  const capability = capabilityOf(capabilityInputOf(profile));
  return {
    id: profile.id,
    agent: profile.agent,
    declared_provider: profile.provider ?? null,
    billing_mode: profile.billing_mode,
    capability_rank: capabilityRank,
    capability_tier: profile.capability_prior?.tier ?? null,
    planner_compatible: capability.role_compatibility.planner.value,
    credential_available: facts.credential.availability,
    quota_available: facts.quota.availability,
  };
}

function plannerProfileIdOf(
  authorization: ProjectRunAuthorizationFile,
  requested: string | undefined,
  snapshots: readonly PlanningProfileSnapshot[],
): ReturnType<typeof selectPlanningProfile> {
  return selectPlanningProfile({
    snapshots,
    policy: planningPolicyContextOf(authorization),
    ...(requested === undefined ? {} : { requested_profile_id: requested }),
  });
}

function assertPlanningSelection(
  selection: ReturnType<typeof selectPlanningProfile>,
  authorization: ProjectRunAuthorizationFile,
): Extract<ReturnType<typeof selectPlanningProfile>, { outcome: 'SELECTED' }> {
  if (selection.outcome === 'SELECTED') return selection;
  if (selection.outcome === 'EXPLICIT_NOT_IN_POLICY') {
    throw new PlanSetupError(
      '--planner-profile ' +
        selection.profile_id +
        ' não pertence à profile policy ' +
        authorization.profile_policy.id +
        '.',
    );
  }
  throw new PlanSetupError(selection.reason);
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
 * filtrados por compatibilidade com o papel de planning. Rankeados por
 * capacidade de PLANNING (não pelo degrau de implementação). Nenhum profile
 * novo é inventado e nenhum de fora da policy entra.
 */
async function deliberatorAssignmentsOf(
  paths: HarnessPaths,
  authorization: ProjectRunAuthorizationFile,
  snapshots: readonly PlanningProfileSnapshot[],
): Promise<{ readonly assignments: readonly DeliberatorAssignment[]; readonly profiles: Map<string, LauncherProfile> }> {
  const policy = planningPolicyContextOf(authorization);
  const ranked = rankPlanningCandidates(
    snapshots.filter((snapshot) => isPlanningEligible(snapshot, policy)),
  );
  const assignments: DeliberatorAssignment[] = [];
  const profiles = new Map<string, LauncherProfile>();
  for (const snapshot of ranked) {
    let profile: LauncherProfile;
    try {
      profile = await loadProfileFromCatalog(paths.profileCatalogRoot, snapshot.id);
    } catch {
      continue;
    }
    const capability = capabilityOf(capabilityInputOf(profile));
    profiles.set(profile.id, profile);
    assignments.push({
      profile_id: profile.id,
      provider: providerFactsOf(capability).provider,
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
  /** Injetável somente para testes determinísticos dos roles read-only. */
  readonly poolCapacityProbe?: PoolCapacityProbe;
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
  const impliedHumanGated = await resolveImpliedHumanGatedFromRuntime(
    input.paths.devDir,
    authorizationScope,
  );
  const capacityProbe =
    input.poolCapacityProbe ?? createProductionPoolCapacityProbe({ paths: input.paths });
  const roleProfiles = new Map<string, LauncherProfile>();
  for (const entry of authorization.profile_policy.profiles) {
    const profile = await loadProfileFromCatalog(input.paths.profileCatalogRoot, entry.id).catch(
      () => null,
    );
    if (profile !== null) roleProfiles.set(profile.id, profile);
  }
  const quotaPoolOf = (profileId: string): string | null => {
    const profile = roleProfiles.get(profileId);
    return profile === undefined ? null : quotaPoolOfProfile(profile);
  };
  /**
   * Fatos de um role NÃO-implementer (planner, deliberador). Cada invocação é
   * uma ATIVIDADE nova, e por isso observa o pool de novo: a leitura do turno
   * anterior descreve aquele turno, não a capacidade deste.
   */
  async function roleLaunchFacts(profile: LauncherProfile, homeNamespace: string) {
    return collectCurrentLaunchFacts({
      paths: input.paths,
      profile,
      probe: capacityProbe,
      poolOf: (item) => quotaPoolOf(item.id),
      homeNamespace,
    });
  }

  const rankById = new Map(
    authorization.profile_policy.profiles.map((entry) => [entry.id, entry.capability_rank]),
  );

  const plannerRef = {
    id: undefined as string | undefined,
    provider: undefined as string | undefined,
  };

  async function livePlanningSnapshots(homeNamespace: string): Promise<PlanningProfileSnapshot[]> {
    const snapshots: PlanningProfileSnapshot[] = [];
    for (const [id, profile] of roleProfiles) {
      const rank = rankById.get(id);
      if (rank === undefined) continue;
      const facts = await roleLaunchFacts(profile, homeNamespace);
      snapshots.push(planningSnapshotOf(profile, rank, facts));
    }
    return snapshots;
  }

  const deliberationRequest = input.deliberation;
  const ensured = await ensureGeneratedProjectPlan({
    paths: input.paths,
    intake: ProjectIntakeRequest.parse(input.intake),
    authorizationScope,
    get plannerProfileId() {
      return plannerRef.id;
    },
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(deliberationRequest === undefined || deliberationRequest.maxTurns === 0
      ? {}
      : {
          deliberation: async (): Promise<ReviewedPathDeliberation> => {
            const snapshots = await livePlanningSnapshots('deliberator-homes');
            const { assignments, profiles } = await deliberatorAssignmentsOf(
              input.paths,
              authorization,
              snapshots,
            );
            async function buildDeliberationPort(profile: LauncherProfile) {
              const facts = await roleLaunchFacts(profile, 'deliberator-homes');
              return createLaunchedDeliberationWorker({
                paths: input.paths,
                profile,
                scope: authorizationScope,
                ...(impliedHumanGated.length === 0 ? {} : { implied_human_gated: impliedHumanGated }),
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
              ...(plannerRef.provider === undefined ? {} : { plannerProvider: plannerRef.provider }),
              worker: {
                async invoke(invocation) {
                  const sequence = selectDeliberators({
                    candidates: assignments,
                    maxTurns: deliberationRequest.maxTurns,
                    diversity: deliberationRequest.diversity,
                    ...(plannerRef.provider === undefined
                      ? {}
                      : { plannerProvider: plannerRef.provider }),
                  }).sequence;
                  const assignment = sequence[invocation.turn - 1];
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
                  const worker = await buildDeliberationPort(profile);
                  return worker.invoke(invocation);
                },
              },
            };
          },
        }),
    planningWorker: async () => {
      const snapshots = await livePlanningSnapshots('planner-homes');
      const selection = assertPlanningSelection(
        plannerProfileIdOf(authorization, input.plannerProfileId, snapshots),
        authorization,
      );
      plannerRef.id = selection.profile_id;
      return createPlanningFailoverPort({
        ranked_profile_ids: selection.ranked_profile_ids,
        invokeWith: async (profileId, invocation) => {
          const profile = await loadPlannerProfile(input.paths, authorization, profileId);
          const facts = await roleLaunchFacts(profile, 'planner-homes');
          input.onProgress?.({ stage: 'PLANNER_RUNNING', detail: profile.id });
          const worker = createLaunchedPlanningWorker({
            paths: input.paths,
            profile,
            scope: authorizationScope,
            ...(impliedHumanGated.length === 0 ? {} : { implied_human_gated: impliedHumanGated }),
            providerEnabled: true,
            dryRun: false,
            credential: facts.credential,
            quota: facts.quota,
            port: createProviderRoleInvocationPort(),
          });
          const result = await worker.invoke(invocation);
          if (result.outcome === 'DRAFT_RETURNED') {
            plannerRef.id = profile.id;
            plannerRef.provider = planningDiversityProviderOf(profile);
          }
          return result;
        },
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
        ...(ensured.planner_profile_id === null && plannerRef.id === undefined
          ? {}
          : { planner_profile_id: ensured.planner_profile_id ?? plannerRef.id }),
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
