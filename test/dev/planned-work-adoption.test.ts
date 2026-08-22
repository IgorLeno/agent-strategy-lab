import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../../dev/lib/canonical.js';
import { headSha } from '../../dev/lib/git.js';
import type { MaintenanceValidationRunner } from '../../dev/lib/maintenance.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { adoptPlanExtension } from '../../dev/lib/plan-extension.js';
import {
  adoptPlannedWorkRange,
  PlannedWorkAdoptionError,
} from '../../dev/lib/planned-work-adoption.js';
import {
  plannedWorkAdoptionPath,
  projectHistoryBindingPath,
  handoffPath,
  launchRecordPath,
  readLaunchRecord,
  readPlannedWorkAdoption,
} from '../../dev/lib/records.js';
import { recover } from '../../dev/lib/recover.js';
import { selectNextTask } from '../../dev/lib/select.js';
import type { DevelopmentState, ValidationCommand } from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

function task(id: string, blockedBy: readonly string[], argv: readonly string[]): string {
  return `  - id: ${id}
    title: tarefa ${id}
    blocked_by: [${blockedBy.join(', ')}]
    objective: trabalho de ${id}
    acceptance: [ok]
    validation: [{ argv: [${argv.map((entry) => `'${entry}'`).join(', ')}], timeout_seconds: 60 }]
`;
}

const BASE_PLAN = `schema_version: 1
tasks:
${task('M01', [], ['true'])}${task('M02', ['M01'], ['true'])}`;

function extendedPlan(m04Argv: readonly string[] = ['true']): string {
  return `schema_version: 1
tasks:
${task('M01', [], ['true'])}${task('M02', ['M01'], ['true'])}${task('M03', ['M01'], ['true'])}${task('M04', ['M03'], m04Argv)}`;
}

let sandbox: Sandbox;
let paths: HarnessPaths;
let authorized: string;
let rangeValidationCalls: ValidationCommand[];

const passingRangeValidation: MaintenanceValidationRunner = async (command) => {
  rangeValidationCalls.push(command);
  return { argv: [...command.argv], exit_code: 0, timed_out: false, duration_ms: 1 };
};

interface Range {
  readonly planCommit: string;
  readonly m03: string;
  readonly m04: string;
  readonly bridge: string;
}

