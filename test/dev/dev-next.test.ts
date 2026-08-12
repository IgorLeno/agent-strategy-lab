import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAXIMUM_TASK_PACKET_BYTES,
  byteSize,
  parseHandoffRecord,
  parseTaskPacket,
} from '../../dev/lib/schemas.js';
import { buildTaskPacket } from '../../dev/lib/packet.js';
import { loadPlan } from '../../dev/lib/plan.js';
import { REPO_ROOT, makeSandboxRepo, runDevCli, type Sandbox } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function initializedSandbox(): Promise<Sandbox> {
  const sandbox = await makeSandboxRepo();
  created.push(sandbox.root);
  const result = await runDevCli('dev-init.ts', ['--repo', sandbox.root], {
    AGENTLAB_DEV_DIR: sandbox.devDir,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  return sandbox;
}

/** Impressão digital recursiva do diretório — conteúdo, não só nomes. */
async function fingerprint(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const parts: string[] = [];
  for (const entry of entries.sort((a, b) => `${a.parentPath}/${a.name}`.localeCompare(`${b.parentPath}/${b.name}`))) {
    const full = path.join(entry.parentPath, entry.name);
    parts.push(entry.isDirectory() ? `d:${full}` : `f:${full}:${await readFile(full, 'utf8')}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

describe('dev-next', () => {
  it('emite somente o resumo operacional da primeira tentativa e não escreve em disco', async () => {
    const sandbox = await initializedSandbox();
    const before = await fingerprint(sandbox.devDir);
    const state = JSON.parse(await readFile(path.join(sandbox.devDir, 'state.json'), 'utf8')) as {
      authorized_head_sha: string;
    };

    const result = await runDevCli('dev-next.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(result.exitCode, result.stderr).toBe(0);

    expect(JSON.parse(result.stdout)).toEqual({
      status: 'SELECTED',
      ready_to_launch: true,
      task_id: 'T1',
      title: 'primeira tarefa',
      attempt: 1,
      attempt_kind: 'FIRST_PASS',
      base_sha: state.authorized_head_sha,
      authorized_head_sha: state.authorized_head_sha,
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('packet');
    expect(JSON.parse(result.stdout)).not.toHaveProperty('objective');
    expect(JSON.parse(result.stdout)).not.toHaveProperty('acceptance');
    expect(JSON.parse(result.stdout)).not.toHaveProperty('validation');
    expect(JSON.parse(result.stdout)).not.toHaveProperty('initial_files');

    expect(await fingerprint(sandbox.devDir)).toBe(before);
  });

  it('--verbose preserva reason e o TaskPacket completo', async () => {
    const sandbox = await initializedSandbox();

    const result = await runDevCli('dev-next.ts', ['--repo', sandbox.root, '--verbose'], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(result.exitCode, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as {
      status: string;
      reason: string;
      packet: unknown;
    };
    expect(output.status).toBe('SELECTED');
    expect(output.reason).toBe('T1 pronta');
    const packet = parseTaskPacket(output.packet);
    expect(packet).toMatchObject({
      schema_version: 1,
      task_id: 'T1',
      objective: 'criar src/one.txt',
      initial_files: ['README.md'],
      acceptance: ['arquivo criado'],
      validation: [{ argv: ['true'], timeout_seconds: 30 }],
    });
    expect(packet.previous_handoff).toBeNull();
    expect(byteSize(packet)).toBeLessThanOrEqual(MAXIMUM_TASK_PACKET_BYTES);
  });

  it('resume repair como próximo attempt e preserva diagnósticos no verbose', async () => {
    const sandbox = await initializedSandbox();
    const statePath = path.join(sandbox.devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      authorized_head_sha: string;
      tasks: { id: string; attempts: number }[];
    };
    state.tasks.find((task) => task.id === 'T1')!.attempts = 1;
    await writeFile(statePath, JSON.stringify(state));

    const failedAttemptDir = path.join(sandbox.devDir, 'failed-attempts', 'T1', 'attempt-1');
    await mkdir(failedAttemptDir, { recursive: true });
    await writeFile(
      path.join(failedAttemptDir, 'validation-failed-attempt.json'),
      JSON.stringify({
        schema_version: 1,
        task_id: 'T1',
        attempt: 1,
        source_base_sha: state.authorized_head_sha,
        profile_id: 'test-profile',
        worker_self_reported_result: 'SUCCESS',
        report_candidate_commit: null,
        orchestrator_verdict: 'REJECTED_BY_OFFICIAL_VALIDATION',
        finalization_mode: 'normal',
        launch_record_sha256: 'a'.repeat(64),
        original_completion_sha256: 'b'.repeat(64),
        report_sha256: 'c'.repeat(64),
        handoff_draft_sha256: 'd'.repeat(64),
        source_binding_sha256: 'e'.repeat(64),
        patch_fingerprint: 'f'.repeat(64),
        changed_files: ['dev/cli/example.ts'],
        original_validation_results: [
          { argv: ['pnpm', 'test'], exit_code: 1, timed_out: false, duration_ms: 1 },
        ],
        change_bundle: {
          manifest_path: 'failed-attempts/T1/attempt-1/changes-manifest.json',
          manifest_sha256: '1'.repeat(64),
          patch_path: 'failed-attempts/T1/attempt-1/changes.patch',
          patch_sha256: '2'.repeat(64),
          patch_size_bytes: 1,
        },
        reason_code: 'OFFICIAL_VALIDATION_FAILURE',
        reason: 'pnpm test falhou',
        archived_at: '2026-08-11T12:00:00.000Z',
      }),
    );

    const compact = await runDevCli('dev-next.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(compact.exitCode, compact.stderr).toBe(0);
    expect(JSON.parse(compact.stdout)).toMatchObject({
      status: 'SELECTED',
      ready_to_launch: true,
      task_id: 'T1',
      attempt: 2,
      attempt_kind: 'REPAIR',
    });

    const verbose = await runDevCli('dev-next.ts', ['--repo', sandbox.root, '--verbose'], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(verbose.exitCode, verbose.stderr).toBe(0);
    expect(JSON.parse(verbose.stdout).packet.previous_attempt_diagnostics).toMatchObject({
      attempt: 1,
      reason: 'pnpm test falhou',
      failed_validations: [{ argv: ['pnpm', 'test'], exit_code: 1 }],
    });
  });

  it('mantém a seleção visível mas bloqueia lançamento quando a base diverge', async () => {
    const sandbox = await initializedSandbox();
    const statePath = path.join(sandbox.devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      authorized_head_sha: string;
    };
    state.authorized_head_sha = 'a'.repeat(40);
    await writeFile(statePath, JSON.stringify(state));

    const result = await runDevCli('dev-next.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'SELECTED',
      ready_to_launch: false,
      task_id: 'T1',
      authorized_head_sha: 'a'.repeat(40),
      blocker: 'BASE_DIVERGED',
    });
    expect(JSON.parse(result.stdout).base_sha).not.toBe('a'.repeat(40));
  });

  it('todo packet do plano real cabe no budget, mesmo com handoff cheio', async () => {
    const { plan } = await loadPlan(path.join(REPO_ROOT, 'dev', 'plan.yaml'));
    // Handoff no limite dos 4 KiB: o pior caso de packet é tarefa maior + handoff maior.
    const previousHandoff = parseHandoffRecord({
      schema_version: 1,
      task_id: 'M00',
      result: 'PASS',
      accepted_commit: 'c'.repeat(40),
      sealed_at: '2026-08-05T12:00:00.000Z',
      changed_files: Array.from({ length: 20 }, (_, i) => `src/area/arquivo-${i}.ts`),
      validations: [{ argv: ['pnpm', 'test'], exit_code: 0, timed_out: false, duration_ms: 1 }],
      decisions: Array.from({ length: 5 }, (_, i) => `decisão ${i} `.repeat(15)),
      lessons: Array.from({ length: 3 }, (_, i) => `lição ${i} `.repeat(10)),
      next_relevant_files: Array.from({ length: 5 }, (_, i) => `src/area/proximo-${i}.ts`),
    });

    for (const task of plan.tasks) {
      const packet = buildTaskPacket({
        task: { ...task, include_previous_handoff: true },
        baseSha: 'a'.repeat(40),
        previousHandoff,
        now: '2026-08-05T12:00:00.000Z',
      });
      expect(byteSize(packet), task.id).toBeLessThanOrEqual(MAXIMUM_TASK_PACKET_BYTES);
    }
  });

  it('para com exit 4 quando alguma tarefa está em estado bloqueante', async () => {
    const sandbox = await initializedSandbox();
    const statePath = path.join(sandbox.devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { tasks: { status: string }[] };
    state.tasks[0]!.status = 'FAIL';
    await writeFile(statePath, JSON.stringify(state));

    const result = await runDevCli('dev-next.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'HALTED',
      ready_to_launch: false,
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('packet');
  });

  it('emite BLOCKED compacto com exit 4 quando a dependência não está no state', async () => {
    const sandbox = await initializedSandbox();
    const statePath = path.join(sandbox.devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { tasks: { id: string }[] };
    state.tasks = state.tasks.filter((task) => task.id === 'T2');
    await writeFile(statePath, JSON.stringify(state));

    const result = await runDevCli('dev-next.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'BLOCKED',
      ready_to_launch: false,
      reason: expect.stringContaining('dependências PASS'),
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('packet');
  });

  it('emite ALL_DONE compacto com exit 0 quando todas as tasks passaram', async () => {
    const sandbox = await initializedSandbox();
    const statePath = path.join(sandbox.devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      authorized_head_sha: string;
      tasks: { status: string; accepted_commit: string | null }[];
    };
    for (const task of state.tasks) {
      task.status = 'PASS';
      task.accepted_commit = state.authorized_head_sha;
    }
    await writeFile(statePath, JSON.stringify(state));

    const result = await runDevCli('dev-next.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'ALL_DONE',
      ready_to_launch: false,
      reason: 'nenhuma tarefa pendente',
    });
  });

  it('bloqueia quando dev/plan.yaml mudou depois do dev-init', async () => {
    const sandbox = await initializedSandbox();
    const statePath = path.join(sandbox.devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { plan_sha256: string };
    state.plan_sha256 = 'd'.repeat(64);
    await writeFile(statePath, JSON.stringify(state));

    const result = await runDevCli('dev-next.ts', ['--repo', sandbox.root], {
      AGENTLAB_DEV_DIR: sandbox.devDir,
    });
    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toEqual({
      status: 'BLOCKED',
      ready_to_launch: false,
      reason: 'dev/plan.yaml mudou desde o dev-init — rode dev-recover para reconciliar',
    });
  });
});
