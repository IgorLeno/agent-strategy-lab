import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  finalizationFingerprint,
  lookupCandidateReview,
  validationResultsFingerprint,
} from '../../dev/lib/candidate-review.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import {
  candidateReviewPath,
  readReviewRejectedAttempt,
  readReviewRejectionClassification,
  reviewRejectedAttemptPath,
  reviewRejectionClassificationPath,
  writeCandidateReview,
  writeReviewRejectedAttempt,
  writeReviewRejectionClassification,
} from '../../dev/lib/records.js';
import {
  CandidateReviewRecord,
  ReviewRejectedAttemptRecord,
  ReviewRejectionClassificationRecord,
  type CandidateReviewCoverage,
  type OrchestratedFinalizationRecord,
} from '../../dev/lib/schemas.js';
import { ensureRuntimeDirs } from '../../dev/lib/state.js';

const SHA = 'a'.repeat(40);
const NOW = '2026-08-21T12:00:00.000Z';

let root: string;
let paths: HarnessPaths;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'candidate-review-'));
  paths = resolveHarnessPaths(root);
  await ensureRuntimeDirs(paths);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function finalization(): OrchestratedFinalizationRecord {
  return {
    schema_version: 1,
    task_id: 'M94',
    attempt: 1,
    base_sha: 'b'.repeat(40),
    profile_id: 'orchestrator-v2',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    report_sha256: 'c'.repeat(64),
    handoff_draft_sha256: 'd'.repeat(64),
    report_result: 'SUCCESS',
    report_candidate_commit: null,
    commit_message: 'feat(M94): cobertura de review',
    changed_files: ['dev/lib/schemas.ts'],
    validation_results: [{ argv: ['pnpm', 'test'], exit_code: 0, timed_out: false, duration_ms: 1 }],
    patch_fingerprint: 'e'.repeat(64),
    candidate_commit: SHA,
    commit_origin: 'orchestrator',
    review_requirement: {
      required: true,
      reviewer_profile_id: 'fake-reviewer-v1',
      diversity_requirement: 'preferred',
      policy_provenance: 'teste de cobertura de review',
    },
    finalized_at: NOW,
  };
}

const FULL_COVERAGE: CandidateReviewCoverage = {
  files: ['dev/lib/schemas.ts'],
  validations: [['pnpm', 'test']],
  behaviors: ['gate de cobertura recusa ACCEPT sem prova'],
  handoff_gaps: [],
};

function review(overrides: Record<string, unknown> = {}) {
  const record = finalization();
  return {
    schema_version: 1,
    task_id: record.task_id,
    attempt: record.attempt,
    candidate_sha: record.candidate_commit,
    finalization_record_sha256: finalizationFingerprint(record),
    validation_results_sha256: validationResultsFingerprint(record),
    reviewer_profile_id: 'fake-reviewer-v1',
    reviewer_invocation: {
      role: 'reviewer',
      workspace_access: 'READ_ONLY',
      read_only_mechanism: 'argv do worker falso: --agentlab-read-only',
      argv: ['node', 'fixtures/fake-worker.mjs', '--agentlab-read-only'],
      diversity_requirement: 'preferred',
      fresh_context: true,
    },
    coverage: FULL_COVERAGE,
    decision: 'ACCEPT',
    reason: 'evidência consistente com o acceptance declarado',
    decided_at: NOW,
    ...overrides,
  };
}

