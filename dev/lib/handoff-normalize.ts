/**
 * TOLERÂNCIA A OPINIÃO DE WORKER, sem tocar em fato autoritativo.
 *
 * O HandoffDraft mistura duas coisas com autoridades opostas:
 *
 *  - IDENTIDADE/PROVENIÊNCIA — `schema_version`, `task_id`, `result` e a
 *    PRESENÇA de `what_i_did_not_check`. São contrato: o orquestrador decide
 *    o arquivo de destino pelo `task_id`, e ausência de `what_i_did_not_check`
 *    significa "o worker não respondeu à pergunta", que nunca é o mesmo que
 *    `[]`. Nada aqui é normalizado.
 *
 *  - OPINIÃO DESCRITIVA — `decisions`, `lessons`, `next_relevant_files`,
 *    `relevant_files`, `evidence[].claim`, `summary`. Não têm autoridade sobre
 *    nada: arquivos alterados vêm do Git, validação vem da execução oficial,
 *    identidade de candidate e base vêm do orquestrador, e aceitação vem da
 *    review. São conveniência de leitura, e só elas são cortadas aqui.
 *
 *  - INCERTEZA DECLARADA — `what_i_did_not_check`, `open_questions` e
 *    `confidence`. Também são opinião, mas cortá-las teria DIREÇÃO: esconder
 *    uma lacuna ou remover a hesitação de uma frase faz o trabalho parecer
 *    melhor do que é. Os tetos de conveniência delas saíram do schema em vez
 *    de serem aplicados aqui.
 *
 * O defeito que isto corrige: UM campo de opinião acima de um teto de
 * conveniência fazia `HandoffDraft.parse` lançar, `readHandoffDraft` devolver
 * `null` e o draft INTEIRO desaparecer — junto com todo o contexto útil que o
 * worker produziu. Um `claim` de 161 caracteres apagava `what_i_did_not_check`.
 *
 * A normalização é DETERMINÍSTICA e por campo: mesma entrada, mesma saída,
 * sem relógio, sem aleatoriedade, sem I/O. Ela não é um governor de tokens ou
 * bytes: não mede tamanho total nem recusa nada por volume.
 */

/** Marca visível de que a representação foi cortada; nunca silenciosa. */
export const TRUNCATION_MARK = '…[truncado]';

/** Sufixo visível quando itens de opinião excedentes foram descartados. */
export const CARDINALITY_MARK = (dropped: number): string =>
  `…[${dropped} item(ns) adicional(is) omitido(s)]`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Corta preservando o começo — que é onde o worker põe a afirmação — e deixa
 * a marca. Nunca produz string vazia a partir de conteúdo não vazio.
 */
function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const keep = Math.max(1, maximum - TRUNCATION_MARK.length);
  return `${value.slice(0, keep)}${TRUNCATION_MARK}`.slice(0, maximum);
}

function normalizedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return truncate(trimmed, maximum);
}

/**
 * Normaliza uma coleção de opinião: descarta itens inválidos, aplica o teto de
 * cardinalidade e registra a omissão no ÚLTIMO item mantido, para que o leitor
 * veja que houve corte em vez de acreditar que a lista está completa.
 */
function normalizedTextArray(
  value: unknown,
  maximumItems: number,
  maximumChars: number,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const kept: string[] = [];
  for (const item of value) {
    const text = normalizedText(item, maximumChars);
    if (text !== null) kept.push(text);
  }
  if (kept.length <= maximumItems) return kept;
  const truncatedList = kept.slice(0, maximumItems);
  const dropped = kept.length - maximumItems;
  const last = truncatedList[maximumItems - 1];
  if (last !== undefined) {
    truncatedList[maximumItems - 1] = `${last} ${CARDINALITY_MARK(dropped)}`;
  }
  return truncatedList;
}

/** Tetos de REPRESENTAÇÃO dos campos de opinião. Nenhum decide execução. */
const ADVISORY_TEXT_CHARS = 1_000;
const ADVISORY_CLAIM_CHARS = 160;
const ADVISORY_PATH_CHARS = 200;

/**
 * Coleções cuja cardinalidade pode ser reduzida sem mudar o SIGNIFICADO do
 * handoff: são atalhos de leitura para quem vai abrir o código de qualquer
 * jeito. A omissão é sempre declarada no último item mantido.
 *
 * `what_i_did_not_check` e `open_questions` NÃO estão aqui, e a ausência é a
 * regra inteira: descartar a sexta lacuna reconhecida ou a sexta pergunta em
 * aberto faria o trabalho parecer mais completo do que é. Normalização só pode
 * cortar o que não muda o significado — esconder incerteza muda. Os tetos
 * daqueles dois campos foram removidos do schema em vez de aplicados aqui.
 */
