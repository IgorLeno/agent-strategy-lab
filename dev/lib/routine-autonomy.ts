import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonOnce } from './atomic.js';
import type { HarnessPaths } from './paths.js';
import {
  readAttemptAbandonment,
  readInfraFailedAttempt,
  readProtocolInvalidAttempt,
  readValidationFailedAttempt,
} from './records.js';
import type { PreflightResult } from './orchestrate-preflight.js';
import type { ValidationResult } from './schemas.js';
import { readState } from './state.js';

export const ROUTINE_MAX_IMPLEMENTATION_TEST_FILES = 8;
export const ROUTINE_MAX_MAINTENANCE_CYCLES = 2;
export const ROUTINE_MAX_RETRIES_AFTER_MAINTENANCE = 1;

const HUMAN_CONTROLLED_HARNESS_FILES = new Set([
  'dev/lib/atomic.ts',
  'dev/lib/billing.ts',
  'dev/lib/execution-policy.ts',
  'dev/lib/maintenance.ts',
  'dev/lib/profile.ts',
  'dev/lib/records.ts',
  'dev/lib/routine-autonomy.ts',
  'dev/lib/routine-autonomy-runtime.ts',
  'dev/lib/schemas.ts',
  'dev/lib/state.ts',
  'dev/cli/dev-orchestrate.ts',
]);

export type IncidentClassification =
  | 'AUTO_RECOVER'
  | 'AUTO_MAINTENANCE'
  | 'TASK_REPAIR'
  | 'HUMAN_REQUIRED';

export type RoutineRecipeId =
  | 'deterministic-recover'
  | 'protocol-invalid-history-integration'
  | 'protocol-output-recovery'
  | 'provider-infra-retry'
  | 'official-validation-repair';

export interface RoutineRecipe {
  readonly id: RoutineRecipeId;
  readonly incident_phase: 'PRE_FLIGHT' | 'POST_LAUNCH';
  readonly classification: Exclude<IncidentClassification, 'HUMAN_REQUIRED'>;
  readonly action: string;
  readonly boundary: string;
  readonly targeted_tests: readonly string[];
  readonly retry_budget: 1;
}

export const ROUTINE_RECIPES: readonly RoutineRecipe[] = [
  {
    id: 'deterministic-recover',
    incident_phase: 'PRE_FLIGHT',
    classification: 'AUTO_RECOVER',
    action: 'APPLY_DETERMINISTIC_RECOVERY',
    boundary: 'RECOVERY_ATTENTION derivada pela primitive oficial sem plan/state/base divergence',
    targeted_tests: ['test/dev/routine-autonomy.test.ts', 'test/dev/dev-recover.test.ts'],
    retry_budget: 1,
  },
  {
    id: 'protocol-invalid-history-integration',
    incident_phase: 'PRE_FLIGHT',
    classification: 'AUTO_MAINTENANCE',
    action: 'INTEGRATE_PROTOCOL_INVALID_HISTORY',
    boundary: 'HISTORICAL_GAP com exatamente um ProtocolInvalidAttemptRecord',
    targeted_tests: ['test/dev/automatic-repair-policy.test.ts', 'test/dev/retry-failed.test.ts'],
    retry_budget: 1,
  },
  {
    id: 'protocol-output-recovery',
    incident_phase: 'POST_LAUNCH',
    classification: 'AUTO_RECOVER',
    action: 'RECOVER_PROTOCOL_OUTPUT',
    boundary: 'primitive dev-recover-protocol-output aceita integralmente o contrato estreito',
    targeted_tests: ['test/dev/protocol-output-recovery.test.ts', 'test/dev/routine-autonomy.test.ts'],
    retry_budget: 1,
  },
  {
    id: 'provider-infra-retry',
    incident_phase: 'POST_LAUNCH',
    classification: 'AUTO_RECOVER',
    action: 'RECOVER_PROVIDER_INFRA',
    boundary: 'primitive dev-recover-infra prova INFRA_ERROR capability-neutral e recuperável',
    targeted_tests: ['test/dev/infra-recover.test.ts', 'test/dev/routine-autonomy.test.ts'],
    retry_budget: 1,
  },
  {
    id: 'official-validation-repair',
    incident_phase: 'POST_LAUNCH',
    classification: 'TASK_REPAIR',
    action: 'USE_EXISTING_TASK_REPAIR_POLICY',
    boundary: 'somente FAIL de validation oficial reconhecido pela automatic-repair policy',
    targeted_tests: ['test/dev/automatic-repair-policy.test.ts', 'test/dev/automatic-repair-e2e.test.ts'],
    retry_budget: 1,
  },
];

export type LifecycleRecordName =
  | 'ValidationFailedAttemptRecord'
  | 'InfraFailedAttemptRecord'
  | 'ProtocolInvalidAttemptRecord'
  | 'AttemptAbandonmentRecord';

export interface RoutineIncidentContext {
  readonly preflight: PreflightResult;
  readonly authorized_head_before: string;
  readonly task_id: string | null;
  readonly attempt: number | null;
  readonly lifecycle_records: readonly LifecycleRecordName[];
  readonly evidence_error?: string | null;
  readonly evidence_paths?: readonly string[];
}