describe('cobertura estrutural da review', () => {
  it('ACCEPT com cobertura completa é válido', () => {
    const parsed = CandidateReviewRecord.parse(review());
    expect(parsed.decision).toBe('ACCEPT');
    expect(parsed.coverage?.files).toEqual(['dev/lib/schemas.ts']);
    expect(parsed.coverage?.validations).toEqual([['pnpm', 'test']]);
  });

  // O gate é do SCHEMA, não do prompt: um reviewer que só diz "looks good" não
  // consegue produzir um ACCEPT válido, por mais convincente que soe o texto.
  it('ACCEPT sem cobertura é inválido', () => {
    const { coverage: _omitted, ...withoutCoverage } = review();
    const result = CandidateReviewRecord.safeParse(withoutCoverage);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/ACCEPT exige coverage declarada/);

    expect(
      CandidateReviewRecord.safeParse(
        review({ reason: 'looks good', coverage: { ...FULL_COVERAGE, files: [] } }),
      ).success,
    ).toBe(false);
    expect(
      CandidateReviewRecord.safeParse(review({ coverage: { ...FULL_COVERAGE, validations: [] } }))
        .success,
    ).toBe(false);
  });

  it('REJECT continua válido sem cobertura', () => {
    const { coverage: _omitted, ...withoutCoverage } = review();
    const parsed = CandidateReviewRecord.parse({
      ...withoutCoverage,
      decision: 'REJECT',
      reason: 'evidência insuficiente para aceitar a mudança',
    });
    expect(parsed.decision).toBe('REJECT');
    expect(parsed.coverage).toBeUndefined();
  });

  it('REJECT novo preserva disposição estruturada independente da prosa', () => {
    const { coverage: _omitted, ...withoutCoverage } = review();
    const parsed = CandidateReviewRecord.parse({
      ...withoutCoverage,
      decision: 'REJECT',
      rejection_disposition: 'IMPLEMENTATION_DEFECT',
      reason: 'o candidate viola o acceptance já declarado',
    });
    expect(parsed.rejection_disposition).toBe('IMPLEMENTATION_DEFECT');
  });

  it('record legado REJECT sem disposição continua legível como UNKNOWN', () => {
    const { coverage: _omitted, ...withoutCoverage } = review();
    const parsed = CandidateReviewRecord.parse({
      ...withoutCoverage,
      decision: 'REJECT',
      reason: 'veredito anterior ao contrato de disposição',
    });
    expect(parsed.rejection_disposition).toBeUndefined();
  });

  it('ACCEPT não pode carregar disposição de rejeição', () => {
    const result = CandidateReviewRecord.safeParse(
      review({ rejection_disposition: 'IMPLEMENTATION_DEFECT' }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/ACCEPT não pode declarar rejection_disposition/);
  });
});

