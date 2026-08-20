import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  finalizeOrchestratedTask,
  type OrchestratedValidationRunner,
} from '../../dev/lib/finalize-orchestrated.js';
import {
  finalizationFingerprint,
  validationResultsFingerprint,
  type ValidatedCandidateAcceptancePolicy,
} from '../../dev/lib/candidate-review.js';
import { closeTaskByLaunchPolicy } from '../../dev/lib/close-dispatch.js';
import { headSha, parentShas, stagedFiles, workingTreeFiles } from '../../dev/lib/git.js';
import { readProcStartTicks } from '../../dev/lib/process-identity.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import {
  ensureTaskInbox,
  handoffDraftPath,
  orchestratedFinalizationPath,
  readCandidateReview,
  readCloseManifest,
  readCompletion,
  readHandoff,
  readOrchestratedFinalization,
  reportPath,
  writeCandidateReview,
  writeLaunchRecord,
  writeOrchestratedFinalization,
  writePacket,
} from '../../dev/lib/records.js';
import { recover, verifyCloseBundle } from '../../dev/lib/recover.js';
import type {
  CandidateReviewRequirement,
  OrchestratedFinalizationRecord,
} from '../../dev/lib/schemas.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  getTaskState,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { commitAll, makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

const SHA = 'a'.repeat(40);
const NOW = '2026-08-07T12:00:00.000Z';
let root: string;
let paths: HarnessPaths;
let sandbox: Sandbox;
let loaded: LoadedPlan;
let baseSha: string;

const PLAN = `
schema_version: 1
tasks:
  - id: T1
    title: tarefa orquestrada
    objective: produzir patch
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
  - id: T2
    title: próxima
    blocked_by: [T1]
    objective: não executar
    acceptance: ['ok']
    validation: [{argv: ['true'], timeout_seconds: 30}]
`;

const passingRunner: OrchestratedValidationRunner = async (command) => ({
  argv: [...command.argv],
  exit_code: 0,
  timed_out: false,
  duration_ms: 1,
});

function record(): OrchestratedFinalizationRecord {
  return {
    schema_version: 1,
    task_id: 'T1',
    attempt: 2,
    base_sha: SHA,
    profile_id: 'orchestrator-v2',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    report_sha256: 'b'.repeat(64),
    handoff_draft_sha256: 'c'.repeat(64),
    report_result: 'SUCCESS',
    report_candidate_commit: null,
    commit_message: 'feat(T1): tarefa',
    changed_files: ['src/a.ts'],
    validation_results: [
      { argv: ['pnpm', 'test'], exit_code: 0, timed_out: false, duration_ms: 1 },
    ],
    patch_fingerprint: 'd'.repeat(64),
    candidate_commit: SHA,
    commit_origin: 'orchestrator',
    finalized_at: NOW,
  };
}

beforeEach(async () => {
  sandbox = await makeSandboxRepo(PLAN);
  root = sandbox.root;
  paths = resolveHarnessPaths(root);
  loaded = await loadPlan(paths.planFile);
  baseSha = await headSha(root);
  await ensureRuntimeDirs(paths);
});

async function prepareRun(
  changedFiles = ['src/new file.ts'],
  options: { result?: 'SUCCESS' | 'FAILURE'; reportCandidate?: string | null } = {},
): Promise<void> {
  const state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha, now: NOW });
  await writeState(
    paths,
    withTaskState(state, 'T1', {
      status: 'RUNNING',
      phase: 'FINALIZING',
      attempts: 1,
      base_sha: baseSha,
      process: null,
      started_at: NOW,
    }),
  );
  await writePacket(
    paths,
    buildTaskPacket({ task: loaded.byId.get('T1')!, baseSha, previousHandoff: null }),
  );
  await writeLaunchRecord(paths, {
    schema_version: 1,
    task_id: 'T1',
    profile_id: 'orchestrator-v2',
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    argv: ['fake-worker'],
    process: {
      pid: 999_997,
      pgid: 999_997,
      started_at: NOW,
      proc_start_ticks: 1,
      command_sha256: 'e'.repeat(64),
    },
    launch_id: '123e4567-e89b-42d3-a456-426614174000',
    survivors_killed: [],
    survivors_remaining: [],
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 1,
    exit_code: 0,
    timed_out: false,
    controlled: {},
    billing: null,
  });
  await ensureTaskInbox(paths, 'T1');
  const result = options.result ?? 'SUCCESS';
  await writeFile(
    reportPath(paths, 'T1'),
    JSON.stringify({
      schema_version: 1,
      task_id: 'T1',
      self_reported_result: result,
      summary: 'patch pronto',
      candidate_commit: options.reportCandidate ?? null,
      changed_files: changedFiles,
      validations: [],
      decisions: ['decisão'],
      lessons: ['lição'],
      relevant_files: changedFiles.slice(0, 5),
    }),
  );
  await writeFile(
    handoffDraftPath(paths, 'T1'),
    JSON.stringify({
      schema_version: 1,
      task_id: 'T1',
      result: result === 'SUCCESS' ? 'PASS' : 'FAIL',
      changed_files: changedFiles,
      validations: [],
      decisions: ['decisão'],
      lessons: ['lição'],
      next_relevant_files: changedFiles.slice(0, 5),
    }),
  );
  for (const file of changedFiles) {
    if (file.startsWith('.dev/') || file.startsWith('.dev-inbox/')) continue;
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), 'export const value = 1;\n');
  }
}