export interface RoutinePostLaunchIncident {
  readonly phase: 'POST_LAUNCH';
  readonly authorized_head_before: string;
  readonly task_id: string;
  readonly attempt: number;
  readonly profile_id: string;
  readonly launch: string;
  readonly close: string | null;
  readonly outcome: string;
  readonly reason: string;
  readonly task_status: string;
  readonly task_phase: string | null;
  readonly commit_owner: 'worker' | 'orchestrator' | null;
  readonly capability_verdict: boolean;
  readonly official_validation_failure: boolean;
  readonly evidence_paths: readonly string[];
}

export interface RoutineTriage {
  readonly classification: IncidentClassification;
  readonly action: string;
  readonly reason: string;
  readonly recipe_id: RoutineRecipeId | null;
}

function knownRecipe(id: RoutineRecipeId): RoutineRecipe {
  const recipe = ROUTINE_RECIPES.find((candidate) => candidate.id === id);
  if (!recipe) throw new Error(`RoutineRecipe ausente: ${id}`);
  return recipe;
}

function triageFromRecipe(id: RoutineRecipeId, reason: string): RoutineTriage {
  const recipe = knownRecipe(id);
  return {
    classification: recipe.classification,
    action: recipe.action,
    reason,
    recipe_id: recipe.id,
  };
}

function humanTriage(reason: string): RoutineTriage {
  return { classification: 'HUMAN_REQUIRED', action: 'NONE', reason, recipe_id: null };
}

function existingTaskRepairTriage(reason: string): RoutineTriage {
  return {
    classification: 'TASK_REPAIR',
    action: 'USE_EXISTING_TASK_REPAIR_POLICY',
    reason,
    recipe_id: null,
  };
}

export interface RoutineCandidate {
  readonly sha: string;
  readonly parent_sha: string;
  readonly commit_count: number;
  readonly changed_files: readonly string[];
  readonly diff: string;
  readonly targeted_results: readonly ValidationResult[];
  readonly full_gate_results: readonly ValidationResult[];
  readonly working_tree_clean: boolean;
  readonly diff_check_clean: boolean;
  readonly task_provider_launches: number;
  readonly task_attempts_delta: number;
  readonly package_json_script_only?: boolean;
  readonly workspace?: {
    readonly clone_path: string;
    readonly source_repo: string;
    readonly base_sha: string;
    readonly branch: string;
    readonly git_dir?: string;
  };
}

export interface RoutineReview {
  readonly decision: 'ACCEPT' | 'REJECT' | 'HUMAN_REQUIRED';
  readonly reason: string;
}

export interface RoutineAutonomyDriver {
  recover(actionId: string, incident: RoutineIncidentContext): Promise<{ readonly action: string }>;
  maintain(
    actionId: string,
    incident: RoutineIncidentContext,
    cycle: number,
  ): Promise<RoutineCandidate>;
  review(
    actionId: string,
    incident: RoutineIncidentContext,
    candidate: RoutineCandidate,
    cycle: number,
  ): Promise<RoutineReview>;
  adopt(
    actionId: string,
    incident: RoutineIncidentContext,
    candidate: RoutineCandidate,
  ): Promise<{ readonly authorized_head_after: string; readonly official_primitive: true }>;
  retryPreflight(actionId: string, incident: RoutineIncidentContext): Promise<PreflightResult>;
}

export interface RoutinePostLaunchDriver {
  recoverProtocolOutput(
    actionId: string,
    incident: RoutinePostLaunchIncident,
  ): Promise<{ readonly action: string; readonly skip_retry?: boolean }>;
  recoverInfra(
    actionId: string,
    incident: RoutinePostLaunchIncident,
  ): Promise<{ readonly action: string; readonly skip_retry?: boolean }>;
}

export interface HumanRequiredOutput {
  readonly status: 'HUMAN_REQUIRED';
  readonly incident_id: string;
  readonly decision_needed: string;
  readonly why_automation_stopped: string;
  readonly options: readonly string[];
  readonly evidence_paths: readonly string[];
}

export interface RoutineIncidentRecord {
  readonly incident_id: string;
  readonly detected_at: string;
  readonly task_id: string | null;
  readonly attempt: number | null;
  readonly blocker: string;
  readonly classification: IncidentClassification;
  readonly authorized_head_before: string;
  readonly triage_reason: string;
  readonly action: string;
  readonly maintainer_profile: string | null;
  readonly maintenance_commit: string | null;
  readonly reviewer_profile: string | null;
  readonly review_decision: RoutineReview['decision'] | null;
  readonly authorized_head_after: string | null;
  readonly retry_result: string | null;
  readonly human_required: boolean;
  readonly human_reason: string | null;
  readonly phase?: 'PRE_FLIGHT' | 'POST_LAUNCH';
  readonly outcome?: string;
  readonly recipe_id?: RoutineRecipeId | null;
}

export type RoutineResolution = {
  readonly status: 'RECOVERED' | 'HUMAN_REQUIRED';
  readonly preflight: PreflightResult;
  readonly record: RoutineIncidentRecord;
  readonly human_required: HumanRequiredOutput | null;
};

export interface ResolveRoutinePreflightInput {
  readonly paths: HarnessPaths;
  readonly incident: RoutineIncidentContext;
  readonly driver: RoutineAutonomyDriver;
  readonly maintainerProfile?: string;
  readonly reviewerProfile?: string;
  readonly now?: () => string;
}

