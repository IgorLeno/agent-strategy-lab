import { describe, expect, it } from 'vitest';

import {
  HANDOFF_FIELD_TAXONOMY,
  normalizeHandoffOpinion,
} from '../../dev/lib/handoff-normalize.js';
import {
  AgentCompletionReport,
  HANDOFF_NORMALIZATION_SCHEMAS,
  HANDOFF_SCHEMA_VERSION_V2,
  CandidateReviewRecord,
  isHandoffDraftV2,
  parseHandoffDraft,
  readHandoffConfidence,
} from '../../dev/lib/schemas.js';

const normalize = (input: unknown): unknown =>
  normalizeHandoffOpinion(input, HANDOFF_NORMALIZATION_SCHEMAS);

/**
 * O DEFEITO QUE ESTE ARQUIVO TRAVA:
 *
 * Um único campo DESCRITIVO acima de um teto de conveniência derrubava o
 * `HandoffDraft` inteiro. `readHandoffDraft` devolvia `null`, o fechamento
 * ficava PENDING e todo o contexto útil do worker era descartado por causa de
 * um `claim` com 161 caracteres.
 *
 * A tolerância vale SÓ para opinião. Identidade e proveniência continuam
 * fail-closed — é a outra metade do contrato e cada teste abaixo prova as duas.
 */
const draftV2 = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: HANDOFF_SCHEMA_VERSION_V2,
  task_id: 'semiimperium_foundation',
  result: 'PASS',
  changed_files: ['src/a.py', 'src/b.py'],
  validations: [],
  decisions: ['usou o resolver existente'],
  lessons: ['o backend antigo já cobria o caso'],
  next_relevant_files: ['src/a.py'],
  what_i_did_not_check: ['não exercitei o caminho de rede'],
  ...overrides,
});

describe('prose de opinião acima do teto não apaga o handoff', () => {
  it('evidence.claim longo sobrevive truncado e o resto do handoff continua legível', () => {
    const draft = parseHandoffDraft(
      draftV2({
        evidence: [{ kind: 'file', path: 'src/a.py', claim: 'x'.repeat(400) }],
      }),
    );
    expect(isHandoffDraftV2(draft)).toBe(true);
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    // O resto do handoff — o que de fato importa para a review — sobreviveu.
    expect(draft.what_i_did_not_check).toEqual(['não exercitei o caminho de rede']);
    expect(draft.decisions).toEqual(['usou o resolver existente']);
    expect(draft.changed_files).toEqual(['src/a.py', 'src/b.py']);
    // O corte é VISÍVEL: ninguém lê a claim achando que está completa.
    expect(draft.evidence?.[0]?.claim).toContain('…[truncado]');
    expect((draft.evidence?.[0]?.claim ?? '').length).toBeLessThanOrEqual(160);
  });

  it('claim longa pode encurtar sem alterar o path longo da mesma evidência', () => {
    const path = `src/${'segmento/'.repeat(40)}arquivo-final.ts`;
    const draft = parseHandoffDraft(
      draftV2({ evidence: [{ kind: 'file', path, claim: 'x'.repeat(400) }] }),
    );
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.evidence?.[0]).toMatchObject({ kind: 'file', path });
    expect(draft.evidence?.[0]?.claim).toContain('…[truncado]');
  });

  it('confidence longa sobrevive INTEIRA: truncar poderia elevar o nível derivado', () => {
    // O nível vem dos marcadores presentes no texto. Cortar a frase pode
    // remover a hesitação e fazer o worker soar mais seguro do que disse — por
    // isso aqui o teto saiu do schema em vez de virar truncamento.
    const statement = `${'não tenho certeza sobre o caminho de rede. '.repeat(20)}fim`;
    const draft = parseHandoffDraft(draftV2({ confidence: statement }));
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.confidence).toBe(statement);
    expect(readHandoffConfidence(draft.confidence).level).toBe('LOW');
    expect(draft.what_i_did_not_check).toHaveLength(1);
  });
});

