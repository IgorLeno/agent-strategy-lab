import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { resolveDataDir } from '../../src/project/index.js';
import {
  HumanInstruction,
  ProjectIntakeRequest,
  type HumanInstruction as HumanInstructionRecord,
} from '../../src/intake/index.js';
import { writeFileAtomic, writeJsonOnce } from './atomic.js';
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

export interface LabObservability {
  readonly schema_version: 1;
  readonly instruction_source: 'stdin' | 'file';
  readonly instruction_sha256: string;
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
} {
  return {
    humanInstruction: path.join(runtimeDir, HUMAN_INSTRUCTION_FILE),
    intake: path.join(runtimeDir, PROJECT_INTAKE_FILE),
    authorization: path.join(runtimeDir, AUTHORIZATION_SNAPSHOT_FILE),
    observability: path.join(runtimeDir, OBSERVABILITY_FILE),
    selfTarget: path.join(runtimeDir, SELF_TARGET_FILE),
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

export async function loadAuthorizationSnapshot(file: string): Promise<LoadedProjectRunAuthorization> {
  return loadProjectRunAuthorization(file);
}
