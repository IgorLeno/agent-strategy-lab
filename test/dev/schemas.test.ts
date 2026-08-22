import { describe, expect, it } from 'vitest';
import {
  CompletionRecord,
  DEV_SCHEMA_VERSION,
  LaunchRecord,
  MAXIMUM_HANDOFF_BYTES,
  MAXIMUM_TASK_PACKET_BYTES,
  OrchestratedRevalidationRecord,
  REVALIDATION_REASON_CODES,
  RevalidationCheckpoint,
  RevalidationReasonCode,
  RevalidationSourceBinding,
  TaskState,
  OrchestratedFinalizationRecord,
  ValidationEvidence,
  ValidationResult,
  byteSize,
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_SCHEMA_VERSION_V1,
  HANDOFF_SCHEMA_VERSION_V2,
  HandoffDraftV2,
  isHandoffDraftV2,
  isHandoffRecordV2,
  parseHandoffDraft,
  parseHandoffRecord,
  parseTaskPacket,
  readHandoffConfidence,
} from '../../dev/lib/schemas.js';
import { BudgetExceededError } from '../../dev/lib/budget.js';
import { canonicalJson, canonicalSha256 } from '../../dev/lib/canonical.js';

const SHA = 'a'.repeat(40);
const NOW = '2026-08-05T12:00:00.000Z';

const PROCESS = {
  pid: 123,
  pgid: 123,
  started_at: NOW,
  proc_start_ticks: 456,
  command_sha256: 'b'.repeat(64),
};

function validLaunchRecord(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    task_id: 'M01',
    profile_id: 'legacy-worker-v1',
    argv: ['worker'],
    process: PROCESS,
    launch_id: '123e4567-e89b-42d3-a456-426614174000',
    survivors_killed: [],
    survivors_remaining: [],
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 1,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: null,
    ...overrides,
  };
}

describe('ExecutionPolicy no LaunchRecord', () => {
  it('interpreta LaunchRecord legado como worker/worker/full', () => {
    expect(LaunchRecord.parse(validLaunchRecord()).execution_policy).toEqual({
      commit_owner: 'worker',
      official_validation_owner: 'worker',
      worker_validation_policy: 'full',
    });
  });

  it('aceita somente a combinação orchestrator/orchestrator/targeted', () => {
    const executionPolicy = {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    } as const;
    expect(
      LaunchRecord.parse(validLaunchRecord({ execution_policy: executionPolicy })).execution_policy,
    ).toEqual(executionPolicy);
  });

  it('rejeita combinação sintaticamente válida sem semântica implementada', () => {
    expect(() =>
      LaunchRecord.parse(
        validLaunchRecord({
          execution_policy: {
            commit_owner: 'orchestrator',
            official_validation_owner: 'worker',
            worker_validation_policy: 'targeted',
          },
        }),
      ),
    ).toThrow(/combinação.*não suportada/i);
  });
});

function validPacket(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    task_id: 'M01',
    title: 'Scaffold do produto',
    objective: 'Criar o layout src/<área>.',
    base_sha: SHA,
    initial_files: ['package.json'],
    acceptance: ['pnpm typecheck verde'],
    validation: [{ argv: ['pnpm', 'typecheck'], timeout_seconds: 300 }],
    constraints: [],
    previous_handoff: null,
    generated_at: NOW,
    ...overrides,
  };
}

function validDraftV2(overrides: Record<string, unknown> = {}) {
  const { schema_version: _v1, ...common } = validDraft();
  return {
    schema_version: 2,
    ...common,
    evidence: [
      { kind: 'file', path: 'dev/lib/schemas.ts', lines: '182-260', claim: 'handoff v2 aditivo' },
      { kind: 'command', argv: ['pnpm', 'test'], claim: 'testes de contrato executados' },
      { kind: 'record', record_kind: 'validation', task_id: 'M91', attempt: 1, claim: 'validação oficial' },
    ],
    open_questions: ['manter o budget em 4 KiB?'],
    what_i_did_not_check: ['comportamento sob concorrência'],
    confidence: 'alta nos schemas, testes cobrem os dois readers',
    ...overrides,
  };
}

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    task_id: 'M01',
    result: 'PASS',
    changed_files: ['src/core/index.ts'],
    validations: [
      { argv: ['pnpm', 'typecheck'], exit_code: 0, timed_out: false, duration_ms: 1200 },
    ],
    decisions: ['ESM puro, sem CJS'],
    lessons: [],
    next_relevant_files: ['src/core/index.ts'],
    ...overrides,
  };
}

