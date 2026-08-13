/**
 * Contrato mínimo que todo adapter de provider implementa: identidade (já
 * existente em `envelope` como `AdapterIdentity`), construção de invocation
 * (argv/env/stdin) e parser de uma linha bruta do stream do provider para a
 * interface interna de eventos (`AgentEvent`) + observações que não cabem
 * nela (usage, custo, classificação terminal).
 *
 * `preflight` (checar CLI instalada/autenticada) e um runtime comum
 * (`executeWithAdapter`) que rode qualquer `ProviderAdapter` fim a fim são
 * fase posterior — YAGNI enquanto só existe um adapter (fake) exercitando a
 * forma. Adicionar hoje o que só um segundo adapter real justificaria é
 * abstração prematura.
 */
import type { AdapterIdentity, ExecutionEnvelopeManifest } from '../envelope/index.js';
import type { AgentEvent } from './events.js';

/** Linha de stream que não corresponde à interface interna — preservada, não descartada. */
export interface UnknownProviderEvent {
  readonly type: 'unknown';
  /** Texto bruto da linha, já sanitizado por quem implementa o parser. */
  readonly raw: string;
}

/** O que o parser de um adapter produz: a interface interna, mais o caso `unknown` tolerante. */
export type ProviderEvent = AgentEvent | UnknownProviderEvent;

/** Tudo que constrói a invocation de um provider precisa — a identidade do adapter ele já sabe. */
export interface BuildInvocationOptions {
  readonly manifest: Omit<ExecutionEnvelopeManifest, 'adapter'>;
  readonly cwd: string;
}

/** Executável e argumentos já separados — nunca uma linha de comando para alguém partir depois. */
export interface AdapterInvocation {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

/** O que uma linha do stream de um provider observa além do evento normalizado. */
export interface ProviderObservation {
  readonly usage?: { readonly tokens: number | null };
  readonly cost?: { readonly amount: number | null; readonly currency: string };
  /** Classificação terminal relatada pelo próprio provider, quando a linha carrega uma. */
  readonly terminal?: 'success' | 'failure';
}

/** Resultado de interpretar uma linha bruta: o evento normalizado, mais observações quando houver. */
export interface ParsedProviderLine {
  readonly event: ProviderEvent;
  readonly observation?: ProviderObservation;
}

/**
 * Forma mínima de um adapter de provider. Não inclui execução — só o que é
 * específico de cada provider: identidade, como montar a invocation, e como
 * interpretar o que ele emite.
 */
export interface ProviderAdapter {
  readonly identity: AdapterIdentity;
  buildInvocation(options: BuildInvocationOptions): AdapterInvocation;
  parseLine(raw: string): ParsedProviderLine;
}
