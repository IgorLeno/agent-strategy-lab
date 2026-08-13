# Revisão PRE-M2 (M52)

Pacote de revisão humana ao final de M41–M51B. **Parada obrigatória**: este
documento fecha o plano operacional atual (`dev/plan.yaml` termina em M52).
M53–M68, propostos abaixo como documento, só entram em `dev/plan.yaml` por
uma segunda alteração após aprovação humana explícita a este pacote. Nada
neste documento autoriza, por si, o início do Marco 2.

---

## 1. O que foi construído em M41–M51B

| Tarefa | Entrega | Onde |
| --- | --- | --- |
| M41 | ADR-0002 (Evidence Kernel) e LAB_CHARTER — missão, autoridades, dois modos, incubation lifecycle, non-goals | `docs/adr/ADR-0002-evidence-kernel.md`, `docs/LAB_CHARTER.md` |
| M42 | Mapa kernel/planos em ARCHITECTURE.md, política de freeze do harness | `docs/ARCHITECTURE.md` §6, `docs/HARNESS.md` |
| M43 | Métrica genérica com provenance + `ExecutionMetrics` estendida (tokens, custo) | `src/schemas/execution-record.ts` |
| M44 | `QuotaUsage` provider-neutro (`observation` + `windows`) | `src/schemas/quota-usage.ts` |
| M45 | `InterventionRecord` + `deriveAttemptFacts` (fatos ortogonais de attempt) | `src/schemas/intervention.ts`, `src/performance/` |
| M46 | Schemas `RunPerformanceRecord` / `TaskPerformanceRecord` | `src/schemas/performance.ts` |
| M47 | `derivePerformance` + 7 fixtures sintéticas históricas | `src/performance/`, `test/performance/derive.test.ts` |
| M48 | `AttemptHistory` a partir de `data/runs/` com seleção pinada | `src/performance/`, `test/performance/history.test.ts` |
| M49 | `TaskSpec.taxonomy` v1 opcional, backward-compatible | `src/schemas/task-spec.ts` |
| M50 | `ExtensionManifest` imutável + `IncubationState` separado | `src/schemas/extension.ts` |
| M51A | `ProviderAdapter` contract + registry + fake shape | `src/adapters/contract.ts`, `src/adapters/index.ts` |
| M51B | `executeWithAdapter` runtime comum + equivalência fake | `src/runner/execute.ts` |

Todas as doze tarefas fecharam com `pnpm typecheck`, o teste alvo e
`pnpm test` verdes (evidência em `.dev/completions/` e nos commits
`feat(M41)`…`feat(M51B)`).

---

## 2. Contratos criados

### 2.1 `QuotaUsage` (M44) — `src/schemas/quota-usage.ts`

Schema provider-neutro para consumo de cota de assinatura, deliberadamente
fora do STABLE KERNEL (é produto, nunca importa de `dev/lib`):

- `QuotaWindow`: `window_id` livre definido pelo provider (`five_hour`,
  `seven_day`, ...) — nunca um campo fixo do kernel; `before_used_pct`/
  `after_used_pct`/`consumed_pp` nuláveis; `same_window`; `reason_code`
  (`OK` | `RATE_LIMIT_WINDOW_RESET` | `MEASUREMENT_UNAVAILABLE` |
  `WINDOW_LABEL_UNPARSEABLE` | `OBSERVED_DELTA_NEGATIVE`); provenance por
  janela.
- `QuotaUsage.observation`: `{ status: OBSERVED | UNAVAILABLE, reason_code,
  provenance }`. É o campo que **distingue** "probe rodou e não achou
  nenhuma janela" (`OBSERVED` + `windows: []`) de "não há como medir"
  (`UNAVAILABLE` + `windows: []` obrigatório). Sem `observation`,
  `windows: []` sozinho é ambíguo — essa é a razão de o campo existir.
  `consumed_pp` nunca soma entre janelas incompatíveis e só é comparável
  entre mesmo `window_id` + mesmo provider.

### 2.2 Fatos de attempt e performance (M45–M48) — `src/performance/`,
`src/schemas/performance.ts`, `src/schemas/intervention.ts`

- `deriveAttemptFacts` (M45) separa, por attempt, `execution_status`,
  `had_inference` (tri-estado com provenance), `evaluation_outcome`,
  `attempt_role` e `interventions` como dimensões **ortogonais** — não existe
  mais uma classificação binária INFRA vs INFERENCE_BEARING. A regra que
  disciplina o tri-estado: `absence_of_event` nunca vira `false`; só prova
  positiva (autoritativa) decide `true` ou `false`, senão é `null`.
