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
import { grantAdditionalRepairAuthorization } from './automatic-repair.js';
import type { IncidentRemediationPort, RemediationOutcome } from './incident-recovery-coordinator.js';
import type { IncidentDiagnosis, RecoveryIncident } from './incident-recovery.js';
import { withHarnessLock } from './lock.js';
import { reconcileMissingContext } from './missing-context-reconciliation.js';
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
 * MISSING_CONTEXT: procura em fontes locais autorizadas, materializa a
 * evidência encontrada no runtime atual e pede uma única reinvestigação. Se
 * algo continua ausente, isto é uma falha técnica — não existe HumanAuthority
 * real para "não achamos o arquivo", então isto vira BLOCKED, nunca um
 * HUMAN_REQUIRED fabricado.
 */
export async function remediateMissingContext(input: {
  readonly paths: HarnessPaths;
  readonly incident: RecoveryIncident;
  readonly diagnosis: IncidentDiagnosis;
}): Promise<RemediationOutcome> {
  const resolution = await reconcileMissingContext({
    paths: input.paths,
    runtimeDir: input.incident.runtime_dir,
    incidentId: input.incident.incident_id,
    requestedPaths: [...new Set([
      ...input.incident.evidence_paths,
      ...input.diagnosis.evidence.map((evidence) => evidence.path),
    ])],
  });
  if (resolution.status === 'FOUND_RECOVERABLE' || resolution.status === 'NOT_FOUND_BUT_RECONSTRUCTIBLE') {
    return { status: 'REINVESTIGATE', evidence_paths: resolution.evidence_paths };
  }
  return { status: 'FAILED', reason: resolution.reason };
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
          return remediateMissingContext({ paths: deps.paths, incident, diagnosis });
        case 'HARNESS':
          return deps.harness({ incident, diagnosis });
        case 'ENVIRONMENT':
          return {
            status: 'FAILED',
            reason:
              'ENVIRONMENT permanece técnico: não há primitive canônica de preflight/reinspection que aceite este incidente com pré-condições persistidas suficientes; nenhuma mutação foi tentada',
          };
        case 'PROVIDER':
          return {
            status: 'FAILED',
            reason:
              'PROVIDER permanece técnico: retry/failover é interno ao lifecycle e à profile_policy persistida; não há primitive autônoma segura para este incidente e nenhuma expansão foi concedida',
          };
        default:
          return {
            status: 'FAILED',
            reason: `remediação automática para classification=${diagnosis.classification} ainda não existe; nenhuma correção foi tentada`,
          };
      }
    },
  };
}
