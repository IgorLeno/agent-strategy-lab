# ADR-0002 — AgentLab as Evidence Kernel and Development Control Plane

- **Status:** aceito
- **Data:** 2026-08-11
- **Contexto da decisão:** pré-M2 (fechamento do Marco 1, planejamento de
  M41–M52)
- **Substitui:** —

---

## Contexto

O Marco 1 (M01–M40B, fechado no commit `4b33817f141359ed8b802f4b119775ece43c9289`)
entregou o núcleo de evidência: `Task`/`Trial`/`Run`, os dois envelopes, o
layout de `data/runs/`, o índice SQLite descartável e as três dimensões
independentes (execução, avaliação, qualificação). Esse commit é o **baseline
histórico do M1** — a evidência que ele registra nunca é reescrita; qualquer
mudança futura ao formato ou à semântica é aditiva ou versionada, não
retroativa.

A partir daqui o escopo cresce: múltiplas estratégias, múltiplos projetos,
comparação entre agentes, e extensões que hoje não existem (novos graders,
novos adapters, novos formatos de score). Sem um critério explícito de "o que
entra no kernel e o que fica fora", cada extensão futura tem incentivo para
inchar o núcleo — é o caminho mais curto no curto prazo e o mais caro depois,
porque tudo que entra no kernel herda a garantia de nunca quebrar
retrocompatibilidade de evidência.

Esta ADR formaliza esse critério antes que M41+ comece a adicionar extensões,
para que a decisão "isso é kernel ou é extensão" tenha um teste objetivo em vez
de ser julgada caso a caso.

---

## Decisão

### Baseline histórico

O commit `4b33817f141359ed8b802f4b119775ece43c9289` (M40B, fechamento do
Marco 1) é o baseline histórico do `agentlab`. Evidência gerada a partir dele
— e toda evidência gerada depois — nunca é reescrita. Mudança de schema é
versionada (`schema_version`, `score_profile_id` + versão, etc.); nunca é
edição in-place de record já persistido.

### STABLE KERNEL

O kernel estável é: `Task`/`Trial`/`Run`, `Evidence`/`Metrics`, `Evaluation`,
`Score`, `Qualification`, `Profiles` (`AgentProfile`, `EnvironmentProfile`,
score profiles) e `Envelopes` (execution e evaluation).

Um conceito só entra no kernel se satisfizer **todos os quatro** critérios de
inclusão:

1. **Provider-independent** — não depende de nenhuma CLI de agente, formato de
   stream ou convenção específica de um provider. `ExecutionRecord` é kernel;
   um parser do formato de evento do Claude Code não é.
2. **Necessário para evidence/reprodutibilidade** — sem ele, um run não pode
   ser auditado ou reproduzido. Os dois envelopes são kernel porque removê-los
   quebra a prova de reprodutibilidade; um relatório de terminal formatado não
   é, porque é derivado da evidência, não parte dela.
3. **Útil a múltiplas estratégias/projetos** — não serve só a um caso de uso
   particular. `EvaluationPlan` é kernel porque toda estratégia precisa de
   avaliação oculta; uma rubrica específica de uma task class não é.
4. **Remoção quebraria a semântica Task/Trial/Run/Evidence** — é um teste de
   necessidade, não de conveniência: se o conceito sumisse, o modelo de dados
   central deixaria de fazer sentido ou de ser auditável.

Falhar em qualquer um dos quatro critérios significa: é extensão, não kernel.

### Experiment plane vs. control plane

Duas camadas com autoridade distinta:

- **Control plane** — o que garante que a evidência é confiável: storage,
  isolamento de workspace, redaction, manifests, integridade, hashing
  canônico. Muda raramente e sob revisão mais pesada, porque um erro aqui
  compromete toda a evidência já coletada retroativamente.
- **Experiment plane** — o que varia entre execuções: qual estratégia, qual
  agente, qual modelo, qual task. Muda com frequência, é onde a maior parte do
  trabalho de pesquisa acontece, e erros aqui invalidam um run, não o histórico
  inteiro.

O control plane nunca depende do experiment plane. Uma estratégia nova, um
adapter novo ou um grader novo nunca exigem tocar em `storage/`, `envelope/`
ou nas definições dos records do kernel.

### Execution contract: agentes substituíveis

Todo agente de desenvolvimento — Claude, Codex, Hermes, e qualquer futuro
adapter — é **substituível pelo execution contract**, nunca autoridade de
processo. O contrato (spawn por argv, captura de stream, timeout, process
group, exit code) é o mesmo para todos; nenhum agente tem caminho especial
que bypassa storage, redaction ou os envelopes. Isso é o que torna a
comparação entre agentes uma comparação válida em vez de uma comparação entre
processos medidos de formas diferentes.

