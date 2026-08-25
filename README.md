# Agent Strategy Lab

> **North star do produto.** Este README define o que o Lab deve se tornar.
> Detalhes de implementação podem mudar. Toda feature futura precisa responder:
> *isso ajuda o Agent Lab a permitir desenvolvimento mais autônomo, eficiente e
> adaptativo?* Se a resposta for não, provavelmente não pertence ao core.

## O que é

Agent Strategy Lab é um **orquestrador adaptativo de desenvolvimento
autônomo**. Ele transforma objetivos e decisões humanas em execução por
agentes de código, observa como esses agentes trabalham, mede qualidade,
velocidade e custo, e acumula evidência para melhorar futuras escolhas de
modelos, ferramentas, estratégias e métodos.

O Lab é **orquestrador + observador + sistema de aprendizado experimental**.
Não é um micromanager da implementação.

Hoje o sistema já opera como um *Orchestration Control Plane* fundado em
evidência: planeja, roteia, executa, valida, recupera e registra história
auditável. A visão abaixo é o norte para a evolução **depois** do primeiro
projeto real — não um pedido para reescrever a arquitetura agora.

## Product North Star

O fluxo desejado é:

```text
HUMAN INSTRUCTION
      ↓
INTAKE
      ↓
PLAN
      ↓
ROUTE
      ↓
EXECUTE
      ↓
VALIDATE
      ↓
REPAIR / ESCALATE  (quando necessário)
      ↓
COMPLETE PROJECT
```

Intervenção humana deve ser **exceção**. `HUMAN_REQUIRED` representa uma
decisão genuinamente humana — produto, risco, autorização, efeito externo,
mudança real de escopo — e não falta de `package.json`, dificuldade comum de
engenharia, escolha de arquivo, ausência de teste, detalhe de ferramenta ou
capability que routing/escalation já podem resolver.

O objetivo econômico do routing futuro, com evidência suficiente, é:

> **Use the cheapest / fastest configuration that has sufficient evidence of
> quality for that context.**

## Papéis

### Humano

Decide principalmente:

- o que o produto deve fazer;
- comportamento desejado, requisitos e prioridades;
- design quando envolve preferência humana;
- trade-offs de produto;
- riscos, custo e autorização de serviços;
- deployment e efeitos externos;
- mudanças reais de escopo.

O humano **não** deve precisar decidir, no curso normal:

- quais arquivos editar;
- como estruturar módulos;
- se usar TDD;
- quais testes criar;
- a sequência de implementação;
- pequenos refactors;
- detalhes ordinários de engenharia.

### Agent Strategy Lab

Facilita execução autônoma:

- compreender o objetivo;
- planejar e decompor em work units;
- montar o DAG;
- selecionar recursos e modelos;
- oferecer capacidades úteis;
- lançar workers;
- validar, reparar e escalar;
- registrar evidência, medir, comparar e aprender.

Controla **fronteiras**, não a implementação: objetivo, autorização,
segurança, recursos, routing, validação, retry, repair, escalation e a
escalada de decisões que são realmente humanas.

### Coding agents

Recebem objetivo, contexto necessário, boundaries, acceptance e recursos
disponíveis. **Decidem como resolver.**

Dentro das fronteiras autorizadas, o coding agent controla investigação,
arquivos a ler, estratégia de implementação, estrutura interna, refatorações,
ferramentas, testes locais, metodologia e ordem de trabalho da work unit.

## Princípio central

> **Control the boundaries, not the implementation.**

O Lab não microgerencia a implementação. Ele autoriza o envelope da work unit
e observa o que aconteceu. O coding agent tem ampla liberdade dentro desse
envelope.

## Loop de desenvolvimento autônomo

O sistema deve tentar resolver sozinho tudo que seja decisão técnica
ordinária. Progressivamente, o Lab precisa:

- detectar failure;
- diferenciar falha de implementação de falha de infraestrutura;
- tentar *bounded repair*;
- aprender com o repair;
- escalar capability quando necessário;
- evitar repetir abordagens que já produziram a mesma falha.

