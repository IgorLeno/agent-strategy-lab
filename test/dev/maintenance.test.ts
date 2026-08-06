import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptMaintenance,
  assertLinearCommitChain,
  type MaintenanceValidationRunner,
} from '../../dev/lib/maintenance.js';
import { headSha, parentSha } from '../../dev/lib/git.js';
import { acquireLock } from '../../dev/lib/lock.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
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
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

const PLAN = `
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

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;
let authorized: string;
let validationCalls: ValidationCommand[];

const passingValidation: MaintenanceValidationRunner = async (command) => {
  validationCalls.push(command);
  return {
    argv: [...command.argv],
    exit_code: 0,
    timed_out: false,
    duration_ms: 1,
  };
};

beforeEach(async () => {
  sandbox = await makeSandboxRepo(PLAN);
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  authorized = await headSha(sandbox.root);
  validationCalls = [];
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

function adoptionInput(options: { bootstrapRange?: boolean; maxCommits?: number } = {}) {
  return {
    paths,
    reason: 'manutenção testada',
    bootstrapRange: options.bootstrapRange ?? false,
    ...(options.maxCommits === undefined ? {} : { maxCommits: options.maxCommits }),
    validationRunner: passingValidation,
    now: () => '2026-08-06T15:00:00.000Z',
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

describe('adoção normal de manutenção', () => {
  it('adota exatamente um filho direto e registra as quatro validações', async () => {
    const adopted = await createCommit('docs/maintenance.md', 'ok\n', 'manutenção permitida');

    const result = await adoptMaintenance(adoptionInput());

    expect(result.alreadyAdopted).toBe(false);
    expect(result.record.previous_authorized_head_sha).toBe(authorized);
    expect(result.record.adopted_head_sha).toBe(adopted);
    expect(result.record.commits).toEqual([
      { sha: adopted, parent_sha: authorized, changed_files: ['docs/maintenance.md'] },
    ]);
    expect(validationCalls.map((command) => command.argv)).toEqual([
      ['pnpm', 'typecheck'],
      ['pnpm', 'build'],
      ['pnpm', 'test'],
      ['git', 'diff', '--check', `${authorized}..${adopted}`],
    ]);
    expect((await readState(paths)).authorized_head_sha).toBe(adopted);
    expect(await readMaintenanceRecord(paths, adopted)).toEqual(result.record);
  });

  it('recusa dois commits no modo normal', async () => {
    await createCommit('docs/one.md', 'one\n', 'one');
    await createCommit('docs/two.md', 'two\n', 'two');

    await expect(adoptMaintenance(adoptionInput())).rejects.toThrow(/exatamente um commit/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });

  it('é idempotente quando o HEAD já possui record adotado', async () => {
    const adopted = await createCommit('docs/maintenance.md', 'ok\n', 'manutenção permitida');
    await adoptMaintenance(adoptionInput());
    validationCalls = [];

    const repeated = await adoptMaintenance(adoptionInput());

    expect(repeated.alreadyAdopted).toBe(true);
    expect(repeated.record.adopted_head_sha).toBe(adopted);
    expect(validationCalls).toEqual([]);
  });

  it('reconcilia record escrito antes do state sem reescrever evidência', async () => {
    const adopted = await createCommit('docs/maintenance.md', 'ok\n', 'manutenção permitida');
    const record: MaintenanceRecord = {
      schema_version: 1,
      previous_authorized_head_sha: authorized,
      adopted_head_sha: adopted,
      commits: [{ sha: adopted, parent_sha: authorized, changed_files: ['docs/maintenance.md'] }],
      changed_files: ['docs/maintenance.md'],
      validation_results: successfulResults(authorized, adopted),
      working_tree_clean: true,
      bootstrap_range: false,
      reason: 'record persistido antes do state',
      adopted_at: '2026-08-06T14:00:00.000Z',
    };
    await writeMaintenanceRecord(paths, record);
    const before = await readFile(maintenanceRecordPath(paths, adopted), 'utf8');

    const repeated = await adoptMaintenance(adoptionInput());

    expect(repeated.alreadyAdopted).toBe(true);
    expect(repeated.record).toEqual(record);
    expect(validationCalls).toEqual([]);
    expect((await readState(paths)).authorized_head_sha).toBe(adopted);
    expect(await readFile(maintenanceRecordPath(paths, adopted), 'utf8')).toBe(before);
  });
});

describe('bootstrap de faixa de manutenção', () => {
  it('exige --max-commits explícito e positivo', async () => {
    await createCommit('docs/one.md', 'one\n', 'one');
    await expect(
      adoptMaintenance(adoptionInput({ bootstrapRange: true })),
    ).rejects.toThrow(/max-commits.*positivo/);
  });

  it('adota dois commits lineares em ordem', async () => {
    const first = await createCommit('test/first.txt', 'first\n', 'first');
    const second = await createCommit('dev/checkpoint.ts', 'export {};\n', 'second');

    const result = await adoptMaintenance(adoptionInput({ bootstrapRange: true, maxCommits: 2 }));

    expect(result.record.bootstrap_range).toBe(true);
    expect(result.record.commits.map((commit) => commit.sha)).toEqual([first, second]);
    expect(result.record.commits.map((commit) => commit.parent_sha)).toEqual([authorized, first]);
    expect(result.record.adopted_head_sha).toBe(second);
  });

  it('recusa faixa maior que --max-commits', async () => {
    await createCommit('docs/one.md', 'one\n', 'one');
    await createCommit('docs/two.md', 'two\n', 'two');
    await createCommit('docs/three.md', 'three\n', 'three');

    await expect(
      adoptMaintenance(adoptionInput({ bootstrapRange: true, maxCommits: 2 })),
    ).rejects.toThrow(/max-commits|mais de 2 commits/);
  });

  it('recusa merge commit', async () => {
    await gitMust(['checkout', '-q', '-b', 'side']);
    await createCommit('docs/side.md', 'side\n', 'side');
    await gitMust(['checkout', '-q', 'main']);
    await createCommit('docs/main.md', 'main\n', 'main');
    await gitMust(['merge', '--no-ff', '-q', '-m', 'merge não permitido', 'side']);

    await expect(
      adoptMaintenance(adoptionInput({ bootstrapRange: true, maxCommits: 3 })),
    ).rejects.toThrow(/merge|mais de um parent/);
  });

  it('a validação do bootstrap recusa parent divergente', () => {
    const first = 'a'.repeat(40);
    const second = 'b'.repeat(40);
    expect(() =>
      assertLinearCommitChain(authorized, [
        { sha: first, parent_sha: authorized, changed_files: ['docs/one.md'] },
        { sha: second, parent_sha: 'c'.repeat(40), changed_files: ['docs/two.md'] },
      ]),
    ).toThrow(/parent|cadeia/);
  });

  it('recusa bootstrap quando já existe qualquer MaintenanceRecord', async () => {
    await mkdir(paths.maintenanceDir, { recursive: true });
    await writeFile(path.join(paths.maintenanceDir, `${'a'.repeat(40)}.json`), '{}\n', 'utf8');
    await createCommit('docs/one.md', 'one\n', 'one');

    await expect(
      adoptMaintenance(adoptionInput({ bootstrapRange: true, maxCommits: 2 })),
    ).rejects.toThrow(/MaintenanceRecord anterior/);
  });
});

describe('guardas de adoção', () => {
  it('o comando recusa execução quando outro processo segura o lock do harness', async () => {
    const lock = await acquireLock(paths, 'teste-concorrente');
    try {
      const result = await runDevCli(
        'dev-adopt-maintenance.ts',
        ['--repo', sandbox.root, '--reason', 'não deve executar'],
        { AGENTLAB_DEV_DIR: sandbox.devDir },
      );
      expect(result.exitCode).toBe(10);
      expect(result.stderr).toMatch(/harness ocupado/);
    } finally {
      await lock.release();
    }
  });

  it('recusa working tree suja', async () => {
    await createCommit('docs/one.md', 'one\n', 'one');
    await writeFile(path.join(sandbox.root, 'dirty.txt'), 'dirty\n', 'utf8');
    await expect(adoptMaintenance(adoptionInput())).rejects.toThrow(/working tree suja/);
  });

  it('recusa tarefa RUNNING', async () => {
    await createCommit('docs/one.md', 'one\n', 'one');
    const state = withTaskState(await readState(paths), 'M02', {
      status: 'RUNNING',
      phase: 'EXECUTING',
      started_at: '2026-08-06T15:00:00.000Z',
    });
    await writeState(paths, state);
    await expect(adoptMaintenance(adoptionInput())).rejects.toThrow(/M02.*RUNNING|tarefa RUNNING/);
  });

  it('recusa alteração em src/**', async () => {
    await createCommit('src/forbidden.ts', 'export {};\n', 'src não permitido');
    await expect(adoptMaintenance(adoptionInput())).rejects.toThrow(/src\/forbidden\.ts/);
  });

  it('recusa alteração em dev/plan.yaml', async () => {
    await writeFile(paths.planFile, `${await readFile(paths.planFile, 'utf8')}\n# proibido\n`, 'utf8');
    await commitAll(sandbox.root, 'plano não permitido');
    await expect(adoptMaintenance(adoptionInput())).rejects.toThrow(/dev\/plan\.yaml/);
  });

  it('falha de validação não escreve record nem atualiza state', async () => {
    const adopted = await createCommit('docs/one.md', 'one\n', 'one');
    const failingRunner: MaintenanceValidationRunner = async (command) => ({
      argv: [...command.argv],
      exit_code: command.argv[1] === 'build' ? 1 : 0,
      timed_out: false,
      duration_ms: 1,
    });

    await expect(
      adoptMaintenance({ ...adoptionInput(), validationRunner: failingRunner }),
    ).rejects.toThrow(/validação.*falhou|pnpm build/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
    expect(await readMaintenanceRecord(paths, adopted)).toBeNull();
  });
});

