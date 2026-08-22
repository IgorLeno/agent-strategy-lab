# Autonomous Project Run Implementation Plan

> **For agentic workers:** Execute inline in this session. Keep every production change behind a focused failing test and do not launch M95-M126.

**Goal:** Connect the existing autonomous planning path to the existing executable project path so an operator supplies intake plus authorization, not a handwritten PlanFile.

**Architecture:** Add one release glue function and CLI. The glue inspects the target with inspectRepository, launches the existing read-only planning worker through runReviewedPath, projects the authorized ImplementationPlan through projectImplementationPlan, atomically persists one generated PlanFile, and delegates execution to runPlan. The generated PlanFile carries only source hashes and the planning base SHA so restart reuses it without silent regeneration.

**Tech Stack:** TypeScript, Zod, YAML, Vitest, existing fake provider/worker fixtures.

**Spec:** User-approved bounded v0.1 release request from 2026-08-22.

## Global Constraints

- Do not execute or edit the selection state of M95-M126.
- Do not create a planner, executor, router, retrieval system, event system, plan registry, concurrency layer, or knowledge store.
- Keep the coding worker free to explore and implement; do not add investigation instructions to TaskPacket.
- During development run focused tests only. Run pnpm typecheck, pnpm build, pnpm test, and git diff --check exactly once as the final gate.
- Maximum two commits, then push only after the final gate passes.

---

### Task 1: Generated Plan Contract and Base Binding

**Files:**
- Modify: src/planner/generate.ts
- Modify: dev/lib/schemas.ts
- Modify: dev/lib/run-plan.ts
- Modify: test/planner/generate-plan.test.ts
- Modify: test/dev/dev-run-plan.test.ts

**Interfaces:**
- Consumes: ImplementationPlan.source, projectImplementationPlan(), PlanFile, DevelopmentState.baseline_sha.
- Produces: optional PlanFile.generated_from with the existing intake, inspection, authorization-scope hashes and base_revision_sha.

- [x] Add focused failing assertions that projection preserves source binding and that a new generated plan refuses a mismatched repository base.
- [x] Run only those tests and confirm the expected failures.
- [x] Add the optional metadata to both projection and executable PlanFile schemas.
- [x] Make runPlan() compare the generated base to current HEAD for a new runtime and to baseline_sha for a resumed runtime.
- [x] Rerun only those tests and confirm they pass.

### Task 2: Planning-to-Execution Glue and Entrypoint

**Files:**
- Create: dev/lib/run-project.ts
- Create: dev/cli/dev-run-project.ts
- Modify: package.json
- Create: test/dev/run-project.test.ts

**Interfaces:**
- Consumes: ProjectIntakeRequest, loadProjectRunAuthorization(), inspectRepository(), collectProjectLaunchFacts(), createLaunchedPlanningWorker(), runReviewedPath(), projectImplementationPlan(), writeFileAtomic(), runPlan().
- Produces: runProject() and pnpm dev-run-project --repo PATH --request PROJECT-INTAKE --authorization AGENTLAB-RUN [--planner-profile ID].

- [x] Write focused failing tests for first generation and restart reuse without a second planner invocation.
- [x] Run the new test file and confirm the expected failure.
- [x] Implement the smallest glue: validate existing contracts, select an authorized planner profile, inspect, plan, project, persist, or reuse.
- [x] Add the CLI argument adapter and package script; retain the existing executor options needed for bounded runs.
- [x] Rerun only the new test file and confirm it passes.

### Task 3: One Fake End-to-End Proof

**Files:**
- Modify: fixtures/fake-worker.mjs
- Create: test/e2e/autonomous-project-run-e2e.test.ts

**Interfaces:**
- Consumes: the existing fake profile/process port, generated PlannerPacket, existing implementer protocol, official validation, and executor state.
- Produces: one deterministic objective to planner to generated plan to existing executor to accepted PASS scenario.

- [x] Write the single E2E first and run it to observe failure because the fake read-only role does not yet return a planner draft.
- [x] Extend the existing fake worker read-only branch to return a valid draft only when it receives a PlannerPacket; keep reviewer behavior unchanged.
- [x] Rerun only the E2E and confirm ALL_DONE, PASS state, and a reusable generated plan.

### Task 4: Release Documentation and Closing Gate

**Files:**
- Modify: README.md
- Modify: docs/ARCHITECTURE.md
- Modify: docs/BACKLOG.md

**Interfaces:**
- Consumes: the verified CLI and the changed roadmap direction.
- Produces: a short operational entrypoint note and the sentence that M95-M126 are evidence-triggered post-v0.1 backlog.

- [x] Update only the operational command/status and the short roadmap statement; do not reshape milestones.
- [x] Self-review the diff for scope, placeholders, contract consistency, and worker autonomy.
- [x] Run once: pnpm typecheck, pnpm build, pnpm test, git diff --check.
- [x] If all pass, create at most the requested feature commit plus one documentation commit if separation is useful, push, report, and stop.

## Outcome

The v0.1 entrypoint reuses the existing planner and executor, persists one
base-bound generated plan for restart, and passed the final gate with 143 test
files and 1999 tests. M95 remained unstarted.
