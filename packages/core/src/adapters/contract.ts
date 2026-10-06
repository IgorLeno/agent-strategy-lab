// Adaptado de src/adapters/contract.ts (agent-strategy-lab 2052cca). Saem
// `preflight`, `executionKind` e o `ExecutionEnvelopeManifest`: o core novo não
// tem envelope de evidência nem prova de credencial por launch.
import type { AgentEvent } from './events.js';

/** Linha de stream que não corresponde à interface interna — preservada, não descartada. */
export interface UnknownProviderEvent {
  readonly type: 'unknown';
  /** Texto bruto da linha, já sanitizado por quem implementa o parser. */
  readonly raw: string;
}

/** O que o parser de um adapter produz: a interface interna, mais o caso `unknown` tolerante. */
export type ProviderEvent = AgentEvent | UnknownProviderEvent;

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

/** Executável e argumentos já separados — nunca uma linha de comando para alguém partir depois. */
export interface AdapterInvocation {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: string;
}
