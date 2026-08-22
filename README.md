# Agent Strategy Lab

> **An autonomous, evidence-grounded AI project control plane** — planeja, roteia,
> executa, valida, recupera e aprende ao longo de projetos de software de longa
> duração, usando agentes de código (Claude Code, Codex) como workers
> descartáveis e subordinados.

O Agent Strategy Lab recebe uma intenção de projeto e a transforma em execução
organizada: ele decide **o que** fazer, **quem** executa, **como** validar e
**quando** parar para uma decisão humana. Os agentes de código nunca possuem o
plano, o routing, a policy de billing, o commit oficial ou a decisão de PASS —
essas responsabilidades pertencem ao control plane.

```text
USER INTENT + agentlab-run.yaml
        │
   INTAKE ─ escopo de autorização explícito (autônomo vs human-gated)
        │
   INSPECTION ─ leitura do repositório alvo (stack, validações, âncoras)
        │
   PLANNING ─ work units tipadas com DAG de dependências
        │
   ROUTING ─ capability → router determinístico → histórico (Pareto)
        │
   EXECUTION ─ worker descartável, budget e timeout externos
        │
   VALIDATION ─ validação oficial reexecutada + review gate
        │
   ├── PASS aceito ──→ próxima work unit runnable
   └── FAIL ──→ DIAGNOSIS → RECOVERY (repair bounded → escalation → humano)
        │
   CANONICAL EVIDENCE ─ runs selados alimentam o routing futuro
```

## O que o sistema faz

- **Intake e autorização.** Um arquivo `agentlab-run.yaml` separa a *definição
  do trabalho* (plano com tarefas, acceptance e validações) da *autorização de
  execução* (boundary autônomo, capabilities que exigem humano, policy de
  profiles e billing). O que não foi autorizado explicitamente não acontece —
  ausência nunca vira default permissivo. Ver
  [`docs/agentlab-run.example.yaml`](docs/agentlab-run.example.yaml).
- **Inspection.** O repositório alvo é inspecionado em modo somente-leitura
  para derivar fatos (stack, comandos de validação, ferramentas exigidas) que
  alimentam o planejamento — nada é assumido sem evidência.
- **Planejamento com DAG.** Work units (`PlannedTask`) carregam objetivo,
  acceptance, validações determinísticas, dependências (`blocked_by`),
  taxonomia, risco e envelope de recursos. Ciclos, dependências desconhecidas e
  planos desconexos são recusados no carregamento.
- **Routing em três camadas.** Capabilities de perfil derivadas com provenance
  (`src/routing/capability.ts`) → router determinístico por exigência da tarefa
  (`src/routing/router.ts`) → router informado por histórico canônico
  (`src/routing/history-router.ts`), que só decide quando uma série comparável
  domina todas as outras por Pareto — empate, lacuna ou UNKNOWN caem no
  fallback determinístico em vez de virar palpite.
- **Execução subordinada.** Workers são processos frescos de CLI headless
  lançados com timeout externo, process group auditado e ambiente sanitizado
  (`dev/lib/launch.ts`). Continuidade de sessão é proibida por design: cada
  attempt tem identidade própria e contexto fresco.
- **Validação e aceitação.** A validação oficial é sempre reexecutada pelo
  orquestrador — o self-report do worker é comparado com a evidência, nunca
  aceito. Quando a policy exige review, vale a regra conjuntiva
  *validation PASS + review ACCEPT = PASS aceito*, com o veredito amarrado ao
  candidate por hash (`dev/lib/candidate-review.ts`).
- **Recovery e escalation.** Falha passa por diagnóstico com classes explícitas;
  apenas falha de *capability* é elegível a escalation, dentro de uma ladder
  autorizada. Repair automático é limitado a uma tentativa com o mesmo perfil.
  Quatro recoveries determinísticas cobrem falhas de infra, protocolo e output
  incompleto. Esgotou a policy → `HUMAN_REQUIRED`, com zero spawn depois do gate.
- **Evidência canônica.** Cada attempt relevante vira um run selado em
  `data/runs/<id>/` com manifests, ledger append-only e verificação de
  integridade antes da publicação. Fatos comparáveis carregam provenance por
  campo; o que não foi medido permanece `UNKNOWN` — nunca vira zero, nunca é
  inventado retroativamente.
- **Aprendizado.** A história canônica de execução alimenta o routing de
  tarefas futuras (episódios, taxa de first-pass, repair, custo, intervenção
  humana). Intervenções humanas são registradas como fatos com prova positiva
  (`RunInterventionsRecord`).
