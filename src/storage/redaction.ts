/**
 * Redaction de secrets em strings, aplicada **antes** de qualquer persistência:
 * stdout, stderr e o stream do provider passam por aqui no caminho até o disco.
 * Não existe passagem de limpeza sobre `data/` depois — o que for escrito cru
 * fica cru.
 *
 * O placeholder é estável e não deriva do secret: dois valores do mesmo formato
 * viram exatamente o mesmo texto, de modo que nem o conteúdo, nem o tamanho,
 * nem um hash do segredo sobrevivem. Só o valor é substituído — prefixo, chave,
 * aspas e pontuação continuam na linha, senão o log redigido deixaria de servir
 * para depurar o run.
 *
 * Redigir é idempotente: reaplicar sobre um texto já redigido devolve o mesmo
 * texto, então uma linha pode passar por mais de uma fronteira sem virar
 * placeholder aninhado.
 *
 * Chamadores que capturam stream incremental devem redigir **linhas completas**:
 * um secret partido entre dois chunks não casa com nenhum formato e escaparia.
 */

/** Formato reconhecido; vira o rótulo do placeholder e não identifica o valor. */
export type RedactionKind =
  | 'anthropic-api-key'
  | 'openai-api-key'
  | 'github-token'
  | 'google-api-key'
  | 'slack-token'
  | 'aws-access-key-id'
  | 'jwt'
  | 'private-key'
  | 'bearer-token'
  | 'basic-auth'
  | 'url-password'
  /** Valor de uma chave sensível por nome, em formato não reconhecido. */
  | 'sensitive-value';

/** Placeholder sem formato conhecido, para quem redige só pelo nome da chave. */
export const REDACTED_PLACEHOLDER = '[REDACTED]';

const PLACEHOLDER_SOURCE = String.raw`\[REDACTED(?::[a-z0-9-]+)?\]`;
const PLACEHOLDER_PATTERN = new RegExp(`^${PLACEHOLDER_SOURCE}$`);
const PLACEHOLDER_PREFIX_PATTERN = new RegExp(`^${PLACEHOLDER_SOURCE}`);

/**
 * Nomes cujo valor é segredo independentemente do formato. Comparados por
 * segmento (`api_key`, `apiKey` e `API-KEY` dão os mesmos segmentos), para que
 * `AUTHOR` ou `pass_rate` não sejam confundidos com `AUTH` ou `PASSWORD`.
 */
const SENSITIVE_NAME_SEGMENTS: ReadonlySet<string> = new Set([
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'key',
  'keys',
  'passphrase',
  'passwd',
  'password',
  'pat',
  'secret',
  'secrets',
  'session',
  'sessions',
  'signature',
  'token',
  'tokens',
]);

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

/**
 * Ordem importa: os formatos conhecidos vêm antes da regra por nome de chave,
 * para que `ANTHROPIC_API_KEY=sk-ant-...` conserve o rótulo mais específico.
 */
const RULES: readonly RedactionRule[] = [
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => redactionPlaceholder('private-key'),
  },
  {
    pattern: /\bsk-ant-[A-Za-z0-9_-]{12,}/g,
    replace: () => redactionPlaceholder('anthropic-api-key'),
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replace: () => redactionPlaceholder('openai-api-key'),
  },
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
    replace: () => redactionPlaceholder('github-token'),
  },
  {
    pattern: /\bAIza[A-Za-z0-9_-]{16,}\b/g,
    replace: () => redactionPlaceholder('google-api-key'),
  },
  {
    pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
    replace: () => redactionPlaceholder('slack-token'),
  },
  {
    pattern: /\b(?:AKIA|ASIA|AROA|AIDA|AIPA|ANPA|ANVA|ABIA|ACCA|AGPA)[A-Z0-9]{16}\b/g,
    replace: () => redactionPlaceholder('aws-access-key-id'),
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => redactionPlaceholder('jwt'),
  },
  {
    // Só a senha do userinfo é segredo: esquema, usuário e host continuam
    // legíveis, que é o que identifica o endpoint no log. O lookbehind impede
    // que o esquema seja procurado dentro de uma palavra — sem ele, uma linha
    // longa sem `://` é varrida uma vez por caractere.
    pattern: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]+)(@)/g,
    replace: (_match, prefix, _password, at) =>
      `${prefix}${redactionPlaceholder('url-password')}${at}`,
  },
  {
    pattern: /\b(Bearer|Basic|Token|Digest)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_match, scheme, space) =>
      `${scheme}${space}${redactionPlaceholder(
        scheme.toLowerCase() === 'basic' ? 'basic-auth' : 'bearer-token',
      )}`,
  },
];

