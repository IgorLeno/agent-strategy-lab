# Audited Maintenance Range Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class, auditable maintenance-range adoption lifecycle while preserving every historical adoption mode.

**Architecture:** Extend `MaintenanceRecord` with the explicit `maintenance_range` kind and add a dedicated API/CLI while reusing the existing record directory and generic reconciliation chain. Validate the whole range at the target snapshot, persist evidence before state, and rederive every commit fact during verification/recovery.

**Tech Stack:** TypeScript, Zod, Node.js Git subprocesses, Vitest, pnpm.

## Global Constraints

- Create exactly one final commit on `main`, parent `939edf2a729c3b7bc763652476a934a73e5839ef`.
- Do not modify `dev/plan.yaml`, execute any adoption/orchestration command, launch M41, or invoke a provider/model.
- Keep `git diff --check` authoritative and preserve all historical record semantics.
- The final aggregate `7499aa872b4d55913e87e1860a928d6dee799ef9..HEAD` must pass.

---

### Task 1: Schema and record semantics

**Files:**
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/maintenance.ts`
- Test: `test/dev/maintenance-range.test.ts`

**Interfaces:**
- Consumes: existing `MaintenanceRecord`, `MaintenanceCommit`, maintenance allowlist, and validation-result schema.
- Produces: `AdoptionKind = 'maintenance' | 'plan_extension' | 'maintenance_range'` and `resolveAdoptionKind()` with an explicit range branch.

- [x] **Step 1: Write failing schema tests**

Add literal records proving that `maintenance_range` requires
`bootstrap_range: false` and at least two commits, while legacy normal,
bootstrap, and plan-extension records still parse.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- test/dev/maintenance-range.test.ts`
Expected: FAIL because `maintenance_range` is not an accepted kind.

- [x] **Step 3: Implement kind-specific schema rules**

Replace the generic one-commit condition with explicit branches:
normal maintenance requires one commit only when not bootstrap; bootstrap keeps
historical range behavior; plan extension remains one plan-only commit; range
requires `!bootstrap_range && commits.length >= 2`.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test -- test/dev/maintenance-range.test.ts`
Expected: schema cases pass.

### Task 2: Range API and Git verification

**Files:**
- Modify: `dev/lib/maintenance.ts`
- Test: `test/dev/maintenance-range.test.ts`

**Interfaces:**
- Consumes: `HarnessPaths`, `MaintenanceValidationRunner`, Git helpers, state/record IO.
- Produces: `MaintenanceRangeInput`, `adoptMaintenanceRange(input): Promise<AdoptionResult>`.

- [x] **Step 1: Add failing behavioral tests**

Create real sandbox histories covering: accepted three-commit range and ordered
parents/files; exact aggregate diff command; fixed and persistent intermediate
whitespace; validation failure atomicity; merge; divergent ancestry; forbidden
`src/**`; `dev/plan.yaml`; max count; dirty tree; RUNNING task; existing-record
idempotence; recovery recognition; and target-not-HEAD validation cwd.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- test/dev/maintenance-range.test.ts`
Expected: FAIL because `adoptMaintenanceRange` does not exist.

- [x] **Step 3: Implement the minimal range lifecycle**

Resolve `<target>^{commit}`, collect its single-parent chain to the authorized
head within `maxCommits`, validate maintenance files per commit, run the four
existing commands in the target snapshot, construct a
`maintenance_range` record, write it, then write state. Existing records are
fully verified and reused without rewriting evidence.

- [x] **Step 4: Strengthen independent record verification**

Make `verifyMaintenanceRecord` explicitly branch on all three kinds and, for
`maintenance_range`, enforce non-bootstrap multi-commit maintenance scope before
rederiving each parent and file list from Git. Keep aggregate validations owned
by the schema.

- [x] **Step 5: Run focused range and compatibility tests**

Run: `pnpm test -- test/dev/maintenance-range.test.ts test/dev/maintenance.test.ts test/dev/plan-extension.test.ts`
Expected: all focused tests pass.

### Task 3: Dedicated CLI

**Files:**
- Create: `dev/cli/dev-adopt-maintenance-range.ts`
- Modify: `package.json`
- Test: `test/dev/maintenance-range.test.ts`

**Interfaces:**
- Consumes: `parseArgs`, `withHarnessLock`, `headSha`, `adoptMaintenanceRange`.
- Produces: `pnpm dev-adopt-maintenance-range --target <sha> --max-commits <n> --reason <text>`.

- [x] **Step 1: Add a failing CLI test**

Invoke the CLI in a sandbox without `--max-commits` and assert fail-closed
behavior, then invoke the exported API for successful lifecycle assertions so
the test never runs real project gates or touches real `.dev` state.

- [x] **Step 2: Run the CLI-focused test and verify RED**

Run: `pnpm test -- test/dev/maintenance-range.test.ts`
Expected: FAIL because the CLI file/script is absent.

- [x] **Step 3: Implement CLI parsing and package script**

Default target to `headSha`, pass the raw numeric maximum through the API, use
the dedicated lock owner, and emit record path, target, commits, and validation
summary.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test -- test/dev/maintenance-range.test.ts`
Expected: all range and CLI cases pass.

### Task 4: Whitespace repair and full verification

**Files:**
- Modify: `test/dev/plan-extension.test.ts`
- Review: every changed file from `git diff --name-only`

**Interfaces:**
- Consumes: aggregate Git diff from `7499aa8` through the final worktree.
- Produces: a whitespace-clean target commit without changing the historical commits.

- [x] **Step 1: Repair every aggregate whitespace error**

Run `git diff --check 7499aa872b4d55913e87e1860a928d6dee799ef9..HEAD`, remove only reported
whitespace, then include working-tree changes with `git diff --check`.

- [x] **Step 2: Run native gates before commit**

Run: `pnpm typecheck`, `pnpm build`, `pnpm test`, `git diff --check`, and
`git diff --check 7499aa872b4d55913e87e1860a928d6dee799ef9..HEAD` accounting for the
uncommitted repair with the staged/working-tree checks.

- [x] **Step 3: Review scope and transaction invariants**

Confirm no `dev/plan.yaml` change, exactly the intended code/tests/docs, no
`.dev` mutation, `authorized_head_sha=7499aa8`, and M41 `READY/0`.

- [ ] **Step 4: Create the sole commit and reverify the committed tree**

Commit all exact paths once with
`fix(harness): support audited maintenance range adoption`; rerun the complete
gates and exact aggregate diff check against the resulting HEAD.

- [ ] **Step 5: Push normally and stop**

Run `git push origin main`, verify local/remote commit identity and unchanged
runtime state, and do not execute any adoption, recovery, orchestration, or
provider command.
