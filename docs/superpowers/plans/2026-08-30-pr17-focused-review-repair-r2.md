# PR 17 focused review repair, revision 2

**Status:** COMPLETE

**Reviewed baseline:** `8fadd544f17789919e3d8ce7839fdd195733fdf1`

**Terminal constraint:** update PR #17 and push the focused repair; do not merge.

## Scope and acceptance

- [x] Preserve the compile-time proof that `HumanAuthority` is a subset of
  `HumanGatedCapability` and add an exact reverse-partition proof whose only
  deliberately non-authoritative member is `INSUFFICIENT_EVIDENCE`.
- [x] Make the handoff field taxonomy structural: descriptive prose may use a
  visible representation cap; declared uncertainty must not be made more
  complete or confident; pointer identity is byte-identical or absent;
  authoritative facts are outside opinion normalization.
- [x] Reuse the canonical `HandoffEvidenceReference` schema to discard each
  invalid evidence reference independently while preserving unrelated valid
  evidence and the rest of the handoff.
- [x] Prove long path, argv, relevant-file and next-relevant-file identity;
  canonical record-reference validation; malformed authoritative identity;
  existing line-range behavior; and pointer non-fabrication.
- [x] Audit every bound introduced by `dev/lib/handoff-normalize.ts` and correct
  the `MAX_COMMIT_MESSAGE_BYTES` label without redesigning Git behavior.

## Verification

- [x] Run the focused authority, handoff normalization and hard-bound tests.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm test` once after focused tests pass.
- [x] Run `pnpm build`.
- [x] Run `git diff --check`.
- [x] Inspect the complete diff since `8fadd54`, commit, push the existing PR
  branch, verify PR #17 remains open and unmerged, and record the outcome here.

## Boundaries

- No general review or unrelated cleanup.
- No redesign of control-plane halt, blocker architecture, PR #16 continuation,
  authorization/billing/credential gates, reviewer/planner policy, staged
  validation, Evidence Kernel or the `dev-*` architecture.
- No PR B work and no merge.

## Outcome

The focused repair preserves pointer identity, validates evidence references
with the canonical schema, makes the field taxonomy explicit, and enforces the
human-authority partition in both type directions. Focused tests, typecheck,
the full deterministic suite, build and whitespace validation passed. The
authorized publication step updates PR #17 without merging it.
