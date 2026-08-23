import { describe, expect, it } from 'vitest';
import { MAXIMUM_PREAMBLE_BYTES, buildWorkerPrompt } from '../../dev/lib/prompt.js';
import {
  LEGACY_EXECUTION_POLICY,
  ORCHESTRATED_EXECUTION_POLICY,
} from '../../dev/lib/execution-policy.js';
import type { TaskPacket } from '../../dev/lib/schemas.js';
import { canonicalJson } from '../../dev/lib/canonical.js';

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
  it('declara autonomia de exploração e implementação, sem microgerenciar o coding agent', () => {
    const prompt = buildWorkerPrompt(PACKET, IO, LEGACY_EXECUTION_POLICY);

    expect(prompt).toMatch(/autonomia para investigar e implementar/i);
    expect(prompt).toMatch(/explore o repositório, escolha o que ler, decida a\s+abordagem/i);
    expect(prompt).toMatch(/ferramentas auxiliares que o provider oferecer\s+\(incluindo skills e subagentes\)/i);
    expect(prompt).toMatch(/não faça trabalho fora do escopo/i);
  });

  it('não impõe limite fixo de operações exploratórias nem proibição absoluta de ferramentas', () => {
    for (const policy of [LEGACY_EXECUTION_POLICY, ORCHESTRATED_EXECUTION_POLICY]) {
      const prompt = buildWorkerPrompt(PACKET, IO, policy);
      expect(prompt).not.toMatch(/8 operações/i);
      expect(prompt).not.toMatch(/não carregue skills nem subagentes/i);
      expect(prompt).not.toMatch(/NÃO execute o `pnpm build` global/i);
      expect(prompt).not.toMatch(/NÃO execute o `pnpm test` completo/i);
      expect(prompt).not.toMatch(/NÃO use `run_in_background`/i);
    }
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
    expect(prompt).toMatch(/autonomia para investigar e implementar/i);
    for (const command of ['git add', 'git commit', 'git stash', 'git reset']) {
      expect(prompt).toMatch(new RegExp(`NÃO rode[\\s\\S]*${command}`, 'i'));
    }
    expect(prompt).toMatch(/checkout de arquivos/i);
    expect(prompt).toMatch(/não altere HEAD nem index/i);
    expect(prompt).toMatch(/prefira checks direcionados enquanto desenvolve/i);
    expect(prompt).toMatch(
      /pode rodar build ou uma\s+suíte mais ampla quando isso for proporcional e útil/i,
    );
    expect(prompt).toMatch(/não repita suítes globais sem necessidade/i);
    expect(prompt).toMatch(
      /validação oficial que decide PASS\/FAIL pertence exclusivamente ao\s+orquestrador/i,
    );
    expect(prompt).toMatch(/você não decide o\s+resultado/i);
    expect(prompt).toMatch(
      /se iniciar um processo auxiliar[\s\S]*encerre-o antes de\s+finalizar/i,
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

describe('contrato de handoff v2 no prompt do implementer', () => {
  for (const [name, policy] of [
    ['worker-owned', LEGACY_EXECUTION_POLICY],
    ['orchestrator-owned', ORCHESTRATED_EXECUTION_POLICY],
  ] as const) {
    it(`exige what_i_did_not_check com semântica de lista vazia (${name})`, () => {
      const prompt = buildWorkerPrompt(PACKET, IO, policy);

      expect(prompt).toMatch(/"schema_version":2/);
      expect(prompt).toMatch(/"what_i_did_not_check":\[<≤5 itens curtos>\]/);
      expect(prompt).toMatch(
        /what_i_did_not_check é OBRIGATÓRIO: liste os aspectos relevantes que você\s+reconhece NÃO ter verificado/i,
      );
      // A diferença entre [] e campo omitido precisa estar dita, não inferida.
      expect(prompt).toMatch(
        /\[\] é uma afirmação positiva[\s\S]*NÃO significa campo ignorado; omitir o campo invalida/i,
      );
      expect(prompt).toMatch(/evidence APONTA para a evidência/i);
      expect(prompt).toMatch(
        /nunca conteúdo de arquivo, diff, stdout, stderr ou transcript/i,
      );
      expect(prompt).toMatch(/"open_questions"/);
      expect(prompt).toMatch(/"confidence"/);
    });

    // Artifacts operacionais, não raciocínio: o protocolo NÃO pede análise,
    // justificativa longa nem passo a passo — isso seria context bloat com
    // outro nome.
    it(`não pede raciocínio ao worker (${name})`, () => {
      const prompt = buildWorkerPrompt(PACKET, IO, policy);
      for (const forbidden of [
        /chain of thought/i,
        /passo a passo/i,
        /explique seu raciocínio/i,
        /justifique detalhadamente/i,
        /análise completa/i,
        /pense antes/i,
      ]) {
        expect(prompt).not.toMatch(forbidden);
      }
    });

    it(`mantém o preâmbulo dentro do budget com o contrato v2 (${name})`, () => {
      const prompt = buildWorkerPrompt(PACKET, IO, policy);
      // O packet entra canonicalizado: medir o preâmbulo exige cortar
      // exatamente onde ele começa, não onde um JSON qualquer começaria.
      const packetJson = canonicalJson(PACKET);
      const cut = prompt.indexOf(packetJson);
      expect(cut).toBeGreaterThan(0);
      expect(Buffer.byteLength(prompt.slice(0, cut), 'utf8')).toBeLessThanOrEqual(
        MAXIMUM_PREAMBLE_BYTES,
      );
    });
  }
});
