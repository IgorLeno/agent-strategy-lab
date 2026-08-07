# Orchestrator-Owned Normal Task Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the new Codex v2 normal-task flow leave an exact working-tree patch for the harness to validate, commit, seal, and recover transactionally.

**Architecture:** Add one fail-closed execution-policy value shared by profiles and LaunchRecords, keep legacy `closeTask` and recovered finalization unchanged, and introduce a separate orchestrated normal finalizer plus a small launch-policy dispatcher. Reuse neutral Git and atomic-record primitives while binding official validation to a deterministic patch fingerprint and the candidate's exact tree.

**Tech Stack:** TypeScript 5.7 ESM, Zod, Vitest, Node.js 22, YAML, Git subprocess argv with NUL-delimited porcelain output.

## Global Constraints

- Work in the current checkout on `main`, explicitly authorized by the user; do not create another worktree or branch.
- Do not execute M03, Codex, Claude, any real model, or any API.
- Do not push, merge, rebase, amend, stash, hard-reset, or rewrite historical artifacts.
- Do not modify `dev/plan.yaml` or the semantic content of `codex-build-worker-subscription-high-v1`.
- Keep `.dev/**`, `.dev-inbox/**`, `.claude/**`, `.agents/**`, and `.codex/**` out of the maintenance commit.
- Use TDD: add each behavioral test before its production implementation and observe the expected RED result.
- Do not stage or commit between tasks. Create exactly one local maintenance commit after all final gates pass.
- Stop and investigate any complete-suite failure; do not classify it as a flake automatically.
- Final verification requires `pnpm typecheck`, `pnpm build`, `git diff --check`, and three consecutive green `pnpm test` executions.

---

### Task 1: Fail-closed execution policy, profile v2, and doctor

