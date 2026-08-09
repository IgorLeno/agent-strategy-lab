import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { headSha, patchFingerprint } from '../../dev/lib/git.js';
import { resolveHarnessPaths, type HarnessPaths } from '../../dev/lib/paths.js';
import { loadPlan, type LoadedPlan } from '../../dev/lib/plan.js';
import {
  completionPath,
  failedAttemptCompletionPath,
  handoffDraftPath,
  originalCompletionEvidencePath,
  preservedBundleManifestPath,
  preservedBundlePatchPath,
  readPreservedBundleManifest,
  readRevalidationSourceBinding,
  readValidationFailedAttempt,
  reportPath,
  sourceBindingPath,
  validationFailedAttemptPath,
  writeCompletion,
  writeLaunchRecord,
  writePacket,
  writeRevalidationSourceBinding,
} from '../../dev/lib/records.js';
import {
  previousAttemptDiagnosticsFrom,
  readPreviousAttemptDiagnostics,
  retryFailedAttempt,
} from '../../dev/lib/retry-failed.js';
import type {
  AgentCompletionReport,
  CompletionRecord,
  HandoffDraft,
  ValidationCommand,
  ValidationEvidence,
  ValidationResult,
} from '../../dev/lib/schemas.js';
import { prepareNextTask } from '../../dev/lib/steps.js';
import {
  buildInitialState,
  ensureRuntimeDirs,
  readState,
  withTaskState,
  writeState,
} from '../../dev/lib/state.js';
import { makeSandboxRepo, runGit, type Sandbox } from './helpers.js';

const roots: string[] = [];
const NOW = '2026-08-08T12:00:00.000Z';
const TASK = 'M23';
const PROFILE = 'claude-build-worker-subscription-sonnet5-medium-v3';
const REASON = 'a solução passou na validação focada e falhou reprodutivelmente na suíte completa';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const COMMANDS: readonly ValidationCommand[] = [
  { argv: ['pnpm', 'typecheck'], timeout_seconds: 30 },
  { argv: ['pnpm', 'test'], timeout_seconds: 30 },
];

const PLAN = `
schema_version: 1
tasks:
  - id: ${TASK}
    title: timeout do runner
    objective: adicionar timeout ao runner
    acceptance: ['timeout funciona']
    validation:
${COMMANDS.map(
  (command) =>
    `      - argv: [${command.argv.map((part) => JSON.stringify(part)).join(', ')}]\n` +
    `        timeout_seconds: ${command.timeout_seconds}`,
).join('\n')}
  - id: M24
    title: próxima
    blocked_by: [${TASK}]
    objective: não executar
    acceptance: ['permanece READY']
    validation:
      - argv: ['true']
        timeout_seconds: 30
`;

/** Arquivos que o worker mudou: um modificado, um removido e um novo. */
const MODIFIED = 'src/runner/spawn.ts';
const REMOVED = 'src/runner/legacy.ts';
const ADDED = 'test/runner/timeout.test.ts';
const UNTOUCHED = 'src/runner/capture.ts';
const IGNORED = 'ignored.log';
const PATCH_FILES = [ADDED, REMOVED, MODIFIED].sort();

const BASE_CONTENT: Readonly<Record<string, string>> = {
  [MODIFIED]: 'export const spawnProcess = () => 0;\n',
  [REMOVED]: 'export const legacy = true;\n',
  [UNTOUCHED]: 'export const capture = () => 1;\n',
};

interface SetupOptions {
  readonly taskStatus?: 'FAIL' | 'PASS' | 'RUNNING';
  readonly workerResult?: 'SUCCESS' | 'FAILURE';
  readonly officialFailure?: boolean;
  readonly candidateInState?: boolean;
  readonly writeBinding?: boolean;
  readonly bindingFingerprint?: string;
  readonly reportChangedFiles?: readonly string[];
  readonly otherTaskRunning?: boolean;
  readonly attempts?: number;
}

interface Fixture {
  readonly sandbox: Sandbox;
  readonly paths: HarnessPaths;
  readonly loaded: LoadedPlan;
  readonly baseSha: string;
  readonly report: AgentCompletionReport;
}