describe('cardinalidade de opinião não provoca perda de protocolo', () => {
  it('decisions/lessons acima do teto não recusam o handoff', () => {
    const draft = parseHandoffDraft(
      draftV2({
        decisions: Array.from({ length: 30 }, (_, index) => `decisão ${index}`),
        lessons: Array.from({ length: 12 }, (_, index) => `lição ${index}`),
      }),
    );
    expect(isHandoffDraftV2(draft)).toBe(true);
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.decisions).toHaveLength(5);
    expect(draft.lessons).toHaveLength(3);
    // A omissão é declarada, não escondida.
    expect(draft.decisions.at(-1)).toContain('omitido');
  });

  it('next_relevant_files preserva cada path e toda a cardinalidade', () => {
    const paths = Array.from({ length: 40 }, (_, index) => `src/f${index}.py`);
    const draft = parseHandoffDraft(draftV2({ next_relevant_files: paths }));
    expect(draft.next_relevant_files).toEqual(paths);
  });

  it('INCERTEZA declarada sobrevive INTEIRA: nada de lacuna ou pergunta é cortado', () => {
    // Cortar a sexta lacuna teria direção — faria o trabalho parecer mais
    // completo do que é. Aqui a tolerância veio de remover o teto do schema,
    // não de descartar itens.
    const questions = Array.from({ length: 9 }, (_, index) => `pergunta ${index}`);
    const gaps = Array.from({ length: 11 }, (_, index) => `lacuna ${index}`);
    const draft = parseHandoffDraft(
      draftV2({ open_questions: questions, what_i_did_not_check: gaps }),
    );
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.open_questions).toEqual(questions);
    expect(draft.what_i_did_not_check).toEqual(gaps);
  });

  it('normalização é determinística: mesma entrada, mesma saída', () => {
    const raw = draftV2({ decisions: Array.from({ length: 30 }, (_, i) => `d${i}`) });
    expect(normalize(structuredClone(raw))).toEqual(
      normalize(structuredClone(raw)),
    );
  });
});

describe('um item advisory malformado não apaga os campos advisory válidos', () => {
  it('evidence com kind desconhecido é descartada e o resto permanece', () => {
    const draft = parseHandoffDraft(
      draftV2({
        evidence: [
          { kind: 'inexistente', claim: 'referência que o schema não conhece' },
          { kind: 'file', path: 'src/b.py', claim: 'referência válida' },
        ],
        open_questions: ['o CREST deve rodar por padrão?'],
      }),
    );
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.evidence).toHaveLength(1);
    expect(draft.evidence?.[0]?.claim).toBe('referência válida');
    // Campos advisory NÃO relacionados continuam intactos.
    expect(draft.open_questions).toEqual(['o CREST deve rodar por padrão?']);
    expect(draft.what_i_did_not_check).toHaveLength(1);
  });

  it.each([
    ['record_kind', { record_kind: 'banana', task_id: 'T1', attempt: 1 }],
    ['task_id', { record_kind: 'review', task_id: 'inválido com espaço', attempt: 1 }],
    ['attempt negativo', { record_kind: 'review', task_id: 'T1', attempt: -1 }],
    ['attempt não inteiro', { record_kind: 'review', task_id: 'T1', attempt: 1.5 }],
  ])('descarta só a evidência record com %s inválido', (_label, invalidIdentity) => {
    const valid = {
      kind: 'record',
      record_kind: 'review',
      task_id: 'T1',
      attempt: 2,
      claim: 'review válida',
    };
    const draft = parseHandoffDraft(
      draftV2({
        evidence: [
          { kind: 'record', ...invalidIdentity, claim: 'record inválido' },
          valid,
        ],
      }),
    );
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.evidence).toEqual([valid]);
    expect(draft.what_i_did_not_check).toHaveLength(1);
  });

  it('descarta só a evidência file com intervalo inválido', () => {
    const valid = { kind: 'file', path: 'src/valid.ts', lines: '2-4', claim: 'válida' };
    const draft = parseHandoffDraft(
      draftV2({
        evidence: [
          { kind: 'file', path: 'src/inverted.ts', lines: '9-2', claim: 'inválida' },
          valid,
        ],
      }),
    );
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.evidence).toEqual([valid]);
  });

  it('item vazio numa coleção advisory é descartado sem derrubar a nota', () => {
    const draft = parseHandoffDraft(draftV2({ decisions: ['   ', 'decisão real'] }));
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.decisions).toEqual(['decisão real']);
  });
});