describe('TaskPacket', () => {
  it('aceita packet válido', () => {
    expect(parseTaskPacket(validPacket()).task_id).toBe('M01');
  });

  it('rejeita campo desconhecido (o packet é a única entrada do worker)', () => {
    expect(() => parseTaskPacket(validPacket({ transcript: 'conversa anterior' }))).toThrow();
  });

  it('rejeita validação via shell', () => {
    expect(() => parseTaskPacket(validPacket({ validation: [{ argv: [], timeout_seconds: 1 }] }))).toThrow();
  });

  it('rejeita packet acima de 12 KiB mesmo sendo válido em schema', () => {
    const inflated = validPacket({
      constraints: Array.from({ length: 400 }, (_, index) => `restrição inflada número ${index} `.repeat(3)),
    });
    expect(byteSize(inflated)).toBeGreaterThan(MAXIMUM_TASK_PACKET_BYTES);
    expect(() => parseTaskPacket(inflated)).toThrow(BudgetExceededError);
  });
});

describe('validation evidence compatibility', () => {
  const legacy = {
    argv: ['pnpm', 'test'],
    exit_code: 1,
    timed_out: false,
    duration_ms: 123,
  };

  it('continua parseando ValidationResult legado sem acrescentar campos', () => {
    const before = JSON.stringify(legacy);
    expect(ValidationResult.parse(legacy)).toEqual(legacy);
    expect(JSON.stringify(ValidationResult.parse(legacy))).toBe(before);
  });

  it('tipa metadata externa sem stdout ou stderr bruto', () => {
    const evidence = ValidationEvidence.parse({
      sequence: 7,
      argv: ['pnpm', 'test'],
      exit_code: 0,
      timed_out: false,
      duration_ms: 55,
      stdout_sha256: 'a'.repeat(64),
      stderr_sha256: 'b'.repeat(64),
      stdout_bytes: 12,
      stderr_bytes: 0,
      stdout_path: 'validation-logs/M03B/attempt-1/0007.stdout.log',
      stderr_path: 'validation-logs/M03B/attempt-1/0007.stderr.log',
    });
    expect(evidence.stdout_bytes).toBe(12);
    expect(evidence).not.toHaveProperty('stdout');
    expect(evidence).not.toHaveProperty('stderr');
  });
});