- `RunPerformanceRecord`/`TaskPerformanceRecord` (M46) são **derivados e
  recomputáveis** — a evidência em disco continua autoritativa, os records
  de performance nunca são a fonte de verdade. `TaskPerformanceRecord`
  particiona `operational_attempts` em with/without/unknown inference sem
  impor invariante cruzada com `infra_error_attempts` (INFRA pode
  intersectar with-inference).
- `derivePerformance` (M47) é a função pura que fecha o ciclo: história →
  record agregado. Testada só contra fixtures sintéticas (§3), nunca contra
  `.dev/` nem runtime local.
- O leitor de `data/runs/` (M48) constrói a história real sem jamais
  escolher "avaliação mais recente" — quem seleciona é o chamador
  (`EvaluationSelection`), e a seleção é gravada no record para auditoria.

### 2.3 Taxonomia v1 (M49) — `src/schemas/task-spec.ts`

Bloco `taxonomy` opcional e versionado (`version: 1`) sobre o `TaskSpec`
público: `task_class`, `difficulty_declared` obrigatórios; `complexity`,
`ambiguity`, `verification` opcionais, todos com enum `.strict()`. Aditivo de
verdade — os campos `task_class`/`difficulty` originais continuam strings
livres, e todo `TaskSpec` da era M1 (sem o bloco) segue parseando sem
alteração. `difficulty_declared` é a dificuldade que o autor da task
declarou; a dificuldade **observada** é um produto futuro do Marco 2
(§5), derivado de experimentos, nunca hardcoded.

### 2.4 Extension manifest vs incubation (M50) — `src/schemas/extension.ts`

Dois schemas deliberadamente separados, cada um em arquivo próprio:

- `ExtensionManifest` — identidade e configuração **imutável e versionada**
  (`kind`, `name`, `version`, `description`, `requires`). Nenhum campo de
  lifecycle.
- `IncubationState` — estado **mutável**, em `incubation.yaml` no mesmo
  diretório, referenciando a identidade do manifest. Mudar o status nunca
  altera o manifest nem seu hash canônico — é a mesma separação que
  `EvaluationPlan`/`TaskSpec` já impõe entre "o que é" e "o que sabe sobre
  si", aplicada agora ao ciclo de incubação do §4 do LAB_CHARTER
  (`DISCOVERED → CANDIDATE → SANDBOXED → BENCHMARKED → PROMOTED`).
  `loadExtension` trata ausência de `incubation.yaml` como `DISCOVERED`
  default em memória — nunca escreve o arquivo por conta própria.
  `strategies/` existentes não migraram para este contrato nesta tarefa.

### 2.5 `ProviderAdapter` e runtime comum (M51A/M51B) — `src/adapters/contract.ts`,
`src/runner/execute.ts`

- M51A define a **forma**: `identity`, `buildInvocation(options) → {argv,
  env?, stdin?}`, `parseLine(raw) → {event, observation?}`, mais o registry
  `resolveAdapter(cli)`. O fake foi adaptado a essa forma sem que
  `executeWithAdapter` existisse ainda — `runFakeAgent` continuou exportado
  e o comportamento observável ficou intacto (mudança de forma, não de
  runtime).
- M51B implementa `executeWithAdapter(adapter, options)` como o único lugar
  que faz spawn, timeout, cleanup de process-group e monta o
  `ExecutionRecord` — fatos objetivos de processo (exit code, sinal,
  duração, survivors) vindos do runtime, observações (usage, custo,
  terminal) vindas do adapter, com provenance mantida separada entre as
  duas fontes. Nenhum adapter replica essa mecânica. O fake passa a
  executar através do runtime comum e um teste de equivalência prova que o
  comportamento observável não mudou.
- `preflight` (checar CLI instalada/autenticada) e qualquer adapter de
  provider real (Claude, Codex) continuam fora do escopo do PRE-M2 —
  YAGNI documentado no próprio `contract.ts`: nenhum hook além do que o
  fake e os dois adapters propostos no Marco 2 exigem.

---

## 3. Fixtures sintéticas (M47) — o que cada uma prova

Todas em `test/performance/derive.test.ts`, construídas à mão (nenhuma
depende de `.dev/` ou de um run real), e cada uma isola uma combinação de
`execution_status` × `had_inference` × `attempt_role` × intervenção que o
histórico do projeto realmente produziu:

| Fixture | Combinação isolada | O que prova |
| --- | --- | --- |
| **M26-like** | 1 attempt PASS + intervenção operacional registrada | `final_pass: true` **e** `autonomous_first_pass: false` coexistem — sucesso não é o mesmo que autonomia. |
| **M33-like** | attempt 1 `INFRA_ERROR` com prova positiva de **zero** inferência, attempt 2 com inferência real e PASS | INFRA que nunca chegou a inferir não conta como tentativa "com inferência"; `first_operational_pass: false` mas `first_inference_bearing_pass: true`. |
| **infra-inference-unknown** | attempt `INFRA_ERROR` sem eventos e sem prova de zero nem de inferência | `had_inference: null` — distingue "provado zero" (M33-like) de "não dá para saber". Nenhum dos dois vira `false` por omissão. |
| **M39B-like** | attempt 1 FAIL legítimo (self-report de sucesso do provider ignorado), attempt 2 role `repair` PASS | `repair_attempts: 1`, `escalations: 0`; a proveniência do `attempt_role` vem da história fornecida, nunca é inferida do conteúdo do attempt. |
| **M23-like** | repair no mesmo effort falha, attempt seguinte com role `escalation` passa | `escalations: 1`; distingue repair (mesmo nível) de escalation (nível acima) na contagem agregada. |
| **infra-after-inference** | attempt 1 `INFRA_ERROR` com `had_inference: true` (inferência comprovada antes do crash de infra), attempt 2 PASS | terceiro caso INFRA distinto de M33-like e infra-inference-unknown: infra **depois** de inferência real, `attempts_with_inference` conta os dois attempts. |
| **unknown-intervention** | história sem nenhum registro de intervenção | `human_intervention: null` com provenance `not_recorded` e `autonomous_first_pass: null` — nunca um default `false`/`true` suposto. |

Os três casos INFRA (M33-like, infra-inference-unknown, infra-after-inference)
juntos são a prova central do M45/M47: `INFRA_ERROR` é **capability-neutral**
— não implica nada sobre `had_inference` por si só, e a única fonte legítima
para decidir `true`/`false` é evidência positiva, nunca a ausência de evento.

---

## 4. Divergências documentais tratadas

Ambas já registradas em `docs/ARCHITECTURE.md` §6.1 (M42), reafirmadas aqui
porque fazem parte do escopo de fechamento do PRE-M2:

1. **Driver de SQLite (D1).** `docs/ARCHITECTURE.md` §7 e o `package.json`
   original previam `better-sqlite3`; `src/storage/sqlite-index.ts` usa
   `node:sqlite` (`DatabaseSync`) porque `better-sqlite3` não é instalável
   no sandbox dos workers (sem toolchain de compilação). Decisão e trade-off
   (API experimental, sem paridade formal de migração) em
   [ADR-0001](../adr/ADR-0001-stack.md).
2. **`src/reporting/` é placeholder.** O relatório de um run vive hoje em
   `src/cli/report.ts`; `reporting/` fica reservado para quando o compare
   entre estratégias (Marco 2, §5) precisar de apresentação compartilhada
   entre múltiplos runs.

Nenhuma divergência nova foi introduzida em M41–M51B.

---

## 5. Plano do Marco 2 — proposto como documento (M53–M68 fora de `dev/plan.yaml`)

O que segue é uma **proposta**, não um plano adotado: nenhuma destas tarefas
existe em `dev/plan.yaml`. Elas só entram lá por uma segunda alteração após
aprovação humana explícita a este documento — é a parada obrigatória que M52
declara.

O Marco 2 usa o kernel de performance construído em M43–M48 e os contratos de
M49–M51B para produzir a primeira comparação real entre agentes/modelos sob o
control plane completo. Numeração provisória, sequencial por dependência:

| # | Título proposto | Objetivo em uma frase |
| --- | --- | --- |
| M53 | Adapter Claude real (`preflight` + `buildInvocation` + `parseLine`) | Primeiro `ProviderAdapter` não-fake, sobre `executeWithAdapter` (M51B), com `preflight` verificando CLI/autenticação antes do spawn. |
| M54 | Adapter Codex real | Segundo adapter real, provando que o contrato do M51A generaliza além de um único provider. |
| M55 | `quota-usage.json` — probe e escrita no runtime | Runtime grava `execution/quota-usage.json` quando o provider expõe consumo de cota, fechando o lado de escrita que M48 já lê. |
| M56 | Perfil de score v2 informado por `taxonomy` | Sub-scores que usam `TaskSpec.taxonomy` (M49) para normalizar por classe/dificuldade declarada, sem hardcode de categoria. |
| M57 | `agentlab compare` — agregação entre trials | Primeiro comando de comparação: agrega `TaskPerformanceRecord` (M46–M48) de N trials sob o mesmo `TaskSpec`. |
| M58 | Intervalo de confiança e variância no compare | Estatística agregada (explicitamente fora do M29/score de run individual) entra aqui, não antes. |
| M59 | Task suite piloto — 8–12 tasks com `taxonomy` completa | Conjunto real de tasks cobrindo as classes/dificuldades declaradas, base do Pilot Benchmark (§6). |
| M60 | Registro de extensão incubada — primeira estratégia além de `direct@1` | Usa `ExtensionManifest`/`IncubationState` (M50) fim a fim: uma estratégia nova nasce `DISCOVERED`. |
| M61 | Sandbox de incubação | Execução `SANDBOXED` isolada, que não conta como benchmark nem entra em `compare`. |
| M62 | Promoção `BENCHMARKED → PROMOTED` com evidência | Critério objetivo e auditável de promoção, ligado a `compare` (M57/M58). |
| M63 | Capability Matrix derivada | Primeira materialização real da matriz descrita em ARCHITECTURE.md §2.1 — derivada de `TaskPerformanceRecord` agregados, nunca hardcoded. |
| M64 | Redação de custo agregado por trial/task | `api_equivalent_usd` (M43) e `quota_usage` (M44/M55) agregados no `compare`, sem confundir estimativa com cobrança real (ver LESSONS.md 2026-08-06). |
| M65 | `agentlab report --compare` | Relatório humano do resultado de M57/M58/M63, terminal + `--json`. |
| M66 | Pilot Benchmark: execução real | Roda a suite do M59 contra os adapters do M53/M54, sob `EXPERIMENTAL`, gera evidência qualificada real. |
| M67 | Pilot Benchmark: análise e relatório | Relatório do resultado do M66 — o primeiro artefato do lab que compara agentes com evidência ponta a ponta. |
| M68 | Revisão do Marco 2 (parada obrigatória) | Mesmo padrão de M40B/M52: BACKLOG, LESSONS, ARCHITECTURE conferidos, gates verdes, parada para revisão humana antes de qualquer Marco 3. |

