import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertNoApiCredentials, runBillingPreflight } from './billing.js';
import { buildTimeoutArgv, runValidation, toValidationResult } from './exec.js';
import {
  changedFiles,
  git,
  gitOrThrow,
  headSha,
  isWorkingTreeClean,
  parentShas,
} from './git.js';
import { adoptMaintenance, adoptionValidationCommands } from './maintenance.js';
import { runOrchestrationPreflight } from './orchestrate-preflight.js';
import type { HarnessPaths } from './paths.js';
import type { LoadedPlan } from './plan.js';
import { recoverInfraAttempt } from './infra-recover.js';
import {
  assertNoForbiddenFlags,
  buildEnvironment,
  loadProfile,
  type LauncherProfile,
} from './profile.js';
import { recover } from './recover.js';
import { recoverProtocolOutput } from './protocol-output-recovery.js';
import type {
  RoutineAutonomyDriver,
  RoutineCandidate,
  RoutineIncidentContext,
  RoutinePostLaunchDriver,
  RoutineReview,
} from './routine-autonomy.js';
import type { ValidationResult } from './schemas.js';
import { createDisposableClone, type DisposableClone } from '../../src/workspace/clone.js';
import { disposeClone } from '../../src/workspace/cleanup.js';

export const DEFAULT_ROUTINE_MAINTAINER_PROFILE =
  'claude-build-worker-subscription-sonnet5-medium-v3';
export const DEFAULT_ROUTINE_REVIEWER_PROFILE = 'codex-build-worker-subscription-terra-high-v2';

const SESSION_INSTALL_TIMEOUT_SECONDS = 3_600;

export interface RoutineRuntimeClone {
  readonly clonePath: string;
  readonly sourceRepo: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly gitDir?: string;
}

export interface RoutineRuntimeAgentInput {
  readonly actionId: string;
  readonly role: 'maintainer' | 'reviewer';
  readonly profileId: string;
  readonly clone: RoutineRuntimeClone;
  readonly prompt: string;
  readonly readOnly: boolean;
}

export interface RoutineTaskActivity {
  readonly attempts: number;
  readonly launch_evidence: string;
}

interface CandidateInspection {
  readonly sha: string;
  readonly parent_sha: string;
  readonly commit_count: number;
  readonly changed_files: readonly string[];
  readonly diff: string;
  readonly working_tree_clean: boolean;
  readonly diff_check_clean: boolean;
}

export interface RoutineRuntimePort {
  createClone(sourceRepo: string, baseSha: string, actionId: string): Promise<RoutineRuntimeClone>;
  disposeClone(clone: RoutineRuntimeClone): Promise<void>;
  prepareClone(clone: RoutineRuntimeClone): Promise<void>;
  observeTaskActivity(clone: RoutineRuntimeClone): Promise<RoutineTaskActivity>;
  runAgent(input: RoutineRuntimeAgentInput): Promise<string>;
  inspectCandidate(clone: RoutineRuntimeClone, baseSha: string): Promise<CandidateInspection>;
  assertReviewerReadOnly(clone: RoutineRuntimeClone, candidateSha: string): Promise<void>;
  runValidation(argv: readonly string[], cwd: string): Promise<ValidationResult>;
  publishAndFastForward(
    clone: RoutineRuntimeClone,
    baseSha: string,
    candidateSha: string,
  ): Promise<void>;
  adoptOfficial(candidateSha: string): Promise<string>;
  applyRecovery(): Promise<void>;
  runPreflight(): ReturnType<typeof runOrchestrationPreflight>;
}

export interface RoutineAutonomyRuntimeOptions {
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly requestedProfileId: string;
  readonly maintainerProfile?: string;
  readonly reviewerProfile?: string;
  readonly port?: RoutineRuntimePort;
}

export interface RoutinePostLaunchRuntimePort {
  recoverProtocolOutput: typeof recoverProtocolOutput;
  recoverInfraAttempt: typeof recoverInfraAttempt;
}