describe('OrchestratedRevalidationRecord', () => {
  const result = {
    argv: ['pnpm', 'test'],
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
  };
  const evidence = {
    sequence: 1,
    ...result,
    stdout_sha256: '1'.repeat(64),
    stderr_sha256: '2'.repeat(64),
    stdout_bytes: 1,
    stderr_bytes: 0,
    stdout_path: 'validation-logs/M03B/attempt-1/0001.stdout.log',
    stderr_path: 'validation-logs/M03B/attempt-1/0001.stderr.log',
  };
  const binding = {
    schema_version: 1,
    task_id: 'M03B',
    attempt: 1,
    source_base_sha: SHA,
    original_completion_path: 'original-completion.fail.json',
    original_completion_sha256: '3'.repeat(64),
    report_sha256: '4'.repeat(64),
    handoff_draft_sha256: '5'.repeat(64),
    changed_files: ['src/a.ts'],
    derived_patch_fingerprint: '6'.repeat(64),
    fingerprint_observed_at: NOW,
    fingerprint_provenance: 'derived_during_revalidation_preflight',
  };
  const record = {
    schema_version: 1,
    task_id: 'M03B',
    attempt: 1,
    sequence: 1,
    outcome: 'PASS',
    reason_code: 'NONDETERMINISTIC_VALIDATION',
    reason: 'gate oscilou sem mudança de patch',
    source_binding_sha256: '7'.repeat(64),
    source_base_sha: SHA,
    finalization_base_sha: 'b'.repeat(40),
    original_completion_sha256: binding.original_completion_sha256,
    report_sha256: binding.report_sha256,
    handoff_draft_sha256: binding.handoff_draft_sha256,
    patch_fingerprint: binding.derived_patch_fingerprint,
    original_validation_results: [{ ...result, exit_code: 1 }],
    revalidation_results: [result],
    validation_evidence: [evidence],
    changed_files: ['src/a.ts'],
    commit_message: 'feat(M03B): EvaluationPlan mínimo (privado)',
    candidate_commit: 'c'.repeat(40),
    candidate_tree_sha: 'e'.repeat(40),
    commit_origin: 'orchestrator',
    working_tree_clean: true,
    revalidated_at: NOW,
  };

  it('tipa o source binding com provenance honesta', () => {
    expect(RevalidationSourceBinding.parse(binding).source_base_sha).toBe(SHA);
    expect(() =>
      RevalidationSourceBinding.parse({ ...binding, fingerprint_provenance: 'historical' }),
    ).toThrow();
  });

  // O enum de proveniência é append-only. `derived_during_revalidation_preflight`
  // era o único valor possível antes de o FAIL passar a nascer selado, e os
  // bindings gravados naquela época continuam sendo bindings válidos.
  it('a proveniência distingue quando a fonte foi observada', () => {
    for (const provenance of [
      'derived_at_official_validation_failure',
      'derived_during_revalidation_preflight',
      'derived_during_failed_attempt_recovery',
    ] as const) {
      expect(
        RevalidationSourceBinding.parse({ ...binding, fingerprint_provenance: provenance })
          .fingerprint_provenance,
      ).toBe(provenance);
    }
  });

  it('separa source base da finalization base e aceita PASS consistente', () => {
    const parsed = OrchestratedRevalidationRecord.parse(record);
    expect(parsed.source_base_sha).not.toBe(parsed.finalization_base_sha);
    expect(parsed.candidate_commit).toBe('c'.repeat(40));
  });

  it('recusa PASS sem candidate e FAIL sem validação malsucedida', () => {
    expect(() =>
      OrchestratedRevalidationRecord.parse({ ...record, candidate_commit: null }),
    ).toThrow(/PASS.*candidate/i);
    expect(() =>
      OrchestratedRevalidationRecord.parse({
        ...record,
        outcome: 'FAIL',
        candidate_commit: null,
        candidate_tree_sha: null,
        working_tree_clean: false,
      }),
    ).toThrow(/FAIL.*malsucedida/i);
  });

  it('aceita FAIL append-only sem candidate quando uma nova validação falha', () => {
    const failed = OrchestratedRevalidationRecord.parse({
      ...record,
      outcome: 'FAIL',
      revalidation_results: [{ ...result, exit_code: 1 }],
      validation_evidence: [{ ...evidence, exit_code: 1 }],
      candidate_commit: null,
      candidate_tree_sha: null,
      working_tree_clean: false,
    });
    expect(failed.sequence).toBe(1);
  });

  it('aceita os dois reason codes e recusa qualquer outro', () => {
    expect([...REVALIDATION_REASON_CODES]).toEqual([
      'NONDETERMINISTIC_VALIDATION',
      'HARNESS_VALIDATION_DEFECT',
    ]);
    expect(RevalidationReasonCode.parse('NONDETERMINISTIC_VALIDATION')).toBe(
      'NONDETERMINISTIC_VALIDATION',
    );
    expect(RevalidationReasonCode.parse('HARNESS_VALIDATION_DEFECT')).toBe(
      'HARNESS_VALIDATION_DEFECT',
    );
    expect(() => RevalidationReasonCode.parse('QUALQUER_OUTRO')).toThrow();
  });

  it('HARNESS_VALIDATION_DEFECT parseia em record e checkpoint', () => {
    expect(
      OrchestratedRevalidationRecord.parse({ ...record, reason_code: 'HARNESS_VALIDATION_DEFECT' })
        .reason_code,
    ).toBe('HARNESS_VALIDATION_DEFECT');

    const checkpoint = {
      schema_version: record.schema_version,
      task_id: record.task_id,
      attempt: record.attempt,
      sequence: record.sequence,
      reason_code: 'HARNESS_VALIDATION_DEFECT',
      reason: record.reason,
      source_binding_sha256: record.source_binding_sha256,
      source_base_sha: record.source_base_sha,
      finalization_base_sha: record.finalization_base_sha,
      original_completion_sha256: record.original_completion_sha256,
      report_sha256: record.report_sha256,
      handoff_draft_sha256: record.handoff_draft_sha256,
      patch_fingerprint: record.patch_fingerprint,
      original_validation_results: record.original_validation_results,
      revalidation_results: record.revalidation_results,
      validation_evidence: record.validation_evidence,
      changed_files: record.changed_files,
      commit_message: record.commit_message,
      staged_tree_sha: 'd'.repeat(40),
      checkpointed_at: NOW,
    };
    expect(RevalidationCheckpoint.parse(checkpoint).reason_code).toBe('HARNESS_VALIDATION_DEFECT');
    expect(
      RevalidationCheckpoint.parse({ ...checkpoint, reason_code: 'NONDETERMINISTIC_VALIDATION' })
        .reason_code,
    ).toBe('NONDETERMINISTIC_VALIDATION');
  });

  // O enum é append-only: os bytes gravados antes de HARNESS_VALIDATION_DEFECT
  // existir continuam parseando, e o conteúdo lido é idêntico ao gravado — a
  // identidade do harness é a forma canônica, não a ordem das chaves no arquivo.
  it('record histórico continua byte/parse-compatible', () => {
    const historicalBytes = `${JSON.stringify(record, null, 2)}\n`;
    const parsed = OrchestratedRevalidationRecord.parse(JSON.parse(historicalBytes));
    expect(parsed.reason_code).toBe('NONDETERMINISTIC_VALIDATION');
    expect(canonicalJson(parsed)).toBe(canonicalJson(record));
    expect(canonicalSha256(parsed)).toBe(canonicalSha256(record));

    const historicalBinding = `${JSON.stringify(binding, null, 2)}\n`;
    expect(canonicalJson(RevalidationSourceBinding.parse(JSON.parse(historicalBinding)))).toBe(
      canonicalJson(binding),
    );
  });
});

