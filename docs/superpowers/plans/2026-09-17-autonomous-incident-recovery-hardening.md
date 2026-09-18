# Autonomous Incident Recovery Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the reviewed PR #22 recovery gaps while preserving its durable-incident, read-only-investigator, authorized-remediation architecture.

**Architecture:** Put one typed terminal-to-recovery policy in front of incident persistence, share one injected Recovery Chat between advanced CLI and wizard, and distinguish same-process resume from a persisted HARNESS fresh-controller restart. MISSING_CONTEXT becomes a bounded local reconciliation followed by at most one re-investigation; investigator budgets count actual provider/profile invocations.

**Tech Stack:** TypeScript, Zod, Node.js fs/process APIs, `@inquirer/prompts`, existing argv-based Git helpers, Vitest, pnpm.

**Spec:** `docs/autonomous-incident-recovery-plan.md` plus the 2026-09-17 independent hardening request attached to this task.

## Global Constraints

- Preserve typed `HumanRequiredOutput`, `TechnicalBlockedOutput`, deterministic fingerprints, append-only incident attempts, existing repair primitives, authorized profile policy, canonical quota/credential checks, and bounded recovery.
- Non-TTY defaults to `stop`; only explicit `recovery_mode=auto` recovers without interaction.
- No profile-selection feature, new provider, billing, credentials, publication, destructive action, scope expansion, or authority expansion.
- HARNESS integration never resumes the parent runtime in the controller process that loaded the pre-repair modules.
- Local searches stay within the target repository, its Git refs/worktrees, the current/known Agent Lab runtime roots, persisted plans/artifacts, and repository documentation.
- Verification uses fake providers/ports and fixture Git repositories, never a real provider.

---

## Planned File Boundaries

- Create `dev/lib/recovery-prompt.ts` for prompt copy, injected selection, and cancellation mapping.
- Create `dev/lib/terminal-recovery-policy.ts` for terminal facts and pure eligibility decisions.
- Create `dev/lib/missing-context-reconciliation.ts` for bounded local source discovery and reconciliation manifests.
- Create `dev/lib/controller-restart.ts` for the persisted HARNESS restart contract and fresh-process adapter.
- Modify `dev/cli/lab.ts`, `dev/lib/lab-wizard.ts`, `dev/lib/lab.ts`, incident modules, and runtime persistence only where those boundaries connect.
- Add focused tests under `test/dev/` and one subprocess fixture only for the PID/fresh-process proof.

### Task 1: Shared Recovery Chat and Wizard Wiring

**Files:** Create `dev/lib/recovery-prompt.ts`; modify `dev/cli/lab.ts`, `dev/lib/lab-wizard.ts`; test `test/dev/recovery-prompt.test.ts`, `test/dev/lab-wizard.test.ts`.

**Interfaces:** Produce `createRecoveryDecisionPrompt({ select, write })`; add `recovery_decide` to `runLabWizard` input and `dispatchOptions()` so submit and resume receive the same callback.

- [x] Write failing injected-adapter tests for investigate, stop, `ExitPromptError`, and `AbortPromptError`.

```ts
const decide = createRecoveryDecisionPrompt({ write: output.push.bind(output), select: async () => selected });
await expect(decide(incident)).resolves.toBe(expected);
expect(output.join('')).toContain('Encontrei um problema técnico');
```

- [x] Run `pnpm vitest run test/dev/recovery-prompt.test.ts` and confirm it fails because the module is absent.
- [x] Implement the exact two-choice product prompt and map both cancellation errors to `stop` without logging a stack.

```ts
return input.select('Como deseja continuar?', [
  { name: 'Investigar e tentar corrigir automaticamente', value: 'investigate' },
  { name: 'Parar e mostrar diagnóstico', value: 'stop' },
]);
```

- [x] Pass one callback instance to advanced CLI and wizard; spread it from `dispatchOptions()` into new/existing/self submit and resume.
- [x] Run `pnpm vitest run test/dev/recovery-prompt.test.ts test/dev/lab-wizard.test.ts`; expect PASS without ANSI snapshots.
- [x] Commit with `git commit -m "fix(recovery): wire shared recovery chat through wizard"` (`74d8036`).

### Task 2: Typed Terminal Eligibility and Verification-Only Regression

**Files:** Create `dev/lib/terminal-recovery-policy.ts`; modify `dev/lib/lab.ts`, `dev/lib/lab-runtime.ts`; test `test/dev/terminal-recovery-policy.test.ts`, `test/dev/incident-recovery-lab.test.ts`.

**Interfaces:** Produce closed `TerminalRecoveryFacts`; produce pure `classifyTerminalRecovery(facts)`; collect facts separately from persisted completion/state artifacts.

- [x] Write the exhaustive failing policy table.

