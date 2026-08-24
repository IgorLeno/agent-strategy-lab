import type { HumanGatedCapability } from './index.js';

/**
 * Classifica INTENÇÃO a partir do texto humano. Isto NÃO autoriza nada:
 * só nomeia categorias human-gated que o pedido implica. A policy decide
 * se a categoria exige gate.
 *
 * Invariante central: PROHIBITION != REQUEST. Uma Run Directive realista
 * cita ações perigosas para PROIBI-LAS ("no force push", "não fazer deploy",
 * "never use an API key"). A mera presença lexical da ação não é pedido.
 * A classificação continua determinística, local e sem inferência paga:
 * o texto é segmentado em cláusulas e uma cláusula que contém um marcador
 * de negação/proibição (PT ou EN) é tratada como restrição, nunca como
 * pedido positivo. Pedidos afirmativos continuam detectados.
 */

/**
 * Marcadores de negação/proibição, PT e EN, avaliados NO ESCOPO DA CLÁUSULA
 * (linha ou sentença). Deliberadamente amplos: falso negativo aqui significa
 * apenas que um pedido embutido numa frase negada não gera gate lexical — a
 * autorização estruturada continua sendo a única fonte de permissão, então o
 * erro é conservador do lado do produto.
 */
const NEGATION_CLAUSE =
  /(?:\b(?:no|not|never|don'?t|do not|does not|doesn'?t|avoid|without|forbidden|prohibited|must not|mustn'?t|cannot|can'?t|shall not|shouldn'?t|should not|ban(?:ned)?|não|nao|nunca|jamais|sem|proibid[oa]s?|evit(?:e|ar|ando)|ved(?:a|ado|ada))\b|\bnem\b)/i;

interface LexicalCategory {
  readonly capability: HumanGatedCapability;
  readonly patterns: readonly RegExp[];
  /**
   * `publish`: a intenção correspondente é publicar no remoto/ref concedido
   * pelo header estruturado (`authorization.publish`). Quando o grant existe,
   * a intenção afirmativa está coberta por autorização explícita e não gera
   * gate; sem grant, permanece EXTERNAL_SIDE_EFFECT.
   */
  readonly satisfiable_by: 'publish' | null;
}

const CATEGORIES: readonly LexicalCategory[] = [
  {
    capability: 'DEPLOYMENT_OR_PRODUCTION',
    patterns: [
      /\bdeploy(?:ment|ing|ed|ar|e)?\b.{0,80}\b(?:production|prod|produção|producao)\b/i,
      /\b(?:production|prod|produção|producao)\b.{0,80}\bdeploy(?:ment|ing|ed|ar|e)?\b/i,
      /\bdeploy this (?:application|app|service|system)\b/i,
      /\b(?:fazer|faça|realize|realizar) (?:o )?deploy\b/i,
    ],
    satisfiable_by: null,
  },
  {
    capability: 'DESTRUCTIVE_ACTION',
    patterns: [
      /\brm\s+-rf\b/i,
      /\bwipe (?:the )?repo\b/i,
      /\bdelete everything\b/i,
      /\bdestroy (?:the )?(?:database|cluster)\b/i,
      /\bforce[- ]push\b/i,
      /\b(?:apague|apagar|delete|deletar) tudo\b/i,
      /\b(?:destrua|destruir) (?:o |a )?(?:banco|base de dados|cluster)\b/i,
      /\b(?:push|atualização|atualizacao) forçad[oa]\b/i,
    ],
    satisfiable_by: null,
  },
  {
    capability: 'EXTERNAL_SIDE_EFFECT',
    patterns: [
      /\bgit push\b/i,
      /\bpush (?:to|para) (?:o )?origin\b/i,
      /\bpush (?:normal )?(?:to|para) origin\/\S+/i,
    ],
    satisfiable_by: 'publish',
  },
  {
    capability: 'EXTERNAL_SIDE_EFFECT',
    patterns: [
      /\bpublish to (?:npm|pypi)\b/i,
      /\bpublicar no (?:npm|pypi)\b/i,
      /\bsend (?:this )?email\b/i,
      /\b(?:envie|enviar) (?:este |esse |um )?e?-?mail\b/i,
    ],
    satisfiable_by: null,
  },
  {
    capability: 'UNAUTHORIZED_API_BILLING',
    patterns: [
      /\buse (?:an? )?api key\b/i,
      /\banthropic_api_key\b/i,
      /--api-key\b/i,
      /\b(?:disable|ignore) billing\b/i,
      /\bcharge (?:the )?api\b/i,
      /\b(?:use|usar|utilize) (?:uma? )?(?:chave de api|api key)\b/i,
      /\b(?:desabilite|desabilitar|ignore|ignorar) (?:o )?billing\b/i,
    ],
    satisfiable_by: null,
  },
  {
    capability: 'NEW_CREDENTIAL_BOUNDARY',
    patterns: [
      /\buse (?:my )?(?:api key|access token)\b/i,
      /\b(?:disable|bypass) sandbox\b/i,
      /\b(?:use|usar) (?:meu |minha )?(?:access token|token de acesso)\b/i,
      /\b(?:desabilite|desabilitar|burle|burlar) (?:o )?sandbox\b/i,
    ],
    satisfiable_by: null,
  },
];

/**
 * Cláusulas: quebras de linha e pontuação de sentença. Um item de lista
 * ("- no force push.") vira cláusula própria, então a negação dele nunca
 * vaza para a cláusula vizinha nem é diluída por ela.
 */
function splitClauses(text: string): string[] {
  return text
    .split(/[\n;]|(?<=[.!?])\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

export interface ImpliedGateMatch {
  readonly capability: HumanGatedCapability;
  /** Cláusula que evidencia a intenção afirmativa (nunca uma cláusula negada). */
  readonly evidence: string;
  readonly satisfiable_by: 'publish' | null;
}

/** Classificação detalhada: capability + evidência + como o header poderia satisfazê-la. */
export function classifyImpliedHumanGatedMatches(rawInstruction: string): readonly ImpliedGateMatch[] {
  const clauses = splitClauses(rawInstruction);
  const matches: ImpliedGateMatch[] = [];
  for (const category of CATEGORIES) {
    for (const clause of clauses) {
      if (NEGATION_CLAUSE.test(clause)) continue;
      if (!category.patterns.some((pattern) => pattern.test(clause))) continue;
      matches.push({
        capability: category.capability,
        evidence: clause.length > 200 ? `${clause.slice(0, 200)}…` : clause,
        satisfiable_by: category.satisfiable_by,
      });
      break;
    }
  }
  return matches;
}

export function classifyImpliedHumanGated(rawInstruction: string): readonly HumanGatedCapability[] {
  return [...new Set(classifyImpliedHumanGatedMatches(rawInstruction).map((match) => match.capability))];
}
