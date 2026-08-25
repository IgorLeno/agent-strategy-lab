import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { EvaluationOutcome, ExecutionStatus } from '../../src/core/index.js';
import {
  canonicalSha256,
  evaluationEnvelopeSha256,
  executionEnvelopeSha256,
  type EvaluationEnvelopeManifest,
  type ExecutionEnvelopeManifest,
} from '../../src/envelope/index.js';
import { resolveDataDir } from '../../src/project/index.js';
import { scoreRunV1 } from '../../src/scorer/index.js';
import type { ProfileCapabilityInput } from '../../src/routing/index.js';
import {
  EvaluationRecord,
  ExecutionRecord,
  RunInterventionsRecord,
  QuotaObservationStatus,
  QuotaReasonCode,
  QuotaUsage,
  TaskSpec,
  type EnvironmentProfile,
  type InterventionRecord,
  type QualificationRecord,
} from '../../src/schemas/index.js';
import {
  appendLedgerEntry,
  buildSectionManifest,
  createRunDirectory,
  finalizeExecution,
  listRunRecords,
  RunIndex,
  sealEvaluation,
  sealScore,
  verifyRunIntegrity,
  type RunDirectory,
  type RunHistoryContextV1,
  type RunRecord,
  type SectionManifest,
} from '../../src/storage/index.js';
import { machineSafetyCeiling, machineSafetyCeilingMs } from './machine-safety.js';
import { writeJsonOnce } from './atomic.js';
import type { HarnessPaths } from './paths.js';
import { recordComparableRunFacts } from './project-orchestrate.js';
import type { WorkUnitClassification } from './project-authorization.js';
import {
  readProjectHistoryBinding,
  writeProjectHistoryBinding,
} from './records.js';
import {
  ProjectHistoryBinding,
  type CandidateReviewRecord,
  type LaunchRecord,
  type PlanTask,
  type ValidationResult,
} from './schemas.js';
import type { LauncherProfile } from './profile.js';
import type { ProjectInspection } from '../../src/inspection/index.js';
import { AttemptRole } from '../../src/performance/index.js';

const EVALUATION_RECORD_FILE = 'evaluation-record.json';
const EVALUATION_ENVELOPE_FILE = 'evaluation-envelope.json';
const SCORE_RECORD_FILE = 'score-record.json';
const QUALIFICATION_RECORD_FILE = 'qualification-record.json';
const INTERVENTIONS_FILE = 'interventions.json';
const MANIFEST_FILE = 'manifest.json';
const LEDGER_FILE = 'ledger.jsonl';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type ProjectHistoryStage =
  | 'RUN_CREATED'
  | 'EXECUTION_WRITTEN'
  | 'EXECUTION_SEALED'
  | 'EVALUATION_SEALED'
  | 'SCORE_SEALED'
  | 'INDEXED'
  | 'BOUND';

export interface CanonicalProjectAttemptInput {
  readonly paths: HarnessPaths;
  readonly labRoot: string;
  readonly planTask: PlanTask;
  readonly classification: WorkUnitClassification;
  readonly inspection: ProjectInspection;
  readonly profile: LauncherProfile;
  readonly capability: ProfileCapabilityInput;
  readonly launch: LaunchRecord;
  readonly attempt: number;
  readonly attemptRole: Exclude<AttemptRole, AttemptRole.UNKNOWN>;
  readonly executionEpisodeId: string;
  readonly episodeAttemptOrdinal: number;
  readonly initialProfileId: string;
  readonly initialProfileFingerprintSha256: string;
  readonly baseSha: string;
  readonly compiledPrompt: string;
  readonly validationResults: readonly ValidationResult[];
  readonly validationEvidence?: readonly unknown[];
  readonly reviewRequired: boolean;
  readonly reviewRecord: CandidateReviewRecord | null;
  readonly reviewUnavailableReason?: string | null;
  readonly changedFiles: readonly string[] | null;
  readonly observedTokens?: {
    readonly total: number;
    readonly input?: number;
    readonly cachedInput?: number;
    readonly output?: number;
    readonly reasoning?: number;
    readonly provenance: string;
  } | null;
  readonly observedHadInference?: {
    readonly value: boolean;
    readonly provenance: string;
  };
  /**
   * Conjunto PROVADO de intervenções humanas do attempt. `undefined`/`null`
   * significa que o lifecycle não pôde provar nem zero nem uma intervenção
   * concreta: nesse caso nenhum artifact é publicado e o leitor mantém UNKNOWN.
   * Lista vazia só é aceitável com prova positiva de execução autônoma.
   */
  readonly interventionEvidence?: {
    readonly provenance: string;
    readonly interventions: readonly InterventionRecord[];
  } | null;
  readonly instructionFiles?: readonly { readonly path: string; readonly sha256: string }[];
  readonly instructionInventoryComplete?: boolean;
  readonly contextPressure: 'low' | 'medium' | 'high';
  readonly environmentReadiness: 'READY';
  readonly now?: Date;
  /** Hook de teste para simular crash entre publicações append-only. */
  readonly afterStage?: (stage: ProjectHistoryStage) => void | Promise<void>;
}

