import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { inspectRepository, type ProjectInspection } from '../../src/inspection/index.js';
import { CapacityStatus } from '../../src/quota/index.js';
import {
  createHumanInstruction,
  HUMAN_GATE_GRANT_PATH,
  type HumanAuthority,
  DETERMINISTIC_INTAKE_COMPILER_PROFILE,
  deterministicIntakeCompiler,
  humanInstructionBody,
  parseRunDirective,
  ProjectIntakeRequest,
  RunDirectiveError,
  runDirectiveHash,
  type ExecutionAuthorizationScope,
  type AgentLabRunDirectiveHeader,
  type HumanInstruction,
  type IntakeCompilerPort,
  type ParsedRunDirective,
} from '../../src/intake/index.js';
import {
  evaluateImpliedHumanGatedIntent,
  executionScopeFromAuthorization,
} from './human-gated-intent.js';
import { grantAdditionalRepairAuthorization } from './automatic-repair.js';
import {
  createProductionPoolCapacityProbe,
  observeEligiblePoolCapacities,
} from './pool-capacity-observer.js';
import { loadProfileFromCatalog } from './profile.js';
import {
  grantProviderExpansionAuthorization,
  ProviderExpansionAuthorizationError,
} from './provider-expansion.js';
import { headSha, isWorkingTreeClean, repoTopLevel } from './git.js';
import {
  deriveRuntimeDir,
  labArtifactPaths,
  labHarnessPaths,
  loadAuthorizationSnapshot,
  loadHumanInstruction,
  loadPersistedIntake,
  loadPersistedRunDirective,
  loadPublishGrant,
  pathExists,
  persistHumanInstruction,
  persistObservability,
  persistProjectIntake,
  persistPublishGrant,
  persistRunDirective,
  persistRunDirectiveHeader,
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
import { withHarnessLock } from './lock.js';
import { resolveHarnessInstallationRoot } from './paths.js';
import { PlanSetupError, type PlanRunResult } from './run-plan.js';
import { runProject, type ProjectDeliberationRequest } from './run-project.js';
import {
  overlayAuthorization,
  resolveDirectivePublishGrant,
  resolvedPublishLabel,
  type ResolvedPublishGrant,
} from './run-directive-auth.js';
import {
  authorizationYaml,
  DEFAULT_POLICY_PRESET,
  loadPolicyPreset,
  materializeAuthorization,
  resolvePolicyPresetName,
} from './policy-preset.js';
import { writeFileAtomic } from './atomic.js';
import type { LabProgressListener } from './lab-progress.js';

export class LabRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabRunError';
  }
}

export interface LabRunSummary {
  readonly target: string;
  readonly mode: 'new' | 'resume';
  readonly base: string;
  readonly policy: string;
  readonly providers: string;
  readonly local_write: boolean;
  readonly repair: boolean;
  readonly escalation: boolean;
  readonly publish: string;
  readonly runtime: string;
}

export function formatRunSummary(summary: LabRunSummary): string {
  return [
    `Target: ${summary.target}`,
    `Mode: ${summary.mode}`,
    `Base: ${summary.base}`,
    `Policy: ${summary.policy}`,
    `Providers: ${summary.providers}`,
    `Local write: ${summary.local_write ? 'granted' : 'denied'}`,
    `Repair: ${summary.repair ? 'granted' : 'denied'}`,
    `Escalation: ${summary.escalation ? 'granted' : 'denied'}`,
    `Publish: ${summary.publish}`,
    `Runtime: ${summary.runtime}`,
  ].join('\n');
}

interface SharedLabInput {
  readonly on_progress?: LabProgressListener;
  readonly planner_profile_id?: string;
  readonly max_iterations?: number;
  readonly machine_safety_ceiling_override?: string;
  readonly verbose?: boolean;
  readonly autonomy?: 'routine';
  readonly control_root?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly compile_intake?: IntakeCompilerPort;
  readonly inspect?: (repoRoot: string) => Promise<ProjectInspection>;
  readonly run_project?: typeof runProject;
  readonly on_runtime?: (runtimeDir: string) => void;
  readonly on_summary?: (summary: LabRunSummary) => void;
}

