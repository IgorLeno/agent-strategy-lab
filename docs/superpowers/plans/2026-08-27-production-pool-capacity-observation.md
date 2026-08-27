# Production pool-capacity observation

**Date:** 2026-08-27

**Status:** COMPLETE

**Branch:** `fix/production-pool-capacity-observation`

**Baseline:** `d84aa50372a8999d79784c78fcbfbc2f0bbe2e56`

## Objective

Wire the read-only quota probes merged in Provider Expansion v1 into the real
project lifecycle so routing observes each authorized quota pool once per work
unit, fresh successful observations outrank history, and the selected launch
persists comparable before/after capacity without turning low or unknown
headroom into artificial gates.

## Boundaries

- [x] Preserve normalized provider/profile/billing/quota-pool contracts.
- [x] Preserve shared `openai_chatgpt_subscription` identity across Codex and
      OpenCode/OpenAI profiles.
- [x] Preserve explicit OpenRouter metered-billing authorization independently
      of observed balance.
- [x] Preserve UNKNOWN as UNKNOWN and low headroom as preference evidence only.
- [x] Reuse existing probes under `src/quota`; perform no model inference.
- [x] Keep cache lifetime bounded to one assessment/work unit; no global TTL.
- [x] Do not modify the existing Semi-Imperium runtime.

## Checkable plan

- [x] **1. Map the production lifecycle and contracts.** Inspect routing,
      preflight, implementer launch, planner/reviewer launch, quota credentials,
      capacity schemas, TUI projections, and existing provider-expansion tests.
- [x] **2. Define production-observer regression tests (RED).** Exercise the
      actual project/launch paths for fresh-over-history routing, shared-pool
      deduplication and exhaustion, Go evidence, UNKNOWN fallback, low-headroom
      eligibility, OpenRouter auth separation, before/after/delta/reset, one
      non-implementer role, TUI propagation, and secret-free records/errors.
- [x] **3. Implement the smallest production observer.** Map normalized pools
      to existing credential readers and read-only probes; expose a scope-bound
      observation cache and truthful UNKNOWN outcomes.
- [x] **4. Wire routing-time observation.** Observe unique eligible pools before
      selection, merge fresh success over historical capacity, exclude only
      provider-declared/real-resource exhaustion, and keep failed probes from
      erasing history.
- [x] **5. Wire launch-time before/after observation.** Reuse the routing
      snapshot as the selected launch baseline where safe, run one post-worker
      observation, and persist valid deltas/reset evidence in
      `LaunchRecord.pool_capacity` through the normal production caller.
- [x] **6. Cover planner/reviewer consumption coherently.** Apply the same
      pool-aware exhaustion and billing semantics to at least one real
      non-implementer production path without a parallel quota subsystem.
- [x] **7. Preserve structured reporting.** Feed real observations into the
      existing launch records/events/projections so UNKNOWN is never rendered
      as zero.
- [x] **8. Verify focused behavior.** Run each new regression RED then GREEN;
      run affected existing suites and inspect the final diff for scope,
      secrets, stale rationale, and accidental runtime changes.
- [x] **9. Run native gates.** `pnpm typecheck`, `pnpm test`, `pnpm build`, and
      `git diff --check`, reporting exact outcomes and any environmental limits.
- [x] **10. Deliver Git/PR.** Review atomicity, commit the coherent correction,
      push the focused branch, open an English focused PR, and do not merge it.

## Implementation gate

The user's task explicitly authorizes this focused cross-cutting correction,
local commits, branch push, and PR creation. Destructive operations, provider
inference, billing-policy changes, secret mutation, and automatic merge remain
outside scope.

## Outcome

Lifecycle audit confirmed the production gap: `assessWorkUnit` builds
`EvidenceBalanceFacts` exclusively from prior launch records, while
`launchTask` calls `launchWorker` without its optional capacity probe. Existing
quota probes, pool identity, delta schema, router exhaustion semantics, and TUI
projection are suitable and will be reused.
