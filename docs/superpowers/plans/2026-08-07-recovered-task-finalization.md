# Recovered Task Finalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic, auditable orchestrator-owned finalization path for infrastructure-abandoned work and use it to recover M02 attempt 2 without another worker.

**Architecture:** Extend retry evidence compatibly, then implement recovered finalization in a separate library and CLI. Recovery acceptance requires a Git commit, an immutable RecoveredFinalizationRecord, and the existing sealed completion bundle to agree before state advances.

**Tech Stack:** TypeScript 5.7 ESM, Zod, Vitest, Node.js 22, YAML, Git subprocesses using argv only.

## Global Constraints

- Do not execute Codex, Claude, an API, or any real model.
- Do not execute M03.
- Do not push, create a PR, merge, amend, rebase, or hard-reset.
- Do not edit `.dev/state.json` manually.
- Do not rewrite the original M02 report or handoff draft.
- Preserve the worker's historical `FAILURE` and null candidate commit.
- Create exactly one maintenance commit and exactly one recovered M02 commit.
- `--commit-message` is required, trimmed non-empty, single-line, and at most 200 UTF-8 bytes; no fallback.
- Never use `git add -A`; pass paths and commit messages directly as subprocess argv.

---

### Task 1: Backward-compatible infrastructure abandonment evidence

**Files:**
- Modify: `test/dev/retry.test.ts`
- Modify: `test/dev/schemas.test.ts`
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/retry.ts`
- Modify: `dev/cli/dev-retry.ts`

**Interfaces:**
- Consumes: existing RUNNING/FINALIZING state, LaunchRecord, report, handoff, Git state.
- Produces: `AttemptAbandonmentReasonCode`, optional source-evidence fields on old records, and `allowInfraOutput` retry behavior.

- [x] **Step 1: Add RED tests for retry modes and compatibility**

Add behavioral cases proving normal no-output retry still succeeds; report
without `allowInfraOutput` fails; SUCCESS, non-null candidate, live process,
dirty tree, divergent HEAD, and invalid maintenance chain fail; valid FAILURE
records exact report/handoff byte hashes; old attempt records still parse.

- [x] **Step 2: Run RED tests**

Run: `pnpm exec vitest run test/dev/retry.test.ts test/dev/schemas.test.ts`

Expected: failures identify missing flags, reason-code type, hash fields, and
legacy-compatible schema.

- [x] **Step 3: Implement minimal retry support**

Parse `--allow-infra-output` and required `--reason-code` only in that mode.
Read valid report/handoff records, compare task IDs, require worker FAILURE and
null candidate, hash exact bytes with SHA-256, and populate the optional new
record fields. Leave no-output records in their existing shape.

- [x] **Step 4: Run GREEN tests**

Run: `pnpm exec vitest run test/dev/retry.test.ts test/dev/schemas.test.ts`

Expected: all retry and schema tests pass without provider processes.

### Task 2: Recovered record, path, parsing, and commit-message contract

**Files:**
- Create: `test/dev/finalize-recovered.test.ts`
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/paths.ts`
- Modify: `dev/lib/records.ts`
- Modify: `dev/lib/git.ts`

**Interfaces:**
- Consumes: source abandonment record and exact report/handoff bytes.
- Produces: `RecoveredFinalizationRecord`, deterministic record paths, exact commit-message reader, and working-tree file discovery.

- [x] **Step 1: Add RED schema and Git-boundary tests**

Cover required single-line 200-byte commit messages, recovery-record fields,
modified/added/deleted/untracked discovery, forbidden paths, and exact message
reading via `git log -1 --format=%B`.

- [x] **Step 2: Run RED tests**

Run: `pnpm exec vitest run test/dev/finalize-recovered.test.ts`

Expected: failures identify missing schema, path, and Git helpers.

- [x] **Step 3: Implement minimal schemas and helpers**