describe('fatos autoritativos e de identidade permanecem fail-closed', () => {
  it('task_id ausente continua recusando a nota inteira', () => {
    const { task_id: _omitted, ...withoutTaskId } = draftV2();
    expect(() => parseHandoffDraft(withoutTaskId)).toThrow();
  });

  it('result inválido continua recusando a nota inteira', () => {
    expect(() => parseHandoffDraft(draftV2({ result: 'TALVEZ' }))).toThrow();
  });

  it('schema_version desconhecida continua recusando a nota inteira', () => {
    expect(() => parseHandoffDraft(draftV2({ schema_version: 99 }))).toThrow();
  });

  it('what_i_did_not_check AUSENTE continua sendo protocolo inválido; nada o inventa', () => {
    const { what_i_did_not_check: _omitted, ...withoutGaps } = draftV2();
    expect(() => parseHandoffDraft(withoutGaps)).toThrow();
    expect(normalize(withoutGaps)).not.toHaveProperty('what_i_did_not_check');
  });

  it('lista de lacunas NÃO vazia nunca é normalizada para vazia', () => {
    // `[]` afirma POSITIVAMENTE "não identifiquei lacuna". Se a limpeza
    // esvaziasse a lista, a normalização estaria INVERTENDO a afirmação do
    // worker: de "reconheço uma lacuna" para "afirmo que não há nenhuma".
    // Nesse caso o campo fica intocado — o significado é preservado mesmo
    // quando o conteúdo é inútil.
    const normalized = normalize(
      draftV2({ what_i_did_not_check: ['   ', '\t'] }),
    ) as Record<string, unknown>;
    expect(normalized['what_i_did_not_check']).toEqual(['   ', '\t']);
    const draft = parseHandoffDraft(normalized);
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.what_i_did_not_check.length).toBeGreaterThan(0);
  });

  it('lista de lacunas vazia declarada pelo worker continua significando vazia', () => {
    const draft = parseHandoffDraft(draftV2({ what_i_did_not_check: [] }));
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.what_i_did_not_check).toEqual([]);
  });

  it('changed_files e validations do draft nunca são reescritos pela normalização', () => {
    const files = Array.from({ length: 80 }, (_, index) => `src/mod${index}.py`);
    const draft = parseHandoffDraft(draftV2({ changed_files: files }));
    expect(draft.changed_files).toEqual(files);
  });
});

describe('identidade de ponteiro nunca é fabricada pela normalização', () => {
  it('preserva argv completo, inclusive cardinalidade e argumentos longos', () => {
    const argv = [
      'pytest',
      ...Array.from({ length: 20 }, (_, index) => `arg-${index}-${'x'.repeat(80)}`),
    ];
    const draft = parseHandoffDraft(
      draftV2({ evidence: [{ kind: 'command', argv, claim: 'comando executado' }] }),
    );
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.evidence?.[0]).toEqual({ kind: 'command', argv, claim: 'comando executado' });
  });

  it('preserva todas as referências válidas sem teto de contagem', () => {
    const evidence = Array.from({ length: 20 }, (_, index) => ({
      kind: 'file',
      path: `src/evidence-${index}.ts`,
      claim: `referência ${index}`,
    }));
    const draft = parseHandoffDraft(draftV2({ evidence }));
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');
    expect(draft.evidence).toEqual(evidence);
  });

  it('preserva cada identidade válida ou descarta a referência inválida inteira', () => {
    const path = `src/${'muito-longo/'.repeat(30)}arquivo.ts`;
    const argv = ['pnpm', 'test', '--', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const raw = draftV2({
      next_relevant_files: [path, 'src/next.ts'],
      evidence: [
        { kind: 'file', path, lines: '10-20', claim: 'arquivo' },
        { kind: 'command', argv, claim: 'comando' },
        { kind: 'record', record_kind: 'review', task_id: 'T1', attempt: 3, claim: 'record' },
        { kind: 'record', record_kind: 'banana', task_id: 'T1', attempt: 3, claim: 'inválido' },
      ],
    });
    const draft = parseHandoffDraft(raw);
    if (!isHandoffDraftV2(draft)) throw new Error('esperava draft v2');

    expect(draft.next_relevant_files).toEqual(raw['next_relevant_files']);
    expect(draft.evidence).toHaveLength(3);
    expect(draft.evidence?.[0]).toMatchObject({ path, lines: '10-20' });
    expect(draft.evidence?.[1]).toMatchObject({ argv });
    expect(draft.evidence?.[2]).toMatchObject({
      record_kind: 'review',
      task_id: 'T1',
      attempt: 3,
    });
  });

  it('remove somente paths canonicamente inválidos sem transformar os válidos', () => {
    const next = ['src/exato.ts', '', 42, ' src/com-espacos-preservados.ts '];
    const relevant = ['docs/exato.md', null, 'docs/outro.md'];
    const normalizedDraft = normalize(draftV2({ next_relevant_files: next })) as Record<
      string,
      unknown
    >;
    const normalizedReport = normalize({ relevant_files: relevant }) as Record<string, unknown>;

    expect(normalizedDraft['next_relevant_files']).toEqual([next[0], next[3]]);
    expect(normalizedReport['relevant_files']).toEqual([relevant[0], relevant[2]]);
  });

  it('torna a taxonomia de todos os campos tocados mecanicamente visível', () => {
    expect(HANDOFF_FIELD_TAXONOMY).toEqual({
      decisions: 'DESCRIPTIVE_PROSE',
      lessons: 'DESCRIPTIVE_PROSE',
      summary: 'DESCRIPTIVE_PROSE',
      what_i_did_not_check: 'DECLARED_UNCERTAINTY',
      open_questions: 'DECLARED_UNCERTAINTY',
      confidence: 'DECLARED_UNCERTAINTY',
      next_relevant_files: 'POINTER_IDENTITY',
      relevant_files: 'POINTER_IDENTITY',
      evidence: 'POINTER_IDENTITY',
      schema_version: 'AUTHORITATIVE_FACT',
      task_id: 'AUTHORITATIVE_FACT',
      result: 'AUTHORITATIVE_FACT',
      self_reported_result: 'AUTHORITATIVE_FACT',
      changed_files: 'AUTHORITATIVE_FACT',
      validations: 'AUTHORITATIVE_FACT',
      candidate_commit: 'AUTHORITATIVE_FACT',
      accepted_commit: 'AUTHORITATIVE_FACT',
      sealed_at: 'AUTHORITATIVE_FACT',
    });
  });
});

