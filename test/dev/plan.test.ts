import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { loadPlan, parsePlan } from '../../dev/lib/plan.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

describe('dev/plan.yaml real', () => {
  it('carrega, valida e produz hash canônico', async () => {
    const { plan, planSha256, byId } = await loadPlan(path.join(REPO_ROOT, 'dev', 'plan.yaml'));
    expect(plan.tasks.length).toBeGreaterThan(30);
    expect(planSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byId.get('M01')?.blocked_by).toEqual([]);
    expect(byId.get('M40B')?.blocked_by).toEqual(['M40A']);
  });

  it('toda tarefa tem pelo menos uma validação em argv, sem shell', async () => {
    const { plan } = await loadPlan(path.join(REPO_ROOT, 'dev', 'plan.yaml'));
    for (const task of plan.tasks) {
      expect(task.validation.length).toBeGreaterThan(0);
      for (const command of task.validation) {
        expect(command.argv.length).toBeGreaterThan(0);
        expect(command.argv.join(' ')).not.toMatch(/[;&|><]/);
      }
    }
  });

  it('o grafo de dependências não tem ciclos', async () => {
    const { plan, byId } = await loadPlan(path.join(REPO_ROOT, 'dev', 'plan.yaml'));
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 'done') return;
      if (state.get(id) === 'visiting') throw new Error(`ciclo: ${[...trail, id].join(' -> ')}`);
      state.set(id, 'visiting');
      for (const dependency of byId.get(id)?.blocked_by ?? []) visit(dependency, [...trail, id]);
      state.set(id, 'done');
    };
    expect(() => plan.tasks.forEach((task) => visit(task.id, []))).not.toThrow();
  });
});

describe('parsePlan', () => {
  const minimal = `
schema_version: 1
tasks:
  - id: T1
    title: primeira
    objective: fazer algo
    acceptance: [ok]
    validation:
      - argv: [pnpm, test]
        timeout_seconds: 60
`;

  it('aplica defaults de blocked_by, initial_files e constraints', () => {
    const { plan } = parsePlan(minimal);
    expect(plan.tasks[0]?.blocked_by).toEqual([]);
    expect(plan.tasks[0]?.initial_files).toEqual([]);
    expect(plan.tasks[0]?.include_previous_handoff).toBe(false);
  });

  it('o hash ignora formatação do YAML', () => {
    const reformatted = minimal.replace('tasks:', 'tasks:\n').replace(/\n\n+/g, '\n');
    expect(parsePlan(minimal).planSha256).toBe(parsePlan(reformatted).planSha256);
  });

  it('rejeita dependência inexistente', () => {
    expect(() => parsePlan(minimal.replace('title: primeira', 'title: primeira\n    blocked_by: [T9]'))).toThrow(
      /T9/,
    );
  });

  it('rejeita id duplicado', () => {
    expect(() => parsePlan(`${minimal}${minimal.split('tasks:')[1]}`)).toThrow();
  });

  it('rejeita tarefa sem validação', () => {
    expect(() =>
      parsePlan(`
schema_version: 1
tasks:
  - id: T1
    title: primeira
    objective: fazer algo
    acceptance: [ok]
    validation: []
`),
    ).toThrow();
  });
});
