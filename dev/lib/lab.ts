import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { inspectRepository, type ProjectInspection } from '../../src/inspection/index.js';
import {
  authorizeExecutionAction,
  classifyImpliedHumanGated,
  createHumanInstruction,
  DETERMINISTIC_INTAKE_COMPILER_PROFILE,
  deterministicIntakeCompiler,
  ProjectIntakeRequest,
  type HumanInstruction,
  type IntakeCompilerPort,
} from '../../src/intake/index.js';
import { headSha, isWorkingTreeClean, repoTopLevel } from './git.js';
import {
  deriveRuntimeDir,
  labArtifactPaths,
  labHarnessPaths,
  loadAuthorizationSnapshot,
  loadHumanInstruction,
  loadPersistedIntake,
  pathExists,
  persistHumanInstruction,
  persistObservability,
  persistProjectIntake,
  type LabObservability,
} from './lab-runtime.js';
import {
  assertControllerUnchanged,
  ensureIsolatedSelfTarget,
  integrateSelfMaintenance,
  isSameGitRepo,
  loadSelfTargetIdentity,
  publishControlRef,
  resolveControlRepo,
  SelfMaintenanceError,
  type SelfTargetIdentity,
} from './lab-self.js';
import { resolveHarnessInstallationRoot } from './paths.js';
import { PlanSetupError, type PlanRunResult } from './run-plan.js';
import { runProject } from './run-project.js';
import {
  authorizationYaml,
  DEFAULT_POLICY_PRESET,
  loadPolicyPreset,
  materializeAuthorization,
  resolvePolicyPresetName,
} from './policy-preset.js';
import { writeFileAtomic } from './atomic.js';

export class LabRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabRunError';
  }
}

export interface SubmitHumanInstructionInput {
  readonly raw_instruction: string;
  readonly instruction_source: 'stdin' | 'file';
  readonly source_path?: string;
  readonly repo?: string;
  readonly self?: boolean;
  readonly publish?: boolean;
  readonly runtime_dir?: string;
  readonly authorization_file?: string;
  readonly policy_preset?: string;
  readonly planner_profile_id?: string;
  readonly max_iterations?: number;
  readonly timeout_override?: string;
  readonly verbose?: boolean;
  readonly autonomy?: 'routine';
  readonly control_root?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly compile_intake?: IntakeCompilerPort;
  readonly inspect?: (repoRoot: string) => Promise<ProjectInspection>;
  readonly run_project?: typeof runProject;
  readonly on_runtime?: (runtimeDir: string) => void;
}

export interface ResumeHumanInstructionInput {
  readonly runtime_dir: string;
  readonly publish?: boolean;
  readonly planner_profile_id?: string;
  readonly max_iterations?: number;
  readonly timeout_override?: string;
  readonly verbose?: boolean;
  readonly autonomy?: 'routine';
  readonly control_root?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run_project?: typeof runProject;
  readonly on_runtime?: (runtimeDir: string) => void;
}

