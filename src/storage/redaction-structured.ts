/**
 * Redaction recursiva sobre estruturas — objetos, arrays e mapas de variáveis
 * de ambiente — na mesma fronteira de `redactString`: **antes** da persistência.
 *
 * A forma é preservada: objeto continua objeto, array continua array, toda
 * chave continua no lugar e na ordem em que estava. Só o valor é substituído.
 * Um record redigido continua servindo para depurar o run e continua batendo
 * com o schema que o descreve, que é o que um blob `[REDACTED]` no lugar do
 * objeto inteiro perderia.
 *
 * Sensibilidade é herdada pela subárvore: sob uma chave sensível por nome,
 * todo escalar abaixo é redigido, por mais fundo que esteja. Sem a herança,
 * `{"credentials":{"alias":"..."}}` vazaria — `alias` não é sensível por nome
 * e o valor pode não bater com nenhum formato conhecido.
 *
 * Nada aqui lança: a redaction está no caminho de escrita de todo run, e falhar
 * fechado (redigir a mais) é preferível a abortar a execução ou a deixar passar.
 */

import type { JsonValue } from '../core/index.js';
import {
  isRedactionPlaceholder,
  isSensitiveKeyName,
  redactString,
  redactionPlaceholder,
  REDACTED_PLACEHOLDER,
} from './redaction.js';

/**
 * Profundidade máxima percorrida. Existe pela entrada patológica, não pelo JSON
 * legítimo: um objeto vindo do stream de um provider pode ter ciclo, e sem o
 * limite a recursão travaria o run em vez de persistir a linha.
 */
const MAX_STRUCTURE_DEPTH = 64;

/** O que aconteceu com uma variável de ambiente na saída redigida. */
export type EnvironmentDisposition = 'kept' | 'redacted' | 'omitted';

/** Por que a variável recebeu a disposição — o registro do que foi retido. */
export type EnvironmentRedactionReason =
  /** Está na allowlist e o valor não continha nada a redigir. */
  | 'allowlisted'
  /** Fora da allowlist do EnvironmentProfile: o valor nunca é persistido. */
  | 'not-allowlisted'
  /** Nome sensível: valor redigido mesmo em formato desconhecido. */
  | 'sensitive-name'
  /** Um formato conhecido foi reconhecido dentro do valor. */
  | 'secret-in-value';

export interface EnvironmentVariableRecord {
  readonly name: string;
  readonly disposition: EnvironmentDisposition;
  readonly reason: EnvironmentRedactionReason;
}

export interface RedactedEnvironment {
  /** Mapa redigido, sem as variáveis omitidas. */
  readonly env: Readonly<Record<string, string>>;
  /** Toda variável recebida, inclusive as omitidas, ordenada por nome. */
  readonly records: readonly EnvironmentVariableRecord[];
}

export interface EnvironmentRedactionOptions {
  /** `env_allowlist` do EnvironmentProfile do run: os nomes cujo valor pode ser persistido. */
  readonly allowlist: Iterable<string>;
  /**
   * O que fazer com o que está fora da allowlist. `redact` mantém o nome com
   * placeholder no lugar do valor; `omit` tira a variável do mapa. Nos dois
   * casos o nome fica em `records` — omitir sem registrar esconderia do
   * relatório que o ambiente tinha mais coisa do que o perfil declara.
   */
  readonly unlisted?: 'redact' | 'omit';
}

/**
 * Redige um valor JSON recursivamente, preservando forma, chaves e ordem.
 *
 * `null` e booleano atravessam intactos: não carregam conteúdo que possa ser
 * um segredo, e mantê-los conserva a leitura do record. Número sob chave
 * sensível vira placeholder — um PIN ou um id numérico de sessão é segredo,
 * e a forma que importa preservar é a da estrutura, não a do escalar.
 */
export function redactJsonValue(value: JsonValue): JsonValue {
  return redactNode(value, false, 0);
}

/**
 * Redige um mapa de variáveis de ambiente contra a allowlist do
 * EnvironmentProfile. Estar na allowlist significa que o perfil registrou a
 * variável, não que o valor seja público: nome sensível e formato conhecido
 * continuam sendo redigidos dentro da allowlist.
 *
 * A saída é ordenada por nome para que o mesmo ambiente produza sempre os
 * mesmos bytes — o mapa entra em manifest e em envelope, onde a ordem das
 * chaves não pode virar diferença de hash.
 */
export function redactEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: EnvironmentRedactionOptions,
): RedactedEnvironment {
  const allowlist = new Set(options.allowlist);
  const unlisted = options.unlisted ?? 'redact';
  const redactedEnv: Record<string, string> = {};
  const records: EnvironmentVariableRecord[] = [];

  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    // Variável sem valor não está definida no processo: não há o que registrar.
    if (value === undefined) continue;

    if (!allowlist.has(name)) {
      if (unlisted === 'omit') {
        records.push({ name, disposition: 'omitted', reason: 'not-allowlisted' });
        continue;
      }
      redactedEnv[name] = REDACTED_PLACEHOLDER;
      records.push({ name, disposition: 'redacted', reason: 'not-allowlisted' });
      continue;
    }

    const sensitiveName = isSensitiveKeyName(name);
    const redacted = redactLeafString(value, sensitiveName);
    redactedEnv[name] = redacted;
    records.push(
      redacted === value
        ? { name, disposition: 'kept', reason: 'allowlisted' }
        : {
            name,
            disposition: 'redacted',
            reason: sensitiveName ? 'sensitive-name' : 'secret-in-value',
          },
    );
  }

  return { env: redactedEnv, records };
}

function redactNode(value: JsonValue, sensitive: boolean, depth: number): JsonValue {
  if (depth > MAX_STRUCTURE_DEPTH) return REDACTED_PLACEHOLDER;

  if (Array.isArray(value)) {
    return value.map((item) => redactNode(item, sensitive, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = redactNode(item, sensitive || isSensitiveKeyName(key), depth + 1);
    }
    return redacted;
  }

  if (typeof value === 'string') return redactLeafString(value, sensitive);
  if (typeof value === 'number') return sensitive ? redactionPlaceholder('sensitive-value') : value;
  return value;
}

/**
 * Regra única para todo escalar de texto — a mesma para campo de objeto e para
 * variável de ambiente, para que as duas fronteiras não possam divergir.
 *
 * Sob chave sensível, o valor só sobrevive quando é inteiro um placeholder:
 * aí uma regra de formato já o cobriu e o rótulo dela é mais específico.
 * Qualquer resíduo em volta faz o valor inteiro virar placeholder — perder o
 * prefixo custa contexto, deixar passar custa o segredo.
 */
function redactLeafString(value: string, sensitive: boolean): string {
  const redacted = redactString(value);
  if (!sensitive || redacted === '' || isRedactionPlaceholder(redacted)) return redacted;
  return redactionPlaceholder('sensitive-value');
}
