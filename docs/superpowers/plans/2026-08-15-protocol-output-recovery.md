# Protocol-Output Recovery Implementation Plan

> **For agentic workers:** Execute inline in the independent clone. Do not dispatch providers or task workers. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clarify that protocol I/O never belongs to `changed_files` and safely return a proven protocol-invalid orchestrator-owned attempt to `READY` without a capability or official-validation verdict.

**Architecture:** Add a dedicated `ProtocolInvalidAttemptRecord` and `dev-recover-protocol-output` flow under `dev/**`. The flow performs a read-only preflight against state, LaunchRecord, inbox bytes, Git HEAD/index/worktree and exact protocol paths; publishes byte-exact append-only evidence and a terminal manifest record; then performs path-scoped cleanup, crash-safe inbox release and state transition in that order. Existing finalizer restrictions remain unchanged.

**Tech Stack:** TypeScript, Zod, Node.js filesystem/crypto APIs, Git plumbing, Vitest, pnpm/tsx.

**Spec:** User-approved maintenance contract in the 2026-08-15 task request.

## Global Constraints

- Work only in the independent clone until the new CLI is committed and fully verified.
- Do not modify `src/**`, `test/adapters/**`, `dev/plan.yaml`, product fixtures or `pnpm-lock.yaml`.
- Do not run a provider, `dev-orchestrate`, M56 attempt 2 or M57.
- Preserve original M56 report/handoff bytes; never create a CompletionRecord for attempt 1.
- Create exactly one maintenance commit, with the required message, directly on `c8d8e4ae3df81848e48cfaee63e5da12ac6301eb`.

---

### Task 1: Make protocol I/O exclusion explicit in the worker prompt

**Files:**
- Modify: `test/dev/prompt.test.ts`
- Modify: `dev/lib/prompt.ts`

**Interfaces:**
- Consumes: `buildWorkerPrompt(packet, io, ORCHESTRATED_EXECUTION_POLICY)`.
- Produces: an orchestrator-owned preamble stating that `changed_files` lists only repository patch candidates and excludes `reportPath`, `handoffDraftPath`, `.dev`, `.dev-inbox` and protocol files.

- [x] Add an assertion to the orchestrator-owned prompt test for the exact exclusion contract and absence of ambiguity.
- [x] Run `pnpm vitest run test/dev/prompt.test.ts` and confirm the new assertion fails for the missing instruction.
- [x] Add the shortest unambiguous wording to the orchestrator-owned branch in `dev/lib/prompt.ts`.
- [x] Run the focused test and confirm both contract and preamble-budget tests pass.

### Task 2: Define append-only protocol-invalid evidence

