# Orchestrator-Owned Normal Task Finalization Design

## Goal

Move commit ownership and authoritative validation for future normal tasks from
the provider worker to the orchestrator, without changing the historical
meaning of worker-owned launches or recovered M02 evidence.

Under the new profile, the worker edits the working tree, may run targeted
development checks, writes an AgentCompletionReport and HandoffDraft, and
exits. The orchestrator verifies the exact patch, runs the TaskPacket's
official validations outside the provider sandbox, creates one candidate
commit, seals the close bundle, and advances state only after the bundle is
consistent.

## Historical and operational invariants

- `codex-build-worker-subscription-high-v1` remains semantically unchanged and
  continues to mean worker-owned commit, worker-owned official validation, and
  full worker validation.
- Existing profiles and LaunchRecords without execution-policy fields remain
  valid and are interpreted as `worker`, `worker`, `full`.
- No historical M01 or M02 artifact is rewritten.
- The recovered M02 finalization remains valid and continues to use
  `commit_origin: orchestrator_recovery`.
- `dev/plan.yaml` is neither changed nor extended with commit messages.
- No maintenance workflow launches M03, invokes Codex, Claude, a model or API,
  or performs a push.

## Execution policy

A shared, versioned `ExecutionPolicy` value contains:

```yaml
commit_owner: worker | orchestrator
official_validation_owner: worker | orchestrator
worker_validation_policy: full | targeted
```

`LauncherProfile` accepts the three fields with legacy-preserving defaults:

```yaml
commit_owner: worker
official_validation_owner: worker
worker_validation_policy: full
```

The new profile
`dev/profiles/codex-build-worker-subscription-high-v2.yaml` explicitly records:

```yaml
commit_owner: orchestrator
official_validation_owner: orchestrator
worker_validation_policy: targeted
```

The policy is fail-closed across fields. Until another combination has an
explicit launcher, prompt, finalizer, and recovery implementation, only these
two tuples are valid:

```text
worker / worker / full
orchestrator / orchestrator / targeted
```

Every mixed tuple is rejected by the schema. The doctor also reports the
effective tuple independently and fails if it is unsupported, so a profile
cannot be syntactically accepted while selecting undefined runtime semantics.

It otherwise preserves the v1 Codex subscription contract: `codex`,
`subscription_only`, ChatGPT subscription authentication, `gpt-5.6-sol`, high
reasoning, `workspace-write`, `ephemeral`, `sanitized_user_home`,
`--ignore-user-config`, `--ignore-rules`, and no API credential variables.

The v2 profile omits Git author and committer variables because the provider
worker never commits. The doctor requires a worker Git identity only when the
effective `commit_owner` is `worker`. For orchestrator ownership it emits an
independent passing or skipped check explaining that commit identity belongs
to the harness process outside the provider sandbox.

## Launch evidence

Every new LaunchRecord includes the effective `execution_policy` used for the
launch. The value is copied from the parsed profile before the provider process
starts and is present in both the initial and finalized versions of the record.

The profile is pre-launch intent. The LaunchRecord is immutable run evidence.
Closing and recovery dispatch from the LaunchRecord value and never reinterpret
a historical run by reloading a possibly changed profile.

The LaunchRecord schema applies the legacy execution policy when the field is
absent. This preserves parsing of historical records without rewriting their
bytes.

## Worker prompt

`buildWorkerPrompt` receives the effective execution policy. Its existing
worker-owned text remains the legacy branch, including the requirement to run
the packet validations and create exactly one commit.

For orchestrator ownership, the compact preamble states:

1. Execute only the packet task.
2. Start from the packet and `initial_files`, using directed searches.
3. Do not load skills or subagents unless the packet explicitly requests them.
4. Do not run `git add`, `git commit`, `git stash`, `git reset`, file checkout,
   or any command that changes HEAD or the index.
5. Edit only the task patch.
6. Run typecheck, focused tests, or other small checks only as useful for
   development.
7. Do not treat the full packet validation suite as a worker obligation.
8. State that official validation runs in the orchestrator outside the provider
   sandbox.
9. Define worker `SUCCESS` as "patch ready for official validation", require a
   null `candidate_commit`, exact `changed_files`, and only validations actually
   run by the worker.
10. Define HandoffDraft `PASS` as patch ready for validation and `FAIL` as no
    usable patch produced, then stop without starting another task.

