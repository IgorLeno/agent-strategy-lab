import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptMaintenance, type MaintenanceValidationRunner } from '../../dev/lib/maintenance.js';
import { headSha, parentSha } from '../../dev/lib/git.js';
import {
  adoptPlanExtension,
  assertAppendOnlyPlanExtension,
} from '../../dev/lib/plan-extension.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, parsePlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  maintenanceRecordPath,
  readMaintenanceRecord,
  writeMaintenanceRecord,
} from '../../dev/lib/records.js';
import { recover } from '../../dev/lib/recover.js';
import type { MaintenanceRecord, ValidationCommand, ValidationResult } from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runGit, type Sandbox } from './helpers.js';

const BASE_PLAN = `
schema_version: 1
tasks:
  - id: M01
    title: primeira tarefa
    objective: trabalho histórico
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M02
    title: segunda tarefa
    blocked_by: [M01]
    objective: próxima tarefa
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
`;

const EXTENDED_PLAN = `
schema_version: 1
tasks:
  - id: M01
    title: primeira tarefa
    objective: trabalho histórico
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M02
    title: segunda tarefa
    blocked_by: [M01]
    objective: próxima tarefa
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M03
    title: terceira tarefa
    blocked_by: [M02]
    objective: extensão
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M04
    title: quarta tarefa
    blocked_by: [M03]
    objective: mais extensão
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
`;

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let authorized: string;
let validationCalls: ValidationCommand[];
let validationCwds: string[];

const passingValidation: MaintenanceValidationRunner = async (command, cwd) => {
  validationCalls.push(command);
  validationCwds.push(cwd);
  return {
    argv: [...command.argv],
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
  };
};

beforeEach(async () => {
  sandbox = await makeSandboxRepo(BASE_PLAN);
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  authorized = await headSha(sandbox.root);
  validationCalls = [];
  validationCwds = [];
  await ensureRuntimeDirs(paths);
  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: authorized });
  state = withTaskState(state, 'M01', {
    status: 'PASS',
    accepted_commit: authorized,
    candidate_commit: authorized,
    finished_at: '2026-08-06T12:46:01.263Z',
  });
  await writeState(paths, state);
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

async function writePlan(contents: string): Promise<void> {
  await writeFile(paths.planFile, contents, 'utf8');
}

async function commitPlan(message: string): Promise<string> {
  return commitAll(sandbox.root, message);
}

