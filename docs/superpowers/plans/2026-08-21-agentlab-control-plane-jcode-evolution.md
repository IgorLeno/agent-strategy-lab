# Agent Strategy Lab — Evolução do Control Plane Autônomo + Integração jcode

**Data:** 2026-08-21 · **Status:** APROVADO COM AJUSTES (decisões humanas D1–D6 incorporadas)

> **HISTÓRICO / SUPERSEDED (2026-08-25).** Documento preservado como registro do que foi decidido em 2026-08-21; nada abaixo foi reescrito. Deste plano só foram executadas as work units M87–M94 (M-A e M-B). Depois do primeiro piloto externo real, as tasks M95–M126 foram **removidas de `dev/plan.yaml`** e este plano **deixou de ser uma sequência de desenvolvimento autorizada**: não é o roadmap atual, não autoriza implementação e não deve ser retomado como plano. Os temas que sobreviveram estão em [`docs/FUTURE_DIRECTIONS.md`](../../FUTURE_DIRECTIONS.md), que não é plano.

**Base de evidência:** main @ `a24c0cb1d55724438c6a1c13d546797f11512084` + auditoria read-only do jcode @ `a63dbc4` (v0.79.1)
**Tasks operacionais:** M87–M126 em `dev/plan.yaml` (mapa na §17)

---

## Goal

Evoluir o Agent Strategy Lab de "control plane ~80% completo" para um ciclo autônomo fechado:
`intent → plano persistido → task graph → routing → execução → validação → recovery → decisão humana quando necessário → próximo trabalho runnable` — preservando autoridade arquitetural, auditabilidade e os princípios do Evidence Kernel. O jcode entra apenas como substrato de execução opcional, em milestone tardio, atrás da interface canônica de eventos.

## Decisões humanas resolvidas (não reabrir)

- **D1 — Identidade do produto (APROVADA):** *"Agent Strategy Lab is an autonomous, evidence-grounded AI project control plane for planning, routing, executing, validating, recovering and learning across long-running software projects."* Benchmarks = **Experimental / Learning Plane**: ensinam routing, model/effort/strategy selection e decisões de custo/qualidade. Não definem o produto.
- **D2 — Baterias:** baterias adicionais interrompidas por decisão do usuário; E06–E09 não iniciam. Resultados anteriores permanecem evidência histórica. Nenhuma bateria bloqueia M-A..M-F.
- **D3 — jcode tardio (APROVADO):** adapter jcode (M-G) só após M-C, M-D, M-E e M-F. G1 vira **spike de fronteira de transporte** (SDK TypeScript vs ACP/JSON-RPC stdio) com veredito `GO_SDK | GO_ACP | NO_GO` antes de qualquer implementação.
- **D4 — História canônica:** autoridade permanece no armazenamento canônico do Agent Lab (`data/` da instalação). Princípio: *global canonical evidence store + mandatory project identity/namespace/provenance*. Aprendizado cross-projeto só quando a policy permitir; nunca misturar contexto de projetos silenciosamente. Sem migração de storage agora.
- **D5 — Reviewer diversity:** default continua econômico (sem diversidade obrigatória). Diversidade selecionada por risco, histórico, policy ou exigência de revisão independente. Sem review automático "por princípio".
- **D6 — Caps de crescimento do grafo:** defaults iniciais `max_tasks_per_plan_revision = 2`, `max_promotions_per_task = 1`; configuráveis na authorization; limites conservadores iniciais, não constantes universais.

## Regra principal

O Agent Strategy Lab é o control plane. O jcode NÃO assume: planning, task graph, scheduling, routing, validation, evidence, billing policy, credential policy, recovery, human decision gates, project history, project knowledge. jcode = execution substrate opcional.

---

## 1. Estado atual (verificado no código)

Duas árvores: `src/` = contratos puros/decisão (~18.6k LOC, zero I/O de provider no caminho vivo); `dev/` = runtime real (~29k LOC; `dev` importa `src`, nunca o inverso). Execução = subprocess de CLI headless (`launchWorker`, `dev/lib/launch.ts`); dependências de runtime só `yaml` + `zod`; "adapter" real = `LauncherProfile.argv` versionado em `dev/profiles/*.yaml`.

