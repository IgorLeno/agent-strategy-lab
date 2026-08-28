# Current quota is always live-observed per activity

**Date:** 2026-08-28

**Status:** COMPLETE

**Branch:** `fix/current-quota-live-observation`

**Baseline:** `cb8e07d6f62f5b04a0542229a1ac7b16e098bcb1` (PR #6 merged into `main`)

## Objective

Remove historical quota from every current execution decision. Provider
Expansion v1 and PR #6 introduced useful capacity evidence but let a persisted
`LaunchRecord` answer "how much quota exists now?". This work separates the two
questions: history describes the consumption of a completed launch, and only a
read performed for the current activity may decide routing, eligibility,
availability, exhaustion or headroom tie-breaks.

## Boundaries

- [x] Preserve the model-performance history system in full, including
      `quota.consumed_pp.p90_total` as an efficiency dimension.
- [x] Preserve `LaunchRecord.pool_capacity.before/after/deltas` as analytics.
- [x] Preserve shared `openai_chatgpt_subscription` identity across Codex and
      OpenCode/OpenAI profiles, and its single-read deduplication.
- [x] Preserve OpenRouter metered-billing authorization as independent of
      observed balance.
- [x] Preserve UNKNOWN as UNKNOWN and low headroom as preference-only evidence.
- [x] No TTL, no cross-activity cache; reuse only inside one immediate decision.
- [x] No model inference, no paid OpenRouter inference.
- [x] Do not modify the existing Semi-Imperium runtime.

## Checkable plan

- [x] **1. Classify every consumer of historical quota.** `quotaHeadroomByPool`,
      `effectiveQuotaHeadroom`, `effectiveQuotaHeadroomByPool`,
      `LaunchRecord.pool_capacity`, `subscription_usage`,
      `rate_limit_observations` — separated into current-decision use (removed)
      and post-hoc analytics (kept).
- [x] **2. Make `quotaFactOf` fresh-only.** Three outcomes: fresh EXHAUSTED is
      PROVEN FALSE, any other fresh measurement is PROVEN TRUE, fresh UNKNOWN or
      no observation is UNKNOWN. It no longer opens any `LaunchRecord`.
- [x] **3. Delete the history-to-current-headroom functions.** Replaced by
      `currentQuotaHeadroom` / `currentQuotaHeadroomByPool`, which read only the
      snapshot of the current assessment.
- [x] **4. Give every role one shared observer.** `collectCurrentLaunchFacts` is
      the single path for planner, deliberator, implementer, reviewer, bounded
      repair and escalation steps.
- [x] **5. Deduplicate per immediate decision.** Escalation ladder candidates now
      share one observation round, indexed by pool.
- [x] **6. Regression tests on the production path.** No historical OBSERVED or
      EXHAUSTED fallback, OpenRouter recharge and fresh UNKNOWN, fresh
      exhaustion authority, low headroom eligibility, per-activity reprobe,
      same-assessment dedup, routing snapshot reused as launch `before`,
      static_cost vs evidence_balanced, non-implementer roles, no secret leakage.
- [x] **7. Documentation.** `docs/PROVIDERS.md` §5.1 states the invariant and the
      exact scope of allowed reuse; `docs/LESSONS.md` records why the fallback
      was wrong.

## Outcome

`pnpm typecheck`, `pnpm test` (175 files, 2488 tests), `pnpm build` and
`git diff --check` all green. Test count moved from 2478 to 2488: four tests
that asserted the historical fallback were replaced, and fourteen were added.

No production routing, eligibility or availability decision can derive quota
from a previous `LaunchRecord`.