**Files:**
- Create: `dev/lib/execution-policy.ts`
- Create: `dev/profiles/codex-build-worker-subscription-high-v2.yaml`
- Modify: `dev/lib/profile.ts`
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/doctor.ts`
- Modify: `test/dev/schemas.test.ts`
- Modify: `test/dev/doctor.test.ts`
- Modify: `test/dev/billing.test.ts`

**Interfaces:**
- Produces: `ExecutionPolicy`, `LEGACY_EXECUTION_POLICY`, `ORCHESTRATED_EXECUTION_POLICY`, and `executionPolicyOf(profile)`.
- `LauncherProfile` exposes flat `commit_owner`, `official_validation_owner`, and `worker_validation_policy` fields with legacy defaults.
- `LaunchRecord.execution_policy` is nested, defaults to legacy when absent, and rejects unsupported tuples.
- `DoctorReport` exposes all three effective policy fields and an independent `execution policy` check.

- [x] **Step 1: Add RED schema and profile tests**

Add cases equivalent to:

```ts
expect(ExecutionPolicy.parse(LEGACY_EXECUTION_POLICY)).toEqual({
  commit_owner: 'worker',
  official_validation_owner: 'worker',
  worker_validation_policy: 'full',
});
expect(ExecutionPolicy.parse(ORCHESTRATED_EXECUTION_POLICY)).toEqual({
  commit_owner: 'orchestrator',
  official_validation_owner: 'orchestrator',
  worker_validation_policy: 'targeted',
});
for (const mixed of unsupportedPolicyTuples) {
  expect(() => ExecutionPolicy.parse(mixed)).toThrow(/combina.*não suportada/i);
}
```

Also prove that a profile omitting all fields resolves to worker/worker/full,
the checked-in v1 resolves to that tuple without changing its YAML, and v2
explicitly resolves to orchestrator/orchestrator/targeted while retaining the
v1 model, billing, sandbox, persistence, instruction-home, config/rules, and
credential constraints. Assert v2 has none of the four `GIT_*` identity keys.

- [x] **Step 2: Run policy/profile tests and observe RED**

Run:

```text
pnpm exec vitest run test/dev/schemas.test.ts test/dev/billing.test.ts
```

Expected: failures name missing execution-policy schema/profile fields and the
missing v2 profile.

- [x] **Step 3: Implement the minimal policy and profile contract**

Define the three enums and a strict Zod object whose refinement accepts only
the two approved tuples. Add the flat fields with defaults to LauncherProfile,
validate the picked tuple through `ExecutionPolicy`, and add v2 by copying v1's
provider contract, changing only its ID, policy fields, Git identity variables,
and explanatory notes. Add `execution_policy` with a legacy default to
LaunchRecord without changing `DEV_SCHEMA_VERSION` or rewriting any record.

- [x] **Step 4: Add RED doctor tests**

Add assertions that worker ownership still requires resolved author and
committer, orchestrator ownership succeeds without worker Git variables and
states that commit identity belongs to the harness outside the provider
sandbox, and a mixed policy is rejected before meaningful doctor success.

- [x] **Step 5: Run doctor tests and observe RED**

Run:

```text
pnpm exec vitest run test/dev/doctor.test.ts test/dev/billing.test.ts
```

Expected: v2 identity/policy assertions fail because doctor is not policy-aware.

- [x] **Step 6: Implement doctor policy reporting and run GREEN tests**

Update the Git identity check to branch only on `commit_owner`, add the explicit
policy check and top-level report fields, then run:

```text
pnpm exec vitest run test/dev/schemas.test.ts test/dev/doctor.test.ts test/dev/billing.test.ts
```

Expected: all selected tests pass with fake CLIs only.

---

### Task 2: LaunchRecord evidence and policy-specific worker prompt

**Files:**
- Modify: `dev/lib/prompt.ts`
- Modify: `dev/lib/launch.ts`
- Modify: `test/dev/prompt.test.ts`
- Modify: `test/dev/dev-launch.test.ts`

**Interfaces:**
- `buildWorkerPrompt(packet, io, executionPolicy): string` requires an explicit effective policy.
- `launchWorker` derives policy from the parsed profile once and writes that same value into both versions of LaunchRecord.

- [x] **Step 1: Add RED prompt tests for both ownership modes**

Preserve the legacy assertions and add orchestrator assertions for explicit
prohibition of `git add`, `git commit`, `git stash`, `git reset`, and file
checkout; targeted checks being optional; full packet validations belonging to
the orchestrator; `SUCCESS` meaning ready for official validation;
`candidate_commit: null`; exact changed files; actual-only validation commands;
HandoffDraft PASS/FAIL semantics; and final stop. Compute the preamble bytes for
both branches and compare with `MAXIMUM_PREAMBLE_BYTES`.

- [x] **Step 2: Run prompt tests and observe RED**

Run:

```text
pnpm exec vitest run test/dev/prompt.test.ts
```

Expected: the new signature and orchestrator text are absent.

- [x] **Step 3: Implement the minimal two-branch prompt**

Keep the worker-owned preamble text byte-for-byte where practical. Add a compact
orchestrator-owned preamble containing only the approved contract and retain
the common strict JSON skeleton and packet append.

- [x] **Step 4: Add RED LaunchRecord tests**

Assert a legacy parsed record without `execution_policy` yields the legacy
tuple, and a launched fake orchestrator profile records its explicit policy in
both the returned and persisted LaunchRecord. Ensure no test invokes a real
provider.

- [x] **Step 5: Implement launch evidence and run GREEN tests**

Pass `executionPolicyOf(profile)` to the prompt and include it in the immutable
LaunchRecord base object. Run:

```text
pnpm exec vitest run test/dev/prompt.test.ts test/dev/dev-launch.test.ts test/dev/schemas.test.ts
```

Expected: all selected tests pass.

---

### Task 3: Machine-readable patch discovery, fingerprint, and staged-tree checks

**Files:**
- Modify: `dev/lib/git.ts`
- Create: `test/dev/git.test.ts`

**Interfaces:**
- Produces `WorkingTreeEntry` with `status`, `path`, and optional `originalPath`.
- Produces `parsePorcelainV1Z(output)`, `workingTreeSnapshot(repoRoot)`, and `patchFingerprint(repoRoot)`.
- Produces staged-tree helpers `writeTree(repoRoot)` and `commitTree(repoRoot, sha)`.
- Existing `workingTreeFiles` delegates to the structured snapshot.

- [x] **Step 1: Add RED parser and real-repository tests**

Use synthetic NUL data to prove spaces are preserved and rename/copy records
consume their second path field:

```ts
expect(parsePorcelainV1Z('?? new file.txt\0R  renamed file.txt\0old file.txt\0')).toEqual([
  { status: '??', path: 'new file.txt', originalPath: null },
  { status: 'R ', path: 'renamed file.txt', originalPath: 'old file.txt' },
]);
```

In a temporary Git repo, create modified, added, deleted, renamed, and untracked
paths and assert the exact unordered changed-file set. Add a copy-form parser
case even if Git's default status does not enable copy detection.

- [x] **Step 2: Run parser tests and observe RED**

Run:

```text
pnpm exec vitest run test/dev/git.test.ts
```

Expected: missing parser/snapshot APIs fail.

- [x] **Step 3: Implement NUL-delimited status parsing**

Invoke exactly `git status --porcelain=v1 -z --untracked-files=all`. Parse the
two fixed status bytes and NUL fields without line splitting or arrow syntax.
Include the original path in the changed-file set for rename, not for copy;
retain it as fingerprint metadata for both.

- [x] **Step 4: Add RED fingerprint and cached-check tests**

Prove the fingerprint changes when a validation-style callback rewrites bytes
without changing paths, includes an explicit null-content deletion marker, and
hashes an untracked file. Add a new untracked file containing trailing
whitespace, stage only its exact path, prove `git diff --cached --check` fails,
restore that path, then assert `stagedFiles()` is empty and the file contents
remain unchanged.

- [x] **Step 5: Implement fingerprint and staged-tree helpers**

Canonicalize sorted `{status,path,original_path,current_content_sha256}` entries.
Hash current regular-file bytes; hash symlink target bytes; use null for paths
absent from the working tree. Add `writeTree` and candidate tree lookup using
direct Git argv.

- [x] **Step 6: Run GREEN Git tests**

Run:

```text
pnpm exec vitest run test/dev/git.test.ts
```

Expected: parser, fingerprint, cached-check, index-restoration, and tree helpers pass.

---

### Task 4: Orchestrated finalization schema and atomic records

**Files:**
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/paths.ts`
- Modify: `dev/lib/records.ts`
- Modify: `test/dev/schemas.test.ts`
- Create: `test/dev/finalize-orchestrated.test.ts`