export type CanonicalProjectAttemptResult =
  | {
      readonly outcome: 'MATERIALIZED' | 'ALREADY_MATERIALIZED';
      readonly run_id: string;
      readonly trial_id: string;
      readonly evaluation_id: string;
      readonly score_id: string;
      readonly qualification: QualificationRecord;
    }
  | { readonly outcome: 'SKIPPED'; readonly reason: string };

export function projectProfileFingerprint(profile: LauncherProfile): string {
  return canonicalSha256(profile);
}

export function projectWorkDefinitionFingerprint(input: {
  readonly planTask: PlanTask;
  readonly classification: WorkUnitClassification;
}): string {
  return canonicalSha256({
    schema_version: 2,
    work_definition: {
      objective: input.planTask.objective,
      initial_files: input.planTask.initial_files,
      acceptance: input.planTask.acceptance,
      validation: input.planTask.validation,
      constraints: input.planTask.constraints,
      include_previous_handoff: input.planTask.include_previous_handoff,
      dependency_count: input.planTask.blocked_by.length,
    },
    classification: input.classification,
  });
}

export async function materializeCanonicalProjectAttempt(
  input: CanonicalProjectAttemptInput,
): Promise<CanonicalProjectAttemptResult> {
  assertPositive(input.attempt, 'attempt');
  assertPositive(input.episodeAttemptOrdinal, 'episodeAttemptOrdinal');
  const inference = input.observedHadInference ?? observedInference(input.launch);
  if (inference === null) {
    return { outcome: 'SKIPPED', reason: 'had_inference UNKNOWN; ausência não vira capability sample' };
  }
  if (!inference.value) {
    return { outcome: 'SKIPPED', reason: 'operational retry com zero inference provado' };
  }
  if (input.launch.duration_ms === null || input.launch.finished_at === null) {
    return { outcome: 'SKIPPED', reason: 'LaunchRecord não alcançou desfecho temporal observável' };
  }
  if (!input.inspection.stack.known || input.inspection.stack.value.ecosystems_detected.length === 0) {
    return { outcome: 'SKIPPED', reason: 'stack autoritativa ausente; ExecutionEnvelope falha fechado' };
  }
  if (input.instructionInventoryComplete === false) {
    return { outcome: 'SKIPPED', reason: 'instruction file inventory não pôde ser fingerprintado autoritativamente' };
  }

  const profileFingerprint = projectProfileFingerprint(input.profile);
  const workFingerprint = projectWorkDefinitionFingerprint(input);
  const bindingKey = canonicalSha256({
    schema_version: 1,
    target_project: path.resolve(input.paths.repoRoot),
    runtime: path.resolve(input.paths.devDir),
    task_id: input.planTask.id,
    attempt: input.attempt,
    launch_id: input.launch.launch_id,
  });
  const runId = deterministicRunId(new Date(input.launch.started_at).getTime(), bindingKey);
  const trialId = `external-${canonicalSha256({
    execution_episode_id: input.executionEpisodeId,
    profile_fingerprint_sha256: profileFingerprint,
  }).slice(0, 24)}`;
  const evaluationId = `evaluation-${bindingKey.slice(0, 16)}`;
  const scoreId = `score-${bindingKey.slice(0, 16)}`;
  const existingBinding = await readProjectHistoryBinding(
    input.paths,
    input.planTask.id,
    input.attempt,
    input.launch.launch_id,
  );
  if (existingBinding !== null) {
    if (existingBinding.binding_key_sha256 !== bindingKey || existingBinding.canonical_run_id !== runId) {
      throw new Error('binding attempt -> canonical run diverge da identidade observada');
    }
    const integrity = await verifyRunIntegrity(
      path.join(resolveDataDir({ labRoot: input.labRoot }), 'runs', runId),
    );
    if (!integrity.ok) throw new Error(`binding aponta para run sem integridade: ${runId}`);
    return {
      outcome: 'ALREADY_MATERIALIZED',
      run_id: runId,
      trial_id: existingBinding.canonical_trial_id,
      evaluation_id: evaluationId,
      score_id: scoreId,
      qualification: await readQualification(input.labRoot, runId, scoreId),
    };
  }

  const now = input.now ?? new Date(input.launch.finished_at);
  const run = await createOrResumeRun(input.labRoot, runId, new Date(input.launch.started_at));
  await stage(input, 'RUN_CREATED');

  const envelope = buildExecutionEnvelope(input);
  const executionRecord = buildExecutionRecord(input, executionEnvelopeSha256(envelope));
  await writeJsonOnce(path.join(run.executionDir, 'execution-envelope.json'), envelope);
  await writeJsonOnce(path.join(run.executionDir, 'execution-record.json'), executionRecord);
  const comparable = await recordComparableRunFacts({
    executionDir: run.executionDir,
    evidence: {
      authoritative_profile: input.profile,
      profile_provenance: 'LauncherProfile completo carregado do catálogo canônico',
      provider: { value: input.profile.agent, provenance: 'LauncherProfile.agent usado pelo LaunchRecord' },
      transport: { value: input.profile.prompt_delivery, provenance: 'LauncherProfile.prompt_delivery' },
      worker_role: { value: 'implementer', provenance: 'project_lifecycle.role' },
      attempt_role: { value: input.attemptRole, provenance: 'project_lifecycle.attempt_role' },
      context_pressure: {
        value: input.contextPressure,
        provenance: 'ProjectWorkUnitReport.context_pressure observado antes do launch',
      },
      environment_readiness: {
        value: input.environmentReadiness,
        provenance: 'ProjectWorkUnitReport.environment_readiness observado antes do launch',
      },
    },
  });
  if (comparable.outcome === 'ALREADY_RECORDED') {
    throw new Error('ComparableRunFacts append-only divergiu durante resume');
  }
  const quota = quotaUsageFromLaunch(input.launch, input.profile.agent);
  if (quota !== null) await writeJsonOnce(path.join(run.executionDir, 'quota-usage.json'), quota);
  const interventionEvidence = input.interventionEvidence ?? null;
  if (interventionEvidence !== null) {
    await writeJsonOnce(
      path.join(run.executionDir, INTERVENTIONS_FILE),
      RunInterventionsRecord.parse({
        schema_version: 1,
        provenance: interventionEvidence.provenance,
        interventions: interventionEvidence.interventions,
      }),
    );
  }
  await stage(input, 'EXECUTION_WRITTEN');
  const executionManifest = await resumeOrSeal(
    run.runDir,
    'execution',
    () => finalizeExecution(run.runDir, { now }),
  );
  await stage(input, 'EXECUTION_SEALED');

  const evaluation = buildEvaluation(input, executionManifest.digest_sha256, evaluationId);
  const evaluationDir = path.join(run.runDir, 'evaluations', evaluationId);
  await mkdir(evaluationDir, { recursive: true });
  await writeJsonOnce(path.join(evaluationDir, EVALUATION_ENVELOPE_FILE), evaluation.envelope);
  await writeJsonOnce(path.join(evaluationDir, EVALUATION_RECORD_FILE), evaluation.record);
  await writeJsonOnce(path.join(evaluationDir, 'official-validation-evidence.json'), {
    results: input.validationResults,
    evidence: input.validationEvidence ?? [],
  });
  if (input.reviewRecord !== null) {
    await writeJsonOnce(path.join(evaluationDir, 'candidate-review-evidence.json'), input.reviewRecord);
  }
  if (input.reviewRequired && input.reviewRecord === null) {
    await writeJsonOnce(path.join(evaluationDir, 'candidate-review-unavailable.json'), {
      required: true,
      reason: input.reviewUnavailableReason ?? 'review evidence unavailable',
    });
  }
  await resumeOrSeal(run.runDir, `evaluations/${evaluationId}`, () =>
    sealEvaluation(run.runDir, evaluationId, { now }),
  );
  await stage(input, 'EVALUATION_SEALED');

  const scored = scoreRunV1({
    executionRecord,
    evaluationRecord: evaluation.record,
    budgets: envelope.budgets,
  });
  const scoreDir = path.join(run.runDir, 'scores', scoreId);
  await mkdir(scoreDir, { recursive: true });
  await writeJsonOnce(path.join(scoreDir, SCORE_RECORD_FILE), scored.score);
  await writeJsonOnce(path.join(scoreDir, QUALIFICATION_RECORD_FILE), scored.qualification);
  await resumeOrSeal(run.runDir, `scores/${scoreId}`, () => sealScore(run.runDir, scoreId, { now }));
  await stage(input, 'SCORE_SEALED');

  const historyContext: RunHistoryContextV1 = {
    schema_version: 1,
    execution_episode_id: input.executionEpisodeId,
    episode_attempt_ordinal: input.episodeAttemptOrdinal,
    work_definition_fingerprint_sha256: workFingerprint,
    initial_profile_id: input.initialProfileId,
    initial_profile_fingerprint_sha256: input.initialProfileFingerprintSha256,
    observed_had_inference: inference,
    selection: { evaluation_id: evaluationId, score_id: scoreId },
  };
  const runRecord = buildRunRecord(input, run, trialId, executionRecord.status, historyContext);
  const index = RunIndex.open(path.join(run.dataDir, 'index.sqlite'));
  try {
    await index.indexRun(run.runDir, runRecord);
  } finally {
    index.close();
  }
  await stage(input, 'INDEXED');
  const integrity = await verifyRunIntegrity(run.runDir);
  if (!integrity.ok) {
    throw new Error(
      `run canônico não será publicado: ${integrity.violations.map((item) => item.kind).join(', ')}`,
    );
  }

  const binding = ProjectHistoryBinding.parse({
    schema_version: 1,
    binding_key_sha256: bindingKey,
    target_repo_root: path.resolve(input.paths.repoRoot),
    runtime_dir: path.resolve(input.paths.devDir),
    task_id: input.planTask.id,
    attempt: input.attempt,
    launch_id: input.launch.launch_id,
    attempt_role: input.attemptRole,
    execution_episode_id: input.executionEpisodeId,
    episode_attempt_ordinal: input.episodeAttemptOrdinal,
    initial_profile_id: input.initialProfileId,
    initial_profile_fingerprint_sha256: input.initialProfileFingerprintSha256,
    canonical_trial_id: trialId,
    canonical_run_id: runId,
    bound_at: now.toISOString(),
  });
  await writeProjectHistoryBinding(input.paths, binding);
  await stage(input, 'BOUND');
  return {
    outcome: 'MATERIALIZED',
    run_id: runId,
    trial_id: trialId,
    evaluation_id: evaluationId,
    score_id: scoreId,
    qualification: scored.qualification,
  };
}

