# Revisão M3 (M86) — checklist antes do primeiro projeto real

Revisão humana/documental do Marco 3, cobrindo M71–M85. O Marco transforma o
Agent Strategy Lab no **control plane** de implementação: Claude Code e Codex
são workers subordinados, sem posse do lifecycle, do plano autorizado, do
routing, da escalation, da policy de billing ou da evidência autoritativa.

Este documento não autoriza execução real. **Nenhum projeto real, provider
real, inferência ou repositório de usuário foi executado ou modificado em M86.**

---

## 1. Evidência de fechamento do Marco 3

- `.dev/state.json` registra M71–M85 como `PASS`; o `accepted_commit` de M85 e
  o `authorized_head_sha` são `945697f570a602c5bd6e28267e962b4db7683625`,
  exatamente o base SHA e o HEAD recebido por M86.
- `.dev/handoffs/M71.json`…`.dev/handoffs/M85.json` registram, para cada task,
  `pnpm typecheck`, `pnpm build`, `pnpm test`, `git diff --check` e
  `git diff --cached --check` com `exit_code: 0`, além do teste direcionado.
  Portanto os gates completos oficiais de cada entrega estão verdes.
- O estado está reconciliado (`authorized_head_sha == HEAD`, todas as tasks do
  intervalo com `accepted_commit` e `PASS`): o recover do ciclo aceito está
  **CLEAN**. A revisão não reexecuta o runtime do orquestrador.
- O E2E fake de M85 cobre exatamente oito cenários no projeto externo
  sintético e não chama provider real: DIRECT, REVIEWED, CAPABILITY, INFRA,
  ENVIRONMENT, TASK/CONTEXT, CROSS_PROVIDER e HUMAN_GATE.

## 2. Checklist obrigatório

| # | Item | Veredito | Evidência |
| --- | --- | --- | --- |
| 1 | M71–M85 fechadas | ✅ PASS | `.dev/state.json` e handoffs M71…M85, todos `PASS`. |
| 2 | Control plane no lab; Claude/Codex como workers | ✅ PASS | `dev/lib/project-orchestrate.ts` conserva estado e decisões; `dev/lib/project-roles.ts` deriva argv por role. Workers não escolhem DAG, routing, escalation, billing ou fechamento. |
| 3 | AVC sem teto universal de duração | ✅ PASS | `src/planner/decomposition.ts` usa coerência/validabilidade e sinais estruturais; duração absoluta não obriga decomposição. `PlannedTask.estimated_duration` é específico da task. |
| 4 | Três conceitos de tempo separados | ✅ PASS | `src/planner/task.ts`: `estimated_duration`, `resource_envelope.duration_ms` (matéria-prima do worker runtime budget) e `validation[].timeout_seconds` são contratos distintos. |
| 5 | Cada timeout validado somente contra seu bound | ✅ PASS | `dev/lib/project-roles.ts` separa as primitives de worker runtime e validation command; M84 testa ausência de `min` ou cruzamento entre bounds. |
| 6 | Execution budgets adaptativos | ✅ PASS | M78 deriva budget por work unit/profile; M82 pode derivá-lo do p90 histórico. Fora do runtime bound resulta em `BUDGET_UNSUPPORTED` com o `violated_bound`, nunca truncamento ou bypass. |
| 7 | Context management usa instruções como mapa | ✅ PASS | `ProjectInspection` registra caminhos, escopo, relevância e source anchors; não concatena AGENTS/CLAUDE/README/docs como prompt. Packets continuam bounded. |
| 8 | Environment readiness | ✅ PASS | `src/planner/assess.ts` compara requirements planejados com fatos observados; `UNKNOWN` não é `READY`, reduz confidence e precede atribuição de falha à capacidade. |
| 9 | Policy Direct/Reviewed | ✅ PASS | DIRECT exige minimal factual preflight e passa pela Direct Task Normalization determinística de M75; fato ausente/ambíguo encaminha a REVIEWED. REVIEWED usa inspection, planning draft não confiável e validação determinística. |
| 10 | M81 read-only e writer no evidence path | ✅ PASS | `src/performance/query.ts`/`history.ts` somente leem; `recordComparableRunFacts` em `dev/lib/project-orchestrate.ts` grava aditivamente e recusa divergência. |
| 11 | `ComparableRunFacts` puro e compartilhado | ✅ PASS | Schema e builder provider-neutral vivem em `src/performance/comparable-run.ts`, sem I/O. O writer M84 importa esse contrato e o reader M81 lê o mesmo artifact `comparable-run-facts.json`. |
| 12 | Authorization é de escopo, não por spawn | ✅ PASS | `ExecutionAuthorizationScope` separa boundary autônomo e capabilities human-gated; `authorizeExecutionAction` decide a ação contra esse scope. |
| 13 | Autonomia dentro do boundary | ✅ PASS | Novo worker, workspace descartável, validation determinística, bounded repair, escalation CAPABILITY na ladder e cross-provider entre profiles permitidos não pedem gate novo quando suas capabilities estão autorizadas. M85 prova continuidade até a próxima task. |
| 14 | Boundary produz `HUMAN_REQUIRED` | ✅ PASS | Billing/API não autorizado, mudança de billing mode, nova credencial, profile/provider fora da policy, scope expansion e demais human gates não são inferidos de `requested_scope`; M85 prova zero spawn posterior. |
| 15 | Evidence e provenance por escalation | ✅ PASS | `src/routing/escalation.ts` registra authorization, degraus descartados, preflight/billing provenance e transição selecionada; decisão pertence ao control plane. |
| 16 | `requested_scope` separado dos gates | ✅ PASS | `src/intake/index.ts` mantém `RequestedScope`, `autonomous_execution_boundary` e `human_gated_capabilities` em campos/tipos separados; pedido não vira autorização geral. |
| 17 | Role-specific workers com restrição estrutural | ✅ PASS | Planner/reviewer Codex recebem `--sandbox read-only`; Claude recebe settings versionada com deny de mutação, `--permission-mode plan` e `--setting-sources project`. Ownership de commit/validation permanece no orquestrador. |
| 18 | Diagnosis antes de escalation; escalation seletiva | ✅ PASS | M79 classifica failure antes da decisão; somente `CAPABILITY`, depois de bounded repair, é elegível. INFRA, ENVIRONMENT, TASK_DEFINITION, CONTEXT e TOOLING seguem remediação/replan próprios. |
| 19 | Independent fresh review | ✅ PASS | Reviewer usa nova invocação, contexto/packet bounded independente, workspace read-only e decisão estruturada; nunca confia no self-report. Diversidade de profile/model/provider é policy-based e proporcional ao risco. |
| 20 | History-informed routing sem dados inventados | ✅ PASS | M81 preserva `UNKNOWN` + provenance; identidade usa profile id + fingerprint canônico. M82 exige série comparável/amostra suficiente e dominância; empate, lacuna ou ambiguidade cai no fallback determinístico M78 inalterado. |
| 21 | Safety, validation, recovery e evidence | ✅ PASS | Workspaces descartáveis, argv sem shell, validação oficial do control plane, recovery existente reutilizado e records duráveis; M85 prova preservação no stop. |
| 22 | Billing/quota e human gates proporcionais | ✅ PASS | Cada launch verifica scope, profile, credential, billing e quota. Dentro da policy já autorizada não há aprovação universal; fora do boundary há `HUMAN_REQUIRED`. |
| 23 | Gates completos e recover CLEAN | ✅ PASS | Handoffs M71…M85 têm gates oficiais completos com exit 0; state reconciliado no SHA aceito de M85. |
| 24 | Nenhum projeto real em M86 | ✅ PASS | A task alterou somente documentação; não houve launch de lifecycle de projeto, provider ou repositório alvo. |