The existing preamble byte budget remains enforced for both branches.

## Normal orchestrated finalizer

`dev/lib/finalize-orchestrated.ts` is a separate transaction from both
`closeTask` and recovered finalization. It accepts only launches whose recorded
execution policy has `commit_owner: orchestrator`.

For a new SUCCESS close it requires:

- task state `RUNNING` with phase `FINALIZING`;
- a finished, matching LaunchRecord and a process identity that is no longer
  alive;
- recorded `execution_policy.commit_owner: orchestrator`;
- valid report and handoff draft for the same task;
- `report.candidate_commit: null`;
- HEAD equal to `packet.base_sha`;
- an empty index;
- at least one real working-tree change;
- no other RUNNING task.

Real files come from porcelain Git status and include tracked modifications,
additions, deletions, renames or copies, and all untracked files. The unordered
set must exactly equal `report.changed_files`; extra actual files and absent
reported files are both refusals.

Discovery uses the machine-readable, NUL-delimited command:

```text
git status --porcelain=v1 -z --untracked-files=all
```

The parser reads the two status columns and NUL-separated path fields. For
rename and copy entries it consumes the additional original-path field rather
than parsing human-readable `old -> new` text. Spaces and other non-NUL path
characters therefore remain unambiguous.

These paths are always forbidden in the actual or reported set:

- `.dev/**`
- `.dev-inbox/**`
- `dev/plan.yaml`
- `.claude/**`
- `.agents/**`
- `.codex/**`

The finalizer never uses `git add -A`.

## Worker failure

When the worker report is `FAILURE`, the orchestrator creates no commit and
runs no official validations. It records a FAIL CompletionRecord from the real
HEAD, index, working-tree files, launch result, and report comparison; moves the
task to FAIL; writes no PASS handoff or close manifest; and preserves the
working tree for diagnosis.

The failure path still requires valid, task-matching launch, report, and draft
evidence and a dead worker process. Patch mismatch becomes a discrepancy in the
CompletionRecord rather than fabricated worker knowledge.

## Official validation failure

For worker SUCCESS, the finalizer runs the TaskPacket validation commands in
their authoritative order through the harness process.

The worker's validation list is not reused as official evidence. A timeout,
nonzero exit, or null exit is failure.

On any validation failure, no files are staged and no commit is created. The
CompletionRecord is FAIL with the official validation results, candidate and
accepted commit both null, and the state becomes FAIL without advancing
`authorized_head_sha`. The index remains clean and the working tree remains
available for diagnosis.

Immediately before and after official validation, the finalizer computes a
deterministic patch fingerprint from sorted entries containing path, porcelain
status, and SHA-256 of the current bytes. Deleted paths use an explicit null
content marker; rename and copy entries bind both source and destination.
Untracked files are read and hashed like tracked files. The canonical entry
sequence is SHA-256 hashed, and the two fingerprints must be identical.

A validation that changes bytes, status, or paths is refused even when the
unordered `changed_files` set remains unchanged. After fingerprint equality is
proved, the finalizer reconfirms HEAD, empty index, and the exact file set before
staging.

## Candidate commit

After all validations pass, the finalizer derives the message only from the
authoritative PlanTask:

```text
feat(<task.id>): <task.title>
```

The derived message must be non-empty, single-line, and no more than 200 UTF-8
bytes. Git receives the message and all paths as direct argv elements.

The finalizer stages only the exact validated file list, confirms the staged
path set, and runs:

```text
git diff --cached --check
```

This check runs after staging so new untracked files are included. If it fails,
the finalizer restores only those index entries and preserves the working-tree
patch. No commit or state advancement occurs.

Before committing, the finalizer captures the staged tree identity and
reconfirms that the index still contains exactly the validated paths. The
candidate's tree must equal that captured tree, proving that the content which
passed the cached diff check is exactly the content committed.

The commit uses:

```text
Agent Strategy Lab Harness <harness@agent-strategy-lab.invalid>
```

It then proves that the candidate exists, has exactly one parent equal to the
packet base, contains exactly the expected files, records the derived message,
and leaves both working tree and index clean.

## Orchestrated finalization record

After candidate verification, the finalizer atomically writes:

```text
.dev/finalizations/<task-id>/attempt-<N>.json
```

