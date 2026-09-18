/** Coordinator puro sobre artifacts e a primitive oficial de resume. */
import { createHumanRequired, type HumanRequiredOutput } from './control-plane-halt.js';
import {
  IncidentDiagnosis,
  IncidentInvestigationResult,
  recoveryBudgetStatus,
  type IncidentInvestigationResult as IncidentInvestigationResultType,
  type RecoveryBudgetUsage,
  type RecoveryIncident,
} from './incident-recovery.js';
import {
  incrementRecoveryUsage,
  persistInvestigatorLaunchEvidence,
  persistIncidentDiagnosis,
  persistRecoveryOutcome,
} from './lab-runtime.js';
import type { LabProgressListener } from './lab-progress.js';

export interface IncidentInvestigatorPort {
  investigate(input: {
    readonly incident: RecoveryIncident;
    readonly maximumLaunches: number;
  }): Promise<IncidentInvestigationResultType>;
}

/**
 * Desfecho de UMA tentativa de remediação. Não é void de propósito: HARNESS
 * pode descobrir, só depois de tentar, que a correção exige uma autoridade
 * humana real (a run interna de self-maintenance bateu no próprio gate humano)
 * — e isso precisa atravessar como o mesmo HUMAN_REQUIRED estrutural, nunca
 * como uma exceção genérica nem como um resume silencioso.
 */
export type RemediationOutcome =
  | { readonly status: 'REMEDIATED' }
  | { readonly status: 'HUMAN_REQUIRED'; readonly halt: HumanRequiredOutput }
  | { readonly status: 'FAILED'; readonly reason: string };

/** A única ponte permitida de volta ao lifecycle: o chamador usa a primitive oficial. */
export interface IncidentRemediationPort {
  remediate(input: {
    readonly incident: RecoveryIncident;
    readonly diagnosis: IncidentDiagnosis;
  }): Promise<RemediationOutcome>;
}

export type IncidentRecoveryResult =
  | { readonly status: 'RESUME'; readonly diagnosis: IncidentDiagnosis }
  | { readonly status: 'HUMAN_REQUIRED'; readonly halt: HumanRequiredOutput; readonly diagnosis: IncidentDiagnosis }
  | { readonly status: 'BLOCKED'; readonly reason: string };

/**
 * Não executa reparo: só decide se um reparo oficial já autorizado pode ser
 * iniciado pelo chamador. Assim, a implementação da primitive continua sendo
 * dona de Git, validation e state.
 */
export async function coordinateIncidentRecovery(input: {
  readonly runtimeDir: string;
  readonly incident: RecoveryIncident;
  readonly usage: RecoveryBudgetUsage;
  readonly investigator: IncidentInvestigatorPort;
  readonly remediation: IncidentRemediationPort;
  readonly onProgress?: LabProgressListener;
}): Promise<IncidentRecoveryResult> {
  const budget = recoveryBudgetStatus(input.incident.budget, input.usage, input.incident.fingerprint);
  // Ciclo ATUAL, 1-based: cada ciclo tem seu próprio slot append-only
  // (dev/lib/lab-runtime.ts `incidentAttemptPaths`), porque decisão,
  // diagnóstico e desfecho podem legitimamente divergir entre ciclos do MESMO
  // incidente — um arquivo write-once fixo não sobrevive a um segundo ciclo
  // com desfecho diferente do primeiro.
  const attempt = input.usage.investigator_launches + 1;
  if (budget.status === 'EXHAUSTED') {
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
      schema_version: 1, status: 'BLOCKED', reason: budget.reason,
    }, attempt);
    return { status: 'BLOCKED', reason: budget.reason };
  }
  input.onProgress?.({ stage: 'RECOVERY_INVESTIGATING', detail: input.incident.incident_id });
  const maximumLaunches = input.incident.budget.max_investigator_launches - input.usage.investigator_launches;
  let diagnosis: IncidentDiagnosis;
  let investigation: IncidentInvestigationResultType;
  try {
    investigation = IncidentInvestigationResult.parse(await input.investigator.investigate({
      incident: input.incident,
      maximumLaunches,
    }));
  } catch (error) {
    const reason = `investigator não produziu um diagnóstico válido: ${error instanceof Error ? error.message : String(error)}`;
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, { schema_version: 1, status: 'BLOCKED', reason }, attempt);
    return { status: 'BLOCKED', reason };
  }
  await persistInvestigatorLaunchEvidence({
    runtimeDir: input.runtimeDir,
    incidentId: input.incident.incident_id,
    firstSequence: input.usage.investigator_launches + 1,
    launches: investigation.launches,
  });
  await incrementRecoveryUsage(input.runtimeDir, input.incident.incident_id, {
    investigator_launches: investigation.launches.length,
  });
  if (investigation.outcome === 'UNAVAILABLE') {
    const reason = `investigator indisponível: ${investigation.reason}`;
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
      schema_version: 1, status: 'BLOCKED', reason,
    }, attempt);
    return { status: 'BLOCKED', reason };
  }
  diagnosis = IncidentDiagnosis.parse(investigation.diagnosis);
  await persistIncidentDiagnosis(input.runtimeDir, input.incident.incident_id, diagnosis, attempt);
  input.onProgress?.({ stage: 'ROOT_CAUSE_IDENTIFIED', detail: diagnosis.classification });
  if (diagnosis.classification === 'HUMAN_DECISION') {
    const halt = createHumanRequired({
      human_authority: diagnosis.human_authority!,
      incident_id: input.incident.incident_id,
      decision_needed: diagnosis.root_cause,
      why_automation_stopped: diagnosis.root_cause,
      options: diagnosis.remediation,
      evidence_paths: diagnosis.evidence.map((item) => item.path),
    });
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
      schema_version: 1, status: 'HUMAN_REQUIRED', human_authority: halt.human_authority,
    }, attempt);
    return { status: 'HUMAN_REQUIRED', halt, diagnosis };
  }
  if (!diagnosis.safe_within_current_authority) {
    const reason = 'diagnóstico não cabe na autorização atual sem nomear uma autoridade humana';
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, { schema_version: 1, status: 'BLOCKED', reason }, attempt);
    return { status: 'BLOCKED', reason };
  }
  input.onProgress?.({ stage: 'REMEDIATING', detail: diagnosis.classification });
  const outcome = await input.remediation.remediate({ incident: input.incident, diagnosis });
  await incrementRecoveryUsage(input.runtimeDir, input.incident.incident_id, { remediation_cycles: 1 });
  if (outcome.status === 'HUMAN_REQUIRED') {
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
      schema_version: 1, status: 'HUMAN_REQUIRED', human_authority: outcome.halt.human_authority,
    }, attempt);
    return { status: 'HUMAN_REQUIRED', halt: outcome.halt, diagnosis };
  }
  if (outcome.status === 'FAILED') {
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
      schema_version: 1, status: 'BLOCKED', reason: outcome.reason,
    }, attempt);
    return { status: 'BLOCKED', reason: outcome.reason };
  }
  input.onProgress?.({ stage: 'REVALIDATING', detail: input.incident.incident_id });
  await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
    schema_version: 1, status: 'REMEDIATED', classification: diagnosis.classification,
  }, attempt);
  return { status: 'RESUME', diagnosis };
}