Já resolvido e preservado como autoridade: intake com `ExecutionAuthorizationScope` (6 capabilities autônomas + 12 human-gated); inspection read-only; `PlannedTask` com DAG `blocked_by` + validação de ciclo/desconexão; AVC (11 sinais com provenance); routing em 3 camadas (`ProfileCapability` → determinístico → histórico Pareto com fallback explícito); validação oficial reexecutada pelo orquestrador; reviewed-pass gating por 3 hashes (`assertCandidateReviewAccepted` como guarda única); repair bounded (1×, mesmo profile, fail-closed); escalation por ladder; 4 recoveries determinísticas; routine autonomy bounded; evidência canônica selada (`data/runs/<ULID>`, manifests, ledger, integridade pré-publicação, ids determinísticos crash-resumáveis); `ComparableRunFacts` com provenance por campo; fatos tri-state (UNKNOWN ≠ TRUE; quota UNKNOWN→ALLOW, credencial UNKNOWN→HUMAN_REQUIRED); billing/credencial provados a cada launch; `RunInterventionsRecord` (ausente=UNKNOWN, vazio=zero provado); dry-run = decisão real (`assessWorkUnit` compartilhado).

## 2. Gaps que este plano fecha

| # | Gap | Milestone |
|---|---|---|
| G1 | Sem interface unificada de eventos; Codex `--json` não parseado no harness | M-C |
| G2 | HUMAN_REQUIRED terminal: sem registro de aprovação nem resume | M-E |
| G3 | `ImplementationPlan` sem writer/registry/versionamento | M-D |
| G4 | Planning worker REVIEWED nunca instanciado; `DECOMPOSITION_REQUIRED` sem executor | M-D (parcial), pós-M-E |
| G5 | Handoff sem `what_i_did_not_check`/evidence tipada/confidence | M-B |
| G6 | Tarefas não nascem durante execução | M-D |
| G7 | Loop serial; zero concorrência | M-H |
| G8 | Sem streaming/progresso/checkpoint intra-attempt | M-C (parcial), M-G (compact) |
| G9 | Spawn de planner/reviewer sem LaunchRecord/auditoria/usage | M-C |
| G11 | Sem README raiz; charter proíbe router adaptativo já implementado; "control plane" ambíguo | M-A |
| G12 | Results→knowledge inexistente além dos runs | M-I |
| G16 | `data/runs/` vazio; loop de história nunca girou com dados reais | rollout real |

(G10 `MODEL_TIER_PATTERNS` hardcoded, G13 feature flags, G14 CLIs não roteadas, G15 diversity default, G17 quota probe Codex: registrados; fora do critical path desta fase.)

## 3. Auditoria jcode — síntese decisória

MIT confirmado. Protocolo próprio NDJSON/Unix socket com handshake versionado (v1) e capability detection; anti-drift Rust↔TS mecânico (ponto mais maduro do projeto). Fatos que determinam a posição tardia e o spike G1:

1. `permission_request` nunca emitido pelo bridge; `respondToPermission` retorna erro; capability `permissions` ausente — sem gate de permissão programático via SDK.
2. Task DAG, memória e agentgrep NÃO expostos pelo SDK — só acionáveis por tool calls do modelo; impossível dirigir de fora.
3. npm dessincronizado: repo `1.2.0`, registry `1.1.0` (2026-08-04); runtime avançou 4 minors no período (0.79.x, múltiplos releases/semana).
4. Bugs abertos de provider routing no swarm com risco financeiro comprovado (#1006: US$ 11 em 2 min; #1001/#1002/#1020; #1022 memória chama provider não configurado).
5. Hooks insuficientes para hospedar workflow framework (5 eventos, 1 gate; rejeição pública de integrador em #999).
6. `launch()` herda credenciais de todos os CLIs por symlink (`inheritLogins: true` default) — colide com a política de credencial do Lab; mitigável com `inheritLogins: false` + provisionamento explícito.
7. `globalEvents()` = N conexões + polling 1s sem replay; `background_progress` = scraping de markdown (best-effort); `run()` sem timeout próprio.
8. Superfície ACP (`src/cli/acp.rs`, JSON-RPC 2.0/stdio, protocolo do Zed) = candidata de menor lock-in — objeto do spike G1.

**Recomendações:** ADAPT (ideias): `HandoffArtifact` (`what_i_did_not_check`, evidence by-reference, confidence, gates de cobertura `UncoveredSiblings`/`UnaddressedLowConfidence`), retrieval estrutural estilo Agent Grep, growth accounting do DAG. WRAP (M-G, flag off, pinned, launch-only, fallback total): session runtime. REJECT: swarm, DAG engine, memória, ambient, self-dev, `runStructured`, `setModel` pós-pin, `connect()`, session resume de outros harnesses.

## 4. Authority Matrix

| Responsabilidade | Autoridade | jcode |
|---|---|---|
| Intake, inspection, planning, task graph, scheduling, routing, billing/credential policy, validation, acceptance, commit, evidence, project history, recovery, human gates, project knowledge | **Agent Lab** | — |
| Execução de uma work unit | Agent Lab decide | backend opcional ao lado de Claude/Codex |
| Session runtime intra-attempt (compact, soft interrupt) | — | jcode, sob budget/timeout/attempt identity do Lab |

## 5. Arquitetura-alvo (fluxo)

```
USER intent + agentlab-run.yaml
  → Intake/Authorization → Inspection → Planner (PlanFile ou planning worker READ_ONLY)
  → Task Graph Store (planos versionados + status projection)
  → Scheduler (runnable nodes; concurrency 1..N) → Router (capability → determinístico → história Pareto)
  → Execution Interface (ExecutionEventV1) → { Claude CLI | Codex CLI | jcode (flag, M-G) }
  → Canonical Evidence (data/runs + .dev) → Official Validation + Review Gate
  → PASS aceito: libera dependentes / promove tarefas (caps D6)
  → FAIL: Diagnosis → Recovery (repair 1× → escalation ladder → HumanDecisionRequest)
  → Project History V2 → alimenta Router
Human Decision Store ↔ Scheduler (nó human_blocked → runnable após decisão registrada)
Experimental Plane → evidência → Routing Knowledge
```

Sources of truth inalterados: PlanFile+authorization (definição de trabalho), `.dev/` (estado operacional), `data/runs/` (evidência canônica, com identidade de projeto obrigatória — D4), SQLite derivado. Novos stores: `.dev/plans/` (planos versionados), `.dev/decisions/` (decisões humanas).

## 6. M-A — Positioning + ADR alignment (M87–M90)

- **A1/M87 — README raiz:** abre pela identidade D1 (nunca por benchmarks); descreve intake→inspection→planning→decomposition→routing→execution→validation→recovery→history→adaptive selection→human gates; Experimental Plane como produtor de evidência; separa implemented / current limitations / planned; toda capability citada verificável no código.
- **A2/M88 — ADR-0003:** formaliza a evolução de identidade; resolve o conflito com o non-goal "adaptive router" do charter (o código implementou M78/M81/M82); define Evidence Kernel vs Orchestration Control Plane vs Experimental Plane; registra explicitamente a mudança de direção histórica; registra D4 (evidência global + identidade de projeto obrigatória).
- **A3/M89 — LAB_CHARTER + ARCHITECTURE + HARNESS:** charter com missão D1 e non-goals corrigidos sem perder rigor experimental; ARCHITECTURE documenta o control plane real (incl. `dev/lib/project-*` como runtime do control plane, 6 commits pós-M86, distinção `src`/`dev` e sources of truth); HARNESS clarifica papel do runtime dentro do produto maior (não "benchmark harness" para o todo) e explicita que `--authorization` entra por `dev-run-plan`.
- **A4/M90 — contrato de uso + limpeza:** documenta `agentlab-run.example.yaml` como contrato de entrada para condução de projeto (prosa adjacente); corrige comentário obsoleto `dev/lib/project-run.ts:205-211` (diz que projeto externo não materializa história; `a24c0cb` mudou isso). Sem mudança de comportamento.

## 7. M-B — Typed Handoff v2 (M91–M94)

Evolução aditiva de `HandoffDraft`/`HandoffRecord` (`dev/lib/schemas.ts`), adaptando o `HandoffArtifact` do jcode:

```yaml
schema_version: 2
outcome: derived            # orquestrador, nunca worker
summary: required
changed: derived            # files + commit, by-reference do change bundle
evidence: required          # [{ref: "file:line|comando|record-id", claim}] — refs, nunca bytes
validation: derived         # dos ValidationEvidence oficiais
decisions / open_questions: optional (worker)
what_i_did_not_check: REQUIRED (worker; lista vazia = afirmação positiva)
confidence: optional        # parser leniente, pessimista em hedge
```

Required por role — implementer: summary, evidence, what_i_did_not_check; reviewer: summary, evidence, coverage (nomeia o que auditou — adaptação de `UncoveredSiblings`); planner: summary, open_questions. Derived continuam autoridade do orquestrador (só opinião sobrevive do draft). BY_REFERENCE default; budget 4 KiB mantido; malformado → `PROTOCOL_OUTPUT_INVALID` (recovery existente). v1 continua legível; campos ausentes = UNKNOWN, nunca default.

## 8. M-C — Unified Execution Events (M95–M99)

`ExecutionEventV1` em `src/schemas` (provider-neutral): `assistant_delta | tool_call | tool_result | usage | result | provider_failure | rate_limit`. Camada de LEITURA — records atuais inalterados. Codex `--json` passa a ser parseado no harness (reusa `src/adapters/codex/parser.ts`), fechando a assimetria de observabilidade (provider_failure/rate_limit/usage para Codex). Claude stream-json projetado para o mesmo contrato. Planner/reviewer passam a spawnar com a mesma evidência do implementer (LaunchRecord, auditoria de sobreviventes, duração) — fecha G9. Eventos normalizados persistidos aditivamente na seção execution do run canônico.

## 9. M-D — Task Graph Runtime (M100–M104)

`PlannedTask.blocked_by` + `validatePlan` + `select.ts` JÁ SÃO o DAG — evoluir, não recriar. Status runtime como **projection** (`runnable|blocked|running|completed|failed|repair|escalated|cancelled|human_blocked`), derivado de `TaskState`+finalizations+decisions, nunca armazenado em duplicidade. Writer/loader/registry de `ImplementationPlan` em `.dev/plans/<plan_id>/` (sha256, source fingerprints); SHA continua pinando runtime. Nascimento dinâmico: única porta = promotion policy sobre `open_questions`/`what_i_did_not_check`/`DECOMPOSITION_REQUIRED`; nova task nasce como **plan revision** versionada (parent_plan_id, diff), nunca mutação in-place; dentro do escopo + caps D6 → autônoma, fora → decision request; item não promovido vira registro de backlog no plano.

## 10. M-E — Human Decisions (M105–M109)

`HumanDecisionRequest` persistido (`.dev/decisions/<id>/`: classe D1..D5 de decisão, contexto, opções, evidência, task afetada) + `HumanDecisionRecord` (decisão, quem, quando, escopo concedido). Todo `HUMAN_REQUIRED` grava request. CLI `dev-decide` lista/decide. Resume: `human_blocked` é estado de nó; decisão registrada re-torna runnable sem reinício do runtime. Decisão vira `InterventionRecord` (design_decision) e entra na história. Classes: D1 produto/arquitetura ambígua; D2 risco/destrutivo/externo; D3 custo/credencial; D4 escopo/policy; D5 esgotamento/evidência insuficiente.

## 11. M-F — Context Economy (M110–M112)

**F1 define interface language-neutral** (contrato provider-neutral único para consumidores): `get_file_outline | find_symbol | read_symbol | read_range | find_references`, com adapters de capacidade possivelmente distinta (TypeScript primeiro; Python/Kotlin/Rust/generic-text fallback depois) — a arquitetura NÃO se acopla a TypeScript. Consumidor inicial: construção de packet/inspection do control plane (workers têm suas próprias tools). Métricas de contexto por attempt com provenance: `context_bytes_sent`, `handoff_size`, `full_files_read` (quando observável). Proibições que viram teste: packet nunca embute arquivo além dos budgets; handoff nunca contém diff.

## 12. M-G — jcode Adapter (M113–M118; flag off; após M-C/M-D/M-E/M-F)

**G1/M113 — spike de fronteira de transporte (gate humano `GO_SDK | GO_ACP | NO_GO`):** compara SDK TypeScript vs ACP/JSON-RPC stdio em: versioning, event fidelity, session lifecycle, binary coupling, credential isolation, timeout control, capability detection, forward compatibility, dependency stability, testability. Só depois do veredito registrado o adapter é implementado — não assumir SDK por ter aparecido primeiro.

Invariantes independentes do transporte: instância privada isolada (nunca `connect()` à instância do usuário); `inheritLogins: false` + credencial provisionada e provada pelo fluxo do Lab; binário+cliente pinados; capability ausente → `PROFILE_UNAVAILABLE` fail-closed; deadline EXTERNA do Lab envolve tudo; modelo/effort pinados pelo perfil (nunca `setModel` pós-pin); `background_progress` descartado; eventos normalizados para `ExecutionEventV1`; memória/swarm/ambient desligados no perfil; falha de sessão = `INFRA_ERROR` recuperável; fallback total — nenhum caminho depende do jcode.

## 13. M-H — Optional Concurrency (M119–M122; gate humano de ativação)

`concurrency = 1` default permanente. Pré-requisitos para N>1: nós independentes no DAG; workspace por work unit (mecanismo de clone descartável existente); merge/acceptance serializado (conflito → 1 rebase-repair, senão `human_blocked`); lock por recurso; limites por credencial (1 sessão por credencial subscription default). Paralelismo só quando: sem ancestral comum não-fechado E `initial_files ∩ probable_files` disjuntos E política autoriza.

## 14. M-I — Project Knowledge (M123–M126; último; requer execução real acumulada)

`KnowledgeEntry { category: FACT|DECISION|PROCEDURE|FAILURE_PATTERN|CONSTRAINT|PREFERENCE|CORRECTION, content, source{kind: canonical_run|human_decision|lesson|derived, ref}, provenance, confidence{value, basis}, relations[{RELATES_TO|SUPERSEDES|CONTRADICTS|DERIVED_FROM, target}] }`. Regras: inference nunca promovida silenciosamente a fato; `derived` nunca vira canônico sem decisão humana registrada; retrieval **pull** apenas em planner/router/reviewer/recovery, com registro do que foi consultado; implementers NÃO recebem memória injetada. Respeita D4: conhecimento carrega identidade de projeto; cross-projeto só por policy.

## 15. Testing Strategy

unit (schemas novos; handoff v2 rejeita malformado; promotion caps; decision records) · contract (EventV1: fixtures reais Claude/Codex/jcode normalizam idêntico) · adapter (fake bridge: dial, handshake de versão errada, turn pendurada → deadline, overflow) · integration (plan store + revision + scheduler; decisão → resume) · recovery (falha jcode = INFRA_ERROR; validação falha → estado correto) · project-flow e2e (estilo `external-plan-run-e2e`: task nasce de handoff, dependente espera, gate só quando deve) · regression (planos v1 carregam; runs antigos legíveis; caminho sem authorization bit-idêntico).

## 16. Metrics · Risks (resumo)

Métricas por episódio/projeto, todas com provenance e amostra mínima: `user_interventions`, `human_decision_count`, `work_units_completed`, `first_pass_rate`, `repair_rate`, `escalation_rate`, `blocked_time` (Δ human_blocked→decisão), `context_bytes_sent`, `tokens_per_work_unit`, `handoff_size`, `duplicate_work_detected`, `recovery_success_rate`, **`autonomous_progress_depth`** = maior sequência de work units consecutivas com accepted PASS e `RunInterventionsRecord` presente e vazio; UNKNOWN quebra a sequência.

Riscos principais e mitigação: instabilidade da dependência jcode (pinning duplo + spike G1 + fallback total; detecção via doctor; rollback = flag off) · dual control planes (Authority Matrix; DAG/memória/swarm jcode nunca acionados) · escalation de custo (budgets + deadline externa + caps) · context amplification (budgets estruturais + métricas M-F) · explosão do grafo (caps D6 + revision versionada) · conflito paralelo (M-H tardio, disjunção exigida, merge serializado) · contaminação de memória (pull-only, provenance, derived≠canonical) · migração de schema (política never-migrate aditiva já testada V1/V2) · perda de auditabilidade (eventos selados no run; `verifyRunIntegrity`).

## 17. Mapa milestones arquiteturais ↔ tasks operacionais

| Arquitetural | Operacional | Conteúdo |
|---|---|---|
| M-A | M87–M90 | A1 README · A2 ADR-0003 · A3 charter/architecture/harness · A4 agentlab-run doc + comentário obsoleto |
| M-B | M91–M94 | B1 schema v2 · B2 finalize propagation · B3 worker contract · B4 reviewer coverage |
| M-C | M95–M99 | C1 EventV1 · C2 Codex · C3 Claude · C4 role launch evidence · C5 persistência canônica |
| M-D | M100–M104 | D1 plan store · D2 projection · D3 promotion policy · D4 plan revision · D5 e2e |
| M-E | M105–M109 | E1 schemas · E2 persistência HUMAN_REQUIRED · E3 CLI · E4 resume · E5 e2e |
| M-F | M110–M112 | F1 retrieval interface (language-neutral) · F2 packet builder · F3 métricas |
| M-G | M113–M118 | G1 transport spike (gate) · G2 contrato · G3 runtime · G4 profile/doctor · G5 e2e · G6 flag |
| M-H | M119–M122 | H1 workspace/unit · H2 merge queue · H3 scheduler N>1 · H4 e2e (gate de ativação) |
| M-I | M123–M126 | I1 schema · I2 derivers · I3 retrieval pull · I4 guard derived≠canonical |

Sequência: M87→…→M90 → (M91–M94 ∥ M95–M99 ∥ M110) → M100–M104 → M105–M109 → M111–M112 → [GATE G1] M113–M118 → [GATE] M119–M122 → M123–M126. Ciclo por milestone: implementação → validation → commit → review humana → próximo.

## 18. Definition of Done da evolução

Usuário entrega objetivo + `agentlab-run.yaml`. O Lab: inspeciona; produz/atualiza plano persistido e versionado; deriva grafo e seleciona próxima work unit runnable; roteia por capability+história dentro da policy; executa via Claude/Codex/jcode (se habilitado) sob budget e evidência canônica; worker devolve handoff v2 ≤4 KiB com `what_i_did_not_check`; validação oficial + review gate decidem accepted PASS; PASS libera dependentes e pode promover tarefas dentro dos caps; FAIL segue repair→escalation→decision request; decisões humanas persistem e retomam o nó sem reinício; múltiplas work units correm sem coordenação manual; história alimenta routing com amostra real; toda decisão/métrica tem provenance; o sistema funciona integralmente com jcode indisponível.

## 19. Gates humanos futuros (únicos pontos de decisão pendentes)

1. **M113 (G1):** veredito `GO_SDK | GO_ACP | NO_GO` do spike de transporte jcode, registrado antes de M114.
2. **M119 (M-H):** ativação de concorrência N>1.
3. **Primeiro projeto real / side-effects externos:** HUMAN STOP do M3-REVIEW §5 permanece vigente — autorização explícita nomeando repo/base, `requested_scope`, boundary, profiles/providers, billing/credential policy.
4. **M123 (M-I):** confirmação de que há execução real suficiente para justificar retrieval de conhecimento.

## 20. Princípios preservados

SPEC FIRST · evidence over self-report · UNKNOWN ≠ 0 · fail closed com evidência inválida · canonical source of truth única · contratos provider-neutrais · autorização explícita de escopo · retries bounded · recovery observável · commits incrementais · história auditável.

Antipadrões vetados: jcode substituindo o Lab · swarm como orquestrador · Big Bang rewrite · memória auto-injetada · segunda abstração duplicando abstração boa existente · enforcement só por prompt quando estrutural é possível · routing/fallback/substituição de modelo silenciosos · retries/crescimento de grafo unbounded · handoff-transcript.