The `OrchestratedFinalizationRecord` contains:

- schema version, task ID, attempt, base SHA, and profile ID;
- the recorded execution policy;
- exact-byte SHA-256 hashes of report and handoff draft;
- report result and derived commit message;
- sorted unique changed files and official validation results;
- the stable pre/post-validation patch fingerprint;
- candidate commit, `commit_origin: orchestrator`, and finalization timestamp.

The normal orchestrator CompletionRecord additionally records the attempt and
canonical hash of this finalization record. These fields bind the normal close
bundle to the deterministic record used for crash recovery.

The transaction order is:

1. Validate state, launch, source artifacts, HEAD, index, file set, and initial
   patch fingerprint.
2. Run official validations, then require the same patch fingerprint and
   reconfirm HEAD, index, and file set.
3. Stage only exact paths, run `git diff --cached --check`, capture the staged
   tree, create the candidate, and verify that exact tree.
4. Atomically write OrchestratedFinalizationRecord.
5. Write CompletionRecord.
6. Write HandoffRecord.
7. Write CloseManifest last.
8. Update task state and `authorized_head_sha`.

## Crash consistency and idempotence

If HEAD advances by one exact candidate before the finalization record is
written, repeating `dev-close` verifies base, single parent, changed files,
derived message, clean checkout, report and draft identity, then continues
without creating a second commit. Official validations are rerun against the
candidate checkout. Candidate verification checks its stored tree and runs a
read-only whitespace check over the committed base-to-candidate diff.

If a valid finalization record exists, `dev-close` resumes deterministic
sealing. Existing artifacts must equal their expected canonical values; any
divergence is refused rather than overwritten.

`dev-recover` may finish sealing and state promotion only when the finalization
record, candidate commit, source hashes, execution policy, completion, handoff,
and manifest agree. An advanced HEAD without the record never promotes PASS.
A second close after PASS verifies or reuses the valid bundle and creates no
new commit.

## Completion and handoff semantics

`CompletionRecord.commit_origin` supports `worker`, `orchestrator`, and
`orchestrator_recovery`. Normal orchestrated success records:

```yaml
finalization_mode: normal
commit_origin: orchestrator
```

The original AgentCompletionReport remains embedded unchanged with
`candidate_commit: null`. This is expected under orchestrator ownership and is
not a discrepancy. `report_matches_evidence` compares only worker-owned facts:
the result contract and exact changed files.

The sealed HandoffRecord uses authoritative PASS, real changed files, official
validation results, and the candidate as accepted commit. Only decisions,
lessons, and next relevant files are copied from the draft.

## Dispatch

Both `dev-orchestrate` and `dev-close` read the matching LaunchRecord and apply
its effective policy:

```text
worker       -> closeTask
orchestrator -> finalizeOrchestratedTask
```

An old LaunchRecord without `execution_policy` resolves to the legacy worker
path. `dev-close` performs the same dispatch on repeated invocations after a
crash. The legacy close function does not gain ownership-mode branches.

## Verification strategy

Tests use temporary Git repositories, fake workers, injected validation
runners, and deterministic crash hooks. They never call a provider, model, or
API.

Coverage proves profile defaults and v2 policy, conditional doctor identity,
LaunchRecord evidence, both prompt branches and budget, exact working-tree
discovery (including spaces and rename/copy records), invalid policy tuples,
fingerprint rejection when validation mutates content, cached whitespace checks
for new files, index restoration after cached-check failure, all refusal paths,
worker and validation failure preservation,
candidate authorship and message, deterministic sealing, crash windows,
idempotence, policy-based dispatch, legacy `closeTask`, and unchanged validity
of M01 and recovered M02.

After focused RED/GREEN cycles, maintenance gates are:

1. `pnpm typecheck`
2. `pnpm build`
3. `pnpm test`
4. `git diff --check`
5. two more consecutive `pnpm test` runs

Any suite failure stops the workflow for investigation. Only after three
consecutive complete green suites may the single local maintenance commit be
created and adopted. Final commands are verification-only and must not launch
M03.

## Single-commit constraint

The design, implementation plan, code, tests, and v2 profile enter one local
commit:

```text
feat(harness): move normal task commits to orchestrator
```

There is no intermediate documentation commit because the explicit maintenance
contract requires exactly one local commit.
