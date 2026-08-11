import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptMaintenanceRange,
  verifyMaintenanceRecord,
  type MaintenanceValidationRunner,
} from '../../dev/lib/maintenance.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  maintenanceRecordPath,
  readMaintenanceRecord,
  writeMaintenanceRecord,
} from '../../dev/lib/records.js';
import { recover } from '../../dev/lib/recover.js';
import {
  MaintenanceRecord,
  type ValidationCommand,
  type ValidationResult,
} from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import {
  commitAll,
  makeSandboxRepo,
  runDevCli,
  runGit,
  type Sandbox,
} from './helpers.js';

const previous = '1'.repeat(40);
const first = '2'.repeat(40);
const second = '3'.repeat(40);
const target = '4'.repeat(40);

function successfulResults(from: string, to: string) {
  return [
    ['pnpm', 'typecheck'],
    ['pnpm', 'build'],
    ['pnpm', 'test'],
    ['git', 'diff', '--check', `${from}..${to}`],
  ].map((argv) => ({ argv, exit_code: 0, timed_out: false, duration_ms: 1 }));
}

function rangeRecord() {
  return {
    schema_version: 1 as const,
    previous_authorized_head_sha: previous,
    adopted_head_sha: target,
    commits: [
      { sha: first, parent_sha: previous, changed_files: ['docs/first.md'] },
      { sha: second, parent_sha: first, changed_files: ['test/second.test.ts'] },
      { sha: target, parent_sha: second, changed_files: ['dev/range.ts'] },
    ],
    changed_files: ['dev/range.ts', 'docs/first.md', 'test/second.test.ts'],
    validation_results: successfulResults(previous, target),
    working_tree_clean: true as const,
    bootstrap_range: false,
    reason: 'faixa auditável',
    adopted_at: '2026-08-11T18:00:00.000Z',
    adoption_kind: 'maintenance_range' as const,
  };
}

describe('schema de maintenance_range', () => {
  it('aceita três commits com bootstrap_range=false', () => {
    const parsed = MaintenanceRecord.parse(rangeRecord());

    expect(parsed.adoption_kind).toBe('maintenance_range');
    expect(parsed.commits.map((commit) => commit.sha)).toEqual([first, second, target]);
  });

  it('recusa maintenance_range com somente um commit', () => {
    const record = rangeRecord();
    record.commits = [
      { sha: target, parent_sha: previous, changed_files: ['dev/range.ts'] },
    ];
    record.changed_files = ['dev/range.ts'];

    expect(() => MaintenanceRecord.parse(record)).toThrow(/maintenance_range|dois commits/);
  });

  it('recusa maintenance_range com bootstrap_range=true', () => {
    expect(() =>
      MaintenanceRecord.parse({ ...rangeRecord(), bootstrap_range: true }),
    ).toThrow(/maintenance_range|bootstrap_range/);
  });

  it('preserva maintenance normal, bootstrap histórico e plan_extension', () => {
    const normal = rangeRecord();
    delete (normal as Partial<typeof normal>).adoption_kind;
    normal.commits = [
      { sha: target, parent_sha: previous, changed_files: ['dev/range.ts'] },
    ];
    normal.changed_files = ['dev/range.ts'];
    expect(MaintenanceRecord.parse(normal).adoption_kind).toBeUndefined();

    const bootstrap = {
      ...rangeRecord(),
      bootstrap_range: true,
      adoption_kind: 'maintenance' as const,
    };
    expect(MaintenanceRecord.parse(bootstrap).commits).toHaveLength(3);

    const planExtension = {
      ...rangeRecord(),
      adopted_head_sha: first,
      commits: [
        { sha: first, parent_sha: previous, changed_files: ['dev/plan.yaml'] },
      ],
      changed_files: ['dev/plan.yaml'],
      validation_results: successfulResults(previous, first),
      adoption_kind: 'plan_extension' as const,
    };
    expect(MaintenanceRecord.parse(planExtension).adoption_kind).toBe('plan_extension');
  });
});

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