/**
 * `nome: valor`, `nome=valor` e `"nome": "valor"`. O esquema de auth, quando
 * presente, fica fora do valor para não virar ele próprio o placeholder.
 *
 * O lookbehind exige que o nome comece de fato um identificador: sem ele o
 * motor tentaria casar a partir de cada caractere de uma palavra longa, e uma
 * linha de log grande custaria tempo quadrático.
 */
const ASSIGNMENT_PATTERN =
  /(?<![A-Za-z0-9_.-])([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)((?:Bearer|Basic|Token|Digest)\s+|)("[^"\n]*"|'[^'\n]*'|[^\s]+)/gi;

/** Pontuação que fecha o contexto em volta do valor e não faz parte dele. */
const VALUE_TRAILING_PUNCTUATION = /["'),;\]}]+$/;

/** Placeholder de um formato. Depende só do formato, nunca do valor. */
export function redactionPlaceholder(kind: RedactionKind): string {
  return `[REDACTED:${kind}]`;
}

/** Verdadeiro quando o valor inteiro já é um placeholder desta redaction. */
export function isRedactionPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

/**
 * Nome de chave cujo valor é segredo mesmo em formato desconhecido. Exportado
 * porque a redaction estruturada precisa da mesma regra — duas cópias dela
 * poderiam divergir e deixar um campo passar.
 */
export function isSensitiveKeyName(name: string): boolean {
  return splitNameSegments(name).some((segment) => SENSITIVE_NAME_SEGMENTS.has(segment));
}

/** Redige todos os secrets reconhecidos, preservando o resto do texto. */
export function redactString(value: string): string {
  let redacted = value;
  for (const rule of RULES) {
    redacted = redacted.replace(rule.pattern, rule.replace);
  }
  return redactSensitiveAssignments(redacted);
}

/** Verdadeiro quando ainda há algo a redigir — usado para provar zero vazamento. */
export function containsSecret(value: string): boolean {
  return redactString(value) !== value;
}

/**
 * Redige o valor de toda atribuição cujo nome é sensível.
 *
 * A varredura é feita à mão porque um `replace` global consumiria o valor de
 * uma atribuição não sensível inteira — e `provider: {"password":"x"}` esconde
 * uma atribuição sensível dentro desse valor. Quando o nome não é sensível, a
 * busca recomeça logo depois do nome, em vez de pular o valor.
 */
function redactSensitiveAssignments(text: string): string {
  ASSIGNMENT_PATTERN.lastIndex = 0;
  let redacted = '';
  let copiedUpTo = 0;
  let match: RegExpExecArray | null;

  while ((match = ASSIGNMENT_PATTERN.exec(text)) !== null) {
    const [whole = '', name = '', separator = '', scheme = '', value = ''] = match;

    if (!isSensitiveKeyName(name)) {
      ASSIGNMENT_PATTERN.lastIndex = match.index + name.length;
      continue;
    }

    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
    const bare = quote === '' ? value : value.slice(1, -1);
    // Valor vazio não é segredo; um que já começa com placeholder conserva o
    // rótulo mais específico que uma regra de formato lhe deu.
    if (bare === '' || PLACEHOLDER_PREFIX_PATTERN.test(bare)) continue;

    // Sem aspas o valor vai até o próximo espaço e arrasta a pontuação que
    // fecha o contexto em volta — devolvê-la mantém a linha bem formada.
    const suffix = quote === '' ? (VALUE_TRAILING_PUNCTUATION.exec(bare)?.[0] ?? '') : '';
    const secret = bare.slice(0, bare.length - suffix.length);
    if (secret === '') continue;

    const placeholder = `${quote}${redactionPlaceholder('sensitive-value')}${quote}${suffix}`;
    redacted += text.slice(copiedUpTo, match.index) + name + separator + scheme + placeholder;
    copiedUpTo = match.index + whole.length;
  }

  return redacted + text.slice(copiedUpTo);
}

function splitNameSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment !== '');
}