async function writeFileAt(relative: string, contents: string): Promise<void> {
  const absolute = path.join(sandbox.root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

/**
 * Reproduz a forma exata do incidente: uma extensão de plano MISTA (plano +
 * documentação no mesmo commit), tarefas implementadas fora do lifecycle e um
 * commit de manutenção de reconciliação no fim da faixa.
 */
async function buildRange(m04Argv: readonly string[] = ['true']): Promise<Range> {
  await writeFileAt('dev/plan.yaml', extendedPlan(m04Argv));
  await writeFileAt('docs/BACKLOG.md', '# backlog estendido\n');
  const planCommit = await commitAll(sandbox.root, 'plan: extend com M03 e M04');
  await writeFileAt('src/three.txt', 'M03\n');
  const m03 = await commitAll(sandbox.root, 'feat(M03): trabalho fora do lifecycle');
  await writeFileAt('src/four.txt', 'M04\n');
  const m04 = await commitAll(sandbox.root, 'feat(M04): trabalho fora do lifecycle');
  await writeFileAt('dev/lib/bridge.txt', 'reconciliation\n');
  const bridge = await commitAll(sandbox.root, 'fix(harness): reconciliation bridge');
  return { planCommit, m03, m04, bridge };
}

function adoptionInput(
  range: Range,
  overrides: {
    readonly target?: string;
    readonly taskCommits?: ReadonlyMap<string, string>;
    readonly maintenanceCommits?: readonly string[];
    readonly dryRun?: boolean;
  } = {},
) {
  return {
    paths,
    target: overrides.target ?? range.bridge,
    taskCommits:
      overrides.taskCommits ??
      new Map([
        ['M03', range.m03],
        ['M04', range.m04],
      ]),
    maintenanceCommits: overrides.maintenanceCommits ?? [range.bridge],
    reason: 'reconciliar trabalho aprovado executado fora do lifecycle',
    rangeValidationRunner: passingRangeValidation,
    ...(overrides.dryRun === undefined ? {} : { dryRun: overrides.dryRun }),
  };
}

async function currentPlan(): Promise<LoadedPlan> {
  return loadPlan(paths.planFile);
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  sandbox = await makeSandboxRepo(BASE_PLAN);
  paths = resolveHarnessPaths(sandbox.root);
  authorized = await headSha(sandbox.root);
  rangeValidationCalls = [];
  await ensureRuntimeDirs(paths);
  const loaded = await loadPlan(paths.planFile);
  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: authorized });
  state = withTaskState(state, 'M01', {
    status: 'PASS',
    accepted_commit: authorized,
    candidate_commit: authorized,
    attempts: 1,
    finished_at: '2026-08-06T12:46:01.263Z',
  });
  await writeState(paths, state);
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

describe('adoção de planned work executado fora do lifecycle', () => {
  it('adota a faixa inteira, revalida cada tarefa e avança a base autorizada', async () => {
    const range = await buildRange();
    const result = await adoptPlannedWorkRange(adoptionInput(range));

    expect(result.status).toBe('ADOPTED');
    if (result.status === 'DRY_RUN') throw new Error('esperava adoção aplicada');

    expect(result.record.adoption_kind).toBe('planned_work_range');
    expect(result.record.previous_authorized_head_sha).toBe(authorized);
    expect(result.record.adopted_head_sha).toBe(range.bridge);
    expect(result.record.plan_extension_commit_sha).toBe(range.planCommit);
    expect(result.record.plan_added_task_ids).toEqual(['M03', 'M04']);
    expect(result.record.commits.map((commit) => commit.role)).toEqual([
      'plan_extension',
      'planned_task',
      'planned_task',
      'unplanned_maintenance',
    ]);
    // A documentação que veio junto com o plano fica REGISTRADA, não escondida.
    expect(result.record.changed_files).toContain('docs/BACKLOG.md');
    expect(result.record.tasks.map((entry) => entry.task_id)).toEqual(['M03', 'M04']);
    for (const entry of result.record.tasks) {
      expect(entry.completion_origin).toBe('out_of_band_planned_work');
      expect(entry.executed_by_harness).toBe(false);
      expect(entry.validation_source).toBe('adoption_revalidation');
      expect(entry.validation_results.every((item) => item.exit_code === 0)).toBe(true);
      expect(entry.validation_evidence.length).toBe(entry.validation_results.length);
    }

    const state = await readState(paths);
    expect(state.authorized_head_sha).toBe(range.bridge);
    expect(getTaskState(state, 'M03').status).toBe('PASS');
    expect(getTaskState(state, 'M03').accepted_commit).toBe(range.m03);
    expect(getTaskState(state, 'M04').status).toBe('PASS');
    expect(getTaskState(state, 'M04').accepted_commit).toBe(range.m04);
    // Tarefa posterior não é adotada por tabela: M02 continua pendente.
    expect(getTaskState(state, 'M02').status).toBe('READY');

    const committed = (
      await runGit(sandbox.root, ['show', '-s', '--format=%cI', range.m03])
    ).stdout.trim();
    expect(getTaskState(state, 'M03').finished_at).toBe(new Date(committed).toISOString());

    // recover imediatamente depois não tem nada a reconciliar.
    const again = await recover(paths, await currentPlan());
    expect(again.reconciliations).toEqual([]);
    expect(again.state.authorized_head_sha).toBe(range.bridge);
    expect(again.adoptedOutOfBand.map((entry) => entry.task_id)).toEqual(['M03', 'M04']);
  });

  it('deixa a próxima tarefa do DAG selecionável sem tê-la adotado', async () => {
    const range = await buildRange();
    await adoptPlannedWorkRange(adoptionInput(range));
    const loaded = await currentPlan();
    const selection = selectNextTask(loaded, await readState(paths));
    expect(selection.status).toBe('SELECTED');
    expect(selection.task?.id).toBe('M02');
  });

  it('dry-run mostra a adoção inteira e não escreve arquivo, record nem state', async () => {
    const range = await buildRange();
    const before = await readFile(paths.stateFile, 'utf8');
    const result = await adoptPlannedWorkRange(adoptionInput(range, { dryRun: true }));

    expect(result.status).toBe('DRY_RUN');
    if (result.status !== 'DRY_RUN') throw new Error('esperava dry-run');
    expect(result.preview.previousAuthorizedHeadSha).toBe(authorized);
    expect(result.preview.targetSha).toBe(range.bridge);
    expect(result.preview.planExtensionCommitSha).toBe(range.planCommit);
    expect(result.preview.tasks.map((entry) => entry.taskId)).toEqual(['M03', 'M04']);
    expect(result.preview.tasks[0]?.validationArgv).toEqual([['true']]);
    expect(result.preview.stateTransitions).toEqual([
      { taskId: 'M03', from: 'ausente', to: 'PASS' },
      { taskId: 'M04', from: 'ausente', to: 'PASS' },
    ]);
    expect(result.preview.authorizedHeadTransition).toEqual({
      from: authorized,
      to: range.bridge,
    });
    expect(result.preview.rangeValidationArgv[0]).toEqual(['pnpm', 'typecheck']);

    expect(await exists(plannedWorkAdoptionPath(paths, range.bridge))).toBe(false);
    expect(await readFile(paths.stateFile, 'utf8')).toBe(before);
    expect(rangeValidationCalls).toEqual([]);
  });
});

describe('mapping inválido', () => {
  it('recusa tarefa inexistente no plano', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, { taskCommits: new Map([['M99', range.m03]]) }),
      ),
    ).rejects.toThrow(/tarefa ausente no plano atual: M99/);
  });

  it('recusa duas tarefas mapeadas para o mesmo commit', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, {
          taskCommits: new Map([
            ['M03', range.m03],
            ['M04', range.m03],
          ]),
        }),
      ),
    ).rejects.toThrow(/mapeado por M03 e M04/);
  });

  it('recusa commit fora da faixa', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, {
          taskCommits: new Map([
            ['M03', authorized],
            ['M04', range.m04],
          ]),
        }),
      ),
    ).rejects.toThrow(/está fora da faixa/);
  });

  it('recusa tarefa que não foi acrescentada pela extensão adotada', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, {
          taskCommits: new Map([
            ['M02', range.m03],
            ['M04', range.m04],
          ]),
        }),
      ),
    ).rejects.toThrow(/M02 não foi acrescentada pela extensão de plano/);
  });

  it('recusa commit da faixa sem papel declarado', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(adoptionInput(range, { maintenanceCommits: [] })),
    ).rejects.toThrow(new RegExp(`sem papel declarado: ${range.bridge}`));
  });

  it('recusa mapear uma tarefa para o commit de extensão de plano', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, {
          taskCommits: new Map([['M03', range.planCommit]]),
          maintenanceCommits: [range.m03, range.m04, range.bridge],
        }),
      ),
    ).rejects.toThrow(/ele não implementa tarefa/);
  });
});

