# Targeted Worker Validation Prompt Implementation Plan

> **For agentic workers:** Execute this plan inline in the current checkout. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `worker_validation_policy: targeted` normatively forbid packet-wide validation inside the provider sandbox while preserving legacy `full` behavior.

**Architecture:** Keep command enforcement unchanged and alter only the generated worker contract. Select validation instructions from `worker_validation_policy`, then compose them with the existing ownership-specific prompt so validation behavior derives from the validation policy rather than Git ownership.

**Tech Stack:** TypeScript, Vitest, pnpm

## Global Constraints

- Do not execute M03B or any real Codex, Claude, provider, or API run.
- Do not alter `dev/plan.yaml`, lifecycle, finalizers, recovery, Git ownership, or product schemas.
- Do not add OS command blocking, pnpm wrappers, an exec policy, or shell interception.
- Do not push.
- Create exactly one local commit named `fix(harness): keep targeted worker validation focused`.

---

### Task 1: Tighten the targeted prompt contract

**Files:**
- Modify: `dev/lib/prompt.ts`
- Test: `test/dev/prompt.test.ts`
- Track: `docs/superpowers/plans/2026-08-07-targeted-worker-validation-prompt.md`

**Interfaces:**
- Consumes: `ExecutionPolicy.worker_validation_policy` with values `full | targeted`.
- Produces: `buildWorkerPrompt(...)` with unchanged signature and preamble budget.

- [x] **Step 1: Record the current targeted preamble size**

Run a local script against the current compiled prompt and record the UTF-8 byte count before production edits.

Recorded: 2,489 bytes. The direct `tsx` probe hit the known sandbox-local
`listen EPERM`; compiling the current prompt to `/tmp` and running it with Node
produced the measurement without a provider invocation.

- [x] **Step 2: Write regression assertions first**

In `test/dev/prompt.test.ts`, require legacy `full` to keep instructing the worker to execute packet validations. Require `targeted` to explicitly forbid full `pnpm test`, global `pnpm build`, and replay of the full `packet.validation` list; assign the official suite exclusively to the orchestrator outside the provider sandbox; permit typecheck, the task's focused test, and small directly related tests; keep the existing Git mutation prohibitions; and keep the preamble at or below `MAXIMUM_PREAMBLE_BYTES`.

- [x] **Step 3: Prove RED**

Run `pnpm vitest run test/dev/prompt.test.ts`. Expected: the new targeted assertions fail because the prompt still uses permissive wording and lacks explicit command prohibitions.

Observed: 1 targeted test failed on the first missing normative sentence; the
remaining 4 tests passed.

- [x] **Step 4: Implement the minimal prompt change**

In `dev/lib/prompt.ts`, derive validation instructions from `executionPolicy.worker_validation_policy`. Preserve the full-policy wording. For targeted, use normative `NÃO execute` clauses for `pnpm test`, global `pnpm build`, and the complete `packet.validation` list; allow only development-focused checks and tell the worker not to investigate environmental failures from prohibited global validations.

- [x] **Step 5: Prove GREEN and review the patch**

Run `pnpm vitest run test/dev/prompt.test.ts`, measure the new targeted preamble byte count, and inspect the diff for policy coupling, scope, and budget.

First GREEN attempt: the generated prompt contained the required clause, but
the assertion treated its formatting newline as a literal space. The assertion
was corrected to accept whitespace at that wrap boundary before rerunning.

Observed: focused prompt suite passed 5/5. The targeted preamble is now 2,817
bytes, below the existing 4,096-byte limit; the change remains confined to the
validation-policy-selected text and its prompt tests.

- [x] **Step 6: Run all requested quality gates**

Run `pnpm typecheck`, `pnpm build`, `pnpm test`, and `git diff --check`. Stop and investigate any real failure; report environmental restrictions separately.

Observed: typecheck and build exited 0; the focused suite passed 5/5; the full
suite passed 341/341 outside the socket-restricted sandbox; and
`git diff --check` exited 0. The initial restricted full-suite run had 54
environmental `tsx listen EPERM` failures and was not treated as product
evidence.

- [ ] **Step 7: Commit and adopt maintenance**

Stage only the three files listed above, create exactly one commit with the required message, then run `pnpm dev-adopt-maintenance --reason "impedir suite oficial completa em workers targeted"`.

- [ ] **Step 8: Verify lifecycle without launching a worker**

Run `pnpm dev-recover --dry-run`, `pnpm dev-doctor --profile codex-build-worker-subscription-high-v2`, and `pnpm dev-next`. Confirm M01/M02/M03 PASS, M03B READY with zero attempts, `authorized_head_sha` equal to the maintenance commit, a clean tree, and zero provider runs. Stop without executing M03B.

## Outcome

- Prompt implementation and pre-commit verification completed. Maintenance
  adoption and lifecycle verification follow the immutable commit and are
  reported in the final handoff rather than by rewriting this committed plan.
