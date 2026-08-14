# Revisão PRE-M2 (M52)

Pacote de revisão humana ao final de M41–M51B, corrigido em M52A (gap
semântico do runtime comum), M52B (revisão após auditoria humana) e M52C
(fronteira entre a prova E2E, o checklist e o pilot real).
**Parada obrigatória**: este documento fecha o plano operacional atual
(`dev/plan.yaml` termina em M52C). M53–M68, aprovados abaixo como sequência
final do Marco 2, só entram em `dev/plan.yaml` por uma segunda alteração após
aprovação humana explícita a este pacote. Nada neste documento autoriza, por
si, o início do Marco 2; depois de M68 haverá uma nova parada humana
obrigatória antes do pilot real de 12 slots.

---

## 1. O que foi construído em M41–M52A

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
| M52A | Correção do gap semântico apontado pela revisão de M52: `ProviderObservation` (usage/cost/terminal) deixa de ser descartada pelo runtime comum | `src/runner/execute.ts`, `test/adapters/provider-observations.test.ts` |

Todas as treze tarefas fecharam com `pnpm typecheck`, o teste alvo e
`pnpm test` verdes (evidência em `.dev/completions/` e nos commits
`feat(M41)`…`feat(M52A)`).

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

### 2.5 `ProviderAdapter` e runtime comum (M51A/M51B/M52A) — `src/adapters/contract.ts`,
`src/runner/execute.ts`

- M51A define a **forma**: `identity`, `buildInvocation(options) → {argv,
  env?, stdin?}`, `parseLine(raw) → {event, observation?}`, mais o registry
  `resolveAdapter(cli)`. O fake foi adaptado a essa forma sem que
  `executeWithAdapter` existisse ainda — `runFakeAgent` continuou exportado
  e o comportamento observável ficou intacto (mudança de forma, não de
  runtime).
- M51B implementa `executeWithAdapter(adapter, options)` como o único lugar
  que faz spawn, timeout, cleanup de process-group e monta o
  `ExecutionRecord`. Na primeira versão desta tarefa, a montagem usava
  apenas `ParsedProviderLine.event` — `.observation` (usage/cost/terminal)
  chegava a ser produzida pelo `parseLine` do adapter, mas era descartada
  antes de alimentar o resultado do runtime. O fake passou a executar
  através do runtime comum e um teste de equivalência provou que o
  comportamento observável do fake não mudou; esse teste, porém, cobria
  só `record`/`events` e não detectou o descarte de `.observation` (ver
  lesson datada em `docs/LESSONS.md`).
- M52A fecha esse gap: `AdapterExecutionRun` passa a expor `parsedLines`
  (`ParsedProviderLine[]`), uma entrada por linha não vazia de stdout, na
  mesma ordem/índice de `events` — a correlação entre uma
  `ProviderObservation` e a linha que a produziu nunca fica ambígua, mesmo
  com várias linhas carregando observation. `ExecutionRecord` continua
  reunindo fatos OBJETIVOS de processo (exit code, sinal, duração,
  survivors, `ExecutionStatus`) vindos só do runtime, e métricas
  normalizadas derivadas da observation do último evento `result`:
  `usage.tokens` alimenta `metrics.tokens` (ausência vira `null` com
  provenance, nunca zero); `cost` só alimenta `metrics.api_equivalent_usd`
  quando já expresso em USD/API-equivalent — sem conversão de moeda, custo
  incompatível permanece só na observation; `terminal` permanece
  observation e nunca sobrescreve `ExecutionStatus` (`terminal: failure`
  do provider pode coexistir com `ExecutionStatus.COMPLETED`). Nenhum
  adapter replica spawn/timeout/cleanup/montagem de record; `src/schemas/
  execution-record.ts` não foi expandido para armazenar `terminal` ou um
  blob de provider.
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

## 5. Plano do Marco 2 — aprovado após auditoria humana (M53–M68 fora de `dev/plan.yaml`)

Esta seção **substitui** a proposta original de M52 (que incluía score v2,
intervalo de confiança, suite de 8–12 tasks, incubação/sandbox, promoção
`BENCHMARKED → PROMOTED`, Capability Matrix completa e marketplace/extensions
como requisitos do Marco 2). A auditoria humana considerou essa proposta
superdimensionada para um primeiro Marco 2; o documento final contém **uma
única** sequência de M2, a lista abaixo. Nenhuma destas tarefas existe em
`dev/plan.yaml` ainda — elas só entram lá por uma segunda alteração após
aprovação humana explícita a este documento, que é a parada obrigatória que
M52B declara.

O Marco 2 enxuto usa o kernel de performance construído em M43–M48 e os
contratos de M49–M52A para produzir a primeira comparação real entre dois
perfis Claude, com um smoke mínimo em Codex. Sequência final, sequencial por
dependência:

| # | Título | Objetivo em uma frase |
| --- | --- | --- |
| M53 | Corpus experimental inicial | Corpus fixo de tasks para o piloto do §6 — sem ampliar para suite de 8–12 tasks nesta fase. |
| M54 | Billing guard | Guarda capaz de impedir novo launch quando o consumo de cota/billing não permite mais execução real. |
| M55 | Credential proof | Prova de que a CLI de um provider está instalada e autenticada antes do primeiro spawn real. |
| M56 | Claude invocation | `buildInvocation` real para a CLI Claude, sobre `executeWithAdapter` (M51B/M52A). |
| M57 | Claude stream parser | `parseLine` real da CLI Claude — eventos normalizados + `ProviderObservation` (usage/cost/terminal). |
| M58 | Claude ProviderAdapter | Primeiro `ProviderAdapter` não-fake completo (identity + preflight + buildInvocation + parseLine), registrado em `resolveAdapter`. |
| M59 | Claude quota probe | Probe de consumo de cota do Claude, escrevendo `execution/quota-usage.json` (fecha o lado de escrita que M48 já lê). |
| M60 | Codex invocation | `buildInvocation` real para a CLI Codex. |
| M61 | Codex ProviderAdapter | Segundo `ProviderAdapter` real, provando que o contrato do M51A generaliza além de um único provider — apenas para o smoke do §6, não um segundo braço completo do piloto. |
| M62 | executeRun / integração de adapter | Fecha a integração diferida em M52A: `resolveAdapter(profile.cli) → adapter.buildInvocation(...) → executeWithAdapter(...)` ponta a ponta. |
| M63 | CLI experimental | Comando `agentlab` para lançar o piloto do §6 sob modo `EXPERIMENTAL`. |
| M64 | ExperimentSpec freeze | `ExperimentSpec` do piloto (arms, tasks, repetições, seed, counterbalancing) congelada antes de qualquer execução real. |
| M65 | Experiment runner seeded/counterbalanced | Runner que executa o `ExperimentSpec` congelado — sequential, seeded, interleaved/counterbalanced entre arms. |
| M66 | Compare | Agregação de `TaskPerformanceRecord` (M46–M48) entre arms do piloto — só `QUALIFIED` entra; resultado por task antes do agregado global. |
| M67 | E2E da infraestrutura experimental | Prova que `ExperimentSpec → ProviderAdapter → executeRun → evidence → evaluation → qualification → performance → compare` funciona ponta a ponta com fixtures, fake adapters, ambientes determinísticos e evidência sintética/controlada; smoke real mínimo somente quando explicitamente autorizado e necessário. Não executa os 12 slots nem produz a conclusão comparativa Medium vs High. |
| M68 | Revisão M2 + pilot checklist | Última tarefa operacional antes do pilot real: confere o M2 e todos os pré-requisitos do pilot, fecha gates e impõe parada humana obrigatória; não lança nenhum dos 12 slots. |

Itens que saem da sequência inicial do Marco 2 e, quando úteis, ficam
registrados como candidatos a **Marco 3 ou follow-up pós-piloto** (não são
requisito de M53–M68):

- Perfil de score v2 informado por `taxonomy` (era M56 na proposta antiga).
- Intervalo de confiança/variância como requisito do compare (era M58).
- Suite de 8–12 tasks cobrindo todas as classes/dificuldades declaradas (era
  M59) — o corpus do piloto (M53) fica menor e fixo.
- Estratégia nova ou incubação como pré-requisito do Marco 2 (era M60).
- Sandbox de incubação (era M61).
- Promoção `BENCHMARKED → PROMOTED` (era M62).
- Capability Matrix completa derivada (era M63) — o compare do piloto (M66)
  produz resultado por task/arm, não a matriz inteira.
- Marketplace/extensions.

Riscos e decisões em aberto que a aprovação humana precisa resolver antes de
M53 virar packet real:

- **Custo de rodar adapters reais** (billing real, não fake) — política de
  quando/quantas vezes o pilot roda, dado o precedente de LESSONS.md
  2026-08-06 (estimativa ≠ cobrança); M54 (billing guard) é pré-requisito
  bloqueante de qualquer execução real.
- **Escopo do corpus piloto (M53)** — fixo em 3 tasks para o piloto atual
  (§6); ampliar para suite maior fica para o follow-up listado acima.
- **Codex como smoke, não segundo braço** — M60/M61 provam que o contrato
  generaliza, mas o primeiro benchmark comparativo real (§6) é só
  Claude Sonnet 5 Medium vs High; nenhuma decisão de produto sobre Codex sai
  deste Marco 2.

---

## 6. Pilot Benchmark — desenho aprovado após auditoria humana