export async function queryCanonicalProjectHistory(input: {
  readonly labRoot: string;
  readonly workDefinitionFingerprintSha256: string;
  readonly eligibleProfileIds: readonly string[];
  readonly minimumSampleSize: number;
  readonly filter?: {
    readonly task_class?: string;
    readonly difficulty?: string;
    readonly stack?: readonly string[];
  };
}) {
  const runsDir = path.join(resolveDataDir({ labRoot: input.labRoot }), 'runs');
  const records = await listRunRecords(runsDir);
  const byTrial = new Map<string, Record<string, { evaluation_id: string; score_id: string | null }>>();
  for (const { record } of records) {
    const context = record.history_context;
    if (context?.work_definition_fingerprint_sha256 !== input.workDefinitionFingerprintSha256) continue;
    const selection = byTrial.get(record.trial.id) ?? {};
    selection[record.run.run_id] = context.selection;
    byTrial.set(record.trial.id, selection);
  }
  const { queryPerformanceHistory } = await import('../../src/performance/query.js');
  return queryPerformanceHistory({
    schema_version: 2,
    runs_dir: runsDir,
    minimum_sample_size: input.minimumSampleSize,
    work_definition_fingerprint_sha256: input.workDefinitionFingerprintSha256,
    eligible_profile_ids: input.eligibleProfileIds,
    trials: [...byTrial.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([trial_id, selection]) => ({ trial_id, selection })),
    ...(input.filter === undefined ? {} : { filter: input.filter }),
  });
}

