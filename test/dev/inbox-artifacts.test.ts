import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InboxArtifactError,
  archiveInboxArtifacts,
  releaseCurrentInboxArtifacts,
  releaseInboxForLaunch,
  tryFinishPendingInboxRelease,
} from '../../dev/lib/inbox-artifacts.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  failedAttemptHandoffDraftPath,
  failedAttemptReportPath,
  handoffDraftPath,
  inboxReleaseIntentPath,
  reportPath,
  writeValidationFailedAttempt,
} from '../../dev/lib/records.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  writeState,
} from '../../dev/lib/state.js';
import { makeSandboxRepo, type Sandbox } from './helpers.js';

/**
 * Liberação crash-safe do inbox: intent durável antes do primeiro `rm`, e
 * retomada só com prova de que a release daquele par já havia sido autorizada.
 */

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

const REPORT = '{"schema_version":1,"kind":"report"}\n';
const HANDOFF = '{"schema_version":1,"kind":"handoff"}\n';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const HASHES = {
  reportSha256: digest(REPORT),
  handoffDraftSha256: digest(HANDOFF),
};

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function seedArchivedPair(attempt = 1): Promise<void> {
  await mkdir(path.dirname(reportPath(paths, 'T1')), { recursive: true });
  await writeFile(reportPath(paths, 'T1'), REPORT, 'utf8');
  await writeFile(handoffDraftPath(paths, 'T1'), HANDOFF, 'utf8');
  await archiveInboxArtifacts({
    paths,
    taskId: 'T1',
    attempt,
    bytes: { report: Buffer.from(REPORT), handoff: Buffer.from(HANDOFF) },
    expected: HASHES,
  });
  await writeValidationFailedAttempt(paths, {
    schema_version: 1,
    task_id: 'T1',
    attempt,
    source_base_sha: 'a'.repeat(40),
    profile_id: 'fake-worker-v1',
    worker_self_reported_result: 'SUCCESS',
    report_candidate_commit: null,
    orchestrator_verdict: 'REJECTED_BY_OFFICIAL_VALIDATION',
    finalization_mode: 'normal',
    launch_record_sha256: digest('launch'),
    original_completion_sha256: digest('completion'),
    report_sha256: HASHES.reportSha256,
    handoff_draft_sha256: HASHES.handoffDraftSha256,
    source_binding_sha256: digest('binding'),
    patch_fingerprint: digest('patch'),
    changed_files: ['src/alvo.ts'],
    original_validation_results: [
      { argv: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 1 },
    ],
    change_bundle: {
      manifest_path: 'failed-attempts/T1/attempt-1/changes-manifest.json',
      manifest_sha256: digest('manifest'),
      patch_path: 'failed-attempts/T1/attempt-1/changes.patch',
      patch_sha256: digest('patch-bytes'),
      patch_size_bytes: 12,
    },
    reason_code: 'OFFICIAL_VALIDATION_FAILURE',
    reason: 'attempt arquivado para teste de release',
    archived_at: '2026-08-12T18:14:28.960Z',
  });
}

