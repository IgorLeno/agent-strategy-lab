import { rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { recover } from '../../dev/lib/recover.js';
import { canonicalSha256 } from '../../dev/lib/canonical.js';
import type { CompletionRecord, HandoffRecord } from '../../dev/lib/schemas.js';
import {
  readHandoff,
  writeCloseManifest,
  writeCompletion,
  writeHandoff,
} from '../../dev/lib/records.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

let sandbox: Sandbox;
let paths: HarnessPaths;
let loaded: LoadedPlan;

beforeEach(async () => {
  sandbox = await makeSandboxRepo();
  paths = resolveHarnessPaths(sandbox.root);
  loaded = await loadPlan(paths.planFile);
  await ensureRuntimeDirs(paths);
  await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));
});

afterEach(async () => {
  await rm(sandbox.root, { recursive: true, force: true });
});

const DEAD_PROCESS = {
  pid: 999_999,
  pgid: 999_999,
  started_at: '2026-08-05T12:00:00.000Z',
  proc_start_ticks: 1,
  command_sha256: 'a'.repeat(64),
};

describe('dev-recover', () => {
  it('RUNNING/EXECUTING com processo inexistente vira INFRA_ERROR', async () => {
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, 'T1', {
        status: 'RUNNING',
        phase: 'EXECUTING',
        process: DEAD_PROCESS,
        started_at: '2026-08-05T12:00:00.000Z',
      }),
    );

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('INFRA_ERROR');
    expect(result.reconciliations[0]?.reason).toMatch(/não existe mais/);
  });

  it('RUNNING/FINALIZING com processo encerrado continua pendente de fechamento', async () => {
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, 'T1', {
        status: 'RUNNING',
        phase: 'FINALIZING',
        process: DEAD_PROCESS,
        started_at: '2026-08-05T12:00:00.000Z',
      }),
    );

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('RUNNING');
    expect(result.state.tasks[0]?.phase).toBe('FINALIZING');
    expect(result.reconciliations[0]?.reason).toMatch(/retry de dev-close/);
  });

  it('processo vivo em EXECUTING é preservado', async () => {
    const alive = {
      ...DEAD_PROCESS,
      pid: process.pid,
      proc_start_ticks: await import('../../dev/lib/process-identity.js').then((m) =>
        m.readProcStartTicks(process.pid),
      ),
    };
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, 'T1', {
        status: 'RUNNING',
        phase: 'EXECUTING',
        process: alive,
        started_at: '2026-08-05T12:00:00.000Z',
      }),
    );

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('RUNNING');
    expect(result.reconciliations).toHaveLength(0);
  });

  it('fechamento completo reconstrói o PASS perdido do state', async () => {
    const accepted = await sealBundle();

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('PASS');
    expect(result.state.tasks[0]?.accepted_commit).toBe(accepted);
  });

  it('reconstrói o runtime inteiro a partir do plano quando o state some', async () => {
    await rm(paths.stateFile, { force: true });
    const result = await recover(paths, loaded);
    expect(result.stateWasMissing).toBe(true);
    expect(result.state.tasks.map((task) => task.id)).toEqual(['T1', 'T2']);
    expect(result.state.tasks.every((task) => task.status === 'READY')).toBe(true);
  });

  it('absorve mudança no plano preservando o que já passou', async () => {
    const accepted = await commitAll(sandbox.root, 'trabalho da T1');
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, 'T1', {
        status: 'PASS',
        phase: null,
        accepted_commit: accepted,
        candidate_commit: accepted,
      }),
    );

    await writeFile(
      paths.planFile,
      `${await readPlan()}\n  - id: T3\n    title: nova\n    blocked_by: [T2]\n    objective: fazer T3\n    acceptance: [ok]\n    validation: [{ argv: ['true'], timeout_seconds: 30 }]\n`,
      'utf8',
    );
    const changedPlan = await loadPlan(paths.planFile);

    const result = await recover(paths, changedPlan);
    expect(result.planChanged).toBe(true);
    expect(result.state.plan_sha256).toBe(changedPlan.planSha256);
    expect(result.state.tasks.find((task) => task.id === 'T1')?.status).toBe('PASS');
    expect(result.state.tasks.find((task) => task.id === 'T3')?.status).toBe('READY');
  });

  it('CLI --dry-run relata sem gravar', async () => {
    const state = await readState(paths);
    await writeState(
      paths,
      withTaskState(state, 'T1', {
        status: 'RUNNING',
        phase: 'EXECUTING',
        process: DEAD_PROCESS,
        started_at: '2026-08-05T12:00:00.000Z',
      }),
    );

    const dry = await runDevCli('dev-recover.ts', ['--repo', sandbox.root, '--dry-run'], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(dry.exitCode, dry.stderr).toBe(0);
    expect(JSON.parse(dry.stdout).statuses.T1).toBe('INFRA_ERROR');
    expect((await readState(paths)).tasks[0]?.status).toBe('RUNNING');

    const applied = await runDevCli('dev-recover.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(applied.exitCode, applied.stderr).toBe(0);
    expect((await readState(paths)).tasks[0]?.status).toBe('INFRA_ERROR');
  });
});

