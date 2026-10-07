/**
 * Superfície pública do core para quem hospeda o loop (CLI e daemon desktop).
 * Só o que um host precisa: loop, ledger, plano, catálogo, Git mode e os
 * tipos de evento do transcript.
 */
export type { AgentEvent } from './adapters/events.js';
export type { AdapterInvocation, ProviderEvent } from './adapters/contract.js';
export { buildInvocation, type InvocationRequest, type PermissionMode } from './adapters/invocation.js';
export { DEFAULT_CATALOG, parseCatalogYaml, type ModelProfile, type Tier } from './catalog/catalog.js';
export { planSlug, type GitMode, type Workspace } from './git/git.js';
export {
  Ledger,
  type AttemptOutcome,
  type AttemptRow,
  type LedgerStepStatus,
  type PlanRow,
  type PlanRunStatus,
  type StepRow,
} from './ledger/ledger.js';
export { PlanLoop, type Continuity, type LoopEvent, type LoopOptions, type LoopResult, type PauseReason } from './loop/loop.js';
export { PlanFormatError, parsePlan, type Plan, type PlanStep, type StepStatus } from './plan/plan.js';