Objetivo do piloto: produzir a **primeira comparação real** entre dois
perfis do mesmo provider (Claude Sonnet 5 Medium vs Claude Sonnet 5 High)
sob o control plane completo, com evidência qualificada suficiente para
validar que o kernel de performance (M43–M48) e o compare (M66) produzem um
resultado legível e defensável — antes de investir em escala ou em um
segundo provider como braço completo.

Desenho aprovado:

1. **2 arms**: Claude Sonnet 5 Medium vs Claude Sonnet 5 High — mesmo
   `TaskSpec`, mesma `Strategy` (`direct@1`) e mesmo `EnvironmentProfile`
   `controlled` entre os dois; só `AgentProfile`/reasoning effort varia.
2. **3 tasks × 2 repetições por (task × arm)** — corpus fixo do M53 (§5),
   não a suite de 8–12 tasks da proposta antiga.
3. **12 slots inference-bearing planejados** (2 arms × 3 tasks × 2
   repetições), execução **sequential**, **seeded** e
   **interleaved/counterbalanced** entre arms — nunca todos os slots de um
   arm antes do outro, para não confundir efeito de ordem com efeito de
   arm.
4. **Só `QUALIFIED` entra no compare** (M66); `INFRA_ERROR` consome um slot
   de retry e **não** vira capability FAIL — é capability-neutral, mesma
   regra de `deriveAttemptFacts` (M45/§3).
5. **Resultados por task antes do agregado global** — o compare reporta
   cada task individualmente primeiro; o agregado entre as 3 tasks vem
   depois, nunca substitui a leitura por task.
6. **Quota stop em ≥80%** de consumo de cota observado (`QuotaUsage`,
   M44/M59) interrompe o lançamento de novos slots do piloto.
7. **Billing guard (M54) pode impedir novo launch** — nenhum slot adicional
   é lançado sem essa guarda permitir explicitamente.
8. **Codex é smoke real mínimo** (M60/M61) — prova que a CLI Codex invoca e
   parseia via `executeWithAdapter`, explicitamente **não** um segundo braço
   completo deste primeiro benchmark comparativo.
9. **Nenhuma execução adicional ocorre sem billing authorization** — cada
   lançamento de slot real (Claude ou o smoke Codex) exige autorização de
   billing explícita antes do spawn.
10. **Fora de escopo do piloto**: qualquer decisão de produto sobre "qual
    perfil/agente usar" — o piloto produz evidência; a leitura de valor
    sobre ela é humana (LAB_CHARTER §2).

M67 prova a infraestrutura capaz de realizar este experimento, não realiza o
experimento: seu E2E é baseado primordialmente em fixtures, fake adapters,
ambientes determinísticos e evidência sintética/controlada. Um smoke real
mínimo só pode ocorrer quando for necessário para provar a integração real,
for explicitamente autorizado, o billing guard permitir e a credential proof
passar. Mesmo nesse caso, M67 não lança o pilot completo, não consome seus 12
slots planejados e não produz uma conclusão comparativa final Medium vs High.

M68 é a última tarefa operacional do M2 antes do pilot real. Seu checklist
exige: M53–M67 `PASS`; gates verdes; `recover CLEAN`; contratos de evidence
íntegros; billing guard, credential proof e quota probe funcionais;
`ExperimentSpec` congelado; corpus de 3 tasks aprovado; seed, ordem e
counterbalancing definidos; retry policy de `INFRA` definida; compare restrito
a `QUALIFIED`; quota stop em ≥80%; profiles Medium/High corretos; Codex mantido
somente como smoke; e custo máximo/billing authorization definidos. M68 não
lança automaticamente nenhum dos 12 slots e termina em **parada humana
obrigatória**.

O pilot real só começa depois de M68 e de uma nova aprovação humana explícita.
Essa aprovação posterior autoriza o lançamento sequential, seeded e
interleaved/counterbalanced dos 12 slots, sempre sujeito ao billing guard,
quota stop e às demais regras acima; não autoriza execuções adicionais além do
limite de custo aprovado.

---

## 7. Gates

`pnpm typecheck`, `pnpm build` e `pnpm test` verdes em M52A (correção do
runtime comum) e na revisão corrigida M52B. M52C altera somente a fronteira
documental descrita acima; não altera `src/`, `test/`, providers nem o desenho
aprovado do experimento.

---

## 8. Parada obrigatória

M52C cria uma nova parada obrigatória. **O Marco 2 (M53–M68 acima) não inicia
sem aprovação humana explícita** a este pacote corrigido. Até lá,
`dev/plan.yaml` permanece com M52C como última entrada. Se M53–M68 forem
posteriormente aprovados e concluídos, M68 encerra com outra parada humana
obrigatória: o pilot real de 12 slots só começa após aprovação explícita nova,
posterior a M68.