describe('integridade histórica e recovery', () => {
  it('adoção não altera M01, seus artifacts nem M02', async () => {
    const artifactFiles = [
      path.join(paths.completionsDir, 'M01.completion.json'),
      path.join(paths.completionsDir, 'M01.close-manifest.json'),
      path.join(paths.handoffsDir, 'M01.json'),
      path.join(paths.inboxDir, 'M01', 'report.json'),
      path.join(paths.inboxDir, 'M01', 'handoff-draft.json'),
    ];
    for (const [index, file] of artifactFiles.entries()) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `artifact-${index}\n`, 'utf8');
    }
    const artifactsBefore = await Promise.all(artifactFiles.map((file) => readFile(file, 'utf8')));
    const tasksBefore = JSON.stringify((await readState(paths)).tasks);
    await createCommit('docs/one.md', 'one\n', 'one');

    await adoptMaintenance(adoptionInput());

    const state = await readState(paths);
    expect(JSON.stringify(state.tasks)).toBe(tasksBefore);
    expect(getTaskState(state, 'M01')).toMatchObject({
      status: 'PASS',
      accepted_commit: authorized,
    });
    expect(getTaskState(state, 'M02')).toMatchObject({ status: 'READY', attempts: 0 });
    expect(await Promise.all(artifactFiles.map((file) => readFile(file, 'utf8')))).toEqual(
      artifactsBefore,
    );
  });

  it('dev-recover reconcilia record válido escrito antes do state', async () => {
    const adopted = await createCommit('docs/one.md', 'one\n', 'one');
    const record: MaintenanceRecord = {
      schema_version: 1,
      previous_authorized_head_sha: authorized,
      adopted_head_sha: adopted,
      commits: [
        {
          sha: adopted,
          parent_sha: (await parentSha(sandbox.root, adopted))!,
          changed_files: ['docs/one.md'],
        },
      ],
      changed_files: ['docs/one.md'],
      validation_results: successfulResults(authorized, adopted),
      working_tree_clean: true,
      bootstrap_range: false,
      reason: 'record escrito antes do state',
      adopted_at: '2026-08-06T15:00:00.000Z',
    };
    await writeMaintenanceRecord(paths, record);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);

    const dry = await recover(paths, loaded);
    expect(dry.state.authorized_head_sha).toBe(adopted);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);

    const applied = await runDevCli('dev-recover.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect((await readState(paths)).authorized_head_sha).toBe(adopted);
    expect(await readFile(maintenanceRecordPath(paths, adopted), 'utf8')).toContain(adopted);
  });

  it('recovery recusa record com validação obrigatória adulterada', async () => {
    const adopted = await createCommit('docs/one.md', 'one\n', 'one');
    const invalid = {
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
      validation_results: successfulResults(authorized, adopted).map((result, index) =>
        index === 0 ? { ...result, argv: ['true'] } : result,
      ),
      working_tree_clean: true,
      bootstrap_range: false,
      reason: 'record adulterado',
      adopted_at: '2026-08-06T15:00:00.000Z',
    };
    await mkdir(paths.maintenanceDir, { recursive: true });
    await writeFile(
      maintenanceRecordPath(paths, adopted),
      `${JSON.stringify(invalid, null, 2)}\n`,
      'utf8',
    );

    await expect(recover(paths, loaded)).rejects.toThrow(/validações obrigatórias/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });
});