```ts
expect(classifyTerminalRecovery(typedBlocked).eligible).toBe(true);
expect(classifyTerminalRecovery(verificationOnlyValidationFail).eligible).toBe(true);
expect(classifyTerminalRecovery(officialValidationFail).eligible).toBe(true);
expect(classifyTerminalRecovery(infraError).eligible).toBe(true);
expect(classifyTerminalRecovery(timedOut).eligible).toBe(true);
expect(classifyTerminalRecovery(preflightTechnicalBlock).eligible).toBe(true);
expect(classifyTerminalRecovery(humanRequired).eligible).toBe(false);
expect(classifyTerminalRecovery(allDone).eligible).toBe(false);
expect(classifyTerminalRecovery(workerReportedFailure).eligible).toBe(false);
expect(classifyTerminalRecovery(untypedFail).eligible).toBe(false);
```

- [x] Implement policy: typed BLOCKED, official validation FAIL (including verification-only), and exhausted typed INFRA/TIMEOUT/PREFLIGHT failures are eligible; HUMAN_REQUIRED, ALL_DONE/LIMIT_REACHED, worker-declared FAILURE, untyped FAIL, and MISSCOPED without a typed technical cause are excluded.
- [x] Gather FAIL kind from authoritative completion/revalidation records; never classify by matching prose.
- [x] Replace `technicalHaltFromPayload()` as the sole gate in `persistTechnicalRecoveryCandidate()` while retaining it as the BLOCKED parser.
- [x] Add the required regression: `verification_only`, process success, official validation FAIL, `project_lifecycle.halt=null`, TTY ask→investigate, investigator called, runtime not immediately terminated.
- [x] Run `pnpm vitest run test/dev/terminal-recovery-policy.test.ts test/dev/incident-recovery.test.ts test/dev/incident-recovery-lab.test.ts`; 30 tests passed.
- [x] Commit with `git commit -m "fix(recovery): classify eligible terminal technical failures"` (`369f189`).

### Task 3: Real Evidence and Launch-Level Investigator Budget

**Files:** Modify `dev/lib/incident-recovery.ts`, `dev/lib/incident-investigator.ts`, `dev/lib/incident-recovery-coordinator.ts`, `dev/lib/lab-runtime.ts`; test the corresponding three focused suites.

**Interfaces:** `IncidentInvestigatorPort.investigate({ incident, maximumLaunches })` returns a diagnosis/unavailable union plus one `InvestigatorLaunchEvidence` per actual profile invocation. `incrementRecoveryUsage` accepts an integer launch delta.

- [x] Add a failing stop-mode test with `evidence_paths=[]` and assert persisted diagnosis evidence points to an artifact that exists.
- [x] Persist a structured terminal lifecycle record, then pass its real path to `diagnosticFromTechnicalHalt`; never invent a nonexistent path.
- [x] Add a failing three-profile test with only two launches remaining; assert only two profiles run and two launch records persist.
- [x] Return launch evidence for every attempted profile and cap failover by `maximumLaunches`.

```ts
const remaining = incident.budget.max_investigator_launches - usage.investigator_launches;
const result = await investigator.investigate({ incident, maximumLaunches: remaining });
await incrementRecoveryUsage(runtimeDir, incident.incident_id, { investigator_launches: result.launches.length });
```

- [x] Run `pnpm vitest run test/dev/incident-recovery.test.ts test/dev/incident-investigator.test.ts test/dev/incident-recovery-lab.test.ts`; 23 tests passed with exact launch counts and bounded fingerprints.
- [x] Commit with `git commit -m "fix(recovery): account for real investigator launches"` (`c658ce1`).

### Task 4: Bounded MISSING_CONTEXT Reconciliation

**Files:** Create `dev/lib/missing-context-reconciliation.ts`; modify remediation, coordinator, and runtime persistence; add `test/dev/missing-context-reconciliation.test.ts` and integrated cases.

**Interfaces:** Produce `MissingContextResolution` with `FOUND_RECOVERABLE`, `NOT_FOUND_BUT_RECONSTRUCTIBLE`, `NOT_FOUND_REQUIRES_HUMAN`, or `NOT_FOUND_TECHNICAL`; remediation may return `REINVESTIGATE` with reconciled evidence paths.

- [x] Create a failing WP0 fixture: target checkout lacks `docs/WP0.md`, while an authorized sibling worktree/previous runtime contains it.
- [x] Implement explicit limits: 16 worktrees, 64 local refs, 32 previous runtimes, 16 matches, and 1 MB per artifact.
- [x] Search only exact relative paths/basenames in current checkout, local Git refs/history/worktrees, same-target known runtimes, persisted plans/artifacts/workspaces, and repository docs; never walk HOME or the global filesystem.
- [x] Persist a content-addressed reconciliation manifest with source, ref/runtime, relative path, size, and SHA-256.
- [x] On found or deterministically reconstructible evidence, re-run the investigator once with the reconciled evidence view, then route its new classification through the ordinary authorized remediation path.

```ts
if (outcome.status === 'REINVESTIGATE' && reconciliationDepth === 0) {
  return investigateAndRemediate({
    incident: { ...incident, evidence_paths: outcome.evidence_paths },
    reconciliationDepth: 1,
  });
}
```