**Interfaces:**
- Produces `OrchestratedFinalizationRecord` at `.dev/finalizations/<task>/attempt-<N>.json`.
- Adds `orchestrated_finalization_attempt` and `orchestrated_finalization_record_sha256` to normal orchestrator CompletionRecords only.
- Extends `commit_origin` to `worker | orchestrator | orchestrator_recovery` while preserving legacy optional fields.

- [x] **Step 1: Add RED record/schema/path tests**

Assert the complete required record shape, sorted unique non-empty changed
files, successful validation results, stable patch fingerprint, null worker
candidate source, and literal `commit_origin: orchestrator`. Prove old normal
worker CompletionRecords and recovered M02-shaped records still parse. Assert
the deterministic path includes task ID and attempt.

- [x] **Step 2: Run record tests and observe RED**

Run:

```text
pnpm exec vitest run test/dev/schemas.test.ts test/dev/finalize-orchestrated.test.ts
```

Expected: missing schema/path/read-write functions fail.

- [x] **Step 3: Implement minimal schemas and atomic record IO**

Add `finalizationsDir` to HarnessPaths/runtime setup, deterministic path/read/
write functions using `writeJsonAtomic`, and CompletionRecord refinements that
require attempt+hash exactly when `finalization_mode: normal` and
`commit_origin: orchestrator`.

- [x] **Step 4: Run GREEN record tests**

Run the same focused command and require all selected tests to pass.

---

### Task 5: Orchestrated finalizer preconditions and failure paths

**Files:**
- Create: `dev/lib/finalize-orchestrated.ts`
- Extend: `test/dev/finalize-orchestrated.test.ts`

