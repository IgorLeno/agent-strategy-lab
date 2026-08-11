# LAB_CHARTER

Este documento é a carta de missão do `agentlab`: por que ele existe, quem
decide o quê, e onde a fronteira do produto termina. Decisões estruturais
sobre o kernel de evidência estão em
[ADR-0002](adr/ADR-0002-evidence-kernel.md); este documento é o texto legível
que as motiva e complementa.

---

## 1. Missão

O `agentlab` é uma plataforma de engenharia de software orientada por
evidência para **selecionar, coordenar e melhorar agentes de desenvolvimento**.

"Orientada por evidência" não é adjetivo: toda alegação sobre desempenho de um
agente, uma estratégia ou um modelo precisa rastrear até um run auditável,
com envelope reproduzível e proveniência por campo. O lab não existe para
produzir opinião sobre qual agente é melhor — existe para produzir a evidência
que sustenta ou refuta essa opinião.

---

## 2. Autoridades

Duas autoridades distintas, que nunca se sobrepõem:

- **Humano — autoridade de produto e design.** Decide o que o lab mede
  (quais task classes, quais critérios de sucesso), quais estratégias e
  agentes entram em comparação, e o que fazer com o resultado. Julgamento de
  valor ("essa estratégia é melhor") é sempre humano.
- **Lab — autoridade de processo e evidência.** Decide como uma medição é
  coletada, isolada, redigida, hashada e classificada nas três dimensões
  (execução, avaliação, qualificação). O lab não julga se um resultado é bom;
  julga se a medição desse resultado é confiável o bastante para entrar numa
  comparação.

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

## 5. `dev/` não é arquitetura do produto

`dev/` é o harness de bootstrap que constrói o `agentlab` — sessões
descartáveis, `plan.yaml`, packets, perfis de launcher (ver
[HARNESS.md](HARNESS.md)). Ele não é o produto, não faz parte do kernel de
evidência, e nenhuma decisão de arquitetura do produto depende do estado do
harness. Quando o `agentlab` estiver completo, `dev/` pode ser descartado sem
que isso afete o produto.

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
- **Memory system** — o lab não mantém estado conversacional entre runs além
  do que já está em `data/runs/`.
- **Workflow DSL** — estratégias são receitas declarativas versionadas em
  YAML, não uma linguagem de orquestração de propósito geral.
- **Supervisor complexo** de múltiplos agentes coordenados em tempo real.
- **Auto-remoção de config de máquina** — o lab não modifica configuração do
  ambiente do operador para além do que precisa para rodar um trial.
- **Adaptive router** que escolhe agente/modelo automaticamente com base em
  histórico — isso é uma decisão de produto que cabe ao humano, informada
  pela evidência do lab, não uma feature do lab.
- **Microservices** — o lab é um processo CLI local; distribuir componentes
  em serviços separados não resolve nenhum problema real do escopo atual.

Um non-goal listado aqui não é permanente por acidente: é permanente até uma
ADR nova argumentar o contrário com a mesma explicitação de trade-off que
[ADR-0002](adr/ADR-0002-evidence-kernel.md) exige para o kernel.

---

## 7. Documentos relacionados

- [ADR-0002](adr/ADR-0002-evidence-kernel.md) — kernel estável, critérios de
  inclusão, execution contract, ciclo de incubação
- [ARCHITECTURE.md](ARCHITECTURE.md) — modelo de dados e layout de evidência
- [HARNESS.md](HARNESS.md) — harness de sessões descartáveis (`dev/`)
- [BACKLOG.md](BACKLOG.md) — espelho humano de `dev/plan.yaml`
- [LESSONS.md](LESSONS.md) — correções que viraram regra
