import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveHarnessPaths } from '../../dev/lib/paths.js';
import {
  nextRevalidationSequence,
  originalCompletionEvidencePath,
  readOrchestratedRevalidation,
  readRevalidationSourceBinding,
  revalidationRecordPath,
  sourceBindingPath,
  writeOrchestratedRevalidation,
  writeRevalidationSourceBinding,
} from '../../dev/lib/records.js';
import type {
  OrchestratedRevalidationRecord,
  RevalidationSourceBinding,
} from '../../dev/lib/schemas.js';
import { makeTempDevDir } from './helpers.js';

const roots: string[] = [];
const SHA = 'a'.repeat(40);
const NOW = '2026-08-07T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function binding(): RevalidationSourceBinding {
  return {
    schema_version: 1,
    task_id: 'M03B',
    attempt: 1,
    source_base_sha: SHA,
    original_completion_path: 'original-completion.fail.json',
    original_completion_sha256: '1'.repeat(64),
    report_sha256: '2'.repeat(64),
    handoff_draft_sha256: '3'.repeat(64),
    changed_files: ['src/a.ts'],
    derived_patch_fingerprint: '4'.repeat(64),
    fingerprint_observed_at: NOW,
    fingerprint_provenance: 'derived_during_revalidation_preflight',
  };
}

function record(sequence: number): OrchestratedRevalidationRecord {
  const failed = { argv: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 1 };
  return {
    schema_version: 1,
    task_id: 'M03B',
    attempt: 1,
    sequence,
    outcome: 'FAIL',
    reason_code: 'NONDETERMINISTIC_VALIDATION',
    reason: 'gate oscilou',
    source_binding_sha256: '5'.repeat(64),
    source_base_sha: SHA,
    finalization_base_sha: 'b'.repeat(40),
    original_completion_sha256: '1'.repeat(64),
    report_sha256: '2'.repeat(64),
    handoff_draft_sha256: '3'.repeat(64),
    patch_fingerprint: '4'.repeat(64),
    original_validation_results: [failed],
    revalidation_results: [failed],
    validation_evidence: [
      {
        sequence,
        ...failed,
        stdout_sha256: '6'.repeat(64),
        stderr_sha256: '7'.repeat(64),
        stdout_bytes: 0,
        stderr_bytes: 1,
        stdout_path: `validation-logs/M03B/attempt-1/000${sequence}.stdout.log`,
        stderr_path: `validation-logs/M03B/attempt-1/000${sequence}.stderr.log`,
      },
    ],
    changed_files: ['src/a.ts'],
    commit_message: 'feat(M03B): title',
    candidate_commit: null,
    candidate_tree_sha: null,
    commit_origin: 'orchestrator',
    working_tree_clean: false,
    revalidated_at: NOW,
  };
}

describe('append-only revalidation records', () => {
  it('usa paths separados para binding, FAIL original e records sequenciais', async () => {
    const root = await makeTempDevDir();
    roots.push(root);
    const paths = resolveHarnessPaths(root);

    expect(sourceBindingPath(paths, 'M03B', 1)).toMatch(
      /revalidations\/M03B\/attempt-1\/source-binding\.json$/,
    );
    expect(originalCompletionEvidencePath(paths, 'M03B', 1)).toMatch(
      /revalidations\/M03B\/attempt-1\/original-completion\.fail\.json$/,
    );
    expect(revalidationRecordPath(paths, 'M03B', 1, 2)).toMatch(
      /revalidations\/M03B\/attempt-1\/revalidation-2\.json$/,
    );
  });

  it('aceita replay idêntico, recusa overwrite e avança a sequência', async () => {
    const root = await makeTempDevDir();
    roots.push(root);
    const paths = resolveHarnessPaths(root);
    const source = binding();

    await writeRevalidationSourceBinding(paths, source);
    await writeRevalidationSourceBinding(paths, source);
    await expect(
      writeRevalidationSourceBinding(paths, { ...source, report_sha256: 'f'.repeat(64) }),
    ).rejects.toThrow(/append-only|diverge/i);
    expect(await readRevalidationSourceBinding(paths, 'M03B', 1)).toEqual(source);

    expect(await nextRevalidationSequence(paths, 'M03B', 1)).toBe(1);
    await writeOrchestratedRevalidation(paths, record(1));
    await writeOrchestratedRevalidation(paths, record(1));
    await expect(
      writeOrchestratedRevalidation(paths, { ...record(1), reason: 'mudou' }),
    ).rejects.toThrow(/append-only|diverge/i);
    expect(await readOrchestratedRevalidation(paths, 'M03B', 1, 1)).toEqual(record(1));
    expect(await nextRevalidationSequence(paths, 'M03B', 1)).toBe(2);
  });
});
