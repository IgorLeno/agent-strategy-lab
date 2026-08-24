# Arquitetura do `agentlab`

Control plane autônomo, fundado em evidência, para condução de projetos por
agentes de IA — ver [README.md](../README.md) e
[ADR-0003](adr/ADR-0003-control-plane-identity.md), que define o vocabulário
oficial usado neste documento:

- **Evidence Kernel** — a máquina de confiabilidade da medição (storage,
  envelopes, manifests, integridade, redaction; sentido de
  [ADR-0002](adr/ADR-0002-evidence-kernel.md));
- **Orchestration Control Plane** — o lifecycle de condução de projetos
  (intake → inspection → planning → routing → execução → validação →
  recovery), com contratos em `src/` e runtime em `dev/lib/`;
- **Experimental Plane** — experimentos controlados que produzem a evidência
  que ensina o routing.

O medidor empírico de agentes continua existindo — como Experimental Plane, a
serviço do control plane, não como definição do produto.

> **Estado v0.1 operacional.** O entrypoint canônico `pnpm lab run` aceita
> uma Run Directive (header estruturado + corpo), persiste o documento raw,
> deriva `ProjectIntakeRequest` do corpo, aplica o preset
> `local-autonomous-development` com overlay do header e reutiliza
> `submitHumanInstruction` / `runProject` / `runPlan`. Flags `--repo` /
> `--self` / `--resume` permanecem como interface avançada. Self-maintenance
> (`target.type: self`) executa num git worktree isolado; o processo do
> control plane continua na SHA original até um fast-forward fail-closed no
> fim. A evolução seguinte está descrita
> em
> [docs/superpowers/plans/2026-08-21-agentlab-control-plane-jcode-evolution.md](superpowers/plans/2026-08-21-agentlab-control-plane-jcode-evolution.md).
> Post-v0.1 capabilities M95–M126 are evidence-triggered backlog. They are not
> blockers for real-project operation.
> Onde houver divergência futura, o código é a autoridade.

---

## 1. Princípio central: três dimensões independentes

A maior parte dos erros de medição em benchmark de agente vem de colapsar
perguntas diferentes num campo só. Aqui elas são **enums separados**, e nenhum
valor aparece em dois deles:

| Dimensão | Pergunta | Valores |
| --- | --- | --- |
| **Execução** | O processo do agente chegou ao fim? | `COMPLETED` `TIMED_OUT` `CRASHED` `CANCELLED` `INFRA_ERROR` |
| **Avaliação** | O trabalho produzido passa nos graders? | `PASS` `FAIL` `PARTIAL` `NOT_EVALUATED` |
| **Qualificação** | O resultado pode entrar numa comparação? | `QUALIFIED` `UNSCORABLE` `MISSCOPED` `CONTAMINATED` `INVALID_ENVIRONMENT` `HISTORICAL_ONLY` |

Consequências que o resto do desenho respeita:

- um agente que **completa** e entrega código errado é `COMPLETED` + `FAIL` —
  não é crash;
- um crash de infraestrutura é `INFRA_ERROR` e **não** vira veredito sobre o
  agente: o trial é repetido, o run não conta como falha dele;
- um run pode ser tecnicamente perfeito e ainda assim `UNSCORABLE`, quando
  falta métrica obrigatória para o perfil de score.

Corolário de medição: **métrica ausente é `null` com origem registrada, nunca
zero**. Zero é uma medição; ausência é a falta de uma. Provenance é por campo,
não por record.

---

## 2. Modelo de dados

### 2.1 Entrada — o que o humano define

| Entidade | Área | Papel | Vaza para o agente? |
| --- | --- | --- | --- |
| `TaskSpec` | `schemas` | id, descrição, critérios **visíveis**, classe, dificuldade, stack, graders públicos, budgets | **sim, por desenho** |
| `EvaluationPlan` | `schemas` | graders ocultos, rubrica, pesos | **nunca** |
| `AgentProfile` | `schemas` | CLI, versão, modelo, flags | não |
| `EnvironmentProfile` | `schemas` | `controlled` \| `real-world`, allowlist de env, fingerprint dos instruction files, plugins/skills/MCPs | não |
| `StrategyDef` | `strategies` | receita declarativa versionada, em `strategies/<nome>/<versão>/strategy.yaml` | o prompt compilado, sim |

