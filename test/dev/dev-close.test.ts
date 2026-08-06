import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTask } from '../../dev/lib/close.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { headSha } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  ensureTaskInbox,
  handoffDraftPath,
  readCloseManifest,
  readCompletion,
  readHandoff,
  reportPath,
  writePacket,
} from '../../dev/lib/records.js';
import { canonicalSha256 } from '../../dev/lib/canonical.js';
import { verifyCloseBundle } from '../../dev/lib/recover.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

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

/** Coloca T1 em RUNNING/FINALIZING com packet persistido, como faz o orquestrador. */
async function startTask(taskId = 'T1'): Promise<string> {
  const baseSha = await headSha(paths.repoRoot);
  const task = loaded.byId.get(taskId)!;
  await writePacket(paths, buildTaskPacket({ task, baseSha, previousHandoff: null }));
  const state = await readState(paths);
  await writeState(
    paths,
    withTaskState(state, taskId, {
      status: 'RUNNING',
      phase: 'FINALIZING',
      base_sha: baseSha,
      attempts: 1,
      started_at: new Date().toISOString(),
    }),
  );
  return baseSha;
}

async function writeWorkerArtifacts(options: {
  taskId?: string;
  result?: 'SUCCESS' | 'FAILURE';
  candidateCommit: string | null;
  changedFiles: string[];
  withDraft?: boolean;
}): Promise<void> {
  const taskId = options.taskId ?? 'T1';
  await ensureTaskInbox(paths, taskId);
  await writeFile(
    reportPath(paths, taskId),
    JSON.stringify({
      schema_version: 1,
      task_id: taskId,
      self_reported_result: options.result ?? 'SUCCESS',
      summary: 'trabalho concluído',
      candidate_commit: options.candidateCommit,
      changed_files: options.changedFiles,
      validations: [{ argv: ['true'], exit_code: 0, timed_out: false, duration_ms: 5 }],
      decisions: [],
      lessons: [],
      relevant_files: [],
    }),
    'utf8',
  );
  if (options.withDraft === false) return;
  await writeFile(
    handoffDraftPath(paths, taskId),
    JSON.stringify({
      schema_version: 1,
      task_id: taskId,
      result: options.result === 'FAILURE' ? 'FAIL' : 'PASS',
      changed_files: options.changedFiles,
      validations: [{ argv: ['true'], exit_code: 0, timed_out: false, duration_ms: 5 }],
      decisions: [],
      lessons: [],
      next_relevant_files: [],
    }),
    'utf8',
  );
}

async function doWork(file = 'src/one.txt'): Promise<string> {
  await mkdir(path.join(sandbox.root, path.dirname(file)), { recursive: true });
  await writeFile(path.join(sandbox.root, file), 'conteúdo\n', 'utf8');
  return commitAll(sandbox.root, 'trabalho da T1');
}

describe('dev-close — caminho de aceitação', () => {
  it('promove candidate a accepted, sela handoff e marca PASS', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });

    const result = await closeTask({ paths, loaded, taskId: 'T1' });

    expect(result.kind).toBe('PASS');
    expect(result.discrepancies).toEqual([]);
    expect(result.completion?.orchestrator_evidence.accepted_commit).toBe(candidate);
    expect(result.completion?.orchestrator_evidence.revalidation).toHaveLength(1);
    expect(result.completion?.orchestrator_evidence.revalidation[0]?.exit_code).toBe(0);

    const task = getTaskState(await readState(paths), 'T1');
    expect(task.status).toBe('PASS');
    expect(task.phase).toBeNull();
    expect(task.accepted_commit).toBe(candidate);

    const handoff = await readHandoff(paths, 'T1');
    expect(handoff?.accepted_commit).toBe(candidate);
    expect(handoff?.result).toBe('PASS');
  });

  it('grava o bundle completo, com o manifesto amarrando completion e handoff', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });

    await closeTask({ paths, loaded, taskId: 'T1' });

    const manifest = await readCloseManifest(paths, 'T1');
    expect(manifest?.accepted_commit).toBe(candidate);
    expect(manifest?.completion_sha256).toBe(canonicalSha256(await readCompletion(paths, 'T1')));
    expect(manifest?.handoff_sha256).toBe(canonicalSha256(await readHandoff(paths, 'T1')));
    // O bundle completo é o que o dev-recover exige para reconstruir o PASS.
    expect((await verifyCloseBundle(paths, 'T1')).status).toBe('VALID');
  });

  it('é idempotente: fechar de novo não revalida nem reescreve', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });
    await closeTask({ paths, loaded, taskId: 'T1' });

    const again = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(again.kind).toBe('PASS');
    expect(again.reason).toMatch(/já fechada/);
    expect(getTaskState(await readState(paths), 'T1').accepted_commit).toBe(candidate);
  });

  it('registra discrepância quando o report mente sobre os arquivos alterados', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({
      candidateCommit: candidate,
      changedFiles: ['src/inexistente.txt'],
    });

    const result = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(result.kind).toBe('PASS');
    expect(result.completion?.report_matches_evidence).toBe(false);
    expect(result.discrepancies.join(' ')).toMatch(/arquivos alterados divergem/);
  });
});