function buildExecutionEnvelope(input: CanonicalProjectAttemptInput): ExecutionEnvelopeManifest {
  const capability = input.capability;
  const environment = environmentProfile(input);
  const graderIds = input.planTask.validation.map((_, index) => `official-validation-${index + 1}`);
  const taskSpec = TaskSpec.parse({
    id: `project-${projectWorkDefinitionFingerprint(input).slice(0, 24)}`,
    description: input.planTask.objective,
    visible_criteria: input.planTask.acceptance,
    task_class: input.classification.task_class,
    difficulty: input.classification.difficulty_declared,
    stack: input.inspection.stack.known ? input.inspection.stack.value.ecosystems_detected : [],
    public_graders: graderIds,
    budgets: input.classification.resource_envelope,
    taxonomy: {
      version: 1,
      task_class: input.classification.task_class,
      difficulty_declared: input.classification.difficulty_declared,
      complexity: input.classification.complexity,
      ambiguity: input.classification.ambiguity,
      verification: input.classification.verification,
    },
  });
  return {
    task_spec: taskSpec,
    strategy: {
      name: 'external-project-lifecycle',
      version: 1,
      prompt: input.planTask.objective,
    },
    compiled_prompt: input.compiledPrompt,
    base_sha: input.baseSha,
    agent_profile: {
      id: input.profile.id,
      cli: input.profile.agent,
      cli_version: 'UNKNOWN',
      model: capability.model,
      flags: [...input.launch.argv, `reasoning_effort:${capability.reasoning_effort}`],
    },
    environment_profile: environment,
    adapter: { name: 'external-project-lifecycle', version: '1.0.0' },
    budgets: input.classification.resource_envelope,
    // O record descreve o limite REAL sob o qual o attempt correu. Não existe
    // mais deadline derivado da task: o que existe é o teto de segurança de
    // máquina, e é ele que fica registrado.
    timeout_ms: machineSafetyCeilingMs(machineSafetyCeiling()),
  };
}