## 3. Benchmark `pilot-v1` preservado

O Marco 3 acrescenta o lifecycle universal sem reescrever o plano experimental
do Marco 2:

- `corpus/pilot-v1/` continua com as mesmas três tasks;
- `ExperimentSpec` continua strict, deep-frozen e identificado pelo mesmo
  fingerprint canônico para os mesmos bytes; `buildPilotExperimentSpec`
  conserva arms, repetições, seed, ordering, strategy, environment e billing
  policy do piloto. `corpus/pilot-v1/` e
  `src/schemas/experiment-spec.ts` não mudaram desde o fechamento do M2;
- `runExperimentSchedule` continua genérico em `src/experiment/runner.ts`;
- profiles existentes, seus IDs/argv e a evidência histórica permanecem
  inalterados por M86 (M77/M78 apenas acrescentaram as capacidades/identidades
  necessárias ao Marco 3, sem renomear IDs históricos);
- `ComparableRunFacts` novos são aditivos: runs históricos sem o artifact
  continuam `UNKNOWN` com provenance, sem migração retroativa.

O pilot permanece disponível como benchmark congelado. Esta revisão não o
executou e não produz resultado comparativo novo.

## 4. Decisões e limites operacionais

1. O lab possui o lifecycle e a autorização; workers recebem uma work unit e
   um role, não autoridade para ampliar o projeto.
2. AVC decide fronteiras de mudança; budgets dimensionam uma task válida. Um
   não substitui o outro.
3. DIRECT reduz etapas de raciocínio redundantes, não reduz factual preflight,
   validação, safety ou evidence.
4. A ladder é uma autorização finita. Falha não-CAPABILITY, profile/provider
   fora da policy, billing/credential boundary ou ladder esgotada param em
   `HUMAN_REQUIRED`.
5. Review fresco é obrigatório quando indicado; diversidade é uma exigência
   separada e proporcional ao risco.

## 5. HUMAN STOP — antes do primeiro projeto real

**PARADA HUMANA OBRIGATÓRIA.** M86 encerra o Marco 3 documentalmente, mas não
autoriza o primeiro projeto real. O próximo passo só pode ocorrer após uma
aprovação humana explícita, posterior a este documento, que nomeie ao menos o
repositório/base, `requested_scope`, execution boundary, profiles/providers e
billing/credential policy autorizados.

Até essa aprovação, é proibido lançar planning worker, implementer, reviewer,
bounded repair ou escalation contra projeto real. A aprovação futura também
não elimina os gates permanentes: ação destrutiva, efeito externo, deploy,
scope expansion, billing/credential boundary nova, decisão crítica/security-
sensitive, evidência insuficiente e profile/provider fora da policy continuam
produzindo `HUMAN_REQUIRED`.
