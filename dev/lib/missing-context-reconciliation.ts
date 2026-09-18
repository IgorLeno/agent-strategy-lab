import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { writeFileOnce, writeJsonOnce } from './atomic.js';
import { canonicalSha256, sha256Hex } from './canonical.js';
import { git, worktreePaths } from './git.js';
import { incidentArtifactPaths } from './lab-runtime.js';
import type { HarnessPaths } from './paths.js';

export const MISSING_CONTEXT_LIMITS = {
  requested_paths: 32,
  worktrees: 16,
  local_refs: 64,
  previous_runtimes: 32,
  matches: 16,
  artifact_bytes: 1_048_576,
  walked_files: 512,
} as const;

interface FoundArtifact {
  readonly source: 'current_checkout' | 'repository_docs' | 'worktree' | 'local_ref' | 'git_history' | 'previous_runtime';
  readonly locator: string;
  readonly relative_path: string;
  readonly bytes: Buffer;
}

interface ManifestMatch {
  readonly source: FoundArtifact['source'];
  readonly locator: string;
  readonly relative_path: string;
  readonly size: number;
  readonly sha256: string;
  readonly materialized_path: string;
}

export type MissingContextResolution =
  | { readonly status: 'FOUND_RECOVERABLE'; readonly evidence_paths: readonly string[]; readonly manifest_path: string }
  | { readonly status: 'NOT_FOUND_BUT_RECONSTRUCTIBLE'; readonly evidence_paths: readonly string[]; readonly manifest_path: string }
  | { readonly status: 'NOT_FOUND_REQUIRES_HUMAN'; readonly reason: string; readonly human_authority: string; readonly manifest_path: string }
  | { readonly status: 'NOT_FOUND_TECHNICAL'; readonly reason: string; readonly manifest_path: string };

function relativeCandidate(repoRoot: string, requested: string): string | null {
  const repoRelative = path.isAbsolute(requested) ? path.relative(repoRoot, requested) : requested;
  const relative = repoRelative.startsWith(`..${path.sep}`) || repoRelative === '..'
    ? path.basename(requested)
    : repoRelative;
  const normalized = path.normalize(relative);
  if (normalized === '' || normalized === '.' || path.isAbsolute(normalized) || normalized.startsWith(`..${path.sep}`) || normalized === '..') {
    return null;
  }
  return normalized;
}

async function fileArtifact(
  source: FoundArtifact['source'],
  locator: string,
  root: string,
  relativePath: string,
): Promise<FoundArtifact | null> {
  const file = path.resolve(root, relativePath);
  const relative = path.relative(root, file);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  try {
    const facts = await stat(file);
    if (!facts.isFile() || facts.size > MISSING_CONTEXT_LIMITS.artifact_bytes) return null;
    return { source, locator, relative_path: relativePath, bytes: await readFile(file) };
  } catch {
    return null;
  }
}

async function boundedMatches(
  root: string,
  candidates: readonly string[],
  source: FoundArtifact['source'],
  locator: string,
): Promise<FoundArtifact[]> {
  const basenames = new Set(candidates.map((candidate) => path.basename(candidate)));
  const found: FoundArtifact[] = [];
  const queue = [''];
  let seen = 0;
  while (queue.length > 0 && seen < MISSING_CONTEXT_LIMITS.walked_files && found.length < MISSING_CONTEXT_LIMITS.matches) {
    const relativeDir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (seen >= MISSING_CONTEXT_LIMITS.walked_files) break;
      seen += 1;
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) queue.push(relative);
      else if (entry.isFile() && (basenames.has(entry.name) || candidates.includes(relative))) {
        const artifact = await fileArtifact(source, locator, root, relative);
        if (artifact !== null) found.push(artifact);
      }
      if (found.length >= MISSING_CONTEXT_LIMITS.matches) break;
    }
  }
  return found;
}

async function gitArtifact(
  repoRoot: string,
  source: 'local_ref' | 'git_history',
  ref: string,
  relativePath: string,
): Promise<FoundArtifact | null> {
  const result = await git(repoRoot, ['show', `${ref}:${relativePath}`]);
  if (result.exitCode !== 0) return null;
  const bytes = Buffer.from(result.stdout, 'utf8');
  if (bytes.byteLength > MISSING_CONTEXT_LIMITS.artifact_bytes) return null;
  return { source, locator: ref, relative_path: relativePath, bytes };
}

