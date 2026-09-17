import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { resolveDataDir } from '../../src/project/index.js';
import {
  AgentLabRunDirectiveHeader,
  HumanInstruction,
  ProjectIntakeRequest,
  type HumanInstruction as HumanInstructionRecord,
} from '../../src/intake/index.js';
import type { ResolvedPublishGrant } from './run-directive-auth.js';
import { writeFileAtomic, writeJsonAtomic, writeJsonOnce } from './atomic.js';
import {
  IncidentDiagnosis,
  RecoveryIncident,
  RecoveryMode,
  type RecoveryBudgetUsage,
  type RecoveryMode as RecoveryModeValue,
} from './incident-recovery.js';
import { resolveHarnessInstallationRoot, resolveHarnessPaths, type HarnessPaths } from './paths.js';
import {
  loadProjectRunAuthorization,
  type LoadedProjectRunAuthorization,
} from './project-authorization.js';

export const HUMAN_INSTRUCTION_FILE = 'lab/human-instruction.json';
export const PROJECT_INTAKE_FILE = 'lab/project-intake.yaml';
export const AUTHORIZATION_SNAPSHOT_FILE = 'lab/authorization.yaml';
export const OBSERVABILITY_FILE = 'lab/observability.json';
export const SELF_TARGET_FILE = 'lab/self-target.json';
export const RUN_DIRECTIVE_FILE = 'lab/run-directive.txt';
export const RUN_DIRECTIVE_HEADER_FILE = 'lab/run-directive-header.yaml';
export const PUBLISH_GRANT_FILE = 'lab/publish-grant.json';
export const INCIDENTS_DIR = 'incidents';
export const RECOVERY_PENDING_FILE = 'incidents/pending.json';

export interface LabObservability {
  readonly schema_version: 1;
  readonly instruction_source: 'stdin' | 'file';
  readonly instruction_sha256: string;
  readonly run_directive_sha256?: string;
  readonly directive_format?: 'agentlab-v1' | 'legacy';
  readonly target_type: 'external' | 'self';
  readonly controller_sha: string;
  readonly intake_compiler_profile: string;
  readonly planner_profile: string;
  readonly policy_preset: string;
}

export function repoIdentity(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo';
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return `${base}-${digest}`;
}

export function instructionRunId(instructionHash: string, baseSha: string): string {
  return `${instructionHash.slice(0, 16)}-${baseSha.slice(0, 12)}`;
}

