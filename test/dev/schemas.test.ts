import { describe, expect, it } from 'vitest';
import {
  MAXIMUM_HANDOFF_BYTES,
  MAXIMUM_TASK_PACKET_BYTES,
  TaskState,
  byteSize,
  parseHandoffDraft,
  parseHandoffRecord,
  parseTaskPacket,
} from '../../dev/lib/schemas.js';
import { BudgetExceededError } from '../../dev/lib/budget.js';

const SHA = 'a'.repeat(40);
const NOW = '2026-08-05T12:00:00.000Z';

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