async function persistManifest(input: {
  readonly runtimeDir: string;
  readonly incidentId: string;
  readonly requestedPaths: readonly string[];
  readonly matches: readonly FoundArtifact[];
}): Promise<{ readonly manifestPath: string; readonly matches: readonly ManifestMatch[] }> {
  const root = path.join(incidentArtifactPaths(input.runtimeDir, input.incidentId).root, 'reconciliation');
  const materialized: ManifestMatch[] = [];
  for (const match of input.matches.slice(0, MISSING_CONTEXT_LIMITS.matches)) {
    const sha256 = sha256Hex(match.bytes);
    const artifactPath = path.join(root, 'artifacts', `${sha256}-${path.basename(match.relative_path)}`);
    await writeFileOnce(artifactPath, match.bytes);
    materialized.push({
      source: match.source,
      locator: match.locator,
      relative_path: match.relative_path,
      size: match.bytes.byteLength,
      sha256,
      materialized_path: artifactPath,
    });
  }
  const body = {
    schema_version: 1,
    incident_id: input.incidentId,
    requested_paths: [...input.requestedPaths],
    limits: MISSING_CONTEXT_LIMITS,
    matches: materialized,
  };
  const manifestPath = path.join(root, `${canonicalSha256(body)}.json`);
  await writeJsonOnce(manifestPath, body);
  return { manifestPath, matches: materialized };
}

/** Bounded, local-only search. It materializes bytes; it never invents missing content. */
export async function reconcileMissingContext(input: {
  readonly paths: HarnessPaths;
  readonly runtimeDir: string;
  readonly incidentId: string;
  readonly requestedPaths: readonly string[];
}): Promise<MissingContextResolution> {
  const candidates = [...new Set(
    input.requestedPaths
      .slice(0, MISSING_CONTEXT_LIMITS.requested_paths)
      .map((requested) => relativeCandidate(input.paths.repoRoot, requested))
      .filter((value): value is string => value !== null),
  )];
  const found: FoundArtifact[] = [];
  const append = (artifacts: readonly FoundArtifact[]): void => {
    for (const artifact of artifacts) {
      if (found.length >= MISSING_CONTEXT_LIMITS.matches) return;
      if (!found.some((candidate) => candidate.source === artifact.source && candidate.locator === artifact.locator && candidate.relative_path === artifact.relative_path)) {
        found.push(artifact);
      }
    }
  };

  for (const candidate of candidates) {
    const artifact = await fileArtifact('current_checkout', input.paths.repoRoot, input.paths.repoRoot, candidate);
    if (artifact !== null) append([artifact]);
  }
  append(await boundedMatches(path.join(input.paths.repoRoot, 'docs'), candidates, 'repository_docs', input.paths.repoRoot));

  const worktrees = await worktreePaths(input.paths.repoRoot).catch(() => [] as readonly string[]);
  for (const worktree of worktrees.slice(0, MISSING_CONTEXT_LIMITS.worktrees)) {
    for (const candidate of candidates) {
      const artifact = await fileArtifact('worktree', worktree, worktree, candidate);
      if (artifact !== null) append([artifact]);
    }
  }

  const refsResult = await git(input.paths.repoRoot, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']);
  const refs = refsResult.exitCode === 0 ? refsResult.stdout.split('\n').filter(Boolean).slice(0, MISSING_CONTEXT_LIMITS.local_refs) : [];
  for (const ref of refs) for (const candidate of candidates) {
    const artifact = await gitArtifact(input.paths.repoRoot, 'local_ref', ref, candidate);
    if (artifact !== null) append([artifact]);
  }
  const historyResult = await git(input.paths.repoRoot, ['rev-list', '--all', `--max-count=${MISSING_CONTEXT_LIMITS.local_refs}`]);
  const commits = historyResult.exitCode === 0 ? historyResult.stdout.split('\n').filter(Boolean) : [];
  for (const commit of commits) for (const candidate of candidates) {
    const artifact = await gitArtifact(input.paths.repoRoot, 'git_history', commit, candidate);
    if (artifact !== null) append([artifact]);
  }

  const runtimeGroup = path.dirname(input.runtimeDir);
  let runtimeEntries: Dirent[];
  try {
    runtimeEntries = await readdir(runtimeGroup, { withFileTypes: true });
  } catch {
    runtimeEntries = [];
  }
  const previous = runtimeEntries
    .filter((entry) => entry.isDirectory() && path.join(runtimeGroup, entry.name) !== input.runtimeDir)
    .map((entry) => path.join(runtimeGroup, entry.name))
    .sort()
    .slice(0, MISSING_CONTEXT_LIMITS.previous_runtimes);
  for (const runtime of previous) append(await boundedMatches(runtime, candidates, 'previous_runtime', runtime));

  const persisted = await persistManifest({
    runtimeDir: input.runtimeDir,
    incidentId: input.incidentId,
    requestedPaths: input.requestedPaths,
    matches: found,
  });
  if (persisted.matches.length === 0) {
    return {
      status: 'NOT_FOUND_TECHNICAL',
      reason: 'nenhuma evidência correspondente foi encontrada nas fontes locais autorizadas e limitadas',
      manifest_path: persisted.manifestPath,
    };
  }
  return {
    status: 'FOUND_RECOVERABLE',
    evidence_paths: [persisted.manifestPath, ...persisted.matches.map((match) => match.materialized_path)],
    manifest_path: persisted.manifestPath,
  };
}
