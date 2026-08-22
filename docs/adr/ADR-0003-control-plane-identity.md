# ADR-0003 — Orchestration Control Plane como produto; adaptive routing deixa de ser non-goal

- **Status:** aceito
- **Data:** 2026-08-21
- **Contexto da decisão:** pós-M86 (fechamento do Marco 3) e commits
  `c7ec6a4`…`a24c0cb`; planejamento do Marco 4
  ([plano](../superpowers/plans/2026-08-21-agentlab-control-plane-jcode-evolution.md))
- **Substitui:** — (emenda o LAB_CHARTER §1 e §6; complementa
  [ADR-0002](ADR-0002-evidence-kernel.md), que permanece válido)

---

## Contexto

O LAB_CHARTER definia a missão como "selecionar, coordenar e melhorar agentes
de desenvolvimento" por evidência, e listava em §6 três non-goals que o código
posterior contradisse:

1. **"Adaptive router que escolhe agente/modelo automaticamente com base em
   histórico"** — M78 entregou o router determinístico
   (`src/routing/router.ts`), M81 a consulta read-only de história
   (`src/performance/query.ts`) e M82 o router informado por histórico
   (`src/routing/history-router.ts`); o commit `a24c0cb` ligou a história
   canônica de projetos externos a esse router em produção
   (`dev/lib/project-history.ts`, `dev/lib/project-run.ts`).
2. **"Supervisor complexo de múltiplos agentes coordenados"** — o lifecycle
   universal (M71–M86) spawna planner, implementer e reviewer com fronteiras
   estruturais de papel (`dev/lib/project-roles.ts`,
   `dev/lib/project-orchestrate.ts`).
3. **"Memory system"** — `RunHistoryContextV1`, episódios e
   `ComparableRunFacts` são estado durável entre runs que alimenta decisões,
   ainda que viva inteiramente em `data/runs/`.

O charter previa a saída correta: *"um non-goal é permanente até uma ADR nova
argumentar o contrário com a mesma explicitação de trade-off que ADR-0002
exige"*. Essa ADR não existia — o charter estava, portanto, ativamente errado
em relação ao código. Além disso, o termo **"control plane"** era usado com
três sentidos distintos: em ADR-0002, a máquina de confiabilidade da evidência
(storage/isolamento/redaction/manifests/integridade); em ARCHITECTURE §6, um
rótulo de camada para `cli`/`intake`/`inspection`/`planner`/`routing`; em
ARCHITECTURE §6.1 e M3-REVIEW, o lifecycle completo de orquestração de
projetos. Um leitor que confiasse em qualquer um dos documentos julgaria o
codebase errado.

Esta ADR registra a mudança de direção explicitamente, em vez de escondê-la:
o projeto evoluiu, por decisões incrementais evidenciadas em M71–M86, de
"laboratório que mede agentes" para "control plane que conduz projetos usando
a própria evidência que coleta". A identidade documentada precisa alcançar a
identidade implementada.

---

## Decisão

### 1. Identidade do produto

> **Agent Strategy Lab is an autonomous, evidence-grounded AI project control
> plane for planning, routing, executing, validating, recovering and learning
> across long-running software projects.**

Benchmarks e experimentos controlados são o **Experimental / Learning Plane**:
existem para produzir a evidência que melhora routing, seleção de
modelo/effort, seleção de estratégia e decisões de custo/qualidade. O plano
experimental ensina o control plane; **o control plane é o produto**. Isso
inverte a ênfase da missão original sem abandonar seu núcleo: "toda alegação
rastreia até um run auditável" continua inegociável — mudou quem consome a
evidência (antes: o humano compara agentes; agora: também o próprio sistema
roteia com ela).

### 2. Vocabulário oficial (fim da ambiguidade de "control plane")

| Termo | Significado | Onde vive |
| --- | --- | --- |
| **Evidence Kernel** | O sentido de ADR-0002: storage, isolamento, redaction, manifests, hashing canônico, integridade, os records do kernel estável. Autoridade de confiabilidade da medição. | `src/storage`, `src/envelope`, `src/schemas`, `data/runs/` |
| **Orchestration Control Plane** | O lifecycle universal de condução de projetos: intake, inspection, planning, routing, execução subordinada, validação, review gate, diagnosis, recovery, escalation, human gates, história→routing. | `src/intake`, `src/inspection`, `src/planner`, `src/routing`, `src/performance` + runtime em `dev/lib/project-*.ts`, `dev/lib/orchestrate.ts` |
| **Experimental Plane** | Experimentos controlados: `ExperimentSpec` congelado, scheduling contrabalanceado, scoring, comparação entre arms, corpus. | `src/experiment`, `src/scorer`, `src/reporting`, `corpus/`, `strategies/` |

Documentos e código novos usam estes termos; "control plane" sem qualificador
passa a significar **Orchestration Control Plane**. ADR-0002 permanece válido
lido com este glossário: onde escreve "control plane", leia "Evidence Kernel".

### 3. Adaptive routing deixa de ser non-goal — com as salvaguardas que o tornaram aceitável

O non-goal original protegia contra um router que **inventa julgamento**: pesos
arbitrários, precisão fabricada, decisão opaca. A implementação entregue não é
esse router, e é exatamente por isso que a reversão é aceitável. As
propriedades abaixo são **condições da decisão**, não detalhes de
implementação — removê-las reabre esta ADR:

- **Pareto-only, sem pesos.** O router histórico só decide quando uma única
  série comparável domina todas as alternativas em todas as dimensões de
  utilidade; empate, trade-off ou ambiguidade caem no fallback determinístico
  (M78). Nenhuma ponderação externa aos dados.
- **Ausência não prova inferioridade.** Perfil elegível sem série suficiente
  força fallback — histórico nunca pune quem não foi medido.
- **Identidade comparável estrita.** Séries só se comparam com fingerprint de
  perfil byte-igual, mesma task class/difficulty/stack/modelo/effort/ambiente;
  `UNKNOWN` bloqueia comparação em vez de virar default.
- **Decisão auditável.** Todo resultado carrega `source`
  (`HISTORY`/`M78_FALLBACK`), rationale e provenance; o humano continua dono
  da policy (perfis elegíveis, ladder, billing) — o router escolhe **dentro**
  dela, nunca a amplia.

O julgamento de valor continua humano — o que mudou é que a *aplicação
mecânica* de evidência suficiente e não-ambígua a uma escolha dentro de policy
autorizada deixou de exigir um humano no loop a cada task.

Pelo mesmo raciocínio, dois non-goals vizinhos são **reescopados** (não
removidos): o lab agora coordena múltiplos workers **com fronteiras
estruturais e um por vez** (não é o "supervisor em tempo real" vetado — esse
continua fora); e mantém **estado durável de execução com provenance** em
`data/runs/` (não é o "memory system conversacional" vetado — injeção
automática de memória em workers continua fora, ver plano do Marco 4, M-I).

### 4. História canônica: global com identidade de projeto obrigatória (D4)

A história canônica de projetos externos é gravada no armazenamento canônico
da instalação do Lab (`data/` do lab, não do repo alvo — comportamento de
`a24c0cb`). Esta ADR ratifica essa localização com a condição que a torna
segura:

> **global canonical evidence store + mandatory project identity / namespace /
> provenance.**

Todo registro de história de projeto carrega identidade do projeto
(fingerprint da work definition, binding com repo/runtime). Consulta e
aprendizado **cross-projeto só quando a policy permitir explicitamente**;
nenhum caminho de código mistura contexto de projetos silenciosamente. Não há
migração de storage nesta decisão; se um dia a localização mudar, será por ADR
nova com plano de migração aditivo.

### 5. O que esta ADR não muda

- Os quatro critérios de inclusão no kernel, o baseline histórico, o execution
  contract e o ciclo de incubação de ADR-0002 — intactos.
- A regra EXPERIMENTAL vs. OPERATIONAL — intacta; dado operacional continua
  nunca virando benchmark silenciosamente.
- A divisão de autoridades humano/lab — refinada, não invertida: produto,
  risco, custo não autorizado, escopo e arquitetura ambígua continuam humanos
  (as 12 capabilities human-gated de `src/intake/index.ts`).
- Rigor experimental — o Experimental Plane mantém spec congelada,
  contrabalanceamento, qualificação e limites estatísticos explícitos.

---

## Consequências

### Positivas

- Charter, ARCHITECTURE, HARNESS e README podem descrever o mesmo sistema sem
  contradição; "control plane" tem um significado por contexto.
- A evolução histórica fica registrada em vez de escondida: quem ler ADR-0002
  e depois esta ADR entende o que mudou, quando e por quê.
- As salvaguardas do routing (Pareto-only, fallback, provenance) viram
  condições de decisão revisáveis, não folclore de implementação.

### Negativas

- O produto assume responsabilidade maior: um bug no Orchestration Control
  Plane agora é um bug de produto, não do harness de bootstrap. A fronteira
  "dev/ é descartável" de ADR-0002 §`dev/` ficou parcialmente falsa na prática
  (o runtime do control plane vive em `dev/lib/project-*.ts`) — a consolidação
  é dívida registrada no plano do Marco 4, não resolvida por esta ADR.
- Manter as condições do §3 tem custo permanente: qualquer otimização de
  routing que exija ponderação ou heurística opaca é vetada até ADR nova.

---

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **Manter o charter e remover o router histórico** | destruiria M81/M82 funcionando e testado; a necessidade real (rotear sem humano por task dentro de policy) permanece e voltaria pior |
| **Reinterpretar o non-goal ("o router não é 'adaptive' porque tem fallback")** | reescrita retroativa de intenção — a mesma classe de erro que o baseline histórico proíbe para evidência |
| **Dois produtos (lab de benchmark + orquestrador separado)** | duplicaria Evidence Kernel, perfis, billing e história; a evidência que ensina o routing é a mesma que o benchmark produz — separá-los quebra o ciclo de aprendizado |
| **História canônica por projeto (no repo alvo)** | espalha evidência por N repositórios com N políticas de redaction/backup; cross-projeto viraria sincronização; identidade obrigatória no store global dá o mesmo isolamento sem fragmentar a fonte de verdade |

---

## Revisar quando

- alguém propuser ponderação, score composto ou heurística não-Pareto no
  routing histórico — isso reabre o §3 por definição;
- a consolidação do runtime do control plane (`dev/lib/project-*.ts` → produto)
  for planejada — esta ADR documenta a dívida, a ADR da consolidação decide o
  destino;
- surgir necessidade real de aprendizado cross-projeto por default — hoje é
  policy-gated e a inversão exigiria nova análise de contaminação;
- o Experimental Plane deixar de conseguir responder às perguntas que o
  routing faz (sinal de que o ciclo evidência→decisão quebrou em algum elo).