describe('a cobertura de review acompanha as lacunas sem teto de contagem', () => {
  // `implementer_gaps` é uma CÓPIA derivada de `what_i_did_not_check`, e
  // `handoff_gaps` precisa endereçar cada item. Se um dos dois mantivesse teto
  // fixo, um handoff com seis lacunas faria `writeCandidateReview` lançar e a
  // promoção parar por CONTAGEM — não por qualidade da review.
  const gaps = Array.from({ length: 9 }, (_, index) => `lacuna ${index}`);

  it('nove lacunas declaradas continuam cabendo no record de review', () => {
    const record = CandidateReviewRecord.parse({
      schema_version: 1,
      task_id: 'semiimperium_foundation',
      attempt: 1,
      candidate_sha: 'a'.repeat(40),
      finalization_record_sha256: 'b'.repeat(64),
      validation_results_sha256: 'c'.repeat(64),
      reviewer_profile_id: 'codex-reviewer',
      reviewer_invocation: {
        role: 'reviewer',
        workspace_access: 'READ_ONLY',
        read_only_mechanism: 'argv convertido para read-only antes do spawn',
        argv: ['codex', 'exec'],
        diversity_requirement: 'DIFFERENT_PROFILE',
        fresh_context: true,
      },
      implementer_gaps: gaps,
      coverage: {
        // A cobertura ESPELHA o tamanho do candidate: 60 arquivos auditados
        // não podem ser recusados por contagem.
        files: Array.from({ length: 60 }, (_, index) => `src/mod${index}.py`),
        validations: [['pytest']],
        behaviors: ['fluxo de cálculo'],
        handoff_gaps: gaps.map((gap) => ({
          gap,
          disposition: 'accepted_with_justification' as const,
          note: 'coberto pela validação oficial',
        })),
      },
      decision: 'ACCEPT',
      reason: 'candidate atende ao critério de aceitação',
      decided_at: new Date(0).toISOString(),
    });
    expect(record.implementer_gaps).toEqual(gaps);
    expect(record.coverage?.handoff_gaps).toHaveLength(9);
    expect(record.coverage?.files).toHaveLength(60);
  });
});

describe('AgentCompletionReport: opinião tolerante, fato comparável intacto', () => {
  const report = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schema_version: 1,
    task_id: 'semiimperium_foundation',
    self_reported_result: 'SUCCESS',
    summary: 'implementou o fluxo',
    candidate_commit: 'a'.repeat(40),
    changed_files: ['src/a.py'],
    validations: [],
    decisions: ['reusou o resolver'],
    lessons: ['nada novo'],
    relevant_files: ['src/a.py'],
    ...overrides,
  });

  it('changed_files além de 50 não recusa mais o report: quem decide o que mudou é o Git', () => {
    const files = Array.from({ length: 120 }, (_, index) => `src/mod${index}.py`);
    const parsed = AgentCompletionReport.parse(
      normalize(report({ changed_files: files })),
    );
    // Nenhum arquivo é cortado: cortar fabricaria divergência contra a
    // evidência derivada do Git em `compareReportWithEvidence`.
    expect(parsed.changed_files).toEqual(files);
  });

  it('coleções de opinião do report são normalizadas em vez de recusadas', () => {
    const parsed = AgentCompletionReport.parse(
      normalize(
        report({ decisions: Array.from({ length: 20 }, (_, index) => `d${index}`) }),
      ),
    );
    expect(parsed.decisions).toHaveLength(5);
  });

  it('relevant_files preserva cada path e toda a cardinalidade', () => {
    const paths = Array.from({ length: 30 }, (_, index) => `src/ref${index}.py`);
    const parsed = AgentCompletionReport.parse(
      normalize(report({ relevant_files: paths })),
    );
    expect(parsed.relevant_files).toEqual(paths);
  });

  it('candidate_commit inválido continua recusando o report', () => {
    expect(() =>
      AgentCompletionReport.parse(normalize(report({ candidate_commit: 'nope' }))),
    ).toThrow();
  });
});
