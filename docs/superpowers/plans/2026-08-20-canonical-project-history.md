# Canonical External Project History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize external project attempts into canonical runs and route new work with episode-safe M81 V2 history.

**Architecture:** Preserve profile-homogeneous Trial semantics, add an optional versioned run-to-episode context, and project canonical evidence into episode lifecycle plus homogeneous profile series. The project control plane queries a frozen, read-only history snapshot before launch and materializes evidence only after an observed attempt.

**Tech Stack:** TypeScript, Zod, Node.js filesystem/crypto/sqlite, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-20-canonical-project-history-design.md`

## Global Constraints

- Do not change `dev/plan.yaml` or create M87.
- Do not call a real provider or run a real external project in tests.
- Keep M81 V1, TaskPerformanceRecord V1 and `derivePerformance` semantics unchanged.
- Use canonical `data/runs`, section sealing, integrity verification and `RunIndex.indexRun`.
- Preserve null and UNKNOWN; never fabricate tokens, quota, cost, review or profile identity.
- Produce exactly one final commit before the explicitly authorized maintenance adoption.

---

### Task 1: Versioned episode linkage and M81 V2 projection

**Files:**
- Modify: `src/storage/sqlite-index.ts`
- Modify: `src/performance/history.ts`
- Modify: `src/performance/query.ts`
- Modify: `src/performance/index.ts`
- Test: `test/performance/history.test.ts`
- Test: `test/performance/query.test.ts`

**Interfaces:**
- Produces: `RunHistoryContextV1`, `PerformanceHistoryQueryInputV2`, `PerformanceHistoryQueryResultV2` and the V2 overload of `queryPerformanceHistory`.
- Preserves: the existing V1 input/result and `derivePerformance(AttemptHistory)`.

- [ ] Add RED fixtures whose one episode contains profile-A INITIAL/REPAIR and profile-B ESCALATION trials.
- [ ] Run `pnpm exec vitest run test/performance/history.test.ts test/performance/query.test.ts` and confirm the V2 contracts are absent.
- [ ] Add optional `history_context` parsing to RunRecord and expose it from each `RunReadResult`.
- [ ] Implement V2 grouping: lifecycle by episode, comparable identity per run, role-partitioned execution aggregates, and initial-profile lifecycle attribution.
- [ ] Keep V1 code path unchanged and make missing legacy episode context an explicit V2 exclusion.
- [ ] Run the focused tests and confirm V1 plus V2 pass.

### Task 2: M82 consumes only episode-safe routing evidence

**Files:**
- Modify: `src/routing/history-router.ts`
- Test: `test/routing/history-router.test.ts`

**Interfaces:**
- Consumes: `PerformanceHistoryQueryResultV2.series[].routing_aggregations`.
- Produces: existing `HistoryInformedRoutingResult`, with unchanged V1 behavior.

- [ ] Add RED routing cases proving profile B wins with three compatible initial episodes and falls back when a required metric is missing.
- [ ] Add a cross-profile episode case proving escalation-only B evidence cannot select B initially.
- [ ] Normalize V1 and V2 into the existing frontier comparison while keeping candidate fingerprint and policy checks fail-closed.
- [ ] Run `pnpm exec vitest run test/routing/history-router.test.ts` and confirm all cases pass.

### Task 3: Crash-safe canonical external-attempt materialization

**Files:**
- Create: `dev/lib/project-history.ts`
- Modify: `dev/lib/project-run.ts`
- Modify: `dev/lib/paths.ts`
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/records.ts`
- Test: `test/dev/project-run.test.ts`
- Test: `test/e2e/external-plan-run-e2e.test.ts`

**Interfaces:**
- Produces: `queryCanonicalProjectHistory(...)` and `materializeCanonicalProjectAttempt(...)`.
- Consumes: PlanFile task, classification, inspection, full LauncherProfile, LaunchRecord, validation evidence, review evidence and existing storage/evaluation/scoring primitives.

- [ ] Add RED fake-only tests for INITIAL PASS, validation FAIL, REPAIR, ESCALATION, inference-free retry, idempotent rerun and crash resume.
- [ ] Define the append-only binding schema keyed by project/runtime/task/attempt/launch and deterministic run-id derivation.
- [ ] Build canonical TaskSpec, Trial, execution envelope and ExecutionRecord only from authoritative evidence; preserve unobserved metrics as null.
- [ ] Reuse `recordComparableRunFacts`, `finalizeExecution`, `sealEvaluation`, `scoreRunV1`, `sealScore` and `RunIndex.indexRun`.
- [ ] Map PASS, FAIL, REJECT and unavailable review without promoting unavailable evidence to PASS.
- [ ] Verify every published fake run with `verifyRunIntegrity` and `RunIndex.rebuild`.
- [ ] Run the focused project tests and confirm zero provider invocation.

### Task 4: Production read-only history query, fixed policy and dry-run

**Files:**
- Modify: `dev/lib/project-run.ts`
- Modify: `dev/cli/dev-run-plan.ts`
- Test: `test/dev/dev-run-plan.test.ts`
- Test: `test/dev/project-run.test.ts`

**Interfaces:**
- Consumes: `queryCanonicalProjectHistory` and canonical fingerprints of complete catalog profiles.
- Produces: accurate `history_status`, routing source/profile and evidence summary for real execution and dry-run.

- [ ] Add RED tests that distinguish EMPTY, INSUFFICIENT and AVAILABLE using compatible canonical runs.
- [ ] Replace `emptyPerformanceHistory()` with the read-only V2 query and freeze its result for the primary work-unit cycle.
- [ ] Pass complete profile fingerprints into M82 and filter history to authorized candidates.
- [ ] Prove the Sol Medium-only policy remains sovereign when another history series is better.
- [ ] Prove dry-run reports history while creating no run, state, evaluation, index or provider activity.
- [ ] Run both focused dev tests.

### Task 5: Quality gates, single commit and authorized lifecycle checks

**Files:**
- Review: all changed files
- Preserve: `dev/plan.yaml`

**Interfaces:**
- Produces: one verified maintenance commit and the requested lifecycle reports.

- [ ] Run `pnpm typecheck`.
- [ ] Run the exact focused Vitest command requested by the operator.
- [ ] Run `pnpm build`, `pnpm test`, `git diff --check` and `git diff --cached --check`.
- [ ] Confirm `dev/plan.yaml` hash remains `cdaf7acf3378e2e5cd243004dd4b3513f3a4c66b57dec59357120ec13106a899`.
- [ ] Create one commit: `feat(harness): feed canonical project history into routing`.
- [ ] Run `pnpm dev-adopt-maintenance --reason "feed canonical external project history into M81 M82 routing"`; stop without forcing if refused.
- [ ] Run `pnpm dev-recover --dry-run` and `pnpm dev-next`; do not start A/B or any provider.