`TaskSpec` e `EvaluationPlan` são **tipos independentes**, gravados em arquivos
separados, sem herança nem campo compartilhado. Não é estilo: qualquer reuso
entre os dois é um caminho por onde rubrica oculta chega ao workspace do
agente e o benchmark deixa de medir o que diz medir.

`EnvironmentProfile` tem dois modos e eles **não se misturam em comparação**.
`controlled` exige allowlist explícita e HOME sanitizado; `real-world` registra
o que **não** foi controlado, em vez de omitir. Perfil que não desliga
descoberta de instruction files é `real-world` — mesmo que a intenção fosse
outra.

`TaskSpec.taxonomy` é um bloco opcional e versionado (`version: 1`) com
enums estritos para `task_class`, `difficulty_declared` e, opcionalmente,
`complexity`, `ambiguity` e `verification`. Os campos `task_class` e
`difficulty` originais do `TaskSpec` continuam strings livres — nenhum
TaskSpec histórico deixa de parsear. `difficulty_declared` é a dificuldade
que o autor da task declarou; não é a dificuldade observada. A **Capability
Matrix** (o que cada perfil consegue em cada categoria de taxonomia) é, por
desenho, **derivada** de evidência — nunca opinião hardcoded — e nenhuma
categoria nova entra na taxonomia antes de haver dados que a justifiquem.
Estado atual honesto: o código de derivação ainda não existe (`data/runs/`
não tem amostra real), e o router determinístico usa um mapeamento estático
de tier por nome de modelo como aproximação provisória — divergência
registrada na Seção 6.2.

### 2.2 Planejamento e execução

```
Trial            = Agent × Model × Strategy × EnvironmentProfile × TaskSpec
                   status: PLANNED | EXECUTED | CANCELLED | REPEATED
ExecutionRequest = Trial + base SHA + budgets + timeout
Run              = uma materialização de um ExecutionRequest
```

O `Trial` é a unidade de **intenção**; o run é a unidade de **evidência**.
Separá-los é o que permite repetir um trial após falha de infraestrutura sem
contaminar a estatística com um "resultado" que nunca foi sobre o agente.

### 2.3 Saída — o que o lab deriva

| Record | Área | Contém |
| --- | --- | --- |
| `ExecutionRecord` | `schemas` | status da dimensão de execução, exit code, duração, `execution_envelope_sha256`, métricas com provenance por campo |
| `EvaluationRecord` | `schemas` | `evaluation_id`, outcome da dimensão de avaliação, resultado por grader, versões dos graders, `evaluation_envelope_sha256` |
| `ScoreRecord` | `schemas` | `score_profile_id` + versão, sub-scores, budgets usados, coverage |
| `QualificationRecord` | `schemas` | status da dimensão de qualificação + justificativa obrigatória quando não é `QUALIFIED` |

Cardinalidade: **um run tem N avaliações, e cada avaliação tem N scores.**
Reavaliar com graders novos, ou repontuar com outro perfil de score, cria
diretório novo — nunca sobrescreve o anterior. Resultado antigo continua
auditável mesmo depois de a rubrica mudar.

### 2.4 Score: o que o perfil pode e não pode fazer

Sub-scores de tempo, tokens e escopo são relativos aos budgets
`expected`/`maximum` do `TaskSpec`, não a constantes mágicas. Outcome `FAIL`
impõe teto. E a regra que não se negocia:

- métrica **obrigatória** ausente → `UNSCORABLE`;
- métrica **opcional** ausente → sub-score `null` e **coverage menor**, com o
  peso preservado.

Redistribuir o peso de um sub-score ausente inflaria a nota de exatamente os
runs em que se mediu menos — o viés apareceria como mérito.