function environmentProfile(input: CanonicalProjectAttemptInput): EnvironmentProfile {
  const inventory = {
    id: `external-${input.profile.environment_mode}`,
    env_allowlist: [...input.profile.env_allowlist],
    instruction_files: [...(input.instructionFiles ?? [])],
    plugins: [],
    skills: [],
    mcp_servers: [],
  };
  if (input.profile.environment_mode === 'controlled') {
    return { ...inventory, mode: 'controlled', home: 'sanitized' };
  }
  return {
    ...inventory,
    mode: 'real-world',
    home: input.profile.instruction_environment === 'sanitized_user_home' ? 'sanitized' : 'user',
    uncontrolled: [
      'plugins/skills/mcp inventory not authoritatively observed by LaunchRecord',
      'host environment outside LauncherProfile.env_allowlist',
    ],
  };
}

function buildExecutionRecord(
  input: CanonicalProjectAttemptInput,
  envelopeSha256: string,
) {
  const status = input.launch.timed_out
    ? ExecutionStatus.TIMED_OUT
    : input.launch.provider_failure !== null
      ? ExecutionStatus.INFRA_ERROR
      : input.launch.exit_code !== 0
        ? ExecutionStatus.CRASHED
        : ExecutionStatus.COMPLETED;
  const observed = input.observedTokens ?? null;
  return ExecutionRecord.parse({
    status,
    exit_code: input.launch.exit_code,
    duration_ms: input.launch.duration_ms,
    execution_envelope_sha256: envelopeSha256,
    metrics: {
      tokens: {
        value: observed?.total ?? null,
        provenance: observed?.provenance ?? 'LaunchRecord não registra token count',
      },
      changed_files: {
        value: input.changedFiles?.length ?? null,
        provenance: input.changedFiles === null ? 'changed_files não observado' : 'official attempt evidence.changed_files',
      },
      ...(observed?.input === undefined ? {} : { input_tokens: { value: observed.input, provenance: observed.provenance } }),
      ...(observed?.cachedInput === undefined ? {} : { cached_input_tokens: { value: observed.cachedInput, provenance: observed.provenance } }),
      ...(observed?.output === undefined ? {} : { output_tokens: { value: observed.output, provenance: observed.provenance } }),
      ...(observed?.reasoning === undefined ? {} : { reasoning_tokens: { value: observed.reasoning, provenance: observed.provenance } }),
      api_equivalent_usd: {
        value: input.launch.billing?.provider_estimated_api_equivalent_usd ?? null,
        provenance: input.launch.billing === null ? 'LaunchRecord.billing ausente' : 'LaunchRecord.billing.provider_estimated_api_equivalent_usd',
      },
    },
  });
}