**Interfaces:**
- Produces `finalizeOrchestratedTask(input): Promise<CloseOutcome>`.
- Input includes `paths`, `loaded`, `taskId`, optional injected validation runner,
  deterministic clock, and crash hooks after commit/finalization/completion.
- Produces `verifyOrchestratedFinalizationRecord` and `sealOrchestratedFinalization` for recovery.

- [x] **Step 1: Add RED operational-precondition tests**

Cover task not RUNNING/FINALIZING, missing/unfinished/mismatched LaunchRecord,
live process, worker-owned launch, missing or invalid report/draft, mismatched
task IDs, non-null report candidate, wrong HEAD, prior staging, empty patch,
other RUNNING task, extra actual file, absent reported file, and every forbidden
path prefix. Assertions require PENDING/refusal without commit, accepted SHA, or
historical-artifact changes.

- [x] **Step 2: Run precondition tests and observe RED**

Run:

```text
pnpm exec vitest run test/dev/finalize-orchestrated.test.ts
```

Expected: finalizer API is absent.

- [x] **Step 3: Implement evidence loading and fail-closed preconditions**

Load packet, launch, exact report/draft bytes, and parsed artifacts; verify the
recorded policy and dead process; compare the structured working-tree snapshot
to report paths; reject forbidden paths before any validation or staging.

- [x] **Step 4: Add RED worker/validation/fingerprint failure tests**

Prove worker FAILURE creates no commit or PASS handoff, records real evidence,
preserves the patch, and stops at FAIL. Prove official validation failure does
the same with candidate/accepted null and unchanged authorized head. Inject a
successful validation that rewrites an existing file while keeping the same
changed-file set and assert refusal by fingerprint. Use a new trailing-
whitespace file to force `git diff --cached --check`, then assert only the index
is restored and the working file remains.

- [x] **Step 5: Implement failure transactions and run GREEN tests**

Compute fingerprint before official validations and immediately after; compare
before staging. On ordinary or cached validation failure, write only a FAIL
CompletionRecord and FAIL state. Treat cached diff check as an official
validation result, restore exact staged paths on failure, and never write a
finalization record, handoff PASS, manifest, or commit.

Run:

```text
pnpm exec vitest run test/dev/finalize-orchestrated.test.ts
```

Expected: all precondition and failure-path tests pass.

---

### Task 6: Successful commit, sealing, crash recovery, and dispatch

**Files:**
- Modify: `dev/lib/git.ts`
- Modify: `dev/lib/finalize-orchestrated.ts`
- Create: `dev/lib/close-dispatch.ts`
- Modify: `dev/lib/recover.ts`
- Modify: `dev/cli/dev-close.ts`
- Modify: `dev/cli/dev-orchestrate.ts`
- Extend: `test/dev/finalize-orchestrated.test.ts`
- Modify: `test/dev/dev-close.test.ts`
- Modify: `test/dev/dev-recover.test.ts`
- Modify: `test/dev/protocol-e2e.test.ts`

**Interfaces:**
- `closeTaskByLaunchPolicy(input)` reads the finalized LaunchRecord and dispatches only by its effective recorded policy.
- `verifyCloseBundle` validates orchestrator-normal record/hash metadata in addition to existing worker and recovered modes.
- Recovery seals orchestrated records only when explicitly applied; dry-run reports without writes.

- [x] **Step 1: Add RED successful-finalization tests**

Prove SUCCESS with a valid patch and validations creates exactly one commit;
the candidate has one parent equal to base; exact changed files include
untracked additions and deletions; author and committer are the harness identity;
message is exactly `feat(<id>): <title>` and <=200 bytes; candidate tree equals
the staged tree that passed cached check; report candidate remains null without
discrepancy; CompletionRecord is normal/orchestrator; handoff uses official
validations and worker opinion fields; and authorized head advances only after
record, completion, handoff, and manifest exist consistently.

- [x] **Step 2: Run success tests and observe RED**

Run the focused finalizer test and confirm failures identify missing commit and
sealing phases.

- [x] **Step 3: Implement deterministic commit and sealing**