function finalize(overrides: Partial<Parameters<typeof finalizeOrchestratedTask>[0]> = {}) {
  return finalizeOrchestratedTask({
    paths,
    loaded,
    taskId: 'T1',
    validationRunner: passingRunner,
    now: () => NOW,
    ...overrides,
  });
}

async function commitCount(): Promise<number> {
  return Number((await runGit(root, ['rev-list', '--count', `${baseSha}..HEAD`])).stdout.trim());
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Autoridade de review usada pelos testes de fronteira. Não lança provider
 * nenhum: exercita exatamente o contrato que o control plane implementa —
 * declarar a exigência antes do candidate existir e publicar um veredito
 * DURÁVEL antes de qualquer promoção.
 */
const REVIEW_REQUIREMENT: CandidateReviewRequirement = {
  required: true,
  reviewer_profile_id: 'fake-reviewer-v1',
  diversity_requirement: 'preferred',
  policy_provenance: 'teste de fronteira de aceitação',
};

async function publishVerdict(
  record: OrchestratedFinalizationRecord,
  decision: 'ACCEPT' | 'REJECT',
): Promise<void> {
  await writeCandidateReview(paths, {
    schema_version: 1,
    task_id: record.task_id,
    attempt: record.attempt,
    candidate_sha: record.candidate_commit,
    finalization_record_sha256: finalizationFingerprint(record),
    validation_results_sha256: validationResultsFingerprint(record),
    reviewer_profile_id: REVIEW_REQUIREMENT.reviewer_profile_id,
    reviewer_invocation: {
      role: 'reviewer',
      workspace_access: 'READ_ONLY',
      read_only_mechanism: 'argv do worker falso: --agentlab-read-only',
      argv: ['node', 'fixtures/fake-worker.mjs', '--agentlab-read-only'],
      diversity_requirement: REVIEW_REQUIREMENT.diversity_requirement,
      fresh_context: true,
    },
    decision,
    reason: `veredito ${decision} do teste`,
    decided_at: NOW,
  });
}

function reviewingPolicy(
  decision: 'ACCEPT' | 'REJECT',
  onReview?: (record: OrchestratedFinalizationRecord) => Promise<void>,
): ValidatedCandidateAcceptancePolicy {
  return {
    requirementFor: () => REVIEW_REQUIREMENT,
    async review({ record }) {
      await onReview?.(record);
      await publishVerdict(record, decision);
      return decision === 'ACCEPT'
        ? { outcome: 'ACCEPT', reason: 'veredito ACCEPT do teste' }
        : { outcome: 'BLOCKED', code: 'REVIEW_REJECTED', reason: 'veredito REJECT do teste' };
    },
  };
}

/** Fotografia do runtime no instante EXATO em que o reviewer decide. */
interface ObservedAtReview {
  readonly candidate: string;
  readonly head: string;
  readonly status: string;
  readonly phase: string | null;
  readonly acceptedCommit: string | null;
  readonly completion: unknown;
  readonly handoff: unknown;
  readonly manifest: unknown;
  readonly authorizedHead: string | null;
}

describe('fronteira entre candidate validado e PASS aceito', () => {
  it('o reviewer decide ANTES de existir qualquer artefato de aceitação', async () => {
    await prepareRun(['src/reviewed.ts']);
    const observed: ObservedAtReview[] = [];

    const outcome = await finalize({
      acceptance: reviewingPolicy('ACCEPT', async (record) => {
        const state = await readState(paths);
        const task = getTaskState(state, 'T1');
        observed.push({
          candidate: record.candidate_commit,
          head: await headSha(root),
          status: task.status,
          phase: task.phase,
          acceptedCommit: task.accepted_commit,
          completion: await readCompletion(paths, 'T1'),
          handoff: await readHandoff(paths, 'T1'),
          manifest: await readCloseManifest(paths, 'T1'),
          authorizedHead: state.authorized_head_sha,
        });
      }),
    });

    expect(outcome.kind).toBe('PASS');
    expect(observed).toHaveLength(1);
    const seen = observed[0] as ObservedAtReview;
    // O candidate JÁ existe, validado e commitado: é isso que o reviewer revisa.
    expect(seen.candidate).toBe(seen.head);
    expect(seen.candidate).not.toBe(baseSha);
    // E NADA de aceitação existe ainda.
    expect(seen.status).toBe('RUNNING');
    expect(seen.phase).toBe('FINALIZING');
    expect(seen.acceptedCommit).toBeNull();
    expect(seen.completion).toBeNull();
    expect(seen.handoff).toBeNull();
    expect(seen.manifest).toBeNull();
    expect(seen.authorizedHead).toBe(baseSha);

    // Só depois do ACCEPT a aceitação passa a existir.
    const state = await readState(paths);
    expect(getTaskState(state, 'T1').status).toBe('PASS');
    expect(getTaskState(state, 'T1').accepted_commit).toBe(seen.candidate);
    expect(state.authorized_head_sha).toBe(seen.candidate);
    expect((await verifyCloseBundle(paths, 'T1')).status).toBe('VALID');
  });

  it('REJECT preserva o candidate, não aceita nada e nem o recover promove', async () => {
    await prepareRun(['src/rejected.ts']);
    const outcome = await finalize({ acceptance: reviewingPolicy('REJECT') });

    expect(outcome.kind).toBe('PENDING');
    const candidate = await headSha(root);
    const record = await readOrchestratedFinalization(paths, 'T1', 1);
    expect(record?.candidate_commit).toBe(candidate);
    expect(record?.review_requirement?.required).toBe(true);
    expect((await readCandidateReview(paths, 'T1', 1))?.decision).toBe('REJECT');

    const state = await readState(paths);
    expect(getTaskState(state, 'T1').status).toBe('RUNNING');
    expect(getTaskState(state, 'T1').accepted_commit).toBeNull();
    expect(state.authorized_head_sha).toBe(baseSha);
    expect(await readCompletion(paths, 'T1')).toBeNull();

    // Repetir o fechamento SEM autoridade de review não promove.
    expect((await finalize()).kind).toBe('PENDING');
    expect(getTaskState(await readState(paths), 'T1').status).toBe('RUNNING');

    // E o `dev-recover`, que sela finalizações válidas, também não: a guarda
    // vive na selagem, então nenhum promotor a contorna.
    const recovered = await recover(paths, loaded, { applyRecovered: true });
    const reconciled = recovered.state.tasks.find((task) => task.id === 'T1');
    expect(reconciled?.status).toBe('RUNNING');
    expect(reconciled?.diagnostics).toContain('review independente');
    expect(await readCompletion(paths, 'T1')).toBeNull();
  });

  it('crash depois do ACCEPT durável: rerun promove o MESMO candidate, sem novo reviewer', async () => {
    await prepareRun(['src/crashed.ts']);
    await expect(
      finalize({
        acceptance: {
          requirementFor: () => REVIEW_REQUIREMENT,
          async review({ record }) {
            await publishVerdict(record, 'ACCEPT');
            throw new Error('crash entre o ACCEPT durável e a promoção');
          },
        },
      }),
    ).rejects.toThrow('crash entre o ACCEPT durável e a promoção');

    const candidate = await headSha(root);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('RUNNING');
    expect(await readCompletion(paths, 'T1')).toBeNull();

    let reviewed = 0;
    const outcome = await finalize({
      acceptance: {
        requirementFor: () => REVIEW_REQUIREMENT,
        async review() {
          reviewed += 1;
          return { outcome: 'BLOCKED', code: 'REVIEWER_REINVOCADO', reason: 'não deveria ocorrer' };
        },
      },
    });

    expect(reviewed).toBe(0);
    expect(outcome.kind).toBe('PASS');
    expect(await commitCount()).toBe(1);
    const state = await readState(paths);
    expect(getTaskState(state, 'T1').accepted_commit).toBe(candidate);
    expect(state.authorized_head_sha).toBe(candidate);
    expect((await verifyCloseBundle(paths, 'T1')).status).toBe('VALID');
  });

  it('veredito que não amarra ao candidate nunca promove', async () => {
    await prepareRun(['src/divergente.ts']);
    const outcome = await finalize({
      acceptance: {
        requirementFor: () => REVIEW_REQUIREMENT,
        async review({ record }) {
          // ACCEPT emitido sobre OUTRO candidate: evidência de outra coisa,
          // não permissão para promover esta.
          await publishVerdict({ ...record, candidate_commit: SHA }, 'ACCEPT');
          return { outcome: 'ACCEPT', reason: 'aceite não amarrado' };
        },
      },
    });

    expect(outcome.kind).toBe('PENDING');
    expect(getTaskState(await readState(paths), 'T1').status).toBe('RUNNING');
    expect(await readCompletion(paths, 'T1')).toBeNull();
  });
});

describe('OrchestratedFinalizationRecord IO', () => {
  it('usa path determinístico e round-trip com escrita atômica', async () => {
    expect(orchestratedFinalizationPath(paths, 'T1', 2)).toBe(
      path.join(paths.devDir, 'finalizations', 'T1', 'attempt-2.json'),
    );
    await writeOrchestratedFinalization(paths, record());
    expect(await readOrchestratedFinalization(paths, 'T1', 2)).toEqual(record());
  });
});

describe('finalizeOrchestratedTask', () => {
  it('dispatch usa a policy gravada no LaunchRecord', async () => {
    await prepareRun(['src/dispatched.ts']);
    const outcome = await closeTaskByLaunchPolicy({ paths, loaded, taskId: 'T1' });
    expect(outcome.kind).toBe('PASS');
    expect(outcome.completion?.commit_origin).toBe('orchestrator');
  });

  it('dev-close CLI repete o mesmo dispatch orchestrator-owned', async () => {
    await prepareRun(['src/cli-dispatched.ts']);
    const result = await runDevCli('dev-close.ts', ['--repo', root, '--task', 'T1'], {
      AGENTLAB_DEV_DIR: paths.devDir,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).result).toBe('PASS');
    expect((await readCompletion(paths, 'T1'))?.commit_origin).toBe('orchestrator');
  });

  it('SUCCESS cria exatamente um commit e sela evidência oficial', async () => {
    await prepareRun();
    const outcome = await finalize();

    expect(outcome.kind).toBe('PASS');
    expect(await commitCount()).toBe(1);
    const candidate = await headSha(root);
    expect(await parentShas(root, candidate)).toEqual([baseSha]);
    expect((await runGit(root, ['show', '-s', '--format=%s', candidate])).stdout.trim()).toBe(
      'feat(T1): tarefa orquestrada',
    );
    expect((await runGit(root, ['show', '-s', '--format=%an <%ae>', candidate])).stdout.trim()).toBe(
      'Agent Strategy Lab Harness <harness@agent-strategy-lab.invalid>',
    );
    expect(outcome.completion?.report?.candidate_commit).toBeNull();
    expect(outcome.completion?.commit_origin).toBe('orchestrator');
    expect(outcome.completion?.report_matches_evidence).toBe(true);
    expect((await readHandoff(paths, 'T1'))?.validations.map((item) => item.argv)).toEqual([
      ['true'],
      ['git', 'diff', '--cached', '--check'],
    ]);
    expect((await verifyCloseBundle(paths, 'T1')).status).toBe('VALID');
    expect(getTaskState(await readState(paths), 'T1').status).toBe('PASS');
    expect((await readState(paths)).authorized_head_sha).toBe(candidate);
    expect(await workingTreeFiles(root)).toEqual([]);
    expect(await stagedFiles(root)).toEqual([]);
  });

  it('default runner preserva validation logs com hashes em nova finalização', async () => {
    await prepareRun(['src/logged.ts']);

    const outcome = await finalizeOrchestratedTask({
      paths,
      loaded,
      taskId: 'T1',
      now: () => NOW,
    });
    const record = await readOrchestratedFinalization(paths, 'T1', 1);

    expect(outcome.kind).toBe('PASS');
    expect(record?.validation_evidence).toHaveLength(2);
    expect(outcome.completion?.orchestrator_evidence.validation_evidence).toEqual(
      record?.validation_evidence,
    );
    for (const evidence of record?.validation_evidence ?? []) {
      const stdout = await readFile(path.join(paths.devDir, evidence.stdout_path));
      const stderr = await readFile(path.join(paths.devDir, evidence.stderr_path));
      expect(createHash('sha256').update(stdout).digest('hex')).toBe(evidence.stdout_sha256);
      expect(createHash('sha256').update(stderr).digest('hex')).toBe(evidence.stderr_sha256);
      expect(stdout.byteLength).toBe(evidence.stdout_bytes);
      expect(stderr.byteLength).toBe(evidence.stderr_bytes);
    }
  });

  it('commita exatamente deleção, rename e arquivo novo com espaço', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src/deleted.ts'), 'export const value = 1;\n');
    await writeFile(path.join(root, 'src/old name.ts'), 'export const value = 1;\n');
    baseSha = await commitAll(root, 'tracked fixtures');
    expect((await runGit(root, ['ls-files', '--', 'src/deleted.ts'])).stdout.trim()).toBe(
      'src/deleted.ts',
    );
    await prepareRun(['src/deleted.ts', 'src/old name.ts', 'src/new name.ts', 'src/new file.ts']);
    await rm(path.join(root, 'src/deleted.ts'));
    await rm(path.join(root, 'src/old name.ts'));
    const rawStatus = await runGit(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
    ]);
    expect(rawStatus.stdout).toContain('src/deleted.ts');
    expect(await workingTreeFiles(root)).toContain('src/deleted.ts');

    expect((await finalize()).kind).toBe('PASS');
    const names = (await runGit(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']))
      .stdout.trim()
      .split('\n')
      .sort();
    expect(names).toEqual([
      'src/deleted.ts',
      'src/new file.ts',
      'src/new name.ts',
      'src/old name.ts',
    ]);
  });

  it('recusa arquivo real extra, report ausente, staging prévio e path proibido', async () => {
    await prepareRun();
    await writeFile(path.join(root, 'src', 'extra.ts'), 'extra\n');
    expect((await finalize()).kind).toBe('PENDING');
    expect(await commitCount()).toBe(0);

    await rm(path.join(root, 'src', 'extra.ts'));
    await runGit(root, ['add', '--', 'src/new file.ts']);
    expect((await finalize()).reason).toMatch(/index.*staged/i);
  });

  it('recusa arquivo reportado ausente, candidate do worker e LaunchRecord worker-owned', async () => {
    await prepareRun(['src/missing.ts']);
    await rm(path.join(root, 'src/missing.ts'));
    expect((await finalize()).reason).toMatch(/arquivos reais divergem/i);

    await prepareRun(['src/candidate.ts'], { reportCandidate: baseSha });
    expect((await finalize()).reason).toMatch(/candidate_commit deve ser null/i);

    await prepareRun(['src/worker-owned.ts']);
    const launchFile = path.join(paths.logsDir, 'T1.launch.json');
    const launch = JSON.parse(await readFile(launchFile, 'utf8')) as Record<string, unknown>;
    launch['execution_policy'] = {
      commit_owner: 'worker',
      official_validation_owner: 'worker',
      worker_validation_policy: 'full',
    };
    await writeFile(launchFile, JSON.stringify(launch));
    expect((await finalize()).reason).toMatch(/não pertence ao modo orchestrator/i);
  });

  it.each([
    '.dev/manual.json',
    '.dev-inbox/T1/manual.json',
    'dev/plan.yaml',
    '.claude/settings.json',
    '.agents/rules.md',
    '.codex/config.toml',
  ])('recusa path proibido: %s', async (file) => {
    await prepareRun([file]);
    expect((await finalize()).reason).toMatch(/caminho proibido/i);
    expect(await commitCount()).toBe(0);
  });

  it('recusa task fora de RUNNING/FINALIZING e outra task RUNNING', async () => {
    await prepareRun();
    let state = await readState(paths);
    state = withTaskState(state, 'T1', { status: 'READY', phase: null });
    await writeState(paths, state);
    expect((await finalize()).reason).toMatch(/não RUNNING\/FINALIZING/i);

    await prepareRun();
    state = await readState(paths);
    state = withTaskState(state, 'T2', {
      status: 'RUNNING',
      phase: 'EXECUTING',
      attempts: 1,
      base_sha: baseSha,
      started_at: NOW,
    });
    await writeState(paths, state);
    expect((await finalize()).reason).toMatch(/outra tarefa está RUNNING/i);
  });

  it('recusa launch inacabado ou vivo e artifacts ausentes/inválidos', async () => {
    await prepareRun();
    const launchFile = path.join(paths.logsDir, 'T1.launch.json');
    let launch = JSON.parse(await readFile(launchFile, 'utf8')) as Record<string, unknown>;
    launch['finished_at'] = null;
    launch['duration_ms'] = null;
    await writeFile(launchFile, JSON.stringify(launch));
    expect((await finalize()).reason).toMatch(/não está finalizado/i);

    await prepareRun();
    launch = JSON.parse(await readFile(launchFile, 'utf8')) as Record<string, unknown>;
    launch['process'] = {
      pid: process.pid,
      pgid: process.pid,
      started_at: NOW,
      proc_start_ticks: await readProcStartTicks(process.pid),
      command_sha256: 'e'.repeat(64),
    };
    await writeFile(launchFile, JSON.stringify(launch));
    expect((await finalize()).reason).toMatch(/ainda está vivo/i);

    await prepareRun();
    await rm(reportPath(paths, 'T1'));
    expect((await finalize()).reason).toMatch(/AgentCompletionReport ausente/i);

    await prepareRun();
    await writeFile(handoffDraftPath(paths, 'T1'), '{}');
    expect((await finalize()).reason).toMatch(/handoff-draft.*inválido/i);
  });

  it('FAILURE do worker não commita nem sela handoff e preserva o patch', async () => {
    await prepareRun(['src/failure.ts'], { result: 'FAILURE' });
    const outcome = await finalize();
    expect(outcome.kind).toBe('FAIL');
    expect(await commitCount()).toBe(0);
    expect(await readHandoff(paths, 'T1')).toBeNull();
    expect(await workingTreeFiles(root)).toEqual(['src/failure.ts']);
    expect(getTaskState(await readState(paths), 'T1').status).toBe('FAIL');
    expect((await readState(paths)).authorized_head_sha).toBe(baseSha);
  });

  it('validation FAIL não commita, não avança authorized head e preserva patch', async () => {
    await prepareRun(['src/validation.ts']);
    const failingRunner: OrchestratedValidationRunner = async (command) => ({
      argv: [...command.argv],
      exit_code: 1,
      timed_out: false,
      duration_ms: 1,
    });
    const outcome = await finalize({ validationRunner: failingRunner });
    expect(outcome.kind).toBe('FAIL');
    expect(await commitCount()).toBe(0);
    expect(await workingTreeFiles(root)).toEqual(['src/validation.ts']);
    expect((await readState(paths)).authorized_head_sha).toBe(baseSha);
  });

  it('recusa validação que muda bytes sem mudar changed_files', async () => {
    await prepareRun(['src/mutated.ts']);
    const mutatingRunner: OrchestratedValidationRunner = async (command, cwd) => {
      await writeFile(path.join(cwd, 'src/mutated.ts'), 'mutado durante validação\n');
      return { argv: [...command.argv], exit_code: 0, timed_out: false, duration_ms: 1 };
    };
    const outcome = await finalize({ validationRunner: mutatingRunner });
    expect(outcome.kind).toBe('FAIL');
    expect(outcome.reason).toMatch(/fingerprint/i);
    expect(await commitCount()).toBe(0);
  });

  it('cached diff-check cobre arquivo novo e restaura somente o index', async () => {
    await prepareRun(['src/whitespace.ts']);
    await writeFile(path.join(root, 'src/whitespace.ts'), 'trailing   \n');
    const outcome = await finalize();
    expect(outcome.kind).toBe('FAIL');
    expect(outcome.reason).toMatch(/cached.*check|whitespace/i);
    expect(await stagedFiles(root)).toEqual([]);
    expect(await readFile(path.join(root, 'src/whitespace.ts'), 'utf8')).toBe('trailing   \n');
    expect(await commitCount()).toBe(0);
  });

  it('crash depois do commit é retomado sem segundo commit', async () => {
    await prepareRun(['src/crash.ts']);
    await expect(
      finalize({ afterCommitCreated: async () => Promise.reject(new Error('crash after commit')) }),
    ).rejects.toThrow(/crash after commit/);
    expect(await commitCount()).toBe(1);

    const outcome = await finalize();
    expect(outcome.kind).toBe('PASS');
    expect(await commitCount()).toBe(1);
  });

  it('candidate divergente depois do crash é recusado', async () => {
    await prepareRun(['src/divergent.ts']);
    await expect(
      finalize({ afterCommitCreated: async () => Promise.reject(new Error('crash')) }),
    ).rejects.toThrow(/crash/);
    await runGit(root, ['commit', '--amend', '-q', '-m', 'mensagem divergente']);

    const outcome = await finalize();
    expect(outcome.kind).toBe('PENDING');
    expect(outcome.reason).toMatch(/mensagem.*diverge/i);
    expect(await commitCount()).toBe(1);
  });

  it('crash depois do finalization record é reconciliável e repetição é idempotente', async () => {
    await prepareRun(['src/record-crash.ts']);
    await expect(
      finalize({
        afterFinalizationWritten: async () => Promise.reject(new Error('crash after record')),
      }),
    ).rejects.toThrow(/crash after record/);
    expect(await readOrchestratedFinalization(paths, 'T1', 1)).not.toBeNull();

    expect((await finalize()).kind).toBe('PASS');
    expect((await finalize()).kind).toBe('PASS');
    expect(await commitCount()).toBe(1);
    expect((await readCompletion(paths, 'T1'))?.commit_origin).toBe('orchestrator');
  });

  it('crash depois de CompletionRecord retoma handoff/manifest antes de promover state', async () => {
    await prepareRun(['src/completion-crash.ts']);
    await expect(
      finalize({
        afterCompletionWritten: async () => Promise.reject(new Error('crash after completion')),
      }),
    ).rejects.toThrow(/crash after completion/);
    expect(await readCompletion(paths, 'T1')).not.toBeNull();
    expect(await readHandoff(paths, 'T1')).toBeNull();
    expect((await readState(paths)).authorized_head_sha).toBe(baseSha);

    expect((await finalize()).kind).toBe('PASS');
    expect((await verifyCloseBundle(paths, 'T1')).status).toBe('VALID');
  });

  it('record divergente é recusado e authorized head só avança após bundle completo', async () => {
    await prepareRun(['src/record-divergent.ts']);
    await expect(
      finalize({
        afterFinalizationWritten: async () => Promise.reject(new Error('crash after record')),
      }),
    ).rejects.toThrow(/crash after record/);
    expect((await readState(paths)).authorized_head_sha).toBe(baseSha);

    const file = orchestratedFinalizationPath(paths, 'T1', 1);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    persisted['commit_message'] = 'feat(T1): mensagem divergente';
    await writeFile(file, JSON.stringify(persisted));
    await expect(finalize()).rejects.toThrow(/mensagem.*diverge|fontes.*diverge/i);
    expect((await readState(paths)).authorized_head_sha).toBe(baseSha);
  });

  it('dev-recover relata no dry-run e sela record válido somente quando aplicado', async () => {
    await prepareRun(['src/recover-record.ts']);
    await expect(
      finalize({
        afterFinalizationWritten: async () => Promise.reject(new Error('crash after record')),
      }),
    ).rejects.toThrow(/crash after record/);

    const dry = await recover(paths, loaded, { applyRecovered: false });
    expect(getTaskState(dry.state, 'T1').status).toBe('RUNNING');
    expect(dry.reconciliations[0]?.reason).toMatch(/aguarda dev-recover/i);
    expect(await readCompletion(paths, 'T1')).toBeNull();

    const applied = await recover(paths, loaded, { applyRecovered: true });
    expect(getTaskState(applied.state, 'T1').status).toBe('PASS');
    expect(await commitCount()).toBe(1);
    expect((await verifyCloseBundle(paths, 'T1')).status).toBe('VALID');
  });

  it('dev-recover nunca promove PASS só porque HEAD avançou sem record', async () => {
    await prepareRun(['src/head-only.ts']);
    await expect(
      finalize({ afterCommitCreated: async () => Promise.reject(new Error('head only')) }),
    ).rejects.toThrow(/head only/);
    expect(await readOrchestratedFinalization(paths, 'T1', 1)).toBeNull();

    const result = await recover(paths, loaded, { applyRecovered: true });
    expect(getTaskState(result.state, 'T1').status).toBe('RUNNING');
    expect(result.reconciliations[0]?.reason).toMatch(/fechamento pendente/i);
  });
});