Score é de **um run**. Variância, intervalo de confiança e comparação entre
estratégias são a fase de compare, fora do Marco 1.

---

## 3. Layout de evidência

Fonte de verdade é o **disco**. O índice SQLite é derivado, descartável e
reconstruível (M31); nenhum dado existe apenas nele.

Raiz: `<lab>/data/` por default, sobrescrita por `AGENTLAB_DATA_DIR` ou pela
config do projeto. `data/` não é versionado.

```
data/runs/<run-id>/                      run-id ULID: ordenável por tempo
├── metadata.json                        criado com o run dir
├── ledger.jsonl                         append-only lógico: uma entrada por seção adicionada
│
├── execution/                           SELADO exatamente uma vez
│   ├── manifest.json                    sha256 por artifact + digest agregado
│   ├── execution-record.json
│   ├── execution-envelope.json
│   ├── prompt/                          prompt compilado entregue ao agente
│   ├── events.jsonl                     eventos normalizados (interface interna)
│   ├── provider-sanitized.jsonl         stream do provider, já redigido
│   ├── stdout.log  stderr.log           captura incremental, já redigida
│   └── changes/
│       ├── changes.patch                reaplica sobre o base SHA
│       └── changes-manifest.json        arquivos, hashes, material_tree_sha256
│
├── evaluations/<evaluation-id>/         uma por avaliação; nunca sobrescrita
│   ├── manifest.json
│   ├── evaluation-record.json
│   ├── evaluation-envelope.json
│   └── grader-artifacts/                saída dos graders, redigida
│
└── scores/<score-id>/                   um por (avaliação × perfil de score)
    ├── manifest.json
    ├── score-record.json
    └── qualification-record.json
```

**Cada seção tem manifest próprio e independente.** Um manifest único na raiz
teria que ser reescrito a cada avaliação nova — e reescrever o manifest que
prova a execução é justamente perder a prova. `execution/` é selado uma vez;
tentar selar de novo falha explicitamente.

O `ledger.jsonl` amarra as seções: cada adição vira entrada nova, entrada
anterior nunca é reescrita.

### 3.1 O que a integridade detecta

Verificação de integridade (M15) precisa pegar, no mínimo:

1. alteração de conteúdo — **inclusive troca por outro valor válido no
   schema** (é o caso que schema sozinho não pega);
2. remoção de um artifact listado no manifest;
3. reordenação de linhas de um JSONL;
4. edição de uma entrada antiga do ledger.

### 3.2 Redaction

Aplicada **antes de qualquer persistência**, não depois — não existe passagem
de limpeza sobre `data/`. Cobre stdout, stderr e o stream do provider, e é
recursiva sobre objetos e mapas de ambiente, preservando a forma e as chaves e
redigindo só o valor. Chave sensível **por nome** é redigida mesmo quando o
valor não bate com nenhum formato conhecido.

---

## 4. Reprodutibilidade: dois envelopes

```
execution_envelope_sha256  = TaskSpec + Strategy + prompt compilado + base SHA
                           + AgentProfile + EnvironmentProfile + modelo
                           + flags da CLI + adapter/versão + budgets + timeout

evaluation_envelope_sha256 = digest do execution manifest + EvaluationPlan
                           + versões dos graders + ambiente do evaluator
                           + comandos de avaliação
```

Ambos por serialização canônica: a ordem das chaves na entrada não pode afetar
o hash.

São dois porque as perguntas são duas. Mudar uma flag da CLI muda a execução e
o envelope de execução. Mudar um hidden grader muda **só** o de avaliação — com
envelope único, trocar a rubrica exigiria re-executar o agente, e o custo disso
faria a rubrica nunca mudar.

---

## 5. Isolamento da execução

**Clone descartável, nunca linked worktree.** Um worktree compartilha objects,
refs e config com o repositório do usuário — e o agente alcança tudo isso. O
clone tem objects próprios, sem `alternates` apontando para o repo-alvo, está
exatamente no base SHA e não herda remote com credencial. É descartado ao fim
do run **inclusive no caminho de erro**; cleanup não confirmado é reportado
como erro, não silenciado.

