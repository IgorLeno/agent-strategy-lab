/**
 * LEITURA DE CREDENCIAL PARA PROBE DE QUOTA.
 *
 * Regra única e absoluta deste arquivo: o material da credencial existe apenas
 * como valor em memória, entregue direto ao header da requisição. Ele não é
 * devolvido em nenhum tipo público, não entra em record, não entra em log e
 * não entra em mensagem de erro.
 *
 * O que SAI daqui é: presença (sim/não), o motivo quando não, e — quando a
 * comparação de identidade de conta é necessária — um FINGERPRINT não
 * reversível. O `account_id` cru nunca é persistido: o Lab precisa saber se
 * dois scaffolds falam com a MESMA conta, e para isso a igualdade de dois
 * digests basta.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Sal fixo e versionado. Ele não protege contra um atacante com o binário —
 * não é esse o objetivo. Ele impede que o digest de uma conta gravado neste
 * repositório seja cruzado com o digest da mesma conta em qualquer outro
 * sistema que use sha256 puro.
 */
const FINGERPRINT_SALT = 'agentlab-account-fingerprint-v1';

/** Digest curto e não reversível. Serve para IGUALDADE, nunca para identificar. */
export function accountFingerprint(accountId: string): string {
  return createHash('sha256')
    .update(`${FINGERPRINT_SALT}:${accountId}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export interface CredentialPaths {
  readonly codexAuthFile: string;
  readonly opencodeAuthFile: string;
}

export function defaultCredentialPaths(home: string = os.homedir()): CredentialPaths {
  return {
    codexAuthFile: path.join(home, '.codex', 'auth.json'),
    opencodeAuthFile: path.join(home, '.local', 'share', 'opencode', 'auth.json'),
  };
}

/**
 * Credencial pronta para uso, com o segredo FECHADO dentro do objeto. Quem
 * recebe pode aplicá-la a uma requisição; não pode lê-la, imprimi-la nem
 * serializá-la — `toJSON` devolve o rótulo, não o material.
 */
export class SealedCredential {
  readonly #apply: (headers: Record<string, string>) => void;
  readonly label: string;
  /** Fingerprint da conta quando a credencial identifica uma; `null` quando não. */
  readonly accountFingerprint: string | null;

  constructor(input: {
    readonly label: string;
    readonly accountFingerprint: string | null;
    readonly apply: (headers: Record<string, string>) => void;
  }) {
    this.label = input.label;
    this.accountFingerprint = input.accountFingerprint;
    this.#apply = input.apply;
  }

  headers(base: Readonly<Record<string, string>> = {}): Record<string, string> {
    const headers = { ...base };
    this.#apply(headers);
    return headers;
  }

  /** Serialização deliberadamente inócua: nenhum caminho de log vaza segredo. */
  toJSON(): { readonly credential: string; readonly account_fingerprint: string | null } {
    return { credential: this.label, account_fingerprint: this.accountFingerprint };
  }

  toString(): string {
    return `SealedCredential(${this.label})`;
  }
}

export type CredentialLookup =
  | { readonly present: true; readonly credential: SealedCredential }
  | { readonly present: false; readonly reason: string };

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Ausente, ilegível ou não-JSON. O motivo textual é dado por quem chama,
    // sem repetir conteúdo do arquivo.
    return null;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function nested(record: Record<string, unknown> | null, key: string): Record<string, unknown> | undefined {
  const value = record?.[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Credencial OAuth do ChatGPT a partir do Codex — a fonte PREFERIDA para o
 * pool `openai_chatgpt_subscription`, porque é a que o Lab já usa para executar.
 */
export async function loadCodexChatGptCredential(
  paths: CredentialPaths = defaultCredentialPaths(),
): Promise<CredentialLookup> {
  const auth = await readJson(paths.codexAuthFile);
  if (auth === null) {
    return { present: false, reason: 'auth do Codex ausente ou ilegível' };
  }
  if (stringField(auth, 'auth_mode') !== 'chatgpt') {
    return { present: false, reason: 'auth do Codex não está em modo ChatGPT' };
  }
  const tokens = nested(auth, 'tokens');
  const access = stringField(tokens, 'access_token');
  const account = stringField(tokens, 'account_id');
  if (access === null || account === null) {
    return { present: false, reason: 'auth do Codex sem access token ou conta ChatGPT' };
  }
  return {
    present: true,
    credential: new SealedCredential({
      label: 'codex_chatgpt_oauth',
      accountFingerprint: accountFingerprint(account),
      apply: (headers) => {
        headers['authorization'] = `Bearer ${access}`;
        headers['chatgpt-account-id'] = account;
      },
    }),
  };
}

/**
 * Credencial OAuth do ChatGPT a partir do OpenCode. É FALLBACK, e só vale como
 * observador do mesmo pool quando o fingerprint bate com o do Codex — dois
 * OAuths de contas diferentes observam franquias diferentes, e tratá-los como
 * um só inventaria capacidade.
 */
export async function loadOpenCodeOpenAiCredential(
  paths: CredentialPaths = defaultCredentialPaths(),
): Promise<CredentialLookup> {
  const auth = await readJson(paths.opencodeAuthFile);
  const entry = nested(auth, 'openai');
  if (entry === undefined) {
    return { present: false, reason: 'auth do OpenCode sem entrada openai' };
  }
  if (stringField(entry, 'type') !== 'oauth') {
    return {
      present: false,
      reason: 'entrada openai do OpenCode não é OAuth: chave de API não observa a franquia da assinatura',
    };
  }
  const access = stringField(entry, 'access');
  const account = stringField(entry, 'accountId');
  if (access === null || account === null) {
    return { present: false, reason: 'entrada openai do OpenCode sem access token ou conta' };
  }
  return {
    present: true,
    credential: new SealedCredential({
      label: 'opencode_openai_oauth',
      accountFingerprint: accountFingerprint(account),
      apply: (headers) => {
        headers['authorization'] = `Bearer ${access}`;
        headers['chatgpt-account-id'] = account;
      },
    }),
  };
}

/** Chave de API do OpenCode Go. Autentica uma ASSINATURA, não cobrança por uso. */
export async function loadOpenCodeGoCredential(
  paths: CredentialPaths = defaultCredentialPaths(),
): Promise<CredentialLookup> {
  return loadOpenCodeApiKey(paths, 'opencode-go', 'opencode_go_api_key');
}

/** Chave de API do OpenRouter. Autentica cobrança POR USO contra saldo pré-pago. */
export async function loadOpenRouterCredential(
  paths: CredentialPaths = defaultCredentialPaths(),
): Promise<CredentialLookup> {
  return loadOpenCodeApiKey(paths, 'openrouter', 'openrouter_api_key');
}

async function loadOpenCodeApiKey(
  paths: CredentialPaths,
  provider: string,
  label: string,
): Promise<CredentialLookup> {
  const auth = await readJson(paths.opencodeAuthFile);
  const entry = nested(auth, provider);
  if (entry === undefined) {
    return { present: false, reason: `auth do OpenCode sem entrada ${provider}` };
  }
  if (stringField(entry, 'type') !== 'api') {
    return { present: false, reason: `entrada ${provider} do OpenCode não é chave de API` };
  }
  const key = stringField(entry, 'key');
  if (key === null) {
    return { present: false, reason: `entrada ${provider} do OpenCode sem chave` };
  }
  return {
    present: true,
    credential: new SealedCredential({
      label,
      accountFingerprint: null,
      apply: (headers) => {
        headers['authorization'] = `Bearer ${key}`;
      },
    }),
  };
}

/**
 * As duas credenciais OAuth apontam para a MESMA conta ChatGPT?
 *
 * Responder isso é o que impede o Lab de contar `codex_cli -> openai` e
 * `opencode -> openai` como duas capacidades. Só a igualdade dos digests sai
 * daqui; nenhum identificador de conta atravessa a fronteira.
 */
export function sameChatGptAccount(
  left: CredentialLookup,
  right: CredentialLookup,
): { readonly same: boolean | null; readonly reason: string } {
  if (!left.present || !right.present) {
    return { same: null, reason: 'uma das credenciais não está presente: identidade não comparável' };
  }
  const leftPrint = left.credential.accountFingerprint;
  const rightPrint = right.credential.accountFingerprint;
  if (leftPrint === null || rightPrint === null) {
    return { same: null, reason: 'uma das credenciais não identifica conta: identidade não comparável' };
  }
  return leftPrint === rightPrint
    ? { same: true, reason: 'fingerprints de conta idênticos: mesma conta ChatGPT, mesmo pool' }
    : {
        same: false,
        reason: 'fingerprints de conta distintos: contas diferentes observam franquias diferentes',
      };
}
