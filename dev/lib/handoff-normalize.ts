/**
 * TOLERÂNCIA A OPINIÃO DE WORKER, sem tocar em identidade nem fato
 * autoritativo.
 *
 * Cada campo que este módulo conhece escolhe uma classe semântica explícita:
 *
 * - DESCRIPTIVE_PROSE pode ter representação encurtada, sempre visível;
 * - DECLARED_UNCERTAINTY fica intacta, porque um corte pode esconder lacunas;
 * - POINTER_IDENTITY é preservado byte a byte ou descartado como referência
 *   inválida completa;
 * - AUTHORITATIVE_FACT fica intacto e continua sob o parser/gate proprietário.
 *
 * O último rótulo também cobre discriminantes e alegações factuais do
 * protocolo que este normalizador não tem autoridade para reescrever. No
 * record selado, Git, validação oficial e orquestrador continuam sendo as
 * fontes dos fatos autoritativos.
 */

export type HandoffFieldSemanticClass =
  | 'DESCRIPTIVE_PROSE'
  | 'DECLARED_UNCERTAINTY'
  | 'POINTER_IDENTITY'
  | 'AUTHORITATIVE_FACT';

/**
 * Inventário mecânico dos campos conhecidos por esta fronteira. Configurar um
 * novo campo para normalização exige primeiro escolher sua classe aqui.
 */
export const HANDOFF_FIELD_TAXONOMY = {
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
} as const satisfies Readonly<Record<string, HandoffFieldSemanticClass>>;

type FieldOfClass<Class extends HandoffFieldSemanticClass> = {
  [Field in keyof typeof HANDOFF_FIELD_TAXONOMY]: (typeof HANDOFF_FIELD_TAXONOMY)[Field] extends Class
    ? Field
    : never;
}[keyof typeof HANDOFF_FIELD_TAXONOMY];

interface CanonicalParser<Value> {
  safeParse(input: unknown):
    | { readonly success: true; readonly data: Value }
    | { readonly success: false };
}

export interface HandoffNormalizationSchemas {
  readonly pointerIdentity: CanonicalParser<string>;
  readonly evidenceReference: CanonicalParser<Record<string, unknown>>;
}

/** Marca visível de que a representação foi cortada; nunca silenciosa. */
export const TRUNCATION_MARK = '…[truncado]';

/** Sufixo visível quando itens de prosa excedentes foram descartados. */
export const CARDINALITY_MARK = (dropped: number): string =>
  `…[${dropped} item(ns) adicional(is) omitido(s)]`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Encurta somente representação textual, preservando uma marca explícita. */
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
 * Normaliza coleção de prosa. O marcador deixa claro que a representação não
 * é completa; nenhum item daqui participa de identidade ou decisão de
 * execução.
 */
function normalizedDescriptiveArray(
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

/**
 * Valida cada ponteiro pela MESMA primitive usada pelo schema final. O parser
 * não tem transform: um valor que sobrevive é byte-idêntico ao original.
 */
function preservedPointerArray(
  value: unknown,
  parser: CanonicalParser<string>,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const preserved: string[] = [];
  for (const item of value) {
    const parsed = parser.safeParse(item);
    if (parsed.success) preserved.push(parsed.data);
  }
  return preserved;
}

/** Tetos de representação de prosa; não são budgets de protocolo. */
const ADVISORY_TEXT_CHARS = 1_000;
const ADVISORY_CLAIM_CHARS = 160;

const DESCRIPTIVE_PROSE_COLLECTIONS = [
  { field: 'decisions', maximumItems: 5 },
  { field: 'lessons', maximumItems: 3 },
] as const satisfies readonly {
  readonly field: FieldOfClass<'DESCRIPTIVE_PROSE'>;
  readonly maximumItems: number;
}[];

const POINTER_IDENTITY_COLLECTIONS = [
  'next_relevant_files',
  'relevant_files',
] as const satisfies readonly FieldOfClass<'POINTER_IDENTITY'>[];

/**
 * Encurta SOMENTE `claim`, então entrega a referência inteira ao parser
 * canônico. Qualquer path, argv, record_kind, task_id, attempt, lines ou chave
 * extra inválida faz a referência completa desaparecer; nenhum validador
 * aproximado existe aqui.
 */
function normalizedEvidence(
  value: unknown,
  parser: CanonicalParser<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const claim = normalizedText(value['claim'], ADVISORY_CLAIM_CHARS);
  if (claim === null) return null;
  const parsed = parser.safeParse({ ...value, claim });
  return parsed.success ? parsed.data : null;
}

/**
 * Normaliza somente a representação não autoritativa de report/handoff.
 * Campos desconhecidos e campos autoritativos são copiados verbatim para que
 * o schema proprietário continue decidindo se são válidos.
 */
export function normalizeHandoffOpinion(
  input: unknown,
  schemas: HandoffNormalizationSchemas,
): unknown {
  if (!isRecord(input)) return input;
  const output: Record<string, unknown> = { ...input };

  for (const collection of DESCRIPTIVE_PROSE_COLLECTIONS) {
    if (!(collection.field in output)) continue;
    const normalized = normalizedDescriptiveArray(
      output[collection.field],
      collection.maximumItems,
      ADVISORY_TEXT_CHARS,
    );
    if (normalized !== null) output[collection.field] = normalized;
  }

  for (const field of POINTER_IDENTITY_COLLECTIONS) {
    if (!(field in output)) continue;
    const preserved = preservedPointerArray(output[field], schemas.pointerIdentity);
    if (preserved !== null) output[field] = preserved;
  }

  if (Array.isArray(output['evidence'])) {
    output['evidence'] = output['evidence']
      .map((entry) => normalizedEvidence(entry, schemas.evidenceReference))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }

  if ('summary' in output) {
    const summary = normalizedText(output['summary'], ADVISORY_TEXT_CHARS);
    if (summary !== null) output['summary'] = summary;
  }

  // DECLARED_UNCERTAINTY e AUTHORITATIVE_FACT permanecem exatamente como
  // chegaram. Qualquer invalidade continua sob o schema/gate proprietário.
  return output;
}