const aggregateDiffValidation: MaintenanceValidationRunner = async (command, cwd) => {
  validationCalls.push(command);
  validationCwds.push(cwd);
  if (command.argv[0] !== 'git') {
    return {
      argv: [...command.argv],
      exit_code: 0,
      timed_out: false,
      duration_ms: 1,
    };
  }
  const result = await runGit(cwd, command.argv.slice(1));
  return {
    argv: [...command.argv],
    exit_code: result.exitCode,
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
  validationCwds = [];
  await ensureRuntimeDirs(paths);
  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: authorized });
  state = withTaskState(state, 'M01', {
    status: 'PASS',
    accepted_commit: authorized,
    candidate_commit: authorized,
    finished_at: '2026-08-11T18:00:00.000Z',
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

function adoptionInput(
  rangeTarget: string,
  options: {
    maxCommits?: number;
    validationRunner?: MaintenanceValidationRunner;
  } = {},
) {
  return {
    paths,
    target: rangeTarget,
    maxCommits: options.maxCommits ?? 3,
    reason: 'faixa de manutenção testada',
    validationRunner: options.validationRunner ?? passingValidation,
    now: () => '2026-08-11T19:00:00.000Z',
  };
}

function recordedResults(from: string, to: string): ValidationResult[] {
  return successfulResults(from, to);
}

async function twoCommitRange(): Promise<{ first: string; target: string }> {
  const rangeFirst = await createCommit('docs/first.md', 'first\n', 'first');
  const rangeTarget = await createCommit('dev/second.ts', 'export {};\n', 'second');
  return { first: rangeFirst, target: rangeTarget };
}

function persistedRangeRecord(
  rangeFirst: string,
  rangeTarget: string,
): MaintenanceRecord {
  return MaintenanceRecord.parse({
    schema_version: 1,
    previous_authorized_head_sha: authorized,
    adopted_head_sha: rangeTarget,
    commits: [
      {
        sha: rangeFirst,
        parent_sha: authorized,
        changed_files: ['docs/first.md'],
      },
      {
        sha: rangeTarget,
        parent_sha: rangeFirst,
        changed_files: ['dev/second.ts'],
      },
    ],
    changed_files: ['dev/second.ts', 'docs/first.md'],
    validation_results: recordedResults(authorized, rangeTarget),
    working_tree_clean: true,
    bootstrap_range: false,
    reason: 'record persistido antes do state',
    adopted_at: '2026-08-11T18:30:00.000Z',
    adoption_kind: 'maintenance_range',
  });
}

describe('adoção auditável de maintenance_range', () => {
  it('adota três commits lineares como unidade, preservando ordem, parents e arquivos', async () => {
    const rangeFirst = await createCommit('docs/first.md', 'first\n', 'first');
    const rangeSecond = await createCommit('test/second.txt', 'second\n', 'second');
    const rangeTarget = await createCommit('dev/third.ts', 'export {};\n', 'third');

    const result = await adoptMaintenanceRange(adoptionInput(rangeTarget));

    expect(result.alreadyAdopted).toBe(false);
    expect(result.record).toMatchObject({
      previous_authorized_head_sha: authorized,
      adopted_head_sha: rangeTarget,
      bootstrap_range: false,
      adoption_kind: 'maintenance_range',
    });
    expect(result.record.commits).toEqual([
      {
        sha: rangeFirst,
        parent_sha: authorized,
        changed_files: ['docs/first.md'],
      },
      {
        sha: rangeSecond,
        parent_sha: rangeFirst,
        changed_files: ['test/second.txt'],
      },
      {
        sha: rangeTarget,
        parent_sha: rangeSecond,
        changed_files: ['dev/third.ts'],
      },
    ]);
    expect(validationCalls.map((command) => command.argv)).toEqual([
      ['pnpm', 'typecheck'],
      ['pnpm', 'build'],
      ['pnpm', 'test'],
      ['git', 'diff', '--check', `${authorized}..${rangeTarget}`],
    ]);
    expect((await readState(paths)).authorized_head_sha).toBe(rangeTarget);
    expect(await readMaintenanceRecord(paths, rangeTarget)).toEqual(result.record);
  });

  it('aceita whitespace ruim intermediário quando o target corrige o aggregate diff', async () => {
    await createCommit('docs/whitespace.md', 'bad \n', 'introduz whitespace');
    await createCommit('docs/whitespace.md', 'clean\n', 'corrige whitespace');
    const rangeTarget = await createCommit('dev/final.ts', 'export {};\n', 'target final');

    const result = await adoptMaintenanceRange(
      adoptionInput(rangeTarget, { validationRunner: aggregateDiffValidation }),
    );

    expect(result.record.adopted_head_sha).toBe(rangeTarget);
    expect(result.record.validation_results.at(-1)).toMatchObject({
      argv: ['git', 'diff', '--check', `${authorized}..${rangeTarget}`],
      exit_code: 0,
    });
  });

  it('recusa whitespace que permanece no target sem criar record nem avançar state', async () => {
    await createCommit('docs/whitespace.md', 'bad \n', 'introduz whitespace');
    const rangeTarget = await createCommit('dev/final.ts', 'export {};\n', 'target final');

    await expect(
      adoptMaintenanceRange(
        adoptionInput(rangeTarget, { validationRunner: aggregateDiffValidation }),
      ),
    ).rejects.toThrow(/git diff --check|validação falhou/);
    expect(await readMaintenanceRecord(paths, rangeTarget)).toBeNull();
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });

  it('falha de validation não cria record nem avança state', async () => {
    const { target: rangeTarget } = await twoCommitRange();
    const failingRunner: MaintenanceValidationRunner = async (command) => ({
      argv: [...command.argv],
      exit_code: command.argv[1] === 'build' ? 1 : 0,
      timed_out: false,
      duration_ms: 1,
    });

    await expect(
      adoptMaintenanceRange(
        adoptionInput(rangeTarget, { validationRunner: failingRunner }),
      ),
    ).rejects.toThrow(/pnpm build|validação falhou/);
    expect(await readMaintenanceRecord(paths, rangeTarget)).toBeNull();
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });

  it('recusa merge commit na faixa', async () => {
    await gitMust(['checkout', '-q', '-b', 'side']);
    await createCommit('docs/side.md', 'side\n', 'side');
    await gitMust(['checkout', '-q', 'main']);
    await createCommit('docs/main.md', 'main\n', 'main');
    await gitMust(['merge', '--no-ff', '-q', '-m', 'merge não permitido', 'side']);
    const rangeTarget = await headSha(sandbox.root);

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget)),
    ).rejects.toThrow(/merge|mais de um parent/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });

  it('recusa target sem ancestry até o authorized head', async () => {
    await gitMust(['checkout', '--orphan', 'unrelated']);
    await createCommit('docs/unrelated-root.md', 'root\n', 'unrelated root');
    const rangeTarget = await createCommit('docs/unrelated-target.md', 'target\n', 'unrelated target');
    await gitMust(['checkout', '-q', 'main']);

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget, { maxCommits: 5 })),
    ).rejects.toThrow(/base autorizada|não possui parent|ancestr|não descende/);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });

  it('recusa arquivo fora da allowlist em commit intermediário', async () => {
    await createCommit('src/forbidden.ts', 'export {};\n', 'src proibido');
    const rangeTarget = await createCommit('docs/final.md', 'final\n', 'final');

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget)),
    ).rejects.toThrow(/src\/forbidden\.ts|fora do escopo/);
  });

  it('recusa dev/plan.yaml em qualquer commit mesmo quando o target restaura seus bytes', async () => {
    const originalPlan = await readFile(paths.planFile, 'utf8');
    await writeFile(paths.planFile, `${originalPlan}\n# temporário\n`, 'utf8');
    await commitAll(sandbox.root, 'edita plano temporariamente');
    await writeFile(paths.planFile, originalPlan, 'utf8');
    const rangeTarget = await commitAll(sandbox.root, 'restaura plano');

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget)),
    ).rejects.toThrow(/dev\/plan\.yaml/);
  });

  it('recusa faixa maior que --max-commits', async () => {
    await createCommit('docs/one.md', 'one\n', 'one');
    await createCommit('docs/two.md', 'two\n', 'two');
    const rangeTarget = await createCommit('docs/three.md', 'three\n', 'three');

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget, { maxCommits: 2 })),
    ).rejects.toThrow(/max-commits|mais de 2 commits/);
  });

  it('exige --max-commits inteiro e positivo', async () => {
    const { target: rangeTarget } = await twoCommitRange();

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget, { maxCommits: 0 })),
    ).rejects.toThrow(/max-commits.*positivo|inteiro positivo/);
    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget, { maxCommits: 1.5 })),
    ).rejects.toThrow(/max-commits.*positivo|inteiro positivo/);
  });

  it('recusa working tree suja', async () => {
    const { target: rangeTarget } = await twoCommitRange();
    await writeFile(path.join(sandbox.root, 'dirty.txt'), 'dirty\n', 'utf8');

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget)),
    ).rejects.toThrow(/working tree suja/);
  });

  it('recusa task RUNNING', async () => {
    const { target: rangeTarget } = await twoCommitRange();
    await writeState(
      paths,
      withTaskState(await readState(paths), 'M02', {
        status: 'RUNNING',
        phase: 'EXECUTING',
        started_at: '2026-08-11T18:30:00.000Z',
      }),
    );

    await expect(
      adoptMaintenanceRange(adoptionInput(rangeTarget)),
    ).rejects.toThrow(/M02.*RUNNING|tarefa RUNNING/);
  });

  it('record existente antes do state é concluído sem revalidar nem reescrever evidence', async () => {
    const { first: rangeFirst, target: rangeTarget } = await twoCommitRange();
    const record = persistedRangeRecord(rangeFirst, rangeTarget);
    await writeMaintenanceRecord(paths, record);
    const before = await readFile(maintenanceRecordPath(paths, rangeTarget), 'utf8');

    const result = await adoptMaintenanceRange(adoptionInput(rangeTarget));

    expect(result.alreadyAdopted).toBe(true);
    expect(validationCalls).toEqual([]);
    expect((await readState(paths)).authorized_head_sha).toBe(rangeTarget);
    expect(await readFile(maintenanceRecordPath(paths, rangeTarget), 'utf8')).toBe(before);
  });

  it('recover reconhece maintenance_range válido e avança somente o state reconstruído', async () => {
    const { first: rangeFirst, target: rangeTarget } = await twoCommitRange();
    await writeMaintenanceRecord(paths, persistedRangeRecord(rangeFirst, rangeTarget));

    const result = await recover(paths, loaded);

    expect(result.state.authorized_head_sha).toBe(rangeTarget);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
  });

  it('valida target diferente de HEAD em worktree destacado com o range exato', async () => {
    const { target: rangeTarget } = await twoCommitRange();
    await createCommit('docs/later.md', 'later\n', 'commit posterior ao target');

    const result = await adoptMaintenanceRange(adoptionInput(rangeTarget));

    expect(result.record.adopted_head_sha).toBe(rangeTarget);
    expect(validationCwds).toHaveLength(4);
    expect(validationCwds.every((cwd) => cwd !== sandbox.root)).toBe(true);
    expect(validationCalls.at(-1)?.argv).toEqual([
      'git',
      'diff',
      '--check',
      `${authorized}..${rangeTarget}`,
    ]);
    expect(await headSha(sandbox.root)).not.toBe(rangeTarget);
    expect((await readState(paths)).authorized_head_sha).toBe(rangeTarget);
  });

  it('verifyMaintenanceRecord rederiva changed_files de cada commit', async () => {
    const { first: rangeFirst, target: rangeTarget } = await twoCommitRange();
    const record = persistedRangeRecord(rangeFirst, rangeTarget);
    const forged = MaintenanceRecord.parse({
      ...record,
      commits: [
        { ...record.commits[0], changed_files: ['docs/forged.md'] },
        record.commits[1],
      ],
      changed_files: ['dev/second.ts', 'docs/forged.md'],
    });

    await expect(verifyMaintenanceRecord(paths, forged)).rejects.toThrow(
      /changed_files.*diverge/,
    );
  });

  it('schema recusa validation_results que não provam previous..target', async () => {
    const { first: rangeFirst, target: rangeTarget } = await twoCommitRange();
    const record = persistedRangeRecord(rangeFirst, rangeTarget);
    const invalidResults = record.validation_results.map((result, index) =>
      index === 3
        ? { ...result, argv: ['git', 'diff', '--check', `${rangeFirst}..${rangeTarget}`] }
        : result,
    );

    expect(() =>
      MaintenanceRecord.parse({ ...record, validation_results: invalidResults }),
    ).toThrow(/validações obrigatórias/);
  });
});