Derive and validate the message from PlanTask, stage exact paths, run cached
diff-check, capture the index tree, commit with exported harness identity, and
verify parents/files/message/tree/cleanliness. Write finalization, completion,
handoff, manifest, then state in the specified order. Existing records are
compared canonically and never overwritten on divergence.

- [x] **Step 4: Add RED crash and idempotence tests**

Inject crashes after commit, finalization record, and completion. Assert repeat
close creates no second commit, a valid record is sealable, divergent record or
candidate is refused, advanced HEAD alone is never PASS, and repeated execution
after PASS is idempotent.

- [x] **Step 5: Implement recovery verification and resume**

Recognize an exact direct-child candidate when the record is absent; rerun
official checks read-only and continue. Verify report/draft byte hashes,
recorded policy, patch fingerprint, candidate metadata and tree before sealing
an existing record. Extend `verifyCloseBundle` and `recover` without changing
the recovered M02 branch.

- [x] **Step 6: Add RED dispatch and legacy tests**

Assert worker-owned launch records call legacy `closeTask`, orchestrator-owned
records call the new finalizer, and launch records without policy use legacy.
Exercise both `dev-close` and `dev-orchestrate` with fake workers only. Re-run
the existing worker-owned close and recovered-finalization suites unchanged.

- [x] **Step 7: Implement dispatch and run focused GREEN suites**

Run:

```text
pnpm exec vitest run test/dev/finalize-orchestrated.test.ts test/dev/dev-close.test.ts test/dev/dev-recover.test.ts test/dev/protocol-e2e.test.ts test/dev/finalize-recovered.test.ts
```

Expected: all new and legacy focused suites pass with zero provider calls.

---

### Task 7: Review, final gates, one maintenance commit, adoption, and read-only verification

**Files:**
- Modify: this plan's checkboxes and outcome note.
- Maintenance commit: only reviewed source, tests, v2 profile, spec, and plan.
- Runtime after commit: one MaintenanceRecord and state update written by `dev-adopt-maintenance`.

**Interfaces:**
- Produces one local commit `feat(harness): move normal task commits to orchestrator`.
- Produces final evidence without launching a worker.

- [x] **Step 1: Review exact diff and historical hashes**

Confirm `dev/plan.yaml` and v1 profile have no diff; compare the baseline SHA-256
values recorded at session start for all M01/M02 packets, launch logs, inbox
artifacts, attempts, completions, handoffs, manifests, and recovered record.
Confirm no forbidden/runtime path is staged or intended for commit.

- [x] **Step 2: Run typecheck, build, and first complete suite**

Run separately:

```text
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

Stop immediately on any failure and investigate before continuing.

- [x] **Step 3: Run the second and third complete suites consecutively**

Run separately:

```text
pnpm test
pnpm test
```

Record duration and total test count for all three complete runs. All three must
be consecutive and green.

- [ ] **Step 4: Create exactly one maintenance commit**

Stage only the reviewed implementation/profile/test/spec/plan paths, never
`git add -A`, and run:

```text
git commit -m "feat(harness): move normal task commits to orchestrator"
```

Verify one parent equal to the starting HEAD, exact message, exact changed
files, and a clean index/working tree.

- [ ] **Step 5: Adopt maintenance through the harness**

Run:

```text
pnpm dev-adopt-maintenance --reason "mover commit e validação oficial do worker para o orquestrador"
```

Do not edit `.dev/state.json` manually.

- [ ] **Step 6: Run only final read-only checks and stop**

Run:

```text
pnpm dev-recover --dry-run
pnpm dev-doctor --profile codex-build-worker-subscription-high-v2
pnpm dev-next
```

Also invoke `verifyCloseBundle` directly for M01 and M02, inspect M03 state,
authorized head, Git status, maintenance commit parent/files, and process/log
evidence proving zero new real runs. Stop without executing M03 or pushing.

## Outcome

Implementation completed with legacy and recovered paths preserved. Typecheck,
build, diff-check, focused suites, and three consecutive complete suites were
green before the single maintenance commit; final adoption/read-only evidence
is reported in the task handoff.