describe('dependências', () => {
  it('recusa adotar filha sem a dependência satisfeita nem incluída', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, {
          taskCommits: new Map([['M04', range.m04]]),
          maintenanceCommits: [range.m03, range.bridge],
        }),
      ),
    ).rejects.toThrow(/M04: dependência M03 não está PASS nem entra nesta adoção/);
  });

  it('recusa quando o commit da filha não vem depois do commit da dependência', async () => {
    const range = await buildRange();
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, {
          taskCommits: new Map([
            ['M03', range.m04],
            ['M04', range.m03],
          ]),
        }),
      ),
    ).rejects.toThrow(/M04: commit não vem depois da dependência adotada M03/);
  });
});

describe('contrato de plano', () => {
  it('recusa mutação de plano que não é append-only', async () => {
    await writeFileAt(
      'dev/plan.yaml',
      `schema_version: 1
tasks:
${task('M01', [], ['echo'])}${task('M02', ['M01'], ['true'])}${task('M03', ['M01'], ['true'])}`,
    );
    const planCommit = await commitAll(sandbox.root, 'plan: reescreve M01');
    await writeFileAt('src/three.txt', 'M03\n');
    const m03 = await commitAll(sandbox.root, 'feat(M03)');
    await expect(
      adoptPlannedWorkRange({
        paths,
        target: m03,
        taskCommits: new Map([['M03', m03]]),
        maintenanceCommits: [],
        reason: 'tentativa',
        rangeValidationRunner: passingRangeValidation,
      }),
    ).rejects.toThrow(/task histórica alterada: M01/);
    expect(planCommit).not.toBe('');
  });

  it('recusa faixa com uma segunda reescrita de dev/plan.yaml', async () => {
    const range = await buildRange();
    await writeFileAt(
      'dev/plan.yaml',
      `${extendedPlan()}${task('M05', ['M04'], ['true'])}`,
    );
    const second = await commitAll(sandbox.root, 'plan: segunda extensão');
    await expect(
      adoptPlannedWorkRange(
        adoptionInput(range, { target: second, maintenanceCommits: [range.bridge, second] }),
      ),
    ).rejects.toThrow(/reescreve dev\/plan\.yaml mais de uma vez/);
  });

  it('recusa quando dev/plan.yaml atual não corresponde ao plano do target', async () => {
    const range = await buildRange();
    await writeFileAt('dev/plan.yaml', `${extendedPlan()}${task('M05', ['M04'], ['true'])}`);
    await expect(adoptPlannedWorkRange(adoptionInput(range))).rejects.toThrow(
      /working tree suja/,
    );
    await runGit(sandbox.root, ['checkout', '--', 'dev/plan.yaml']);
  });
});