**Files:**
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/records.ts`
- Create: `test/dev/protocol-output-recovery.test.ts`

**Interfaces:**
- Produces: `ProtocolInvalidPatchFile`, `ProtocolInvalidAttemptRecord`, `protocolInvalidAttemptPath()`, `readProtocolInvalidAttempt()` and `writeProtocolInvalidAttempt()`.
- Record invariants: `classification: 'PROTOCOL_OUTPUT_INVALID'`, worker `SUCCESS`, handoff `PASS`, null candidate/accepted commits, orchestrator/orchestrator execution policy, exactly two normalized protocol-invalid paths, sorted unique real patch paths, hashes/sizes/archive paths for present files and explicit absent-content markers for deletions.

- [x] Add schema/record-path tests that reject capability/validation semantics, unsorted paths, incomplete hashes, inconsistent deletion markers and a policy not owned by the orchestrator.
- [x] Run the focused test and confirm RED because the new schema and record API do not exist.
- [x] Implement the minimal strict Zod schemas and record read/write helpers using the existing canonical append-only writer.
- [x] Run the focused test and confirm the schema/path cases pass.

### Task 3: Implement fail-closed preflight and archival

**Files:**
- Create: `dev/lib/protocol-output-recovery.ts`
- Modify: `test/dev/protocol-output-recovery.test.ts`

**Interfaces:**
- Produces: `recoverProtocolOutput(input: ProtocolOutputRecoveryInput): Promise<ProtocolOutputRecoveryResult>`.
- Preflight requires `RUNNING/FINALIZING`, dead recorded process, one running task, finished matching LaunchRecord, orchestrator/orchestrator policy, null candidate/accepted commits, `HEAD == task.base_sha == authorized_head_sha`, empty index, valid same-task `SUCCESS` report with null candidate, valid same-task `PASS` handoff, identical declared arrays, exactly the two current inbox protocol paths as invalid extras, and exact equality between normalized declaration and real worktree paths.
- Archive layout: `.dev/failed-attempts/<task>/attempt-<n>/protocol-invalid/`, containing byte-exact report, handoff, launch record, present-file blobs, explicit file metadata, patch evidence and the append-only record.

- [x] Add the M56-equivalent happy-path test and prove RED.
- [x] Add refusal tests for extra forbidden path, extra real file, missing reported path, divergent HEAD, dirty index and live process; each snapshots state, inbox, patch and record absence before calling.
- [x] Implement path normalization, Git/state/LaunchRecord/process checks and no-write preflight.
- [x] Implement archival with `writeFileOnce`: protocol bytes, LaunchRecord bytes, per-file bytes, patch bundle, then `ProtocolInvalidAttemptRecord` last.
- [x] Run focused tests and confirm accepted/refusal/archive-byte cases pass.

### Task 4: Implement scoped cleanup, crash recovery and state transition

**Files:**
- Modify: `dev/lib/protocol-output-recovery.ts`
- Modify: `test/dev/protocol-output-recovery.test.ts`

**Interfaces:**
- Cleanup consumes only `record.patch_files`: restore base-present tracked paths and remove only base-absent untracked paths.
- Inbox release consumes the archived report/handoff hashes through `releaseCurrentInboxArtifacts()`.
- State transition preserves attempts/base/authorized head, sets `READY`, null phase/process/candidate/accepted, and records diagnostics that no capability verdict was produced.

- [x] Add tests for tracked restoration, untracked removal, READY transition, unchanged authorized head/attempt count and no CompletionRecord.
- [x] Add crash hook before completed archive and prove patch/inbox/state remain untouched.
- [x] Add crash hook after record publication and before cleanup/state; rerun must verify the record and converge.
- [x] Add rerun-after-READY idempotency and divergent-existing-bytes refusal tests.
- [x] Implement record-first resume, path-scoped idempotent cleanup, crash-safe inbox release and state write last.
- [x] Run the focused suite and confirm all recovery/crash cases pass.

### Task 5: Add CLI and documentation

**Files:**
- Create: `dev/cli/dev-recover-protocol-output.ts`
- Modify: `package.json`
- Modify: `docs/HARNESS.md`
- Modify: `docs/LESSONS.md`
- Modify: `test/dev/protocol-output-recovery.test.ts`

**Interfaces:**
- CLI: `pnpm dev-recover-protocol-output --repo <path> --task <id> --reason <text>` under `withHarnessLock()`.
- Output: structured JSON containing record path, classification, attempt, patch paths and idempotency status.

- [x] Add CLI argument/JSON-output test and confirm RED because the entrypoint/script are absent.
- [x] Implement the minimal CLI and package script without dependencies.
- [x] Document the dedicated recovery, ordering and capability-neutral classification in `docs/HARNESS.md`.
- [x] Add the dated formal lesson to `docs/LESSONS.md` in the required Context/Mistake/Rule format.
- [x] Run prompt and protocol-output focused suites.

### Task 6: Verify and create the single maintenance commit

**Files:** all allowed files changed by Tasks 1–5 and this plan.

- [x] Run `pnpm typecheck`.
- [x] Run `pnpm build`.
- [x] Run `pnpm test`.
- [x] Run `git diff --check`.
- [x] Audit `git diff --name-only` against the allowlist and confirm forbidden paths are absent.
- [x] Confirm `git rev-list --count c8d8e4ae3df81848e48cfaee63e5da12ac6301eb..HEAD` is zero before committing.
- [x] Create exactly one commit: `fix(harness): recover protocol-invalid worker output safely`.
- [x] Confirm its parent is exactly `c8d8e4ae3df81848e48cfaee63e5da12ac6301eb` and its changed files are allowlisted.

### Task 7: Recover and audit the original checkout

**Files:** runtime artifacts only in `/home/plasma-test/Projetos/agent-strategy-lab/.dev/**` and `.dev-inbox/**`, managed by the new CLI.

- [ ] Reconfirm original report/handoff hashes, HEAD, authorized head, M56 state, dead process, empty index and exact patch before execution.
- [ ] Run the committed CLI from the clone against the original repo with the approved reason.
- [ ] Verify original checkout is clean, HEAD/authorized head unchanged, M56 READY with attempts 1, no CompletionRecord, and byte-exact append-only archives/patch evidence.
- [ ] Rerun the CLI with the same reason and confirm idempotent convergence.

### Task 8: Publish, adopt and stop before provider execution

- [ ] Confirm `origin/main` still equals `c8d8e4ae3df81848e48cfaee63e5da12ac6301eb`.
- [ ] Push normally with `git push origin HEAD:main`; never force.
- [ ] Fast-forward the original checkout to the maintenance commit without disturbing runtime evidence.
- [ ] Run `pnpm dev-adopt-maintenance --reason "Correção auditada do harness: protocol I/O excluído de changed_files e recovery append-only para o attempt M56 protocol-invalid, sem capability verdict"`.
- [ ] Run `pnpm dev-recover --dry-run` and require `CLEAN`.
- [ ] Run `pnpm dev-next` and require M56, attempt 2 and `ready_to_launch: true`.
- [ ] Confirm no M57/provider/orchestration execution and stop for human audit.