### Extensions: ciclo de incubação

Tudo que não é kernel é extensão, e toda extensão nasce fora de produção,
avança por evidência, nunca por decreto:

```
DISCOVERED -> CANDIDATE -> SANDBOXED -> BENCHMARKED -> PROMOTED
```

- **DISCOVERED** — identificada como possível (novo grader, novo adapter, nova
  estratégia); ainda não tem implementação.
- **CANDIDATE** — implementação existe, ainda não rodou contra o kernel real.
- **SANDBOXED** — roda isolada, sem afetar comparação controlada nem contar
  como benchmark.
- **BENCHMARKED** — rodou sob o control plane completo, gerou evidência
  qualificada, comparável a outras extensões do mesmo tipo.
- **PROMOTED** — adotada como padrão para o caso de uso que ela cobre; ainda
  assim permanece extensão, nunca migra para o kernel, a menos que passe pelos
  quatro critérios acima e vire ADR própria.

Uma extensão não pula estágio. Pular de `CANDIDATE` direto para dado
comparável é exatamente o erro que o modo EXPERIMENTAL/OPERATIONAL (ver
[LAB_CHARTER.md](../LAB_CHARTER.md)) existe para impedir.

### Modo EXPERIMENTAL vs. OPERATIONAL

Definido em detalhe no [LAB_CHARTER.md](../LAB_CHARTER.md). O ponto que esta
ADR fixa: **dado operacional nunca vira benchmark controlado silenciosamente**.
Rodar o lab no dia a dia (modo `OPERATIONAL`) produz evidência real, mas essa
evidência só entra numa comparação controlada (modo `EXPERIMENTAL`) se o run
foi declarado como tal antes de começar — nunca por reclassificação
retroativa de um run operacional.

### Autoridades

- **Humano** — autoridade de produto e design: o que o lab mede, quais
  estratégias existem, quais critérios de sucesso importam.
- **Lab** (o próprio `agentlab`, seu control plane e seus contratos) —
  autoridade de processo e evidência: como uma medição é coletada, isolada,
  redigida e hashada. O lab não decide o que é "bom"; decide se a medição de
  "bom" é confiável.

Nenhum agente de desenvolvimento (Claude, Codex, Hermes, futuros) tem
autoridade de processo — ver execution contract acima.

### `dev/` é bootstrap harness, não arquitetura do produto

`dev/` constrói o `agentlab` (ver [HARNESS.md](../HARNESS.md)); não é parte do
kernel nem do produto que o kernel descreve. Nada em `dev/` — packets,
`plan.yaml`, perfis de launcher — entra nos critérios de inclusão acima, e
nenhuma decisão sobre o kernel depende do estado do harness.

---

## Consequências

### Positivas

- Toda proposta de "adicionar isso ao core" tem um teste de quatro perguntas
  em vez de julgamento ad-hoc.
- O control plane fica pequeno e estável por desenho, o que reduz a
  superfície que precisa de revisão pesada.
- Comparação entre agentes é uma comparação válida porque o contrato de
  execução é uniforme.

### Negativas

- Toda extensão nova paga o custo do ciclo de incubação completo antes de
  virar dado comparável — não há atalho para "só dessa vez".
- Decisões de fronteira (kernel vs. extensão) exigem justificativa explícita
  contra os quatro critérios; isso é atrito deliberado, não acidental.

---

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **Sem critério explícito, decisão caso a caso** | é o que já causa inchaço de core em projetos comparáveis; sem teste objetivo, toda extensão parece "importante o bastante" |
| **Kernel definido por código, não por ADR** | código não impede a próxima extensão de adicionar campo ao core sem debate; a fronteira precisa ser um documento que se discute antes de implementar |
| **Um único plano sem distinção experiment/control** | mistura o que muda a cada estratégia com o que garante confiabilidade da evidência; erro num muda o significado do outro |
| **Extensões promovidas por decreto (sem estágios)** | é exatamente o caminho para dado operacional virar benchmark controlado sem ter sido desenhado para isso |

---

## Revisar quando

- um conceito passar nos quatro critérios mas ainda assim causar atrito real
  em manter fora do kernel — sinal de que os critérios precisam de ajuste, não
  de exceção;
- o ciclo de incubação se mostrar burocracia sem valor para extensões de baixo
  risco — mas só depois de medir esse custo, não por impressão;
- a distinção experiment/control plane deixar de refletir a estrutura real de
  `src/`.