Routing, no estado atual, já combina exigência da tarefa, capabilities do
perfil e histórico canônico quando uma série comparável domina por Pareto.
A direção futura — **não implementada neste ciclo** — é o routing deixar de
considerar apenas dificuldade declarada e, com evidência suficiente, olhar
também:

- histórico daquela classe de task;
- modelo, provider e effort;
- stack e disponibilidade de tools;
- skills e métodos;
- first-pass history;
- custo, velocidade e qualidade.

## Aprendizado a partir da execução

O Lab não deve registrar só PASS / FAIL. Execuções reais são a principal
fonte de aprendizado. A direção futura é cada work unit gerar um
*execution episode* (ou representação equivalente) com:

| Dimensão | O que observar |
|---|---|
| **Context** | task class, dificuldade, complexidade, ambiguidade, verification type, stack, risco |
| **Resources** | provider, modelo, effort, tools, skills, hooks, MCPs, subagents e outras capacidades usadas |
| **Method / strategy** | TDD, test-after, prototype-first, refactor-first, browser-driven e outras abordagens observáveis |
| **Outcome** | first-pass success, validation, repair, escalation, review, regressões posteriores |
| **Efficiency** | wall clock, worker runtime, tokens, launches, custo/equivalência de API quando disponível |
| **Quality** | força da validação, resultado de review, regressões, avaliação do produto, qualidade observável |

Isso é direção de produto, não schema congelado. O nome e o formato podem
mudar; a intenção não: aprender com o que realmente aconteceu em projetos
reais.

### Aprendizado é contextual

O Lab **não** deve concluir "TDD é sempre melhor". Deve aprender coisas como:

- TDD apresenta boa evidência para tasks de domínio determinístico;
- determinada skill apresenta bom desempenho em tarefas visuais;
- modelo X é suficiente e econômico para scaffolds;
- modelo Y tem melhor first-pass em debugging cross-cutting.

Conclusões são condicionadas pelo **contexto da tarefa**.

### Correlação não é causalidade

Uma execução bem-sucedida usando Skill X + Model Y + TDD **não prova** que
Skill X causou o sucesso. O Lab deve inicialmente registrar
associação/evidência observada. Com múltiplos episódios comparáveis, poderá
formular hipótese, comparar, testar, benchmarkar e aumentar ou reduzir
confiança. Não fabricar causalidade a partir de um único episódio.

### Métricas não devem virar burocracia

Observabilidade existe para **melhorar** a execução. Workers não devem
preencher questionários longos, produzir justificativas excessivas ou seguir
protocolos que prejudiquem o trabalho. Sempre que possível, o orquestrador
deriva fatos automaticamente: arquivos via Git, duração via processo, modelo
via profile, tokens via telemetria do provider, testes via validação, uso de
ferramentas via execution trace quando disponível. O coding agent não é
microgerenciado para gerar métricas.

## Extensões

Skills, hooks, MCPs, tools, subagents e strategies são **capacidades
disponíveis**, não novas obrigações.

Uma task pode receber ou descobrir essas capacidades. O Lab poderá aprender
que certas capacidades têm bom histórico em certos contextos. A filosofia é:

> **Recommend / provide — not mandate / block.**

Exemplo: uma task frontend com a skill `frontend-design` disponível deve
disponibilizar ou recomendar essa skill. Não deve torná-la obrigatória, nem
escalar para `HUMAN_REQUIRED` se ela estiver ausente.

O repositório já possui uma fundação de extensão
(`strategy`, `skill`, `hook`, `mcp`, `review_protocol`,
`provider_integration`) e um ciclo de incubação:

```text
community capability
      ↓
DISCOVERED
      ↓
inspection
      ↓
CANDIDATE
      ↓
real experiment / benchmark
      ↓
BENCHMARKED
      ↓
evidence favorable?
   ↙             ↘
PROMOTED        discard / defer
```

Estágios intermediários equivalentes a `SANDBOXED` continuam válidos como
isolamento antes de benchmark. **PROMOTED** significa *available /
recommended based on evidence* — não *mandatory*. Esta integração adaptativa
**não está autorizada como trabalho**: é visão, e só vira mudança se a
operação em projeto real produzir a evidência que a justifique.