describe('revalidação', () => {
  it('uma validação reprovada não escreve record nem muda o state', async () => {
    const range = await buildRange(['false']);
    const stateBefore = await readFile(paths.stateFile, 'utf8');

    await expect(adoptPlannedWorkRange(adoptionInput(range))).rejects.toThrow(
      /M04: revalidação falhou em false/,
    );

    expect(await exists(plannedWorkAdoptionPath(paths, range.bridge))).toBe(false);
    expect(await readFile(paths.stateFile, 'utf8')).toBe(stateBefore);
    const state = await readState(paths);
    expect(state.authorized_head_sha).toBe(authorized);
  });

  it('roda os comandos declarados pela tarefa sobre os bytes do commit mapeado', async () => {
    // `test -f src/three.txt` só passa no commit de M03 em diante — se a
    // revalidação rodasse no HEAD ou na base, o resultado seria outro.
    await writeFileAt('dev/plan.yaml', `schema_version: 1
tasks:
${task('M01', [], ['true'])}${task('M02', ['M01'], ['true'])}  - id: M03
    title: tarefa M03
    blocked_by: [M01]
    objective: trabalho de M03
    acceptance: [ok]
    validation: [{ argv: ['test', '-f', 'src/three.txt'], timeout_seconds: 60 }]
`);
    const planCommit = await commitAll(sandbox.root, 'plan: extend com M03');
    await writeFileAt('src/three.txt', 'M03\n');
    const m03 = await commitAll(sandbox.root, 'feat(M03)');

    const result = await adoptPlannedWorkRange({
      paths,
      target: m03,
      taskCommits: new Map([['M03', m03]]),
      maintenanceCommits: [],
      reason: 'revalidação sobre o commit mapeado',
      rangeValidationRunner: passingRangeValidation,
    });
    expect(result.status).toBe('ADOPTED');
    expect(planCommit).not.toBe('');
    if (result.status === 'DRY_RUN') throw new Error('esperava adoção');
    expect(result.record.tasks[0]?.validation_results[0]?.argv).toEqual([
      'test',
      '-f',
      'src/three.txt',
    ]);
  });
});