describe('Handoff', () => {
  it('draft do worker não tem accepted_commit', () => {
    expect(() => parseHandoffDraft(validDraft({ accepted_commit: SHA }))).toThrow();
  });

  it('record selado exige accepted_commit', () => {
    expect(() => parseHandoffRecord({ ...validDraft(), sealed_at: NOW })).toThrow();
    const sealed = parseHandoffRecord({ ...validDraft(), accepted_commit: SHA, sealed_at: NOW });
    expect(sealed.accepted_commit).toBe(SHA);
  });

  it('rejeita handoff acima de 4 KiB', () => {
    const inflated = validDraft({
      changed_files: Array.from({ length: 50 }, (_, index) => `src/muito/fundo/arquivo-${index}-com-nome-longo.ts`),
      decisions: Array.from({ length: 5 }, () => 'decisão longa '.repeat(30)),
    });
    expect(byteSize(inflated)).toBeGreaterThan(MAXIMUM_HANDOFF_BYTES);
    expect(() => parseHandoffDraft(inflated)).toThrow(BudgetExceededError);
  });

  it('limita decisões a 5 e lessons a 3', () => {
    expect(() => parseHandoffDraft(validDraft({ decisions: ['a', 'b', 'c', 'd', 'e', 'f'] }))).toThrow();
    expect(() => parseHandoffDraft(validDraft({ lessons: ['a', 'b', 'c', 'd'] }))).toThrow();
  });

  it('handoff v1 persistido continua parseável sem migração', () => {
    const historicalBytes = `${JSON.stringify(validDraft(), null, 2)}\n`;
    const parsed = parseHandoffDraft(JSON.parse(historicalBytes));
    expect(parsed.schema_version).toBe(HANDOFF_SCHEMA_VERSION_V1);
    expect(canonicalJson(parsed)).toBe(canonicalJson(validDraft()));
    expect(isHandoffDraftV2(parsed)).toBe(false);
  });

  // Ausência de campo v2 em v1 é UNKNOWN. Se algum leitor normalizasse para
  // [] o harness estaria afirmando, em nome de um worker de agosto, que nada
  // ficou sem verificar — conhecimento retroativo fabricado.
  it('campo v2 ausente em v1 não vira default', () => {
    const parsed = parseHandoffDraft(validDraft()) as Record<string, unknown>;
    expect('what_i_did_not_check' in parsed).toBe(false);
    expect('open_questions' in parsed).toBe(false);
    expect('evidence' in parsed).toBe(false);
    expect('confidence' in parsed).toBe(false);
  });

  it('o versionamento do handoff não é o dos demais records', () => {
    expect(HANDOFF_SCHEMA_VERSION).toBe(HANDOFF_SCHEMA_VERSION_V2);
    expect(HANDOFF_SCHEMA_VERSION_V2).not.toBe(DEV_SCHEMA_VERSION);
    expect(HANDOFF_SCHEMA_VERSION_V1).toBe(DEV_SCHEMA_VERSION);
    // TaskPacket e PlanFile continuam em DEV_SCHEMA_VERSION, intocados.
    expect(parseTaskPacket(validPacket()).schema_version).toBe(DEV_SCHEMA_VERSION);
  });
});

