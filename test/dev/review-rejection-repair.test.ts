import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  finalizationFingerprint,
  validationResultsFingerprint,
} from '../../dev/lib/candidate-review.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import {
  candidateReviewPath,
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  readReviewRejectedAttempt,
  writeCandidateReview,
  writeOrchestratedFinalization,
} from '../../dev/lib/records.js';
import {
  readPreviousAttemptDiagnostics,
  retryReviewRejectedAttempt,
} from '../../dev/lib/retry-failed.js';
import {
  CandidateReviewRecord,
  type OrchestratedFinalizationRecord,
} from '../../dev/lib/schemas.js';
import { ensureRuntimeDirs, getTaskState, readState, writeState } from '../../dev/lib/state.js';

const exec = promisify(execFile);
const NOW = '2026-08-27T12:00:00.000Z';

let root: string;
let paths: HarnessPaths;
let baseSha: string;
let candidateSha: string;

async function git(args: readonly string[]): Promise<string> {
  const result = await exec('git', args, { cwd: root });
  return result.stdout.trim();
}

async function seedRejectedCandidate(): Promise<{
  finalization: OrchestratedFinalizationRecord;
  reviewBytes: Buffer;
}> {
  await writeFile(path.join(root, '.gitignore'), '.dev/\n.dev-inbox/\n');
  await writeFile(path.join(root, 'src.txt'), 'base\n');
  await git(['add', '.gitignore', 'src.txt']);
  await git(['commit', '-m', 'base']);
  baseSha = await git(['rev-parse', 'HEAD']);

  await writeFile(path.join(root, 'src.txt'), 'candidate rejeitado\n');
  await git(['add', 'src.txt']);
  await git(['commit', '-m', 'candidate']);
  candidateSha = await git(['rev-parse', 'HEAD']);

  const reportBytes = Buffer.from('{"worker":"success"}\n');
  const handoffBytes = Buffer.from('{"handoff":"attempt-1"}\n');
  const inbox = path.join(paths.inboxDir, 'T1');
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, 'report.json'), reportBytes);
  await writeFile(path.join(inbox, 'handoff-draft.json'), handoffBytes);

  const { createHash } = await import('node:crypto');
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
  const finalization: OrchestratedFinalizationRecord = {
    schema_version: 1,
    task_id: 'T1',
    attempt: 1,
    base_sha: baseSha,
    profile_id: 'fake-worker-v1',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    report_sha256: sha256(reportBytes),
    handoff_draft_sha256: sha256(handoffBytes),
    report_result: 'SUCCESS',
    report_candidate_commit: null,
    commit_message: 'candidate',
    changed_files: ['src.txt'],
    validation_results: [
      { argv: ['true'], exit_code: 0, timed_out: false, duration_ms: 1 },
    ],
    patch_fingerprint: await git(['diff', '--binary', baseSha, candidateSha]).then((patch) =>
      createHash('sha256').update(patch.endsWith('\n') ? patch : `${patch}\n`).digest('hex'),
    ),
    candidate_commit: candidateSha,
    commit_origin: 'orchestrator',
    review_requirement: {
      required: true,
      reviewer_profile_id: 'fake-reviewer-v1',
      diversity_requirement: 'preferred',
      policy_provenance: 'teste',
    },
    finalized_at: NOW,
  };
  await writeOrchestratedFinalization(paths, finalization);
  const review = CandidateReviewRecord.parse({
    schema_version: 1,
    task_id: 'T1',
    attempt: 1,
    candidate_sha: candidateSha,
    finalization_record_sha256: finalizationFingerprint(finalization),
    validation_results_sha256: validationResultsFingerprint(finalization),
    reviewer_profile_id: 'fake-reviewer-v1',
    reviewer_invocation: {
      role: 'reviewer',
      workspace_access: 'READ_ONLY',
      read_only_mechanism: 'fixture read-only',
      argv: ['node', 'reviewer.mjs', '--read-only'],
      diversity_requirement: 'preferred',
      fresh_context: true,
    },
    decision: 'REJECT',
    rejection_disposition: 'IMPLEMENTATION_DEFECT',
    reason: 'candidate viola acceptance já definido',
    decided_at: NOW,
  });
  await writeCandidateReview(paths, review);
  await writeState(paths, {
    schema_version: 1,
    plan_sha256: 'a'.repeat(64),
    baseline_sha: baseSha,
    authorized_head_sha: baseSha,
    created_at: NOW,
    updated_at: NOW,
    tasks: [
      {
        id: 'T1',
        status: 'RUNNING',
        phase: 'FINALIZING',
        attempts: 1,
        process: null,
        base_sha: baseSha,
        candidate_commit: null,
        accepted_commit: null,
        diagnostics: 'review rejeitou o candidate',
        started_at: NOW,
        finished_at: null,
      },
    ],
  });
  return { finalization, reviewBytes: await readFile(candidateReviewPath(paths, 'T1', 1)) };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'review-repair-'));
  paths = resolveHarnessPaths(root);
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'agentlab@example.test']);
  await git(['config', 'user.name', 'Agent Lab Test']);
  await ensureRuntimeDirs(paths);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('retryReviewRejectedAttempt', () => {
  it('preserva o candidate/review, volta à base e reabre a mesma task', async () => {
    const { reviewBytes } = await seedRejectedCandidate();

    const result = await retryReviewRejectedAttempt({
      paths,
      taskId: 'T1',
      reason: 'bounded repair autorizado para implementation defect',
      now: () => NOW,
    });

    expect(result.record.rejection_disposition).toBe('IMPLEMENTATION_DEFECT');
    expect(result.record.candidate_sha).toBe(candidateSha);
    expect(result.bundle?.manifest.changed_files).toEqual(['src.txt']);
    expect(await headSha(root)).toBe(baseSha);
    const state = await readState(paths);
    expect(getTaskState(state, 'T1')).toMatchObject({
      status: 'READY',
      attempts: 1,
      candidate_commit: null,
      accepted_commit: null,
    });
    expect(await readFile(candidateReviewPath(paths, 'T1', 1))).toEqual(reviewBytes);
    expect((await readReviewRejectedAttempt(paths, 'T1', 1))?.candidate_sha).toBe(candidateSha);
    expect(await readPreviousAttemptDiagnostics(paths, 'T1', 1)).toMatchObject({
      attempt: 1,
      profile_id: 'fake-worker-v1',
      reason_code: 'REJECTED_BY_INDEPENDENT_REVIEW',
      failed_validations: [],
      review_rejection: {
        disposition: 'IMPLEMENTATION_DEFECT',
        candidate_sha: candidateSha,
        reason: 'candidate viola acceptance já definido',
      },
    });
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1))).toEqual(
      Buffer.from('{"worker":"success"}\n'),
    );
    expect(await readFile(failedAttemptHandoffDraftPath(paths, 'T1', 1))).toEqual(
      Buffer.from('{"handoff":"attempt-1"}\n'),
    );
  });

  it('retoma idempotentemente se o processo cair depois de mover HEAD', async () => {
    await seedRejectedCandidate();

    await expect(
      retryReviewRejectedAttempt({
        paths,
        taskId: 'T1',
        reason: 'bounded repair autorizado',
        now: () => NOW,
        afterHeadMoved: async () => {
          throw new Error('crash injetado depois de mover HEAD');
        },
      }),
    ).rejects.toThrow('crash injetado');
    expect(await headSha(root)).toBe(baseSha);

    const resumed = await retryReviewRejectedAttempt({
      paths,
      taskId: 'T1',
      reason: 'bounded repair autorizado',
      now: () => NOW,
    });

    expect(resumed.alreadyArchived).toBe(true);
    expect(await headSha(root)).toBe(baseSha);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('READY');
  });
});