export interface ResolveRoutinePostLaunchInput<T> {
  readonly paths: HarnessPaths;
  readonly incident: RoutinePostLaunchIncident;
  readonly driver: RoutinePostLaunchDriver;
  readonly retrySameTask: (
    actionId: string,
    incident: RoutinePostLaunchIncident,
  ) => Promise<{ readonly incident: RoutinePostLaunchIncident; readonly value: T }>;
  readonly operationalRetryAllowed?: boolean;
  readonly now?: () => string;
}

export type RoutinePostLaunchResolution<T> =
  | {
      readonly status: 'RETRIED';
      readonly retry: T;
      readonly record: RoutineIncidentRecord;
      readonly human_required: null;
    }
  | {
      readonly status: 'RECOVERED';
      readonly retry: null;
      readonly record: RoutineIncidentRecord;
      readonly human_required: null;
    }
  | {
      readonly status: 'HUMAN_REQUIRED';
      readonly retry: null;
      readonly record: RoutineIncidentRecord;
      readonly human_required: HumanRequiredOutput;
    };

function blockerOf(context: RoutineIncidentContext): string {
  return context.preflight.blocker ?? 'UNKNOWN_BLOCKER';
}

export function classifyRoutineIncident(context: RoutineIncidentContext): RoutineTriage {
  const blocker = blockerOf(context);
  if (context.evidence_error) {
    return humanTriage(`evidência não pôde ser verificada: ${context.evidence_error}`);
  }
  if (blocker === 'INCONSISTENT_EVIDENCE' || blocker === 'INVALID_EVIDENCE') {
    return humanTriage(context.preflight.reason ?? blocker);
  }
  if (context.lifecycle_records.length > 1) {
    return humanTriage('lifecycle records incompatíveis simultâneos; normalização automática recusada');
  }
  if (blocker === 'AUTOMATIC_REPAIR_PROFILE_MISMATCH') {
    return existingTaskRepairTriage(context.preflight.reason ?? blocker);
  }
  if (blocker === 'RECOVERY_ATTENTION') {
    const recovery = context.preflight.recover;
    if (
      recovery &&
      recovery.reconciliation_count > 0 &&
      !recovery.plan_changed &&
      !recovery.state_was_missing &&
      recovery.head_matches_authorized
    ) {
      return triageFromRecipe(
        'deterministic-recover',
        'reconciliation pendente já derivada pela primitive de recovery',
      );
    }
  }
  if (
    blocker === 'HISTORICAL_GAP' &&
    context.lifecycle_records.length === 1 &&
    context.lifecycle_records[0] === 'ProtocolInvalidAttemptRecord'
  ) {
    return triageFromRecipe(
      'protocol-invalid-history-integration',
      'record capability-neutral existe e o history walker conhecido não o reconhece',
    );
  }
  return humanTriage(context.preflight.reason ?? blocker);
}

export function classifyRoutinePostLaunchIncident(
  incident: RoutinePostLaunchIncident,
): RoutineTriage {
  if (incident.capability_verdict && incident.outcome !== 'FAIL') {
    return humanTriage('incidente operacional contém capability verdict incompatível');
  }
  if (incident.outcome === 'FAIL' && incident.official_validation_failure) {
    return triageFromRecipe('official-validation-repair', incident.reason);
  }
  if (
    incident.outcome === 'PENDING' &&
    incident.launch === 'FINISHED' &&
    incident.close === 'PENDING' &&
    incident.task_status === 'RUNNING' &&
    incident.task_phase === 'FINALIZING' &&
    incident.commit_owner === 'orchestrator' &&
    !incident.capability_verdict
  ) {
    return triageFromRecipe(
      'protocol-output-recovery',
      'fechamento orchestrator-owned pendente; primitive oficial decidirá o contrato estreito',
    );
  }
  if (
    incident.outcome === 'INFRA_ERROR' &&
    incident.launch === 'INFRA_ERROR' &&
    incident.close === null &&
    !incident.capability_verdict
  ) {
    return triageFromRecipe(
      'provider-infra-retry',
      'launcher classificou INFRA_ERROR sem capability verdict; primitive oficial decidirá recoverability',
    );
  }
  return humanTriage(incident.reason);
}

function isGreen(result: ValidationResult): boolean {
  return result.exit_code === 0 && !result.timed_out;
}

function commandKey(result: ValidationResult): string {
  return result.argv.join('\u0000');
}