describe('Handoff v2', () => {
  it('aceita draft v2 completo e reconhece a versão', () => {
    const draft = parseHandoffDraft(validDraftV2());
    expect(isHandoffDraftV2(draft)).toBe(true);
    if (!isHandoffDraftV2(draft)) throw new Error('draft v2 esperado');
    expect(draft.what_i_did_not_check).toEqual(['comportamento sob concorrência']);
    expect(draft.open_questions).toEqual(['manter o budget em 4 KiB?']);
  });

  it('rejeita draft v2 sem what_i_did_not_check', () => {
    const { what_i_did_not_check: _omitted, ...withoutField } = validDraftV2();
    expect(() => parseHandoffDraft(withoutField)).toThrow();
  });

  it('aceita what_i_did_not_check vazio como afirmação positiva', () => {
    const draft = parseHandoffDraft(validDraftV2({ what_i_did_not_check: [] }));
    if (!isHandoffDraftV2(draft)) throw new Error('draft v2 esperado');
    expect(draft.what_i_did_not_check).toEqual([]);
  });

  // [] e ausência são estados DIFERENTES e precisam continuar diferentes: um é
  // cobertura afirmada, o outro é protocolo não respondido.
  it('lista vazia e ausência não colapsam no mesmo estado', () => {
    const empty = HandoffDraftV2.safeParse(validDraftV2({ what_i_did_not_check: [] }));
    const { what_i_did_not_check: _omitted, ...missing } = validDraftV2();
    expect(empty.success).toBe(true);
    expect(HandoffDraftV2.safeParse(missing).success).toBe(false);
  });

  it('evidence é por referência, com forma distinta por tipo', () => {
    const draft = parseHandoffDraft(validDraftV2());
    if (!isHandoffDraftV2(draft)) throw new Error('draft v2 esperado');
    expect(draft.evidence?.map((reference) => reference.kind)).toEqual([
      'file',
      'command',
      'record',
    ]);
  });

  it('evidence recusa campos de payload e referência mal formada', () => {
    // conteúdo embutido: campo desconhecido em schema estrito
    expect(() =>
      parseHandoffDraft(
        validDraftV2({
          evidence: [{ kind: 'file', path: 'dev/lib/schemas.ts', claim: 'x', content: 'export const' }],
        }),
      ),
    ).toThrow();
    // string livre no lugar da referência tipada
    expect(() =>
      parseHandoffDraft(validDraftV2({ evidence: [{ kind: 'file', ref: 'a.ts:1-2', claim: 'x' }] })),
    ).toThrow();
    expect(() =>
      parseHandoffDraft(
        validDraftV2({ evidence: [{ kind: 'file', path: 'a.ts', lines: '148-120', claim: 'x' }] }),
      ),
    ).toThrow();
    expect(() =>
      parseHandoffDraft(validDraftV2({ evidence: [{ kind: 'transcript', claim: 'x' }] })),
    ).toThrow();
  });

  it('record selado v2 carrega os campos novos e exige accepted_commit', () => {
    expect(() => parseHandoffRecord({ ...validDraftV2(), sealed_at: NOW })).toThrow();
    const sealed = parseHandoffRecord({ ...validDraftV2(), accepted_commit: SHA, sealed_at: NOW });
    expect(isHandoffRecordV2(sealed)).toBe(true);
    if (!isHandoffRecordV2(sealed)) throw new Error('record v2 esperado');
    expect(sealed.what_i_did_not_check).toEqual(['comportamento sob concorrência']);
    expect(sealed.accepted_commit).toBe(SHA);
  });

  it('draft v2 não tem accepted_commit', () => {
    expect(() => parseHandoffDraft(validDraftV2({ accepted_commit: SHA }))).toThrow();
  });

  it('mantém o budget de 4 KiB para v2', () => {
    const inflated = validDraftV2({
      what_i_did_not_check: Array.from({ length: 5 }, () => 'lacuna reconhecida '.repeat(12)),
      open_questions: Array.from({ length: 5 }, () => 'pergunta em aberto '.repeat(12)),
      evidence: Array.from({ length: 8 }, (_, index) => ({
        kind: 'file',
        path: `dev/lib/modulo-com-nome-bem-longo-${index}.ts`,
        lines: '1-999',
        claim: 'referência com claim longa '.repeat(5),
      })),
    });
    expect(byteSize(inflated)).toBeGreaterThan(MAXIMUM_HANDOFF_BYTES);
    expect(() => parseHandoffDraft(inflated)).toThrow(BudgetExceededError);
  });

  it('respeita o budget num v2 realista', () => {
    expect(byteSize(validDraftV2())).toBeLessThanOrEqual(MAXIMUM_HANDOFF_BYTES);
  });
});

