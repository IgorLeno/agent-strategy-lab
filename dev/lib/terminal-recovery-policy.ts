import { createTechnicalBlocked, type TechnicalBlockedOutput } from './control-plane-halt.js';
import { technicalHaltFromPayload } from './incident-recovery.js';
import { loadPlan } from './plan.js';
import { completionPath, readCompletion } from './records.js';
import { isVerificationOnlyTask, type TaskStatus } from './schemas.js';
import { readState } from './state.js';
import type { HarnessPaths } from './paths.js';
import { TechnicalBlocker, type TechnicalBlocker as TechnicalBlockerType } from '../../src/intake/index.js';

interface TechnicalFailureFacts {
  readonly task_id: string | null;
  readonly reason: string;
  readonly evidence_paths: readonly string[];
}

export type TerminalRecoveryFacts =
  | { readonly kind: 'TYPED_BLOCKED'; readonly halt: TechnicalBlockedOutput }
  | (TechnicalFailureFacts & {
      readonly kind: 'OFFICIAL_VALIDATION_FAILURE';
      readonly verification_only: boolean | null;
    })
  | (TechnicalFailureFacts & { readonly kind: 'INFRA_ERROR' | 'TIMED_OUT' })
  | (TechnicalFailureFacts & {
      readonly kind: 'PREFLIGHT_TECHNICAL_BLOCK';
      readonly blocker: TechnicalBlockerType;
    })
  | { readonly kind: 'HUMAN_REQUIRED' | 'ALL_DONE' | 'LIMIT_REACHED'; readonly reason: string }
  | { readonly kind: 'WORKER_REPORTED_FAILURE' | 'UNTYPED_FAIL' | 'MISSCOPED'; readonly task_id: string | null; readonly reason: string }
  | { readonly kind: 'PREFLIGHT_UNTYPED_BLOCK'; readonly reason: string };

export type TerminalRecoveryClassification =
  | {
      readonly eligible: true;
      readonly why_eligible: string;
      readonly task_id: string | null;
      readonly halt: TechnicalBlockedOutput;
    }
  | { readonly eligible: false; readonly why_ineligible: string };

function incidentId(kind: string, taskId: string | null): string {
  return `terminal:${taskId ?? 'project'}:${kind.toLowerCase()}`;
}

function technicalHalt(input: TechnicalFailureFacts & {
  readonly kind: string;
  readonly blocker: TechnicalBlockerType;
  readonly decision_needed: string;
}): TechnicalBlockedOutput {
  return createTechnicalBlocked({
    blocker: input.blocker,
    incident_id: incidentId(input.kind, input.task_id),
    decision_needed: input.decision_needed,
    why_automation_stopped: input.reason,
    options: [],
    evidence_paths: input.evidence_paths,
  });
}

const PREFLIGHT_BLOCKERS: Readonly<Record<string, TechnicalBlockerType>> = {
  MAINTENANCE_BLOCKED: 'INVALID_PROVENANCE',
  RECOVERY_ATTENTION: 'INCONSISTENT_EVIDENCE',
  SELECTION_BLOCKED: 'RUNTIME_CONFIGURATION_INVALID',
  AUTOMATIC_REPAIR_EXHAUSTED: 'AUTOMATED_REMEDIATION_FAILED',
  AUTOMATIC_REPAIR_PROFILE_MISMATCH: 'RUNTIME_CONFIGURATION_INVALID',
  INCONSISTENT_EVIDENCE: 'INCONSISTENT_EVIDENCE',
  HISTORICAL_GAP: 'INSUFFICIENT_EVIDENCE',
  INVALID_EVIDENCE: 'INVALID_PROVENANCE',
  DIRTY_WORKTREE: 'INVALID_PROVENANCE',
  BASE_DIVERGED: 'INVALID_PROVENANCE',
};

function terminalStatus(payload: Record<string, unknown>): string {
  const value = payload['stopped_by'] ?? payload['status'];
  return typeof value === 'string' ? value : 'UNKNOWN';
}

function terminalReason(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload['reason'] === 'string' && payload['reason'].trim().length > 0
    ? payload['reason']
    : fallback;
}

async function taskWithStatus(paths: HarnessPaths, status: TaskStatus): Promise<string | null> {
  try {
    const matches = (await readState(paths)).tasks.filter((task) => task.status === status);
    return matches.length === 1 ? matches[0]!.id : null;
  } catch {
    return null;
  }
}

async function isVerificationOnly(paths: HarnessPaths, taskId: string): Promise<boolean | null> {
  try {
    const loaded = await loadPlan(paths.planFile);
    return isVerificationOnlyTask(loaded.plan.tasks.find((task) => task.id === taskId));
  } catch {
    return null;
  }
}