**Sinais vão ao process group.** O processo é criado em grupo próprio
(`setsid`) e o timeout é SIGTERM → graça → SIGKILL **no grupo**. Matar só o pai
deixa descendente vivo mexendo no workspace depois que o run "terminou". Depois
do kill, sobreviventes são procurados; cleanup não confirmável marca o run como
`INFRA_ERROR`, nunca `COMPLETED` silencioso.

**O evaluator tem workspace separado** — outro clone do mesmo base SHA, com o
`changes.patch` aplicado. É ali, e só ali, que o `EvaluationPlan` é injetado.
O workspace do agente nunca o vê, e M39A verifica isso por busca no snapshot.

**Nenhuma interpolação de shell em nenhum caminho.** Processo é sempre `argv`.

---

## 6. Áreas de `src/`

Uma área por diretório, com `index.ts` documentando responsabilidade e
fronteira.

| Área | Responsabilidade | Camada | Microtarefas |
| --- | --- | --- | --- |
| `core` | enums das três dimensões, tipos base, hierarquia de erros. Zero I/O | STABLE KERNEL | M02 |
| `schemas` | schemas zod de todos os contratos | STABLE KERNEL | M03–M09 |
| `envelope` | serialização canônica e os dois hashes | STABLE KERNEL | M10 |
| `storage` | run dir, JSONL, manifests, ledger, integridade, redaction, índice SQLite | EXECUTION CONTRACT | M11–M17, M30, M31 |
| `workspace` | clone descartável, cleanup, change bundle | EXECUTION CONTRACT | M18–M20 |
| `runner` | spawn por argv, captura, timeout, process group, sobreviventes | EXECUTION CONTRACT | M21–M24B |
| `adapters` | CLI de provider → interface interna | EXECUTION CONTRACT | M25, M26 |
| `billing` | autorização provider-neutral anterior ao launch real | EXECUTION CONTRACT | M54 |
| `credentials` | prova sanitizada e provider-neutral da fonte da credencial | EXECUTION CONTRACT | M55 |
| `strategies` | carga e validação das receitas em `strategies/` | EXPERIMENT PLANE | M05 |
| `experiment` | congelamento/hash de `ExperimentSpec` (arms, corpus, repetitions, seed, ordering, strategy, environment, billing policy) | EXPERIMENT PLANE | M64 |
| `evaluator` | workspace do evaluator, graders, orquestração da avaliação | EXECUTION CONTRACT | M27A–M28 |
| `scorer` | perfis de score, qualificação | EXECUTION CONTRACT | M29 |
| `reporting` | relatório de terminal e `--json`; compare entre arms do piloto | EXTENSIONS | M38, M66 |
| `performance` | fatos de attempt, records derivados e consulta read-only de séries comparáveis | EXTENSIONS | M45–M48, M81 |
| `project` | `.agentlab/project.yaml`, resolução do data dir | CONTROL PLANE | M11, M33 |
| `cli` | comandos `agentlab` | CONTROL PLANE | M32–M38 |
| `intake` | `ProjectIntakeRequest` e `ExecutionAuthorizationScope`: pedido formal sobre repo externo e separação entre escopo pedido e ações autorizadas sem novo gate | CONTROL PLANE | M71 |
| `inspection` | inspeção read-only, facts de repositório/ambiente e mapa de instruções/source anchors | CONTROL PLANE | M72 |
| `planner` | `PlannedTask`, AVC, policy Direct/Reviewed, assessment, planning draft não confiável e projeção autorizada | CONTROL PLANE | M73–M76, M83 |
| `routing` | capability registry, routing inicial/histórico, diagnosis e escalation seletiva/cross-provider | CONTROL PLANE | M77–M82 |

- **STABLE KERNEL** — vocabulário e contratos que todo o resto importa; zero
  I/O ou serialização canônica, muda raramente e qualquer mudança é
  cross-cutting por definição.