describe('readHandoffConfidence', () => {
  it('é UNKNOWN sem declaração e com texto irreconhecível', () => {
    expect(readHandoffConfidence(undefined).level).toBe('UNKNOWN');
    expect(readHandoffConfidence('   ').level).toBe('UNKNOWN');
    expect(readHandoffConfidence('lorem ipsum dolor').level).toBe('UNKNOWN');
  });

  it('reconhece declaração forte como HIGH', () => {
    expect(readHandoffConfidence('alta: comportamento verificado pelos testes').level).toBe('HIGH');
    expect(readHandoffConfidence('high confidence, fully verified').level).toBe('HIGH');
  });

  it('hedge reduz confiança', () => {
    expect(readHandoffConfidence('provavelmente correto').level).toBe('MEDIUM');
    expect(readHandoffConfidence('probably fine').level).toBe('MEDIUM');
    // hedge junto de linguagem forte NÃO recupera HIGH
    expect(readHandoffConfidence('alta confiança, acho que cobre tudo').level).toBe('MEDIUM');
    expect(readHandoffConfidence('high confidence, I think').level).toBe('MEDIUM');
  });

  it('negação nunca é lida otimisticamente', () => {
    expect(readHandoffConfidence('não verifiquei o caminho de erro').level).toBe('LOW');
    expect(readHandoffConfidence('not confident in the parser').level).toBe('LOW');
    // frase que "soa" positiva mas nega: continua pessimista
    expect(readHandoffConfidence('alta confiança, sem dúvidas').level).toBe('LOW');
    expect(readHandoffConfidence('totally sure, no doubts').level).toBe('LOW');
  });

  it('ambiguidade resolve para o lado conservador', () => {
    expect(readHandoffConfidence('alta em schemas, baixa no parser').level).toBe('LOW');
    expect(readHandoffConfidence('confident here, uncertain there').level).toBe('LOW');
    expect(readHandoffConfidence('confiança média').level).toBe('MEDIUM');
  });

  it('é determinístico e expõe os marcadores que usou', () => {
    const first = readHandoffConfidence('talvez cubra o caminho de erro');
    const second = readHandoffConfidence('talvez cubra o caminho de erro');
    expect(first).toEqual(second);
    expect(first.markers.length).toBeGreaterThan(0);
    expect(first.source).toBe('worker_statement');
  });
});

describe('TaskState', () => {
  const base = {
    id: 'M01',
    status: 'READY',
    phase: null,
    attempts: 0,
    process: null,
    base_sha: null,
    candidate_commit: null,
    accepted_commit: null,
    diagnostics: null,
    started_at: null,
    finished_at: null,
  };

  it('RUNNING exige phase', () => {
    expect(() => TaskState.parse({ ...base, status: 'RUNNING' })).toThrow();
    expect(TaskState.parse({ ...base, status: 'RUNNING', phase: 'EXECUTING' }).phase).toBe('EXECUTING');
  });

  it('phase só existe dentro de RUNNING', () => {
    expect(() => TaskState.parse({ ...base, status: 'READY', phase: 'EXECUTING' })).toThrow();
  });

  it('PASS exige accepted_commit e accepted_commit exige PASS', () => {
    expect(() => TaskState.parse({ ...base, status: 'PASS' })).toThrow();
    expect(() => TaskState.parse({ ...base, status: 'FAIL', accepted_commit: SHA })).toThrow();
    expect(TaskState.parse({ ...base, status: 'PASS', accepted_commit: SHA }).accepted_commit).toBe(SHA);
  });

  it('não admite estado fora dos 7 do harness', () => {
    expect(() => TaskState.parse({ ...base, status: 'BLOCKED' })).toThrow();
  });
});

