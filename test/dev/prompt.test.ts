import { describe, expect, it } from 'vitest';
import { MAXIMUM_PREAMBLE_BYTES, buildWorkerPrompt } from '../../dev/lib/prompt.js';
import {
  LEGACY_EXECUTION_POLICY,
  ORCHESTRATED_EXECUTION_POLICY,
} from '../../dev/lib/execution-policy.js';
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
    const prompt = buildWorkerPrompt(PACKET, IO, LEGACY_EXECUTION_POLICY);

    expect(prompt).toMatch(/comece pelo packet e pelos initial_files/i);
    expect(prompt).toMatch(/não carregue skills nem subagentes\s+salvo pedido explícito/i);
    expect(prompt).toMatch(/use rg e intervalos direcionados/i);
    expect(prompt).toMatch(/não leia\s+LESSONS\.md ou ARCHITECTURE\.md inteiros sem necessidade/i);
    expect(prompt).toMatch(/primeira edição após no máximo 8 operações\s+exploratórias/i);
    expect(prompt).toMatch(/não faça revisão geral do repositório/i);
  });

  it('mantém o preâmbulo dentro do budget', () => {
    const prompt = buildWorkerPrompt(PACKET, IO, LEGACY_EXECUTION_POLICY);
    const packetJson = JSON.stringify(PACKET);
    const preamble = prompt.slice(0, prompt.indexOf(packetJson));

    expect(Buffer.byteLength(preamble, 'utf8')).toBeLessThanOrEqual(MAXIMUM_PREAMBLE_BYTES);
  });

  it('mantém validações oficiais no profile full e preserva ownership de commit', () => {
    const prompt = buildWorkerPrompt(PACKET, IO, LEGACY_EXECUTION_POLICY);
    expect(prompt).toMatch(/crie EXATAMENTE UM commit local/i);
    expect(prompt).toMatch(/rode as validações do packet você mesmo antes de commitar/i);
    expect(prompt).not.toMatch(/NÃO execute o `pnpm (?:test|build)`/i);
  });

  it('torna a validação targeted focal e exclusiva do orquestrador', () => {
    const prompt = buildWorkerPrompt(PACKET, IO, ORCHESTRATED_EXECUTION_POLICY);

    expect(prompt).toMatch(/execute SOMENTE a tarefa deste packet/i);
    expect(prompt).toMatch(/comece pelo packet e pelos initial_files/i);
    expect(prompt).toMatch(/não carregue skills nem subagentes\s+salvo pedido explícito/i);
    for (const command of ['git add', 'git commit', 'git stash', 'git reset']) {
      expect(prompt).toMatch(new RegExp(`NÃO rode[\\s\\S]*${command}`, 'i'));
    }
    expect(prompt).toMatch(/checkout de arquivos/i);
    expect(prompt).toMatch(/não altere HEAD nem index/i);
    expect(prompt).toMatch(/execute somente checks pequenos necessários para desenvolver o patch/i);
    expect(prompt).toMatch(
      /pode executar\s+typecheck, o teste direcionado da tarefa e testes adicionais pequenos e diretamente\s+relacionados/i,
    );
    expect(prompt).toMatch(/NÃO execute o `pnpm test` completo/i);
    expect(prompt).toMatch(/NÃO execute o `pnpm build` global/i);
    expect(prompt).toMatch(/NÃO execute novamente toda a lista `packet\.validation`/i);
    expect(prompt).toMatch(
      /validações oficiais completas\s+pertencem exclusivamente ao orquestrador\s+e serão executadas fora do sandbox do provider/i,
    );
    expect(prompt).toMatch(
      /falha ambiental de uma validação global que o worker não deveria executar\s+não deve ser investigada pelo worker/i,
    );
    expect(prompt).toMatch(/SUCCESS significa "patch pronto para validação oficial"/i);
    expect(prompt).toMatch(/candidate_commit deve ser null/i);
    expect(prompt).toMatch(/changed_files.*exatamente os\s+arquivos alterados/is);
    expect(prompt).toMatch(
      /changed_files lista exclusivamente os arquivos do patch dentro do repositório[\s\S]*NÃO inclua reportPath, handoffDraftPath, \.dev, \.dev-inbox ou qualquer arquivo de protocolo/i,
    );
    expect(prompt).toMatch(/validations.*somente comandos.*realmente executou/is);
    expect(prompt).toMatch(/HandoffDraft.*PASS.*pronto para validação/is);
    expect(prompt).toMatch(/FAIL.*não conseguiu produzir patch utilizável/is);
    expect(prompt).toMatch(/não inicie a próxima tarefa/i);
    expect(prompt).not.toMatch(/crie EXATAMENTE UM commit local/i);
  });

  it('mantém também o preâmbulo orchestrator-owned dentro do budget', () => {
    const prompt = buildWorkerPrompt(PACKET, IO, ORCHESTRATED_EXECUTION_POLICY);
    const packetJson = JSON.stringify(PACKET);
    const preamble = prompt.slice(0, prompt.indexOf(packetJson));

    expect(Buffer.byteLength(preamble, 'utf8')).toBeLessThanOrEqual(MAXIMUM_PREAMBLE_BYTES);
  });
});
