/**
 * Adapters de agente: traduzem a CLI de cada provider para a interface interna
 * do lab (eventos normalizados, métricas com provenance, estado da dimensão de
 * execução).
 *
 * Fronteira: o resto do produto nunca vê formato de provider. Stream
 * malformado não é fatal — a linha bruta sanitizada é preservada e o evento
 * desconhecido é armazenado, em vez de derrubar o run.
 *
 * Preenchido por M25 e M26 (adapter fake); adapters reais são fase posterior.
 */
export { AgentEvent, parseAgentEvents } from './events.js';
export type {
  AdapterInvocation,
  BuildInvocationOptions,
  ParsedProviderLine,
  ProviderAdapter,
  ProviderEvent,
  ProviderObservation,
  UnknownProviderEvent,
} from './contract.js';
export { buildClaudeInvocation, CLAUDE_ADAPTER_IDENTITY } from './claude/invocation.js';
export { parseClaudeLine } from './claude/parser.js';
export {
  FAKE_ADAPTER_IDENTITY,
  fakeAdapter,
  runFakeAgent,
  type FakeAgentEvent,
  type FakeAgentRun,
  type RunFakeAgentOptions,
  type UnknownAgentEvent,
} from './fake/index.js';
export { resolveAdapter } from './registry.js';