Riscos e decisões em aberto que a aprovação humana precisa resolver antes de
M53 virar packet real:

- **Custo de rodar adapters reais** (billing real, não fake) — política de
  quando/quantas vezes o pilot roda, dado o precedente de LESSONS.md
  2026-08-06 (estimativa ≠ cobrança).
- **Escopo da task suite piloto (M59)** — quantas classes de `taxonomy`
  cobrir na primeira rodada; sub-dimensionar é reversível, super-dimensionar
  não é (cada task nova custa autoria + validação).
- **Se M60–M63 (incubação/capability matrix) entram no mesmo Marco 2 ou
  ficam para um Marco 3** — são desacopláveis do pilot (M53–M59, M64–M68) e
  podem ser aprovados separadamente.

---

## 6. Pilot Benchmark — proposto

Objetivo do piloto: produzir a **primeira comparação real** entre pelo menos
dois adapters (Claude, Codex — M53/M54) sob o control plane completo, com
evidência qualificada suficiente para validar que o kernel de performance
(M43–M48) e o compare (M57/M58) produzem um resultado legível e defensável —
antes de investir em escala.

Desenho proposto:

1. **Suite fixa e pequena** (M59): 8–12 tasks cobrindo pelo menos
   `bugfix`, `feature` e `refactor` em `task_class`, e as três faixas de
   `difficulty_declared` (`easy`/`medium`/`hard`), com `EvaluationPlan`
   fixado antes de qualquer execução — modo `EXPERIMENTAL` por definição do
   LAB_CHARTER §3.
2. **Dois agentes, mesma task, mesma strategy** (`direct@1` — nenhuma
   estratégia nova é pré-requisito do piloto): cada `Trial` varia só
   `AgentProfile`, mantendo `EnvironmentProfile` `controlled` idêntico entre
   os dois.
3. **N ≥ 3 repetições por (task × agente)** para que M58 (intervalo de
   confiança) tenha o que agregar sem inventar significância estatística
   sobre N=1.
4. **Relatório de saída** (M67): `TaskPerformanceRecord` agregado por
   agente, custo estimado (`api_equivalent_usd`) e consumo de cota
   (`quota_usage`) por agente, taxa de `autonomous_first_pass`, e a
   Capability Matrix (M63) preenchida só para as células com dado real —
   célula sem trial correspondente fica ausente, nunca extrapolada.
5. **Fora de escopo do piloto**: qualquer decisão de produto sobre "qual
   agente usar" — o piloto produz evidência; a leitura de valor sobre ela é
   humana (LAB_CHARTER §2).

O piloto **não começa** com a aprovação deste documento sozinha: como as
demais tarefas do §5, exige M53–M59 e M64–M67 primeiro em `dev/plan.yaml`
por decisão humana explícita, e só então execução real.

---

## 7. Gates

`pnpm typecheck`, `pnpm build` e `pnpm test` verdes nesta revisão (M52).
Nenhuma alteração de `src/` ou `test/` nesta tarefa — escopo é
`docs/BACKLOG.md`, `docs/LESSONS.md` e este documento.

---

## 8. Parada obrigatória

Esta é a última task do plano operacional atual. **O Marco 2 (M53–M68 acima)
não inicia sem aprovação humana explícita** a este pacote de revisão. Até lá,
`dev/plan.yaml` permanece com M52 como última entrada.