Add `recoveriesDir`, record read/write functions using atomic JSON, byte-length
validation with `Buffer.byteLength`, porcelain `-z` parsing, staged-path
inspection, explicit-path staging/restoration, deterministic commit env, and
exact commit-message lookup. Git calls remain argv arrays without shell.

- [x] **Step 4: Run GREEN tests**

Run: `pnpm exec vitest run test/dev/finalize-recovered.test.ts`

Expected: all new schema and Git-boundary cases pass.

### Task 3: Recovered finalization transaction

**Files:**
- Create: `dev/lib/finalize-recovered.ts`
- Create: `dev/cli/dev-finalize-recovered.ts`
- Modify: `package.json`
- Extend: `test/dev/finalize-recovered.test.ts`

**Interfaces:**
- Consumes: READY state, source attempt, abandonment hashes, loaded plan, real patch, validation runner, commit message.
- Produces: `finalizeRecovered(input): Promise<RecoveredFinalizationResult>` and the `pnpm dev-finalize-recovered` command.

- [x] **Step 1: Add RED precondition and validation tests**

Cover task not READY, missing/nonrecoverable abandonment, mutated report or
handoff, extra/missing/forbidden files, prior staging, wrong HEAD, another
RUNNING task, accepted task, empty patch, and validation failure with no commit.

- [x] **Step 2: Run RED precondition tests**

Run: `pnpm exec vitest run test/dev/finalize-recovered.test.ts`

Expected: failures are caused by the absent transaction.

- [x] **Step 3: Implement fail-closed validation phase**

Validate state and artifact hashes, compare actual/reported file sets, run the
plan validations in order followed by `git diff --check`, and recheck HEAD,
index, and files before staging.

- [x] **Step 4: Add RED commit and sealing tests**

Prove exactly one commit, direct parent, exact files, exact message, explicit
orchestrator ownership, preserved worker FAILURE, recovered mode, PASS handoff,
authorized head advancement, unchanged attempts/M01, and untouched M03.

- [x] **Step 5: Implement commit and sealing phase**

Stage only validated paths, commit with deterministic author/committer and
direct `-m` argv, verify parent/files/message/cleanliness, then write recovery,
completion, handoff, manifest, and state in the approved order. Restore only
the selected index paths if staging or commit fails.

- [x] **Step 6: Run GREEN transaction tests**

Run: `pnpm exec vitest run test/dev/finalize-recovered.test.ts`

Expected: all recovered finalization cases pass without provider calls.

### Task 4: Crash recovery and idempotence

**Files:**
- Modify: `dev/lib/recover.ts`
- Extend: `test/dev/dev-recover.test.ts`
- Extend: `test/dev/finalize-recovered.test.ts`

**Interfaces:**
- Consumes: candidate commit, partial/full recovery record and close bundle.
- Produces: reconciliation only when recovery evidence and sealed hashes agree.

- [x] **Step 1: Add RED crash-window tests**

Inject crashes after commit, recovery record, completion, and handoff. Prove an
advanced HEAD alone does not pass; a valid recovery plus partial bundle can be
completed without a second commit; a full second invocation is idempotent.

- [x] **Step 2: Run RED recovery tests**

Run: `pnpm exec vitest run test/dev/finalize-recovered.test.ts test/dev/dev-recover.test.ts`

Expected: failures identify missing recovered-bundle reconciliation.

- [x] **Step 3: Implement recovery verification and resume**

Verify recovery path identity, artifact hashes, reason allowlist, commit
existence/parent/files/message, and bundle hashes. Resume sealing from the
immutable recovery record; never create a second commit or accept bare HEAD.

- [x] **Step 4: Run GREEN recovery tests**

Run: `pnpm exec vitest run test/dev/finalize-recovered.test.ts test/dev/dev-recover.test.ts`

Expected: crash and idempotence coverage passes.

### Task 5: Maintenance gates and maintenance commit

**Files:**
- Modify: plan checkboxes and outcome note in this file.
- Maintenance scope: `dev/**`, `test/dev/**`, `package.json`, and these two docs only.

