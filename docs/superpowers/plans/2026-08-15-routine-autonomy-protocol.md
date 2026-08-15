# Routine Autonomy Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan inline. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bounded routine-exception layer to `dev-orchestrate` that can recover deterministic incidents, repair a small harness defect through an independently reviewed candidate, adopt it through the official primitive, retry the same preflight, and otherwise emit a specific `HUMAN_REQUIRED` decision.

**Architecture:** Keep the existing preflight and task-repair policy authoritative. A small incident state machine classifies only known evidence shapes and writes immutable step records; a separate runtime performs disposable-clone agent sessions, candidate inspection, gates, publication and official maintenance adoption. `--autonomy routine` wraps a blocked preflight once; without it, behavior is unchanged.

**Tech Stack:** TypeScript, Node.js filesystem/child-process APIs, Zod, Git plumbing, Vitest, pnpm/tsx.

**Spec:** User-approved routine-autonomy protocol in the 2026-08-15 task request.

## Global Constraints

- Touch implementation/tests only under `dev/**` and `test/dev/**`; docs are outside the eight-file implementation/test budget.
- Never modify `dev/plan.yaml`, `src/**`, experiment semantics, profile model/effort, billing policy or `schema_version`.
- At most eight implementation/test files, one adopted maintenance commit, one maintainer correction after a reviewer rejection, one retry after adoption, and two total autocorrection cycles.
- Maintainer and reviewer use independent disposable clones pinned to the exact authorized head/candidate; reviewer is read-only and a different profile by default.
- No task provider is launched by maintenance/review, and tests use injected fakes only—never a real provider.
- Historical records are read-only. Ambiguous, inconsistent, malformed or conflicting evidence is always `HUMAN_REQUIRED`.
- Publication is a normal fast-forward push; adoption delegates to `adoptMaintenance`; recovery and selection reuse the existing preflight primitives.

---

### Task 1: Make M56 history capability-neutral

**Files:**
- Modify: `test/dev/automatic-repair-policy.test.ts`
- Modify: `test/dev/retry-failed.test.ts`
- Modify: `dev/lib/automatic-repair.ts`
- Modify: `dev/lib/retry-failed.ts`

**Interfaces:**
- Consumes: `readProtocolInvalidAttempt(paths, taskId, attempt)`.
- Produces: both history walkers treat a sole protocol-invalid record like infra evidence: traverse without incrementing capability failures or producing repair diagnostics.

- [x] Add failing tests for protocol-only M56, validation-1/protocol-2, validation-1/protocol-2/validation-3, and mixed records in one attempt.
- [x] Run the two focused suites and confirm failures name the unknown gap or missing inconsistency check.
- [x] Read protocol-invalid evidence alongside validation/infra/abandonment in each walker; count all simultaneous records before choosing a branch.
- [x] Rerun focused suites and require: protocol-only `NOT_APPLICABLE`/`null`, one connected validation remains repair-eligible, two validations are exhausted, and mixed evidence fails closed.

### Task 2: Add bounded classification, budgets and append-only journal

**Files:**
- Create: `dev/lib/routine-autonomy.ts`
- Create: `test/dev/routine-autonomy.test.ts`

**Interfaces:**
- Produces: `IncidentClassification = 'AUTO_RECOVER' | 'AUTO_MAINTENANCE' | 'TASK_REPAIR' | 'HUMAN_REQUIRED'`.
- Produces: `resolveRoutinePreflight(input)` with an injected `RoutineAutonomyDriver` and immutable incident events under `.dev/autonomy/incidents/<incident-id>/`; a terminal aggregate is written once at `.dev/autonomy/incidents/<incident-id>.json`.
- Produces: `validateRoutineCandidate(candidate)` enforcing allowed roots, eight implementation/test files, direct-parent/single-commit shape, green targeted/full gates, clean diff, no task-provider launch, and explicit billing/plan/src/schema guards.