export interface SubmitHumanInstructionInput extends SharedLabInput {
  readonly raw_instruction: string;
  readonly instruction_source: 'stdin' | 'file';
  readonly source_path?: string;
  readonly repo?: string;
  readonly self?: boolean;
  readonly publish?: boolean;
  readonly runtime_dir?: string;
  readonly authorization_file?: string;
  readonly policy_preset?: string;
}

export interface SubmitRunDirectiveInput extends SharedLabInput {
  readonly raw_directive: string;
  readonly instruction_source: 'stdin' | 'file';
  readonly source_path?: string;
  readonly repo?: string;
  readonly self?: boolean;
  readonly publish?: boolean;
  readonly resume_runtime?: string;
  readonly runtime_dir?: string;
  readonly authorization_file?: string;
  readonly policy_preset?: string;
}

export interface ResumeHumanInstructionInput extends SharedLabInput {
  readonly runtime_dir: string;
  readonly publish?: boolean;
}

export interface LabRunResult {
  readonly payload: Record<string, unknown>;
  readonly exitCode: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Payload HUMAN_REQUIRED com opções VERDADEIRAS: a sugestão de conceder pelo
 * header só aparece quando `HUMAN_GATE_GRANT_PATH` (fonte única da política de
 * grantability) declara um caminho de grant para a categoria. Categoria
 * never-grantable jamais recebe uma opção impossível.
 */
function humanRequiredPayload(
  capability: HumanAuthority,
  runtimeDir: string,
  why: string,
): Record<string, unknown> {
  const grantPath = HUMAN_GATE_GRANT_PATH[capability];
  const grantOption =
    grantPath.kind === 'publish'
      ? [
          'se a intenção é publicar no remoto autorizado, conceder authorization.publish (allowed/remote/ref) no header estruturado da Run Directive',
        ]
      : [
          `a categoria ${capability} nunca é concedível por Run Directive; execute a ação manualmente fora do Agent Lab se ela for realmente desejada`,
        ];
  return {
    status: 'HUMAN_REQUIRED',
    // A autoridade que falta, nomeada estruturalmente — e não só embutida em
    // `decision_needed`, que é texto e sozinho nunca provou nada.
    human_authority: capability,
    incident_id: `lab-gate-${capability.toLowerCase()}`,
    decision_needed: capability,
    why_automation_stopped: why,
    options: [
      ...grantOption,
      'remover ou reformular o pedido gated do corpo e rerodar',
      `inspecionar o runtime em ${runtimeDir}`,
    ],
    evidence_paths: [runtimeDir],
    runtime_dir: runtimeDir,
  };
}

async function loadObservabilityIfPresent(file: string): Promise<LabObservability | undefined> {
  if (!(await pathExists(file))) return undefined;
  return JSON.parse(await readFile(file, 'utf8')) as LabObservability;
}

/**
 * Mesma avaliação para NEW e RESUME. Resume não amplia autoridade e não
 * relança provider quando a instrução persistida ainda implica uma categoria
 * never-grantable.
 */
function humanGatedInstructionStop(input: {
  readonly instructionBody: string;
  readonly scope: ExecutionAuthorizationScope;
  readonly publishAllowed: boolean;
  readonly runtimeDir: string;
  readonly artifacts: ReturnType<typeof labArtifactPaths>;
  readonly authorizationFile: string;
  readonly policyPreset: string;
  readonly observability?: LabObservability;
  readonly extra?: Record<string, unknown>;
  readonly onProgress?: LabProgressListener;
}): LabRunResult | null {
  const evaluation = evaluateImpliedHumanGatedIntent({
    instructionBody: input.instructionBody,
    scope: input.scope,
    publishAllowed: input.publishAllowed,
  });
  if (evaluation.outcome !== 'HUMAN_REQUIRED') return null;
  input.onProgress?.({ stage: 'HUMAN_REQUIRED', detail: evaluation.capability });
  return {
    payload: {
      ...humanRequiredPayload(
        evaluation.capability,
        input.runtimeDir,
        `a instrução implica ${evaluation.capability} (evidência: ${JSON.stringify(evaluation.evidence)}); ` +
          'texto livre não autoriza esta categoria e o header estruturado também não a concedeu.',
      ),
      human_instruction: input.artifacts.humanInstruction,
      intake_file: input.artifacts.intake,
      authorization_file: input.authorizationFile,
      policy_preset: input.policyPreset,
      ...(input.observability === undefined ? {} : { observability: input.observability }),
      ...(input.extra ?? {}),
    },
    exitCode: 9,
  };
}

/**
 * Traduz o desfecho do executor em UM evento de progresso terminal do run.
 * `stopped_by` é o mesmo campo que `maybeIntegrateSelf` já consome.
 */
function emitExecutionOutcome(
  onProgress: LabProgressListener | undefined,
  executed: PlanRunResult,
): void {
  if (onProgress === undefined) return;
  const stoppedBy = executed.payload['stopped_by'];
  const status = executed.payload['status'];
  if (stoppedBy === 'ALL_DONE' || status === 'ALL_DONE') {
    onProgress({ stage: 'ALL_DONE' });
    return;
  }
  if (stoppedBy === 'HUMAN_REQUIRED' || status === 'HUMAN_REQUIRED') {
    const reason = executed.payload['reason'];
    onProgress(
      typeof reason === 'string' && reason.length > 0
        ? { stage: 'HUMAN_REQUIRED', detail: reason }
        : { stage: 'HUMAN_REQUIRED' },
    );
    return;
  }
  onProgress({
    stage: 'FAILURE',
    detail: String(stoppedBy ?? status ?? 'desconhecido'),
  });
}

async function requireCleanRepo(repoRoot: string, label: string): Promise<void> {
  if (!(await isWorkingTreeClean(repoRoot))) {
    throw new LabRunError(`${label} precisa estar com working tree limpa: ${repoRoot}`);
  }
}

async function resolveExternalRepo(repo: string | undefined): Promise<string> {
  if (repo === undefined || repo.trim() === '') {
    throw new LabRunError('o alvo externo precisa de um caminho de repositório.');
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
    user_request: humanInstructionBody(instruction),
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
  readonly machineSafetyCeilingOverride?: string;
  readonly verbose?: boolean;
  readonly autonomy?: 'routine';
  readonly onProgress?: LabProgressListener;
  readonly deliberation?: ProjectDeliberationRequest;
  readonly runProjectImpl: typeof runProject;
}): Promise<PlanRunResult> {
  const paths = labHarnessPaths({ repoRoot: input.repoRoot, runtimeDir: input.runtimeDir });
  return input.runProjectImpl({
    paths,
    intake: input.intake,
    authorizationFile: input.authorizationFile,
    maxIterations: input.maxIterations,
    ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
    ...(input.plannerProfileId === undefined ? {} : { plannerProfileId: input.plannerProfileId }),
    ...(input.machineSafetyCeilingOverride === undefined ? {} : { machineSafetyCeilingOverride: input.machineSafetyCeilingOverride }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
    ...(input.deliberation === undefined ? {} : { deliberation: input.deliberation }),
  });
}

/**
 * Deliberação pedida pelo header da Run Directive. Ausência preserva o
 * comportamento anterior verbatim: `max_turns: 0`, nenhum deliberador chamado.
 */
function deliberationRequestOf(
  header: AgentLabRunDirectiveHeader | null,
): ProjectDeliberationRequest {
  const declared = header?.planning?.deliberation;
  return {
    maxTurns: declared?.max_turns ?? 0,
    diversity: declared?.diversity ?? 'cross_provider_preferred',
  };
}

async function maybeIntegrateSelf(input: {
  readonly self: boolean;
  readonly publish: ResolvedPublishGrant;
  readonly controlRoot: string;
  readonly identity: SelfTargetIdentity | null;
  readonly executed: PlanRunResult;
  readonly onProgress?: LabProgressListener;
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
    input.onProgress?.({ stage: 'INTEGRATING', detail: input.identity.self_maintenance_branch });
    const integrated = await integrateSelfMaintenance({
      controlRoot: input.controlRoot,
      identity: input.identity,
    });
    if (!input.publish.allowed) {
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
    if (input.publish.ref !== input.identity.original_ref) {
      throw new LabRunError(
        `publish.ref ${input.publish.ref} não coincide com a ref original ${input.identity.original_ref}.`,
      );
    }
    const pushed = await publishControlRef({
      controlRoot: input.controlRoot,
      ref: input.identity.original_ref,
      remote: input.publish.remote,
    });
    input.onProgress?.({ stage: 'PUBLISHED', detail: `${pushed.remote}/${input.identity.original_ref}` });
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

export function resolveLabTarget(input: {
  readonly header: AgentLabRunDirectiveHeader | null;
  readonly cliRepo?: string;
  readonly cliSelf?: boolean;
}): { readonly type: 'external' | 'self'; readonly repo?: string; readonly self: boolean } {
  const target = input.header?.target;
  const cliSelf = input.cliSelf === true;
  const cliRepo = input.cliRepo?.trim() ? input.cliRepo : undefined;

  if (target === undefined) {
    if (cliSelf) return { type: 'self', self: true };
    if (cliRepo !== undefined) return { type: 'external', repo: cliRepo, self: false };
    throw new LabRunError(
      'o alvo precisa estar na Run Directive (target.type) ou, na interface avançada, em --repo/--self.',
    );
  }

  if (target.type === 'self') {
    if (cliRepo !== undefined) {
      throw new LabRunError(
        'conflito de alvo: a Run Directive pede target.type=self e a CLI passou --repo. Não há precedência silenciosa.',
      );
    }
    return { type: 'self', self: true };
  }

  if (cliSelf) {
    throw new LabRunError(
      'conflito de alvo: a Run Directive pede um repositório externo e a CLI passou --self. Não há precedência silenciosa.',
    );
  }
  if (cliRepo !== undefined && path.resolve(cliRepo) !== path.resolve(target.path)) {
    throw new LabRunError(
      `conflito de alvo: a Run Directive pede ${path.resolve(target.path)} e a CLI passou ${path.resolve(cliRepo)}. Não há precedência silenciosa.`,
    );
  }
  return { type: 'external', repo: target.path, self: false };
}

function executionModeOf(header: AgentLabRunDirectiveHeader | null): 'new' | 'resume' {
  return header?.execution?.mode === 'resume' ? 'resume' : 'new';
}

function resolveResumeRuntime(input: {
  readonly header: AgentLabRunDirectiveHeader | null;
  readonly resumeRuntime?: string;
  readonly runtimeDir?: string;
}): string {
  const fromHeader = input.header?.execution?.runtime;
  const fromCli = input.resumeRuntime ?? input.runtimeDir;
  if (fromHeader !== undefined && fromCli !== undefined && path.resolve(fromHeader) !== path.resolve(fromCli)) {
    throw new LabRunError(
      `conflito de runtime: a Run Directive pede ${path.resolve(fromHeader)} e a CLI passou ${path.resolve(fromCli)}.`,
    );
  }
  const runtime = fromHeader ?? fromCli;
  if (runtime === undefined || runtime.trim() === '') {
    throw new LabRunError('execution.mode=resume exige execution.runtime ou `pnpm lab resume RUNTIME`.');
  }
  return path.resolve(runtime);
}

function sharedResumeInput(
  input: SharedLabInput & { readonly publish?: boolean },
  runtimeDir: string,
): ResumeHumanInstructionInput {
  return {
    runtime_dir: runtimeDir,
    ...(input.on_progress === undefined ? {} : { on_progress: input.on_progress }),
    ...(input.publish === undefined ? {} : { publish: input.publish }),
    ...(input.planner_profile_id === undefined ? {} : { planner_profile_id: input.planner_profile_id }),
    ...(input.max_iterations === undefined ? {} : { max_iterations: input.max_iterations }),
    ...(input.machine_safety_ceiling_override === undefined ? {} : { machine_safety_ceiling_override: input.machine_safety_ceiling_override }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
    ...(input.control_root === undefined ? {} : { control_root: input.control_root }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.run_project === undefined ? {} : { run_project: input.run_project }),
    ...(input.on_runtime === undefined ? {} : { on_runtime: input.on_runtime }),
    ...(input.on_summary === undefined ? {} : { on_summary: input.on_summary }),
  };
}

/**
 * Porta de produto transport-neutral: uma Run Directive crua.
 * O adapter (CLI) só lê terminal e chama isto.
 */
export async function submitRunDirective(input: SubmitRunDirectiveInput): Promise<LabRunResult> {
  let parsed: ParsedRunDirective;
  try {
    parsed = parseRunDirective(input.raw_directive);
  } catch (error) {
    if (error instanceof RunDirectiveError) throw error;
    throw error;
  }

  if (executionModeOf(parsed.header) === 'resume') {
    const runtimeDir = resolveResumeRuntime({
      header: parsed.header,
      ...(input.resume_runtime === undefined ? {} : { resumeRuntime: input.resume_runtime }),
      ...(input.runtime_dir === undefined ? {} : { runtimeDir: input.runtime_dir }),
    });
    const artifacts = labArtifactPaths(runtimeDir);
    if (await pathExists(artifacts.runDirective)) {
      const persisted = await loadPersistedRunDirective(artifacts.runDirective);
      if (parsed.hash !== runDirectiveHash(persisted)) {
        throw new LabRunError(
          `a Run Directive colada não coincide com a autoridade persistida em ${artifacts.runDirective}. Resume não substitui a autoridade original.`,
        );
      }
    }
    return resumeHumanInstruction(sharedResumeInput(input, runtimeDir));
  }

  const target = resolveLabTarget({
    header: parsed.header,
    ...(input.repo === undefined ? {} : { cliRepo: input.repo }),
    ...(input.self === undefined ? {} : { cliSelf: input.self }),
  });

  const preset = input.policy_preset ?? parsed.header?.authorization?.preset;
  return submitHumanInstruction({
    raw_instruction: parsed.raw,
    ...(parsed.header === null ? {} : { instruction_body: parsed.body }),
    instruction_source: input.instruction_source,
    ...(input.source_path === undefined ? {} : { source_path: input.source_path }),
    ...(target.repo === undefined ? {} : { repo: target.repo }),
    self: target.self,
    ...(input.publish === undefined ? {} : { publish: input.publish }),
    ...(input.runtime_dir === undefined ? {} : { runtime_dir: input.runtime_dir }),
    ...(input.authorization_file === undefined ? {} : { authorization_file: input.authorization_file }),
    ...(preset === undefined ? {} : { policy_preset: preset }),
    ...(input.planner_profile_id === undefined ? {} : { planner_profile_id: input.planner_profile_id }),
    ...(input.max_iterations === undefined ? {} : { max_iterations: input.max_iterations }),
    ...(input.machine_safety_ceiling_override === undefined ? {} : { machine_safety_ceiling_override: input.machine_safety_ceiling_override }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(parsed.header?.execution?.autonomy === 'routine' || input.autonomy === 'routine'
      ? { autonomy: 'routine' }
      : {}),
    ...(input.control_root === undefined ? {} : { control_root: input.control_root }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.compile_intake === undefined ? {} : { compile_intake: input.compile_intake }),
    ...(input.inspect === undefined ? {} : { inspect: input.inspect }),
    ...(input.run_project === undefined ? {} : { run_project: input.run_project }),
    ...(input.on_runtime === undefined ? {} : { on_runtime: input.on_runtime }),
    ...(input.on_summary === undefined ? {} : { on_summary: input.on_summary }),
    ...(input.on_progress === undefined ? {} : { on_progress: input.on_progress }),
    directive: parsed,
  });
}

/**
 * Porta de aplicação transport-neutral. CLI e um futuro MCP chamam isto;
 * stdin/console/argv ficam no adapter.
 */
export async function submitHumanInstruction(
  input: SubmitHumanInstructionInput & {
    readonly instruction_body?: string;
    readonly directive?: ParsedRunDirective;
  },
): Promise<LabRunResult> {
  const raw = input.raw_instruction.trim();
  if (raw.length === 0) throw new LabRunError('a instrução humana está vazia.');

  const onProgress = input.on_progress;
  onProgress?.({ stage: 'PREFLIGHT' });
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
        'o repositório alvo é o próprio Agent Lab. Use target.type=self ou --self para self-maintenance isolada.',
      );
    }
  }

  await requireCleanRepo(selfRequested ? controlRoot : repoRoot, selfRequested ? 'control repo' : 'repositório alvo');
  const baseSha = await headSha(repoRoot);
  const instruction = createHumanInstruction({
    raw_instruction: raw,
    ...(input.instruction_body === undefined ? {} : { instruction_body: input.instruction_body }),
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
    return resumeHumanInstruction(sharedResumeInput(input, runtimeDir));
  }

  const directive = input.directive ?? parseRunDirective(input.raw_instruction);
  await persistRunDirective(artifacts.runDirective, directive.raw);
  if (directive.header !== null) {
    await persistRunDirectiveHeader(artifacts.runDirectiveHeader, directive.header);
  }
  await persistHumanInstruction(artifacts.humanInstruction, instruction);
  const publishGrant = resolveDirectivePublishGrant({
    header: directive.header,
    ...(input.publish === undefined ? {} : { cliPublish: input.publish }),
  });
  await persistPublishGrant(artifacts.publishGrant, publishGrant);

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
  onProgress?.({ stage: 'TARGET_READY', detail: targetType === 'self' ? 'self' : repoRoot });

  const inspect = input.inspect ?? ((root: string) => inspectRepository({ repoRoot: root }));
  const inspection = await inspect(repoRoot);
  const compiler = input.compile_intake ?? deterministicIntakeCompiler;
  const fields = await compiler.compile({ instruction, inspection });
  const intake = assembleIntake(instruction, repoRoot, fields);
  await persistProjectIntake(artifacts.intake, stringifyYaml(intake));

  const headerPreset = directive.header?.authorization?.preset;
  const presetName =
    input.authorization_file === undefined
      ? resolvePolicyPresetName({
          requested: input.policy_preset ?? headerPreset,
          env,
        })
      : 'authorization-file';
  const authorizationFile = artifacts.authorization;
  if (input.authorization_file !== undefined) {
    const loaded = await loadAuthorizationSnapshot(input.authorization_file);
    const snapshot = materializeAuthorization({
      preset: overlayAuthorization({ preset: loaded.file, header: directive.header }),
      requested_scope: intake.requested_scope,
    });
    await writeFileAtomic(authorizationFile, authorizationYaml(snapshot));
  } else {
    const loaded = await loadPolicyPreset(presetName, path.join(controlRoot, 'dev', 'presets'));
    const snapshot = materializeAuthorization({
      preset: overlayAuthorization({ preset: loaded.file, header: directive.header }),
      requested_scope: intake.requested_scope,
    });
    await writeFileAtomic(authorizationFile, authorizationYaml(snapshot));
  }
  const authorization = await loadAuthorizationSnapshot(authorizationFile);
  onProgress?.({ stage: 'AUTHORIZED', detail: presetName });

  const observability: LabObservability = {
    schema_version: 1,
    instruction_source: input.instruction_source,
    instruction_sha256: instruction.instruction_hash,
    run_directive_sha256: directive.hash,
    directive_format: directive.header === null ? 'legacy' : 'agentlab-v1',
    target_type: targetType,
    controller_sha: await headSha(controlRoot),
    intake_compiler_profile: DETERMINISTIC_INTAKE_COMPILER_PROFILE,
    planner_profile: input.planner_profile_id ?? authorization.file.profile_policy.profiles[0]?.id ?? 'unknown',
    policy_preset: presetName,
  };
  await persistObservability(artifacts.observability, observability);

  input.on_summary?.({
    target: targetType === 'self' ? 'self' : repoRoot,
    mode: 'new',
    base: baseSha,
    policy: presetName,
    providers: directive.header?.providers?.policy ?? 'default',
    local_write: authorization.file.autonomous_execution_boundary.includes('DISPOSABLE_LOCAL_WORKSPACE'),
    repair: authorization.file.autonomous_execution_boundary.includes('BOUNDED_REPAIR'),
    escalation: authorization.file.autonomous_execution_boundary.includes('CAPABILITY_ESCALATION_WITHIN_LADDER'),
    publish: resolvedPublishLabel(publishGrant),
    runtime: runtimeDir,
  });

  const gated = humanGatedInstructionStop({
    instructionBody: humanInstructionBody(instruction),
    scope: executionScopeFromAuthorization({
      requested_scope: intake.requested_scope,
      autonomous_execution_boundary: authorization.file.autonomous_execution_boundary,
      human_gated_capabilities: authorization.file.human_gated_capabilities,
    }),
    publishAllowed: publishGrant.allowed,
    runtimeDir,
    artifacts,
    authorizationFile,
    policyPreset: presetName,
    observability,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  if (gated !== null) return gated;

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
    deliberation: deliberationRequestOf(directive.header),
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(input.planner_profile_id === undefined ? {} : { plannerProfileId: input.planner_profile_id }),
    ...(input.machine_safety_ceiling_override === undefined ? {} : { machineSafetyCeilingOverride: input.machine_safety_ceiling_override }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
  });
  emitExecutionOutcome(onProgress, executed);

  const selfReport = await maybeIntegrateSelf({
    self: targetType === 'self',
    publish: publishGrant,
    controlRoot,
    identity: selfIdentity,
    executed,
    ...(onProgress === undefined ? {} : { onProgress }),
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
  const onProgress = input.on_progress;
  onProgress?.({ stage: 'PREFLIGHT', detail: 'resume' });
  const runtimeDir = path.resolve(input.runtime_dir);
  input.on_runtime?.(runtimeDir);
  const artifacts = labArtifactPaths(runtimeDir);
  if (!(await pathExists(artifacts.humanInstruction))) {
    throw new LabRunError(`runtime sem HumanInstruction persistida: ${artifacts.humanInstruction}`);
  }
  const instruction = await loadHumanInstruction(artifacts.humanInstruction);
  const intake = await loadPersistedIntake(artifacts.intake);
  if (intake.user_request !== humanInstructionBody(instruction)) {
    throw new LabRunError(
      'intake persistido diverge da instrução humana raw. O planner não será chamado.',
    );
  }
  const authorization = await loadAuthorizationSnapshot(artifacts.authorization);
  const persistedGrant = await loadPublishGrant(artifacts.publishGrant);
  const publishGrant =
    persistedGrant ??
    resolveDirectivePublishGrant({
      header: null,
      ...(input.publish === undefined ? {} : { cliPublish: input.publish }),
    });
  if (input.publish === true && persistedGrant?.allowed === false) {
    throw new LabRunError(
      'conflito: --publish tenta conceder publicação e a Run Directive persistida a nega.',
    );
  }

  const observability = await loadObservabilityIfPresent(artifacts.observability);
  const gated = humanGatedInstructionStop({
    instructionBody: humanInstructionBody(instruction),
    scope: executionScopeFromAuthorization({
      requested_scope: intake.requested_scope,
      autonomous_execution_boundary: authorization.file.autonomous_execution_boundary,
      human_gated_capabilities: authorization.file.human_gated_capabilities,
    }),
    // Resume nunca amplia autoridade: só o grant persistido satisfaz publish.
    publishAllowed: persistedGrant?.allowed === true,
    runtimeDir,
    artifacts,
    authorizationFile: artifacts.authorization,
    policyPreset: authorization.file.profile_policy.id,
    extra: { resumed: true },
    ...(observability === undefined ? {} : { observability }),
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  if (gated !== null) return gated;

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
  onProgress?.({
    stage: 'TARGET_READY',
    detail: instruction.target.type === 'self' ? 'self' : repoRoot,
  });

  input.on_summary?.({
    target: instruction.target.type === 'self' ? 'self' : repoRoot,
    mode: 'resume',
    base: instruction.base_sha,
    policy: authorization.file.profile_policy.id,
    providers: 'default',
    local_write: authorization.file.autonomous_execution_boundary.includes('DISPOSABLE_LOCAL_WORKSPACE'),
    repair: authorization.file.autonomous_execution_boundary.includes('BOUNDED_REPAIR'),
    escalation: authorization.file.autonomous_execution_boundary.includes('CAPABILITY_ESCALATION_WITHIN_LADDER'),
    publish: resolvedPublishLabel(input.publish === true && persistedGrant === null ? { ...publishGrant, allowed: true } : publishGrant),
    runtime: runtimeDir,
  });

  const executed = await executeProject({
    repoRoot,
    runtimeDir,
    intake,
    authorizationFile: artifacts.authorization,
    maxIterations: input.max_iterations ?? 100,
    runProjectImpl: input.run_project ?? runProject,
    ...(onProgress === undefined ? {} : { onProgress }),
    ...(input.planner_profile_id === undefined ? {} : { plannerProfileId: input.planner_profile_id }),
    ...(input.machine_safety_ceiling_override === undefined ? {} : { machineSafetyCeilingOverride: input.machine_safety_ceiling_override }),
    ...(input.verbose === undefined ? {} : { verbose: input.verbose }),
    ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
  });
  emitExecutionOutcome(onProgress, executed);
  const effectivePublish =
    persistedGrant ??
    (input.publish === true ? { allowed: true, remote: 'origin', ref: 'main' } : publishGrant);
  const selfReport = await maybeIntegrateSelf({
    self: instruction.target.type === 'self',
    publish: effectivePublish,
    controlRoot,
    identity: selfIdentity,
    executed,
    ...(onProgress === undefined ? {} : { onProgress }),
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

export async function authorizeAdditionalRepairForRuntime(input: {
  readonly runtime_dir: string;
  readonly task_id: string;
  readonly reason: string;
}): Promise<{
  readonly runtime_dir: string;
  readonly task_id: string;
  readonly grant_sha256: string;
  readonly grant_path: string;
  readonly additional_attempts: 1;
}> {
  const runtimeDir = path.resolve(input.runtime_dir);
  const artifacts = labArtifactPaths(runtimeDir);
  if (!(await pathExists(artifacts.humanInstruction))) {
    throw new LabRunError(`runtime sem HumanInstruction persistida: ${artifacts.humanInstruction}`);
  }
  if (input.task_id.trim() === '') {
    throw new LabRunError('--task é obrigatório');
  }
  if (input.reason.trim() === '') {
    throw new LabRunError('--reason é obrigatório');
  }
  const instruction = await loadHumanInstruction(artifacts.humanInstruction);
  const repoRoot = path.resolve(instruction.target.identity);
  const paths = labHarnessPaths({ repoRoot, runtimeDir });
  const granted = await withHarnessLock(paths, 'lab-authorize-repair', () =>
    grantAdditionalRepairAuthorization({
      paths,
      taskId: input.task_id,
      reason: input.reason,
    }),
  );
  return {
    runtime_dir: runtimeDir,
    task_id: input.task_id,
    grant_sha256: granted.sha256,
    grant_path: granted.path,
    additional_attempts: 1,
  };
}

export async function authorizeProviderExpansionForRuntime(input: {
  readonly runtime_dir: string;
  readonly reason: string;
}): Promise<{
  readonly runtime_dir: string;
  readonly grant_sha256: string;
  readonly grant_path: string;
  readonly added_providers: readonly string[];
  readonly added_profile_ids: readonly string[];
  readonly exhausted_pools: readonly string[];
}> {
  const runtimeDir = path.resolve(input.runtime_dir);
  const artifacts = labArtifactPaths(runtimeDir);
  if (!(await pathExists(artifacts.humanInstruction))) {
    throw new LabRunError(`runtime sem HumanInstruction persistida: ${artifacts.humanInstruction}`);
  }
  if (input.reason.trim() === '') {
    throw new LabRunError('--reason é obrigatório');
  }
  const instruction = await loadHumanInstruction(artifacts.humanInstruction);
  const repoRoot = path.resolve(instruction.target.identity);
  const paths = labHarnessPaths({ repoRoot, runtimeDir });
  const original = await loadAuthorizationSnapshot(artifacts.authorization);
  const probe = createProductionPoolCapacityProbe({ paths });
  const authorizedProfiles = [];
  for (const entry of original.file.profile_policy.profiles) {
    authorizedProfiles.push(await loadProfileFromCatalog(paths.profileCatalogRoot, entry.id));
  }
  const fresh = await observeEligiblePoolCapacities(authorizedProfiles, probe);
  const exhaustedPools = [...fresh.entries()]
    .filter(([, observation]) => observation.status === CapacityStatus.EXHAUSTED)
    .map(([pool]) => pool);
  const granted = await withHarnessLock(paths, 'lab-authorize-provider-expansion', () =>
    grantProviderExpansionAuthorization({
      paths,
      catalogRoot: paths.profileCatalogRoot,
      original,
      reason: input.reason,
      exhaustedPools,
    }),
  );
  return {
    runtime_dir: runtimeDir,
    grant_sha256: granted.sha256,
    grant_path: granted.path,
    added_providers: granted.record.added_providers,
    added_profile_ids: granted.record.added_profiles.map((entry) => entry.id),
    exhausted_pools: granted.record.exhausted_pools,
  };
}

export { DEFAULT_POLICY_PRESET };
export { PlanSetupError };
export { RunDirectiveError };
