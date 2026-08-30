# Hard Bound Audit — PR #17 focused repair

**Scope:** only bounds introduced or applied by
`dev/lib/handoff-normalize.ts` in PR #17, plus the requested classification of
`MAX_COMMIT_MESSAGE_BYTES`.

**Reviewed baseline:** `8fadd544f17789919e3d8ce7839fdd195733fdf1`.

This is not a repository-wide numeric-constant audit. A number remains only
when its semantic class and downstream authority justify it.

## Normalizer bounds

| Bound at reviewed HEAD | Field(s) | Semantic class | Downstream consumers | Execution authority | Decision | Rationale |
|---|---|---|---|---|---|---|
| `ADVISORY_TEXT_CHARS = 1_000` | `summary` | `DESCRIPTIVE_REPRESENTATION_BOUND` | Parsed into `AgentCompletionReport`, then persisted in `CompletionRecord`; no routing, validation, review or acceptance reader consumes the text | no | keep | Pure readable/context-efficient representation. Truncation is visible through `…[truncado]`; task/candidate/validation facts are separate fields and untouched. |
| `ADVISORY_TEXT_CHARS = 1_000` | each `decisions` / `lessons` item | `DESCRIPTIVE_REPRESENTATION_BOUND` | Copied by `sealHandoff` and optionally carried in `TaskPacket.previous_handoff`; no lifecycle gate consumes their text | no | keep | These are worker prose. The visible truncation marker prevents a reader from mistaking the representation for the complete statement. |
| `ADVISORY_CLAIM_CHARS = 160` | `evidence[].claim` only | `DESCRIPTIVE_REPRESENTATION_BOUND` | Stored beside the reference and optionally carried in `previous_handoff`; no code reads `.claim` for routing, validation, review or acceptance | no | keep | The claim is explicitly an assertion about a pointer, not pointer identity or evidence content. The marker makes shortening visible. |
| `maximumItems = 5` | `decisions` | `DESCRIPTIVE_REPRESENTATION_BOUND` | `sealHandoff` and optional `previous_handoff` context | no | keep | Descriptive context only; the last preserved item contains a visible omitted-item count. |
| `maximumItems = 3` | `lessons` | `DESCRIPTIVE_REPRESENTATION_BOUND` | `sealHandoff` and optional `previous_handoff` context | no | keep | Descriptive context only; the last preserved item contains a visible omitted-item count. |
| `ADVISORY_PATH_CHARS = 200` | `evidence[kind=file].path` | `POINTER_IDENTITY_BOUND` | Canonical evidence-reference parser and any reader opening the referenced file | no authority to shorten; identity itself affects lookup | remove | Truncation fabricated a different path. File paths are now parser-valid and byte-identical, or the entire reference is discarded. |
| `ADVISORY_TEXT_CHARS = 1_000` per argument | `evidence[kind=command].argv[]` | `POINTER_IDENTITY_BOUND` | Canonical evidence-reference parser and readers comparing/replaying the declared command | no authority to shorten; identity itself affects command meaning | remove from this field | Truncation fabricated a different argument. Each valid argument is now byte-identical. |
| `maximumItems = 8` | command `argv` | `POINTER_IDENTITY_BOUND` | Canonical evidence-reference parser and command readers | no authority to reduce cardinality | remove | The omission marker became a fabricated final argument. The complete argv now survives. |
| `maximumItems = 5` | `next_relevant_files` | `POINTER_IDENTITY_BOUND` | `sealHandoff`, then optional `TaskPacket.previous_handoff` | no authority to reduce cardinality | remove | The marker was appended inside a path, producing an identity that never existed and dropping valid pointers. Schema and worker contract no longer cap it. |
| `maximumItems = 5` | `relevant_files` | `POINTER_IDENTITY_BOUND` | Parsed into `AgentCompletionReport` and persisted in `CompletionRecord` | no authority to reduce cardinality | remove | Same fabricated-path and cardinality corruption as `next_relevant_files`. Schema and worker contract no longer cap it. |
| `.slice(0, 8)` / schema `.max(8)` | `evidence` references | `POINTER_IDENTITY_BOUND` | `sealHandoff`, then optional `TaskPacket.previous_handoff` | no authority to discard valid references by count | remove | Each evidence item is now independently canonical-validated; valid references all survive, invalid references alone disappear. |

## Unbounded semantic classes

- `what_i_did_not_check`, `open_questions` and `confidence` are
  `DECLARED_UNCERTAINTY_BOUND` candidates for which no safe directional bound
  exists. The normalizer preserves them exactly, and the worker contract does
  not request cardinality truncation.
- `schema_version`, task/result identity, candidate/base/provenance,
  `changed_files`, validations, accepted commit and sealing facts are
  `AUTHORITATIVE_BOUND` candidates. The opinion normalizer copies them verbatim
  and leaves validation to their owner.

## Pointer non-fabrication invariant

For every pointer field handled by the normalizer, each output identity is
either exactly equal to an input identity or absent because its complete
reference failed the canonical parser. No path, argv element, record identity
or line range is trimmed, rewritten or given an omission marker.

`HandoffEvidenceReference.safeParse` is the single validator for evidence
references. The normalizer changes only `claim` before calling it; closed
`record_kind`, identifier syntax, positive-integer `attempt`, complete line
range semantics, strict keys, path and argv are therefore checked by the same
schema as the final `HandoffDraft` parse.

## `MAX_COMMIT_MESSAGE_BYTES`

Classification: **`INTENTIONAL_POLICY_BOUNDARY`**.

The 200-byte limit is an internal Agent Lab readability/operational convention
shared by `deriveCommitMessage` and `CommitMessage`. It is not described as an
external maximum imposed by Git. This repair changes only the label and audit;
it does not redesign commit-message behavior.
