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
  persistReinvestigationDiagnosis,
  persistRecoveryOutcome,
} from './lab-runtime.js';
import type { LabProgressListener } from './lab-progress.js';
import {
  harnessRestartRecordPath,
  persistHarnessRestartRecord,
  type HarnessRestartRecord,
} from './controller-restart.js';

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
  | { readonly status: 'REINVESTIGATE'; readonly evidence_paths: readonly string[] }
  | { readonly status: 'RESTART_REQUIRED'; readonly record: HarnessRestartRecord }
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
  | { readonly status: 'RESTART_REQUIRED'; readonly record: HarnessRestartRecord; readonly diagnosis: IncidentDiagnosis }
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
  let currentIncident = input.incident;
  let launchesUsed = 0;
  let remediationCyclesUsed = 0;
  let reconciliationDepth = 0;

  while (true) {
    input.onProgress?.({ stage: 'RECOVERY_INVESTIGATING', detail: input.incident.incident_id });
    const maximumLaunches = input.incident.budget.max_investigator_launches
      - input.usage.investigator_launches
      - launchesUsed;
    if (maximumLaunches <= 0) {
      const reason = 'orçamento de launches do investigator esgotado durante a reconciliação de contexto';
      await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
        schema_version: 1, status: 'BLOCKED', reason,
      }, attempt);
      return { status: 'BLOCKED', reason };
    }

    let investigation: IncidentInvestigationResultType;
    try {
      investigation = IncidentInvestigationResult.parse(await input.investigator.investigate({
        incident: currentIncident,
        maximumLaunches,
      }));
    } catch (error) {
      const reason = `investigator não produziu um diagnóstico válido: ${error instanceof Error ? error.message : String(error)}`;
      await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, { schema_version: 1, status: 'BLOCKED', reason }, attempt);
      return { status: 'BLOCKED', reason };
    }
    if (investigation.launches.length > maximumLaunches) {
      const reason = `investigator excedeu o orçamento da tentativa: ${investigation.launches.length} launches para limite ${maximumLaunches}`;
      await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, { schema_version: 1, status: 'BLOCKED', reason }, attempt);
      return { status: 'BLOCKED', reason };
    }
    await persistInvestigatorLaunchEvidence({
      runtimeDir: input.runtimeDir,
      incidentId: input.incident.incident_id,
      firstSequence: input.usage.investigator_launches + launchesUsed + 1,
      launches: investigation.launches,
    });
    launchesUsed += investigation.launches.length;
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

    const diagnosis = IncidentDiagnosis.parse(investigation.diagnosis);
    if (reconciliationDepth === 0) {
      await persistIncidentDiagnosis(input.runtimeDir, input.incident.incident_id, diagnosis, attempt);
    } else {
      await persistReinvestigationDiagnosis(input.runtimeDir, input.incident.incident_id, attempt, diagnosis);
    }
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
    if (input.usage.remediation_cycles + remediationCyclesUsed >= input.incident.budget.max_remediation_cycles) {
      const reason = 'orçamento de ciclos de remediação esgotado durante a reconciliação de contexto';
      await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, { schema_version: 1, status: 'BLOCKED', reason }, attempt);
      return { status: 'BLOCKED', reason };
    }

    input.onProgress?.({ stage: 'REMEDIATING', detail: diagnosis.classification });
    const outcome = await input.remediation.remediate({ incident: currentIncident, diagnosis });
    remediationCyclesUsed += 1;
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
    if (outcome.status === 'REINVESTIGATE') {
      if (reconciliationDepth >= 1) {
        const reason = 'reconciliação de contexto não convergiu após uma reinvestigação';
        await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
          schema_version: 1, status: 'BLOCKED', reason,
        }, attempt);
        return { status: 'BLOCKED', reason };
      }
      reconciliationDepth += 1;
      currentIncident = { ...currentIncident, evidence_paths: [...outcome.evidence_paths] };
      continue;
    }
    if (outcome.status === 'RESTART_REQUIRED') {
      if (
        outcome.record.parent_runtime_dir !== input.runtimeDir ||
        outcome.record.incident_id !== input.incident.incident_id
      ) {
        const reason = 'restart record não pertence ao runtime/incidente em recuperação';
        await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
          schema_version: 1, status: 'BLOCKED', reason,
        }, attempt);
        return { status: 'BLOCKED', reason };
      }
      await persistHarnessRestartRecord(outcome.record);
      await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
        schema_version: 1,
        status: 'RESTART_REQUIRED',
        integrated_sha: outcome.record.integrated_sha,
        restart_record: harnessRestartRecordPath(input.runtimeDir, input.incident.incident_id),
      }, attempt);
      return { status: 'RESTART_REQUIRED', record: outcome.record, diagnosis };
    }

    input.onProgress?.({ stage: 'REVALIDATING', detail: input.incident.incident_id });
    await persistRecoveryOutcome(input.runtimeDir, input.incident.incident_id, {
      schema_version: 1, status: 'REMEDIATED', classification: diagnosis.classification,
    }, attempt);
    return { status: 'RESUME', diagnosis };
  }
}