- [x] Write failing unit tests for AUTO_RECOVER, AUTO_MAINTENANCE, every mandatory human boundary, inconsistent evidence, append-only writes and no historical-record mutation.
- [x] Write failing state-machine tests: first reject permits one replacement candidate, second reject escalates, ACCEPT adopts officially, same blocker after retry escalates, and task attempts never change.
- [x] Write a failing crash/restart test using stable action ids; repeated execution must reuse the same maintenance/adoption/retry result rather than call the driver twice.
- [x] Implement deterministic incident ids, narrow classification recipes, candidate validation, immutable event writes and a specific `HUMAN_REQUIRED` payload.
- [x] Implement the two-cycle state machine and single retry of the same preflight; rerun the focused suite.

### Task 3: Implement the real clone/agent/review/adoption runtime

**Files:**
- Create: `dev/lib/routine-autonomy-runtime.ts`
- Modify: `test/dev/routine-autonomy.test.ts`

**Interfaces:**
- Produces: `createRoutineAutonomyRuntime(options): RoutineAutonomyDriver`.
- Maintainer defaults to a subscription-only Claude profile; reviewer defaults to a distinct subscription-only Codex profile, both overrideable without changing the experiment worker profile.
- Candidate contract: exactly one clean commit directly over `authorized_head_before`; targeted checks then `pnpm typecheck`, `pnpm build`, `pnpm test`, and `git diff --check`.
- Adoption contract: verify remote/base/candidate, normal push, fast-forward current checkout, call `adoptMaintenance`, then let the state machine repeat the original preflight.

- [x] Add fake-runner tests that prove separate clones/profiles/prompts, reviewer read-only enforcement, no task-launch call, official adoption callback use and refusal when any gate or Git invariant fails.
- [x] Implement profile/billing preflight, prompt delivery, time-bounded clean sessions and reviewer JSON parsing without provider-specific authority.
- [x] Implement candidate/reviewer clone lifecycle, Git inspection, gates and idempotent action-result reuse.
- [x] Implement normal publication plus the official adoption primitive; any refusal becomes `HUMAN_REQUIRED` rather than an alternate adoption path.

### Task 4: Add the explicit orchestrator mode

**Files:**
- Modify: `dev/cli/dev-orchestrate.ts`
- Modify: `test/dev/routine-autonomy.test.ts`
- Modify: `docs/HARNESS.md`

**Interfaces:**
- CLI: `pnpm dev-orchestrate --profile <worker> --max-iterations N --autonomy routine`.
- Without `--autonomy`, the existing preflight/stop output is unchanged.
- With routine autonomy, a recovered preflight proceeds normally; an escalation emits `{ status: 'HUMAN_REQUIRED', incident_id, decision_needed, why_automation_stopped, options, evidence_paths }` and exits before launch.

- [x] Add a subprocess test for option validation and structured `HUMAN_REQUIRED` output with zero fake-provider launches.
- [x] Wire only the blocked-preflight branch through `resolveRoutinePreflight`; do not alter task launch/finalization semantics.
- [x] Document classification, budgets, boundaries, incident journal, maintainer/reviewer sequence, official adoption and exact retry behavior.

### Task 5: Verify M56 and create the installation commit

**Files:** all files above plus this plan and `docs/LESSONS.md`.

- [x] Run the M56-focused walker tests and the routine-autonomy suite.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm build`.
- [x] Run `pnpm test`.
- [x] Run `git diff --check` and audit changed paths/count against the bounded allowlist.
- [x] Add a formal lesson only if implementation required a correction; otherwise record the protocol invariant in harness documentation.
- [ ] Obtain an independent read-only review from a clean second session; address at most one rejection before the final gates.
- [ ] Create exactly one commit: `feat(harness): add bounded routine autonomy recovery`.
- [ ] Confirm its parent is `40853ca6a2377cb8f38eb52bc89b3f49ac1800ce` and push normally without force.

### Task 6: Adopt, recover and stop before M56

- [ ] Fast-forward the original checkout to the pushed candidate without touching runtime evidence.
- [ ] Run the official `pnpm dev-adopt-maintenance --reason <installation reason>` primitive.
- [ ] Run `pnpm dev-recover --dry-run` and require `CLEAN`.
- [ ] Run `pnpm dev-next` and require M56 attempt 2, `FIRST_PASS`, ready to launch.
- [ ] Confirm M56 attempts remain 1, the protocol-invalid record is unchanged, and no provider/M56/M57 launch occurred.
- [ ] Stop for the one-time human installation audit.