describe('dev-close — FAIL', () => {
  it('falha quando a validação obrigatória falha na re-execução', async () => {
    const failingPlan = `
schema_version: 1
tasks:
  - id: T1
    title: tarefa com validação que falha
    objective: qualquer
    acceptance: [ok]
    validation:
      - argv: ['false']
        timeout_seconds: 30
`;
    await writeFile(paths.planFile, failingPlan, 'utf8');
    await commitAll(sandbox.root, 'plano com validação falha');
    loaded = await loadPlan(paths.planFile);
    await writeState(paths, buildInitialState(loaded.plan, loaded.planSha256));

    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });

    const result = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(result.kind).toBe('FAIL');
    expect(result.reason).toMatch(/validação obrigatória falhou/);

    const task = getTaskState(await readState(paths), 'T1');
    expect(task.status).toBe('FAIL');
    expect(task.accepted_commit).toBeNull();
    // O candidate commit não é apagado nem reescrito.
    expect(task.candidate_commit).toBe(candidate);
    expect(await headSha(paths.repoRoot)).toBe(candidate);
    expect(await readHandoff(paths, 'T1')).toBeNull();
  });

  it('falha quando o worker reporta falha explícita, sem revalidar', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({
      candidateCommit: candidate,
      changedFiles: ['src/one.txt'],
      result: 'FAILURE',
    });

    const result = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(result.kind).toBe('FAIL');
    expect(result.reason).toMatch(/falha explícita/);
    expect(result.completion?.orchestrator_evidence.revalidation).toEqual([]);
  });
});

describe('dev-close — guardas operacionais (permanecem RUNNING/FINALIZING)', () => {
  async function expectPending(match: RegExp): Promise<void> {
    const result = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(result.kind).toBe('PENDING');
    expect(result.reason).toMatch(match);
    const task = getTaskState(await readState(paths), 'T1');
    expect(task.status).toBe('RUNNING');
    expect(task.phase).toBe('FINALIZING');
    expect(task.diagnostics).toMatch(match);
  }

  it('handoff draft ausente', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({
      candidateCommit: candidate,
      changedFiles: ['src/one.txt'],
      withDraft: false,
    });
    await expectPending(/HandoffDraft/);
  });

  it('report ausente', async () => {
    await startTask();
    await doWork();
    await expectPending(/AgentCompletionReport ausente/);
  });

  it('report fora do schema nomeia o campo, em vez de dizer só "inválido"', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });
    // Foi assim que um agente real errou: campos inventados e sha abreviado.
    await writeFile(
      reportPath(paths, 'T1'),
      JSON.stringify({
        schema_version: 1,
        task_id: 'T1',
        self_reported_result: 'SUCCESS',
        summary: 'feito',
        candidate_commit: candidate.slice(0, 7),
        changed_files: ['src/one.txt'],
        validations: [],
        decisions: [],
        lessons: [],
        relevant_files: [],
        acceptance: [{ criterion: 'inventado', met: true }],
      }),
      'utf8',
    );

    const result = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(result.kind).toBe('PENDING');
    expect(result.reason).toMatch(/candidate_commit|acceptance/);
    expect(result.reason).not.toMatch(/ausente ou inválido/);
  });

  it('working tree suja', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });
    await writeFile(path.join(sandbox.root, 'src', 'sujeira.txt'), 'não commitado\n', 'utf8');
    await expectPending(/working tree suja/);
  });

  it('nenhum commit criado', async () => {
    await startTask();
    await writeWorkerArtifacts({ candidateCommit: null, changedFiles: [] });
    await expectPending(/base SHA/);
  });

  it('commit reportado diferente do HEAD', async () => {
    await startTask();
    await doWork();
    await writeWorkerArtifacts({ candidateCommit: 'f'.repeat(40), changedFiles: ['src/one.txt'] });
    await expectPending(/não é o HEAD/);
  });

  it('mais de um commit sobre o base SHA', async () => {
    await startTask();
    await doWork();
    const second = await doWork('src/extra.txt');
    await writeWorkerArtifacts({ candidateCommit: second, changedFiles: ['src/extra.txt'] });
    await expectPending(/não parte do base SHA/);
  });

  it('commit fora do escopo (dev/plan.yaml)', async () => {
    await startTask();
    await writeFile(paths.planFile, `${await readPlanSource()}\n# alterado pelo worker\n`, 'utf8');
    const candidate = await commitAll(sandbox.root, 'worker mexeu no plano');
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['dev/plan.yaml'] });
    await expectPending(/fora do escopo/);
  });

  it('retry é legítimo: corrigida a guarda, o mesmo fechamento passa', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({
      candidateCommit: candidate,
      changedFiles: ['src/one.txt'],
      withDraft: false,
    });
    expect((await closeTask({ paths, loaded, taskId: 'T1' })).kind).toBe('PENDING');

    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });
    const retried = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(retried.kind).toBe('PASS');
    expect(getTaskState(await readState(paths), 'T1').accepted_commit).toBe(candidate);
  });
});