export interface RoutinePostLaunchRuntimeOptions {
  readonly paths: HarnessPaths;
  readonly port?: RoutinePostLaunchRuntimePort;
}

export function createRoutinePostLaunchRuntime(
  options: RoutinePostLaunchRuntimeOptions,
): RoutinePostLaunchDriver {
  const port: RoutinePostLaunchRuntimePort = options.port ?? {
    recoverProtocolOutput,
    recoverInfraAttempt,
  };
  return {
    async recoverProtocolOutput(_actionId, incident) {
      await port.recoverProtocolOutput({
        paths: options.paths,
        taskId: incident.task_id,
        reason: `routine recipe protocol-output-recovery: ${incident.reason}`,
      });
      return { action: 'dev-recover-protocol-output' };
    },
    async recoverInfra(_actionId, incident) {
      await port.recoverInfraAttempt({
        paths: options.paths,
        taskId: incident.task_id,
        reason: `routine recipe provider-infra-retry: ${incident.reason}`,
      });
      return { action: 'dev-recover-infra' };
    },
  };
}

function targetedCommands(incident: RoutineIncidentContext): readonly (readonly string[])[] {
  if (
    incident.preflight.blocker === 'HISTORICAL_GAP' &&
    incident.lifecycle_records.length === 1 &&
    incident.lifecycle_records[0] === 'ProtocolInvalidAttemptRecord'
  ) {
    return [
      [
        'pnpm',
        'vitest',
        'run',
        'test/dev/automatic-repair-policy.test.ts',
        'test/dev/retry-failed.test.ts',
      ],
    ];
  }
  return [['pnpm', 'vitest', 'run', 'test/dev/orchestrate-preflight.test.ts']];
}

function incidentPacket(incident: RoutineIncidentContext): string {
  return JSON.stringify(
    {
      blocker: incident.preflight.blocker,
      reason: incident.preflight.reason,
      task_id: incident.task_id,
      attempt: incident.attempt,
      authorized_head: incident.authorized_head_before,
      lifecycle_records: incident.lifecycle_records,
    },
    null,
    2,
  );
}

function maintainerPrompt(incident: RoutineIncidentContext, cycle: number): string {
  return `Você é o MAINTAINER bounded do development harness.\n\nINCIDENT PACKET\n${incidentPacket(incident)}\n\n` +
    `Ciclo ${cycle + 1} de no máximo 2. Corrija somente a causa mecânica do harness.\n` +
    'Fronteiras: não toque src/**, dev/plan.yaml, billing, profiles/model/effort, schema_version, .dev/** ou evidência histórica.\n' +
    'Toque somente dev/**, test/dev/** e docs; no máximo 8 arquivos de implementação/teste.\n' +
    'Não execute provider/task, não altere requisitos e não adote/push a própria manutenção.\n' +
    'Adicione regressão direcionada, execute somente testes focados e produza exatamente um commit filho do HEAD atual.\n' +
    'Mensagem do commit: feat(harness): add bounded routine autonomy recovery\n';
}

function reviewerPrompt(incident: RoutineIncidentContext, candidate: RoutineCandidate): string {
  return `Você é o REVIEWER independente e somente leitura. NÃO edite, não faça commit e não execute provider/task.\n\n` +
    `INCIDENT\n${incidentPacket(incident)}\n\nCANDIDATE SHA: ${candidate.sha}\n` +
    `CHANGED FILES:\n${candidate.changed_files.join('\n')}\n\nDIFF:\n${candidate.diff}\n\n` +
    'Verifique causa raiz, allowlist, guardas fail-closed, regressão, gates, idempotência/crash-safety.\n' +
    'Responda somente JSON: {"decision":"ACCEPT|REJECT|HUMAN_REQUIRED","reason":"..."}.\n';
}

function reviewFromUnknown(value: unknown): RoutineReview | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const decision = record['decision'];
  const reason = record['reason'];
  if (
    (decision === 'ACCEPT' || decision === 'REJECT' || decision === 'HUMAN_REQUIRED') &&
    typeof reason === 'string' &&
    reason.trim() !== ''
  ) {
    return { decision, reason: reason.trim() };
  }
  return null;
}