describe('dev-adopt-maintenance-range CLI', () => {
  it('exige --max-commits explicitamente', async () => {
    const { target: rangeTarget } = await twoCommitRange();

    const result = await runDevCli(
      'dev-adopt-maintenance-range.ts',
      [
        '--repo',
        sandbox.root,
        '--target',
        rangeTarget,
        '--reason',
        'faixa sem limite deve falhar',
      ],
      { AGENTLAB_DEV_DIR: sandbox.devDir },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/max-commits.*inteiro.*positivo/i);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);
    expect(await readMaintenanceRecord(paths, rangeTarget)).toBeNull();
  });

  it('aceita target e max-commits explícitos e emite a faixa adotada', async () => {
    const { target: rangeTarget } = await twoCommitRange();
    const fakeBin = path.join(sandbox.devDir, '.fake-bin');
    const fakePnpm = path.join(fakeBin, 'pnpm');
    await mkdir(fakeBin, { recursive: true });
    await writeFile(fakePnpm, '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
    await chmod(fakePnpm, 0o755);

    const result = await runDevCli(
      'dev-adopt-maintenance-range.ts',
      [
        '--repo',
        sandbox.root,
        '--target',
        rangeTarget,
        '--max-commits',
        '2',
        '--reason',
        'faixa explícita testada',
      ],
      {
        AGENTLAB_DEV_DIR: sandbox.devDir,
        PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'ADOPTED',
      previous_authorized_head_sha: authorized,
      authorized_head_sha: rangeTarget,
      target_sha: rangeTarget,
    });
    expect((await readState(paths)).authorized_head_sha).toBe(rangeTarget);
    expect(await readMaintenanceRecord(paths, rangeTarget)).toMatchObject({
      adoption_kind: 'maintenance_range',
      bootstrap_range: false,
    });
  });
});