describe('CompletionRecord', () => {
  const completion = {
    schema_version: 1,
    task_id: 'T1',
    status: 'PASS',
    report: null,
    orchestrator_evidence: {
      task_id: 'T1',
      base_sha: SHA,
      candidate_commit: SHA,
      accepted_commit: SHA,
      changed_files: [],
      working_tree_clean: true,
      process: null,
      duration_ms: 1,
      exit_code: 0,
      timed_out: false,
      revalidation: [],
      observed_at: '2026-08-05T12:00:00.000Z',
    },
    report_matches_evidence: true,
    discrepancies: [],
    closed_at: '2026-08-05T12:00:00.000Z',
  };

  it('só admite veredito: PASS ou FAIL', () => {
    expect(CompletionRecord.parse(completion).status).toBe('PASS');
    expect(CompletionRecord.parse({ ...completion, status: 'FAIL' }).status).toBe('FAIL');
    for (const status of ['READY', 'RUNNING', 'TIMED_OUT', 'MISSCOPED', 'INFRA_ERROR']) {
      expect(() => CompletionRecord.parse({ ...completion, status })).toThrow();
    }
  });

  it('preserva records legados e recovered, e amarra normal orchestrator ao finalization record', () => {
    expect(CompletionRecord.parse(completion).commit_origin).toBeUndefined();
    expect(
      CompletionRecord.parse({
        ...completion,
        finalization_mode: 'recovered',
        commit_origin: 'orchestrator_recovery',
        recovery_source_attempt: 2,
        recovery_record_sha256: 'c'.repeat(64),
      }).commit_origin,
    ).toBe('orchestrator_recovery');

    const orchestrated = {
      ...completion,
      finalization_mode: 'normal',
      commit_origin: 'orchestrator',
      orchestrated_finalization_attempt: 1,
      orchestrated_finalization_record_sha256: 'd'.repeat(64),
    };
    expect(CompletionRecord.parse(orchestrated).commit_origin).toBe('orchestrator');
    expect(() =>
      CompletionRecord.parse({
        ...orchestrated,
        orchestrated_finalization_record_sha256: undefined,
      }),
    ).toThrow(/finalization record/i);
  });
});

describe('OrchestratedFinalizationRecord', () => {
  const record = {
    schema_version: 1,
    task_id: 'T1',
    attempt: 1,
    base_sha: SHA,
    profile_id: 'orchestrator-v2',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    report_sha256: 'b'.repeat(64),
    handoff_draft_sha256: 'c'.repeat(64),
    report_result: 'SUCCESS',
    report_candidate_commit: null,
    commit_message: 'feat(T1): tarefa',
    changed_files: ['src/a.ts'],
    validation_results: [
      { argv: ['pnpm', 'test'], exit_code: 0, timed_out: false, duration_ms: 1 },
    ],
    patch_fingerprint: 'd'.repeat(64),
    candidate_commit: SHA,
    commit_origin: 'orchestrator',
    finalized_at: NOW,
  };

  it('aceita o record completo e recusa policy ou resultado de validação divergente', () => {
    expect(OrchestratedFinalizationRecord.parse(record).report_candidate_commit).toBeNull();
    expect(() =>
      OrchestratedFinalizationRecord.parse({
        ...record,
        validation_results: [
          { argv: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 1 },
        ],
      }),
    ).toThrow(/validação malsucedida/i);
    expect(() =>
      OrchestratedFinalizationRecord.parse({
        ...record,
        changed_files: ['src/b.ts', 'src/a.ts', 'src/a.ts'],
      }),
    ).toThrow(/único e ordenado/i);
  });
});