function parseJsonReview(text: string): RoutineReview | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const direct = reviewFromUnknown(parsed);
    if (direct) return direct;
    if (parsed && typeof parsed === 'object') {
      const result = (parsed as Record<string, unknown>)['result'];
      if (typeof result === 'string') return parseJsonReview(result);
      const item = (parsed as Record<string, unknown>)['item'];
      if (item && typeof item === 'object') {
        const message = item as Record<string, unknown>;
        if (message['type'] === 'agent_message' && typeof message['text'] === 'string') {
          return parseJsonReview(message['text']);
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}

function assertRoutineRoleProfile(profile: LauncherProfile, role: RoutineRuntimeAgentInput['role']): void {
  const expected = role === 'maintainer'
    ? DEFAULT_ROUTINE_MAINTAINER_PROFILE
    : DEFAULT_ROUTINE_REVIEWER_PROFILE;
  const expectedAgent = role === 'maintainer' ? 'claude' : 'codex';
  if (
    profile.id !== expected ||
    profile.agent !== expectedAgent ||
    profile.billing_mode !== 'subscription_only' ||
    profile.commit_owner !== 'orchestrator' ||
    profile.official_validation_owner !== 'orchestrator' ||
    profile.worker_validation_policy !== 'targeted'
  ) {
    throw new Error(`${role} precisa usar o profile subscription-only aprovado ${expected}`);
  }
}

export function buildRoutineAgentArgv(
  profile: LauncherProfile,
  input: Pick<RoutineRuntimeAgentInput, 'prompt' | 'readOnly' | 'role'>,
): string[] {
  assertRoutineRoleProfile(profile, input.role);
  if (input.role === 'reviewer' && !input.readOnly) {
    throw new Error('reviewer precisa de sandbox read-only');
  }
  const argv = profile.prompt_delivery === 'argv'
    ? [...profile.argv, input.prompt]
    : [...profile.argv];
  if (input.readOnly) {
    const sandboxIndexes = argv.flatMap((token, index) => token === '--sandbox' ? [index] : []);
    const sandboxIndex = sandboxIndexes[0];
    if (
      profile.agent !== 'codex' ||
      sandboxIndexes.length !== 1 ||
      sandboxIndex === undefined ||
      argv[sandboxIndex + 1] !== 'workspace-write'
    ) {
      throw new Error('reviewer não possui sandbox Codex único convertível para read-only');
    }
    argv[sandboxIndex + 1] = 'read-only';
  }
  assertNoForbiddenFlags(profile, argv);
  return argv;
}

export function parseRoutineReview(stdout: string): RoutineReview {
  const candidates: RoutineReview[] = [];
  const direct = parseJsonReview(stdout.trim());
  if (direct) candidates.push(direct);
  for (const line of stdout.split(/\r?\n/)) {
    const parsed = parseJsonReview(line.trim());
    if (parsed) candidates.push(parsed);
  }
  const fenced = stdout.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (fenced?.[1]) {
    const parsed = parseJsonReview(fenced[1]);
    if (parsed) candidates.push(parsed);
  }
  const unique = new Map(candidates.map((candidate) => [`${candidate.decision}\0${candidate.reason}`, candidate]));
  if (unique.size !== 1) {
    throw new Error('reviewer não produziu uma decisão JSON única e inequívoca');
  }
  return [...unique.values()][0] as RoutineReview;
}

async function runAgentProcess(
  paths: HarnessPaths,
  profile: LauncherProfile,
  input: RoutineRuntimeAgentInput,
): Promise<string> {
  const home = path.join(paths.devDir, 'autonomy', 'homes', input.actionId, profile.id);
  await mkdir(home, { recursive: true });
  const env = buildEnvironment(profile, process.env, { sanitizedHome: home });
  assertNoApiCredentials(`ambiente do ${input.role}`, env);
  const billing = await runBillingPreflight({
    agent: profile.agent,
    billingMode: profile.billing_mode,
    binary: profile.argv[0] as string,
    env,
    orchestratorEnv: process.env,
  });
  if (!billing.ok) throw new Error(billing.refusal ?? 'billing preflight recusou a sessão');
  const agentArgv = buildRoutineAgentArgv(profile, input);
  const [program, ...args] = buildTimeoutArgv(agentArgv, profile.timeout_seconds);
  return new Promise((resolve, reject) => {
    const child = spawn(program as string, args, {
      cwd: input.clone.clonePath,
      env,
      stdio: [profile.prompt_delivery === 'stdin' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `${input.role} terminou com exit ${code}: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    if (profile.prompt_delivery === 'stdin') child.stdin?.end(input.prompt, 'utf8');
  });
}

function asDisposable(clone: RoutineRuntimeClone): DisposableClone {
  if (!clone.gitDir) throw new Error(`clone sem gitDir verificável: ${clone.clonePath}`);
  return { ...clone, gitDir: clone.gitDir };
}

function workspaceOf(clone: RoutineRuntimeClone): NonNullable<RoutineCandidate['workspace']> {
  return {
    clone_path: clone.clonePath,
    source_repo: clone.sourceRepo,
    base_sha: clone.baseSha,
    branch: clone.branch,
    ...(clone.gitDir === undefined ? {} : { git_dir: clone.gitDir }),
  };
}

function cloneOf(candidate: RoutineCandidate): RoutineRuntimeClone | null {
  const workspace = candidate.workspace;
  if (!workspace) return null;
  return {
    clonePath: workspace.clone_path,
    sourceRepo: workspace.source_repo,
    baseSha: workspace.base_sha,
    branch: workspace.branch,
    ...(workspace.git_dir === undefined ? {} : { gitDir: workspace.git_dir }),
  };
}

async function optionalText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

async function launchEvidence(logsDir: string): Promise<string> {
  let names: string[];
  try {
    names = (await readdir(logsDir)).filter((name) => name.endsWith('.launch.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  return (await Promise.all(names.map(async (name) => `${name}\0${await readFile(path.join(logsDir, name), 'utf8')}`))).join('\0');
}

async function taskActivity(paths: Pick<HarnessPaths, 'stateFile' | 'logsDir'>): Promise<RoutineTaskActivity> {
  const stateText = await optionalText(paths.stateFile);
  let attempts = 0;
  if (stateText !== '') {
    const parsed = JSON.parse(stateText) as { readonly tasks?: readonly { readonly attempts?: unknown }[] };
    attempts = (parsed.tasks ?? []).reduce(
      (total, task) => total + (typeof task.attempts === 'number' ? task.attempts : 0),
      0,
    );
  }
  return {
    attempts,
    launch_evidence: `${stateText}\0${await launchEvidence(paths.logsDir)}`,
  };
}

function activityDelta(before: RoutineTaskActivity, after: RoutineTaskActivity) {
  return {
    task_provider_launches: before.launch_evidence === after.launch_evidence ? 0 : 1,
    task_attempts_delta: after.attempts - before.attempts,
  };
}

function createProductionPort(options: RoutineAutonomyRuntimeOptions): RoutineRuntimePort {
  const { paths, loaded, requestedProfileId } = options;
  return {
    async createClone(sourceRepo, baseSha) {
      return createDisposableClone({ sourceRepo, baseSha });
    },
    async disposeClone(clone) {
      await disposeClone(asDisposable(clone));
    },
    async prepareClone(clone) {
      const outcome = await runValidation(
        {
          argv: ['pnpm', 'install', '--frozen-lockfile'],
          timeout_seconds: SESSION_INSTALL_TIMEOUT_SECONDS,
        },
        { cwd: clone.clonePath },
      );
      if (outcome.exit_code !== 0 || outcome.timed_out) {
        throw new Error(`pnpm install falhou no clone (exit ${outcome.exit_code})`);
      }
    },
    async observeTaskActivity(clone) {
      const original = await taskActivity(paths);
      const cloneDevDir = path.join(clone.clonePath, '.dev');
      const cloneActivity = await taskActivity({
        stateFile: path.join(cloneDevDir, 'state.json'),
        logsDir: path.join(cloneDevDir, 'logs'),
      });
      return {
        attempts: original.attempts + cloneActivity.attempts,
        launch_evidence: `${original.launch_evidence}\0${cloneActivity.launch_evidence}`,
      };
    },
    async runAgent(input) {
      const profile = await loadProfile(paths.repoRoot, input.profileId);
      return runAgentProcess(paths, profile, input);
    },
    async inspectCandidate(clone, baseSha) {
      const sha = await headSha(clone.clonePath);
      const parents = await parentShas(clone.clonePath, sha);
      const count = Number((await gitOrThrow(clone.clonePath, ['rev-list', '--count', `${baseSha}..${sha}`])).trim());
      const check = await git(clone.clonePath, ['diff', '--check', `${baseSha}..${sha}`]);
      return {
        sha,
        parent_sha: parents[0] ?? '',
        commit_count: count,
        changed_files: await changedFiles(clone.clonePath, sha),
        diff: await gitOrThrow(clone.clonePath, ['diff', '--no-renames', '--binary', `${baseSha}..${sha}`]),
        working_tree_clean: await isWorkingTreeClean(clone.clonePath),
        diff_check_clean: check.exitCode === 0,
      };
    },
    async assertReviewerReadOnly(clone, candidateSha) {
      if ((await headSha(clone.clonePath)) !== candidateSha || !(await isWorkingTreeClean(clone.clonePath))) {
        throw new Error('reviewer alterou HEAD ou working tree');
      }
    },
    async runValidation(argv, cwd) {
      return toValidationResult(
        await runValidation({ argv: [...argv], timeout_seconds: 3_600 }, { cwd }),
      );
    },
    async publishAndFastForward(clone, baseSha, candidateSha) {
      if ((await headSha(paths.repoRoot)) !== baseSha || !(await isWorkingTreeClean(paths.repoRoot))) {
        throw new Error('checkout original divergiu antes da publicação');
      }
      const branch = (await gitOrThrow(paths.repoRoot, ['symbolic-ref', '--short', 'HEAD'])).trim();
      const remoteLine = (
        await gitOrThrow(paths.repoRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
      ).trim();
      const remoteSha = remoteLine.split(/\s+/)[0] ?? '';
      if (remoteSha !== baseSha) throw new Error(`origin/${branch} divergiu do authorized head`);
      await gitOrThrow(paths.repoRoot, ['fetch', '--no-tags', clone.clonePath, candidateSha]);
      await gitOrThrow(paths.repoRoot, ['push', 'origin', `${candidateSha}:refs/heads/${branch}`]);
      await gitOrThrow(paths.repoRoot, ['merge', '--ff-only', candidateSha]);
    },
    async adoptOfficial(candidateSha) {
      const adopted = await adoptMaintenance({
        paths,
        reason: 'routine autonomy: independently reviewed bounded harness maintenance',
      });
      if (adopted.record.adopted_head_sha !== candidateSha) {
        throw new Error('primitive oficial adotou SHA diferente do candidate');
      }
      return adopted.record.adopted_head_sha;
    },
    async applyRecovery() {
      await recover(paths, loaded, { applyRecovered: true });
    },
    runPreflight() {
      return runOrchestrationPreflight({ paths, loaded, requestedProfileId });
    },
  };
}

export function createRoutineAutonomyRuntime(
  options: RoutineAutonomyRuntimeOptions,
): RoutineAutonomyDriver {
  const port = options.port ?? createProductionPort(options);
  const maintainerProfile = options.maintainerProfile ?? DEFAULT_ROUTINE_MAINTAINER_PROFILE;
  const reviewerProfile = options.reviewerProfile ?? DEFAULT_ROUTINE_REVIEWER_PROFILE;
  if (maintainerProfile === reviewerProfile) {
    throw new Error('maintainer e reviewer precisam de profiles distintos');
  }
  const workspaces = new Map<string, RoutineRuntimeClone>();
  const candidates = new Map<string, RoutineRuntimeClone>();

  return {
    async recover() {
      await port.applyRecovery();
      return { action: 'official recover primitive applied' };
    },
    async maintain(actionId, incident, cycle) {
      const clone = await port.createClone(options.paths.repoRoot, incident.authorized_head_before, actionId);
      workspaces.set(actionId, clone);
      try {
        await port.prepareClone(clone);
        const activityBefore = await port.observeTaskActivity(clone);
        await port.runAgent({
          actionId,
          role: 'maintainer',
          profileId: maintainerProfile,
          clone,
          prompt: maintainerPrompt(incident, cycle),
          readOnly: false,
        });
        const activityAfter = await port.observeTaskActivity(clone);
        const inspected = await port.inspectCandidate(clone, incident.authorized_head_before);
        const targetedResults: ValidationResult[] = [];
        for (const argv of targetedCommands(incident)) {
          targetedResults.push(await port.runValidation(argv, clone.clonePath));
        }
        const fullGateResults: ValidationResult[] = [];
        for (const command of adoptionValidationCommands(incident.authorized_head_before, inspected.sha)) {
          fullGateResults.push(await port.runValidation(command.argv, clone.clonePath));
        }
        const afterGates = await port.inspectCandidate(clone, incident.authorized_head_before);
        if (afterGates.sha !== inspected.sha) {
          throw new Error('gates alteraram o HEAD do candidate');
        }
        const result: RoutineCandidate = {
          ...afterGates,
          targeted_results: targetedResults,
          full_gate_results: fullGateResults,
          ...activityDelta(activityBefore, activityAfter),
          workspace: workspaceOf(clone),
        };
        candidates.set(result.sha, clone);
        return result;
      } catch (error) {
        await port.disposeClone(clone).catch(() => undefined);
        throw error;
      }
    },
    async review(actionId, incident, candidate) {
      const source = candidates.get(candidate.sha) ?? cloneOf(candidate);
      if (!source) throw new Error(`workspace do candidate não encontrado: ${candidate.sha}`);
      const reviewerClone = await port.createClone(source.clonePath, candidate.sha, actionId);
      try {
        await port.prepareClone(reviewerClone);
        const activityBefore = await port.observeTaskActivity(reviewerClone);
        const stdout = await port.runAgent({
          actionId,
          role: 'reviewer',
          profileId: reviewerProfile,
          clone: reviewerClone,
          prompt: reviewerPrompt(incident, candidate),
          readOnly: true,
        });
        const activityAfter = await port.observeTaskActivity(reviewerClone);
        const activity = activityDelta(activityBefore, activityAfter);
        if (activity.task_provider_launches !== 0 || activity.task_attempts_delta !== 0) {
          throw new Error('reviewer lançou provider de task ou alterou attempts');
        }
        await port.assertReviewerReadOnly(reviewerClone, candidate.sha);
        const review = parseRoutineReview(stdout);
        if (review.decision !== 'ACCEPT') {
          await port.disposeClone(source);
          candidates.delete(candidate.sha);
        }
        return review;
      } finally {
        await port.disposeClone(reviewerClone);
      }
    },
    async adopt(_actionId, incident, candidate) {
      const clone = candidates.get(candidate.sha) ?? cloneOf(candidate);
      if (!clone) throw new Error(`workspace do candidate não encontrado: ${candidate.sha}`);
      try {
        await port.publishAndFastForward(clone, incident.authorized_head_before, candidate.sha);
        const authorizedHead = await port.adoptOfficial(candidate.sha);
        return { authorized_head_after: authorizedHead, official_primitive: true };
      } finally {
        await port.disposeClone(clone);
        candidates.delete(candidate.sha);
      }
    },
    retryPreflight() {
      return port.runPreflight();
    },
  };
}
