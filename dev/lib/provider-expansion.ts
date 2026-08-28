/**
 * Expansão humana append-only da profile policy de um runtime já autorizado.
 *
 * O snapshot `lab/authorization.yaml` permanece byte-idêntico. A concessão
 * vive no runtime, registra que a expansão ocorreu DEPOIS da exaustão dos
 * pools originais, e só admite profiles OpenCode Go subscription-only.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalSha256, sha256Hex } from './canonical.js';
import type { HarnessPaths } from './paths.js';
import { loadProfileFromCatalog } from './profile.js';
import type { LoadedProjectRunAuthorization } from './project-authorization.js';
import { ProfilePolicy } from './project-authorization.js';
import {
  listProviderExpansionAuthorizationFiles,
  writeProviderExpansionAuthorizationGrant,
} from './records.js';
import { ProviderExpansionAuthorizationRecord } from './schemas.js';

const GRANT_FILE = /^grant-([0-9a-f]{64})\.json$/;

export class ProviderExpansionAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderExpansionAuthorizationError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function originalSnapshotSha256(sourceFile: string): Promise<string> {
  return sha256Hex(await readFile(sourceFile));
}

async function listOpenCodeGoSubscriptionProfileIds(catalogRoot: string): Promise<string[]> {
  const dir = path.join(path.resolve(catalogRoot), 'dev', 'profiles');
  const entries = await readdir(dir);
  const ids = entries
    .filter((entry) => entry.startsWith('opencode-go-') && entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length))
    .sort();
  const accepted: string[] = [];
  for (const id of ids) {
    const profile = await loadProfileFromCatalog(catalogRoot, id);
    if (profile.agent !== 'opencode') continue;
    if (profile.provider !== 'opencode_go') continue;
    if (profile.billing_mode !== 'subscription_only') continue;
    accepted.push(id);
  }
  return accepted;
}

async function readExistingGrant(
  paths: HarnessPaths,
): Promise<ProviderExpansionAuthorizationRecord | null> {
  const names = await listProviderExpansionAuthorizationFiles(paths);
  const grants: ProviderExpansionAuthorizationRecord[] = [];
  for (const name of names) {
    const match = GRANT_FILE.exec(name);
    if (!match) {
      throw new ProviderExpansionAuthorizationError(
        `arquivo inesperado em expansão de provider: ${name}`,
      );
    }
    const file = path.join(paths.providerExpansionAuthorizationsDir, name);
    try {
      const parsed = ProviderExpansionAuthorizationRecord.parse(
        JSON.parse(await readFile(file, 'utf8')) as unknown,
      );
      if (canonicalSha256(parsed) !== match[1]) {
        throw new ProviderExpansionAuthorizationError(
          `hash da concessão de expansão diverge do nome: ${name}`,
        );
      }
      grants.push(parsed);
    } catch (error) {
      if (error instanceof ProviderExpansionAuthorizationError) throw error;
      throw new ProviderExpansionAuthorizationError(
        `concessão de expansão ilegível (${name}): ${errorMessage(error)}`,
      );
    }
  }
  if (grants.length === 0) return null;
  if (grants.length > 1) {
    throw new ProviderExpansionAuthorizationError(
      'runtime tem mais de uma autorização de expansão de provider',
    );
  }
  return grants[0] ?? null;
}

export async function grantProviderExpansionAuthorization(input: {
  readonly paths: HarnessPaths;
  readonly catalogRoot: string;
  readonly original: LoadedProjectRunAuthorization;
  readonly reason: string;
  readonly exhaustedPools: readonly string[];
  readonly now?: () => string;
}): Promise<{
  readonly record: ProviderExpansionAuthorizationRecord;
  readonly path: string;
  readonly sha256: string;
}> {
  if (input.reason.trim() === '') {
    throw new ProviderExpansionAuthorizationError('reason é obrigatório');
  }
  if (input.exhaustedPools.length === 0) {
    throw new ProviderExpansionAuthorizationError(
      'expansão exige evidência de pelo menos um pool original EXHAUSTED',
    );
  }
  const existing = await readExistingGrant(input.paths);
  if (existing !== null) {
    throw new ProviderExpansionAuthorizationError(
      'já existe autorização de expansão de provider neste runtime',
    );
  }

  const goIds = await listOpenCodeGoSubscriptionProfileIds(input.catalogRoot);
  if (goIds.length === 0) {
    throw new ProviderExpansionAuthorizationError(
      'catálogo não contém profile OpenCode Go subscription-only',
    );
  }

  const originalPolicy = input.original.file.profile_policy;
  const maxRank = Math.max(...originalPolicy.profiles.map((entry) => entry.capability_rank));
  const addedProfiles = goIds.map((id, index) => ({
    id,
    capability_rank: maxRank + 1 + index,
    rationale: 'OpenCode Go subscription-only após exaustão dos pools originalmente autorizados',
  }));

  const record = ProviderExpansionAuthorizationRecord.parse({
    schema_version: 1,
    kind: 'PROVIDER_EXPANSION_AUTHORIZATION',
    expansion_class: 'OPENCODE_GO_SUBSCRIPTION_ONLY',
    added_providers: ['opencode'],
    added_profiles: addedProfiles,
    original_authorization_sha256: await originalSnapshotSha256(input.original.source_file),
    original_allowed_providers: [...originalPolicy.allowed_providers],
    original_profile_ids: originalPolicy.profiles.map((entry) => entry.id),
    exhausted_pools: [...input.exhaustedPools],
    reason: input.reason.trim(),
    granted_at: (input.now ?? (() => new Date().toISOString()))(),
    provenance: 'human_explicit',
  });
  const sha256 = canonicalSha256(record);
  const file = await writeProviderExpansionAuthorizationGrant(input.paths, record, sha256);
  return { record, path: file, sha256 };
}

export async function applyProviderExpansionAuthorization(input: {
  readonly paths: HarnessPaths;
  readonly original: LoadedProjectRunAuthorization;
}): Promise<LoadedProjectRunAuthorization> {
  const grant = await readExistingGrant(input.paths);
  if (grant === null) return input.original;

  const currentSha = await originalSnapshotSha256(input.original.source_file);
  if (currentSha !== grant.original_authorization_sha256) {
    throw new ProviderExpansionAuthorizationError(
      'snapshot de autorização divergiu da concessão de expansão; o yaml original não pode ser editado',
    );
  }
  const originalIds = input.original.file.profile_policy.profiles.map((entry) => entry.id);
  if (originalIds.join('\0') !== grant.original_profile_ids.join('\0')) {
    throw new ProviderExpansionAuthorizationError(
      'profile policy original divergiu da concessão de expansão',
    );
  }

  const merged = ProfilePolicy.parse({
    ...input.original.file.profile_policy,
    allowed_providers: [
      ...input.original.file.profile_policy.allowed_providers,
      ...grant.added_providers.filter(
        (provider) => !input.original.file.profile_policy.allowed_providers.includes(provider),
      ),
    ],
    profiles: [...input.original.file.profile_policy.profiles, ...grant.added_profiles],
  });
  return {
    source_file: input.original.source_file,
    file: {
      ...input.original.file,
      profile_policy: merged,
    },
  };
}
