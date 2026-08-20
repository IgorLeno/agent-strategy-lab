# Canonical External Project History Design

## Goal

Materialize inference-bearing external project attempts as integrity-checked
canonical runs and feed their explicitly selected evidence into M81 and M82,
without creating a second history store or changing historical trial semantics.

## Two orthogonal identities

`Trial` remains the homogeneous planned-execution identity already used by the
experimental system: one task, agent/profile, strategy and environment. A new,
versioned `RunHistoryContextV1` links runs from one primary project work unit
across INITIAL, REPAIR and ESCALATION into an `execution_episode_id`.

An episode can therefore contain more than one trial when escalation changes
profile. M81 V2 derives lifecycle facts over the ordered episode, while it
derives comparable profile series from each run's complete comparable identity.
Neither projection uses the first run of a cross-profile episode as an identity
anchor for the other runs.

## Canonical binding and selection

Each new external-project `RunRecord` carries optional `history_context` with:

- `schema_version: 1`;
- stable `execution_episode_id`;
- positive `episode_attempt_ordinal`;
- explicitly pinned initial profile id and fingerprint;
- explicitly pinned evaluation id and score id or null.

The harness also writes one append-only attempt-to-run binding under its target
runtime. The binding key includes target project, runtime, task, attempt and
launch id. A deterministic canonical ULID derived from the launch timestamp and
binding key makes recovery converge on the same run directory after a crash.

## M81 V2

`queryPerformanceHistory` keeps the existing V1 overload unchanged and gains a
V2 overload. V2 returns:

- `episodes`: lifecycle projections ordered by `episode_attempt_ordinal`;
- `series`: homogeneous comparable profile series grouped per run identity;
- explicit exclusions for missing, divergent or unknown episode evidence.

Lifecycle first/final pass, repair, escalation and intervention metrics are
attributed to the series that was explicitly selected as the episode's initial
profile. Execution metrics are partitioned by INITIAL, REPAIR and ESCALATION.
M82 initial routing consumes episode lifecycle metrics and inference-bearing
INITIAL execution metrics only. A profile observed only in escalation remains
reportable but cannot become eligible for initial routing.

Historical runs without `history_context` remain valid for V1 and are not
silently promoted to V2 episodes. No automatic backfill occurs.

## External run materialization

After an observed attempt, the harness reads authoritative PlanFile,
classification, inspection, profile catalog, LaunchRecord, official validation,
candidate review and archived attempt evidence. It creates the canonical run in
the Agent Strategy Lab data directory, writes the existing execution envelope,
execution record, ComparableRunFacts and quota evidence when present, and seals
execution with `finalizeExecution`.

The selected evaluation preserves these outcomes:

- official validation FAIL: required validation grader FAIL, outcome FAIL;
- validation PASS and review not required/accepted: outcome PASS;
- validation PASS and review REJECT: validation grader PASS plus required review
  grader FAIL, outcome FAIL;
- required review unavailable: review grader NOT_EVALUATED and overall
  NOT_EVALUATED, never PASS.

Scoring uses `scoreRunV1`; missing required metrics remain null and qualification
remains UNSCORABLE. The run is indexed only through `RunIndex.indexRun`.

## Human intervention evidence

M82 exige `human_intervention_rate` entre as agregações obrigatórias, e o
leitor canônico não tinha writer para esse fato: sem ele nenhuma série real
poderia ser elegível. O run canônico passa a publicar
`execution/interventions.json` (`RunInterventionsRecord` v1) reutilizando
`InterventionRecord`/`InterventionType`.

A existência do artifact é a prova positiva:

- ausente: `interventions = null`, desconhecido, como todo run histórico;
- lista vazia: zero intervenções PROVADAS — o control plane conduziu o attempt
  inteiro dentro do `autonomous_execution_boundary` e nenhum gate humano do
  episódio o precedeu (primeiro attempt do episódio, ou antecessor observado
  pelo mesmo processo);
- entradas: intervenção humana registrada, como o humano que liberou um gate de
  review REJECT e autorizou o attempt seguinte;
- artifact inválido: o run é excluído da história, nunca convertido em zero.

Quando o lifecycle não consegue provar nem zero nem uma intervenção concreta
(episódio retomado do disco com antecessor não observado), nenhum artifact é
escrito e a evidência permanece UNKNOWN.

## Read-only routing and causality

The production assessment discovers canonical RunRecords for the same exact
semantic work-definition fingerprint and calls M81 V2 before routing. The
versioned fingerprint excludes literal task ids and labels, but includes the
objective, acceptance, validation commands, initial scope, constraints,
handoff mode, dependency count and declared classification. Candidate profile
fingerprints come from canonical hashes of the complete loaded catalog entries.
The eligible history snapshot is frozen for the entire primary work unit, so
INITIAL, REPAIR and ESCALATION cannot influence their own routing cycle.

Dry-run executes the same query and routing logic but never materializes a run,
binding, evaluation, score, index or provider action. Candidate policy is
applied before routing; history cannot widen the fixed-profile benchmark.

## Compatibility and safety

V1 query behavior, TaskPerformanceRecord V1 and derivePerformance remain
unchanged. New fields are optional and versioned. Unknown facts remain unknown;
no missing token, quota, cost, review or fingerprint is converted to zero or a
positive assertion. Partial sections are ignored by M81 until integrity and
the explicit selection are complete.
