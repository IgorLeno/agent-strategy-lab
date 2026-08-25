# LAB_CHARTER

Este documento é a carta de missão do `agentlab`: por que ele existe, quem
decide o quê, e onde a fronteira do produto termina. Decisões estruturais
sobre o kernel de evidência estão em
[ADR-0002](adr/ADR-0002-evidence-kernel.md); a evolução de identidade e o
vocabulário oficial (Evidence Kernel / Orchestration Control Plane /
Experimental Plane) estão em
[ADR-0003](adr/ADR-0003-control-plane-identity.md). Este documento é o texto
legível que os motiva e complementa.

---

## 1. Missão

O Agent Strategy Lab é um **control plane autônomo, fundado em evidência,
para condução de projetos por agentes de IA**: planeja, roteia, executa,
valida, recupera e aprende ao longo de projetos de software de longa duração,
usando agentes de desenvolvimento (Claude Code, Codex e futuros) como workers
descartáveis e subordinados.

"Fundado em evidência" não é adjetivo: toda alegação sobre desempenho — e
toda decisão de routing que o sistema toma sozinho — precisa rastrear até um
run auditável, com envelope reproduzível e proveniência por campo. O que não
foi medido permanece `UNKNOWN`; o sistema prefere recusar uma decisão a
inventá-la.

O medidor empírico de agentes que deu origem ao projeto continua existindo,
como **Experimental / Learning Plane**: experimentos controlados que produzem
a evidência usada para melhorar routing, seleção de modelo/effort, estratégias
e decisões de custo/qualidade. O plano experimental ensina o control plane;
o control plane é o produto. A mudança de ênfase em relação à missão original
("produzir a evidência que sustenta ou refuta a opinião sobre agentes") está
registrada, com trade-offs, em [ADR-0003](adr/ADR-0003-control-plane-identity.md).

---

## 2. Autoridades

Duas autoridades distintas, que nunca se sobrepõem:

- **Humano — autoridade de produto, risco e design.** Decide o que o lab mede
  e conduz (quais projetos, quais critérios de sucesso), qual policy de
  profiles/billing/escalation está autorizada, e tudo que é human-gated por
  contrato (`src/intake/index.ts`): billing não autorizado, ação destrutiva,
  side-effect externo, expansão de escopo, decisão de arquitetura/produto
  ambígua, risco crítico. Julgamento de valor é sempre humano.
- **Lab — autoridade de processo e evidência.** Decide como uma medição é
  coletada, isolada, redigida, hashada e classificada nas três dimensões
  (execução, avaliação, qualificação) — e, desde
  [ADR-0003](adr/ADR-0003-control-plane-identity.md), também **aplica**
  mecanicamente a evidência a escolhas de routing **dentro da policy humana**:
  só quando uma série comparável domina por Pareto, com fallback
  determinístico e provenance em toda decisão. O lab não julga se um resultado
  é bom nem amplia a própria policy; julga se a medição é confiável e roteia
  dentro do que foi autorizado.

Nenhum agente de desenvolvimento — Claude, Codex, Hermes, ou qualquer adapter
futuro — tem autoridade de processo. Eles são sujeitos da medição, substituíveis
pelo execution contract (ver [ADR-0002](adr/ADR-0002-evidence-kernel.md)),
nunca parte de quem decide como a medição acontece.

---

## 3. Dois modos: EXPERIMENTAL vs. OPERATIONAL

Todo run acontece em um dos dois modos, declarado **antes** de começar:

### EXPERIMENTAL

Run desenhado para entrar em comparação controlada. Exige:

- `TaskSpec` e `EvaluationPlan` fixados antes da execução;
- `EnvironmentProfile` explícito (`controlled` ou `real-world`), sem campo
  implícito;
- os dois envelopes calculados e persistidos;
- classificação de qualificação (`QUALIFIED`/`UNSCORABLE`/...) antes de
  contar em qualquer agregação.

### OPERATIONAL

Run do dia a dia — usar o lab, ou os agentes que ele coordena, para trabalho
real. Gera evidência real e é registrado com o mesmo rigor de storage e
redaction, mas **não** foi desenhado como comparação controlada: falta a
fixação prévia de `EvaluationPlan`, ou o ambiente não segue o perfil
`controlled`, ou o objetivo nunca foi comparar.

### A regra que não se negocia

**Dado operacional nunca vira benchmark controlado silenciosamente.** Um run
`OPERATIONAL` não pode ser reclassificado como `EXPERIMENTAL` depois do fato
para preencher uma comparação. Se um resultado operacional parece
interessante o bastante para virar dado comparável, a resposta é repetir o
trabalho como um run `EXPERIMENTAL` novo — nunca reetiquetar o antigo. A
motivação é a mesma do baseline histórico em
[ADR-0002](adr/ADR-0002-evidence-kernel.md): evidência não é reescrita, e
reclassificação retroativa é uma forma de reescrita.

---

## 4. Incubation lifecycle

Toda extensão ao lab — grader novo, adapter novo, estratégia nova, perfil de
score novo — nasce fora de produção e avança por evidência, não por decreto:

```
DISCOVERED -> CANDIDATE -> SANDBOXED -> BENCHMARKED -> PROMOTED
```

| Estágio | Significado |
| --- | --- |
| `DISCOVERED` | identificada como possível; sem implementação ainda |
| `CANDIDATE` | implementada; ainda não rodou contra o control plane real |
| `SANDBOXED` | roda isolada; não conta como benchmark nem entra em comparação |
| `BENCHMARKED` | rodou sob o control plane completo, gerou evidência qualificada |
| `PROMOTED` | adotada como padrão para o caso de uso que cobre |

Nenhum estágio é pulado. Detalhe completo do critério de cada estágio e da
relação com o kernel está em [ADR-0002](adr/ADR-0002-evidence-kernel.md).

---

## 5. `dev/`: harness de bootstrap + runtime do control plane

`dev/` nasceu como harness de bootstrap que constrói o `agentlab` — sessões
descartáveis, `plan.yaml`, packets, perfis de launcher (ver
[HARNESS.md](HARNESS.md)) — e essa parte continua não sendo produto nem kernel
de evidência.

Estado honesto pós-M86: o **runtime do Orchestration Control Plane** também
vive em `dev/lib/` (`project-run.ts`, `project-orchestrate.ts`,
`project-history.ts` e vizinhos), consumindo os contratos puros de `src/`.
Essa parte **é** arquitetura do produto em execução, ainda que hospedada no
diretório do harness — a afirmação original "`dev/` pode ser descartado sem
afetar o produto" vale para o harness de bootstrap, não para esses módulos.
A dívida de consolidação está registrada em
[ADR-0003](adr/ADR-0003-control-plane-identity.md) e no plano do Marco 4.

---

## 6. Non-goals

O lab explicitamente **não** é, e não deve crescer para ser:

- **Dashboard** — visualização é derivada da evidência, não parte dela; fica
  fora do kernel e fora do escopo deste projeto.
- **Sistema multi-usuário** — o lab tem um operador por instância.
- **Autenticação** — não há superfície de rede que a exija.
- **Scheduler distribuído** — orquestração de runs é local e sequencial por
  desenho; escala horizontal não é meta.
- **Marketplace** de estratégias ou agentes.
- **Memory system conversacional** — o lab mantém estado durável de execução
  com provenance em `data/runs/` (episódios, facts comparáveis, história de
  routing), mas não mantém memória conversacional entre runs nem injeta
  memória automaticamente em workers. Reescopado por
  [ADR-0003](adr/ADR-0003-control-plane-identity.md); qualquer memória de
  projeto futura é pull-based, auditável e com provenance obrigatória.
- **Workflow DSL** — estratégias são receitas declarativas versionadas em
  YAML, não uma linguagem de orquestração de propósito geral.
- **Supervisor em tempo real** de múltiplos agentes conversando entre si
  (swarm). O lab coordena workers **um por vez**, com papéis estruturais
  (planner/implementer/reviewer) e contexto fresco por invocação — reescopado
  por [ADR-0003](adr/ADR-0003-control-plane-identity.md); coordenação
  conversacional em tempo real continua fora.
- **Auto-remoção de config de máquina** — o lab não modifica configuração do
  ambiente do operador para além do que precisa para rodar um trial.
- **Microservices** — o lab é um processo CLI local; distribuir componentes
  em serviços separados não resolve nenhum problema real do escopo atual.

**Ex-non-goal, revertido por ADR:** *adaptive router que escolhe
agente/modelo com base em histórico* deixou de ser non-goal em
[ADR-0003](adr/ADR-0003-control-plane-identity.md), que registra as condições
da reversão (Pareto-only sem pesos, ausência nunca prova inferioridade,
fallback determinístico, decisão auditável dentro de policy humana). O
routing histórico está implementado em `src/routing/history-router.ts`.

Um non-goal listado aqui não é permanente por acidente: é permanente até uma
ADR nova argumentar o contrário com a mesma explicitação de trade-off que
[ADR-0002](adr/ADR-0002-evidence-kernel.md) exige para o kernel — foi
exatamente esse o caminho que [ADR-0003](adr/ADR-0003-control-plane-identity.md)
seguiu para o adaptive router.

---

## 7. Documentos relacionados

- [ADR-0002](adr/ADR-0002-evidence-kernel.md) — kernel estável, critérios de
  inclusão, execution contract, ciclo de incubação
- [ADR-0003](adr/ADR-0003-control-plane-identity.md) — identidade de control
  plane, vocabulário oficial, reversão do non-goal de adaptive routing
- [ARCHITECTURE.md](ARCHITECTURE.md) — modelo de dados, layout de evidência e
  Orchestration Control Plane
- [HARNESS.md](HARNESS.md) — runtime de execução e sessões descartáveis (`dev/`)
- [BACKLOG.md](BACKLOG.md) — espelho humano de `dev/plan.yaml`
- [FUTURE_DIRECTIONS.md](FUTURE_DIRECTIONS.md) — temas evidence-triggered; não é plano
- [LESSONS.md](LESSONS.md) — correções que viraram regra
