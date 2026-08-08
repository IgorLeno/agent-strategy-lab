import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileOnce } from '../../dev/lib/atomic.js';
import { canonicalSha256 } from '../../dev/lib/canonical.js';
import {
  changedFiles,
  headSha,
  parentShas,
  patchFingerprint,
  recordedCommitMessage,
  stagedFiles,
  workingTreeFiles,
} from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  completionPath,
  handoffDraftPath,
  originalCompletionEvidencePath,
  readCompletion,
  readOrchestratedRevalidation,
  reportPath,
  sourceBindingPath,
  writeCompletion,
  writePacket,
  writeMaintenanceRecord,
  writeRevalidationSourceBinding,
} from '../../dev/lib/records.js';
import { revalidateOrchestrated } from '../../dev/lib/revalidate.js';
import { recover, verifyCloseBundle } from '../../dev/lib/recover.js';
import type {
  AgentCompletionReport,
  CompletionRecord,
  HandoffDraft,
  RevalidationSourceBinding,
  ValidationCommand,
  ValidationResult,
} from '../../dev/lib/schemas.js';
import { buildInitialState, readState, withTaskState, writeState } from '../../dev/lib/state.js';
import { makeSandboxRepo, runGit, type Sandbox } from './helpers.js';

const roots: string[] = [];
const NOW = '2026-08-07T12:00:00.000Z';
const REASON = 'official gate failed once and passed unchanged';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function plan(commands: readonly ValidationCommand[]): string {
  const validations = commands
    .map(
      (command) =>
        `      - argv: [${command.argv.map((part) => JSON.stringify(part)).join(', ')}]\n` +
        `        timeout_seconds: ${command.timeout_seconds}`,
    )
    .join('\n');
  return `
schema_version: 1
tasks:
  - id: M03B
    title: EvaluationPlan mínimo (privado)
    objective: adicionar evaluation plan
    acceptance: ['schema válido']
    validation:
${validations}
  - id: M04
    title: próxima
    blocked_by: [M03B]
    objective: não executar
    acceptance: ['permanece READY']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;
}

interface SetupOptions {
  readonly taskStatus?: 'FAIL' | 'PASS';
  readonly workerResult?: 'SUCCESS' | 'FAILURE';
  readonly originalFailure?: boolean;
  readonly commands?: readonly ValidationCommand[];
  readonly changedFiles?: readonly string[];
  readonly extraFiles?: readonly string[];
  readonly separateFinalizationBase?: boolean;
  /** Arquivos que o commit de manutenção entre source base e finalization base altera. */
  readonly maintenanceFiles?: readonly string[];
}

interface Fixture {
  readonly sandbox: Sandbox;
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly sourceBase: string;
  readonly finalizationBase: string;
  readonly binding: RevalidationSourceBinding;
  readonly originalCompletionBytes: Buffer;
}

async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const commands = options.commands ?? [
    { argv: ['printf', 'first'], timeout_seconds: 30 },
    { argv: ['true'], timeout_seconds: 30 },
  ];
  const sandbox = await makeSandboxRepo(plan(commands));
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  const loaded = await loadPlan(paths.planFile);
  const sourceBase = await headSha(sandbox.root);

  const maintenanceFiles = options.maintenanceFiles ?? ['dev/harness-maintenance.txt'];
  if (options.separateFinalizationBase ?? true) {
    for (const file of maintenanceFiles) {
      await mkdir(path.dirname(path.join(sandbox.root, file)), { recursive: true });
      await writeFile(path.join(sandbox.root, file), 'maintenance\n');
    }
    await runGit(sandbox.root, ['add', '--', ...maintenanceFiles]);
    await runGit(sandbox.root, ['commit', '-q', '-m', 'maintenance']);
  }
  const finalizationBase = await headSha(sandbox.root);
  const files = [...(options.changedFiles ?? ['src/a.ts'])].sort();
  for (const file of [...files, ...(options.extraFiles ?? [])]) {
    await mkdir(path.dirname(path.join(sandbox.root, file)), { recursive: true });
    await writeFile(path.join(sandbox.root, file), `patch:${file}\n`);
  }

  const originalResults: ValidationResult[] = commands.map((command, index) => ({
    argv: [...command.argv],
    exit_code: options.originalFailure === false ? 0 : index === commands.length - 1 ? 1 : 0,
    timed_out: false,
    duration_ms: index + 1,
  }));
  const workerResult = options.workerResult ?? 'SUCCESS';
  const report: AgentCompletionReport = {
    schema_version: 1,
    task_id: 'M03B',
    self_reported_result: workerResult,
    summary: 'worker output preservado',
    candidate_commit: null,
    changed_files: files,
    validations: [],
    decisions: ['decisão original'],
    lessons: [],
    relevant_files: files.slice(0, 5),
  };
  const handoff: HandoffDraft = {
    schema_version: 1,
    task_id: 'M03B',
    result: workerResult === 'SUCCESS' ? 'PASS' : 'FAIL',
    changed_files: files,
    validations: [],
    decisions: ['decisão original'],
    lessons: [],
    next_relevant_files: files.slice(0, 5),
  };
  await mkdir(path.dirname(reportPath(paths, 'M03B')), { recursive: true });
  await writeFile(reportPath(paths, 'M03B'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(handoffDraftPath(paths, 'M03B'), `${JSON.stringify(handoff, null, 2)}\n`);
  await writePacket(paths, {
    schema_version: 1,
    task_id: 'M03B',
    title: 'EvaluationPlan mínimo (privado)',
    objective: 'adicionar evaluation plan',
    base_sha: sourceBase,
    initial_files: [],
    acceptance: ['schema válido'],
    validation: [...commands],
    constraints: [],
    previous_handoff: null,
    generated_at: NOW,
  });

  const completion: CompletionRecord = {
    schema_version: 1,
    task_id: 'M03B',
    status: 'FAIL',
    report,
    orchestrator_evidence: {
      task_id: 'M03B',
      base_sha: sourceBase,
      candidate_commit: null,
      accepted_commit: null,
      changed_files: files,
      working_tree_clean: false,
      process: null,
      duration_ms: 10,
      exit_code: 0,
      timed_out: false,
      revalidation: originalResults,
      observed_at: NOW,
    },
    report_matches_evidence: true,
    discrepancies: [],
    finalization_mode: 'normal',
    closed_at: NOW,
  };
  await writeCompletion(paths, completion);
  const originalCompletionBytes = await readFile(completionPath(paths, 'M03B'));
  await writeFileOnce(
    originalCompletionEvidencePath(paths, 'M03B', 1),
    originalCompletionBytes,
  );
  const reportBytes = await readFile(reportPath(paths, 'M03B'));
  const handoffBytes = await readFile(handoffDraftPath(paths, 'M03B'));
  const binding: RevalidationSourceBinding = {
    schema_version: 1,
    task_id: 'M03B',
    attempt: 1,
    source_base_sha: sourceBase,
    original_completion_path: 'original-completion.fail.json',
    original_completion_sha256: digest(originalCompletionBytes),
    report_sha256: digest(reportBytes),
    handoff_draft_sha256: digest(handoffBytes),
    changed_files: files,
    derived_patch_fingerprint: await patchFingerprint(sandbox.root),
    fingerprint_observed_at: NOW,
    fingerprint_provenance: 'derived_during_revalidation_preflight',
  };
  await writeRevalidationSourceBinding(paths, binding);

  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: sourceBase });
  state = withTaskState(state, 'M03B', {
    status: options.taskStatus ?? 'FAIL',
    phase: null,
    attempts: 1,
    process: null,
    base_sha: sourceBase,
    candidate_commit: null,
    accepted_commit: options.taskStatus === 'PASS' ? finalizationBase : null,
    diagnostics: 'validação oficial falhou',
    started_at: NOW,
    finished_at: NOW,
  });
  await writeState(paths, { ...state, authorized_head_sha: finalizationBase });
  return { sandbox, paths, loaded, sourceBase, finalizationBase, binding, originalCompletionBytes };
}

function run(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return revalidateOrchestrated({
    paths: fixture.paths,
    loaded: fixture.loaded,
    taskId: 'M03B',
    reasonCode: 'NONDETERMINISTIC_VALIDATION',
    reason: REASON,
    now: () => NOW,
    ...overrides,
  });
}

describe('dev-revalidate preconditions', () => {
  it('recusa tarefa que não está FAIL', async () => {
    const fixture = await setup({ taskStatus: 'PASS' });
    await expect(run(fixture)).rejects.toThrow(/exige tarefa FAIL/i);
  });

  it('recusa worker FAILURE', async () => {
    const fixture = await setup({ workerResult: 'FAILURE' });
    await expect(run(fixture)).rejects.toThrow(/worker.*SUCCESS/i);
  });

  it('recusa FAIL sem validation oficial malsucedida', async () => {
    const fixture = await setup({ originalFailure: false });
    await expect(run(fixture)).rejects.toThrow(/validation oficial.*malsucedida/i);
  });

  it('recusa report ou handoff alterados depois do source binding', async () => {
    const reportFixture = await setup();
    await writeFile(reportPath(reportFixture.paths, 'M03B'), '{}\n');
    await expect(run(reportFixture)).rejects.toThrow(/hash do report/i);

    const handoffFixture = await setup();
    await writeFile(handoffDraftPath(handoffFixture.paths, 'M03B'), '{}\n');
    await expect(run(handoffFixture)).rejects.toThrow(/hash do handoff/i);
  });

  it('recusa patch alterado por fingerprint', async () => {
    const fixture = await setup();
    await writeFile(path.join(fixture.sandbox.root, 'src/a.ts'), 'patch alterado\n');
    await expect(run(fixture)).rejects.toThrow(/fingerprint/i);
  });

  it('recusa arquivos extras', async () => {
    const fixture = await setup({ extraFiles: ['src/extra.ts'] });
    await expect(run(fixture)).rejects.toThrow(/arquivos reais.*divergem/i);
  });

  it('recusa mudanças staged', async () => {
    const fixture = await setup();
    await runGit(fixture.sandbox.root, ['add', '--', 'src/a.ts']);
    await expect(run(fixture)).rejects.toThrow(/index.*staged/i);
  });

  it('recusa forbidden path', async () => {
    const fixture = await setup({ changedFiles: ['.claude/forbidden.txt'] });
    await expect(run(fixture)).rejects.toThrow(/caminho proibido/i);
  });

  it('recusa outro task RUNNING', async () => {
    const fixture = await setup();
    const state = await readState(fixture.paths);
    const withM04 = withTaskState(state, 'M04', {
      status: 'RUNNING',
      phase: 'EXECUTING',
      attempts: 1,
      process: null,
      base_sha: fixture.finalizationBase,
      started_at: NOW,
    });
    await writeState(fixture.paths, withM04);
    await expect(run(fixture)).rejects.toThrow(/outra tarefa RUNNING.*M04/i);
  });

  it('recusa attempt FAIL que já possui candidate', async () => {
    const fixture = await setup();
    const state = await readState(fixture.paths);
    await writeState(
      fixture.paths,
      withTaskState(state, 'M03B', { candidate_commit: fixture.finalizationBase }),
    );
    await expect(run(fixture)).rejects.toThrow(/FAIL não pode ter candidate/i);
  });
});

describe('dev-revalidate transaction', () => {
  it('primeira revalidation falha, não cria commit e preserva patch/FAIL auditável', async () => {
    const fixture = await setup({
      commands: [
        { argv: ['true'], timeout_seconds: 30 },
        { argv: ['false'], timeout_seconds: 30 },
      ],
    });
    const before = await headSha(fixture.sandbox.root);

    const result = await run(fixture);

    expect(result.record.outcome).toBe('FAIL');
    expect(result.record.candidate_commit).toBeNull();
    expect(await headSha(fixture.sandbox.root)).toBe(before);
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual(['src/a.ts']);
    expect(await stagedFiles(fixture.sandbox.root)).toEqual([]);
    expect((await readCompletion(fixture.paths, 'M03B'))?.status).toBe('FAIL');
    expect(
      await readFile(originalCompletionEvidencePath(fixture.paths, 'M03B', 1)),
    ).toEqual(fixture.originalCompletionBytes);
  });

  it('PASS executa lista oficial uma vez e repete somente o gate originalmente falho', async () => {
    const fixture = await setup();
    const result = await run(fixture);

    expect(result.record.revalidation_results.map((entry) => entry.argv)).toEqual([
      ['printf', 'first'],
      ['true'],
      ['true'],
      ['git', 'diff', '--cached', '--check'],
    ]);
    expect(result.record.validation_evidence).toHaveLength(4);
  });

  it('cria exatamente um candidate com parent finalization_base, arquivos e mensagem exatos', async () => {
    const fixture = await setup();
    const result = await run(fixture);
    const candidate = result.record.candidate_commit as string;

    expect(result.record.source_base_sha).toBe(fixture.sourceBase);
    expect(result.record.finalization_base_sha).toBe(fixture.finalizationBase);
    expect(await parentShas(fixture.sandbox.root, candidate)).toEqual([fixture.finalizationBase]);
    expect(await changedFiles(fixture.sandbox.root, candidate)).toEqual(['src/a.ts']);
    expect(await recordedCommitMessage(fixture.sandbox.root, candidate)).toBe(
      'feat(M03B): EvaluationPlan mínimo (privado)',
    );
    expect(await workingTreeFiles(fixture.sandbox.root)).toEqual([]);
    expect(await stagedFiles(fixture.sandbox.root)).toEqual([]);
  });

  it('Completion PASS referencia revalidation e preserva attempts 1/M04 READY', async () => {
    const fixture = await setup();
    const result = await run(fixture);
    const completion = await readCompletion(fixture.paths, 'M03B');
    const state = await readState(fixture.paths);

    expect(completion).toMatchObject({
      status: 'PASS',
      finalization_mode: 'normal',
      commit_origin: 'orchestrator',
      revalidated_after_validation_failure: true,
      revalidation_attempt: 1,
      revalidation_sequence: 1,
      revalidation_record_sha256: canonicalSha256(result.record),
    });
    expect(state.tasks.find((task) => task.id === 'M03B')).toMatchObject({
      status: 'PASS',
      attempts: 1,
      candidate_commit: result.record.candidate_commit,
      accepted_commit: result.record.candidate_commit,
    });
    expect(state.tasks.find((task) => task.id === 'M04')?.status).toBe('READY');
    expect((await verifyCloseBundle(fixture.paths, 'M03B')).status).toBe('VALID');
  });

  it('retoma crash depois do commit sem executar validações ou criar segundo commit', async () => {
    const fixture = await setup();
    await expect(
      run(fixture, {
        afterCommitCreated: async () => {
          throw new Error('crash after commit');
        },
      }),
    ).rejects.toThrow(/crash after commit/);
    const committed = await headSha(fixture.sandbox.root);

    const resumed = await run(fixture, {
      validationRunner: async () => {
        throw new Error('não deveria revalidar');
      },
    });

    expect(resumed.record.candidate_commit).toBe(committed);
    expect(await headSha(fixture.sandbox.root)).toBe(committed);
    expect(await parentShas(fixture.sandbox.root, committed)).toEqual([fixture.finalizationBase]);
  });

  it('segunda execução depois do PASS é idempotente', async () => {
    const fixture = await setup();
    const first = await run(fixture);
    const second = await run(fixture, {
      validationRunner: async () => {
        throw new Error('não deveria revalidar');
      },
    });

    expect(second.alreadyFinalized).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(await headSha(fixture.sandbox.root)).toBe(first.record.candidate_commit);
  });

  it('dev-recover sela record PASS completo depois de crash sem criar outro commit', async () => {
    const fixture = await setup();
    await expect(
      run(fixture, {
        afterRevalidationWritten: async () => {
          throw new Error('crash after revalidation record');
        },
      }),
    ).rejects.toThrow(/crash after revalidation record/);
    const candidate = await headSha(fixture.sandbox.root);
    expect((await readCompletion(fixture.paths, 'M03B'))?.status).toBe('FAIL');

    const dry = await recover(fixture.paths, fixture.loaded, { applyRecovered: false });
    expect(dry.state.tasks.find((task) => task.id === 'M03B')?.status).toBe('FAIL');
    expect(dry.reconciliations[0]?.reason).toMatch(/revalidation.*aguarda dev-recover/i);

    const applied = await recover(fixture.paths, fixture.loaded, { applyRecovered: true });
    expect(applied.state.tasks.find((task) => task.id === 'M03B')).toMatchObject({
      status: 'PASS',
      accepted_commit: candidate,
    });
    expect(await headSha(fixture.sandbox.root)).toBe(candidate);
    expect((await verifyCloseBundle(fixture.paths, 'M03B')).status).toBe('VALID');
  });

  it('dev-recover não promove candidate sem RevalidationRecord', async () => {
    const fixture = await setup();
    await expect(
      run(fixture, {
        afterCommitCreated: async () => {
          throw new Error('head only');
        },
      }),
    ).rejects.toThrow(/head only/);
    expect(await readOrchestratedRevalidation(fixture.paths, 'M03B', 1, 1)).toBeNull();

    const applied = await recover(fixture.paths, fixture.loaded, { applyRecovered: true });
    expect(applied.state.tasks.find((task) => task.id === 'M03B')?.status).toBe('FAIL');
    expect((await readCompletion(fixture.paths, 'M03B'))?.status).toBe('FAIL');
  });

  it('dev-recover exige source binding e FAIL original íntegros', async () => {
    const fixture = await setup();
    await expect(
      run(fixture, {
        afterRevalidationWritten: async () => {
          throw new Error('crash after record');
        },
      }),
    ).rejects.toThrow(/crash after record/);
    await rm(sourceBindingPath(fixture.paths, 'M03B', 1));

    const applied = await recover(fixture.paths, fixture.loaded, { applyRecovered: true });
    expect(applied.state.tasks.find((task) => task.id === 'M03B')?.status).toBe('FAIL');
    expect(applied.reconciliations[0]?.reason).toMatch(/revalidation.*incompleta/i);
  });

  it('nova revalidation depois de FAIL usa record sequencial sem overwrite', async () => {
    const fixture = await setup({
      commands: [{ argv: ['false'], timeout_seconds: 30 }],
    });
    const failed = await run(fixture);
    expect(failed.record.sequence).toBe(1);

    const successful = await run(fixture, {
      validationRunner: async (command: ValidationCommand, context: { sequence: number }) => ({
        result: { argv: [...command.argv], exit_code: 0, timed_out: false, duration_ms: 1 },
        evidence: {
          sequence: context.sequence,
          argv: [...command.argv],
          exit_code: 0,
          timed_out: false,
          duration_ms: 1,
          stdout_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          stderr_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          stdout_bytes: 0,
          stderr_bytes: 0,
          stdout_path: `validation-logs/M03B/attempt-1/${context.sequence.toString().padStart(4, '0')}.stdout.log`,
          stderr_path: `validation-logs/M03B/attempt-1/${context.sequence.toString().padStart(4, '0')}.stderr.log`,
        },
      }),
    });
    expect(successful.record.sequence).toBe(2);
    expect(await readOrchestratedRevalidation(fixture.paths, 'M03B', 1, 1)).toEqual(
      failed.record,
    );
  });
});

/**
 * HARNESS_VALIDATION_DEFECT afirma que a culpa foi da baseline, não do patch.
 * Só é dizível se existir manutenção adotada respondendo pelo defeito, e essa
 * manutenção não pode ter encostado no patch da task.
 */
describe('dev-revalidate HARNESS_VALIDATION_DEFECT', () => {
  const DEFECT_REASON = 'official validation was blocked by a harness defect fixed by maintenance';

  function defectRun(fixture: Fixture, overrides: Record<string, unknown> = {}) {
    return run(fixture, {
      reasonCode: 'HARNESS_VALIDATION_DEFECT',
      reason: DEFECT_REASON,
      ...overrides,
    });
  }

  async function writeMaintenance(
    fixture: Fixture,
    maintenanceFiles: readonly string[],
  ): Promise<void> {
    await writeMaintenanceRecord(fixture.paths, {
      schema_version: 1,
      previous_authorized_head_sha: fixture.sourceBase,
      adopted_head_sha: fixture.finalizationBase,
      commits: [
        {
          sha: fixture.finalizationBase,
          parent_sha: fixture.sourceBase,
          changed_files: [...maintenanceFiles],
        },
      ],
      changed_files: [...new Set(maintenanceFiles)].sort(),
      validation_results: [
        ['pnpm', 'typecheck'],
        ['pnpm', 'build'],
        ['pnpm', 'test'],
        ['git', 'diff', '--check', `${fixture.sourceBase}..${fixture.finalizationBase}`],
      ].map((argv) => ({ argv, exit_code: 0, timed_out: false, duration_ms: 1 })),
      working_tree_clean: true,
      bootstrap_range: false,
      reason: 'correção do defeito do harness',
      adopted_at: NOW,
    });
  }

  it('recusa sem MaintenanceRecord entre source base e finalization base', async () => {
    const fixture = await setup();
    await expect(defectRun(fixture)).rejects.toThrow(
      /HARNESS_VALIDATION_DEFECT sem MaintenanceRecord válido/i,
    );
  });

  it('recusa quando source base e finalization base são o mesmo commit', async () => {
    const fixture = await setup({ separateFinalizationBase: false });
    await expect(defectRun(fixture)).rejects.toThrow(
      /exige manutenção adotada entre source_base_sha e finalization_base_sha/i,
    );
  });

  it('recusa manutenção que tocou arquivo do patch da task', async () => {
    // O arquivo do patch precisa estar num caminho que a manutenção PODE tocar
    // — senão a recusa viria do escopo de manutenção, não da sobreposição.
    const fixture = await setup({
      changedFiles: ['test/a.test.ts'],
      maintenanceFiles: ['dev/harness-maintenance.txt', 'test/a.test.ts'],
    });
    await writeMaintenance(fixture, ['dev/harness-maintenance.txt', 'test/a.test.ts']);
    await expect(defectRun(fixture)).rejects.toThrow(
      /tocou arquivo do patch da task: test\/a\.test\.ts/i,
    );
  });

  it('recusa fingerprint divergente mesmo com manutenção válida', async () => {
    const fixture = await setup();
    await writeMaintenance(fixture, ['dev/harness-maintenance.txt']);
    await writeFile(path.join(fixture.sandbox.root, 'src/a.ts'), 'patch alterado\n');
    await expect(defectRun(fixture)).rejects.toThrow(/fingerprint/i);
  });

  it('PASS com manutenção adotada disjunta do patch e candidate filho da nova base', async () => {
    const fixture = await setup();
    await writeMaintenance(fixture, ['dev/harness-maintenance.txt']);

    const result = await defectRun(fixture);
    const candidate = result.record.candidate_commit as string;

    expect(result.record.outcome).toBe('PASS');
    expect(result.record.reason_code).toBe('HARNESS_VALIDATION_DEFECT');
    expect(result.record.source_base_sha).toBe(fixture.sourceBase);
    expect(result.record.finalization_base_sha).toBe(fixture.finalizationBase);
    expect(result.record.patch_fingerprint).toBe(fixture.binding.derived_patch_fingerprint);
    expect(await parentShas(fixture.sandbox.root, candidate)).toEqual([fixture.finalizationBase]);
    expect(await changedFiles(fixture.sandbox.root, candidate)).toEqual(['src/a.ts']);
    expect((await readState(fixture.paths)).tasks.find((task) => task.id === 'M03B')).toMatchObject({
      status: 'PASS',
      attempts: 1,
      accepted_commit: candidate,
    });
  });

  it('não enfraquece NONDETERMINISTIC_VALIDATION: segue válido sem MaintenanceRecord', async () => {
    const fixture = await setup();
    const result = await run(fixture);
    expect(result.record.outcome).toBe('PASS');
    expect(result.record.reason_code).toBe('NONDETERMINISTIC_VALIDATION');
  });
});