describe('proveniência out-of-band', () => {
  it('não cria attempt, handoff, launch record nem história canônica', async () => {
    const range = await buildRange();
    await adoptPlannedWorkRange(adoptionInput(range));

    const state = await readState(paths);
    for (const id of ['M03', 'M04']) {
      const entry = getTaskState(state, id);
      expect(entry.attempts).toBe(0);
      expect(entry.process).toBeNull();
      expect(entry.started_at).toBeNull();
      expect(entry.base_sha).toBeNull();
      expect(await exists(handoffPath(paths, id))).toBe(false);
      expect(await exists(launchRecordPath(paths, id))).toBe(false);
      expect(await readLaunchRecord(paths, id)).toBeNull();
      // Sem LaunchRecord não existe attempt canônico a materializar: a
      // história de performance é alimentada por attempts, nunca por PASS.
      expect(
        await exists(path.dirname(projectHistoryBindingPath(paths, id, 0, 'x'))),
      ).toBe(false);
    }
    expect(await exists(path.join(sandbox.root, 'data', 'runs'))).toBe(false);
  });

  it('a tarefa adotada não empurra a base autorizada para dentro da faixa', async () => {
    const range = await buildRange();
    await adoptPlannedWorkRange(adoptionInput(range));
    // O último commit de tarefa é M04; a base tem que chegar ao bridge.
    const state = await readState(paths);
    expect(state.authorized_head_sha).not.toBe(range.m04);
    expect(state.authorized_head_sha).toBe(range.bridge);
  });

  it('fail closed quando o plano edita a tarefa depois da adoção', async () => {
    const range = await buildRange();
    await adoptPlannedWorkRange(adoptionInput(range));

    await writeFileAt(
      'dev/plan.yaml',
      `schema_version: 1
tasks:
${task('M01', [], ['true'])}${task('M02', ['M01'], ['true'])}  - id: M03
    title: tarefa M03 REESCRITA
    blocked_by: [M01]
    objective: outro objetivo
    acceptance: [outro]
    validation: [{ argv: ['true'], timeout_seconds: 60 }]
${task('M04', ['M03'], ['true'])}`,
    );

    const recovery = await recover(paths, await currentPlan());
    const m03 = recovery.state.tasks.find((entry) => entry.id === 'M03');
    expect(m03?.status).not.toBe('PASS');
    expect(m03?.diagnostics).toMatch(/não prova a definição atual de M03/);
    expect(recovery.adoptedOutOfBand.map((entry) => entry.task_id)).toEqual(['M04']);
  });

  it('o fingerprint gravado é o da definição revalidada', async () => {
    const range = await buildRange();
    const result = await adoptPlannedWorkRange(adoptionInput(range));
    if (result.status === 'DRY_RUN') throw new Error('esperava adoção');
    const loaded = await currentPlan();
    expect(result.record.tasks[0]?.plan_task_fingerprint_sha256).toBe(
      canonicalSha256(loaded.byId.get('M03')),
    );
  });
});

describe('transação e idempotência', () => {
  it('record publicado e crash antes do state: o rerun conclui a atualização', async () => {
    const range = await buildRange();
    const stateBefore: DevelopmentState = await readState(paths);
    await adoptPlannedWorkRange(adoptionInput(range));
    expect(await exists(plannedWorkAdoptionPath(paths, range.bridge))).toBe(true);

    // Crash simulado: o record sobreviveu, o state voltou ao que era antes.
    await writeState(paths, stateBefore);
    expect((await readState(paths)).authorized_head_sha).toBe(authorized);

    rangeValidationCalls = [];
    const rerun = await adoptPlannedWorkRange(adoptionInput(range));
    expect(rerun.status).toBe('ALREADY_ADOPTED');
    // Nada de revalidar o que já está selado.
    expect(rangeValidationCalls).toEqual([]);
    const state = await readState(paths);
    expect(state.authorized_head_sha).toBe(range.bridge);
    expect(getTaskState(state, 'M03').status).toBe('PASS');
    expect(getTaskState(state, 'M04').status).toBe('PASS');
  });

  it('rodar a mesma adoção duas vezes devolve ALREADY_ADOPTED sem novo record', async () => {
    const range = await buildRange();
    const first = await adoptPlannedWorkRange(adoptionInput(range));
    const bytes = await readFile(plannedWorkAdoptionPath(paths, range.bridge), 'utf8');
    const second = await adoptPlannedWorkRange(adoptionInput(range));

    expect(first.status).toBe('ADOPTED');
    expect(second.status).toBe('ALREADY_ADOPTED');
    expect(await readFile(plannedWorkAdoptionPath(paths, range.bridge), 'utf8')).toBe(bytes);
    const stored = await readPlannedWorkAdoption(paths, range.bridge);
    expect(stored?.adopted_head_sha).toBe(range.bridge);
  });
});

