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
  AdapterPreflightOptions,
  BuildInvocationOptions,
  ParsedProviderLine,
  ProviderAdapter,
  ProviderEvent,
  ProviderObservation,
  UnknownProviderEvent,
} from './contract.js';
export { buildClaudeInvocation, CLAUDE_ADAPTER_IDENTITY } from './claude/invocation.js';
export { parseClaudeLine } from './claude/parser.js';
export { claudeAdapter } from './claude/index.js';
export { buildCodexInvocation, CODEX_ADAPTER_IDENTITY } from './codex/invocation.js';
export { parseCodexLine } from './codex/parser.js';
export { codexAdapter } from './codex/index.js';
export {
  buildClaudeQuotaInvocation,
  buildClaudeQuotaUsage,
  parseClaudeQuotaText,
  probeClaudeQuota,
  writeClaudeQuotaUsage,
  CLAUDE_QUOTA_FILE_NAME,
  CLAUDE_QUOTA_MAX_BUDGET_USD,
  CLAUDE_QUOTA_PROMPT,
  CLAUDE_QUOTA_PROVENANCE,
  type ClaudeQuotaCommandRunner,
  type ClaudeQuotaProbeOutcome,
  type ClaudeQuotaReading,
  type ClaudeQuotaWindowReading,
  type ProbeClaudeQuotaOptions,
} from './claude/quota.js';
export {
  FAKE_ADAPTER_IDENTITY,
  FAKE_AGENT_VARIANT_ENV,
  fakeAdapter,
  runFakeAgent,
  type FakeAgentEvent,
  type FakeAgentRun,
  type RunFakeAgentOptions,
  type UnknownAgentEvent,
} from './fake/index.js';
export { resolveAdapter } from './registry.js';