const ADVISORY_COLLECTIONS: readonly {
  readonly field: string;
  readonly maximumItems: number;
}[] = [
  { field: 'decisions', maximumItems: 5 },
  { field: 'lessons', maximumItems: 3 },
  { field: 'next_relevant_files', maximumItems: 5 },
  { field: 'relevant_files', maximumItems: 5 },
];

/**
 * Normaliza UMA referência de evidência.
 *
 * ESTRITA DE PROPÓSITO. Evidência é PONTEIRO, nunca payload: uma referência
 * que traz `content`, `diff`, `stdout` ou qualquer chave fora da forma do seu
 * `kind` é DESCARTADA inteira, jamais higienizada. Higienizar deixaria o
 * worker contrabandear payload e ainda ver a referência aceita, sem sinal
 * nenhum; descartar mantém a regra com dentes e ainda assim não derruba o
 * resto da nota. O mesmo vale para intervalo de linhas invertido e para `kind`
 * desconhecido.
 */
const EVIDENCE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  file: new Set(['kind', 'path', 'lines', 'claim']),
  command: new Set(['kind', 'argv', 'claim']),
  record: new Set(['kind', 'record_kind', 'task_id', 'attempt', 'claim']),
};

/** Mesma regra do schema: "N" ou "N-M" com N,M ≥ 1 e M ≥ N. */
function validLineRange(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9]\d*(-[1-9]\d*)?$/.test(value)) return false;
  const [start, end] = value.split('-').map(Number);
  return end === undefined || end >= (start as number);
}

function normalizedEvidence(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const kind = value['kind'];
  if (typeof kind !== 'string') return null;
  const allowed = EVIDENCE_KEYS[kind];
  if (allowed === undefined) return null;
  // Chave fora da forma do `kind` = tentativa de payload ou referência que só
  // parece tipada. Nos dois casos a referência inteira sai.
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return null;
  }
  const claim = normalizedText(value['claim'], ADVISORY_CLAIM_CHARS);
  if (claim === null) return null;
  switch (kind) {
    case 'file': {
      const filePath = normalizedText(value['path'], ADVISORY_PATH_CHARS);
      if (filePath === null) return null;
      if (value['lines'] !== undefined && !validLineRange(value['lines'])) return null;
      return {
        kind: 'file',
        path: filePath,
        ...(value['lines'] === undefined ? {} : { lines: value['lines'] }),
        claim,
      };
    }
    case 'command': {
      const argv = normalizedTextArray(value['argv'], 8, ADVISORY_TEXT_CHARS);
      if (argv === null || argv.length === 0) return null;
      return { kind: 'command', argv, claim };
    }
    case 'record': {
      if (typeof value['record_kind'] !== 'string' || typeof value['task_id'] !== 'string') {
        return null;
      }
      return {
        kind: 'record',
        record_kind: value['record_kind'],
        task_id: value['task_id'],
        ...(typeof value['attempt'] === 'number' ? { attempt: value['attempt'] } : {}),
        claim,
      };
    }
    default:
      return null;
  }
}


/**
 * Normaliza a REPRESENTAÇÃO dos campos de opinião de um handoff bruto.
 *
 * Entradas que não são objeto voltam intactas: quem valida forma é o schema,
 * não este módulo. Campos autoritativos — `schema_version`, `task_id`,
 * `result`, `changed_files`, `validations`, `accepted_commit`, `sealed_at` —
 * são copiados verbatim e NUNCA aparecem nas tabelas acima.
 */
export function normalizeHandoffOpinion(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const output: Record<string, unknown> = { ...input };

  for (const collection of ADVISORY_COLLECTIONS) {
    if (!(collection.field in output)) continue;
    const normalized = normalizedTextArray(
      output[collection.field],
      collection.maximumItems,
      ADVISORY_TEXT_CHARS,
    );
    if (normalized === null) continue;
    output[collection.field] = normalized;
  }

  if (Array.isArray(output['evidence'])) {
    const normalized = output['evidence']
      .map(normalizedEvidence)
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .slice(0, 8);
    output['evidence'] = normalized;
  }

  // `confidence` NÃO é truncada. O nível é DERIVADO dos marcadores presentes
  // no texto (`readHandoffConfidence`), então cortar a frase pode remover a
  // hesitação e elevar a confiança derivada — a normalização faria o worker
  // soar mais seguro do que ele disse. O teto saiu do schema em vez disso.
  if ('confidence' in output && typeof output['confidence'] === 'string') {
    const trimmed = output['confidence'].trim();
    // Presente e vazia é UNKNOWN de qualquer forma; remover evita derrubar a
    // nota por um campo que não afirma nada.
    if (trimmed.length === 0) delete output['confidence'];
    else output['confidence'] = trimmed;
  }

  if ('summary' in output) {
    const summary = normalizedText(output['summary'], ADVISORY_TEXT_CHARS);
    if (summary !== null) output['summary'] = summary;
  }

  return output;
}