export function resolveLabRunsRoot(input: {
  readonly controlRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  const env = input.env ?? process.env;
  const explicit = env['AGENTLAB_RUNS_DIR']?.trim();
  if (explicit !== undefined && explicit.length > 0) return path.resolve(explicit);
  const controlRoot = input.controlRoot ?? resolveHarnessInstallationRoot();
  return path.join(resolveDataDir({ labRoot: controlRoot, env }), 'project-runs');
}

export function deriveRuntimeDir(input: {
  readonly controlRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
  readonly instructionHash: string;
  readonly baseSha: string;
  readonly targetType: 'external' | 'self';
}): string {
  const runsRoot = resolveLabRunsRoot(input);
  const repo = input.targetType === 'self' ? 'self' : repoIdentity(input.repoRoot);
  return path.join(runsRoot, repo, instructionRunId(input.instructionHash, input.baseSha));
}

export function labArtifactPaths(runtimeDir: string): {
  readonly humanInstruction: string;
  readonly intake: string;
  readonly authorization: string;
  readonly observability: string;
  readonly selfTarget: string;
  readonly runDirective: string;
  readonly runDirectiveHeader: string;
  readonly publishGrant: string;
} {
  return {
    humanInstruction: path.join(runtimeDir, HUMAN_INSTRUCTION_FILE),
    intake: path.join(runtimeDir, PROJECT_INTAKE_FILE),
    authorization: path.join(runtimeDir, AUTHORIZATION_SNAPSHOT_FILE),
    observability: path.join(runtimeDir, OBSERVABILITY_FILE),
    selfTarget: path.join(runtimeDir, SELF_TARGET_FILE),
    runDirective: path.join(runtimeDir, RUN_DIRECTIVE_FILE),
    runDirectiveHeader: path.join(runtimeDir, RUN_DIRECTIVE_HEADER_FILE),
    publishGrant: path.join(runtimeDir, PUBLISH_GRANT_FILE),
  };
}

export function incidentArtifactPaths(runtimeDir: string, incidentId: string): {
  readonly root: string;
  readonly incident: string;
  readonly decision: string;
  readonly diagnosis: string;
  readonly outcome: string;
} {
  const root = path.join(runtimeDir, INCIDENTS_DIR, incidentId);
  return {
    root,
    incident: path.join(root, 'incident.json'),
    decision: path.join(root, 'user-decision.json'),
    diagnosis: path.join(root, 'diagnosis.json'),
    outcome: path.join(root, 'final-outcome.json'),
  };
}

/**
 * Slot append-only POR CICLO. `incident.json` é o único fato imutável de um
 * incidente; decisão, diagnóstico e desfecho podem legitimamente DIVERGIR
 * entre ciclos de remediação do MESMO incidente (orçamento de step 7 permite
 * até `max_remediation_cycles`), e um arquivo write-once fixo não sobrevive a
 * um segundo ciclo com desfecho diferente do primeiro. Cada ciclo grava no seu
 * próprio slot numerado; nenhum arquivo já escrito é sobrescrito.
 */
export function incidentAttemptPaths(
  runtimeDir: string,
  incidentId: string,
  attempt: number,
): { readonly decision: string; readonly diagnosis: string; readonly outcome: string } {
  const root = path.join(incidentArtifactPaths(runtimeDir, incidentId).root, 'attempts', String(attempt));
  return {
    decision: path.join(root, 'user-decision.json'),
    diagnosis: path.join(root, 'diagnosis.json'),
    outcome: path.join(root, 'final-outcome.json'),
  };
}

/** `null` quando este incidente ainda não foi persistido neste runtime. */
export async function loadRecoveryIncident(
  runtimeDir: string,
  incidentId: string,
): Promise<RecoveryIncident | null> {
  const file = incidentArtifactPaths(runtimeDir, incidentId).incident;
  if (!(await pathExists(file))) return null;
  return RecoveryIncident.parse(JSON.parse(await readFile(file, 'utf8')));
}

export async function persistRecoveryIncident(input: {
  readonly runtimeDir: string;
  readonly incident: RecoveryIncident;
  readonly mode: RecoveryModeValue;
}): Promise<void> {
  const { runtimeDir, incident, mode } = input;
  const paths = incidentArtifactPaths(runtimeDir, incident.incident_id);
  await writeJsonOnce(paths.incident, incident);
  await writeJsonAtomic(path.join(runtimeDir, RECOVERY_PENDING_FILE), {
    schema_version: 1,
    incident_id: incident.incident_id,
    fingerprint: incident.fingerprint,
    mode: RecoveryMode.parse(mode),
  });
}

export async function persistRecoveryDecision(
  runtimeDir: string,
  incidentId: string,
  decision: 'investigate' | 'stop',
  attempt?: number,
): Promise<void> {
  const file =
    attempt === undefined
      ? incidentArtifactPaths(runtimeDir, incidentId).decision
      : incidentAttemptPaths(runtimeDir, incidentId, attempt).decision;
  await writeJsonOnce(file, { schema_version: 1, decision });
}

export async function persistIncidentDiagnosis(
  runtimeDir: string,
  incidentId: string,
  diagnosis: IncidentDiagnosis,
  attempt?: number,
): Promise<void> {
  const file =
    attempt === undefined
      ? incidentArtifactPaths(runtimeDir, incidentId).diagnosis
      : incidentAttemptPaths(runtimeDir, incidentId, attempt).diagnosis;
  await writeJsonOnce(file, IncidentDiagnosis.parse(diagnosis));
}

export async function persistRecoveryOutcome(
  runtimeDir: string,
  incidentId: string,
  outcome: Record<string, unknown>,
  attempt?: number,
): Promise<void> {
  const file =
    attempt === undefined
      ? incidentArtifactPaths(runtimeDir, incidentId).outcome
      : incidentAttemptPaths(runtimeDir, incidentId, attempt).outcome;
  await writeJsonOnce(file, outcome);
}

export interface RecoveryUsageRecord {
  readonly schema_version: 1;
  readonly investigator_launches: number;
  readonly remediation_cycles: number;
}

const EMPTY_RECOVERY_USAGE: RecoveryUsageRecord = {
  schema_version: 1,
  investigator_launches: 0,
  remediation_cycles: 0,
};

function recoveryUsagePath(runtimeDir: string, incidentId: string): string {
  return path.join(incidentArtifactPaths(runtimeDir, incidentId).root, 'usage.json');
}

export async function loadRecoveryUsage(runtimeDir: string, incidentId: string): Promise<RecoveryUsageRecord> {
  const file = recoveryUsagePath(runtimeDir, incidentId);
  if (!(await pathExists(file))) return EMPTY_RECOVERY_USAGE;
  return JSON.parse(await readFile(file, 'utf8')) as RecoveryUsageRecord;
}

/**
 * Contador MUTÁVEL, ao contrário do resto dos artifacts de incident (que são
 * append-only). É o único jeito de o orçamento de step 7 sobreviver a
 * múltiplas invocações de `coordinateIncidentRecovery` para o MESMO
 * incident_id (mesma fingerprint), atravessando resumes e crashes.
 */
export async function incrementRecoveryUsage(
  runtimeDir: string,
  incidentId: string,
  delta: { readonly investigator_launch?: boolean; readonly remediation_cycle?: boolean },
): Promise<RecoveryUsageRecord> {
  const current = await loadRecoveryUsage(runtimeDir, incidentId);
  const next: RecoveryUsageRecord = {
    schema_version: 1,
    investigator_launches: current.investigator_launches + (delta.investigator_launch === true ? 1 : 0),
    remediation_cycles: current.remediation_cycles + (delta.remediation_cycle === true ? 1 : 0),
  };
  await writeJsonAtomic(recoveryUsagePath(runtimeDir, incidentId), next);
  return next;
}

/**
 * Orçamento REAL do incidente identificado por `fingerprint`, lido do runtime
 * persistido — nunca reconstruído em memória.
 *
 * `previous_fingerprints` é TODA fingerprint já persistida neste runtime,
 * INCLUINDO a atual: por construção, `persistRecoveryIncident` já escreveu
 * `incident.json` antes deste load ser chamado, então uma fingerprint que
 * RECORRE (o mesmo defeito, mesma task, mesma evidência) sempre aparece aqui
 * a partir da sua primeira persistência — é esse sinal, combinado com
 * `remediation_cycles` já no teto, que `recoveryBudgetStatus` usa para provar
 * "esta fingerprint sobreviveu ao orçamento", não uma comparação com
 * incidentes IRMÃOS.
 */
export async function loadRecoveryBudgetUsage(
  runtimeDir: string,
  fingerprint: string,
): Promise<RecoveryBudgetUsage> {
  const incidentsRoot = path.join(runtimeDir, INCIDENTS_DIR);
  let entries: string[] = [];
  try {
    // `incidents/pending.json` é um ARQUIVO irmão, não um diretório de
    // incidente: só entradas que são diretório podem conter `incident.json`.
    entries = (await readdir(incidentsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const allFingerprints: string[] = [];
  let usage: RecoveryUsageRecord = EMPTY_RECOVERY_USAGE;
  for (const entry of entries) {
    const incidentFile = path.join(incidentsRoot, entry, 'incident.json');
    if (!(await pathExists(incidentFile))) continue;
    const parsed = RecoveryIncident.safeParse(JSON.parse(await readFile(incidentFile, 'utf8')));
    if (!parsed.success) continue;
    allFingerprints.push(parsed.data.fingerprint);
    if (parsed.data.fingerprint === fingerprint) {
      usage = await loadRecoveryUsage(runtimeDir, entry);
    }
  }
  return {
    investigator_launches: usage.investigator_launches,
    remediation_cycles: usage.remediation_cycles,
    previous_fingerprints: allFingerprints,
  };
}

export function labHarnessPaths(input: {
  readonly repoRoot: string;
  readonly runtimeDir: string;
  readonly profileCatalogRoot?: string;
}): HarnessPaths {
  const base = resolveHarnessPaths(input.repoRoot, {
    devDir: input.runtimeDir,
    planFile: path.join(input.runtimeDir, 'project', 'generated-plan.yaml'),
    profileCatalogRoot: input.profileCatalogRoot ?? resolveHarnessInstallationRoot(),
  });
  return base;
}

export async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function persistHumanInstruction(
  file: string,
  instruction: HumanInstructionRecord,
): Promise<void> {
  await writeJsonOnce(file, instruction);
}

export async function loadHumanInstruction(file: string): Promise<HumanInstructionRecord> {
  return HumanInstruction.parse(JSON.parse(await readFile(file, 'utf8')));
}

export async function persistProjectIntake(file: string, yaml: string): Promise<void> {
  await writeFileAtomic(file, yaml.endsWith('\n') ? yaml : `${yaml}\n`);
}

export async function loadPersistedIntake(file: string): Promise<ProjectIntakeRequest> {
  return ProjectIntakeRequest.parse(parseYaml(await readFile(file, 'utf8')));
}

export async function persistObservability(file: string, record: LabObservability): Promise<void> {
  await writeJsonOnce(file, record);
}

/** Persiste a Run Directive original após a política canônica de texto. */
export async function persistRunDirective(file: string, raw: string): Promise<void> {
  await writeFileAtomic(file, raw);
}

export async function loadPersistedRunDirective(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

export async function persistRunDirectiveHeader(
  file: string,
  header: AgentLabRunDirectiveHeader,
): Promise<void> {
  await writeFileAtomic(file, stringifyYaml(header));
}

/**
 * `null` cobre tanto "sem header" (directive legado) quanto "arquivo ausente"
 * — resume não trata as duas coisas como erro, e o chamador cai no default de
 * sessão (`recoveryModeForSession`) como já fazia antes deste loader existir.
 */
export async function loadPersistedRunDirectiveHeader(
  file: string,
): Promise<AgentLabRunDirectiveHeader | null> {
  if (!(await pathExists(file))) return null;
  return AgentLabRunDirectiveHeader.parse(parseYaml(await readFile(file, 'utf8')));
}

export async function persistPublishGrant(file: string, grant: ResolvedPublishGrant): Promise<void> {
  await writeJsonOnce(file, grant);
}

export async function loadPublishGrant(file: string): Promise<ResolvedPublishGrant | null> {
  if (!(await pathExists(file))) return null;
  const parsed = JSON.parse(await readFile(file, 'utf8')) as ResolvedPublishGrant;
  if (typeof parsed.allowed !== 'boolean' || typeof parsed.remote !== 'string' || typeof parsed.ref !== 'string') {
    throw new Error(`publish grant inválido em ${file}`);
  }
  return parsed;
}

export async function loadAuthorizationSnapshot(file: string): Promise<LoadedProjectRunAuthorization> {
  return loadProjectRunAuthorization(file);
}
