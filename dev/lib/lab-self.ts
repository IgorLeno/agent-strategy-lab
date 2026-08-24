import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { writeJsonOnce } from './atomic.js';
import {
  currentBranch,
  git,
  gitOrThrow,
  GitError,
  headSha,
  isAncestor,
  isWorkingTreeClean,
  repoTopLevel,
  resolveBranchSha,
} from './git.js';

const gitCommitSha = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'SHA-1 de commit em hex minúsculo');

export const SelfTargetIdentity = z
  .object({
    schema_version: z.literal(1),
    controller_sha: gitCommitSha,
    original_ref: z.string().trim().min(1),
    original_main_sha: gitCommitSha,
    target_worktree_path: z.string().trim().min(1),
    self_maintenance_branch: z.string().trim().min(1),
    recorded_base_sha: gitCommitSha,
  })
  .strict();
export type SelfTargetIdentity = z.infer<typeof SelfTargetIdentity>;

export class SelfMaintenanceError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'CONTROL_DIRTY'
      | 'WORKTREE_SETUP'
      | 'EXTERNAL_STATE_DIVERGENCE'
      | 'INTEGRATION_REFUSED'
      | 'PUBLISH_REFUSED',
  ) {
    super(message);
    this.name = 'SelfMaintenanceError';
  }
}

export async function resolveControlRepo(controlRoot: string): Promise<string> {
  return path.resolve(await repoTopLevel(controlRoot));
}

export async function isSameGitRepo(left: string, right: string): Promise<boolean> {
  try {
    return (await resolveControlRepo(left)) === (await resolveControlRepo(right));
  } catch {
    return false;
  }
}

export function selfMaintenanceBranch(runId: string): string {
  return `agentlab/self/${runId}`;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensureIsolatedSelfTarget(input: {
  readonly controlRoot: string;
  readonly runId: string;
  readonly worktreePath: string;
  readonly identityFile: string;
}): Promise<SelfTargetIdentity> {
  const controlRoot = await resolveControlRepo(input.controlRoot);
  if (!(await isWorkingTreeClean(controlRoot))) {
    throw new SelfMaintenanceError(
      'self-maintenance exige o control repo limpo. O working tree do Agent Lab não será usado como alvo.',
      'CONTROL_DIRTY',
    );
  }
  const controllerSha = await headSha(controlRoot);
  const originalRef = (await currentBranch(controlRoot)) ?? 'main';
  const originalMainSha = (await resolveBranchSha(controlRoot, originalRef)) ?? controllerSha;
  const branch = selfMaintenanceBranch(input.runId);
  const worktreePath = path.resolve(input.worktreePath);

  if (await pathExists(input.identityFile)) {
    const existing = SelfTargetIdentity.parse(JSON.parse(await readFile(input.identityFile, 'utf8')));
    if (await pathExists(existing.target_worktree_path)) return existing;
    await gitOrThrow(controlRoot, ['worktree', 'add', existing.target_worktree_path, existing.self_maintenance_branch]);
    return existing;
  }

  const add = await git(controlRoot, [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    controllerSha,
  ]);
  if (add.exitCode !== 0) {
    const listed = await git(controlRoot, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (listed.exitCode !== 0) {
      throw new SelfMaintenanceError(
        `falha ao criar worktree isolado: ${add.stderr.trim() || add.stdout.trim()}`,
        'WORKTREE_SETUP',
      );
    }
    if (!(await pathExists(worktreePath))) {
      await gitOrThrow(controlRoot, ['worktree', 'add', worktreePath, branch]);
    }
  }

  const identity = SelfTargetIdentity.parse({
    schema_version: 1,
    controller_sha: controllerSha,
    original_ref: originalRef,
    original_main_sha: originalMainSha,
    target_worktree_path: worktreePath,
    self_maintenance_branch: branch,
    recorded_base_sha: controllerSha,
  });
  await writeJsonOnce(input.identityFile, identity);
  return identity;
}

export async function loadSelfTargetIdentity(file: string): Promise<SelfTargetIdentity> {
  return SelfTargetIdentity.parse(JSON.parse(await readFile(file, 'utf8')));
}

export async function assertControllerUnchanged(identity: SelfTargetIdentity, controlRoot: string): Promise<void> {
  const root = await resolveControlRepo(controlRoot);
  const current = await resolveBranchSha(root, identity.original_ref);
  if (current !== identity.original_main_sha) {
    throw new SelfMaintenanceError(
      `ref ${identity.original_ref} do control repo divergiu (${identity.original_main_sha} → ${current ?? 'ausente'}). ` +
        'Worktree, branch e evidência foram preservados.',
      'EXTERNAL_STATE_DIVERGENCE',
    );
  }
}

export async function integrateSelfMaintenance(input: {
  readonly controlRoot: string;
  readonly identity: SelfTargetIdentity;
}): Promise<{ readonly status: 'FAST_FORWARD'; readonly integrated_sha: string }> {
  const controlRoot = await resolveControlRepo(input.controlRoot);
  if (!(await isWorkingTreeClean(controlRoot))) {
    throw new SelfMaintenanceError(
      'control repo sujo; integração recusada. Worktree e branch preservados.',
      'INTEGRATION_REFUSED',
    );
  }
  await assertControllerUnchanged(input.identity, controlRoot);

  const targetHead = await headSha(input.identity.target_worktree_path);
  if (!(await isAncestor(controlRoot, input.identity.recorded_base_sha, targetHead))) {
    throw new SelfMaintenanceError(
      'a história do worktree não descende da base gravada; integração recusada.',
      'INTEGRATION_REFUSED',
    );
  }

  try {
    await gitOrThrow(controlRoot, ['merge', '--ff-only', input.identity.self_maintenance_branch]);
  } catch (error) {
    const detail = error instanceof GitError ? error.message : String(error);
    throw new SelfMaintenanceError(
      `fast-forward recusado: ${detail}. Nenhum force/reset foi aplicado.`,
      'INTEGRATION_REFUSED',
    );
  }
  return { status: 'FAST_FORWARD', integrated_sha: await headSha(controlRoot) };
}

export async function publishControlRef(input: {
  readonly controlRoot: string;
  readonly ref: string;
  readonly remote?: string;
}): Promise<{ readonly status: 'PUSHED'; readonly remote: string; readonly ref: string }> {
  const controlRoot = await resolveControlRepo(input.controlRoot);
  const remote = input.remote ?? 'origin';
  const result = await git(controlRoot, ['push', remote, input.ref]);
  if (result.exitCode !== 0) {
    throw new SelfMaintenanceError(
      `git push recusado (sem force): ${result.stderr.trim() || result.stdout.trim()}`,
      'PUBLISH_REFUSED',
    );
  }
  return { status: 'PUSHED', remote, ref: input.ref };
}
