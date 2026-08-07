# Audited Validation Revalidation Implementation Plan

> **Execution:** inline in the authorized `main` checkout. The approved workflow requires a pathspec-only stash, maintenance adoption, and restoration on the new authorized base; do not create a worktree or run a worker/provider.

**Goal:** Add append-only validation evidence and a fail-closed `dev-revalidate` transaction that reuses an unchanged orchestrator-owned patch after an official nondeterministic validation failure.

**Architecture:** Keep historical worker and FAIL evidence immutable. A pre-stash source binding anchors the original completion bytes, report, handoff, source base, changed paths, and a fingerprint explicitly derived during revalidation preflight. Validation executions write monotonically sequenced stdout/stderr logs plus typed hash metadata. A separately sequenced revalidation record binds the historical source to a candidate whose parent is the post-maintenance `finalization_base_sha`; a sealed PASS bundle is required before state promotion.

**Tech Stack:** TypeScript, Zod, Node.js filesystem/crypto/child-process APIs, Git plumbing, Vitest, pnpm.

## Global Constraints

- Never run M03B with a worker, Codex, Claude, a model, or an API.
- Never run M04 and never push.
- Never alter the M03B patch, report, handoff draft, or historical FAIL bytes.
- Preserve old `ValidationResult` and historical record parsing byte-for-byte.
- `source_base_sha` identifies the historical patch origin; `finalization_base_sha` is the authorized parent of the candidate.
- Revalidation records and validation logs are append-only and monotonically sequenced.
- The maintenance commit message is exactly `feat(harness): add audited validation retry`.
- The M03B candidate message is exactly `feat(M03B): EvaluationPlan mínimo (privado)`.

---

### Task 1: Seal the pre-stash source binding

**Files:**
- Create runtime evidence: `.dev/revalidations/M03B/attempt-1/original-completion.fail.json`
- Create runtime evidence: `.dev/revalidations/M03B/attempt-1/source-binding.json`

- [x] Archive the exact current CompletionRecord FAIL bytes and verify `cmp` plus raw SHA-256.
- [x] Record task/attempt, `source_base_sha`, three source hashes, sorted changed files, derived patch fingerprint, observation time, and `fingerprint_provenance: derived_during_revalidation_preflight`.
- [x] Verify current report and completion still describe worker SUCCESS with null candidates and one official failure.

### Task 2: Preserve only the M03B product patch

**Files:**
- Stash only: `src/schemas/evaluation-plan.ts`
- Stash only: `src/schemas/index.ts`
- Stash only: `test/schemas/evaluation-plan.test.ts`

- [x] Create a pathspec-only stash including the two untracked files.
- [x] Verify the stash contains exactly the three approved paths.
- [x] Verify no M03B product path remains in the maintenance working tree and runtime/`.claude` paths were not stashed.

### Task 3: Define schemas and immutable record paths using TDD

**Files:**
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/paths.ts`
- Modify: `dev/lib/records.ts`
- Test: `test/dev/schemas.test.ts`
- Test: `test/dev/revalidation-records.test.ts`

- [x] Write failing tests proving legacy `ValidationResult` bytes still parse unchanged.
- [x] Write failing tests for typed validation metadata, source binding, checkpoint, and PASS/FAIL `OrchestratedRevalidationRecord` invariants.
- [x] Write failing tests for monotonic revalidation paths and immutable-write rejection on divergent bytes.
- [x] Implement only the schemas/path/read-write functions required to pass.

### Task 4: Preserve official validation stdout/stderr using TDD

**Files:**
- Create: `dev/lib/validation-evidence.ts`
- Modify: `dev/lib/exec.ts`
- Modify: `dev/lib/close.ts`
- Modify: `dev/lib/finalize-orchestrated.ts`
- Modify: `dev/lib/finalize-recovered.ts`
- Test: `test/dev/validation-evidence.test.ts`
- Update focused finalization tests as required by the typed execution result.

- [x] Write failing tests that execute a local fixture and assert exact bytes, SHA-256, byte counts, argv/result metadata, and monotonically increasing sequence numbers.
- [x] Write a failing test that existing evidence cannot be overwritten with different bytes.
- [x] Implement an official-validation runner that writes stdout/stderr and metadata atomically without returning raw output in structured records.
- [x] Route future TaskPacket validations and cached/committed diff checks through this runner while preserving historical optionality.

### Task 5: Implement fail-closed `dev-revalidate` using TDD

**Files:**
- Create: `dev/lib/revalidate.ts`
- Create: `dev/cli/dev-revalidate.ts`
- Modify: `package.json`
- Test: `test/dev/revalidate.test.ts`

- [x] Write failing precondition tests for non-FAIL, worker FAILURE, no official failure, source hash drift, fingerprint drift, extra/staged/forbidden paths, candidates, divergent bases, and another RUNNING task.
- [x] Write failing transaction tests for official-list-once, original-failures repeated once, failed revalidation/no commit, exact stage/diff-check, parent/message/files, and source/finalization base separation.
- [x] Write failing crash/idempotence tests for checkpoint-before-commit, crash-after-commit, append-only revalidation numbering, and second execution after PASS.
- [x] Implement source verification before any command, append-only checkpoint/record persistence, exact index restoration, deterministic harness commit, PASS bundle sealing, and state promotion.

### Task 6: Harden bundle verification and recovery using TDD

**Files:**
- Modify: `dev/lib/recover.ts`
- Test: `test/dev/dev-recover.test.ts`
- Test: `test/dev/revalidate.test.ts`

- [x] Write failing tests proving candidate/HEAD alone cannot promote PASS.
- [x] Write failing tests requiring the original FAIL archive, source binding, source hashes, PASS revalidation record, correct candidate, Completion/Handoff, and close manifest.
- [x] Implement revalidation verification/sealing before promotion and preserve existing normal/recovered finalization paths.

### Task 7: Maintenance gates and the single harness commit

- [x] Run focused RED/GREEN suites during each preceding task.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm build`.
- [x] Run `pnpm test`.
- [x] Run `git diff --check`.
- [x] Review the exact diff and verify no M03B product patch/runtime evidence is tracked.
- [ ] Create exactly one commit: `feat(harness): add audited validation retry`.

### Task 8: Adopt maintenance and restore the anchored patch

- [ ] Run `pnpm dev-adopt-maintenance` with an audit reason and verify `authorized_head_sha` advances to the maintenance commit.
- [ ] Restore exactly the three M03B paths from the pathspec-only stash; stop on any conflict.
- [ ] Verify report, handoff, original FAIL archive, source binding, and patch fingerprint before any revalidation command.

### Task 9: Revalidate and audit M03B

- [ ] Run the approved `pnpm dev-revalidate` command once.
- [ ] Verify validation order: typecheck, focused test, full test, repeated full test, cached diff-check.
- [ ] Verify candidate parent equals `finalization_base_sha`, exact files/message, and clean index/tree.
- [ ] Verify Completion PASS references the revalidation record while the original FAIL bytes remain archived.
- [ ] Verify M03B PASS with attempts 1, M04 READY, `dev-recover --dry-run` empty, and zero provider runs.
- [ ] Report maintenance/candidate SHAs, source hashes, fingerprint, validation results/log hashes, and final state; stop without M04 or push.
