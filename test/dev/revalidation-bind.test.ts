import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headSha, patchFingerprint } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  completionPath,
  handoffDraftPath,
  originalCompletionEvidencePath,
  readRevalidationSourceBinding,
  reportPath,
  writeCompletion,
  writePacket,
} from '../../dev/lib/records.js';
import { bindRevalidationSource } from '../../dev/lib/revalidation-bind.js';
import type {
  AgentCompletionReport,
  CompletionRecord,
  HandoffDraft,
  ValidationCommand,
  ValidationResult,
} from '../../dev/lib/schemas.js';
import { buildInitialState, readState, withTaskState, writeState } from '../../dev/lib/state.js';
import { makeSandboxRepo, runDevCli, runGit, type Sandbox } from './helpers.js';

const roots: string[] = [];
const NOW = '2026-08-08T12:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const COMMANDS: readonly ValidationCommand[] = [
  { argv: ['pnpm', 'typecheck'], timeout_seconds: 30 },
  { argv: ['pnpm', 'test'], timeout_seconds: 30 },
];

const PLAN = `
schema_version: 1
tasks:
  - id: M18
    title: workspace clone
    objective: adicionar clone de workspace
    acceptance: ['clone funciona']
    validation:
${COMMANDS.map(
  (command) =>
    `      - argv: [${command.argv.map((part) => JSON.stringify(part)).join(', ')}]\n` +
    `        timeout_seconds: ${command.timeout_seconds}`,
).join('\n')}
  - id: M19
    title: próxima
    blocked_by: [M18]
    objective: não executar
    acceptance: ['permanece READY']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;

interface SetupOptions {
  readonly taskStatus?: 'FAIL' | 'PASS';
  readonly workerResult?: 'SUCCESS' | 'FAILURE';
  readonly originalFailure?: boolean;
  readonly changedFiles?: readonly string[];
  readonly extraFiles?: readonly string[];
}

interface Fixture {
  readonly sandbox: Sandbox;
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly baseSha: string;
  readonly completionBytes: Buffer;
}

async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const sandbox = await makeSandboxRepo(PLAN);
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  const loaded = await loadPlan(paths.planFile);
  const baseSha = await headSha(sandbox.root);

  const files = [...(options.changedFiles ?? ['src/workspace/clone.ts'])].sort();
  for (const file of [...files, ...(options.extraFiles ?? [])]) {
    await mkdir(path.dirname(path.join(sandbox.root, file)), { recursive: true });
    await writeFile(path.join(sandbox.root, file), `patch:${file}\n`);
  }

  const workerResult = options.workerResult ?? 'SUCCESS';
  const report: AgentCompletionReport = {
    schema_version: 1,
    task_id: 'M18',
    self_reported_result: workerResult,
    summary: 'worker terminou o patch',
    candidate_commit: null,
    changed_files: files,
    validations: [],
    decisions: ['decisão do worker'],
    lessons: [],
    relevant_files: files,
  };
  const handoff: HandoffDraft = {
    schema_version: 1,
    task_id: 'M18',
    result: workerResult === 'SUCCESS' ? 'PASS' : 'FAIL',
    changed_files: files,
    validations: [],
    decisions: ['decisão do worker'],
    lessons: [],
    next_relevant_files: files,
  };
  await mkdir(path.dirname(reportPath(paths, 'M18')), { recursive: true });
  await writeFile(reportPath(paths, 'M18'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(handoffDraftPath(paths, 'M18'), `${JSON.stringify(handoff, null, 2)}\n`);
  await writePacket(paths, {
    schema_version: 1,
    task_id: 'M18',
    title: 'workspace clone',
    objective: 'adicionar clone de workspace',
    base_sha: baseSha,
    initial_files: [],
    acceptance: ['clone funciona'],
    validation: [...COMMANDS],
    constraints: [],
    previous_handoff: null,
    generated_at: NOW,
  });

  const official: ValidationResult[] = COMMANDS.map((command, index) => ({
    argv: [...command.argv],
    exit_code: options.originalFailure === false ? 0 : index === COMMANDS.length - 1 ? 1 : 0,
    timed_out: false,
    duration_ms: index + 1,
  }));
  const completion: CompletionRecord = {
    schema_version: 1,
    task_id: 'M18',
    status: 'FAIL',
    report,
    orchestrator_evidence: {
      task_id: 'M18',
      base_sha: baseSha,
      candidate_commit: null,
      accepted_commit: null,
      changed_files: files,
      working_tree_clean: false,
      process: null,
      duration_ms: 10,
      exit_code: 0,
      timed_out: false,
      revalidation: official,
      observed_at: NOW,
    },
    report_matches_evidence: true,
    discrepancies: [],
    finalization_mode: 'normal',
    closed_at: NOW,
  };
  await writeCompletion(paths, completion);
  const completionBytes = await readFile(completionPath(paths, 'M18'));

  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha });
  state = withTaskState(state, 'M18', {
    status: options.taskStatus ?? 'FAIL',
    phase: null,
    attempts: 1,
    process: null,
    base_sha: baseSha,
    candidate_commit: options.taskStatus === 'PASS' ? baseSha : null,
    accepted_commit: options.taskStatus === 'PASS' ? baseSha : null,
    diagnostics: options.taskStatus === 'PASS' ? null : 'validação oficial falhou',
    started_at: NOW,
    finished_at: NOW,
  });
  await writeState(paths, { ...state, authorized_head_sha: baseSha });

  return { sandbox, paths, loaded, baseSha, completionBytes };
}

function bind(fixture: Fixture) {
  return bindRevalidationSource({ paths: fixture.paths, taskId: 'M18' });
}

describe('dev-revalidation-bind preconditions', () => {
  it('exige tarefa FAIL', async () => {
    const fixture = await setup({ taskStatus: 'PASS' });
    await expect(bind(fixture)).rejects.toThrow(/exige tarefa FAIL/i);
  });

  it('exige worker report SUCCESS', async () => {
    const fixture = await setup({ workerResult: 'FAILURE' });
    await expect(bind(fixture)).rejects.toThrow(/worker report SUCCESS/i);
  });

  it('exige validation oficial malsucedida', async () => {
    const fixture = await setup({ originalFailure: false });
    await expect(bind(fixture)).rejects.toThrow(/validation oficial malsucedida/i);
  });

  it('recusa working tree divergente do report.changed_files', async () => {
    const fixture = await setup({ extraFiles: ['src/workspace/extra.ts'] });
    await expect(bind(fixture)).rejects.toThrow(/working tree diverge do report/i);
  });

  it('recusa index sujo', async () => {
    const fixture = await setup();
    await runGit(fixture.sandbox.root, ['add', '--', 'src/workspace/clone.ts']);
    await expect(bind(fixture)).rejects.toThrow(/index.*staged/i);
  });

  it('recusa forbidden path', async () => {
    const fixture = await setup({ changedFiles: ['.claude/forbidden.txt'] });
    await expect(bind(fixture)).rejects.toThrow(/caminho proibido/i);
  });
});

describe('dev-revalidation-bind transaction', () => {
  it('sela archive e binding sem tocar em state, HEAD ou working tree', async () => {
    const fixture = await setup();
    const stateBefore = await readState(fixture.paths);
    const fingerprint = await patchFingerprint(fixture.sandbox.root);

    const result = await bind(fixture);

    expect(result.alreadyBound).toBe(false);
    expect(result.binding).toMatchObject({
      task_id: 'M18',
      attempt: 1,
      source_base_sha: fixture.baseSha,
      original_completion_path: 'original-completion.fail.json',
      original_completion_sha256: digest(fixture.completionBytes),
      changed_files: ['src/workspace/clone.ts'],
      derived_patch_fingerprint: fingerprint,
      fingerprint_provenance: 'derived_during_revalidation_preflight',
    });
    // Bytes exatos do FAIL, não uma reserialização.
    expect(await readFile(originalCompletionEvidencePath(fixture.paths, 'M18', 1))).toEqual(
      fixture.completionBytes,
    );
    expect(await headSha(fixture.sandbox.root)).toBe(fixture.baseSha);
    expect(await readState(fixture.paths)).toEqual(stateBefore);
    expect(await patchFingerprint(fixture.sandbox.root)).toBe(fingerprint);
  });

  it('é idempotente quando os fatos observados não mudaram', async () => {
    const fixture = await setup();
    const first = await bind(fixture);
    const second = await bind(fixture);

    expect(second.alreadyBound).toBe(true);
    expect(second.binding).toEqual(first.binding);
    expect(await readRevalidationSourceBinding(fixture.paths, 'M18', 1)).toEqual(first.binding);
  });

  it('é fail-closed quando o patch mudou depois do selo', async () => {
    const fixture = await setup();
    await bind(fixture);
    await writeFile(
      path.join(fixture.sandbox.root, 'src/workspace/clone.ts'),
      'patch alterado depois do selo\n',
    );

    await expect(bind(fixture)).rejects.toThrow(/binding já selado diverge/i);
  });

  it('é fail-closed quando o CompletionRecord FAIL mudou depois do selo', async () => {
    const fixture = await setup();
    const first = await bind(fixture);
    const completion = JSON.parse(fixture.completionBytes.toString('utf8')) as CompletionRecord;
    await writeCompletion(fixture.paths, {
      ...completion,
      orchestrator_evidence: { ...completion.orchestrator_evidence, duration_ms: 999 },
    });

    await expect(bind(fixture)).rejects.toThrow(/archive do CompletionRecord FAIL diverge/i);
    // O archive write-once continua com os bytes originais.
    expect(await readFile(originalCompletionEvidencePath(fixture.paths, 'M18', 1))).toEqual(
      fixture.completionBytes,
    );
    expect(await readRevalidationSourceBinding(fixture.paths, 'M18', 1)).toEqual(first.binding);
  });
});

describe('dev-revalidation-bind CLI', () => {
  it('sela pela CLI e repete como ALREADY_BOUND', async () => {
    const fixture = await setup();
    const argv = ['--repo', fixture.sandbox.root, '--task', 'M18'];
    const env = { AGENTLAB_DEV_DIR: fixture.sandbox.devDir };

    const first = await runDevCli('dev-revalidation-bind.ts', argv, env);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: 'BOUND',
      task_id: 'M18',
      attempt: 1,
      fingerprint_provenance: 'derived_during_revalidation_preflight',
    });

    const second = await runDevCli('dev-revalidation-bind.ts', argv, env);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).status).toBe('ALREADY_BOUND');
    expect(await headSha(fixture.sandbox.root)).toBe(fixture.baseSha);
  });
});