function buildEvaluation(
  input: CanonicalProjectAttemptInput,
  executionManifestSha256: string,
  evaluationId: string,
): { readonly envelope: EvaluationEnvelopeManifest; readonly record: EvaluationRecord } {
  const results: Record<string, { outcome: EvaluationOutcome; required: boolean }> = {};
  const versions: Record<string, string> = {};
  const commands: Record<string, readonly string[]> = {};
  const rubric: Record<string, string> = {};
  const weights: Record<string, number> = {};
  input.planTask.validation.forEach((command, index) => {
    const id = `official-validation-${index + 1}`;
    const observed = input.validationResults[index];
    const matchesOfficialCommand = observed !== undefined &&
      observed.argv.length === command.argv.length &&
      observed.argv.every((value, argumentIndex) => value === command.argv[argumentIndex]);
    results[id] = {
      outcome: !matchesOfficialCommand || observed.exit_code === null
        ? EvaluationOutcome.NOT_EVALUATED
        : observed.timed_out || observed.exit_code !== 0
          ? EvaluationOutcome.FAIL
          : EvaluationOutcome.PASS,
      required: true,
    };
    versions[id] = `argv-${canonicalSha256(command.argv).slice(0, 16)}`;
    commands[id] = command.argv;
    rubric[id] = `official deterministic validation ${index + 1}`;
    weights[id] = 1;
  });
  if (input.reviewRequired) {
    const id = 'independent-review';
    results[id] = {
      outcome: input.reviewRecord === null
        ? EvaluationOutcome.NOT_EVALUATED
        : input.reviewRecord.decision === 'ACCEPT'
          ? EvaluationOutcome.PASS
          : EvaluationOutcome.FAIL,
      required: true,
    };
    versions[id] = 'candidate-review-record-v1';
    if (input.reviewRecord !== null) {
      commands[id] = input.reviewRecord.reviewer_invocation.argv;
    }
    rubric[id] = 'independent candidate review required by policy';
    weights[id] = 1;
  }
  const values = Object.values(results);
  const outcome = values.some((item) => item.outcome === EvaluationOutcome.FAIL)
    ? EvaluationOutcome.FAIL
    : values.some((item) => item.outcome === EvaluationOutcome.NOT_EVALUATED)
      ? EvaluationOutcome.NOT_EVALUATED
      : EvaluationOutcome.PASS;
  const envelope: EvaluationEnvelopeManifest = {
    execution_manifest_sha256: executionManifestSha256,
    evaluation_plan: { hidden_graders: Object.keys(results), rubric, weights },
    grader_versions: versions,
    evaluator_environment: evaluatorEnvironmentProfile(input),
    evaluation_commands: commands,
  };
  return {
    envelope,
    record: EvaluationRecord.parse({
      evaluation_id: evaluationId,
      outcome,
      grader_results: results,
      grader_versions: versions,
      evaluation_envelope_sha256: evaluationEnvelopeSha256(envelope),
    }),
  };
}

function evaluatorEnvironmentProfile(input: CanonicalProjectAttemptInput): EnvironmentProfile {
  return {
    id: 'external-official-validation-host',
    mode: 'real-world',
    home: 'user',
    env_allowlist: [],
    instruction_files: [...(input.instructionFiles ?? [])],
    plugins: [],
    skills: [],
    mcp_servers: [],
    uncontrolled: [
      'runOfficialValidation inherits the orchestrator process environment',
      'ValidationEvidence does not persist plugin, skill or MCP inventory',
    ],
  };
}