- **EXECUTION CONTRACT** — a mecânica que produz e verifica evidência de um
  trial: isolamento, captura, adapters, avaliação e score. É o que a Seção 3
  a 5 deste documento descreve.
- **EXPERIMENT PLANE** — as receitas declaráveis que variam entre trials
  (`strategies/`); o que muda quando se testa uma estratégia nova, não o lab.
- **CONTROL PLANE** — no sentido do vocabulário de
  [ADR-0003](adr/ADR-0003-control-plane-identity.md), estas são as áreas de
  **contratos do Orchestration Control Plane**: decisão pura, zero I/O de
  provider (`cli`, `project`, `intake`, `inspection`, `planner`, `routing`).
- **EXTENSIONS** — funcionalidade fora do caminho crítico de execução/
  avaliação, hoje placeholder ou em construção.

Dependências apontam para baixo: `cli` → tudo; `core` não importa ninguém.
`src/` nunca importa `dev/`; `dev/` importa `src/` livremente. A consequência
prática: **`src/` carrega contratos e decisão; `dev/lib/` carrega o runtime
que produz efeito** (spawn, estado, recovery, evidência de projeto).

### 6.1 Orchestration Control Plane universal (Marco 3 + pós-M86)

O **Agent Strategy Lab é o control plane**. Claude Code e Codex são workers
descartáveis: recebem packet bounded, role, workspace e budget; não possuem o
DAG, o estado autoritativo, routing/escalation, billing policy, commit oficial
ou decisão de PASS. O lifecycle em `dev/lib/project-orchestrate.ts` reutiliza as
primitives existentes de launch, close, recovery e evidence.

O **runtime** do control plane vive hoje em `dev/lib/` — os módulos
`project-run.ts` (a costura `ProjectControlPlane`, porta única e opcional do
loop de orquestração: ausente, o comportamento histórico é bit-idêntico),
`project-orchestrate.ts` (gate de launch, roles estruturais, adapters de
provider para planner/reviewer), `project-authorization.ts` (contrato do
`agentlab-run.yaml`), `project-preflight.ts` (fatos tri-state),
`project-roles.ts` (overlay read-only por argv) e `project-history.ts`
(materialização de attempts como runs canônicos). Isso excede a definição
original de `dev/` como "harness de bootstrap descartável" — dívida de
consolidação registrada em [ADR-0003](adr/ADR-0003-control-plane-identity.md)
e no plano do Marco 4, não resolvida por este documento.

A história canônica de projetos externos é gravada no `data/` da instalação
do Lab (não do repo alvo), com identidade de projeto obrigatória
(fingerprint da work definition + bindings) — decisão D4, ratificada em
ADR-0003. O layout da Seção 3 vale também para esses runs.

```text
HumanInstruction (raw, persistida antes de qualquer provider)
  → compile estrutural → ProjectIntakeRequest
  → ExecutionAuthorizationScope (preset; nunca inferido do prompt)
  → inspection read-only / minimal factual preflight
  → Direct Task Normalization OU planning worker draft não confiável
  → PlannedTask + AVC + plan/assessment policy
  → capability/history routing + worker runtime budget
  → implementer → validation → fresh review (quando exigido)
  → PASS | repair/replan | CAPABILITY escalation | HUMAN_REQUIRED
```

O princípio que ordena todas as fronteiras abaixo:

> **CONTROL THE BOUNDARIES, NOT THE IMPLEMENTATION.**
> O control plane é dono de escopo, autorização, Git safety, credenciais,
> billing, routing, budgets, validação oficial, retries, escalation, ações
> destrutivas/externas e decisões genuinamente humanas. Como o coding agent
> explora o repositório, o que lê, qual abordagem escolhe, o que refatora e
> quais ferramentas auxiliares usa é decisão dele.

