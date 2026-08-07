# Recovered Task Finalization Design

## Goal

Recover work produced by an infrastructure-blocked worker without launching a
new model, rewriting the worker's evidence, or treating its historical
`FAILURE` as `SUCCESS`. The orchestrator independently revalidates the patch,
owns the recovery commit, and records why a final `PASS` is justified.

## Historical invariants

- The original AgentCompletionReport and HandoffDraft remain byte-for-byte
  unchanged.
- The source report remains `self_reported_result: FAILURE` with
  `candidate_commit: null`.
- The source attempt remains attempt 2; recovered finalization does not
  increment attempts or start a worker.
- A recovered `PASS` is an orchestrator decision supported by a validated
  commit and a sealed evidence bundle.
- M01 and all earlier attempt records remain unchanged; M03 is never launched.

## Retry with infrastructure output

`dev-retry` gains the explicit flags `--allow-infra-output` and
`--reason-code`. The closed `AttemptAbandonmentReasonCode` type initially
contains only `WORKER_ENVIRONMENT_BLOCKED`.

Normal retry keeps its existing behavior when report and handoff are absent.
When infrastructure output is allowed, retry additionally requires valid,
task-matching report and handoff records, a source report result of `FAILURE`,
no candidate commit in either state or report, a dead recorded process, a
finished matching LaunchRecord, a clean working tree, no other running task,
and the existing HEAD/maintenance-chain guards.

The abandonment record remains backward-compatible with schema-version-1
records. New records may additionally contain:

- `reason_code`
- `report_sha256`
- `handoff_draft_sha256`
- `source_report_result`
- `source_base_sha`

The hashes are SHA-256 over the exact file bytes, not canonicalized JSON. This
proves that the original worker artifacts were not rewritten after
abandonment. Retry writes the record first and then moves the task to READY,
preserving its attempt count and authorized head.

## Recovered finalization command

`dev-finalize-recovered` is a separate orchestration path rather than a mode of
normal `closeTask`. Its required inputs are:

```text
--task <id>
--source-attempt <positive integer>
--reason <non-empty text>
--commit-message <single-line message, non-empty after trim, at most 200 UTF-8 bytes>
```

There is no commit-message fallback and no inference from title, objective, or
task ID. The message is passed directly as `git`, `['commit', '-m', message]`.

The command accepts only READY tasks whose selected abandonment record has a
recoverable reason code. The initial allowlist contains only
`WORKER_ENVIRONMENT_BLOCKED`. It rechecks the exact report/handoff hashes,
historical `FAILURE`, null report candidate, authorized HEAD, absence of prior
staging, presence of a working-tree patch, absence of another RUNNING task,
and absence of an accepted commit.

## File ownership and validation

The actual patch set is parsed from Git porcelain output and includes tracked
modifications, additions, deletions, renames where applicable, and untracked
files. It must equal `report.changed_files` as an unordered set.

The following paths are always forbidden:

- `.dev/**`
- `.dev-inbox/**`
- `dev/plan.yaml`
- `.claude/**`
- `.agents/**`
- `.codex/**`

The command loads the task's validation commands from `dev/plan.yaml`, runs
them through the orchestrator validation runner, and then runs
`git diff --check`. Any failure occurs before staging or commit.

Only the validated files are passed to `git add -- <paths>`. `git add -A` is
never used. Immediately before staging, HEAD must still equal the finalization
base and the index must still be clean. If staging or commit fails, only the
index entries for those paths are restored; working-tree files are preserved.

Git author and committer use deterministic harness-owned environment values.
After commit, the command proves a single-parent relationship to the
finalization base, exact committed files, clean working tree, and exact commit
message via `git log -1 --format=%B <candidate>`.

## Evidence and sealed completion

The command atomically writes
`.dev/recoveries/<task>/attempt-<n>.json` with the approved fields, including
`commit_message` and `commit_origin: orchestrator_recovery`.

Completion metadata distinguishes the two finalization paths:

```text
finalization_mode: normal | recovered
commit_origin: worker | orchestrator_recovery
```

Normal close records use `normal` and `worker`. Recovered completion preserves
the original report object with `FAILURE`, records the orchestrator's official
validations and real changed files, and includes an explicit discrepancy that
the worker failed for infrastructure reasons but the orchestrator revalidated
and committed the implementation.

The sealed handoff is assembled field by field. Its authoritative result is
`PASS`; task ID, changed files, validations, and accepted commit come from the
orchestrator. Only decisions, lessons, and next relevant files are copied from
the draft.

## Transaction and crash recovery

The transaction order is:

1. Validate state, abandonment evidence, source artifacts, HEAD, index, and
   working-tree file set.
2. Execute all official validations and `git diff --check`.
3. Create and verify exactly one recovery commit.
4. Write RecoveredFinalizationRecord atomically.
5. Write CompletionRecord.
6. Write HandoffRecord.
7. Write CloseManifest last.
8. Update task state and `authorized_head_sha`.

`dev-recover` recognizes a recovered close only when the recovery record is
valid, its artifact hashes still match, its commit and message match Git, and
the ordinary completion/handoff/manifest hashes form a complete bundle. A
mere advanced HEAD is never enough. If a crash occurs after the commit,
re-running the finalizer resumes evidence sealing instead of creating another
commit. A fully successful second run is idempotent.

## Verification

Tests use temporary Git repositories, direct TypeScript calls, injected
validation runners, and fake subprocesses. They never call Codex, Claude, an
API, or M03. Maintenance gates are `pnpm typecheck`, `pnpm build`, `pnpm test`,
and `git diff --check`. The restored M02 patch is then finalized only through
the new command, which re-runs the three plan validations plus
`git diff --check`.
