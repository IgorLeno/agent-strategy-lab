/**
 * Estratégias de remediação por classification.
 *
 * TARGET_PROJECT e MISSING_CONTEXT são autocontidas aqui. HARNESS não é: ela
 * precisa compor `submitHumanInstruction`/`resumeHumanInstruction`, que vivem
 * em dev/lib/lab.ts — e lab.ts é quem monta a porta padrão de recovery. Para
 * não criar um ciclo de import, HARNESS entra por injeção de dependência
 * (`deps.harness`), implementada em lab.ts.
 *
 * Nenhuma estratégia aqui lança provider, publica ou expande escopo: repair é
 * só um GRANT sobre a primitive oficial já existente (`project-run.ts`
 * consome o grant sozinho no próximo `runProject`); reconciliação de
 * MISSING_CONTEXT só CONFIRMA presença de evidência, nunca inventa conteúdo.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { grantAdditionalRepairAuthorization } from './automatic-repair.js';
import type { IncidentRemediationPort, RemediationOutcome } from './incident-recovery-coordinator.js';
import type { IncidentDiagnosis, RecoveryIncident } from './incident-recovery.js';
import { withHarnessLock } from './lock.js';
import type { HarnessPaths } from './paths.js';

/**
 * TARGET_PROJECT: concede UMA tentativa adicional de repair para a task já
 * identificada pelo lifecycle. Não relança nada aqui — quem consome o grant é
 * `decideAutomaticRepair` na próxima invocação de `runProject` sobre o mesmo
 * runtime, que é a MESMA primitive que o operador usaria manualmente via
 * `authorizeAdditionalRepairForRuntime`.
 */
export async function remediateTargetProject(input: {
  readonly paths: HarnessPaths;
  readonly incident: RecoveryIncident;
  readonly diagnosis: IncidentDiagnosis;
}): Promise<RemediationOutcome> {
  if (input.incident.task_id === null) {
    return {
      status: 'FAILED',
      reason: 'remediação TARGET_PROJECT exige um task_id e o incidente não registrou nenhum',
    };
  }
  try {
    await withHarnessLock(input.paths, 'incident-recovery-repair', () =>
      grantAdditionalRepairAuthorization({
        paths: input.paths,
        taskId: input.incident.task_id as string,
        reason: `incident recovery ${input.incident.incident_id}: ${input.diagnosis.root_cause}`,
      }),
    );
  } catch (error) {
    return {
      status: 'FAILED',
      reason: `grant de repair adicional falhou: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { status: 'REMEDIATED' };
}

/**
 * MISSING_CONTEXT: só CONFIRMA presença de evidência (leitura read-only). Se
 * algo continua ausente, isto é uma falha técnica — não existe HumanAuthority
 * real para "não achamos o arquivo", então isto vira BLOCKED, nunca um
 * HUMAN_REQUIRED fabricado.
 */
export async function remediateMissingContext(input: {
  readonly incident: RecoveryIncident;
}): Promise<RemediationOutcome> {
  const missing: string[] = [];
  for (const evidencePath of input.incident.evidence_paths) {
    try {
      await access(path.resolve(evidencePath));
    } catch {
      missing.push(evidencePath);
    }
  }
  if (missing.length > 0) {
    return {
      status: 'FAILED',
      reason: `evidência ainda ausente e não reconstruível automaticamente: ${missing.join(', ')}`,
    };
  }
  return { status: 'REMEDIATED' };
}

export interface IncidentRemediationDependencies {
  readonly paths: HarnessPaths;
  /** Implementado em lab.ts: compõe self-maintenance isolada sem duplicar o pipeline --self. */
  readonly harness: (input: {
    readonly incident: RecoveryIncident;
    readonly diagnosis: IncidentDiagnosis;
  }) => Promise<RemediationOutcome>;
}

export function createDefaultIncidentRemediationPort(
  deps: IncidentRemediationDependencies,
): IncidentRemediationPort {
  return {
    async remediate({ incident, diagnosis }) {
      switch (diagnosis.classification) {
        case 'TARGET_PROJECT':
          return remediateTargetProject({ paths: deps.paths, incident, diagnosis });
        case 'MISSING_CONTEXT':
          return remediateMissingContext({ incident });
        case 'HARNESS':
          return deps.harness({ incident, diagnosis });
        default:
          return {
            status: 'FAILED',
            reason: `remediação automática para classification=${diagnosis.classification} ainda não existe; nenhuma correção foi tentada`,
          };
      }
    },
  };
}
