# Autonomous Incident Recovery

## Scope and authority

Agent Lab may investigate and remediate a closed set of terminal technical failures without changing the meaning or authority of `HumanRequiredOutput`. Recovery may inspect persisted evidence, invoke the read-only investigator through profiles already present in `profile_policy`, use existing repair/lifecycle primitives, reconcile bounded local context, and resume the same runtime. It never grants billing, credentials, publication, destruction, provider/profile expansion, product scope, or human authority.

Interactive runs use one shared Recovery Chat in the advanced CLI and wizard. It presents `Investigar e tentar corrigir automaticamente` (`investigate`) and `Parar e mostrar diagnóstico` (`stop`); Ctrl+C/Ctrl+D map to `stop`. Non-TTY runs default to `stop`, while autonomous recovery requires an explicitly persisted `recovery_mode=auto`.

## Terminal eligibility

`collectTerminalRecoveryFacts` reads authoritative lifecycle, completion, revalidation, state, and preflight records. `classifyTerminalRecovery` is a pure closed allow-list; investigator prose cannot make an ineligible terminal state recoverable.

| Terminal fact | Recoverable | Reason |
| --- | --- | --- |
| Typed `TechnicalBlockedOutput` | yes | already carries a structured technical blocker |
| Official validation `FAIL` | yes | structured revalidation evidence exists, including `verification_only` tasks whose process exited successfully |
| Typed terminal `INFRA_ERROR` or `TIMED_OUT` | yes | lifecycle-local recovery is exhausted and the technical state is explicit |
| Preflight block with a recognized `TechnicalBlocker` | yes | blocker is structured before execution |
| `HUMAN_REQUIRED` | no | preserves its concrete `HumanAuthority`; recovery cannot reinterpret it |
| `ALL_DONE` or `LIMIT_REACHED` | no | completion and configured limits are not incidents |
| Worker-reported `FAILURE` | no | a worker judgment is not harness failure evidence |
| Untyped `FAIL` or untyped preflight block | no | no structured technical cause exists |
| `MISSCOPED` without a typed technical cause | no | scope judgment is not silently converted to technical recovery |

The `verification_only` regression is intentional: process exit success does not override a failing official validator. The validation record, rather than worker prose or process status alone, makes the terminal state eligible.

## Durable incidents, evidence, and budgets

Each incident keeps an immutable `incident.json`, mutable persisted usage, and append-only per-attempt decision, diagnosis, launch, and outcome artifacts below `incidents/<incident-id>/`. Stop-mode diagnostics reference a real persisted lifecycle artifact even when the original blocker has no evidence paths.

Investigator usage counts actual profile/provider invocations, not coordinator cycles. Every attempted profile yields launch evidence; failover stops at the smaller of the authorized policy and the fingerprint's remaining `max_investigator_launches`. Remediation cycles are accounted independently. A repeated fingerprint cannot obtain more launches by resuming or by failing over.

## Remediation outcomes

- `TARGET_PROJECT` grants one additional repair attempt through the existing authorization primitive; ordinary project execution consumes it.
- `HARNESS` uses the existing self-maintenance pipeline in a nested incident runtime. Successful integration returns `RESTART_REQUIRED`; the old controller never resumes the parent.
- `MISSING_CONTEXT` performs bounded, local-only reconciliation and then permits at most one re-investigation with materialized evidence.
- `HUMAN_DECISION` preserves the existing typed human gate and its concrete authority.
- `ENVIRONMENT` remains technically blocked because no generic preflight/reinspection primitive accepts an arbitrary incident with sufficient persisted preconditions.
- `PROVIDER` remains technically blocked because retry/failover belongs to the ordinary lifecycle and persisted `profile_policy`; recovery does not create an out-of-band retry or expand providers.

The final two cases are deliberate fail-closed behavior, not unfinished implicit authority. No profile/model-selection feature was added.

## Bounded MISSING_CONTEXT reconciliation

The reconciler accepts at most 32 requested paths and searches exact relative paths or basenames only in the current checkout and repository docs, up to 16 repository worktrees, 64 local refs and 64 history commits, and 32 sibling runtimes in the same runtime group. A bounded walk examines at most 512 entries, retains at most 16 matches, and rejects artifacts larger than 1 MiB. It never walks HOME or the global filesystem.

Matches are copied into content-addressed incident artifacts. The append-only manifest records source, ref/runtime locator, relative path, byte size, SHA-256, and materialized path. The typed resolution contract is:

- `FOUND_RECOVERABLE`: local evidence was found and can support one re-investigation;
- `NOT_FOUND_BUT_RECONSTRUCTIBLE`: reserved for deterministic reconstruction when a sound reconstruction primitive exists;
- `NOT_FOUND_REQUIRES_HUMAN`: reserved for a real, concrete human authority;
- `NOT_FOUND_TECHNICAL`: bounded sources were exhausted without evidence or real human authority.

The current implementation produces `FOUND_RECOVERABLE` or `NOT_FOUND_TECHNICAL`. The WP0 fixture proves that a document missing from the checkout can be recovered from an authorized sibling worktree/runtime source and execution can continue. If no source contains it, recovery returns technical `BLOCKED`; it does not fabricate `HUMAN_REQUIRED`.

## HARNESS fresh-controller state machine

An integrated self-repair cannot safely resume in the Node.js process that loaded the old modules. Immediately after fast-forward integration, Agent Lab persists `controller-restart.json` with the parent runtime, incident id, nested recovery runtime, integrated SHA, original entry intent, and resume target.

```text
INTEGRATED_PENDING_RESUME
          |
          | fresh process starts parent resume
          v
    RESUME_STARTED
          |
          | parent resume completes
          v
       RESUMED
```

Library callers receive `RESTART_REQUIRED` and exit code 75. The CLI detects that contract, spawns the current Node/tsx entrypoint without a shell using `resume <parent-runtime>`, inherits stdio, and mirrors the child exit code. A crash after integration but before spawn remains recoverable: a later resume finds the persisted record and continues without repeating self-maintenance. The subprocess test proves the integration PID and resume PID differ and the old process never resumes the parent.

## Verification and remaining gaps

The implementation is exercised with fake providers/ports and fixture repositories; no real provider, billing path, publication, external-project mutation, or destructive action is used. Focused tests cover the shared prompt, exhaustive terminal table, `verification_only`, real launch accounting, WP0 reconciliation, absent-context technical blocking, restart persistence/idempotency, fresh-process PID separation, and authority non-expansion.

Remaining deliberate limitations:

- `ENVIRONMENT` and `PROVIDER` have no generic autonomous remediation strategy; they fail closed with the missing safe primitive named.
- Reconciliation does not yet implement deterministic reconstruction or a real-authority escalation case.
- Previous-runtime discovery is bounded to sibling runtime directories but does not yet filter them by a persisted same-target identity.
- Provider failover is verified with bounded fixture profiles, not a live provider or an exhaustive production ladder.
- Recovery does not select or add profiles/models; it only traverses the persisted authorized policy.

Current command results and exact counts are recorded in `docs/superpowers/plans/2026-09-17-autonomous-incident-recovery-hardening.md` after the final quality-gate run.