describe('dev-close — o handoff selado é do orquestrador', () => {
  /** Draft cru, com os campos exatamente como um worker mentiroso os escreveria. */
  async function writeRawDraft(taskId: string, draft: Record<string, unknown>): Promise<void> {
    await ensureTaskInbox(paths, taskId);
    await writeFile(handoffDraftPath(paths, taskId), JSON.stringify(draft), 'utf8');
  }

  it('recusa draft que declara outra tarefa, sem tocar no handoff alheio', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });
    await writeRawDraft('T1', {
      schema_version: 1,
      task_id: 'T2',
      result: 'PASS',
      changed_files: ['src/one.txt'],
      validations: [],
      decisions: [],
      lessons: [],
      next_relevant_files: [],
    });

    const result = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(result.kind).toBe('PENDING');
    expect(result.reason).toMatch(/pertence a outra tarefa: T2/);
    expect(await readHandoff(paths, 'T2')).toBeNull();
    expect(await readHandoff(paths, 'T1')).toBeNull();
    expect(getTaskState(await readState(paths), 'T2').status).toBe('READY');
  });

  it('sela arquivos e validações da evidência, não os declarados pelo worker', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });
    await writeRawDraft('T1', {
      schema_version: 1,
      task_id: 'T1',
      result: 'PASS',
      changed_files: ['src/inventado.txt'],
      validations: [{ argv: ['mentira'], exit_code: 0, timed_out: false, duration_ms: 1 }],
      decisions: ['usei tsx'],
      lessons: ['nada'],
      next_relevant_files: ['src/one.txt'],
    });

    const result = await closeTask({ paths, loaded, taskId: 'T1' });
    expect(result.kind).toBe('PASS');

    const handoff = await readHandoff(paths, 'T1');
    expect(handoff?.task_id).toBe('T1');
    expect(handoff?.changed_files).toEqual(['src/one.txt']);
    expect(handoff?.validations.map((validation) => validation.argv)).toEqual([['true']]);
    expect(handoff?.accepted_commit).toBe(candidate);
    // O que é opinião do worker sobrevive: só o que é fato é reescrito.
    expect(handoff?.decisions).toEqual(['usei tsx']);
    expect(handoff?.next_relevant_files).toEqual(['src/one.txt']);
  });
});

describe('dev-close — CLI', () => {
  it('exit 0 em PASS, 6 em guarda pendente', async () => {
    await startTask();
    const candidate = await doWork();
    await writeWorkerArtifacts({
      candidateCommit: candidate,
      changedFiles: ['src/one.txt'],
      withDraft: false,
    });

    const pendingRun = await runDevCli('dev-close.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(pendingRun.exitCode).toBe(6);
    expect((JSON.parse(pendingRun.stdout) as { result: string }).result).toBe('PENDING');

    await writeWorkerArtifacts({ candidateCommit: candidate, changedFiles: ['src/one.txt'] });
    const passRun = await runDevCli('dev-close.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(passRun.exitCode, passRun.stderr).toBe(0);
    expect((JSON.parse(passRun.stdout) as { accepted_commit: string }).accepted_commit).toBe(candidate);
  });
});

async function readPlanSource(): Promise<string> {
  const { stdout } = await runGit(sandbox.root, ['show', 'HEAD:dev/plan.yaml']);
  return stdout;
}
