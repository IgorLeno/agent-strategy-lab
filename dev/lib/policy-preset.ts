import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { RequestedScope } from '../../src/intake/index.js';
import {
  ProjectAuthorizationError,
  ProjectRunAuthorizationFile,
  type ProjectRunAuthorizationFile as AuthorizationFile,
} from './project-authorization.js';
import { resolveHarnessInstallationRoot } from './paths.js';

export const DEFAULT_POLICY_PRESET = 'local-autonomous-development';
export const FAKE_POLICY_PRESET = 'local-autonomous-development-fake';

const PRESET_FILES: Readonly<Record<string, string>> = {
  [DEFAULT_POLICY_PRESET]: 'local-autonomous-development.yaml',
  [`${DEFAULT_POLICY_PRESET}.v1`]: 'local-autonomous-development.yaml',
  [FAKE_POLICY_PRESET]: 'local-autonomous-development-fake.yaml',
};

export function resolvePolicyPresetName(input: {
  readonly requested?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): string {
  if (input.requested !== undefined && input.requested.length > 0) return input.requested;
  const env = input.env ?? process.env;
  if ((env['AGENTLAB_FAKE_MODE'] ?? '').trim() !== '') return FAKE_POLICY_PRESET;
  return DEFAULT_POLICY_PRESET;
}

export function policyPresetCatalogRoot(controlRoot?: string): string {
  return path.join(controlRoot ?? resolveHarnessInstallationRoot(), 'dev', 'presets');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stripPresetMetadata(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectAuthorizationError('preset precisa ser um objeto YAML');
  }
  const { id: _id, preset_version: _presetVersion, ...rest } = value as Record<string, unknown>;
  return rest;
}

async function readYaml(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new ProjectAuthorizationError(`preset ilegível em ${file}: ${describe(error)}`);
  }
  try {
    return parseYaml(raw);
  } catch (error) {
    throw new ProjectAuthorizationError(`YAML inválido em ${file}: ${describe(error)}`);
  }
}

/**
 * Carrega o preset versionado. O overlay fake só troca billing/profiles;
 * a ladder humana e o boundary vêm do preset real.
 */
export async function loadPolicyPreset(
  name: string,
  catalogRoot = policyPresetCatalogRoot(),
): Promise<{ readonly name: string; readonly file: AuthorizationFile }> {
  const relative = PRESET_FILES[name];
  if (relative === undefined) {
    throw new ProjectAuthorizationError(
      `preset desconhecido: ${name}. Presets: ${Object.keys(PRESET_FILES).join(', ')}.`,
    );
  }
  const base = stripPresetMetadata(await readYaml(path.join(catalogRoot, PRESET_FILES[DEFAULT_POLICY_PRESET] as string)));
  const selected =
    name === DEFAULT_POLICY_PRESET || name === `${DEFAULT_POLICY_PRESET}.v1`
      ? base
      : {
          ...base,
          ...stripPresetMetadata(await readYaml(path.join(catalogRoot, relative))),
        };

  const parsed = ProjectRunAuthorizationFile.safeParse(selected);
  if (!parsed.success) {
    throw new ProjectAuthorizationError(
      `preset ${name} inválido: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return { name, file: parsed.data };
}

export function materializeAuthorization(input: {
  readonly preset: AuthorizationFile;
  readonly requested_scope: RequestedScope;
}): AuthorizationFile {
  return ProjectRunAuthorizationFile.parse({
    ...input.preset,
    requested_scope: input.requested_scope,
  });
}

export function authorizationYaml(file: AuthorizationFile): string {
  return stringifyYaml(file);
}