function buildRunRecord(
  input: CanonicalProjectAttemptInput,
  run: RunDirectory,
  trialId: string,
  status: ExecutionStatus,
  historyContext: RunHistoryContextV1,
): RunRecord {
  const taskId = `project-${projectWorkDefinitionFingerprint(input).slice(0, 24)}`;
  return {
    task: {
      id: taskId,
      task_class: input.classification.task_class,
      difficulty: input.classification.difficulty_declared,
      description: input.planTask.objective,
    },
    trial: {
      id: trialId,
      task_id: taskId,
      agent_id: input.profile.id,
      strategy_name: 'external-project-lifecycle',
      status: 'EXECUTED',
    },
    run: {
      run_id: run.runId,
      trial_id: trialId,
      run_dir: run.runDir,
      created_at: input.launch.started_at,
      status,
    },
    history_context: historyContext,
  };
}

/**
 * Houve inferência neste launch?
 *
 * A prova mais direta é a contagem de tokens que o PRÓPRIO provider reportou
 * sobre o turno. Ela vem primeiro de propósito: as duas outras evidências —
 * equivalência em dólar e delta de quota — são leituras EXTERNAS e específicas
 * de provider, e a ausência delas descreve o instrumento, não a execução.
 *
 * Foi exatamente essa inversão que se provou custosa no piloto Augmented
 * Chess: nenhum profile Codex de assinatura expõe medidor de conta (`/usage` é
 * comando do Claude) e nenhum reporta custo de API, então todos os 13 attempts
 * reais caíram em UNKNOWN, nenhum virou run canônico e a história ficou
 * permanentemente vazia — o que fazia todo routing cair no fallback estático e
 * reescolher o mesmo provider, sem nunca acumular a evidência que decidiria.
 *
 * O rigor original permanece: ausência de qualquer uma das três continua
 * UNKNOWN, e UNKNOWN continua não virando capability sample.
 */
function observedInference(
  launch: LaunchRecord,
): { readonly value: boolean; readonly provenance: string } | null {
  const tokens = launch.observed_tokens;
  if (tokens !== null && tokens !== undefined && tokens.total > 0) {
    return {
      value: true,
      provenance: `LaunchRecord.observed_tokens.total=${tokens.total} (${tokens.provenance})`,
    };
  }
  const apiEquivalent = launch.billing?.provider_estimated_api_equivalent_usd;
  if (apiEquivalent !== null && apiEquivalent !== undefined) {
    return {
      value: apiEquivalent > 0,
      provenance: 'LaunchRecord.billing.provider_estimated_api_equivalent_usd',
    };
  }
  const windows = launch.subscription_usage === null
    ? []
    : [launch.subscription_usage.five_hour, launch.subscription_usage.seven_day_all_models];
  if (windows.some((window) => window.consumed_pp !== null && window.consumed_pp > 0)) {
    return { value: true, provenance: 'LaunchRecord.subscription_usage observed positive delta' };
  }
  return null;
}

/** Contagem do LaunchRecord na forma que a materialização canônica consome. */
export function observedTokensOf(
  launch: LaunchRecord,
): NonNullable<CanonicalProjectAttemptInput['observedTokens']> | null {
  const tokens = launch.observed_tokens;
  if (tokens === null || tokens === undefined) return null;
  return {
    total: tokens.total,
    ...(tokens.input === null ? {} : { input: tokens.input }),
    ...(tokens.cached_input === null ? {} : { cachedInput: tokens.cached_input }),
    ...(tokens.output === null ? {} : { output: tokens.output }),
    ...(tokens.reasoning === null ? {} : { reasoning: tokens.reasoning }),
    provenance: tokens.provenance,
  };
}

function quotaUsageFromLaunch(launch: LaunchRecord, provider: string) {
  const usage = launch.subscription_usage;
  if (usage === null) return null;
  const observed = usage.probe_contract.before.available && usage.probe_contract.after.available;
  return QuotaUsage.parse({
    provider,
    observation: {
      status: observed ? QuotaObservationStatus.OBSERVED : QuotaObservationStatus.UNAVAILABLE,
      reason_code: observed ? QuotaReasonCode.OK : QuotaReasonCode.MEASUREMENT_UNAVAILABLE,
      provenance: 'LaunchRecord.subscription_usage.probe_contract',
    },
    windows: observed
      ? [
          quotaWindow('five_hour', usage.five_hour),
          quotaWindow('seven_day_all_models', usage.seven_day_all_models),
        ]
      : [],
  });
}

