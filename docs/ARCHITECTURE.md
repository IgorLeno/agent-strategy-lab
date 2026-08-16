# Arquitetura do `agentlab`

Laboratório empírico para medir desempenho de agentes de código sob diferentes
estratégias, modelos e stacks. O produto é a CLI `agentlab` (`src/`); o harness
de sessões descartáveis que o constrói é outra coisa e vive em `dev/`
([HARNESS.md](HARNESS.md)).

> **Estado em M40B (fim do Marco 1).** Todas as microtarefas M01–M40A estão
> implementadas; este documento foi conferido contra `src/` na revisão de
> fechamento do marco. Onde houver divergência futura, o código é a
> autoridade.

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
Matrix** (o que cada perfil consegue em cada categoria de taxonomia) é
**derivada** dos experimentos rodados — não existe matriz hardcoded no
código, e nenhuma categoria nova entra na taxonomia antes de haver dados de
experimentos que a justifiquem.

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
| `performance` | fatos de attempt e records de performance derivados, sem I/O | EXTENSIONS | M45–M48 |
| `project` | `.agentlab/project.yaml`, resolução do data dir | CONTROL PLANE | M11, M33 |
| `cli` | comandos `agentlab` | CONTROL PLANE | M32–M38 |

- **STABLE KERNEL** — vocabulário e contratos que todo o resto importa; zero
  I/O ou serialização canônica, muda raramente e qualquer mudança é
  cross-cutting por definição.
- **EXECUTION CONTRACT** — a mecânica que produz e verifica evidência de um
  trial: isolamento, captura, adapters, avaliação e score. É o que a Seção 3
  a 5 deste documento descreve.
- **EXPERIMENT PLANE** — as receitas declaráveis que variam entre trials
  (`strategies/`); o que muda quando se testa uma estratégia nova, não o lab.
- **CONTROL PLANE** — orquestração e config que amarram as outras camadas em
  comandos (`cli`, resolução de `project`).
- **EXTENSIONS** — funcionalidade fora do caminho crítico de execução/
  avaliação, hoje placeholder ou em construção.

Dependências apontam para baixo: `cli` → tudo; `core` não importa ninguém.

### 6.1 Divergências entre este documento e o código

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
- [HARNESS.md](HARNESS.md) — harness de sessões descartáveis (`dev/`)
- [BILLING.md](BILLING.md) — política de cobrança dos workers
- [adr/ADR-0001-stack.md](adr/ADR-0001-stack.md) — stack e driver de SQLite