describe('dev-recover — fechamento pela metade não vira PASS', () => {
  it('completion sem handoff selado nem manifesto', async () => {
    await sealBundle({ handoff: false, manifest: false });

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('READY');
    expect(result.reconciliations[0]?.reason).toMatch(/handoff selado ausente/);
  });

  it('completion e handoff sem manifesto — crash entre as escritas', async () => {
    await sealBundle({ manifest: false });

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('READY');
    expect(result.reconciliations[0]?.reason).toMatch(/manifesto de fechamento ausente/);
  });

  it('handoff selado de outra tarefa não fecha a atual', async () => {
    await sealBundle({ handoffTaskId: 'T2' });

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('READY');
    expect(result.reconciliations[0]?.reason).toMatch(/handoff selado ausente|pertence a/);
  });

  it('handoff adulterado depois do fechamento é detectado pelo manifesto', async () => {
    const accepted = await sealBundle();
    const handoff = (await readHandoff(paths, 'T1'))!;
    await writeHandoff(paths, { ...handoff, lessons: ['linha injetada depois do selo'] });

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('READY');
    expect(result.reconciliations[0]?.reason).toMatch(/handoff foi alterado/);
    expect(accepted).toMatch(/^[0-9a-f]{40}$/);
  });

  it('accepted_commit inexistente no repositório não fecha', async () => {
    await sealBundle({ acceptedCommit: 'e'.repeat(40) });

    const result = await recover(paths, loaded);
    expect(result.state.tasks[0]?.status).toBe('READY');
    expect(result.reconciliations[0]?.reason).toMatch(/não existe no repositório/);
  });
});

/**
 * Escreve um fechamento aceito como o dev-close escreveria, com controle de
 * qual peça falta — é assim que se simula crash entre as escritas.
 */
async function sealBundle(
  options: {
    handoff?: boolean;
    manifest?: boolean;
    handoffTaskId?: string;
    acceptedCommit?: string;
  } = {},
): Promise<string> {
  const accepted = options.acceptedCommit ?? (await commitAll(sandbox.root, 'trabalho aceito'));
  const closedAt = '2026-08-05T12:00:00.000Z';
  const completion = {
    schema_version: 1,
    task_id: 'T1',
    status: 'PASS',
    report: null,
    orchestrator_evidence: {
      task_id: 'T1',
      base_sha: 'b'.repeat(40),
      candidate_commit: accepted,
      accepted_commit: accepted,
      changed_files: [],
      working_tree_clean: true,
      process: null,
      duration_ms: 10,
      exit_code: 0,
      timed_out: false,
      revalidation: [],
      observed_at: closedAt,
    },
    report_matches_evidence: true,
    discrepancies: [],
    closed_at: closedAt,
  } satisfies CompletionRecord;
  await writeCompletion(paths, completion);

  const handoff = {
    schema_version: 1,
    task_id: options.handoffTaskId ?? 'T1',
    result: 'PASS',
    changed_files: [],
    validations: [],
    decisions: [],
    lessons: [],
    next_relevant_files: [],
    accepted_commit: accepted,
    sealed_at: closedAt,
  } satisfies HandoffRecord;
  if (options.handoff !== false) await writeHandoff(paths, handoff);

  if (options.manifest !== false) {
    await writeCloseManifest(paths, {
      schema_version: 1,
      task_id: 'T1',
      accepted_commit: accepted,
      completion_sha256: canonicalSha256(completion),
      handoff_sha256: canonicalSha256(handoff),
      sealed_at: closedAt,
    });
  }
  return accepted;
}

async function readPlan(): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return (await readFile(paths.planFile, 'utf8')).trimEnd();
}