describe('releaseCurrentInboxArtifacts crash-safe', () => {
  it('A — crash depois de remover report e antes do handoff: retry converge', async () => {
    await seedArchivedPair();

    await expect(
      releaseCurrentInboxArtifacts(paths, 'T1', { attempt: 1, hashes: HASHES }, {
        afterReportRemoved: async () => {
          throw new Error('crash entre os deletes');
        },
      }),
    ).rejects.toThrow(/crash entre os deletes/);

    expect(await exists(reportPath(paths, 'T1'))).toBe(false);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(true);
    expect(await exists(inboxReleaseIntentPath(paths, 'T1'))).toBe(true);
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1), 'utf8')).toBe(REPORT);

    const result = await releaseCurrentInboxArtifacts(paths, 'T1', {
      attempt: 1,
      hashes: HASHES,
    });
    expect(result).toEqual({ report: false, handoff: true });
    expect(await exists(reportPath(paths, 'T1'))).toBe(false);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(false);
    expect(await exists(inboxReleaseIntentPath(paths, 'T1'))).toBe(false);
  });

  it('B — só report restante com intent: retry converge', async () => {
    await seedArchivedPair();
    // Intent autorizado + handoff já apagado (fronteira inversa / estado equivalente).
    await writeFile(
      inboxReleaseIntentPath(paths, 'T1'),
      `${JSON.stringify(
        {
          schema_version: 1,
          task_id: 'T1',
          attempt: 1,
          report_sha256: HASHES.reportSha256,
          handoff_draft_sha256: HASHES.handoffDraftSha256,
          authorized_at: '2026-08-12T18:14:28.960Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await rm(handoffDraftPath(paths, 'T1'), { force: true });

    expect(await tryFinishPendingInboxRelease(paths, 'T1')).toBe(true);
    expect(await exists(reportPath(paths, 'T1'))).toBe(false);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(false);
    expect(await exists(inboxReleaseIntentPath(paths, 'T1'))).toBe(false);
  });

  it('C — meio par SEM evidence durável de release: BLOCKED', async () => {
    await seedArchivedPair();
    await rm(reportPath(paths, 'T1'), { force: true });

    await expect(releaseInboxForLaunch(paths, 'T1')).rejects.toThrow(
      /meio par não prova proveniência/i,
    );
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(true);
    expect(await tryFinishPendingInboxRelease(paths, 'T1')).toBe(false);
  });

  it('D — meio par com artifact divergente do archive: BLOCKED', async () => {
    await seedArchivedPair();
    await expect(
      releaseCurrentInboxArtifacts(paths, 'T1', { attempt: 1, hashes: HASHES }, {
        afterReportRemoved: async () => {
          throw new Error('crash entre os deletes');
        },
      }),
    ).rejects.toThrow(/crash entre os deletes/);

    await writeFile(handoffDraftPath(paths, 'T1'), '{"schema_version":1,"divergente":true}\n', 'utf8');

    await expect(
      releaseCurrentInboxArtifacts(paths, 'T1', { attempt: 1, hashes: HASHES }),
    ).rejects.toThrow(InboxArtifactError);
    await expect(tryFinishPendingInboxRelease(paths, 'T1')).rejects.toThrow(/diverge/);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(true);
    expect(await exists(inboxReleaseIntentPath(paths, 'T1'))).toBe(true);
  });

  it('E — release concluída repetida é idempotente', async () => {
    await seedArchivedPair();
    const first = await releaseCurrentInboxArtifacts(paths, 'T1', {
      attempt: 1,
      hashes: HASHES,
    });
    expect(first).toEqual({ report: true, handoff: true });

    const second = await releaseCurrentInboxArtifacts(paths, 'T1', {
      attempt: 1,
      hashes: HASHES,
    });
    expect(second).toEqual({ report: false, handoff: false });
    expect(await exists(inboxReleaseIntentPath(paths, 'T1'))).toBe(false);
    expect(await readFile(failedAttemptHandoffDraftPath(paths, 'T1', 1), 'utf8')).toBe(HANDOFF);
  });
});

describe('releaseInboxForLaunch retoma release parcial (G)', () => {
  it('retoma release parcial autorizada sem perder evidence do archive', async () => {
    await seedArchivedPair();
    await expect(
      releaseCurrentInboxArtifacts(paths, 'T1', { attempt: 1, hashes: HASHES }, {
        afterReportRemoved: async () => {
          throw new Error('crash entre os deletes');
        },
      }),
    ).rejects.toThrow(/crash entre os deletes/);

    expect(await releaseInboxForLaunch(paths, 'T1')).toBe('released_preserved_artifacts');
    expect(await exists(reportPath(paths, 'T1'))).toBe(false);
    expect(await exists(handoffDraftPath(paths, 'T1'))).toBe(false);
    expect(await readFile(failedAttemptReportPath(paths, 'T1', 1), 'utf8')).toBe(REPORT);
    expect(await readFile(failedAttemptHandoffDraftPath(paths, 'T1', 1), 'utf8')).toBe(HANDOFF);
  });
});
