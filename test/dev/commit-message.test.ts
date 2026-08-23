import { describe, expect, it } from 'vitest';

import { deriveCommitMessage } from '../../dev/lib/commit-message.js';
import { CommitMessage, MAX_COMMIT_MESSAGE_BYTES, PlanTask } from '../../dev/lib/schemas.js';
import { PlannerTaskMetadata } from '../../src/planner/task.js';
import type { TaskTaxonomy } from '../../src/schemas/task-spec.js';

/**
 * `deriveCommitMessage` é uma função TOTAL sobre `PlanTask`. Cada caso aqui é
 * um representante de uma família de entradas que antes tornava a finalização
 * impossível — não um snapshot do texto que ela produz hoje.
 */

function plannerMetadata(taskClass: TaskTaxonomy['task_class']): PlannerTaskMetadata {
  return PlannerTaskMetadata.parse({
    taxonomy: {
      version: 1,
      task_class: taskClass,
      difficulty_declared: 'easy',
      complexity: 'local',
      ambiguity: 'low',
      verification: 'deterministic',
    },
    risk: 'low',
    probable_files: ['src/index.ts'],
    context_scope: { areas: ['bootstrap'] },
    context_requirements: [{ description: 'README do projeto', source_anchor: 'README.md' }],
    environment_requirements: [{ kind: 'tool', name: 'pnpm', reason: 'toolchain' }],
    estimated_duration: { expected: 120_000, maximum: 300_000 },
    validation_budget: { expected: 30_000, maximum: 60_000 },
    resource_envelope: {
      duration_ms: { expected: 120_000, maximum: 300_000 },
      tokens: { expected: 10_000, maximum: 25_000 },
      changed_files: { expected: 2, maximum: 5 },
    },
  });
}

function task(overrides: Partial<PlanTask> = {}): PlanTask {
  return PlanTask.parse({
    id: 'T1',
    title: 'implementar parser',
    objective: 'implementar o parser da linguagem de plano',
    acceptance: ['parser aceita o plano de exemplo'],
    validation: [{ argv: ['pnpm', 'test'], timeout_seconds: 60 }],
    ...overrides,
  });
}

/** A propriedade estrutural que o incidente violou. */
function expectSatisfiesCommitMessage(message: string): void {
  expect(CommitMessage.safeParse(message).success).toBe(true);
  expect(Buffer.byteLength(message, 'utf8')).toBeLessThanOrEqual(MAX_COMMIT_MESSAGE_BYTES);
  expect(message).not.toMatch(/\r|\n/);
  expect(message.trim()).not.toBe('');
}

describe('deriveCommitMessage', () => {
  it('produz mensagem legível para title curto', () => {
    const message = deriveCommitMessage(task());
    expect(message).toBe('feat(T1): implementar parser');
    expectSatisfiesCommitMessage(message);
  });

  it('mantém title acima do budget dentro do limite de bytes', () => {
    const title = 'reescrever o pipeline de validação oficial '.repeat(20);
    const message = deriveCommitMessage(task({ title }));
    expectSatisfiesCommitMessage(message);
    expect(message.startsWith('feat(T1): reescrever o pipeline')).toBe(true);
  });

  it('trunca Unicode sem partir caractere', () => {
    const title = `ação de manutenção — coração, açúcar, ção ${'ãç€😀'.repeat(60)}`;
    const message = deriveCommitMessage(task({ title }));
    expectSatisfiesCommitMessage(message);
    // Round-trip por UTF-8: se algum code point tivesse sido cortado ao meio,
    // o decode devolveria U+FFFD.
    const bytes = Buffer.from(message, 'utf8');
    expect(bytes.toString('utf8')).toBe(message);
    expect(message).not.toContain('�');
    expect(Buffer.byteLength(message, 'utf8')).toBeGreaterThan(message.length);
  });

  it('colapsa whitespace multilinha em uma linha só', () => {
    const message = deriveCommitMessage(
      task({ title: '  primeira linha\r\n\tsegunda   linha\n\n terceira  ' }),
    );
    expect(message).toBe('feat(T1): primeira linha segunda linha terceira');
    expectSatisfiesCommitMessage(message);
  });

  it('mantém a mensagem válida e vinculada à task quando o id é enorme', () => {
    const id = `foundation_${'x'.repeat(400)}`;
    const message = deriveCommitMessage(task({ id, title: 'a'.repeat(500) }));
    expectSatisfiesCommitMessage(message);
    expect(message.startsWith('feat(foundation_xxx')).toBe(true);
    // Vínculo estável com a task: ids distintos produzem scopes distintos.
    const other = deriveCommitMessage(task({ id: `${id}y`, title: 'a'.repeat(500) }));
    expect(other).not.toBe(message);
    expectSatisfiesCommitMessage(other);
  });

  it('é determinística', () => {
    const subject = task({ id: 'long_'.repeat(30), title: 'ação ' .repeat(120) });
    expect(deriveCommitMessage(subject)).toBe(deriveCommitMessage(subject));
  });

  it('usa objective quando o title não tem conteúdo', () => {
    const message = deriveCommitMessage(task({ title: '   ', objective: 'compor o pacote' }));
    expect(message).toBe('feat(T1): compor o pacote');
    expectSatisfiesCommitMessage(message);
  });

  it('não altera o PlanTask', () => {
    const subject = task({ title: 'x'.repeat(400) });
    const before = JSON.stringify(subject);
    deriveCommitMessage(subject);
    expect(JSON.stringify(subject)).toBe(before);
  });

  it('escolhe o conventional type por task_class', () => {
    const cases: ReadonlyArray<readonly [TaskTaxonomy['task_class'], string]> = [
      ['feature', 'feat'],
      ['bugfix', 'fix'],
      ['refactor', 'refactor'],
      ['test', 'test'],
      ['docs', 'docs'],
      ['chore', 'chore'],
    ];
    for (const [taskClass, type] of cases) {
      const message = deriveCommitMessage(
        task({ planner_metadata: plannerMetadata(taskClass) }),
      );
      expect(message).toBe(`${type}(T1): implementar parser`);
      expectSatisfiesCommitMessage(message);
    }
  });

  it('preserva o fallback compatível para PlanTask manual sem planner_metadata', () => {
    const subject = task();
    expect(subject.planner_metadata).toBeUndefined();
    expect(deriveCommitMessage(subject).startsWith('feat(')).toBe(true);
  });

  it('satisfaz CommitMessage para toda família de PlanTask válido', () => {
    const titles = [
      'x',
      'implementar parser',
      'á'.repeat(300),
      '😀'.repeat(200),
      'linha\n'.repeat(80),
      ' '.repeat(50),
    ];
    const ids = ['T1', 'foundation_app_scaffold', 'a'.repeat(300), 'A-1_b'];
    for (const id of ids) {
      for (const title of titles) {
        expectSatisfiesCommitMessage(deriveCommitMessage(task({ id, title })));
      }
    }
  });
});
