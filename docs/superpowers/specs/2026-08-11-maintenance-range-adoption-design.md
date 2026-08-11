# Audited Maintenance Range Adoption Design

## Goal

Adopt a bounded linear range of maintenance commits as one auditable unit
without claiming that any intermediate commit passed validation independently.

## Contract

`maintenance_range` is a third explicit `AdoptionKind`. Its records use the
existing `MaintenanceRecord` envelope with `bootstrap_range: false`, at least
two ordered commits, aggregate `changed_files`, and the four authoritative
validation results for `previous_authorized_head_sha..adopted_head_sha`.

Every recorded commit must exist, have exactly one parent equal to the prior
chain element, and expose the exact `changed_files` rederived from Git. Each
file must satisfy the existing maintenance allowlist and no commit may touch
`dev/plan.yaml`. Intermediate whitespace is not validated separately: only the
aggregate diff and the final target snapshot are authoritative.

Historical records remain unchanged: absent `adoption_kind` means
`maintenance`; normal maintenance remains one commit; historical
`bootstrap_range` retains its existing semantics; `plan_extension` remains one
commit touching only `dev/plan.yaml`.

## API and transaction

`adoptMaintenanceRange({ paths, target, maxCommits, reason, ... })` resolves an
explicit target commit, requires a positive integer limit, collects the linear
chain back to the current authorized head, and rejects merge, gap, forbidden
files, dirty worktrees, and RUNNING tasks before validation.

The four gates run against the target snapshot. When target differs from HEAD,
a detached temporary worktree shares `node_modules` when available. The record
is written before state. A retry that finds a valid existing record finishes
the state transition without rerunning validations or rewriting evidence.

`reconcileMaintenanceRecords` remains generic because the new record still
links one authorized head directly to one adopted head.

## CLI and verification

`pnpm dev-adopt-maintenance-range --target <sha> --max-commits <n> --reason
<text>` invokes the API under the harness lock. Target may default to HEAD, but
the explicit form is supported and is the audited incident workflow.

Sandbox-repository tests cover the range contract, target validation,
transaction/recovery behavior, and historical compatibility. Final gates are
`pnpm typecheck`, `pnpm build`, `pnpm test`, `git diff --check`, and
`git diff --check 7499aa872b4d55913e87e1860a928d6dee799ef9..HEAD`.