**Interfaces:**
- Consumes: completed harness implementation with M02 patch still stashed.
- Produces: one local commit `feat(harness): add recovered task finalization`.

- [x] **Step 1: Run focused and complete gates outside provider sandbox**

Run separately: `pnpm typecheck`; `pnpm build`; `pnpm test`; `git diff --check`.

Expected: all exit 0; no worker/model/API process.

- [x] **Step 2: Review exact maintenance diff and excluded paths**

Confirm no `src/core/**`, `test/core/**`, `.claude/**`, `.dev/**`,
`.dev-inbox/**`, or `dev/plan.yaml` path enters the commit.

- [ ] **Step 3: Create the sole maintenance commit**

Stage only reviewed maintenance paths and run:
`git commit -m "feat(harness): add recovered task finalization"`.

Expected: direct child of `1bc4811ea2aa1582b7ee819228a69a16545c7027`.

### Task 6: Abandon attempt 2 and adopt maintenance

**Files:**
- Runtime only: `.dev/attempts/M02/2-abandoned.json`, `.dev/state.json`, `.dev/maintenance/*.json`.

**Interfaces:**
- Consumes: clean maintenance HEAD and original worker artifacts.
- Produces: M02 READY with attempt 2 abandoned as `WORKER_ENVIRONMENT_BLOCKED`, then authorized maintenance HEAD.

- [ ] **Step 1: Execute infrastructure-output retry**

Run `pnpm dev-retry` with task M02, pending-maintenance and infra-output flags,
reason code `WORKER_ENVIRONMENT_BLOCKED`, and the approved human reason.

Expected: report/handoff bytes unchanged, attempts still 2, authorized head
still the pre-maintenance base.

- [ ] **Step 2: Adopt maintenance and dry-run recovery**

Run `pnpm dev-adopt-maintenance --reason "adicionar finalização recuperável após bloqueio de infraestrutura"`, then `pnpm dev-recover --dry-run`.

Expected: authorized head equals the maintenance commit; no unexpected
reconciliation.

### Task 7: Restore and finalize M02 without a worker

**Files:**
- Restore exactly: `stash@{0}` created as `M02 attempt 2 recovery snapshot`.
- Runtime recovery evidence and the validated M02 product files.

**Interfaces:**
- Consumes: exact stash, recovered finalization CLI, explicit commit message.
- Produces: one M02 commit and complete recovered PASS evidence.

- [ ] **Step 1: Restore the exact stash and verify scope**

Apply `stash@{0}` without dropping it. Stop on conflict. Confirm Git status
contains exactly the five report paths and no harness/runtime/config path.

- [ ] **Step 2: Execute recovered finalization**

Run:

```bash
pnpm dev-finalize-recovered \
  --task M02 \
  --source-attempt 2 \
  --commit-message "feat(M02): add independent core status dimensions" \
  --reason "worker produziu implementação válida; sandbox bloqueou Git e IPC do tsx"
```

Expected: official validations rerun, exactly one direct-child M02 commit,
worker report still FAILURE, M02 PASS with attempts 2, and authorized head at
the accepted commit.

- [ ] **Step 3: Run final read-only verification and stop**

Run: `pnpm dev-recover --dry-run`; `pnpm dev-next`; `git status --short`;
`git log --oneline --decorate -6`.

Expected: M01/M02 PASS, M03 READY and selected but not launched, clean tree,
valid recovery bundle, no live worker, no provider call, and no push.

## Outcome note

Harness implementation completed with observed RED/GREEN cycles. Focused tests
passed 93/93 outside the provider sandbox; final maintenance gates passed with
`pnpm typecheck`, `pnpm build`, 19 test files and 270/270 tests, plus
`git diff --check`. The M02 product patch remains isolated in `stash@{0}`;
maintenance scope contains only `dev/**`, `test/dev/**`, `docs/**`, and
`package.json`. No Codex, Claude, API, M03 execution, or push occurred.