/** Collects authoritative terminal facts; policy remains the pure function below. */
export async function collectTerminalRecoveryFacts(input: {
  readonly payload: Record<string, unknown>;
  readonly paths: HarnessPaths;
}): Promise<TerminalRecoveryFacts> {
  const typedHalt = technicalHaltFromPayload(input.payload);
  if (typedHalt !== null) return { kind: 'TYPED_BLOCKED', halt: typedHalt };

  const status = terminalStatus(input.payload);
  const reason = terminalReason(input.payload, `execução terminou em ${status}`);
  if (status === 'HUMAN_REQUIRED') return { kind: 'HUMAN_REQUIRED', reason };
  if (status === 'ALL_DONE') return { kind: 'ALL_DONE', reason };
  if (status === 'LIMIT_REACHED') return { kind: 'LIMIT_REACHED', reason };

  if (status === 'FAIL') {
    const taskId = await taskWithStatus(input.paths, 'FAIL');
    if (taskId === null) return { kind: 'UNTYPED_FAIL', task_id: null, reason };
    const completion = await readCompletion(input.paths, taskId).catch(() => null);
    if (completion === null) return { kind: 'UNTYPED_FAIL', task_id: taskId, reason };
    const failedValidations = completion.orchestrator_evidence.revalidation.filter(
      (result) => result.exit_code !== 0 || result.timed_out,
    );
    if (failedValidations.length > 0) {
      const validationEvidence = completion.orchestrator_evidence.validation_evidence ?? [];
      return {
        kind: 'OFFICIAL_VALIDATION_FAILURE',
        task_id: taskId,
        verification_only: await isVerificationOnly(input.paths, taskId),
        reason,
        evidence_paths: [
          completionPath(input.paths, taskId),
          ...validationEvidence.flatMap((evidence) => [evidence.stdout_path, evidence.stderr_path]),
        ],
      };
    }
    if (completion.report?.self_reported_result === 'FAILURE') {
      return { kind: 'WORKER_REPORTED_FAILURE', task_id: taskId, reason };
    }
    return { kind: 'UNTYPED_FAIL', task_id: taskId, reason };
  }

  if (status === 'FAILURE') {
    return { kind: 'WORKER_REPORTED_FAILURE', task_id: null, reason };
  }
  if (status === 'INFRA_ERROR' || status === 'TIMED_OUT') {
    const taskId = await taskWithStatus(input.paths, status);
    return { kind: status, task_id: taskId, reason, evidence_paths: [input.paths.stateFile] };
  }
  if (status === 'MISSCOPED') {
    return { kind: 'MISSCOPED', task_id: await taskWithStatus(input.paths, 'MISSCOPED'), reason };
  }

  const preflight = input.payload['preflight'];
  const summarizedBlocker = typeof preflight === 'object' && preflight !== null
    ? (preflight as Record<string, unknown>)['blocker']
    : undefined;
  const rawBlocker = typeof summarizedBlocker === 'string' ? summarizedBlocker : status;
  const blocker = TechnicalBlocker.safeParse(rawBlocker).success
    ? TechnicalBlocker.parse(rawBlocker)
    : PREFLIGHT_BLOCKERS[rawBlocker];
  if (blocker !== undefined) {
    return {
      kind: 'PREFLIGHT_TECHNICAL_BLOCK',
      task_id: null,
      blocker,
      reason,
      evidence_paths: [input.paths.stateFile],
    };
  }
  if (status === 'PREFLIGHT_BLOCKED' || status === 'BLOCKED') {
    return { kind: 'PREFLIGHT_UNTYPED_BLOCK', reason };
  }
  return { kind: 'UNTYPED_FAIL', task_id: null, reason };
}

/** Closed allow-list: the investigator never decides whether recovery is allowed. */
export function classifyTerminalRecovery(facts: TerminalRecoveryFacts): TerminalRecoveryClassification {
  switch (facts.kind) {
    case 'TYPED_BLOCKED':
      return { eligible: true, why_eligible: 'TechnicalBlockedOutput tipado', task_id: null, halt: facts.halt };
    case 'OFFICIAL_VALIDATION_FAILURE':
      return {
        eligible: true,
        task_id: facts.task_id,
        why_eligible: facts.verification_only
          ? 'verification_only concluiu o processo, mas falhou na validação oficial'
          : 'a validação oficial produziu FAIL estruturado',
        halt: technicalHalt({
          ...facts,
          blocker: 'VALIDATION_OR_TOOLING_GAP',
          decision_needed: 'investigar a falha da validação oficial e aplicar somente remediação autorizada',
        }),
      };
    case 'INFRA_ERROR':
    case 'TIMED_OUT':
      return {
        eligible: true,
        task_id: facts.task_id,
        why_eligible: `${facts.kind} terminal tipado após esgotar a recuperação interna`,
        halt: technicalHalt({
          ...facts,
          blocker: 'PROVIDER_OR_INFRA_FAILURE',
          decision_needed: 'investigar a falha técnica terminal sem ampliar provider ou autoridade',
        }),
      };
    case 'PREFLIGHT_TECHNICAL_BLOCK':
      return {
        eligible: true,
        task_id: facts.task_id,
        why_eligible: 'preflight terminal contém blocker técnico tipado',
        halt: technicalHalt({
          ...facts,
          decision_needed: 'investigar o blocker técnico do preflight sem lançar trabalho às cegas',
        }),
      };
    case 'HUMAN_REQUIRED':
      return { eligible: false, why_ineligible: 'HUMAN_REQUIRED preserva a autoridade humana tipada' };
    case 'ALL_DONE':
      return { eligible: false, why_ineligible: 'ALL_DONE não é incidente' };
    case 'LIMIT_REACHED':
      return { eligible: false, why_ineligible: 'LIMIT_REACHED preserva o limite operacional configurado' };
    case 'WORKER_REPORTED_FAILURE':
      return { eligible: false, why_ineligible: 'FAIL declarado pelo worker não é falha técnica do harness' };
    case 'UNTYPED_FAIL':
      return { eligible: false, why_ineligible: 'FAIL sem prova estruturada de falha técnica' };
    case 'MISSCOPED':
      return { eligible: false, why_ineligible: 'MISSCOPED sem blocker técnico tipado permanece inalterado' };
    case 'PREFLIGHT_UNTYPED_BLOCK':
      return { eligible: false, why_ineligible: 'preflight sem TechnicalBlocker reconhecido' };
  }
}