function quotaWindow(
  id: string,
  window: LaunchRecord['subscription_usage'] extends infer _T ? NonNullable<LaunchRecord['subscription_usage']>['five_hour'] : never,
) {
  const reason = Object.values(QuotaReasonCode).includes(window.reason_code as QuotaReasonCode)
    ? (window.reason_code as QuotaReasonCode)
    : QuotaReasonCode.MEASUREMENT_UNAVAILABLE;
  return {
    window_id: id,
    before_used_pct: window.before_used_pct,
    after_used_pct: window.after_used_pct,
    consumed_pp: window.consumed_pp,
    same_window: window.same_window,
    reason_code: reason,
    provenance: `LaunchRecord.subscription_usage.${id}`,
  };
}

async function createOrResumeRun(
  labRoot: string,
  runId: string,
  now: Date,
): Promise<RunDirectory> {
  try {
    return await createRunDirectory({ labRoot, runId, now });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('run directory já existe:')) throw error;
  }
  const dataDir = resolveDataDir({ labRoot });
  const runDir = path.join(dataDir, 'runs', runId);
  const executionDir = path.join(runDir, 'execution');
  const metadataPath = path.join(runDir, 'metadata.json');
  await mkdir(executionDir, { recursive: true });
  const metadata = { schema_version: 1 as const, run_id: runId, created_at: now.toISOString() };
  await writeJsonOnce(metadataPath, metadata);
  return { runId, dataDir, runDir, executionDir, metadataPath, metadata };
}

async function resumeOrSeal(
  runDir: string,
  section: string,
  seal: () => Promise<unknown>,
): Promise<SectionManifest> {
  const manifestPath = path.join(runDir, section, MANIFEST_FILE);
  let manifest: SectionManifest | null = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as SectionManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (manifest === null) {
    await seal();
    const sealed = JSON.parse(await readFile(manifestPath, 'utf8')) as SectionManifest;
    const rebuilt = await buildSectionManifest(path.join(runDir, section), { section });
    if (rebuilt.digest_sha256 !== sealed.digest_sha256) {
      throw new Error(`seção recém-selada diverge do manifest: ${section}`);
    }
    return sealed;
  }
  const rebuilt = await buildSectionManifest(path.join(runDir, section), { section });
  if (rebuilt.digest_sha256 !== manifest.digest_sha256) {
    throw new Error(`seção parcial diverge do manifest selado: ${section}`);
  }
  const ledgerPath = path.join(runDir, LEDGER_FILE);
  let entries: Array<{ section?: string; digest_sha256?: string }> = [];
  try {
    entries = (await readFile(ledgerPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { section?: string; digest_sha256?: string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const matching = entries.filter((entry) => entry.section === section);
  if (matching.length === 0) {
    await appendLedgerEntry(runDir, manifest);
    return manifest;
  }
  if (matching.length !== 1 || matching[0]?.digest_sha256 !== manifest.digest_sha256) {
    throw new Error(`ledger diverge para seção ${section}`);
  }
  return manifest;
}

function deterministicRunId(timestamp: number, bindingKey: string): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 2 ** 48 - 1) {
    throw new RangeError('LaunchRecord.started_at fora do intervalo ULID');
  }
  const bytes = createHash('sha256').update(bindingKey, 'utf8').digest().subarray(0, 10);
  return encodeBase32(timestamp, 10) + encodeBytes(bytes);
}

function encodeBase32(value: number, length: number): string {
  let remaining = value;
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result = CROCKFORD[remaining % 32] + result;
    remaining = Math.floor(remaining / 32);
  }
  return result;
}

function encodeBytes(bytes: Uint8Array): string {
  let buffer = 0;
  let bits = 0;
  let result = '';
  for (const byte of bytes) {
    buffer = buffer * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const divisor = 2 ** bits;
      result += CROCKFORD[Math.floor(buffer / divisor)];
      buffer %= divisor;
    }
  }
  return result;
}

async function readQualification(labRoot: string, runId: string, scoreId: string) {
  return JSON.parse(
    await readFile(
      path.join(resolveDataDir({ labRoot }), 'runs', runId, 'scores', scoreId, QUALIFICATION_RECORD_FILE),
      'utf8',
    ),
  ) as QualificationRecord;
}

async function stage(input: CanonicalProjectAttemptInput, value: ProjectHistoryStage) {
  await input.afterStage?.(value);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} deve ser inteiro positivo`);
}