- **Human-on-the-loop.** O escopo de autorização distingue capabilities
  autônomas (workspace descartável, validação determinística, repair bounded,
  escalation dentro da ladder) de capabilities que sempre exigem humano
  (billing não autorizado, ação destrutiva, side-effect externo, expansão de
  escopo, decisão de arquitetura/produto não resolvida, entre outras —
  `src/intake/index.ts`). O objetivo é o usuário decidir produto e risco, não
  gerenciar agentes manualmente.

## Experimental / Learning Plane

Além do control plane, o Lab mantém um plano experimental: experimentos
controlados (`ExperimentSpec` congelado por hash, scheduling contrabalanceado,
scoring contra budgets, comparação entre arms) sobre um corpus de tarefas
(`corpus/`). **Benchmarks não são o produto** — são o instrumento que produz a
evidência usada para melhorar routing, seleção de modelo/effort, estratégias e
decisões de custo/qualidade. O plano experimental ensina o control plane, não o
contrário. Ver [`docs/adr/ADR-0003-control-plane-identity.md`](docs/adr/ADR-0003-control-plane-identity.md).

## Estado atual

**Implementado e testado** (139 arquivos de teste, incluindo E2E do fluxo de
projeto externo com providers fake):

- Ciclo completo de projeto externo via `pnpm dev-run-plan --repo <alvo>
  --plan <plano> --authorization <agentlab-run.yaml>` — intake, inspection,
  routing, execução, validação, review gate, repair, escalation, diagnóstico e
  materialização de história canônica.
- Evidence kernel: runs selados, redaction, integridade, índice SQLite derivado
  e reconstruível.
- Billing/credencial: assinatura provada a cada launch; API key banida dos
  perfis de assinatura; fatos operacionais tri-state (provado true / provado
  false / UNKNOWN) com assimetria deliberada (credencial UNKNOWN bloqueia;
  quota UNKNOWN prossegue sem ser reportada como disponível).
- Catálogo de perfis de execução versionados (Claude, Codex e duplos fake) com
  capabilities derivadas com provenance.

**Limitações atuais** (mapeadas como work units M87–M126 em
[`dev/plan.yaml`](dev/plan.yaml); plano em
[`docs/superpowers/plans/2026-08-21-agentlab-control-plane-jcode-evolution.md`](docs/superpowers/plans/2026-08-21-agentlab-control-plane-jcode-evolution.md)):

- `HUMAN_REQUIRED` é terminal: ainda não há registro persistido de decisão
  humana com retomada automática do nó bloqueado.
- Tarefas não nascem dinamicamente durante a execução; o grafo é estático por
  plano.
- Não há interface unificada de eventos de execução; o stream do Codex ainda
  não é parseado pelo harness.
- Execução estritamente serial (`concurrency = 1`).
- O primeiro projeto real permanece bloqueado por HUMAN STOP explícito
  ([`docs/reviews/M3-REVIEW.md`](docs/reviews/M3-REVIEW.md)); a história
  canônica ainda não tem amostra real.

**Planejado** (mesmo plano, milestones tardios e com gates humanos próprios):
handoff tipado v2 com `what_i_did_not_check`, task graph com nascimento
controlado de tarefas, decisões humanas persistidas com resume, retrieval
estrutural language-neutral, adapter opcional para o runtime
[jcode](https://github.com/1jehuang/jcode) (atrás de flag, após spike de
transporte), concorrência opcional e memória de projeto auditável.

## Estrutura do repositório

| Caminho | Papel |
|---|---|
| `src/` | Contratos puros e lógica de decisão do produto (schemas, planner, routing, performance, storage, intake, inspection). Não importa `dev/`. |
| `dev/` | Runtime do control plane e harness de execução (launch, orquestração, recovery, perfis, CLIs `dev-*`). Importa `src/`. |
| `dev/plan.yaml` | Definição versionada e autoritativa das work units do próprio Lab. |
| `docs/` | Charter, arquitetura, harness, ADRs, lessons, reviews e planos. |
| `corpus/`, `strategies/` | Plano experimental: tarefas de benchmark e estratégias declarativas. |
| `data/` | Evidência canônica (gitignored; disco é a fonte de verdade). |

Documentos de entrada: [`docs/LAB_CHARTER.md`](docs/LAB_CHARTER.md) (missão e
fronteiras), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (modelo de dados e
control plane), [`docs/HARNESS.md`](docs/HARNESS.md) (runtime de execução),
[`docs/LESSONS.md`](docs/LESSONS.md) (regras aprendidas com falhas reais).

## Princípios inegociáveis

SPEC FIRST · evidência sobre self-report · `UNKNOWN ≠ 0` · fail-closed quando a
evidência é inválida · fonte de verdade canônica única · contratos
provider-neutrais · autorização explícita de escopo · retries bounded ·
recovery observável · história auditável.
