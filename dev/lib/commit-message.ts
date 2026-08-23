/**
 * Derivação BOUNDED da mensagem de commit de uma work unit planejada.
 *
 * A classe de falha que este módulo elimina: o harness reusava um CAMPO
 * SEMÂNTICO (`PlanTask.title`, que existe para explicar o trabalho)
 * DIRETAMENTE como ARTEFATO OPERACIONAL (o subject do commit, que tem budget
 * de `MAX_COMMIT_MESSAGE_BYTES`). Os dois contratos nunca prometeram o mesmo
 * tamanho, então um plano semanticamente válido — aprovado nos gates do
 * planner — tornava a finalização IMPOSSÍVEL: `CommitMessage.parse` estourava
 * dentro do finalizer DEPOIS de o worker já ter feito o trabalho.
 *
 * REGRA: campo semântico não vira artefato bounded por reuso direto; vira por
 * DERIVAÇÃO determinística e TOTAL. `title` e `objective` seguem ilimitados;
 * quem tem budget é a representação derivada.
 *
 * A derivação é pura: não conhece provider, filesystem nem modelo, e não
 * altera o `PlanTask`. O mesmo `PlanTask` produz sempre a mesma mensagem em
 * qualquer caminho de finalização (normal, revalidação, recovery) — é isso que
 * mantém `assertCandidate` uma guarda útil em vez de uma fonte de drift.
 */

import type { TaskTaxonomy } from '../../src/schemas/task-spec.js';

import { sha256Hex } from './canonical.js';
import { CommitMessage, MAX_COMMIT_MESSAGE_BYTES, type PlanTask } from './schemas.js';

/**
 * Conventional commit type por `task_class`. Planos GERADOS trazem
 * `planner_metadata`; PlanFiles manuais/históricos não trazem e continuam no
 * fallback compatível (`feat`) — ausência de metadata nunca é erro.
 */
const COMMIT_TYPE_BY_TASK_CLASS = {
  bugfix: 'fix',
  feature: 'feat',
  refactor: 'refactor',
  test: 'test',
  docs: 'docs',
  chore: 'chore',
} as const satisfies Record<TaskTaxonomy['task_class'], string>;

const DEFAULT_COMMIT_TYPE = 'feat';

/**
 * Teto do scope. `PlanTask.id` é um identifier SEM tamanho máximo: os ids de
 * hoje serem curtos é acidente do plano atual, não contrato. Um id enorme não
 * pode consumir o budget inteiro e deixar a work unit sem mensagem possível.
 */
const MAX_SCOPE_BYTES = 48;

/** Marcador de truncamento: 3 bytes em UTF-8, curto o bastante para caber sempre. */
const ELLIPSIS = '…';

/** Summary de último recurso: nunca vazio, uma linha, ASCII. */
const FALLBACK_SUMMARY = 'planned work';

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Trunca por BYTES UTF-8, nunca por `slice(0, n)`: `title` e `objective`
 * carregam acento, cedilha e símbolo Unicode, e cortar por índice de UTF-16
 * produz byte count errado. A iteração é por CODE POINT (`for...of`), então
 * nenhuma sequência UTF-8 — nem par surrogate — é partida ao meio.
 */
function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const budget = maxBytes - byteLength(ELLIPSIS);
  if (budget <= 0) return '';
  let kept = '';
  let used = 0;
  for (const codePoint of text) {
    const size = byteLength(codePoint);
    if (used + size > budget) break;
    kept += codePoint;
    used += size;
  }
  const trimmed = kept.trimEnd();
  return trimmed === '' ? '' : `${trimmed}${ELLIPSIS}`;
}

/**
 * Colapsa CR/LF, tab e espaço repetido numa única linha. O commit subject é
 * mono-linha por contrato; o campo semântico de origem não é.
 */
function singleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Sufixo curto e estável que mantém a mensagem vinculada à task quando o id não cabe. */
function idDigest(taskId: string): string {
  return sha256Hex(taskId).slice(0, 8);
}

/**
 * Scope legível quando o id cabe; prefixo legível + hash estável quando não
 * cabe. Continua determinístico e continua identificando a work unit.
 */
function boundedScope(taskId: string): string {
  if (byteLength(taskId) <= MAX_SCOPE_BYTES) return taskId;
  const digest = idDigest(taskId);
  const keep = MAX_SCOPE_BYTES - digest.length - 1;
  let prefix = '';
  let used = 0;
  for (const codePoint of taskId) {
    const size = byteLength(codePoint);
    if (used + size > keep) break;
    prefix += codePoint;
    used += size;
  }
  return `${prefix}-${digest}`;
}

function commitTypeFor(task: PlanTask): string {
  const taskClass = task.planner_metadata?.taxonomy.task_class;
  if (taskClass === undefined) return DEFAULT_COMMIT_TYPE;
  return COMMIT_TYPE_BY_TASK_CLASS[taskClass] ?? DEFAULT_COMMIT_TYPE;
}

/**
 * Deriva o subject de commit de uma work unit planejada.
 *
 * TOTAL: para qualquer `PlanTask` válido — id enorme, title de milhares de
 * bytes, texto Unicode, whitespace multilinha — devolve uma mensagem que
 * satisfaz `CommitMessage`. O caminho normal produz
 * `<type>(<id>): <summary legível>`; só um id patológico degrada para o
 * fallback `<type>(task-<hash>): planned work`, que é provadamente válido
 * (ASCII, uma linha, muito abaixo do budget).
 */
export function deriveCommitMessage(task: PlanTask): string {
  const type = commitTypeFor(task);
  const scope = boundedScope(task.id);
  const prefix = `${type}(${scope}): `;
  const source = singleLine(task.title) || singleLine(task.objective);
  const summary = truncateToBytes(source, MAX_COMMIT_MESSAGE_BYTES - byteLength(prefix));
  const message = summary === '' ? `${prefix}${FALLBACK_SUMMARY}` : `${prefix}${summary}`;
  if (CommitMessage.safeParse(message).success) return message;
  return `${type}(task-${idDigest(task.id)}): ${FALLBACK_SUMMARY}`;
}