## Melhoria evidence-driven

O ciclo de aprendizado desejado:

```text
OBSERVE
   ↓
ACCUMULATE EVIDENCE
   ↓
FORM HYPOTHESIS
   ↓
COMPARE / EXPERIMENT
   ↓
PROMOTE USEFUL STRATEGY
   ↓
CONTINUE OBSERVING
```

Ou, no ritmo do produto:

```text
REAL PROJECT → EXECUTION → OBSERVATION → EVIDENCE → IMPROVEMENT → REAL PROJECT
```

O plano experimental (`corpus/`, `strategies/`, experimentos controlados)
continua sendo o instrumento que produz evidência comparável. Benchmarks não
são o produto. Dado operacional nunca vira benchmark controlado
silenciosamente — se um resultado operacional merecer comparação, o trabalho
é repetido como experimento novo.

## O que o Agent Lab não deve se tornar

Agent Lab **não** deve se tornar:

- um sistema que prescreve cada passo do coding agent;
- um conjunto crescente de gates obrigatórios;
- um framework que exige determinada metodologia;
- um sistema que transforma toda incerteza em `HUMAN_REQUIRED`;
- um sistema que adiciona mais overhead do que valor;
- uma arquitetura de pesquisa desconectada de projetos reais;
- um gerador de burocracia de prompts;
- um *mandatory-method engine*;
- um gatekeeper universal.

### Princípio de eficiência

> **The Lab should reduce the cost of autonomy, not add more cost than the
> work it orchestrates.**

Uma nova policy, gate ou record deve justificar seu custo por maior
confiabilidade, menos repetição, melhor routing, melhor aprendizado ou
segurança necessária. Sem evidência de benefício: **defer**.

## Fase atual

O **primeiro teste real end-to-end em projeto externo está concluído**. O
Agent Lab está em uso em projetos reais e acumula evidência operacional a
cada execução.

Mudanças arquiteturais são **evidence-triggered**: nascem de observação em
projeto real, não de antecipação. **Não existe sequência de milestones
pré-autorizada depois da v0.1** — nem no plano, nem neste README.

O ritmo de desenvolvimento do Lab:

```text
REAL PROJECT → OBSERVATION → CONCRETE NEED/DEFECT
     → SMALLEST COHERENT CHANGE → REGRESSION → REAL PROJECT
```

A visão adaptativa descrita acima permanece visão. Ela não autoriza trabalho:
cada peça só é construída quando um projeto real mostrar a necessidade
concreta, e no menor recorte que a resolva.

Temas ainda plausíveis — sem ordem, sem dependências, sem autorização — estão
em [`docs/FUTURE_DIRECTIONS.md`](docs/FUTURE_DIRECTIONS.md).

## Princípio de desenvolvimento

```text
REAL PROJECT
  → EXECUTION
  → OBSERVATION
  → REAL PROBLEM?
  → MINIMUM LAB IMPROVEMENT
  → REGRESSION
  → BACK TO PROJECT
```

Não desenvolver infraestrutura futura só porque ela parece
arquiteturalmente elegante. Melhoria do Lab é *evidence-triggered*.

---

## Quick Start

```text
pnpm lab run
```

Cole a Run Directive completa e pressione Ctrl+D. Um único artefato carrega
alvo, modo, autorização estruturada e a instrução humana. O Lab persiste o
documento original, deriva o intake e começa.

```text
---agentlab
version: 1
target:
  type: repository
  path: /path/to/project
execution:
  mode: new
authorization:
  preset: local-autonomous-development
  allow:
    local_repository_write: true
    subscription_workers: true
    deterministic_validation: true
    bounded_repair: true
    capability_escalation: true
  deny:
    deployment: true
    destructive_actions: true
    api_billing: true
---
# Objective
Implement the requested change in the target repository.
```

Intent ≠ authorization: o corpo não concede permissão. Só o header
estruturado (sobre o preset) autoriza. Self-maintenance usa
`target.type: self`. Publicar origin/main exige um grant estreito no header.