- [x] When nothing is found and no real authority exists, return `NOT_FOUND_TECHNICAL`→BLOCKED and assert no `human_authority` is emitted.
- [x] Run `pnpm typecheck` plus `pnpm vitest run test/dev/missing-context-reconciliation.test.ts test/dev/incident-remediation.test.ts test/dev/incident-recovery.test.ts test/dev/incident-recovery-lab.test.ts`; 28 tests passed with WP0 continuation and honest absent-artifact BLOCKED.
- [x] Commit with `git commit -m "fix(recovery): reconcile missing context from bounded local sources"` (`a5539da`).

### Task 5: HARNESS Fresh-Controller Restart Contract

**Files:** Create `dev/lib/controller-restart.ts`; modify coordinator, runtime persistence, lab, CLI, and wizard dispatch; add `test/dev/controller-restart.test.ts` and `test/dev/fixtures/recovery-restart-controller.ts`.

**Interfaces:** Add `RESTART_REQUIRED` to remediation/recovery results. Persist `HarnessRestartRecord` with parent runtime, incident id, nested recovery runtime, integrated SHA, original entry intent, resume target, and `INTEGRATED_PENDING_RESUME | RESUME_STARTED | RESUMED` state.

- [x] Add a failing coordinator test asserting successful HARNESS integration returns `RESTART_REQUIRED` and old-controller `executeProject` resume count stays zero.
- [x] Persist the restart record atomically immediately after successful self-maintenance integration.
- [x] Return explicit library exit code `75` for unhandled `RESTART_REQUIRED`; when the CLI performs the restart, mirror the fresh child exit code instead.
- [x] Wrap wizard and advanced submit/resume with one restart adapter that spawns the current Node/tsx entrypoint using argv (no shell), inherited stdio, and `resume <parent-runtime>`.
- [x] On fresh resume, detect `INTEGRATED_PENDING_RESUME`, mark `RESUME_STARTED`, resume the parent directly, and never repeat completed self-maintenance.
- [x] Add subprocess E2E assertions: integration PID differs from resume PID; old process never resumes; parent-child incident relation and integrated SHA persist; crash between integration and spawn is recoverable by a later resume.
- [x] Run `pnpm typecheck` and `pnpm vitest run test/dev/controller-restart.test.ts test/dev/incident-recovery-lab.test.ts test/dev/lab-wizard.test.ts test/dev/lab-wizard-dispatch.test.ts`; 50 tests passed with distinct PIDs (outside sandbox because `tsx` IPC is restricted there).
- [x] Commit with `git commit -m "fix(recovery): resume harness repair in a fresh controller"`.

### Task 6: Safe ENVIRONMENT/PROVIDER Audit and Authority Tests

**Files:** Modify `dev/lib/incident-remediation.ts` only if an existing safe primitive composes cleanly; test `test/dev/incident-remediation.test.ts`, `test/dev/incident-recovery-authority.test.ts`.

**Interfaces:** Reuse only canonical preflight refresh/reinspection and policy-bounded provider retry/failover. Otherwise retain explicit FAILED/BLOCKED with the missing primitive named.

- [ ] Inventory existing ENVIRONMENT/PROVIDER primitives and write a test before each composition.
- [ ] Compose only primitives whose preconditions are already proven by persisted runtime artifacts; do not install, mutate global state, expand provider policy, request credentials, or change billing.
- [ ] Keep explicit technical BLOCKED where no safe primitive exists.
- [ ] Assert recovery creates no publish, provider, billing, credential, write-capability, or scope grant.
- [ ] Run `pnpm vitest run test/dev/incident-remediation.test.ts test/dev/incident-recovery-authority.test.ts`; expect PASS.
- [ ] Commit any verified safe composition with `git commit -m "fix(recovery): compose existing safe remediation primitives"`; omit this commit if the audit correctly leaves both classes blocked.

### Task 7: Documentation, Full Gates, Push, and PR

**Files:** Modify `docs/autonomous-incident-recovery-plan.md`, `docs/LESSONS.md`, and this plan.

- [ ] Document the exact eligibility table, restart state machine, MISSING_CONTEXT outcomes, real launch accounting, final ENVIRONMENT/PROVIDER behavior, and remaining gaps.
- [ ] Add the formal lesson: after HARNESS integration, persist a restart contract and resume only in a fresh process; on-disk source changes do not refresh loaded modules.
- [ ] Run all new focused tests, including the subprocess E2E, and record exact results.
- [ ] Run `pnpm typecheck`; expect exit 0.
- [ ] Run `pnpm build`; expect exit 0.
- [ ] Run `pnpm test`; expect exit 0 for the full suite.
- [ ] Run `git diff --check`; expect exit 0 and no output.
- [ ] Review `git status --short`, `git diff --stat origin/main...HEAD`, graph impact, and `git log --oneline origin/main..HEAD`; scope must remain recovery/wizard/tests/docs only.
- [ ] Mark only actually completed checkboxes and append a concise outcome/evidence note to this plan.
- [ ] Commit verified docs with `git commit -m "docs: record incident recovery hardening evidence"`.
- [ ] Push `fix/autonomous-incident-recovery-hardening`, open a PR targeting `main`, and do not merge it.
