# Orchestrator-derived array caps pre-resume correction

**Date:** 2026-08-28

**Status:** VALIDATED — COMMIT/PR PENDING

**Branch:** `fix/orchestrator-derived-array-caps`

**Baseline:** `fe83de5e8f9a8d4a211a3838254bb7391d9c7fd0`

## Objective

Remove only the arbitrary array-count ceilings that can prevent completed,
orchestrator-derived Git and official-validation evidence from being sealed or
preserved. Keep worker/reviewer semantic bounds and all unrelated lifecycle
policies unchanged.

## Boundaries

- [x] Do not modify or resume the canonical Semi-Imperium runtime.
- [x] Change only `HandoffRecord` common facts and
  `PreviousAttemptDiagnostics` fields whose cardinality comes from real
  orchestrator evidence.
- [x] Do not truncate, partition, or otherwise discard evidence.
- [x] Leave `AgentCompletionReport`, `CandidateReviewCoverage`, worker semantic
  fields, artifact-size telemetry, retry/review/repair, quota, provider, and
  billing behavior unchanged.

## Checkable plan

- [x] Inspect the schemas, sealing caller chain, retry diagnostics derivation,
  and existing focused tests through the indexed code graph and source.
- [x] Add RED regressions for a combined handoff with 51 files and 21 official
  validations, large previous-attempt diagnostics, and the real production
  finalization/sealing path; retain a representative worker semantic-bound
  rejection.
- [x] Remove only the four proven `.max(50)` / `.max(20)` constraints at the
  narrow schema ownership boundary.
- [x] Run focused regressions and review the diff for unchanged review coverage,
  semantic bounds, advisory byte telemetry, and Semi-Imperium runtime state.
- [x] Run `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`.
- [ ] Record the outcome, create one coherent commit, push the branch, and open
  a focused non-merged PR.

## Implementation gate

The user's execution-authority audit and current task explicitly authorize this
narrow, reversible correction plus commit, push, and PR creation. They do not
authorize merging or resuming the Semi-Imperium runtime.

## Outcome

- RED reproduced the four arbitrary ceilings at the exact schema paths and in
  `finalizeOrchestratedTask` after Git-derived material already existed.
- The implementation removes only the four reality-derived `.max(50)` /
  `.max(20)` constraints. Item schemas, strict objects, minimum semantics, and
  worker/reviewer semantic bounds remain unchanged.
- Focused proof: 6/6 selected regressions passed, including 51 files plus 21
  validations in one handoff and 51 Git-derived files through production
  finalization.
- Full gates: `pnpm typecheck`, `pnpm build`, and `git diff --check` passed;
  `pnpm test` passed 175 files and 2492/2492 tests.
- The immediate audit found no additional same-class capped array.
  `AgentCompletionReport` remains worker-authored and
  `CandidateReviewCoverage` remains reviewer-declared.