> **UNCERTAINTY SHOULD ROUTE OR ESCALATE CAPABILITY BEFORE IT BLOCKS WORK.**
> Complexidade, ambiguidade, escopo amplo e estimativas altas são insumo de
> assessment, routing, effort e budget — escolhem um modelo mais capaz, não
> recusam o plano. Bloqueio exige um risco concreto: uma fronteira de
> execução/rollback objetivamente excedida, ou uma das proteções acima.

As fronteiras principais são:

- **AVC não é um relógio.** Decomposição responde à coerência e validação
  independente da mudança. Task longa pode permanecer una; task curta pode
  precisar de split. `DECOMPOSITION_REQUIRED` fica reservado à fronteira de
  execução/rollback objetivamente excedida — não a "isto é difícil".
- **O planner conhece o contrato que precisa produzir.** O prompt do planning
  worker expõe `PlannedTask` compactamente (campos, enums, unidades). O gate de
  normalização continua estrito e sem mapeamento heurístico: a saída do modelo
  não é adivinhada, ela é especificada.
- **Objetivos do usuário são piso, não teto.** `USER OBJECTIVES ⊆ PLAN
  ACCEPTANCE`: todo objetivo original precisa aparecer verbatim em alguma task;
  critérios técnicos adicionais da work unit são legítimos.
- **DAG de projeto tem múltiplas raízes.** Componentes independentes
  (fundação, domínio, assets, infraestrutura) são estrutura normal de plano.
  Ciclo, dependência inexistente, auto-dependência e id duplicado continuam
  recusados.
- **Ausência não é impedimento.** Um repositório greenfield — sem
  `package.json`, lockfile, build, testes ou instruções — é executável: a
  primeira work unit existe para criar isso. Continuam bloqueando repositório
  inacessível, estado de git desconhecido, base SHA divergente, filesystem não
  gravável, credencial obrigatória ausente e ação externa/destrutiva não
  autorizada.
- **Review independente é proporcional.** Exigida por razão concreta — risco
  alto/crítico, evidência de verificação fraca, confiança baixa, repair
  significativo ou escalation —, não por default. O caminho `REVIEWED` classifica
  a work unit; por si só ele não lança um segundo LLM. Quando exigida, a regra
  não muda: validation PASS + review ACCEPT = PASS.
- **A inteligência do planejamento chega ao routing.** Planos gerados carregam
  `planner_metadata` por task (taxonomy, risco, envelope, escopo de contexto);
  o executor usa essa classificação. PlanFiles manuais seguem no fallback de
  `agentlab-run.yaml`, e o default global nunca sobrescreve o planner.
- **Tempos não se cruzam.** `estimated_duration` estima a task;
  `worker_runtime_budget` limita o processo contra o bound do launcher/profile;
  `validation[].timeout_seconds` limita um comando contra o contrato de
  validation. Violação de runtime é `BUDGET_UNSUPPORTED` com bound nomeado.
- **Contexto é montado por mapa.** Inspection registra instruction files,
  source anchors e relevância; documentação não é concatenada num prompt.
- **DIRECT não significa sem fatos.** Ele exige minimal factual preflight e
  normalização determinística. Ambiguidade ou fato ausente segue REVIEWED.
- **Autorização é de escopo.** `requested_scope` registra o pedido, enquanto o
  boundary enumera capabilities autônomas. Spawns, bounded repair e escalation
  dentro da ladder/policy não criam aprovação repetitiva; billing/credential
  novo, destruição, efeitos externos, deploy, expansão, risco crítico ou
  profile/provider fora da policy exigem `HUMAN_REQUIRED`.
- **Roles são estruturais.** Planner/reviewer são read-only por argv/settings e
  ownership, não por promessa no prompt; implementer muta apenas o workspace
  autorizado. Review usa invocação e contexto frescos; diversidade adicional é
  proporcional ao risco.
- **Escalation começa por diagnosis.** Só CAPABILITY após bounded repair usa a
  ladder. Environment, context, task definition, tooling e infra não são
  transformados em pedido de modelo maior.