export function validateRoutineCandidate(
  candidate: RoutineCandidate,
  authorizedHead: string,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (candidate.commit_count !== 1 || candidate.parent_sha !== authorizedHead) {
    return { ok: false, reason: 'candidate precisa ser exatamente um commit filho direto do authorized head' };
  }
  if (!candidate.working_tree_clean || !candidate.diff_check_clean) {
    return { ok: false, reason: 'candidate ou diff-check não está limpo' };
  }
  if (candidate.task_provider_launches !== 0 || candidate.task_attempts_delta !== 0) {
    return { ok: false, reason: 'maintenance/review não pode lançar provider de task nem consumir attempt' };
  }
  const uniqueFiles = [...new Set(candidate.changed_files)];
  if (uniqueFiles.length !== candidate.changed_files.length) {
    return { ok: false, reason: 'changed_files contém duplicatas' };
  }
  for (const file of uniqueFiles) {
    if (file === 'dev/plan.yaml' || file.startsWith('src/')) {
      return { ok: false, reason: `fronteira humana obrigatória: ${file}` };
    }
    if (file.startsWith('.dev/') || file.startsWith('.dev-inbox/')) {
      return { ok: false, reason: `evidência runtime/histórica é append-only: ${file}` };
    }
    if (HUMAN_CONTROLLED_HARNESS_FILES.has(file) || file.startsWith('dev/profiles/')) {
      return { ok: false, reason: `política/schema/evidência do harness exige humano: ${file}` };
    }
    if (file.startsWith('docs/') && /(?:report|handoff|run-real)/i.test(file)) {
      return { ok: false, reason: `handoff/report histórico exige humano: ${file}` };
    }
    if (file === 'package.json') {
      if (!candidate.package_json_script_only) {
        return { ok: false, reason: 'package.json só é permitido para script estritamente necessário' };
      }
      continue;
    }
    if (!file.startsWith('dev/') && !file.startsWith('test/dev/') && !file.startsWith('docs/')) {
      return { ok: false, reason: `arquivo fora da allowlist de routine maintenance: ${file}` };
    }
  }
  const counted = uniqueFiles.filter((file) => !file.startsWith('docs/'));
  if (counted.length > ROUTINE_MAX_IMPLEMENTATION_TEST_FILES) {
    return {
      ok: false,
      reason: `${counted.length} arquivos de implementação/teste excedem o limite ${ROUTINE_MAX_IMPLEMENTATION_TEST_FILES}`,
    };
  }
  if (/^[+-].*(schema_version|DEV_SCHEMA_VERSION)/m.test(candidate.diff)) {
    return { ok: false, reason: 'mudança de schema_version exige humano' };
  }
  if (/^[+].*\bpush\b.*--force(?:-with-lease)?/m.test(candidate.diff)) {
    return { ok: false, reason: 'force push exige humano' };
  }
  if (candidate.targeted_results.length === 0 || !candidate.targeted_results.every(isGreen)) {
    return { ok: false, reason: 'targeted tests ausentes ou falhos' };
  }
  const required = [
    'pnpm\u0000typecheck',
    'pnpm\u0000build',
    'pnpm\u0000test',
    'git\u0000diff\u0000--check',
  ];
  const full = candidate.full_gate_results;
  if (!full.every(isGreen)) return { ok: false, reason: 'full gate falhou' };
  for (const prefix of required) {
    if (!full.some((result) => commandKey(result).startsWith(prefix))) {
      return { ok: false, reason: `full gate ausente: ${prefix.replaceAll('\u0000', ' ')}` };
    }
  }
  return { ok: true };
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function routineIncidentId(context: RoutineIncidentContext): string {
  return [
    context.task_id ?? 'preflight',
    context.attempt ?? 0,
    context.authorized_head_before.slice(0, 12),
    safeSegment(blockerOf(context)),
  ].join('-');
}

export function routinePostLaunchIncidentId(context: RoutinePostLaunchIncident): string {
  return [
    context.task_id,
    context.attempt,
    context.authorized_head_before.slice(0, 12),
    'post-launch',
    safeSegment(context.outcome),
  ].join('-');
}

function incidentRoot(paths: HarnessPaths): string {
  return path.join(paths.devDir, 'autonomy', 'incidents');
}

export function writeRoutineIncidentEvent(
  paths: HarnessPaths,
  incidentId: string,
  event: string,
  value: unknown,
): Promise<void> {
  if (!/^[A-Za-z0-9._-]+$/.test(incidentId) || !/^[A-Za-z0-9._-]+$/.test(event)) {
    throw new Error('incident/event id inválido');
  }
  return writeJsonOnce(path.join(incidentRoot(paths), incidentId, `${event}.json`), value);
}

async function readRoutineIncidentEvent<T>(
  paths: HarnessPaths,
  incidentId: string,
  event: string,
): Promise<T | null> {
  try {
    return JSON.parse(
      await readFile(path.join(incidentRoot(paths), incidentId, `${event}.json`), 'utf8'),
    ) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeTerminalRecord(paths: HarnessPaths, record: RoutineIncidentRecord): Promise<void> {
  await writeJsonOnce(path.join(incidentRoot(paths), `${record.incident_id}.json`), record);
}

async function readTerminalRecord(
  paths: HarnessPaths,
  incidentId: string,
): Promise<RoutineIncidentRecord | null> {
  try {
    return JSON.parse(
      await readFile(path.join(incidentRoot(paths), `${incidentId}.json`), 'utf8'),
    ) as RoutineIncidentRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameBlocker(original: PreflightResult, retried: PreflightResult): boolean {
  return (
    retried.status === 'BLOCKED' &&
    retried.blocker === original.blocker &&
    retried.reason === original.reason
  );
}

function automationFailure(stage: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${stage} recusou ou falhou: ${detail}`;
}

function humanOutput(
  incidentId: string,
  reason: string,
  evidencePaths: readonly string[],
  decision = 'Revisar a evidência e escolher a intervenção explícita.',
): HumanRequiredOutput {
  return {
    status: 'HUMAN_REQUIRED',
    incident_id: incidentId,
    decision_needed: decision,
    why_automation_stopped: reason,
    options: ['corrigir a evidência externamente e rerodar', 'autorizar uma mudança fora das fronteiras'],
    evidence_paths: [...evidencePaths],
  };
}

function baseRecord(
  input: ResolveRoutinePreflightInput,
  triage: RoutineTriage,
  incidentId: string,
): Omit<
  RoutineIncidentRecord,
  | 'maintenance_commit'
  | 'review_decision'
  | 'authorized_head_after'
  | 'retry_result'
  | 'human_required'
  | 'human_reason'
> {
  return {
    incident_id: incidentId,
    detected_at: (input.now ?? (() => new Date().toISOString()))(),
    phase: 'PRE_FLIGHT',
    outcome: blockerOf(input.incident),
    recipe_id: triage.recipe_id,
    task_id: input.incident.task_id,
    attempt: input.incident.attempt,
    blocker: blockerOf(input.incident),
    classification: triage.classification,
    authorized_head_before: input.incident.authorized_head_before,
    triage_reason: triage.reason,
    action: triage.action,
    maintainer_profile:
      triage.classification === 'AUTO_MAINTENANCE'
        ? (input.maintainerProfile ?? 'claude-build-worker-subscription-sonnet5-medium-v3')
        : null,
    reviewer_profile:
      triage.classification === 'AUTO_MAINTENANCE'
        ? (input.reviewerProfile ?? 'codex-build-worker-subscription-terra-high-v2')
        : null,
  };
}

async function finishHuman(
  input: ResolveRoutinePreflightInput,
  base: ReturnType<typeof baseRecord>,
  preflight: PreflightResult,
  reason: string,
  maintenanceCommit: string | null,
  reviewDecision: RoutineReview['decision'] | null,
  authorizedHeadAfter: string | null,
  decision?: string,
): Promise<RoutineResolution> {
  const record: RoutineIncidentRecord = {
    ...base,
    maintenance_commit: maintenanceCommit,
    review_decision: reviewDecision,
    authorized_head_after: authorizedHeadAfter,
    retry_result: preflight.status,
    human_required: true,
    human_reason: reason,
  };
  await writeTerminalRecord(input.paths, record);
  const evidence = [
    path.relative(input.paths.repoRoot, path.join(incidentRoot(input.paths), base.incident_id)),
    ...(input.incident.evidence_paths ?? []),
  ];
  return {
    status: 'HUMAN_REQUIRED',
    preflight,
    record,
    human_required: humanOutput(base.incident_id, reason, evidence, decision),
  };
}

async function finishRecovered(
  input: ResolveRoutinePreflightInput,
  base: ReturnType<typeof baseRecord>,
  preflight: PreflightResult,
  maintenanceCommit: string | null,
  reviewDecision: RoutineReview['decision'] | null,
  authorizedHeadAfter: string | null,
): Promise<RoutineResolution> {
  const record: RoutineIncidentRecord = {
    ...base,
    maintenance_commit: maintenanceCommit,
    review_decision: reviewDecision,
    authorized_head_after: authorizedHeadAfter,
    retry_result: preflight.status,
    human_required: false,
    human_reason: null,
  };
  await writeTerminalRecord(input.paths, record);
  return { status: 'RECOVERED', preflight, record, human_required: null };
}

export async function resolveRoutinePreflight(
  input: ResolveRoutinePreflightInput,
): Promise<RoutineResolution> {
  const incidentId = routineIncidentId(input.incident);
  const previous = await readTerminalRecord(input.paths, incidentId);
  if (previous) {
    const human = previous.human_required
      ? humanOutput(incidentId, previous.human_reason ?? 'intervenção humana necessária', [])
      : null;
    return {
      status: previous.human_required ? 'HUMAN_REQUIRED' : 'RECOVERED',
      preflight: input.incident.preflight,
      record: previous,
      human_required: human,
    };
  }

  const triage = classifyRoutineIncident(input.incident);
  const base = baseRecord(input, triage, incidentId);
  await writeRoutineIncidentEvent(input.paths, incidentId, 'detected', {
    incident_id: incidentId,
    blocker: base.blocker,
    classification: triage.classification,
    authorized_head_before: base.authorized_head_before,
    task_id: base.task_id,
    attempt: base.attempt,
    triage_reason: triage.reason,
  });

  if (triage.classification === 'HUMAN_REQUIRED' || triage.classification === 'TASK_REPAIR') {
    return finishHuman(
      input,
      base,
      input.incident.preflight,
      triage.reason,
      null,
      null,
      null,
      triage.classification === 'TASK_REPAIR'
        ? 'Executar a política de TASK_REPAIR com o profile autorizado indicado.'
        : undefined,
    );
  }

  if (triage.classification === 'AUTO_RECOVER') {
    const actionId = `${incidentId}:recover`;
    const savedRecovery = await readRoutineIncidentEvent<{ readonly action: string }>(
      input.paths,
      incidentId,
      'recover-completed',
    );
    let recovery = savedRecovery;
    if (recovery === null) {
      try {
        recovery = await input.driver.recover(actionId, input.incident);
      } catch (error) {
        return finishHuman(
          input,
          base,
          input.incident.preflight,
          automationFailure('recovery automático', error),
          null,
          null,
          null,
        );
      }
    }
    if (savedRecovery === null) {
      await writeRoutineIncidentEvent(input.paths, incidentId, 'recover-completed', recovery);
    }
    const savedRetry = await readRoutineIncidentEvent<PreflightResult>(
      input.paths,
      incidentId,
      'retry-completed',
    );
    let retry = savedRetry;
    if (retry === null) {
      try {
        retry = await input.driver.retryPreflight(`${incidentId}:retry`, input.incident);
      } catch (error) {
        return finishHuman(
          input,
          base,
          input.incident.preflight,
          automationFailure('retry do preflight', error),
          null,
          null,
          null,
        );
      }
    }
    if (savedRetry === null) {
      await writeRoutineIncidentEvent(input.paths, incidentId, 'retry-completed', retry);
    }
    if (sameBlocker(input.incident.preflight, retry)) {
      return finishHuman(
        input,
        base,
        retry,
        'o mesmo blocker reapareceu depois do recovery automático',
        null,
        null,
        null,
      );
    }
    return finishRecovered(input, base, retry, null, null, retry.maintenance.authorized_head_sha);
  }

  let lastCandidate: RoutineCandidate | null = null;
  let lastReview: RoutineReview | null = null;
  for (let cycle = 0; cycle < ROUTINE_MAX_MAINTENANCE_CYCLES; cycle += 1) {
    const ordinal = cycle + 1;
    const maintainEvent = `maintain-${ordinal}-completed`;
    const savedCandidate = await readRoutineIncidentEvent<RoutineCandidate>(
      input.paths,
      incidentId,
      maintainEvent,
    );
    let candidate = savedCandidate;
    if (candidate === null) {
      try {
        candidate = await input.driver.maintain(
          `${incidentId}:maintain:${ordinal}`,
          input.incident,
          cycle,
        );
      } catch (error) {
        return finishHuman(
          input,
          base,
          input.incident.preflight,
          automationFailure(`maintainer ciclo ${ordinal}`, error),
          null,
          null,
          null,
        );
      }
    }
    lastCandidate = candidate;
    if (savedCandidate === null) {
      await writeRoutineIncidentEvent(input.paths, incidentId, maintainEvent, candidate);
    }
    const candidateCheck = validateRoutineCandidate(candidate, input.incident.authorized_head_before);
    if (!candidateCheck.ok) {
      return finishHuman(
        input,
        base,
        input.incident.preflight,
        candidateCheck.reason,
        candidate.sha,
        null,
        null,
      );
    }

    const reviewEvent = `review-${ordinal}-completed`;
    const savedReview = await readRoutineIncidentEvent<RoutineReview>(
      input.paths,
      incidentId,
      reviewEvent,
    );
    let review = savedReview;
    if (review === null) {
      try {
        review = await input.driver.review(
          `${incidentId}:review:${ordinal}`,
          input.incident,
          candidate,
          cycle,
        );
      } catch (error) {
        return finishHuman(
          input,
          base,
          input.incident.preflight,
          automationFailure(`reviewer ciclo ${ordinal}`, error),
          candidate.sha,
          null,
          null,
        );
      }
    }
    lastReview = review;
    if (savedReview === null) {
      await writeRoutineIncidentEvent(input.paths, incidentId, reviewEvent, review);
    }
    if (review.decision === 'HUMAN_REQUIRED') {
      return finishHuman(
        input,
        base,
        input.incident.preflight,
        review.reason,
        candidate.sha,
        review.decision,
        null,
      );
    }
    if (review.decision === 'REJECT') {
      if (ordinal < ROUTINE_MAX_MAINTENANCE_CYCLES) continue;
      return finishHuman(
        input,
        base,
        input.incident.preflight,
        `segunda revisão rejeitou o candidate: ${review.reason}`,
        candidate.sha,
        review.decision,
        null,
        'A segunda revisão independente rejeitou a manutenção; escolher correção manual ou mudança de desenho.',
      );
    }

    const savedAdoption = await readRoutineIncidentEvent<{
      readonly authorized_head_after: string;
      readonly official_primitive: true;
    }>(input.paths, incidentId, 'adopt-completed');
    let adoption = savedAdoption;
    if (adoption === null) {
      try {
        adoption = await input.driver.adopt(`${incidentId}:adopt`, input.incident, candidate);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return finishHuman(
          input,
          base,
          input.incident.preflight,
          `primitive oficial de adoção recusou a maintenance: ${reason}`,
          candidate.sha,
          review.decision,
          null,
          'Resolver a recusa da primitive oficial antes de autorizar qualquer caminho alternativo.',
        );
      }
    }
    if (!adoption.official_primitive) {
      return finishHuman(
        input,
        base,
        input.incident.preflight,
        'runtime não confirmou uso da primitive oficial de adoção',
        candidate.sha,
        review.decision,
        null,
      );
    }
    if (savedAdoption === null) {
      await writeRoutineIncidentEvent(input.paths, incidentId, 'adopt-completed', adoption);
    }
    const savedRetry = await readRoutineIncidentEvent<PreflightResult>(
      input.paths,
      incidentId,
      'retry-completed',
    );
    let retry = savedRetry;
    if (retry === null) {
      try {
        retry = await input.driver.retryPreflight(`${incidentId}:retry`, input.incident);
      } catch (error) {
        return finishHuman(
          input,
          base,
          input.incident.preflight,
          automationFailure('retry do preflight após auto-maintenance', error),
          candidate.sha,
          review.decision,
          adoption.authorized_head_after,
        );
      }
    }
    if (savedRetry === null) {
      await writeRoutineIncidentEvent(input.paths, incidentId, 'retry-completed', retry);
    }
    if (sameBlocker(input.incident.preflight, retry)) {
      return finishHuman(
        input,
        base,
        retry,
        'o mesmo blocker reapareceu depois da auto-maintenance',
        candidate.sha,
        review.decision,
        adoption.authorized_head_after,
      );
    }
    if (retry.status === 'BLOCKED') {
      return finishHuman(
        input,
        base,
        retry,
        `um novo blocker apareceu no retry do mesmo preflight: ${retry.blocker ?? retry.reason}`,
        candidate.sha,
        review.decision,
        adoption.authorized_head_after,
      );
    }
    return finishRecovered(
      input,
      base,
      retry,
      candidate.sha,
      review.decision,
      adoption.authorized_head_after,
    );
  }

  return finishHuman(
    input,
    base,
    input.incident.preflight,
    'budget de auto-maintenance esgotado',
    lastCandidate?.sha ?? null,
    lastReview?.decision ?? null,
    null,
  );
}

function postLaunchBaseRecord(
  input: ResolveRoutinePostLaunchInput<unknown>,
  triage: RoutineTriage,
  incidentId: string,
): Omit<
  RoutineIncidentRecord,
  | 'maintenance_commit'
  | 'review_decision'
  | 'authorized_head_after'
  | 'retry_result'
  | 'human_required'
  | 'human_reason'
> {
  return {
    incident_id: incidentId,
    detected_at: (input.now ?? (() => new Date().toISOString()))(),
    phase: 'POST_LAUNCH',
    outcome: input.incident.outcome,
    recipe_id: triage.recipe_id,
    task_id: input.incident.task_id,
    attempt: input.incident.attempt,
    blocker: input.incident.outcome,
    classification: triage.classification,
    authorized_head_before: input.incident.authorized_head_before,
    triage_reason: triage.reason,
    action: triage.action,
    maintainer_profile: null,
    reviewer_profile: null,
  };
}

async function finishPostLaunchHuman<T>(
  input: ResolveRoutinePostLaunchInput<T>,
  base: ReturnType<typeof postLaunchBaseRecord>,
  reason: string,
  retryResult: string | null,
): Promise<RoutinePostLaunchResolution<T>> {
  const record: RoutineIncidentRecord = {
    ...base,
    maintenance_commit: null,
    review_decision: null,
    authorized_head_after: null,
    retry_result: retryResult,
    human_required: true,
    human_reason: reason,
  };
  await writeTerminalRecord(input.paths, record);
  const evidence = [
    path.relative(input.paths.repoRoot, path.join(incidentRoot(input.paths), base.incident_id)),
    ...input.incident.evidence_paths,
  ];
  return {
    status: 'HUMAN_REQUIRED',
    retry: null,
    record,
    human_required: humanOutput(base.incident_id, reason, evidence),
  };
}

async function finishPostLaunchRetried<T>(
  input: ResolveRoutinePostLaunchInput<T>,
  base: ReturnType<typeof postLaunchBaseRecord>,
  retryResult: string,
  retry: T,
): Promise<RoutinePostLaunchResolution<T>> {
  const record: RoutineIncidentRecord = {
    ...base,
    maintenance_commit: null,
    review_decision: null,
    authorized_head_after: input.incident.authorized_head_before,
    retry_result: retryResult,
    human_required: false,
    human_reason: null,
  };
  await writeTerminalRecord(input.paths, record);
  return { status: 'RETRIED', retry, record, human_required: null };
}

async function finishPostLaunchRecovered<T>(
  input: ResolveRoutinePostLaunchInput<T>,
  base: ReturnType<typeof postLaunchBaseRecord>,
): Promise<RoutinePostLaunchResolution<T>> {
  const record: RoutineIncidentRecord = {
    ...base,
    maintenance_commit: null,
    review_decision: null,
    authorized_head_after: input.incident.authorized_head_before,
    retry_result: null,
    human_required: false,
    human_reason: null,
  };
  await writeTerminalRecord(input.paths, record);
  return { status: 'RECOVERED', retry: null, record, human_required: null };
}

export async function resolveRoutinePostLaunch<T>(
  input: ResolveRoutinePostLaunchInput<T>,
): Promise<RoutinePostLaunchResolution<T>> {
  const incidentId = routinePostLaunchIncidentId(input.incident);
  const previous = await readTerminalRecord(input.paths, incidentId);
  if (previous) {
    const reason = previous.human_reason ?? 'incidente pós-launch já processado; replay automático recusado';
    return {
      status: 'HUMAN_REQUIRED',
      retry: null,
      record: previous,
      human_required: humanOutput(incidentId, reason, input.incident.evidence_paths),
    };
  }

  const triage = classifyRoutinePostLaunchIncident(input.incident);
  const base = postLaunchBaseRecord(input, triage, incidentId);
  await writeRoutineIncidentEvent(input.paths, incidentId, 'detected', {
    incident_id: incidentId,
    phase: 'POST_LAUNCH',
    outcome: input.incident.outcome,
    recipe_id: triage.recipe_id,
    classification: triage.classification,
    task_id: input.incident.task_id,
    attempt: input.incident.attempt,
    profile_id: input.incident.profile_id,
    triage_reason: triage.reason,
  });

  if (triage.classification === 'HUMAN_REQUIRED' || triage.classification === 'TASK_REPAIR') {
    return finishPostLaunchHuman(input, base, triage.reason, null);
  }

  const retryStarted = await readRoutineIncidentEvent<{ readonly action_id: string }>(
    input.paths,
    incidentId,
    'retry-started',
  );
  if (retryStarted !== null) {
    return finishPostLaunchHuman(
      input,
      base,
      'restart encontrou retry já iniciado sem resultado terminal; replay de provider recusado',
      null,
    );
  }

  const actionId = `${incidentId}:recover`;
  const savedRecovery = await readRoutineIncidentEvent<{
    readonly action: string;
    readonly skip_retry?: boolean;
  }>(input.paths, incidentId, 'recover-completed');
  let recovery = savedRecovery;
  if (recovery === null) {
    try {
      recovery =
        triage.recipe_id === 'protocol-output-recovery'
          ? await input.driver.recoverProtocolOutput(actionId, input.incident)
          : await input.driver.recoverInfra(actionId, input.incident);
      await writeRoutineIncidentEvent(input.paths, incidentId, 'recover-completed', recovery);
    } catch (error) {
      return finishPostLaunchHuman(
        input,
        base,
        automationFailure(`recipe ${triage.recipe_id ?? 'desconhecida'}`, error),
        null,
      );
    }
  }

  if (input.operationalRetryAllowed === false) {
    return finishPostLaunchHuman(
      input,
      base,
      `budget operacional da recipe ${triage.recipe_id ?? 'desconhecida'} esgotado; ` +
        'incidente persistente de protocol/tooling recuperado sem novo retry',
      null,
    );
  }

  if (recovery.skip_retry === true) {
    return finishPostLaunchRecovered(input, base);
  }

  const retryActionId = `${incidentId}:retry`;
  await writeRoutineIncidentEvent(input.paths, incidentId, 'retry-started', {
    action_id: retryActionId,
    task_id: input.incident.task_id,
    profile_id: input.incident.profile_id,
  });
  let retry;
  try {
    retry = await input.retrySameTask(retryActionId, input.incident);
  } catch (error) {
    return finishPostLaunchHuman(
      input,
      base,
      automationFailure('retry operacional da mesma task/profile', error),
      null,
    );
  }
  await writeRoutineIncidentEvent(input.paths, incidentId, 'retry-completed', {
    task_id: retry.incident.task_id,
    attempt: retry.incident.attempt,
    profile_id: retry.incident.profile_id,
    outcome: retry.incident.outcome,
  });

  if (
    retry.incident.task_id !== input.incident.task_id ||
    retry.incident.profile_id !== input.incident.profile_id ||
    retry.incident.attempt !== input.incident.attempt + 1
  ) {
    return finishPostLaunchHuman(
      input,
      base,
      'retry operacional não voltou à mesma task/profile no attempt imediatamente seguinte',
      retry.incident.outcome,
    );
  }
  if (retry.incident.outcome !== 'PASS' && retry.incident.outcome !== 'FAIL') {
    return finishPostLaunchHuman(
      input,
      base,
      `budget da recipe esgotado: ${retry.incident.outcome} reapareceu no único retry`,
      retry.incident.outcome,
    );
  }
  return finishPostLaunchRetried(input, base, retry.incident.outcome, retry.value);
}

export async function inspectRoutineIncident(
  paths: HarnessPaths,
  preflight: PreflightResult,
): Promise<RoutineIncidentContext> {
  const state = await readState(paths);
  const taskId = preflight.next?.task_id ?? null;
  const task = taskId === null ? null : state.tasks.find((candidate) => candidate.id === taskId) ?? null;
  const attempt = task?.attempts ?? null;
  const records: LifecycleRecordName[] = [];
  let evidenceError: string | null = null;
  if (taskId !== null && attempt !== null && attempt > 0) {
    try {
      const [validation, infra, protocolInvalid, abandonment] = await Promise.all([
        readValidationFailedAttempt(paths, taskId, attempt),
        readInfraFailedAttempt(paths, taskId, attempt),
        readProtocolInvalidAttempt(paths, taskId, attempt),
        readAttemptAbandonment(paths, taskId, attempt),
      ]);
      if (validation) records.push('ValidationFailedAttemptRecord');
      if (infra) records.push('InfraFailedAttemptRecord');
      if (protocolInvalid) records.push('ProtocolInvalidAttemptRecord');
      if (abandonment) records.push('AttemptAbandonmentRecord');
    } catch (error) {
      evidenceError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    preflight,
    authorized_head_before: state.authorized_head_sha ?? '',
    task_id: taskId,
    attempt,
    lifecycle_records: records,
    ...(evidenceError === null ? {} : { evidence_error: evidenceError }),
  };
}