async function createCommit(file: string, contents: string, message: string): Promise<string> {
  const absolute = path.join(sandbox.root, file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
  return commitAll(sandbox.root, message);
}

async function gitMust(args: readonly string[]): Promise<string> {
  const result = await runGit(sandbox.root, args);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.trim();
}

function planAdoptionInput(target: string) {
  return {
    paths,
    target,
    reason: 'extensão de plano aprovada',
    validationRunner: passingValidation,
    now: () => '2026-08-11T18:00:00.000Z',
  };
}

function successfulResults(previous: string, adopted: string): ValidationResult[] {
  return [
    ['pnpm', 'typecheck'],
    ['pnpm', 'build'],
    ['pnpm', 'test'],
    ['git', 'diff', '--check', `${previous}..${adopted}`],
  ].map((argv) => ({ argv, exit_code: 0, timed_out: false, duration_ms: 1 }));
}

async function commitValidExtension(): Promise<string> {
  await writePlan(EXTENDED_PLAN);
  return commitPlan('plan: add M03-M04');
}

describe('assertAppendOnlyPlanExtension', () => {
  it('aceita sufixo novo e rejeita mutação/remoção/reorder', () => {
    const oldPlan = parsePlan(BASE_PLAN).plan;
    const extended = parsePlan(EXTENDED_PLAN).plan;
    expect(assertAppendOnlyPlanExtension(oldPlan, extended)).toEqual(['M03', 'M04']);

    const mutated = parsePlan(
      EXTENDED_PLAN.replace('trabalho histórico', 'objetivo adulterado'),
    ).plan;
    expect(() => assertAppendOnlyPlanExtension(oldPlan, mutated)).toThrow(/alterada: M01/);

    expect(() => assertAppendOnlyPlanExtension(extended, oldPlan)).toThrow(/removida/);

    const reordered = parsePlan(`
schema_version: 1
tasks:
  - id: M02
    title: segunda tarefa
    blocked_by: [M01]
    objective: próxima tarefa
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M01
    title: primeira tarefa
    objective: trabalho histórico
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M03
    title: terceira tarefa
    blocked_by: [M02]
    objective: extensão
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
`).plan;
    expect(() => assertAppendOnlyPlanExtension(oldPlan, reordered)).toThrow(/reorder|alterada/);
  });
});

describe('adoção de plan extension', () => {
  it('aceita filho direto só com plan.yaml append-only e avança authorized_head_sha', async () => {
    const target = await commitValidExtension();

    const result = await adoptPlanExtension(planAdoptionInput(target));

    expect(result.alreadyAdopted).toBe(false);
    expect(result.targetSha).toBe(target);
    expect(result.authorizedHeadSha).toBe(target);
    expect(result.addedTaskIds).toEqual(['M03', 'M04']);
    expect(result.record.adoption_kind).toBe('plan_extension');
    expect(result.record.changed_files).toEqual(['dev/plan.yaml']);
    expect(result.record.previous_authorized_head_sha).toBe(authorized);

    const state = await readState(paths);
    expect(state.authorized_head_sha).toBe(target);
    expect(state.plan_sha256).toBe((await loadPlan(paths.planFile)).planSha256);
    expect(getTaskState(state, 'M01')).toMatchObject({
      status: 'PASS',
      accepted_commit: authorized,
    });
    expect(getTaskState(state, 'M02')).toMatchObject({ status: 'READY' });
    expect(getTaskState(state, 'M03')).toMatchObject({ status: 'READY', attempts: 0 });
    expect(getTaskState(state, 'M04')).toMatchObject({ status: 'READY', attempts: 0 });

    const oldCanonical = parsePlan(BASE_PLAN).plan.tasks.map((task) => JSON.stringify(task));
    const newCanonical = (await loadPlan(paths.planFile)).plan.tasks
      .slice(0, 2)
      .map((task) => JSON.stringify(task));
    expect(newCanonical).toEqual(oldCanonical);
  });

  it('dev-adopt-maintenance continua recusando dev/plan.yaml', async () => {
    await commitValidExtension();
    await expect(
      adoptMaintenance({
        paths,
        reason: 'não deve adotar plano',
        validationRunner: passingValidation,
        now: () => '2026-08-11T18:00:00.000Z',
      }),
    ).rejects.toThrow(/dev\/plan\.yaml/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });

  it('rejeita alteração de task histórica', async () => {
    await writePlan(EXTENDED_PLAN.replace('trabalho histórico', 'mutado'));
    const target = await commitPlan('plan: mutate M01');
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(/alterada: M01/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
    expect(await readMaintenanceRecord(paths, target)).toBeNull();
  });

  it('rejeita remoção de task histórica', async () => {
    await writePlan(`
schema_version: 1
tasks:
  - id: M01
    title: primeira tarefa
    objective: trabalho histórico
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M03
    title: terceira tarefa
    blocked_by: [M01]
    objective: extensão
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
`);
    const target = await commitPlan('plan: remove M02');
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(
      /alterada|reorder|removida/,
    );
    expect(await readMaintenanceRecord(paths, target)).toBeNull();
  });

  it('rejeita reorder de task histórica', async () => {
    await writePlan(`
schema_version: 1
tasks:
  - id: M02
    title: segunda tarefa
    blocked_by: [M01]
    objective: próxima tarefa
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M01
    title: primeira tarefa
    objective: trabalho histórico
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
  - id: M03
    title: terceira tarefa
    blocked_by: [M02]
    objective: extensão
    acceptance: [ok]
    validation: [{ argv: ['true'], timeout_seconds: 30 }]
`);
    const target = await commitPlan('plan: reorder');
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(/reorder|alterada/);
    expect(await readMaintenanceRecord(paths, target)).toBeNull();
  });

  it('rejeita commit que modifica plan.yaml e outro arquivo', async () => {
    await writePlan(EXTENDED_PLAN);
    await mkdir(path.join(sandbox.root, 'docs'), { recursive: true });
    await writeFile(path.join(sandbox.root, 'docs/extra.md'), 'x\n', 'utf8');
    const target = await commitAll(sandbox.root, 'plan + docs');
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(
      /somente dev\/plan\.yaml/,
    );
  });

  it('rejeita target cujo parent != authorized_head_sha', async () => {
    await createCommit('docs/gap.md', 'gap\n', 'gap');
    await writePlan(EXTENDED_PLAN);
    const target = await commitPlan('plan after gap');
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(
      /parent\(target\)|authorized_head_sha/,
    );
  });

  it('rejeita target que não é ancestral do HEAD', async () => {
    const target = await commitValidExtension();
    await gitMust(['checkout', '-q', '-b', 'side', authorized]);
    await createCommit('docs/side.md', 'side\n', 'side');
    await gitMust(['checkout', '-q', 'main']);
    // main está em target; side não contém target como ancestral de HEAD... 
    // para HEAD sem target como ancestral: checkout side
    await gitMust(['checkout', '-q', 'side']);
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(
      /não é ancestral/,
    );
    await gitMust(['checkout', '-q', 'main']);
  });

  it('com HEAD um commit depois do target: adota só o target', async () => {
    const target = await commitValidExtension();
    const later = await createCommit('dev/fix.ts', 'export {};\n', 'harness fix');
    expect(await headSha(sandbox.root)).toBe(later);

    const result = await adoptPlanExtension(planAdoptionInput(target));

    expect(result.authorizedHeadSha).toBe(target);
    expect((await readState(paths)).authorized_head_sha).toBe(target);
    expect(await headSha(sandbox.root)).toBe(later);
    expect(validationCwds.length).toBeGreaterThan(0);
    expect(validationCwds.every((cwd) => cwd !== sandbox.root)).toBe(true);
  });

  it('rejeita commit posterior que também modificou dev/plan.yaml', async () => {
    const target = await commitValidExtension();
    await writePlan(`${EXTENDED_PLAN}\n# trailing comment\n`);
    await commitPlan('second plan edit');
    const targetPlan = await gitMust(['show', `${target}:dev/plan.yaml`]);
    await writeFile(paths.planFile, targetPlan, 'utf8');
    await commitAll(sandbox.root, 'restore plan to target bytes');

    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(
      /posterior.*dev\/plan\.yaml/,
    );
  });

  it('recusa working tree suja', async () => {
    const target = await commitValidExtension();
    await writeFile(path.join(sandbox.root, 'dirty.txt'), 'dirty\n', 'utf8');
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(/working tree suja/);
  });

  it('recusa tarefa RUNNING', async () => {
    const target = await commitValidExtension();
    await writeState(
      paths,
      withTaskState(await readState(paths), 'M02', {
        status: 'RUNNING',
        phase: 'EXECUTING',
        started_at: '2026-08-11T18:00:00.000Z',
      }),
    );
    await expect(adoptPlanExtension(planAdoptionInput(target))).rejects.toThrow(/RUNNING/);
  });

  it('falha de validação não avança state nem cria evidence', async () => {
    const target = await commitValidExtension();
    const failingRunner: MaintenanceValidationRunner = async (command) => ({
      argv: [...command.argv],
      exit_code: command.argv[1] === 'build' ? 1 : 0,
      timed_out: false,
      duration_ms: 1,
    });

    await expect(
      adoptPlanExtension({ ...planAdoptionInput(target), validationRunner: failingRunner }),
    ).rejects.toThrow(/validação.*falhou|pnpm build/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
    expect(await readMaintenanceRecord(paths, target)).toBeNull();
  });

  it('crash/reexecução é idempotente: record válido conclui state sem reescrever', async () => {
    const target = await commitValidExtension();
    const record: MaintenanceRecord = {
      schema_version: 1,
      previous_authorized_head_sha: authorized,
      adopted_head_sha: target,
      commits: [
        {
          sha: target,
          parent_sha: (await parentSha(sandbox.root, target))!,
          changed_files: ['dev/plan.yaml'],
        },
      ],
      changed_files: ['dev/plan.yaml'],
      validation_results: successfulResults(authorized, target),
      working_tree_clean: true,
      bootstrap_range: false,
      reason: 'record antes do state',
      adopted_at: '2026-08-11T17:00:00.000Z',
      adoption_kind: 'plan_extension',
    };
    await writeMaintenanceRecord(paths, record);
    const before = await readFile(maintenanceRecordPath(paths, target), 'utf8');
    validationCalls = [];

    const repeated = await adoptPlanExtension(planAdoptionInput(target));

    expect(repeated.alreadyAdopted).toBe(true);
    expect(validationCalls).toEqual([]);
    expect((await readState(paths)).authorized_head_sha).toBe(target);
    expect(getTaskState(await readState(paths), 'M03')).toMatchObject({ status: 'READY' });
    expect(await readFile(maintenanceRecordPath(paths, target), 'utf8')).toBe(before);
  });

  it('dev-recover/reconcile reconhece record de plan_extension válido', async () => {
    const target = await commitValidExtension();
    const record: MaintenanceRecord = {
      schema_version: 1,
      previous_authorized_head_sha: authorized,
      adopted_head_sha: target,
      commits: [
        {
          sha: target,
          parent_sha: authorized,
          changed_files: ['dev/plan.yaml'],
        },
      ],
      changed_files: ['dev/plan.yaml'],
      validation_results: successfulResults(authorized, target),
      working_tree_clean: true,
      bootstrap_range: false,
      reason: 'recover plan extension',
      adopted_at: '2026-08-11T17:00:00.000Z',
      adoption_kind: 'plan_extension',
    };
    await writeMaintenanceRecord(paths, record);
    const newLoaded = await loadPlan(paths.planFile);

    const dry = await recover(paths, newLoaded);
    expect(dry.state.authorized_head_sha).toBe(target);
    expect(dry.state.tasks.map((task) => task.id)).toEqual(['M01', 'M02', 'M03', 'M04']);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);

    await writeState(paths, dry.state);
    expect((await readState(paths)).authorized_head_sha).toBe(target);
  });

  it('records históricos de maintenance sem adoption_kind continuam válidos', async () => {
    const adopted = await createCommit('docs/one.md', 'one\n', 'manutenção legada');
    const legacy = {
      schema_version: 1,
      previous_authorized_head_sha: authorized,
      adopted_head_sha: adopted,
      commits: [
        {
          sha: adopted,
          parent_sha: authorized,
          changed_files: ['docs/one.md'],
        },
      ],
      changed_files: ['docs/one.md'],
      validation_results: successfulResults(authorized, adopted),
      working_tree_clean: true,
      bootstrap_range: false,
      reason: 'legado sem adoption_kind',
      adopted_at: '2026-08-06T15:00:00.000Z',
    };
    await mkdir(paths.maintenanceDir, { recursive: true });
    await writeFile(
      maintenanceRecordPath(paths, adopted),
      `${JSON.stringify(legacy, null, 2)}\n`,
      'utf8',
    );

    const parsed = await readMaintenanceRecord(paths, adopted);
    expect(parsed).not.toBeNull();
    expect(parsed?.adoption_kind).toBeUndefined();

    const dry = await recover(paths, loaded);
    expect(dry.state.authorized_head_sha).toBe(adopted);
  });

  it('caso B: plan_sha já reconciliado, authorized ainda antigo', async () => {
    const target = await commitValidExtension();
    const newLoaded = await loadPlan(paths.planFile);
    const recovered = await recover(paths, newLoaded);
    expect(recovered.planChanged).toBe(true);
    // Simula recover que atualizou plan/tasks sem avançar authorized via record.
    await writeState(paths, {
      ...recovered.state,
      authorized_head_sha: authorized,
    });
    expect((await readState(paths)).plan_sha256).toBe(newLoaded.planSha256);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
    expect(getTaskState(await readState(paths), 'M03')?.status).toBe('READY');

    const result = await adoptPlanExtension(planAdoptionInput(target));
    expect(result.authorizedHeadSha).toBe(target);
    expect((await readState(paths)).authorized_head_sha).toBe(target);
    expect(getTaskState(await readState(paths), 'M01')).toMatchObject({ status: 'PASS' });
    expect(getTaskState(await readState(paths), 'M03')).toMatchObject({ status: 'READY' });
  });
});