describe('guardas de segurança', () => {
  it('recusa working tree suja', async () => {
    const range = await buildRange();
    await writeFileAt('src/dirty.txt', 'sujo\n');
    await expect(adoptPlannedWorkRange(adoptionInput(range))).rejects.toThrow(
      PlannedWorkAdoptionError,
    );
    await rm(path.join(sandbox.root, 'src', 'dirty.txt'));
  });

  it('recusa tarefa RUNNING', async () => {
    const range = await buildRange();
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, 'M02', {
        status: 'RUNNING',
        phase: 'EXECUTING',
        started_at: new Date().toISOString(),
      }),
    );
    await expect(adoptPlannedWorkRange(adoptionInput(range))).rejects.toThrow(
      /tarefa RUNNING: M02/,
    );
  });

  it('recusa target que não descende da base autorizada', async () => {
    const range = await buildRange();
    await runGit(sandbox.root, ['checkout', '-q', '-b', 'lateral', authorized]);
    await writeFileAt('src/lateral.txt', 'lateral\n');
    const lateral = await commitAll(sandbox.root, 'lateral');
    await runGit(sandbox.root, ['checkout', '-q', 'main']);
    await expect(
      adoptPlannedWorkRange(adoptionInput(range, { target: lateral })),
    ).rejects.toThrow(/target não é ancestral do HEAD/);
  });

  it('recusa tarefa que já tem fechamento normal aceito', async () => {
    const range = await buildRange();
    const state = await readState(paths);
    await writeState(
      paths,
      DevelopmentStateWithPass(state, range.m03),
    );
    await expect(adoptPlannedWorkRange(adoptionInput(range))).rejects.toThrow(
      /M03 já estava concluída no state anterior/,
    );
  });
});

function DevelopmentStateWithPass(state: DevelopmentState, commit: string): DevelopmentState {
  return {
    ...state,
    tasks: [
      ...state.tasks,
      {
        id: 'M03',
        status: 'PASS' as const,
        phase: null,
        attempts: 1,
        process: null,
        base_sha: null,
        candidate_commit: commit,
        accepted_commit: commit,
        diagnostics: null,
        started_at: null,
        finished_at: '2026-08-21T00:00:00.000Z',
      },
    ],
  };
}

describe('o contrato do dev-adopt-plan continua estrito', () => {
  it('dev-adopt-plan segue recusando o commit misto que a adoção de planned work aceita', async () => {
    const range = await buildRange();
    await expect(
      adoptPlanExtension({
        paths,
        target: range.planCommit,
        reason: 'tentativa de adotar o commit misto como plan extension',
        validationRunner: passingRangeValidation,
      }),
    ).rejects.toThrow(/target deve modificar somente dev\/plan\.yaml/);
  });
});

describe('dev-adopt-planned-range CLI', () => {
  it('exige mapping explícito tarefa=commit', async () => {
    const range = await buildRange();
    const result = await runDevCli(
      'dev-adopt-planned-range.ts',
      [
        '--repo',
        sandbox.root,
        '--target',
        range.bridge,
        '--tasks',
        'M03,M04',
        '--reason',
        'sem mapping',
      ],
      { AGENTLAB_DEV_DIR: sandbox.devDir },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/mapping explícito tarefa=commit/);
  });

  it('--dry-run emite o preview completo sem escrever nada', async () => {
    const range = await buildRange();
    const before = await readFile(paths.stateFile, 'utf8');
    const result = await runDevCli(
      'dev-adopt-planned-range.ts',
      [
        '--repo',
        sandbox.root,
        '--target',
        range.bridge,
        '--tasks',
        `M03=${range.m03},M04=${range.m04}`,
        '--maintenance-commits',
        range.bridge,
        '--reason',
        'reconciliar faixa aprovada',
        '--dry-run',
      ],
      { AGENTLAB_DEV_DIR: sandbox.devDir },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      target: string;
      plan_extension_commit: string;
      tasks_requested: { task_id: string; commit: string }[];
      maintenance_commits: { sha: string }[];
      writes: { files: number; records: number; state: number };
    };
    expect(payload.status).toBe('DRY_RUN');
    expect(payload.target).toBe(range.bridge);
    expect(payload.plan_extension_commit).toBe(range.planCommit);
    expect(payload.tasks_requested.map((entry) => entry.task_id)).toEqual(['M03', 'M04']);
    expect(payload.maintenance_commits.map((entry) => entry.sha)).toEqual([range.bridge]);
    expect(payload.writes).toEqual({ files: 0, records: 0, state: 0 });
    expect(await exists(plannedWorkAdoptionPath(paths, range.bridge))).toBe(false);
    expect(await readFile(paths.stateFile, 'utf8')).toBe(before);
  });
});
