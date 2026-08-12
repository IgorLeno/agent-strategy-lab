# Compact Recover and Next Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `dev-recover` and `dev-next` concise by default while preserving their current diagnostic payloads behind `--verbose`.

**Architecture:** Keep recovery, selection, packet construction, persisted schemas, records, and exit-code decisions unchanged. Derive compact JSON only inside the two CLI presentation layers from the results and state they already load; exercise the CLIs as real subprocesses against disposable Git repositories.

**Tech Stack:** TypeScript, Node.js, Vitest, pnpm, existing harness test helpers.

## Global Constraints

- Do not modify `dev/plan.yaml`, `src/`, product contracts, persisted schemas, records, recovery, selection, retry, orchestration, or lifecycle semantics.
- Do not launch a provider/model, execute M46, or run adoption/orchestration commands.
- Make exactly one maintenance commit, with no amend or force-push.
- Preserve existing exit codes and keep M45 evidence read-only.

---

### Task 1: Specify `dev-recover` compact and verbose views

**Files:**
- Modify: `test/dev/dev-recover.test.ts`
- Modify: `dev/cli/dev-recover.ts`

**Interfaces:**
- Consumes: existing `recover(...)` result, `headSha(repoRoot)`, and `parseArgs(...)` flags.
- Produces: compact default JSON with `status`, `mode`, `authorized_head_sha`, `head_matches_authorized`, `plan_changed`, `reconciliation_count`, and dynamically derived `task_counts`; verbose JSON preserving every historical field.

- [x] Add process-level tests that assert the default omits `statuses`, dynamically counts task statuses, reports `CLEAN` only for a present/reconciled state with matching HEAD, and reports `ATTENTION` for divergent HEAD, changed plan, or non-empty reconciliations.
- [x] Add process-level tests that assert `--verbose` preserves `dry_run`, `state_was_missing`, `plan_changed`, `reconciliations`, `authorized_head_sha`, and full `statuses`.
- [x] Run `pnpm exec vitest run test/dev/dev-recover.test.ts` and confirm the new tests fail for the missing compact/verbose presentation.
- [x] Implement the smallest presentation-only branch in `dev/cli/dev-recover.ts`, leaving `recover()` and writes untouched.
- [x] Re-run `pnpm exec vitest run test/dev/dev-recover.test.ts` and confirm it passes.

### Task 2: Specify `dev-next` compact and verbose views

**Files:**
- Modify: `test/dev/dev-next.test.ts`
- Modify: `dev/cli/dev-next.ts`

**Interfaces:**
- Consumes: existing `selectNextTask(...)`, state task attempts, `readPreviousAttemptDiagnostics(...)`, `headSha(repoRoot)`, and `buildTaskPacket(...)`.
- Produces: compact selected summary with launch readiness/base divergence, compact non-selected status, and verbose legacy `{ status, reason, packet }` diagnostics.

- [x] Replace the legacy default packet assertion with process-level assertions for the exact operational summary and absence of packet details; cover first-pass attempt metadata and matching authorized base.
- [x] Add a repair fixture with archived previous-attempt diagnostics and assert the next attempt number, `REPAIR`, plus verbose preservation of `previous_attempt_diagnostics`.
- [x] Add divergent-HEAD coverage asserting `ready_to_launch: false` and `blocker: "BASE_DIVERGED"` without changing selection/state.
- [x] Add compact `BLOCKED` and `ALL_DONE` cases and assert their existing exit codes; retain a blocking-status case to prove its current exit code.
- [x] Add `--verbose` coverage for the complete packet fields (`schema_version`, `task_id`, `objective`, `acceptance`, `validation`) and legacy payload shape.
- [x] Run `pnpm exec vitest run test/dev/dev-next.test.ts` and confirm the new tests fail for the missing compact/verbose presentation.
- [x] Implement the smallest presentation-only branch in `dev/cli/dev-next.ts`, capturing the HEAD once for both packet construction and readiness while leaving selection and packet construction intact.
- [x] Re-run `pnpm exec vitest run test/dev/dev-next.test.ts` and confirm it passes.

### Task 3: Forensics, verification, and the single maintenance commit

**Files:**
- Read only: `.dev/failed-attempts/M45/attempt-1/**`
- Read only: accepted M45 commit and its parent
- Verify: all modified files

**Interfaces:**
- Consumes: sealed attempt-1 validation record/logs/patch and accepted attempt-2 commit diff.
- Produces: final forensic classification and one pushed maintenance commit; no state/adoption changes.

- [x] Read the referenced M45 validation logs, compare `changes.patch` with commit `be646d8`, and classify the retry using concrete file/hunk evidence.
- [x] Run focused tests for both changed CLIs.
- [x] Run `pnpm typecheck`, `pnpm build`, `pnpm test`, and `git diff --check`; inspect every exit code.
- [x] Review the final diff for scope, confirm `dev/plan.yaml`, `src/`, and `.dev` are unchanged, and confirm M46 remains unlaunched.
- [ ] Stage only the plan, lessons, two CLI files, three affected test files; create exactly one commit named `fix(harness): compact recover and next output`.
- [ ] Push normally without amend/force, then report the before/after authorized head without running any adoption or orchestration command.