Proibição ≠ pedido: escrever `no force push` ou `não fazer deploy em produção`
no corpo é uma salvaguarda, não um pedido da ação — o preflight de intenção é
determinístico, sem inferência paga, e classifica por cláusula (PT e EN).
Pedido afirmativo de categoria human-gated continua parando antes do provider,
e a resposta `HUMAN_REQUIRED` só oferece o que a política realmente concede:
categoria never-grantable nunca sugere "conceda no header".

A instrução humana COMPLETA é a autoridade e chega íntegra ao planner — sem
limite de 4000 caracteres e sem truncation silenciosa. O `PlannerPacket`
continua bounded (fatos derivados + contrato de saída) e carrega só o
`instruction_sha256` que amarra as duas partes. O guard de tamanho de input é
de produto e explícito: 256 KiB por Run Directive, recusado antes de qualquer
persistência ou provider.

Enquanto roda, `pnpm lab run` imprime o progresso do lifecycle em stderr, uma
linha por transição:

```text
[00:00] PREFLIGHT
[00:00] TARGET_READY /path/to/project
[00:01] AUTHORIZED local-autonomous-development
[00:01] PLANNING
[00:01] PLANNER_RUNNING codex-build-worker-subscription-terra-medium-v2
[00:19] PLAN_READY origin=GENERATED tasks=2
[00:19] WORKER_RUNNING task=T1 profile=...
[04:42] VALIDATING task=T1
[05:03] TASK_ACCEPTED task=T1
[18:30] ALL_DONE
```

Falha nomeia o stage, o planner profile e o runtime de evidência; stdout
continua reservado ao payload JSON.

### Advanced / Compatibility Interface

Flags continuam válidas, mas não são o fluxo principal:

```text
pnpm lab --repo /path/to/project
pnpm lab --self
pnpm lab --resume /path/to/runtime
pnpm lab resume /path/to/runtime
pnpm lab run --prompt-file directive.md
```

`--authorization`, `--policy`, `--publish`, `--planner-profile` e
`--runtime-dir` são overrides avançados. `--self` ainda isola o worktree;
`--publish` na CLI conflita com um deny da directive (fail closed).

Os CLIs `dev-*` continuam como primitives internas.

---

## Como funciona hoje

O control plane atual recebe uma intenção de projeto e a transforma em
execução organizada. Agentes de código não possuem o plano, o routing, a
policy de billing, o commit oficial nem a decisão de PASS — essas
responsabilidades pertencem ao Lab. Eles possuem, e devem continuar
possuindo, a liberdade de implementação **dentro** das fronteiras
autorizadas.

```text
RUN DIRECTIVE (header estruturado + corpo) + preset
        │
   INTAKE ─ compile estrutural; o raw da directive permanece a autoridade humana
        │
   INSPECTION ─ leitura do repositório alvo (stack, validações, âncoras)
        │
   PLANNING ─ work units tipadas com DAG de dependências
        │
   ROUTING ─ capability → router determinístico → histórico (Pareto)
        │
   EXECUTION ─ worker descartável, supervisão de processo, sem task deadline
        │
   VALIDATION ─ validação oficial reexecutada + review gate
        │
   ├── PASS aceito ──→ próxima work unit runnable
   └── FAIL ──→ DIAGNOSIS → RECOVERY (repair bounded → escalation → humano)
        │
   CANONICAL EVIDENCE ─ runs selados alimentam o routing futuro
```

- **Intake e autorização.** A Run Directive crua é persistida antes de
  qualquer provider. O Lab deriva `ProjectIntakeRequest` do corpo; o preset
  `local-autonomous-development` mais o header estruturado materializam o
  snapshot imutável. Texto livre não autoriza. `--authorization` / `--policy`
  são overrides avançados. Ver
  [`docs/agentlab-run.example.yaml`](docs/agentlab-run.example.yaml).
- **Inspection, planejamento e routing.** Fatos do repositório alvo alimentam
  work units (`PlannedTask`) com acceptance, validações, dependências e
  envelope de recursos. Routing em três camadas: capabilities com provenance,
  router determinístico, histórico canônico Pareto-only.
