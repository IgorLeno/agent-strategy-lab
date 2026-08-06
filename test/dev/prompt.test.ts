import { describe, expect, it } from 'vitest';
import { MAXIMUM_PREAMBLE_BYTES, buildWorkerPrompt } from '../../dev/lib/prompt.js';
import type { TaskPacket } from '../../dev/lib/schemas.js';

const PACKET: TaskPacket = {
  schema_version: 1,
  task_id: 'T1',
  title: 'mudança localizada',
  objective: 'alterar um módulo específico',
  base_sha: '1111111111111111111111111111111111111111',
  initial_files: ['src/local.ts'],
  acceptance: ['comportamento coberto'],
  validation: [{ argv: ['pnpm', 'test'], timeout_seconds: 30 }],
  constraints: [],
  previous_handoff: null,
  generated_at: '2026-08-06T12:00:00.000Z',
};

const IO = {
  repoRoot: '/repo',
  packetPath: '/repo/.dev/task-packets/T1.json',
  reportPath: '/repo/.dev-inbox/T1/report.json',
  handoffDraftPath: '/repo/.dev-inbox/T1/handoff-draft.json',
};

describe('prompt lean do worker', () => {
  it('limita descoberta global antes da primeira edição', () => {
    const prompt = buildWorkerPrompt(PACKET, IO);

    expect(prompt).toMatch(/comece pelo packet e pelos initial_files/i);
    expect(prompt).toMatch(/não carregue skills nem subagentes\s+salvo pedido explícito/i);
    expect(prompt).toMatch(/use rg e intervalos direcionados/i);
    expect(prompt).toMatch(/não leia\s+LESSONS\.md ou ARCHITECTURE\.md inteiros sem necessidade/i);
    expect(prompt).toMatch(/primeira edição após no máximo 8 operações\s+exploratórias/i);
    expect(prompt).toMatch(/não faça revisão geral do repositório/i);
  });

  it('mantém o preâmbulo dentro do budget', () => {
    const prompt = buildWorkerPrompt(PACKET, IO);
    const packetJson = JSON.stringify(PACKET);
    const preamble = prompt.slice(0, prompt.indexOf(packetJson));

    expect(Buffer.byteLength(preamble, 'utf8')).toBeLessThanOrEqual(MAXIMUM_PREAMBLE_BYTES);
  });
});