- **História não é completada por imaginação.** M81 lê sem escrever;
  `ComparableRunFacts` é contrato puro em `src/performance/comparable-run.ts`,
  gravado aditivamente pelo evidence path de M84. `UNKNOWN` e provenance
  impedem fusão indevida; M82 cai no router determinístico M78 quando a série
  não decide.

O `pilot-v1` permanece uma superfície experimental separada: seu
`ExperimentSpec` congelado, fingerprint, profiles, corpus e
`runExperimentSchedule` genérico não são reconfigurados pelo lifecycle de
projetos.

### 6.2 Divergências entre este documento e o código

Registradas aqui, em vez de silenciosamente corrigidas, porque cada uma tem
uma decisão por trás que vale preservar.

**Driver de SQLite.** A Seção 7 e o `package.json` originais previam
`better-sqlite3` (addon nativo). `src/storage/sqlite-index.ts` usa
`node:sqlite` (`DatabaseSync`) — decisão **D1**: manter `node:sqlite` porque
`better-sqlite3` não é instalável no sandbox de execução dos workers (sem
toolchain de compilação nem prebuild compatível disponível). O motivo e o
trade-off aceito — API experimental na linha 22, sem paridade formal de
migração — estão registrados em [ADR-0001](adr/ADR-0001-stack.md); esta seção
só aponta que a implementação já vive no lado `node:sqlite` daquele ADR, e não
no lado nomeado na Seção 7.

**`reporting/` era placeholder até M66.** O relatório de um run (M38) segue
vivendo inteiramente em `src/cli/report.ts` (formatação texto/`--json` a
partir da evidência selada) — `reporting/` nunca implementou isso. A área foi
reservada para quando o compare entre estratégias (ver Seção 2.4) precisasse
de lógica de apresentação compartilhada entre múltiplos runs, e é exatamente
onde ela nasceu: `src/reporting/compare.ts` (M66) compara
`TaskPerformanceRecord`s QUALIFIED entre arms, por task antes do agregado,
sem fabricar confidence interval, Capability Matrix ou vencedor automático.

**Tier de capability por regex de nome de modelo.** A Seção 2.1 declara que
capability é derivada de evidência; `src/routing/router.ts`
(`MODEL_TIER_PATTERNS`/`MODEL_COST_PATTERNS`) mapeia tier e custo por padrões
estáticos sobre o nome do modelo. É deliberadamente fail-closed (modelo que
não casa com nenhum padrão vira `CAPABILITY_UNCLASSIFIED` e é rejeitado, nunca
adivinhado), mas é uma aproximação hardcoded que exige edição de código a cada
modelo novo. Permanece até a Capability Matrix derivada de experimentos
existir; a substituição é trabalho futuro fora do Marco 4.

---

## 7. Stack

Node ≥ 22.13.0, TypeScript ESM (`NodeNext`), `zod` para schemas, `yaml` para
receitas e config, `vitest` para testes, `pnpm`. Índice em SQLite via
`node:sqlite` (`DatabaseSync`), a partir de M30 — ver a divergência D1
registrada na Seção 6.1.

A escolha do driver de SQLite e o risco de addon nativo estão em
[ADR-0001](adr/ADR-0001-stack.md).

---

## 8. Documentos relacionados

- [BACKLOG.md](BACKLOG.md) — espelho humano de `dev/plan.yaml`
- [LESSONS.md](LESSONS.md) — correções que viraram regra
- [HARNESS.md](HARNESS.md) — runtime de execução e sessões descartáveis (`dev/`)
- [BILLING.md](BILLING.md) — política de cobrança dos workers
- [adr/ADR-0001-stack.md](adr/ADR-0001-stack.md) — stack e driver de SQLite
- [adr/ADR-0002-evidence-kernel.md](adr/ADR-0002-evidence-kernel.md) — Evidence
  Kernel, critérios de inclusão, execution contract
- [adr/ADR-0003-control-plane-identity.md](adr/ADR-0003-control-plane-identity.md)
  — identidade de control plane, vocabulário oficial, reversão do non-goal de
  adaptive routing, decisão D4