function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content, 'utf8');
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function setup(options: SetupOptions = {}): Promise<Fixture> {
  const sandbox = await makeSandboxRepo(PLAN);
  roots.push(sandbox.root);
  const paths = resolveHarnessPaths(sandbox.root);
  await ensureRuntimeDirs(paths);
  const loaded = await loadPlan(paths.planFile);

  // Base autorizada: os arquivos rastreados existem, e um artifact ignorado
  // fica no disco para provar que o reset não é `git clean -x`.
  for (const [file, content] of Object.entries(BASE_CONTENT)) {
    await write(sandbox.root, file, content);
  }
  await writeFile(path.join(sandbox.root, '.gitignore'), `.dev/\n.dev-inbox/\n${IGNORED}\n`, 'utf8');
  await runGit(sandbox.root, ['add', '-A']);
  await runGit(sandbox.root, ['commit', '-q', '-m', 'base do attempt']);
  const baseSha = await headSha(sandbox.root);
  await write(sandbox.root, IGNORED, 'artifact local que não pertence ao harness\n');

  // Patch do worker sobre a base.
  await write(sandbox.root, MODIFIED, 'export const spawnProcess = (timeoutMs: number) => timeoutMs;\n');
  await rm(path.join(sandbox.root, REMOVED));
  await write(sandbox.root, ADDED, "import { it } from 'vitest';\nit('mata no timeout', () => {});\n");

  const files = [...(options.reportChangedFiles ?? PATCH_FILES)].sort();
  const workerResult = options.workerResult ?? 'SUCCESS';
  const report: AgentCompletionReport = {
    schema_version: 1,
    task_id: TASK,
    self_reported_result: workerResult,
    summary: 'RACIOCINIO-DO-WORKER-ANTERIOR que não pode vazar para o próximo attempt',
    candidate_commit: null,
    changed_files: files,
    validations: [],
    decisions: ['DECISAO-DO-WORKER-ANTERIOR'],
    lessons: ['LICAO-DO-WORKER-ANTERIOR'],
    relevant_files: files,
  };
  const handoff: HandoffDraft = {
    schema_version: 1,
    task_id: TASK,
    result: workerResult === 'SUCCESS' ? 'PASS' : 'FAIL',
    changed_files: files,
    validations: [],
    decisions: ['DECISAO-DO-WORKER-ANTERIOR'],
    lessons: ['LICAO-DO-WORKER-ANTERIOR'],
    next_relevant_files: files,
  };
  await mkdir(path.dirname(reportPath(paths, TASK)), { recursive: true });
  await writeFile(reportPath(paths, TASK), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(handoffDraftPath(paths, TASK), `${JSON.stringify(handoff, null, 2)}\n`);

  await writePacket(paths, {
    schema_version: 1,
    task_id: TASK,
    title: 'timeout do runner',
    objective: 'adicionar timeout ao runner',
    base_sha: baseSha,
    initial_files: [],
    acceptance: ['timeout funciona'],
    validation: [...COMMANDS],
    constraints: [],
    previous_handoff: null,
    generated_at: NOW,
  });

  const attempts = options.attempts ?? 2;
  await writeLaunchRecord(paths, {
    schema_version: 1,
    task_id: TASK,
    profile_id: PROFILE,
    execution_policy: {
      commit_owner: 'orchestrator',
      official_validation_owner: 'orchestrator',
      worker_validation_policy: 'targeted',
    },
    argv: ['claude', '-p'],
    process: {
      pid: 4242,
      pgid: 4242,
      started_at: NOW,
      proc_start_ticks: 1,
      command_sha256: digest('claude'),
    },
    launch_id: '08e0a5a1-c55b-4697-a7a3-0d94f21dfbac',
    started_at: NOW,
    finished_at: NOW,
    duration_ms: 10,
    exit_code: 0,
    timed_out: false,
    controlled: {},
  });

  const official: ValidationResult[] = COMMANDS.map((command, index) => ({
    argv: [...command.argv],
    exit_code: options.officialFailure === false ? 0 : index === COMMANDS.length - 1 ? 1 : 0,
    timed_out: false,
    duration_ms: index + 1,
  }));
  const evidence: ValidationEvidence[] = official.map((result, index) => ({
    ...result,
    sequence: index + 1,
    stdout_sha256: digest(`stdout-${index}`),
    stderr_sha256: digest(`stderr-${index}`),
    stdout_bytes: 1,
    stderr_bytes: 0,
    stdout_path: `validation-logs/${TASK}/attempt-${attempts}/000${index + 1}.stdout.log`,
    stderr_path: `validation-logs/${TASK}/attempt-${attempts}/000${index + 1}.stderr.log`,
  }));

  const completion: CompletionRecord = {
    schema_version: 1,
    task_id: TASK,
    status: 'FAIL',
    report,
    orchestrator_evidence: {
      task_id: TASK,
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
      validation_evidence: evidence,
      observed_at: NOW,
    },
    report_matches_evidence: true,
    discrepancies: [],
    finalization_mode: 'normal',
    closed_at: NOW,
  };
  await writeCompletion(paths, completion);

  if (options.writeBinding !== false) {
    await writeRevalidationSourceBinding(paths, {
      schema_version: 1,
      task_id: TASK,
      attempt: attempts,
      source_base_sha: baseSha,
      original_completion_path: 'original-completion.fail.json',
      original_completion_sha256: digest(await readFile(completionPath(paths, TASK))),
      report_sha256: digest(await readFile(reportPath(paths, TASK))),
      handoff_draft_sha256: digest(await readFile(handoffDraftPath(paths, TASK))),
      changed_files: files,
      derived_patch_fingerprint:
        options.bindingFingerprint ?? (await patchFingerprint(sandbox.root)),
      fingerprint_observed_at: NOW,
      fingerprint_provenance: 'derived_during_revalidation_preflight',
    });
  }

  const status = options.taskStatus ?? 'FAIL';
  let state = buildInitialState(loaded.plan, loaded.planSha256, { baselineSha: baseSha });
  state = withTaskState(state, TASK, {
    status,
    phase: status === 'RUNNING' ? 'EXECUTING' : null,
    attempts,
    process: null,
    base_sha: baseSha,
    candidate_commit: options.candidateInState ? baseSha : null,
    accepted_commit: status === 'PASS' ? baseSha : null,
    diagnostics: 'validação oficial falhou: pnpm test (exit 1)',
    started_at: NOW,
    finished_at: NOW,
  });
  if (options.otherTaskRunning) {
    state = withTaskState(state, 'M24', { status: 'RUNNING', phase: 'EXECUTING', attempts: 1 });
  }
  await writeState(paths, { ...state, authorized_head_sha: baseSha });

  return { sandbox, paths, loaded, baseSha, report };
}

function retry(fixture: Fixture, reason = REASON) {
  return retryFailedAttempt({
    paths: fixture.paths,
    taskId: TASK,
    reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
    reason,
    now: () => NOW,
  });
}

describe('dev-retry-failed preconditions', () => {
  it('recusa tarefa que não está FAIL', async () => {
    const fixture = await setup({ taskStatus: 'RUNNING' });
    await expect(retry(fixture)).rejects.toThrow(/exige tarefa FAIL/i);
  });

  it('recusa worker report FAILURE', async () => {
    const fixture = await setup({ workerResult: 'FAILURE' });
    await expect(retry(fixture)).rejects.toThrow(/worker report SUCCESS/i);
  });

  it('exige validation oficial malsucedida', async () => {
    const fixture = await setup({ officialFailure: false });
    await expect(retry(fixture)).rejects.toThrow(/validation oficial malsucedida/i);
  });

  it('exige candidate/accepted null no state', async () => {
    const fixture = await setup({ candidateInState: true });
    await expect(retry(fixture)).rejects.toThrow(/candidate\/accepted commit/i);
  });

  it('recusa fingerprint divergente do binding', async () => {
    const fixture = await setup({ bindingFingerprint: 'a'.repeat(64) });
    await expect(retry(fixture)).rejects.toThrow(/patch fingerprint diverge/i);
  });

  it('recusa changed_files divergentes da working tree', async () => {
    const fixture = await setup();
    await write(fixture.sandbox.root, 'src/runner/extra.ts', 'export const extra = 1;\n');
    await expect(retry(fixture)).rejects.toThrow(/working tree diverge do report/i);
  });

  it('recusa index sujo', async () => {
    const fixture = await setup();
    await runGit(fixture.sandbox.root, ['add', '--', MODIFIED]);
    await expect(retry(fixture)).rejects.toThrow(/index contém mudanças staged/i);
  });

  it('recusa outra tarefa RUNNING', async () => {
    const fixture = await setup({ otherTaskRunning: true });
    await expect(retry(fixture)).rejects.toThrow(/outra tarefa RUNNING/i);
  });

  it('recusa reason vazio', async () => {
    const fixture = await setup();
    await expect(retry(fixture, '   ')).rejects.toThrow(/--reason é obrigatório/i);
  });

  it('recusa HEAD divergente do authorized_head_sha', async () => {
    const fixture = await setup();
    const state = await readState(fixture.paths);
    await writeState(fixture.paths, { ...state, authorized_head_sha: 'b'.repeat(40) });
    await expect(retry(fixture)).rejects.toThrow(/diverge do authorized_head_sha/i);
  });
});

/**
 * FAIL LEGADO: produzido quando o finalization ainda não materializava a fonte.
 * Sobra `status = FAIL` + CompletionRecord oficial + patch rejeitado, e nenhuma
 * intervenção suportada consegue tocar na tarefa — foi o que prendeu o M39B.
 *
 * A recuperação é uma DERIVAÇÃO a partir dos bytes que sobraram, não uma
 * reconstrução do histórico: se qualquer peça da evidência não sustentar o
 * binding, nada é escrito.
 */
describe('dev-retry-failed recupera FAIL legado sem source binding', () => {
  it('deriva o binding dos bytes reais em disco e arquiva o attempt', async () => {
    const fixture = await setup({ writeBinding: false });
    expect(await readRevalidationSourceBinding(fixture.paths, TASK, 2)).toBeNull();

    const completionBytes = await readFile(completionPath(fixture.paths, TASK));
    const reportBytes = await readFile(reportPath(fixture.paths, TASK));
    const handoffBytes = await readFile(handoffDraftPath(fixture.paths, TASK));
    const fingerprint = await patchFingerprint(fixture.sandbox.root);

    const result = await retry(fixture);
    expect(result.bindingRecovered).toBe(true);

    // Cada hash do binding é o hash dos bytes que realmente estavam no disco.
    const binding = await readRevalidationSourceBinding(fixture.paths, TASK, 2);
    expect(binding).toMatchObject({
      task_id: TASK,
      attempt: 2,
      source_base_sha: fixture.baseSha,
      original_completion_sha256: digest(completionBytes),
      report_sha256: digest(reportBytes),
      handoff_draft_sha256: digest(handoffBytes),
      derived_patch_fingerprint: fingerprint,
      changed_files: PATCH_FILES,
    });
    expect(result.record.attempt).toBe(2);
    expect(result.record.patch_fingerprint).toBe(fingerprint);
    expect((await readState(fixture.paths)).tasks.find((task) => task.id === TASK)?.status).toBe(
      'READY',
    );
  });

  it('registra a proveniência como recuperação, não como contemporânea do FAIL', async () => {
    const fixture = await setup({ writeBinding: false });
    await retry(fixture);
    const binding = await readRevalidationSourceBinding(fixture.paths, TASK, 2);
    expect(binding?.fingerprint_provenance).toBe('derived_during_failed_attempt_recovery');
  });

  it('publica o archive do CompletionRecord FAIL que o binding referencia', async () => {
    const fixture = await setup({ writeBinding: false });
    const completionBytes = await readFile(completionPath(fixture.paths, TASK));
    await retry(fixture);

    // Sem esse archive a revalidação auditada não teria contra o que conferir
    // o hash: binding e bytes originais são um par indivisível.
    const archived = await readFile(originalCompletionEvidencePath(fixture.paths, TASK, 2));
    expect(archived).toEqual(completionBytes);
  });

  it('não redepende do binding derivado numa segunda execução', async () => {
    const fixture = await setup({ writeBinding: false });
    const first = await retry(fixture);
    const bindingBytes = await readFile(sourceBindingPath(fixture.paths, TASK, 2));

    const second = await retry(fixture);
    expect(first.bindingRecovered).toBe(true);
    expect(second.bindingRecovered).toBe(false);
    expect(second.alreadyArchived).toBe(true);
    expect(second.record).toEqual(first.record);
    expect(await readFile(sourceBindingPath(fixture.paths, TASK, 2))).toEqual(bindingBytes);
  });

  it('recusa quando o report em disco não é mais o preservado no FAIL', async () => {
    const fixture = await setup({ writeBinding: false });
    const report = JSON.parse(await readFile(reportPath(fixture.paths, TASK), 'utf8'));
    await writeFile(
      reportPath(fixture.paths, TASK),
      `${JSON.stringify({ ...report, summary: 'outra narrativa' }, null, 2)}\n`,
    );

    await expect(retry(fixture)).rejects.toThrow(/report atual diverge do report preservado/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('recusa quando o CompletionRecord foi editado depois do FAIL', async () => {
    const fixture = await setup({ writeBinding: false });
    const completion = JSON.parse(await readFile(completionPath(fixture.paths, TASK), 'utf8'));
    completion.report.summary = 'sumário reescrito à mão';
    await writeFile(completionPath(fixture.paths, TASK), `${JSON.stringify(completion, null, 2)}\n`);

    await expect(retry(fixture)).rejects.toThrow(/report atual diverge do report preservado/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('recusa quando o HandoffDraft em disco não é mais o do fechamento', async () => {
    const fixture = await setup({ writeBinding: false });
    const handoff = JSON.parse(await readFile(handoffDraftPath(fixture.paths, TASK), 'utf8'));
    await writeFile(
      handoffDraftPath(fixture.paths, TASK),
      `${JSON.stringify({ ...handoff, changed_files: ['src/outro.ts'] }, null, 2)}\n`,
    );

    await expect(retry(fixture)).rejects.toThrow(/HandoffDraft diverge do que o FAIL registrou/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('recusa changed_files divergentes entre report e orchestrator evidence', async () => {
    const fixture = await setup({ writeBinding: false });
    const completion = JSON.parse(await readFile(completionPath(fixture.paths, TASK), 'utf8'));
    completion.orchestrator_evidence.changed_files = [MODIFIED];
    await writeFile(completionPath(fixture.paths, TASK), `${JSON.stringify(completion, null, 2)}\n`);

    await expect(retry(fixture)).rejects.toThrow(/changed_files diverge/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('recusa patch em disco divergente dos changed_files reportados', async () => {
    const fixture = await setup({ writeBinding: false });
    await write(fixture.sandbox.root, 'src/runner/extra.ts', 'export const extra = 1;\n');

    await expect(retry(fixture)).rejects.toThrow(/working tree diverge do report/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('recusa index sujo sem escrever binding', async () => {
    const fixture = await setup({ writeBinding: false });
    await runGit(fixture.sandbox.root, ['add', '--', MODIFIED]);

    await expect(retry(fixture)).rejects.toThrow(/index contém mudanças staged/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('recusa HEAD divergente do authorized_head_sha sem escrever binding', async () => {
    const fixture = await setup({ writeBinding: false });
    const state = await readState(fixture.paths);
    await writeState(fixture.paths, { ...state, authorized_head_sha: 'b'.repeat(40) });

    await expect(retry(fixture)).rejects.toThrow(/diverge do authorized_head_sha/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('recusa candidate/accepted no state sem escrever binding', async () => {
    const fixture = await setup({ writeBinding: false, candidateInState: true });
    await expect(retry(fixture)).rejects.toThrow(/candidate\/accepted commit/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('não recupera FAIL de worker FAILURE — esse é o caminho do dev-retry', async () => {
    const fixture = await setup({ writeBinding: false, workerResult: 'FAILURE' });
    await expect(retry(fixture)).rejects.toThrow(/worker report SUCCESS/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });

  it('não recupera FAIL sem validation oficial malsucedida', async () => {
    const fixture = await setup({ writeBinding: false, officialFailure: false });
    await expect(retry(fixture)).rejects.toThrow(/validation oficial malsucedida/i);
    expect(await exists(sourceBindingPath(fixture.paths, TASK, 2))).toBe(false);
  });
});

describe('dev-retry-failed preserva a solução reprovada', () => {
  it('preserva arquivo modificado, novo e removido no change bundle', async () => {
    const fixture = await setup();
    const result = await retry(fixture);

    const manifest = await readPreservedBundleManifest(fixture.paths, TASK, 2);
    expect(manifest).not.toBeNull();
    expect(manifest?.base_sha).toBe(fixture.baseSha);
    expect(manifest?.changed_files).toEqual(PATCH_FILES);

    const byPath = new Map((manifest?.files ?? []).map((file) => [file.path, file]));
    expect(byPath.get(MODIFIED)).toMatchObject({ status: 'modified', old_path: null });
    expect(byPath.get(ADDED)).toMatchObject({ status: 'added', old_path: null });
    expect(byPath.get(REMOVED)).toMatchObject({
      status: 'deleted',
      mode: null,
      sha256: null,
      size_bytes: null,
    });

    // O patch preservado descreve as três mudanças e reaplica sobre a base.
    const patch = await readFile(preservedBundlePatchPath(fixture.paths, TASK, 2), 'utf8');
    expect(patch).toContain(`+++ b/${MODIFIED}`);
    expect(patch).toContain(`new file mode`);
    expect(patch).toContain(`deleted file mode`);
    expect(digest(Buffer.from(patch, 'utf8'))).toBe(result.record.change_bundle.patch_sha256);

    // O manifesto referenciado pelo record é o que está no disco, byte a byte.
    const manifestBytes = await readFile(preservedBundleManifestPath(fixture.paths, TASK, 2));
    expect(digest(manifestBytes)).toBe(result.record.change_bundle.manifest_sha256);
  });

  it('o patch preservado reaplica sobre a base e reconstrói a solução', async () => {
    const fixture = await setup();
    const fingerprintBefore = await patchFingerprint(fixture.sandbox.root);
    await retry(fixture);

    const patchFile = preservedBundlePatchPath(fixture.paths, TASK, 2);
    const applied = await runGit(fixture.sandbox.root, ['apply', '--index', patchFile]);
    expect(applied.exitCode).toBe(0);
    await runGit(fixture.sandbox.root, ['reset', '-q']);
    expect(await patchFingerprint(fixture.sandbox.root)).toBe(fingerprintBefore);
  });

  it('grava um record que diz worker SUCCESS e veredito do orquestrador', async () => {
    const fixture = await setup();
    const result = await retry(fixture);

    expect(result.record).toMatchObject({
      task_id: TASK,
      attempt: 2,
      source_base_sha: fixture.baseSha,
      profile_id: PROFILE,
      worker_self_reported_result: 'SUCCESS',
      report_candidate_commit: null,
      orchestrator_verdict: 'REJECTED_BY_OFFICIAL_VALIDATION',
      finalization_mode: 'normal',
      reason_code: 'OFFICIAL_VALIDATION_FAILURE',
      reason: REASON,
      changed_files: PATCH_FILES,
    });
    expect(result.record.original_validation_results.at(-1)?.exit_code).toBe(1);
    expect(result.record.original_validation_evidence?.length).toBe(COMMANDS.length);
  });

  it('record é append-only: reexecutar com outro reason é recusado', async () => {
    const fixture = await setup();
    await retry(fixture);
    // Reabrir o mesmo attempt como FAIL é a única forma de chegar de novo ao
    // record já publicado; ele não pode ser reescrito com outra narrativa.
    const state = await readState(fixture.paths);
    await writeState(fixture.paths, withTaskState(state, TASK, { status: 'FAIL', finished_at: NOW }));

    await expect(retry(fixture, 'outro motivo qualquer')).rejects.toThrow(/diverge do reason/i);
    const record = await readValidationFailedAttempt(fixture.paths, TASK, 2);
    expect(record?.reason).toBe(REASON);
  });

  it('retoma idempotentemente depois de crash entre record e reset', async () => {
    const fixture = await setup();
    class Crash extends Error {}
    await expect(
      retryFailedAttempt({
        paths: fixture.paths,
        taskId: TASK,
        reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
        reason: REASON,
        now: () => NOW,
        afterRecordWritten: async () => {
          throw new Crash('crash simulado');
        },
      }),
    ).rejects.toThrow(/crash simulado/);

    // Record publicado, patch ainda em disco, tarefa ainda FAIL.
    expect(await readValidationFailedAttempt(fixture.paths, TASK, 2)).not.toBeNull();
    const halfway = await readState(fixture.paths);
    expect(halfway.tasks.find((task) => task.id === TASK)?.status).toBe('FAIL');

    const result = await retry(fixture);
    expect(result.alreadyArchived).toBe(true);
    const state = await readState(fixture.paths);
    expect(state.tasks.find((task) => task.id === TASK)?.status).toBe('READY');
  });

  it('retoma quando o crash foi depois do reset, sem exigir o patch em disco', async () => {
    const fixture = await setup();
    await retry(fixture);
    const state = await readState(fixture.paths);
    await writeState(fixture.paths, withTaskState(state, TASK, { status: 'FAIL', finished_at: NOW }));

    const result = await retry(fixture);
    expect(result.alreadyArchived).toBe(true);
    expect(result.bundle).toBeNull();
    const after = await readState(fixture.paths);
    expect(after.tasks.find((task) => task.id === TASK)?.status).toBe('READY');
  });
});

describe('dev-retry-failed libera o slot do CompletionRecord corrente', () => {
  /** Repõe o patch reprovado no disco, como um novo attempt faria. */
  async function rewritePatch(root: string): Promise<void> {
    await write(root, MODIFIED, 'export const spawnProcess = (timeoutMs: number) => timeoutMs;\n');
    await rm(path.join(root, REMOVED), { force: true });
    await write(root, ADDED, "import { it } from 'vitest';\nit('mata no timeout', () => {});\n");
  }

  it('arquiva o CompletionRecord FAIL byte a byte e libera o slot corrente', async () => {
    const fixture = await setup();
    const original = await readFile(completionPath(fixture.paths, TASK));
    const result = await retry(fixture);

    const archiveFile = failedAttemptCompletionPath(fixture.paths, TASK, 2);
    expect(result.completionArchivePath).toBe(archiveFile);
    expect(await readFile(archiveFile)).toEqual(original);
    // O hash tem uma única fonte: o record do attempt arquivado.
    expect(digest(original)).toBe(result.record.original_completion_sha256);

    expect(result.releasedCurrentCompletion).toBe(true);
    expect(await exists(completionPath(fixture.paths, TASK))).toBe(false);
  });

  it('recusa archive divergente já publicado', async () => {
    const fixture = await setup();
    const archiveFile = failedAttemptCompletionPath(fixture.paths, TASK, 2);
    await mkdir(path.dirname(archiveFile), { recursive: true });
    await writeFile(archiveFile, '{"schema_version":1,"outros":"bytes"}\n', 'utf8');

    await expect(retry(fixture)).rejects.toThrow(/archive do CompletionRecord FAIL diverge/i);
    // O slot corrente continua sendo a única evidência viva do FAIL.
    expect(await exists(completionPath(fixture.paths, TASK))).toBe(true);
  });

  it('não libera o slot antes de publicar record e archive', async () => {
    const fixture = await setup();
    class Crash extends Error {}
    await expect(
      retryFailedAttempt({
        paths: fixture.paths,
        taskId: TASK,
        reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
        reason: REASON,
        now: () => NOW,
        afterRecordWritten: async () => {
          throw new Crash('crash antes do archive');
        },
      }),
    ).rejects.toThrow(/crash antes do archive/);

    expect(await exists(failedAttemptCompletionPath(fixture.paths, TASK, 2))).toBe(false);
    expect(await exists(completionPath(fixture.paths, TASK))).toBe(true);
  });

  it('retoma depois de crash entre o archive e a liberação do slot', async () => {
    const fixture = await setup();
    const original = await readFile(completionPath(fixture.paths, TASK));
    class Crash extends Error {}
    await expect(
      retryFailedAttempt({
        paths: fixture.paths,
        taskId: TASK,
        reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
        reason: REASON,
        now: () => NOW,
        afterCompletionArchived: async () => {
          throw new Crash('crash depois do archive');
        },
      }),
    ).rejects.toThrow(/crash depois do archive/);

    // Archive publicado, slot ainda ocupado, tarefa ainda FAIL.
    expect(await readFile(failedAttemptCompletionPath(fixture.paths, TASK, 2))).toEqual(original);
    expect(await exists(completionPath(fixture.paths, TASK))).toBe(true);
    expect((await readState(fixture.paths)).tasks.find((task) => task.id === TASK)?.status).toBe(
      'FAIL',
    );

    const result = await retry(fixture);
    expect(result.alreadyArchived).toBe(true);
    expect(await exists(completionPath(fixture.paths, TASK))).toBe(false);
    expect((await readState(fixture.paths)).tasks.find((task) => task.id === TASK)?.status).toBe(
      'READY',
    );
  });

  it('retoma depois de crash entre a liberação do slot e o reset', async () => {
    const fixture = await setup();
    const original = await readFile(completionPath(fixture.paths, TASK));
    class Crash extends Error {}
    await expect(
      retryFailedAttempt({
        paths: fixture.paths,
        taskId: TASK,
        reasonCode: 'OFFICIAL_VALIDATION_FAILURE',
        reason: REASON,
        now: () => NOW,
        afterCompletionReleased: async () => {
          throw new Crash('crash depois da liberação');
        },
      }),
    ).rejects.toThrow(/crash depois da liberação/);

    // Slot já liberado e patch ainda em disco: a retomada não pode depender do
    // CompletionRecord corrente que ela mesma removeu.
    expect(await exists(completionPath(fixture.paths, TASK))).toBe(false);
    const status = await runGit(fixture.sandbox.root, ['status', '--porcelain=v1']);
    expect(status.stdout.trim()).not.toBe('');

    const result = await retry(fixture);
    expect(result.alreadyArchived).toBe(true);
    expect(await readFile(failedAttemptCompletionPath(fixture.paths, TASK, 2))).toEqual(original);
    expect(result.restored).toEqual([REMOVED, MODIFIED].sort());
    expect((await runGit(fixture.sandbox.root, ['status', '--porcelain=v1'])).stdout.trim()).toBe('');
    expect((await readState(fixture.paths)).tasks.find((task) => task.id === TASK)?.status).toBe(
      'READY',
    );
  });

  it('é idempotente com a tarefa já READY e o archive publicado', async () => {
    const fixture = await setup();
    const first = await retry(fixture);
    const archived = await readFile(failedAttemptCompletionPath(fixture.paths, TASK, 2));

    // Sem reabrir o state: READY com archive publicado é retomada legítima.
    const second = await retry(fixture);
    expect(second.alreadyArchived).toBe(true);
    expect(second.releasedCurrentCompletion).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(await readFile(failedAttemptCompletionPath(fixture.paths, TASK, 2))).toEqual(archived);

    const state = await readState(fixture.paths);
    expect(state.tasks.find((task) => task.id === TASK)?.status).toBe('READY');
    expect(state.tasks.find((task) => task.id === TASK)?.attempts).toBe(2);
  });

  it('um FAIL posterior não sobrescreve o archive do attempt anterior', async () => {
    const fixture = await setup();
    const original = await readFile(completionPath(fixture.paths, TASK));
    await retry(fixture);

    // Attempt 3: mesma solução reprovada de novo, com evidence própria.
    await rewritePatch(fixture.sandbox.root);
    await writeFile(completionPath(fixture.paths, TASK), original);
    await writeRevalidationSourceBinding(fixture.paths, {
      schema_version: 1,
      task_id: TASK,
      attempt: 3,
      source_base_sha: fixture.baseSha,
      original_completion_path: 'original-completion.fail.json',
      original_completion_sha256: digest(original),
      report_sha256: digest(await readFile(reportPath(fixture.paths, TASK))),
      handoff_draft_sha256: digest(await readFile(handoffDraftPath(fixture.paths, TASK))),
      changed_files: PATCH_FILES,
      derived_patch_fingerprint: await patchFingerprint(fixture.sandbox.root),
      fingerprint_observed_at: NOW,
      fingerprint_provenance: 'derived_during_revalidation_preflight',
    });
    const state = await readState(fixture.paths);
    await writeState(
      fixture.paths,
      withTaskState(state, TASK, { status: 'FAIL', attempts: 3, finished_at: NOW }),
    );

    const result = await retry(fixture);
    expect(result.record.attempt).toBe(3);
    expect(await readFile(failedAttemptCompletionPath(fixture.paths, TASK, 3))).toEqual(original);
    // O attempt 2 continua intacto: cada attempt tem o próprio archive.
    expect(await readFile(failedAttemptCompletionPath(fixture.paths, TASK, 2))).toEqual(original);
    expect(await readValidationFailedAttempt(fixture.paths, TASK, 2)).not.toBeNull();
    expect(
      (await readState(fixture.paths)).tasks.find((task) => task.id === TASK)?.attempts,
    ).toBe(3);
  });
});

describe('dev-retry-failed reset e state', () => {
  it('restaura somente os changed_files e deixa working tree e index limpos', async () => {
    const fixture = await setup();
    const result = await retry(fixture);

    expect(result.restored).toEqual([REMOVED, MODIFIED].sort());
    expect(result.removed).toEqual([ADDED]);

    expect(await readFile(path.join(fixture.sandbox.root, MODIFIED), 'utf8')).toBe(
      BASE_CONTENT[MODIFIED],
    );
    expect(await readFile(path.join(fixture.sandbox.root, REMOVED), 'utf8')).toBe(
      BASE_CONTENT[REMOVED],
    );
    expect(await exists(path.join(fixture.sandbox.root, ADDED))).toBe(false);

    const status = await runGit(fixture.sandbox.root, ['status', '--porcelain=v1']);
    expect(status.stdout.trim()).toBe('');
  });

  it('não toca em arquivos fora de changed_files nem em artifacts ignorados', async () => {
    const fixture = await setup();
    await retry(fixture);

    // Provaria o contrário: `reset --hard` mexeria na árvore inteira e
    // `clean -x` levaria o artifact ignorado e o runtime do orquestrador junto.
    expect(await readFile(path.join(fixture.sandbox.root, UNTOUCHED), 'utf8')).toBe(
      BASE_CONTENT[UNTOUCHED],
    );
    expect(await exists(path.join(fixture.sandbox.root, IGNORED))).toBe(true);
    expect(await exists(fixture.paths.stateFile)).toBe(true);
  });

  it('leva a tarefa de FAIL para READY sem diminuir attempts nem mover a base', async () => {
    const fixture = await setup();
    const before = await readState(fixture.paths);
    const result = await retry(fixture);
    const after = await readState(fixture.paths);
    const task = after.tasks.find((candidate) => candidate.id === TASK);

    expect(task).toMatchObject({
      status: 'READY',
      phase: null,
      process: null,
      candidate_commit: null,
      accepted_commit: null,
    });
    expect(task?.attempts).toBe(2);
    expect(task?.attempts).toBeGreaterThanOrEqual(
      before.tasks.find((candidate) => candidate.id === TASK)?.attempts ?? 0,
    );
    expect(after.authorized_head_sha).toBe(before.authorized_head_sha);
    expect(after.authorized_head_sha).toBe(fixture.baseSha);
    expect(await headSha(fixture.sandbox.root)).toBe(fixture.baseSha);
    expect(result.record.attempt).toBe(2);
  });
});

describe('dev-retry-failed feedback para o attempt de reparo', () => {
  it('entrega previous_attempt_diagnostics no packet do próximo attempt', async () => {
    const fixture = await setup();
    await retry(fixture);

    const diagnostics = await readPreviousAttemptDiagnostics(fixture.paths, TASK, 2);
    expect(diagnostics).toMatchObject({
      attempt: 2,
      profile_id: PROFILE,
      worker_self_reported_result: 'SUCCESS',
      reason_code: 'OFFICIAL_VALIDATION_FAILURE',
      reason: REASON,
      validation_logs_dir: `validation-logs/${TASK}/attempt-2`,
    });
    // Somente o comando que falhou de fato, com exit code e caminho do log.
    expect(diagnostics?.failed_validations).toEqual([
      {
        argv: ['pnpm', 'test'],
        exit_code: 1,
        timed_out: false,
        stdout_path: `validation-logs/${TASK}/attempt-2/0002.stdout.log`,
        stderr_path: `validation-logs/${TASK}/attempt-2/0002.stderr.log`,
      },
    ]);

    const prepared = await prepareNextTask(fixture.paths, fixture.loaded);
    expect(prepared.selection.status).toBe('SELECTED');
    expect(prepared.packet?.task_id).toBe(TASK);
    expect(prepared.packet?.previous_attempt_diagnostics).toEqual(diagnostics);
  });

  it('não entrega transcript, sumário nem raciocínio do attempt anterior', async () => {
    const fixture = await setup();
    await retry(fixture);
    const prepared = await prepareNextTask(fixture.paths, fixture.loaded);
    const serialized = JSON.stringify(prepared.packet);

    for (const leak of [
      fixture.report.summary,
      'DECISAO-DO-WORKER-ANTERIOR',
      'LICAO-DO-WORKER-ANTERIOR',
    ]) {
      expect(serialized).not.toContain(leak);
    }
    expect(Object.keys(prepared.packet?.previous_attempt_diagnostics ?? {}).sort()).toEqual([
      'attempt',
      'changed_files',
      'failed_validations',
      'profile_id',
      'reason',
      'reason_code',
      'validation_logs_dir',
      'worker_self_reported_result',
    ]);
  });

  it('não injeta diagnostics quando não há attempt arquivado', async () => {
    const fixture = await setup();
    expect(await readPreviousAttemptDiagnostics(fixture.paths, TASK, 2)).toBeNull();
    expect(await readPreviousAttemptDiagnostics(fixture.paths, TASK, 0)).toBeNull();
  });

  it('a derivação do diagnóstico é determinística', async () => {
    const fixture = await setup();
    const result = await retry(fixture);
    expect(previousAttemptDiagnosticsFrom(result.record)).toEqual(
      previousAttemptDiagnosticsFrom(result.record),
    );
    expect(await exists(validationFailedAttemptPath(fixture.paths, TASK, 2))).toBe(true);
  });
});