export interface LabRunResult {
  readonly payload: Record<string, unknown>;
  readonly exitCode: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function humanRequiredPayload(
  capability: string,
  runtimeDir: string,
  why: string,
): Record<string, unknown> {
  return {
    status: 'HUMAN_REQUIRED',
    incident_id: `lab-gate-${capability.toLowerCase()}`,
    decision_needed: capability,
    why_automation_stopped: why,
    options: [
      'autorizar explicitamente via --authorization ou um preset que cubra esta categoria',
      'remover o pedido gated da instrução e rerodar',
      `inspecionar o runtime em ${runtimeDir}`,
    ],
    evidence_paths: [runtimeDir],
    runtime_dir: runtimeDir,
  };
}

async function requireCleanRepo(repoRoot: string, label: string): Promise<void> {
  if (!(await isWorkingTreeClean(repoRoot))) {
    throw new LabRunError(`${label} precisa estar com working tree limpa: ${repoRoot}`);
  }
}

async function resolveExternalRepo(repo: string | undefined): Promise<string> {
  if (repo === undefined || repo.trim() === '') {
    throw new LabRunError('--repo é obrigatório sem --self e sem --resume.');
  }
  try {
    return path.resolve(await repoTopLevel(repo));
  } catch (error) {
    throw new LabRunError(`repositório alvo ilegível em ${repo}: ${describe(error)}`);
  }
}

function assembleIntake(
  instruction: HumanInstruction,
  targetRepoUrl: string,
  fields: Awaited<ReturnType<IntakeCompilerPort['compile']>>,
): ProjectIntakeRequest {
  return ProjectIntakeRequest.parse({
    schema_version: 1,
    target_repo: { url: targetRepoUrl },
    base_revision: { sha: instruction.base_sha },
    user_request: instruction.raw_instruction,
    objectives: fields.objectives,
    constraints: fields.constraints,
    exclusions: fields.exclusions,
    requested_scope: fields.requested_scope,
  });
}

async function executeProject(input: {
  readonly repoRoot: string;
  readonly runtimeDir: string;
  readonly intake: ProjectIntakeRequest;
  readonly authorizationFile: string;
  readonly plannerProfileId?: string;
  readonly maxIterations: number;
  readonly timeoutOverride?: string;
  readonly verbose?: boolean;
  readonly autonomy?: 'routine';
  readonly runProjectImpl: typeof runProject;
}): Promise<PlanRunResult> {
  const paths = labHarnessPaths({ repoRoot: input.repoRoot, runtimeDir: input.runtimeDir });
  return input.runProjectImpl({
    paths,
    intake: input.intake,
    authorizationFile: input.authorizationFile,
    maxIterations: input.maxIterations,
    ...(input.plannerProfileId === undefined ? {} : { plannerProfileId: input.plannerProfileId }),
    ...(input.timeoutOverride === undefined ? {} : { timeoutOverride: input.timeoutOverride }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
  });
}

async function maybeIntegrateSelf(input: {
  readonly self: boolean;
  readonly publish: boolean;
  readonly controlRoot: string;
  readonly identity: SelfTargetIdentity | null;
  readonly executed: PlanRunResult;
}): Promise<Record<string, unknown>> {
  if (!input.self || input.identity === null) return {};
  const stoppedBy = input.executed.payload['stopped_by'];
  if (stoppedBy !== 'ALL_DONE') {
    return {
      self_maintenance: {
        isolated_worktree: input.identity.target_worktree_path,
        branch: input.identity.self_maintenance_branch,
        integration: 'DEFERRED',
      },
    };
  }
  try {
    const integrated = await integrateSelfMaintenance({
      controlRoot: input.controlRoot,
      identity: input.identity,
    });
    if (!input.publish) {
      return {
        self_maintenance: {
          isolated_worktree: input.identity.target_worktree_path,
          branch: input.identity.self_maintenance_branch,
          integration: integrated.status,
          integrated_sha: integrated.integrated_sha,
          publish: 'PUSH_REQUIRED',
        },
      };
    }
    const pushed = await publishControlRef({
      controlRoot: input.controlRoot,
      ref: input.identity.original_ref,
    });
    return {
      self_maintenance: {
        isolated_worktree: input.identity.target_worktree_path,
        branch: input.identity.self_maintenance_branch,
        integration: integrated.status,
        integrated_sha: integrated.integrated_sha,
        publish: pushed.status,
        remote: pushed.remote,
      },
    };
  } catch (error) {
    if (error instanceof SelfMaintenanceError && error.code === 'EXTERNAL_STATE_DIVERGENCE') {
      return {
        status: 'EXTERNAL_STATE_DIVERGENCE',
        why_automation_stopped: error.message,
        self_maintenance: {
          isolated_worktree: input.identity.target_worktree_path,
          branch: input.identity.self_maintenance_branch,
          integration: 'REFUSED',
        },
      };
    }
    throw error;
  }
}

/**
 * Porta de aplicação transport-neutral. CLI e um futuro MCP chamam isto;
 * stdin/console/argv ficam no adapter.
 */
export async function submitHumanInstruction(
  input: SubmitHumanInstructionInput,
): Promise<LabRunResult> {
  const raw = input.raw_instruction.trim();
  if (raw.length === 0) throw new LabRunError('a instrução humana está vazia.');

  const controlRoot = await resolveControlRepo(input.control_root ?? resolveHarnessInstallationRoot());
  const env = input.env ?? process.env;
  const selfRequested = input.self === true;
  let targetType: 'external' | 'self' = selfRequested ? 'self' : 'external';
  let repoRoot: string;

  if (selfRequested) {
    repoRoot = controlRoot;
  } else {
    repoRoot = await resolveExternalRepo(input.repo);
    if (await isSameGitRepo(repoRoot, controlRoot)) {
      throw new LabRunError(
        'o repositório alvo é o próprio Agent Lab. Use --self para self-maintenance isolada.',
      );
    }
  }

  await requireCleanRepo(selfRequested ? controlRoot : repoRoot, selfRequested ? 'control repo' : 'repositório alvo');
  const baseSha = await headSha(repoRoot);
  const instruction = createHumanInstruction({
    raw_instruction: raw,
    source: input.instruction_source,
    ...(input.source_path === undefined ? {} : { source_path: input.source_path }),
    target_type: targetType,
    target_identity: repoRoot,
    base_sha: baseSha,
  });

  const runtimeDir =
    input.runtime_dir === undefined
      ? deriveRuntimeDir({
          controlRoot,
          env,
          repoRoot,
          instructionHash: instruction.instruction_hash,
          baseSha,
          targetType,
        })
      : path.resolve(input.runtime_dir);
  input.on_runtime?.(runtimeDir);
  const artifacts = labArtifactPaths(runtimeDir);

  if (await pathExists(artifacts.humanInstruction)) {
    const existing = await loadHumanInstruction(artifacts.humanInstruction);
    if (existing.instruction_hash !== instruction.instruction_hash) {
      throw new LabRunError(
        `runtime ${runtimeDir} já contém outra instrução. Use --runtime-dir novo ou --resume.`,
      );
    }
    return resumeHumanInstruction({
      runtime_dir: runtimeDir,
      ...(input.publish === undefined ? {} : { publish: input.publish }),
      ...(input.planner_profile_id === undefined ? {} : { planner_profile_id: input.planner_profile_id }),
      ...(input.max_iterations === undefined ? {} : { max_iterations: input.max_iterations }),
      ...(input.timeout_override === undefined ? {} : { timeout_override: input.timeout_override }),
      ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
      ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
      control_root: controlRoot,
      env,
      ...(input.run_project === undefined ? {} : { run_project: input.run_project }),
      ...(input.on_runtime === undefined ? {} : { on_runtime: input.on_runtime }),
    });
  }

  await persistHumanInstruction(artifacts.humanInstruction, instruction);

  let selfIdentity: SelfTargetIdentity | null = null;
  if (targetType === 'self') {
    selfIdentity = await ensureIsolatedSelfTarget({
      controlRoot,
      runId: `${instruction.instruction_hash.slice(0, 16)}-${baseSha.slice(0, 12)}`,
      worktreePath: path.join(runtimeDir, 'worktree'),
      identityFile: artifacts.selfTarget,
    });
    repoRoot = selfIdentity.target_worktree_path;
  }

  const inspect = input.inspect ?? ((root: string) => inspectRepository({ repoRoot: root }));
  const inspection = await inspect(repoRoot);
  const compiler = input.compile_intake ?? deterministicIntakeCompiler;
  const fields = await compiler.compile({ instruction, inspection });
  const intake = assembleIntake(instruction, repoRoot, fields);
  await persistProjectIntake(artifacts.intake, stringifyYaml(intake));

  const presetName =
    input.authorization_file === undefined
      ? resolvePolicyPresetName({
          ...(input.policy_preset === undefined ? {} : { requested: input.policy_preset }),
          env,
        })
      : 'authorization-file';
  const authorizationFile = artifacts.authorization;
  if (input.authorization_file !== undefined) {
    const loaded = await loadAuthorizationSnapshot(input.authorization_file);
    const snapshot = materializeAuthorization({
      preset: loaded.file,
      requested_scope: intake.requested_scope,
    });
    await writeFileAtomic(authorizationFile, authorizationYaml(snapshot));
  } else {
    const loaded = await loadPolicyPreset(presetName, path.join(controlRoot, 'dev', 'presets'));
    const snapshot = materializeAuthorization({
      preset: loaded.file,
      requested_scope: intake.requested_scope,
    });
    await writeFileAtomic(authorizationFile, authorizationYaml(snapshot));
  }
  const authorization = await loadAuthorizationSnapshot(authorizationFile);

  const observability: LabObservability = {
    schema_version: 1,
    instruction_source: input.instruction_source,
    instruction_sha256: instruction.instruction_hash,
    target_type: targetType,
    controller_sha: await headSha(controlRoot),
    intake_compiler_profile: DETERMINISTIC_INTAKE_COMPILER_PROFILE,
    planner_profile: input.planner_profile_id ?? authorization.file.profile_policy.profiles[0]?.id ?? 'unknown',
    policy_preset: presetName,
  };
  await persistObservability(artifacts.observability, observability);

  const implied = classifyImpliedHumanGated(instruction.raw_instruction);
  for (const capability of implied) {
    const decision = authorizeExecutionAction(
      {
        schema_version: 1,
        requested_scope: intake.requested_scope,
        autonomous_execution_boundary: authorization.file.autonomous_execution_boundary,
        human_gated_capabilities: authorization.file.human_gated_capabilities,
      },
      { kind: 'human_gated', capability },
    );
    if (decision === 'HUMAN_REQUIRED') {
      return {
        payload: {
          ...humanRequiredPayload(
            capability,
            runtimeDir,
            `a instrução implica ${capability}; o texto do prompt não autoriza esta categoria.`,
          ),
          human_instruction: artifacts.humanInstruction,
          intake_file: artifacts.intake,
          authorization_file: authorizationFile,
          policy_preset: presetName,
          observability,
        },
        exitCode: 9,
      };
    }
  }

  if (targetType === 'self') {
    await assertControllerUnchanged(selfIdentity as SelfTargetIdentity, controlRoot);
  }

  const executed = await executeProject({
    repoRoot,
    runtimeDir,
    intake,
    authorizationFile,
    maxIterations: input.max_iterations ?? 100,
    runProjectImpl: input.run_project ?? runProject,
    ...(input.planner_profile_id === undefined ? {} : { plannerProfileId: input.planner_profile_id }),
    ...(input.timeout_override === undefined ? {} : { timeoutOverride: input.timeout_override }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
  });

  const selfReport = await maybeIntegrateSelf({
    self: targetType === 'self',
    publish: input.publish === true,
    controlRoot,
    identity: selfIdentity,
    executed,
  });
  const diverged = selfReport['status'] === 'EXTERNAL_STATE_DIVERGENCE';
  return {
    payload: {
      runtime_dir: runtimeDir,
      human_instruction: artifacts.humanInstruction,
      intake_file: artifacts.intake,
      authorization_file: authorizationFile,
      policy_preset: presetName,
      observability,
      ...executed.payload,
      ...selfReport,
    },
    exitCode: diverged ? 9 : executed.exitCode,
  };
}

export async function resumeHumanInstruction(
  input: ResumeHumanInstructionInput,
): Promise<LabRunResult> {
  const runtimeDir = path.resolve(input.runtime_dir);
  input.on_runtime?.(runtimeDir);
  const artifacts = labArtifactPaths(runtimeDir);
  if (!(await pathExists(artifacts.humanInstruction))) {
    throw new LabRunError(`runtime sem HumanInstruction persistida: ${artifacts.humanInstruction}`);
  }
  const instruction = await loadHumanInstruction(artifacts.humanInstruction);
  const intake = await loadPersistedIntake(artifacts.intake);
  if (intake.user_request !== instruction.raw_instruction) {
    throw new LabRunError(
      'intake persistido diverge da instrução humana raw. O planner não será chamado.',
    );
  }
  const authorization = await loadAuthorizationSnapshot(artifacts.authorization);
  const controlRoot = await resolveControlRepo(input.control_root ?? resolveHarnessInstallationRoot());

  let repoRoot = path.resolve(instruction.target.identity);
  let selfIdentity: SelfTargetIdentity | null = null;
  if (instruction.target.type === 'self') {
    selfIdentity = await loadSelfTargetIdentity(artifacts.selfTarget);
    if (!(await pathExists(selfIdentity.target_worktree_path))) {
      selfIdentity = await ensureIsolatedSelfTarget({
        controlRoot,
        runId: path.basename(selfIdentity.self_maintenance_branch),
        worktreePath: selfIdentity.target_worktree_path,
        identityFile: artifacts.selfTarget,
      });
    }
    repoRoot = selfIdentity.target_worktree_path;
    await assertControllerUnchanged(selfIdentity, controlRoot);
  }

  const executed = await executeProject({
    repoRoot,
    runtimeDir,
    intake,
    authorizationFile: artifacts.authorization,
    maxIterations: input.max_iterations ?? 100,
    runProjectImpl: input.run_project ?? runProject,
    ...(input.planner_profile_id === undefined ? {} : { plannerProfileId: input.planner_profile_id }),
    ...(input.timeout_override === undefined ? {} : { timeoutOverride: input.timeout_override }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
  });
  const selfReport = await maybeIntegrateSelf({
    self: instruction.target.type === 'self',
    publish: input.publish === true,
    controlRoot,
    identity: selfIdentity,
    executed,
  });
  const diverged = selfReport['status'] === 'EXTERNAL_STATE_DIVERGENCE';
  return {
    payload: {
      runtime_dir: runtimeDir,
      human_instruction: artifacts.humanInstruction,
      intake_file: artifacts.intake,
      authorization_file: artifacts.authorization,
      policy_preset: authorization.file.profile_policy.id,
      resumed: true,
      ...executed.payload,
      ...selfReport,
    },
    exitCode: diverged ? 9 : executed.exitCode,
  };
}

export { DEFAULT_POLICY_PRESET };
export { PlanSetupError };
