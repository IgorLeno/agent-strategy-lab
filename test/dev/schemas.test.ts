import { describe, expect, it } from 'vitest';
import {
  CompletionRecord,
  LaunchRecord,
  MAXIMUM_HANDOFF_BYTES,
  MAXIMUM_TASK_PACKET_BYTES,
  TaskState,
  OrchestratedFinalizationRecord,
  byteSize,
  parseHandoffDraft,
  parseHandoffRecord,
  parseTaskPacket,
} from '../../dev/lib/schemas.js';
import { BudgetExceededError } from '../../dev/lib/budget.js';

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
