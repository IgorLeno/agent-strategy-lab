import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import { REPO_ROOT, makeTempDevDir, runDevCli } from './helpers.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function initializedDevDir(): Promise<string> {
  const dir = await makeTempDevDir();
  created.push(dir);
  const result = await runDevCli('dev-init.ts', [], { AGENTLAB_DEV_DIR: dir });
  expect(result.exitCode, result.stderr).toBe(0);
  return dir;
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
  it('emite o packet da primeira tarefa e não escreve nada em disco', async () => {
    const devDir = await initializedDevDir();
    const before = await fingerprint(devDir);

    const result = await runDevCli('dev-next.ts', [], { AGENTLAB_DEV_DIR: devDir });
    expect(result.exitCode, result.stderr).toBe(0);

    const output = JSON.parse(result.stdout) as { status: string; packet: unknown };
    expect(output.status).toBe('SELECTED');
    const packet = parseTaskPacket(output.packet);
    expect(packet.task_id).toBe('M01');
    expect(packet.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(packet.previous_handoff).toBeNull();
    expect(byteSize(packet)).toBeLessThanOrEqual(MAXIMUM_TASK_PACKET_BYTES);

    expect(await fingerprint(devDir)).toBe(before);
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
    const devDir = await initializedDevDir();
    const statePath = path.join(devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { tasks: { status: string }[] };
    state.tasks[0]!.status = 'FAIL';
    await writeFile(statePath, JSON.stringify(state));

    const result = await runDevCli('dev-next.ts', [], { AGENTLAB_DEV_DIR: devDir });
    expect(result.exitCode).toBe(4);
    expect((JSON.parse(result.stdout) as { status: string }).status).toBe('HALTED');
  });

  it('bloqueia quando dev/plan.yaml mudou depois do dev-init', async () => {
    const devDir = await initializedDevDir();
    const statePath = path.join(devDir, 'state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as { plan_sha256: string };
    state.plan_sha256 = 'd'.repeat(64);
    await writeFile(statePath, JSON.stringify(state));

    const result = await runDevCli('dev-next.ts', [], { AGENTLAB_DEV_DIR: devDir });
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toMatch(/dev-recover/);
  });
});