describe('endereçamento de what_i_did_not_check', () => {
  const GAPS = ['comportamento sob concorrência', 'caminho de erro do parser'];

  it('ACCEPT com os dois itens endereçados é válido', () => {
    const parsed = CandidateReviewRecord.parse(
      review({
        implementer_gaps: GAPS,
        coverage: {
          ...FULL_COVERAGE,
          handoff_gaps: [
            {
              gap: GAPS[0],
              disposition: 'accepted_with_justification',
              note: 'a task é sequencial; concorrência não é alcançável neste caminho',
            },
            {
              gap: GAPS[1],
              disposition: 'open_question',
              note: 'o caminho de erro do parser segue sem cobertura direta',
            },
          ],
        },
      }),
    );
    expect(parsed.coverage?.handoff_gaps).toHaveLength(2);
    expect(parsed.coverage?.handoff_gaps[0]?.disposition).toBe('accepted_with_justification');
    // A pergunta aberta fica REGISTRADA, com o texto do reviewer.
    expect(parsed.coverage?.handoff_gaps[1]).toEqual({
      gap: GAPS[1],
      disposition: 'open_question',
      note: 'o caminho de erro do parser segue sem cobertura direta',
    });
  });

  it('ACCEPT com um item sem endereçamento é inválido', () => {
    const result = CandidateReviewRecord.safeParse(
      review({
        implementer_gaps: GAPS,
        coverage: {
          ...FULL_COVERAGE,
          handoff_gaps: [
            { gap: GAPS[0], disposition: 'accepted_with_justification', note: 'coberto' },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/deixa lacuna do implementer sem endereçamento/);
  });

  it('cobertura não pode inventar lacuna que o implementer não declarou', () => {
    const result = CandidateReviewRecord.safeParse(
      review({
        implementer_gaps: [GAPS[0]],
        coverage: {
          ...FULL_COVERAGE,
          handoff_gaps: [
            { gap: GAPS[0], disposition: 'accepted_with_justification', note: 'coberto' },
            { gap: 'lacuna inventada', disposition: 'open_question', note: 'não declarada' },
          ],
        },
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/lacuna não declarada pelo implementer/);
  });

  // Handoff v1 não respondeu à pergunta: UNKNOWN, e não há o que endereçar.
  it('sem implementer_gaps não há endereçamento a exigir', () => {
    expect(CandidateReviewRecord.safeParse(review()).success).toBe(true);
  });
});

describe('lookupCandidateReview com cobertura', () => {
  it('ACCEPT com cobertura amarrado aos três hashes promove', async () => {
    const record = finalization();
    await writeCandidateReview(paths, CandidateReviewRecord.parse(review()));
    const lookup = await lookupCandidateReview(paths, record);
    expect(lookup.status).toBe('ACCEPTED');
  });

  // A amarração por três hashes continua decidindo antes de qualquer cobertura.
  it('veredito de outro candidate continua DIVERGENT', async () => {
    const record = finalization();
    await writeCandidateReview(
      paths,
      CandidateReviewRecord.parse(review({ candidate_sha: 'f'.repeat(40) })),
    );
    expect((await lookupCandidateReview(paths, record)).status).toBe('DIVERGENT');

    await rm(candidateReviewPath(paths, record.task_id, record.attempt));
    await writeCandidateReview(
      paths,
      CandidateReviewRecord.parse(review({ validation_results_sha256: '0'.repeat(64) })),
    );
    expect((await lookupCandidateReview(paths, record)).status).toBe('DIVERGENT');
  });

  // Um ACCEPT sem cobertura em disco não explode o control plane e não promove:
  // vira bloqueio explícito, como qualquer outra ausência de prova.
  it('ACCEPT sem cobertura em disco vira INVALID, nunca ACCEPTED', async () => {
    const record = finalization();
    const { coverage: _omitted, ...withoutCoverage } = review();
    const file = candidateReviewPath(paths, record.task_id, record.attempt);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(withoutCoverage, null, 2)}\n`,
      'utf8',
    );
    const lookup = await lookupCandidateReview(paths, record);
    expect(lookup.status).toBe('INVALID');
    expect(lookup.reason).toMatch(/ACCEPT exige coverage declarada/);
    expect(lookup.record).toBeNull();
  });

  it('review REJECT continua bloqueando', async () => {
    const record = finalization();
    const { coverage: _omitted, ...withoutCoverage } = review();
    await writeCandidateReview(
      paths,
      CandidateReviewRecord.parse({ ...withoutCoverage, decision: 'REJECT', reason: 'não aceito' }),
    );
    expect((await lookupCandidateReview(paths, record)).status).toBe('REJECTED');
  });

  it('sem exigência de review nada muda', async () => {
    const { review_requirement: _omitted, ...withoutRequirement } = finalization();
    const lookup = await lookupCandidateReview(
      paths,
      withoutRequirement as OrchestratedFinalizationRecord,
    );
    expect(lookup.status).toBe('NOT_REQUIRED');
  });
});

describe('evidência estruturada da rejeição reparável', () => {
  it('classificação legada liga a disposição ao review e candidate por hash', () => {
    const parsed = ReviewRejectionClassificationRecord.parse({
      schema_version: 1,
      task_id: 'M94',
      attempt: 1,
      candidate_sha: SHA,
      review_record_sha256: '1'.repeat(64),
      classifier_profile_id: 'fake-reviewer-v1',
      classifier_invocation: {
        role: 'reviewer',
        workspace_access: 'READ_ONLY',
        read_only_mechanism: 'argv read-only do classificador',
        argv: ['node', 'fixtures/fake-worker.mjs', '--agentlab-read-only'],
        diversity_requirement: 'preferred',
        fresh_context: true,
      },
      disposition: 'IMPLEMENTATION_DEFECT',
      reason: 'violação concreta do acceptance já definido',
      classified_at: NOW,
    });
    expect(parsed.disposition).toBe('IMPLEMENTATION_DEFECT');
  });

  it('attempt rejeitado preserva PASS oficial e REJECT sem converter um no outro', () => {
    const parsed = ReviewRejectedAttemptRecord.parse({
      schema_version: 1,
      task_id: 'M94',
      attempt: 1,
      source_base_sha: 'b'.repeat(40),
      profile_id: 'orchestrator-v2',
      candidate_sha: SHA,
      finalization_record_sha256: '2'.repeat(64),
      review_record_sha256: '3'.repeat(64),
      rejection_classification_sha256: '4'.repeat(64),
      rejection_disposition: 'IMPLEMENTATION_DEFECT',
      review_reason: 'candidate viola o acceptance',
      changed_files: ['dev/lib/schemas.ts'],
      original_validation_results: [
        { argv: ['pnpm', 'test'], exit_code: 0, timed_out: false, duration_ms: 1 },
      ],
      patch_fingerprint: '5'.repeat(64),
      change_bundle: {
        manifest_path: 'failed-attempts/M94/attempt-1/change-bundle/manifest.json',
        manifest_sha256: '6'.repeat(64),
        patch_path: 'failed-attempts/M94/attempt-1/change-bundle/changes.patch',
        patch_sha256: '7'.repeat(64),
        patch_size_bytes: 42,
      },
      archived_at: NOW,
    });
    expect(parsed.original_validation_results.every((result) => result.exit_code === 0)).toBe(true);
    expect(parsed.rejection_disposition).toBe('IMPLEMENTATION_DEFECT');
  });

  it('attempt de review rejeitada recusa validation FAIL contraditória', () => {
    const result = ReviewRejectedAttemptRecord.safeParse({
      schema_version: 1,
      task_id: 'M94',
      attempt: 1,
      source_base_sha: 'b'.repeat(40),
      profile_id: 'orchestrator-v2',
      candidate_sha: SHA,
      finalization_record_sha256: '2'.repeat(64),
      review_record_sha256: '3'.repeat(64),
      rejection_classification_sha256: '4'.repeat(64),
      rejection_disposition: 'IMPLEMENTATION_DEFECT',
      review_reason: 'candidate viola o acceptance',
      changed_files: ['dev/lib/schemas.ts'],
      original_validation_results: [
        { argv: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 1 },
      ],
      patch_fingerprint: '5'.repeat(64),
      change_bundle: {
        manifest_path: 'manifest.json',
        manifest_sha256: '6'.repeat(64),
        patch_path: 'changes.patch',
        patch_sha256: '7'.repeat(64),
        patch_size_bytes: 42,
      },
      archived_at: NOW,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/review rejection exige validation oficial PASS/);
  });

  it('classificação e archival são append-only por task/attempt', async () => {
    const classification = ReviewRejectionClassificationRecord.parse({
      schema_version: 1,
      task_id: 'M94',
      attempt: 1,
      candidate_sha: SHA,
      review_record_sha256: '1'.repeat(64),
      classifier_profile_id: 'fake-reviewer-v1',
      classifier_invocation: {
        role: 'reviewer',
        workspace_access: 'READ_ONLY',
        read_only_mechanism: 'argv read-only do classificador',
        argv: ['node', 'fixtures/fake-worker.mjs', '--agentlab-read-only'],
        diversity_requirement: 'preferred',
        fresh_context: true,
      },
      disposition: 'IMPLEMENTATION_DEFECT',
      reason: 'violação concreta do acceptance já definido',
      classified_at: NOW,
    });
    const rejected = ReviewRejectedAttemptRecord.parse({
      schema_version: 1,
      task_id: 'M94',
      attempt: 1,
      source_base_sha: 'b'.repeat(40),
      profile_id: 'orchestrator-v2',
      candidate_sha: SHA,
      finalization_record_sha256: '2'.repeat(64),
      review_record_sha256: '3'.repeat(64),
      rejection_classification_sha256: '4'.repeat(64),
      rejection_disposition: 'IMPLEMENTATION_DEFECT',
      review_reason: 'candidate viola o acceptance',
      changed_files: ['dev/lib/schemas.ts'],
      original_validation_results: [
        { argv: ['pnpm', 'test'], exit_code: 0, timed_out: false, duration_ms: 1 },
      ],
      patch_fingerprint: '5'.repeat(64),
      change_bundle: {
        manifest_path: 'manifest.json',
        manifest_sha256: '6'.repeat(64),
        patch_path: 'changes.patch',
        patch_sha256: '7'.repeat(64),
        patch_size_bytes: 42,
      },
      archived_at: NOW,
    });

    await writeReviewRejectionClassification(paths, classification);
    await writeReviewRejectedAttempt(paths, rejected);
    expect(await readReviewRejectionClassification(paths, 'M94', 1)).toEqual(classification);
    expect(await readReviewRejectedAttempt(paths, 'M94', 1)).toEqual(rejected);
    expect(reviewRejectionClassificationPath(paths, 'M94', 1)).toMatch(
      /reviews\/M94\/attempt-1\/rejection-classification\.json$/,
    );
    expect(reviewRejectedAttemptPath(paths, 'M94', 1)).toMatch(
      /failed-attempts\/M94\/attempt-1\/review-rejected-attempt\.json$/,
    );

    await expect(
      writeReviewRejectionClassification(paths, {
        ...classification,
        reason: 'bytes divergentes',
      }),
    ).rejects.toThrow(/append-only|diverge|já existe/i);
  });
});