- **Execução subordinada.** Workers são processos frescos de CLI headless, com
  ambiente sanitizado, supervisão de process group e um
  `MACHINE_SAFETY_CEILING` de infraestrutura — nunca um deadline derivado da
  duração prevista da task. Continuidade de sessão é proibida: cada attempt tem
  identidade própria.
- **Validação, recovery e evidência.** A validação oficial é reexecutada pelo
  orquestrador. Repair automático é bounded. Falha de capability pode
  escalar dentro da ladder autorizada; esgotou a policy → `HUMAN_REQUIRED`.
  Runs selados em `data/runs/<id>/` alimentam routing futuro. O que não foi
  medido permanece `UNKNOWN`.

**Implementado e testado** (incluindo E2E do fluxo de projeto externo com
providers fake): ciclo autônomo via `pnpm lab run`; evidence
kernel; billing/credencial com fatos tri-state; catálogo de perfis
versionados. `pnpm dev-run-project` permanece como primitive interna.

**Limitações atuais** (descritas como fatos do sistema, não como trabalho
planejado — nenhuma delas tem work unit autorizada; os temas correspondentes
vivem em [`docs/FUTURE_DIRECTIONS.md`](docs/FUTURE_DIRECTIONS.md)):

- `HUMAN_REQUIRED` é terminal: ainda não há registro persistido de decisão
  humana com retomada automática do nó bloqueado.
- Tarefas não nascem dinamicamente durante a execução; o grafo é estático por
  plano.
- Não há interface unificada de eventos SEMÂNTICOS de execução. O transporte
  JSONL de `codex exec --json` (`thread.started`, `turn.started`,
  `item.completed`, `turn.completed`, `turn.failed`, `error`) JÁ é parseado por
  [`dev/lib/codex-transport.ts`](dev/lib/codex-transport.ts), e o
  `stream-json` do Claude por [`dev/lib/claude-stream.ts`](dev/lib/claude-stream.ts)
  — ambos POST-HOC, sobre o stdout já encerrado. A observação AO VIVO existe
  hoje em v1 provider-neutra
  ([`dev/lib/activity-observer.ts`](dev/lib/activity-observer.ts)): timestamp de
  chunk em stdout/stderr, intervalos de silêncio e suspeita de stall. Ela mede
  ATIVIDADE, não progresso semântico, e não tem autoridade de encerrar nada.
- Execução estritamente serial (`concurrency = 1`).

Documentos de referência: [`docs/LAB_CHARTER.md`](docs/LAB_CHARTER.md)
(missão e fronteiras atuais), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/HARNESS.md`](docs/HARNESS.md), [`docs/LESSONS.md`](docs/LESSONS.md),
[`docs/adr/ADR-0003-control-plane-identity.md`](docs/adr/ADR-0003-control-plane-identity.md),
[`docs/FUTURE_DIRECTIONS.md`](docs/FUTURE_DIRECTIONS.md) (temas
evidence-triggered — não é plano).

## Estrutura do repositório

| Caminho | Papel |
|---|---|
| `src/` | Contratos puros e lógica de decisão do produto (schemas, planner, routing, performance, storage, intake, inspection). Não importa `dev/`. |
| `dev/` | Runtime do control plane e harness de execução (launch, orquestração, recovery, perfis, CLIs `dev-*`). Importa `src/`. |
| `dev/plan.yaml` | Definição versionada e autoritativa das work units do próprio Lab. |
| `docs/` | Charter, arquitetura, harness, ADRs, lessons, reviews e planos. |
| `corpus/`, `strategies/` | Plano experimental: tarefas de benchmark e estratégias declarativas. |
| `data/` | Evidência canônica (gitignored; disco é a fonte de verdade). |

## Princípios inegociáveis

SPEC FIRST · evidência sobre self-report · `UNKNOWN ≠ 0` · fail-closed quando a
evidência é inválida · fonte de verdade canônica única · contratos
provider-neutrais · autorização explícita de escopo · retries bounded ·
recovery observável · história auditável · control the boundaries, not the
implementation · correlação ≠ causalidade · evidence-triggered development.
