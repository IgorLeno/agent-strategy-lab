# Harness de sessões descartáveis (Fase S)

Uma microtarefa = uma sessão nova = um processo novo. O worker que concluiu
uma tarefa nunca inicia a seguinte. A limpeza de contexto é garantida por
**encerramento real do processo**, não por instrução no prompt.

**Papel dentro do produto maior** (vocabulário de
[ADR-0003](adr/ADR-0003-control-plane-identity.md)): este documento descreve o
**runtime de execução** — como sessões descartáveis são lançadas, observadas,
fechadas e recuperadas. Ele serve a dois consumidores: (a) o bootstrap do
próprio `agentlab` via `dev/plan.yaml`, e (b) o **Orchestration Control
Plane** de projetos externos, que reutiliza estas mesmas primitives por
`dev-run-plan --authorization` (ver seção correspondente abaixo). O harness
não é o sistema inteiro e o sistema não é "um benchmark harness": benchmarks
vivem no Experimental Plane (`src/experiment/`), e o produto é o control
plane. Runner do produto experimental é M21–M24, dentro de `src/runner/`.

## Fontes de verdade

| Onde | O quê | Versionado |
| --- | --- | --- |
| `dev/plan.yaml` | definição autoritativa das microtarefas | sim |
| `dev/profiles/*.yaml` | perfis de launcher | sim |
| `.dev/` | runtime do orquestrador: state, packets, completions, handoffs, logs | **não** (`.gitignore`) |
| `.dev-inbox/<task>/` | inbox do worker: `report.json` e `handoff-draft.json` | **não** (`.gitignore`) |
| `docs/BACKLOG.md` | visão humana derivada | sim, nunca operacional |

Como `.dev/` está fora do Git, o accepted_commit contém só a implementação e o
`dev-close` grava estado sem sujar a working tree.

## Política de freeze

`dev/` é o harness que constrói o `agentlab` (ver topo deste documento); ele
não é o produto e não deve crescer capacidade nova indefinidamente. Manutenção
em `dev/` só é aceita quando pelo menos uma condição se aplica:

1. **defeito reproduzível** — comportamento errado do harness, demonstrável
   com passos ou log;
2. **risco à validade experimental** — algo que contaminaria a comparação
   entre estratégias/perfis (ex.: dimensão vazando para o agente, envelope
   calculado errado);
3. **perda ou corrupção de evidência** — qualquer caminho em que
   `LaunchRecord`, `CompletionRecord`, `HandoffRecord` ou os logs do worker
   possam sumir ou ficar inconsistentes;
4. **incapacidade objetiva de executar o plano** — o harness trava, recusa
   avançar ou não consegue processar uma tarefa `READY` legítima.

Capacidade nova — um comando, um perfil de recurso, uma funcionalidade que o
harness ainda não tem — **nasce como contrato em `src/`**, não em `dev/`.

Estado honesto pós-M86: essa regra vale para **contratos e decisão** (que de
fato vivem em `src/`), mas o **runtime** do Orchestration Control Plane foi
construído em `dev/lib/project-*.ts`, consumindo os contratos de `src/`. Ou
seja, `dev/` hoje contém duas coisas distintas — o harness de bootstrap
(congelado pelas quatro condições acima) e o runtime do control plane (que
evolui por evidência de projeto real, sem roadmap pré-autorizado). A dívida
de consolidação está
registrada em [ADR-0003](adr/ADR-0003-control-plane-identity.md); até lá, as
quatro condições de freeze aplicam-se ao harness de bootstrap, e o runtime do
control plane evolui pelas work units planejadas em `dev/plan.yaml`, nunca
ad-hoc.

Nota operacional: o lifecycle universal (`--authorization`) entra **somente**
por `dev-run-plan`; `dev-orchestrate` não aceita `--authorization` e preserva
o comportamento histórico de profile único.

### O que a separação inbox/runtime garante — e o que não garante

O worker recebe exatamente dois caminhos de escrita (`report.json` e
`handoff-draft.json`, dentro do inbox da tarefa) e nenhum caminho do runtime do
orquestrador. Isso torna a fronteira **explícita e auditável**: o que é entrada
do worker e o que é evidência derivada não moram no mesmo diretório.

Não é uma fronteira de segurança. O worker roda com o mesmo usuário, no mesmo
repositório, sem sandbox ou isolamento de permissões — nada impede
tecnicamente que ele escreva em `.dev/`. A evidência é **derivada pelo
orquestrador, não protegida contra worker malicioso**. O modelo de ameaça
coberto é agente confuso ou desalinhado, não agente adversário.

### Contrato de acesso do worker (`WorkerExecutionAccessContract`)

Separar os diretórios não basta: o sandbox real do provider precisa **conceder**
os caminhos que o Agent Lab exige. Antes de cada lançamento de implementer, o
launcher deriva um contrato explícito — workspace (o repo alvo), roots
graváveis auxiliares (o outbox de protocolo *da tarefa corrente* e, quando o
profile o exige, o HOME sanitizado) e a capability de rede para
*dependency fetch* — traduz esse contrato para o mecanismo do provider e
**prova** o resultado lendo o argv final de volta.

- **Codex**: `--sandbox workspace-write` preservado;
  `sandbox_workspace_write.writable_roots` concede os roots auxiliares e
  `sandbox_workspace_write.network_access` habilita a rede. Bypass perigoso
  continua proibido.
- **Claude**: `--add-dir` declara os mesmos roots; a permission policy
  versionada continua governando o que pode ser executado.
- **Worker falso**: representa o contrato sem sandbox de filesystem real.

Duas regras:

> **A worker launch is authorized only when every required writable/runtime
> capability is represented in the access contract and proven by the effective
> provider sandbox before spend.**

> **Paths passed to the worker do not imply permission; effective access must be
> proven.**

Deny by default: o que não está no contrato continua não gravável — runtime
inteiro, catálogo de profiles, `state.json`, inboxes de outras tarefas,
completions, handoffs selados e o plano. Mismatch mecânico falha como
`PREFLIGHT_BLOCKED`, **antes** do spawn: zero launch, zero token, e a tarefa
não vai para `FAIL` nem para `INFRA_ERROR` por causa disso.

Rede é capability de desenvolvimento, não autorização de efeito externo:
`NETWORK CONNECTIVITY != AUTHORIZATION TO PERFORM EXTERNAL SIDE EFFECTS`.
Deploy, publish, push, cloud, e-mail e crédito de API continuam governados
pelos gates próprios. Planner e reviewer permanecem read-only: contrato sem
workspace de escrita, sem outbox de protocolo e sem rede.

## Ciclo

```
dev-next       (somente leitura) seleciona a próxima READY e imprime o packet
                                 -> o orquestrador é quem persiste
dev-launch     processo NOVO (detached, sessão própria, supervisionado), só o
               task packet — SEM deadline derivado da task
                                 -> RUNNING / EXECUTING
   worker      valida SÓ a tarefa atual, cria EXATAMENTE UM candidate commit,
               escreve AgentCompletionReport + HandoffDraft, ENCERRA
                                 -> RUNNING / FINALIZING
dev-close      confirma commit e escopo, re-executa as validações do packet,
               deriva orchestrator_evidence, promove candidate -> accepted,
               grava CompletionRecord e sela o HandoffRecord
                                 -> PASS
dev-orchestrate  roda o loop acima; o worker nunca roda o loop
dev-run-plan     resolve repo/plan/profile, inicializa se preciso, delega ao loop
dev-recover      reconcilia plano + commits + completions + runtime
lab              porta de produto: HumanInstruction → intake → runProject.
                 --self usa worktree isolado; --resume relê o runtime.
```

A porta `lab` não é outro orquestrador: lê a instrução humana, persiste
`HumanInstruction`, deriva o intake e chama `runProject`. Self-maintenance
nunca edita o working tree do control repo durante a run.

## Estados

`READY | RUNNING | PASS | FAIL | TIMED_OUT | MISSCOPED | INFRA_ERROR`, com
`phase: EXECUTING | FINALIZING` apenas dentro de `RUNNING`.

- **FAIL** — worker concluiu explicitamente com falha, OU validação obrigatória
  re-executada pelo orquestrador falhou.
- **TIMED_OUT** — uma AUTORIDADE EXTERNA encerrou o process group antes do
  término espontâneo. Não avança. Qual autoridade fica em
  `LaunchRecord.termination_cause`:
  - `MACHINE_SAFETY_CEILING` — failsafe de infraestrutura (ver "Runtime");
  - `EXPLICIT_CANCELLATION` — cancelamento pedido pelo operador/control plane;
  - `LEGACY_TASK_DEADLINE` — records ANTIGOS, quando a duração prevista da task
    ainda encerrava processo. Nunca é produzido em runs novas;
  - `STALL_GUARD` — reservado; não é produzido na fase observacional atual.
  Record histórico sem o campo e com `timed_out: true` significa
  `LEGACY_TASK_DEADLINE`; `terminationCauseOf` faz essa leitura sem reescrever
  arquivo nenhum. `MISSCOPED` é reclassificação humana posterior, nunca decisão
  do término.
- **INFRA_ERROR** — launcher falhou (exit 125/126/127, término por sinal),
  `RUNNING/EXECUTING` com processo inexistente, ou o `result` do provider
  declarou término por falha (ver abaixo).
- **Guarda operacional incompleta ≠ FAIL** — draft/report ausente, tree suja,
  commit não localizado ou fora do escopo deixam a tarefa em
  `RUNNING/FINALIZING` com diagnóstico. Retry é legítimo.

## Runtime

A duração PREVISTA de uma task **não tem autoridade operacional**. Ela é
hipótese, não autorização.

**Não existe task deadline.** O coding worker é lançado com o argv do próprio
agente, sem wrapper de tempo. Um worker que ultrapassa a previsão continua
trabalhando; ultrapassar previsão nunca produz `TIMED_OUT`.

**A previsão continua sendo calculada** — `ExecutionRuntimeForecast`, com
`authority: 'ADVISORY'`. Ela preserva os componentes úteis (envelope base,
custo de validação quando o stage é do worker, multiplicadores de capability,
task class, stack e ambiente) e sua proveniência, porque é ela que vai ser
comparada com o tempo OBSERVADO. Erro de previsão é telemetria: nunca muda
PASS/FAIL, nunca rejeita profile, nunca encerra processo.

**Routing decide por capacidade, não por relógio.**

```
task characteristics + capability/history  →  model / reasoning effort
predicted time                             →  (nada)
```

**`MACHINE_SAFETY_CEILING` é a única terminação automática ativa.** Ele é
failsafe de INFRAESTRUTURA, não budget de task: independe de
`estimated_duration`, `resource_envelope`, dificuldade e planner; não entra em
routing; não rejeita profile. Default deliberadamente conservador (12h,
`dev/lib/machine-safety.ts`) — escolhido como POLICY OPERACIONAL, não como
duração ótima de tarefa: alto o bastante para nunca cortar execução saudável,
baixo o bastante para que uma máquina sequestrada seja detectável no mesmo dia.
Configurável por `AGENTLAB_MACHINE_SAFETY_CEILING_SECONDS`, com override
explícito para que testes exercitem o failsafe em segundos.

**Supervisão de processo.** Sessão própria (`detached`), pgid conhecido,
`AGENTLAB_LAUNCH_ID` no environment, caminho de cancelamento explícito, escada
SIGTERM → graça (`kill_after_seconds`) → SIGKILL no GRUPO, auditoria e limpeza
de sobreviventes depois do término. `kill_after_seconds` é a graça APÓS o
pedido de término — nunca a duração máxima da task.

**Observação de atividade (v1, observacional).** `dev/lib/activity-observer.ts`
registra ao vivo timestamp de chunk em stdout/stderr, `last_activity_at`,
intervalo corrente e maior intervalo de silêncio, e marca `STALL_SUSPECTED`
quando o silêncio cruza uma janela. O listener convive com o `pipe` do log:
nenhum byte é consumido ou truncado, e os parsers post-hoc
(`readClaudeStream`, `decodeCodexEventStream`) não mudaram de contrato.

> `raw I/O activity != semantic progress`. Byte em stdout prova que o processo
> está vivo e falando — não que ele avança, nem que o que ele escreve faz
> sentido. E silêncio não prova travamento.

**Stall NÃO encerra nada nesta fase.** `STALL_SUSPECTED` persiste telemetria e
evento; a janela é parâmetro OBSERVACIONAL, sem autoridade de termination. A
hipótese de trabalho é que **thresholds de stall precisam ser calibrados por
observação antes de receber autoridade de encerrar processo** — a distribuição
real de silêncio por provider, model, reasoning effort, task class, dificuldade
e outcome ainda não foi coletada. Só depois dela faz sentido discutir sob quais
múltiplos sinais um `STALL_CONFIRMED` poderia encerrar um worker.

**Validation timeouts são outra grandeza.** `ValidationCommand.timeout_seconds`
e `VALIDATION_COMMAND_TIMEOUT_BOUND` limitam um COMANDO de validação e não se
cruzam com nada acima.

`FAIL`, `TIMED_OUT`, `MISSCOPED` e `INFRA_ERROR` **param o fluxo**, com uma
exceção bounded do harness: a **primeira** falha capability-bearing causada
pela validation oficial recebe exatamente um reparo automático no **mesmo
profile**. Se esse repair também falhar na validation oficial, o fluxo para
(`AUTOMATIC_REPAIR_EXHAUSTED`) e exige intervenção humana. Não existe terceiro
repair automático.

A tarefa permanece `FAIL` depois do segundo FAIL oficial. Para uma nova
tentativa ou escalada, o humano precisa inspecionar a evidência e reabrir
explicitamente o lifecycle:

```bash
pnpm dev-retry-failed --task <task> \
  --reason-code OFFICIAL_VALIDATION_FAILURE \
  --reason '<decisão humana>'
pnpm dev-orchestrate --profile <profile escolhido pelo humano>
```

O `READY` produzido por `dev-retry-failed` é o gate humano: com dois
`ValidationFailedAttemptRecord`s, a policy automática fica esgotada, mas não
bloqueia a orquestração normal nem dispara outro repair automático. O próximo
packet continua `REPAIR`, usando os diagnostics do último FAIL oficial, e o
profile é o escolhido nessa nova invocação.

A autorização sai dos `ValidationFailedAttemptRecord`s conectados, não do
número operacional do attempt. `INFRA_ERROR` é capability-neutral: um INFRA
antes do primeiro FAIL oficial não consome o repair, e um INFRA durante o
repair não o consome como falha de capability. Worker FAILURE, PENDING,
TIMED_OUT, PREFLIGHT_BLOCKED e evidência inconsistente/gap **não** entram
nesta automação — mantêm as políticas atuais. Evidência corrupta falha
fechada: nenhum provider é lançado.

`AttemptAbandonmentRecord` é uma fronteira manual conhecida, não um gap nem
um INFRA: a policy automática não atravessa esse attempt para reativar um FAIL
oficial anterior, mas preserva os FAILs oficiais posteriores à boundary no
segmento atual. Ausência de qualquer lifecycle record conhecido continua
`HISTORICAL_GAP`; records incompatíveis no mesmo attempt continuam fail-closed.

Enquanto houver exatamente um repair automático pendente, o `--profile`
solicitado precisa ser o mesmo do `ValidationFailedAttemptRecord` fonte.
Divergência para em `AUTOMATIC_REPAIR_PROFILE_MISMATCH` antes de spawn ou novo
attempt e orienta a rerodar com o profile exigido. Assim uma invocação nunca
mistura profiles enquanto reporta um único `profile_id` no topo.

O repair é um subciclo da tentativa primária. `--max-iterations` limita
tarefas/ciclos primários, não impede o único repair bounded da mesma tarefa:
`--max-iterations 1` pode produzir iteration 1 = FIRST_PASS FAIL e iteration 2
= REPAIR, sem lançar a próxima tarefa do plano. Depois do repair, se o budget
primário acabou, a próxima tarefa não entra; se o repair falhou, o fluxo para
na hora.

`dev-orchestrate` também para em `LIMIT_REACHED` quando esgota
`--max-iterations` com tarefa ainda pendente. Essa é uma parada normal pelo
budget solicitado e retorna exit 0; `stopped_by` e `reason` continuam expondo
o trabalho restante e distinguindo o caso de `ALL_DONE`. Portanto, exit 0
significa sucesso da invocação, não necessariamente conclusão integral do plano.

### Falha terminal do provider ≠ guarda operacional

No transporte `stream-json`, a mensagem `result` diz **como a sessão terminou**.
`is_error: true`, ou `terminal_reason` diferente de `completed`, significa que a
sessão morreu por falha do provider ou do transporte até ele — o protocolo do
worker pode nem ter começado. Isso é `INFRA_ERROR`, nunca fechamento pendente:
cobrar `AgentCompletionReport` de uma sessão que nunca falou com o modelo pede
para sempre um arquivo que ninguém vai escrever.

A regra enumera o **sucesso**, não as falhas: motivo terminal novo cai do lado
seguro sozinho. Nenhum texto de erro específico entra no contrato — `ENOTFOUND`
é diagnóstico de um incidente, não regra. Consumo também não entra: API pode
cair depois de gastar franquia, e o consumo observado vai registrado como veio.

Precedência dos diagnósticos, do mais objetivo ao mais interpretado:
sobrevivente ao SIGKILL → timeout → exit code do launcher / término por sinal →
contrato do transporte violado → falha terminal do provider. Os quatro
primeiros podem PRODUZIR o quinto, e trocar a causa pelo sintoma esconderia o
diagnóstico real.

A evidência fica em `LaunchRecord.provider_failure` (`terminal_reason`,
`api_error_status`, texto do erro truncado + hash da íntegra, e os `signals` que
motivaram a classificação), ao lado de `billing`, `subscription_usage` e
`rate_limit_observations` — que continuam intactos.

O plano precisa ser um DAG: ciclo de dependências é recusado no carregamento,
porque um ciclo deixaria o seletor `BLOCKED` para sempre sem explicar por quê.

## Guarda da base (progressão ≠ recuperação)

Antes de gerar o packet e antes de lançar, o harness exige:

1. working tree limpa;
2. `HEAD` igual ao último `accepted_commit` — ou ao `baseline_sha` registrado
   no `dev-init`, quando nenhuma tarefa passou ainda;
3. `base_sha` do packet persistido igual ao `HEAD` atual.

Sem isso, trabalho externo entre duas sessões (commit manual, merge, arquivo
solto) entrava na base da tarefa seguinte: como o `dev-close` exige exatamente
um commit sobre o `base_sha`, tudo o que veio antes passaria como trabalho do
worker. Divergência para o fluxo em `BASE_DIVERGED` (exit 9) e **não** muda o
status da tarefa — não é veredito sobre o worker.

O `dev-recover` continua sem exigir árvore limpa: reconciliar fechamento
histórico não pode depender do estado atual do checkout. A progressão exige;
a recuperação, não.

## Divisão de autoria

| Quem | Produz |
| --- | --- |
| Worker | `AgentCompletionReport` + `HandoffDraft` (resultado autodeclarado) |
| Orquestrador | `orchestrator_evidence` + `CompletionRecord` + `HandoffRecord` selado |

O worker nunca escreve `accepted_commit` — ele não sabe se o commit foi aceito.
Divergência entre relato e evidência é registrada em `discrepancies`; a
evidência derivada é a autoridade.

## Budgets

Budget é uma questão de PROPRIEDADE: cada teto cobra de quem escreve os bytes.

- `HandoffDraft` ≤ **4 KiB** UTF-8 — payload **do worker**. É ele que decide o
  tamanho de decisões, lições e lacunas, e é dele que o protocolo se defende.
- `HandoffRecord` — **sem teto de bytes**, schema estrito. O record não é o
  draft carimbado: `sealHandoff` troca `changed_files` e `validations` pelos
  valores autoritativos e acrescenta `accepted_commit` e `sealed_at`. Um draft
  honesto dentro do teto vira um record acima dele sem que o worker tenha
  escrito um byte a mais — cobrar do record um teto que o orquestrador é quem
  estoura tornaria o contrato insatisfazível, e a única saída seria truncar
  fato. Um record selado NUNCA é truncado.
- `TaskPacket` ≤ **12 KiB** UTF-8 — o contexto que de fato trafega para a
  próxima sessão, `previous_handoff` incluído. É aqui que um handoff durável
  grande demais para ser transmitido é barrado, e não no selo.
- Preâmbulo do prompt ≤ 5 KiB.

Medidos em bytes sobre JSON canônico: schema válido acima de um budget que
exista continua sendo rejeição.

## Escopo de um commit

O `dev-close` recusa promover commit que:

1. não seja exatamente **um** commit sobre o `base_sha` do packet;
2. não seja o HEAD, ou divirja do commit declarado no report;
3. toque `.dev/`, `.dev-inbox/` ou `dev/plan.yaml` — worker que reescreve o
   próprio plano invalida o protocolo.

O `HandoffRecord` selado é montado campo a campo pelo orquestrador: `task_id`,
`result`, `changed_files`, `validations` e `accepted_commit` vêm da evidência.
Do draft do worker sobrevive apenas o que é opinião dele — `decisions`,
`lessons`, `next_relevant_files`. Draft cujo `task_id` diverge da tarefa em
fechamento é recusado antes de qualquer escrita.

## Auditoria de descendentes

O pai ter morrido não prova sessão encerrada: filho vivo continua mexendo no
repositório enquanto a próxima tarefa roda. Ao fim de cada lançamento o
harness procura sobreviventes por **dois** sinais:

1. **process group** — o worker roda `detached`, então `pgid = pid` e filhos
   comuns herdam esse grupo;
2. **tag de ambiente** — `AGENTLAB_LAUNCH_ID`, único por lançamento, aparece
   em `/proc/<pid>/environ` de qualquer descendente, inclusive o que chamou
   `setsid` e escapou do grupo.

Sobreviventes levam SIGKILL e ficam registrados em `survivors_killed` no
LaunchRecord. O que resistir vira `survivors_remaining` e classifica o
lançamento como `INFRA_ERROR` — sessão contaminada não avança.

**Limite conhecido:** processo que troca o próprio environment (exec com env
limpo, daemon que sanitiza) escapa dos dois sinais. Garantia completa exige
cgroup ou PID namespace, fora do escopo da Fase S.

## Perfis de launcher

O perfil declara **intenção**; o `LaunchRecord` registra o que foi de fato
controlado, derivado do argv final. Capacidade sem a flag que a garante fica
como `"não controlado"` — omitir seria mentir sobre o ambiente do experimento.

Flags de continuidade (`--resume`, `--continue`, `--fork-session`,
`--session-id`) são recusadas **antes** do spawn.

Estado atual dos perfis:

- `fake-worker-v1` — worker falso, fala só a interface interna do harness.
  Nenhum custo, nenhuma rede. É o que os testes usam.
- `claude-build-worker-subscription-v1` — **padrão**. Pago pela assinatura
  Claude Pro (login/OAuth), com política de permissões versionada
  (`--settings dev/profiles/claude-build-worker.settings.json`), modelo fixo
  (`--model`) e `--setting-sources project`, que exclui os settings pessoais
  (`user`, `local`).
- `codex-build-worker-subscription-v1` — pago pela assinatura ChatGPT Plus
  ("Sign in with ChatGPT"). Sem equivalente ao `--bare`; parcialmente não
  controlado por natureza.

Os dois são `real-world`, e não por preguiça: `--bare` é a única flag que
desliga instruction files, hooks, plugins e auto-memory, e ela força
autenticação por `ANTHROPIC_API_KEY`. **Com assinatura não existe modo
`controlled` para o Claude** — a flag é proibida nos perfis de assinatura.

### Modelo e reasoning effort são dimensões experimentais

Ambos saem do **argv versionado do perfil** — nunca de settings pessoais, config
pessoal ou variável de ambiente da máquina de quem roda. O `DoctorReport`
publica `model`, `reasoning_effort` e `reasoning_effort_source`, de modo que
"o perfil fixou este effort" nunca se confunde com "alguém supôs este effort".

- Codex: `--model` fixa o modelo (aprovados: `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`) e `--config model_reasoning_effort="…"` fixa o effort
  (aprovados: `none`, `low`, `medium`, `high`, `xhigh`, `max`). Modelo ou effort
  ausente, duplicado, malformado ou fora da lista **reprova**, e effort sem
  `--ignore-user-config` também reprova — o `config.toml` pessoal ainda entraria.
- Claude: `--effort` fixa o effort (aprovados: `low`, `medium`, `high`, `xhigh`,
  `max`), e só conta como evidência com `--setting-sources` sem fonte pessoal.
  Perfil que declara o `control_marker` `reasoning_effort_pinned: --effort` sem
  a flag no argv reprova.
- Perfil Claude **sem** `--effort` é reportado como `unpinned` (`WARN`), nunca
  como um valor: é o caso de `claude-build-worker-subscription-v2`, e pinar o
  effort nele retroativamente falsificaria os runs já registrados.

Novos profiles Codex de worker usam identidade explícita nas duas dimensões:

`codex-build-worker-subscription-<model>-<effort>-vN`

- `<model>` = `luna` | `terra` | `sol`
- `<effort>` = `medium` | `high` | outra opção explicitamente suportada

Exemplos: `codex-build-worker-subscription-sol-high-v2`,
`codex-build-worker-subscription-terra-high-v2`,
`codex-build-worker-subscription-luna-medium-v2`.
Não completar a matriz por simetria: cada combinação nova é uma capability
decidida à parte. Modelo e effort **nunca** se inferem do texto do
`profile_id` — saem do argv via doctor/`experimentFactsOf`.

`codex-build-worker-subscription-high-v2` é **legacy alias histórico de Sol
High** (`gpt-5.6-sol` + `high`). Permanece no repositório para preservar
LaunchRecords e evidência passada; não usar para novos runs. Não reescrever
histórico nem alterar bytes do YAML legado.

Perfis de experimento (mesmas garantias do baseline; só modelo e effort mudam):
`codex-build-worker-subscription-{high,sol-high,sol-medium,terra-high,terra-medium,luna-medium}-v2`
e `claude-build-worker-subscription-{opus5,sonnet5}-{high,medium}-v3`.

`claude-build-worker-v1`, `claude-build-worker-v2` e `codex-build-worker-v1`
foram removidos: mantinham chave de API na `env_allowlist`, e bastava a
variável existir no shell para o run trocar de fonte de cobrança sem ninguém
perceber. O git guarda o histórico.

## Cobrança: assinatura, nunca API

Detalhes em [BILLING.md](BILLING.md). O resumo operacional:

- perfil de agente real declara `billing_mode` (`subscription_only` | `api`) e
  `environment_mode` (`real-world` | `controlled`) — cobrança e ambiente são
  dimensões separadas;
- perfil `subscription_only` é recusado no carregamento se tiver variável de
  API na allowlist ou flag que troca a credencial (`--bare`, `--with-api-key`,
  `--with-access-token`);
- `dev-doctor` e o preflight de CADA lançamento provam a fonte da credencial
  com comando local e gratuito (`claude auth status --json`,
  `codex login status`). Ausência de chave não é prova de assinatura: sem
  resposta reconhecível, `FAIL: credential source could not be verified`;
- a recusa acontece antes do spawn e classifica `INFRA_ERROR` — nunca `FAIL`,
  porque não é veredito sobre o worker;
- o `total_cost_usd` que a CLI emite é **equivalência estimada em preço de
  API**, gravada em `billing.provider_estimated_api_equivalent_usd`.
  `actual_incremental_charge_usd` fica `null`: não há fonte de faturamento
  autoritativa, e inferir `0` seria mentir na direção oposta.


## Comandos

```bash
pnpm dev-doctor               # confere ANTES de gastar: flags, política, modelo, credencial
pnpm dev-init                 # cria .dev/ a partir de dev/plan.yaml
pnpm dev-next                 # imprime o packet da próxima tarefa (não grava)
pnpm dev-launch --task M01    # um processo novo para uma tarefa
pnpm dev-close                # valida e fecha a tarefa RUNNING
pnpm dev-recover --dry-run    # relata reconciliações sem gravar
pnpm dev-recover-infra --task M33 --reason '...'   # attempt morto por falha do provider
pnpm dev-recover-protocol-output --task M56 --reason '...' # SUCCESS/PASS com metadata de protocolo inválida
pnpm dev-recover-incomplete-worker-output --task M71 --reason '...' # worker terminou sem report/handoff
pnpm dev-orchestrate --profile claude-build-worker-subscription-v1
pnpm dev-run-plan --repo <alvo> --plan <plan.yaml> --profile <id>
pnpm dev-adopt-planned-range --tasks 'M87=<sha>,M88=<sha>' --reason '...'  # planned work feito fora do lifecycle
```

### Adotar planned work executado fora do lifecycle

Existe uma situação que nenhuma das outras adoções cobre: tarefas que ESTÃO no
plano foram implementadas fora do harness, e os commits existem e são
verificáveis, mas não há `CompletionRecord`, `HandoffRecord` nem
`OrchestratedFinalizationRecord` por trás delas. Isso acontece em bootstrap e em
migração do próprio control plane, quando o runtime fica congelado enquanto o
trabalho continua.

Os mecanismos vizinhos recusam esse caso, e devem continuar recusando:

| Mecanismo | Por que não serve |
| --- | --- |
| `dev-adopt-plan` | exige `parent(target) == authorized_head` e `changed_files == [dev/plan.yaml]`; um commit de plano que traz documentação junto não é plan extension |
| `dev-adopt-maintenance-range` | recusa `dev/plan.yaml` por design, e a allowlist de manutenção não cobre código de produto |
| `dev-recover` | tarefa nova sem close bundle reconhecido é `READY`, nunca `PASS` — avançar a base sozinho não conclui tarefa nenhuma |

`dev-adopt-planned-range` é o caminho explícito, e é de propósito mais pesado:

```bash
pnpm dev-adopt-planned-range \
  --target <sha> \
  --tasks 'M87=<sha>,M88=<sha>' \
  --maintenance-commits '<sha>,<sha>' \
  --reason 'reconciliar trabalho aprovado executado fora do lifecycle' \
  --dry-run
```

O que ele exige, e que nenhum atalho substitui:

- **Mapping explícito.** `--tasks` só aceita `tarefa=commit`. Mensagem de commit
  pode sugerir a autoria; nunca decide.
- **Toda a faixa explicada.** Cada commit entre a base autorizada e o target
  recebe um papel — `plan_extension`, `planned_task` ou `unplanned_maintenance`.
  Commit sem papel declarado é recusa, e os arquivos extras de cada commit ficam
  registrados no record em vez de sumirem.
- **Extensão de plano provada.** Exatamente um commit da faixa toca
  `dev/plan.yaml`, e a mudança é verificada append-only contra o plano da base
  autorizada. Cada tarefa adotada precisa estar entre as que a extensão
  acrescentou.
- **Revalidação independente.** Os comandos que a PRÓPRIA tarefa declara rodam
  sobre os bytes do commit mapeado, em worktree destacado. Uma falha derruba a
  adoção inteira: nenhum record, nenhum state parcial.
- **Ordem transacional.** Evidence imutável primeiro, state depois. Crash entre
  os dois é retomado: o rerun reconhece o record, não revalida nada e conclui a
  atualização (`ALREADY_ADOPTED`).

`--dry-run` mostra base anterior, target, extensão detectada, mapping,
manutenção, comandos que rodariam e transições de state — e não escreve arquivo,
record nem state.

#### O que adoção NÃO é

Uma tarefa adotada satisfaz dependência do DAG e avança o runtime, mas **não é
uma execução do harness**. Não existe attempt (`attempts` continua `0`), não
existe handoff — uma tarefa dependente que peça `previous_handoff` recebe `null`,
que é o fato — e nada disso vira `ComparableRunFacts` ou amostra de performance
histórica: aquela camada é alimentada por `LaunchRecord` de attempt real, nunca
por `TaskState.PASS`. Provider, modelo, tokens e billing permanecem UNKNOWN, e
UNKNOWN não vira número para destravar comparação.

A pergunta "por que M87 está PASS?" tem resposta consultável: o
`PlannedWorkAdoptionRecord` em `.dev/planned-work-adoptions/<sha>.json`, com o
commit aceito, o fingerprint da definição revalidada e a evidence de cada
validação. Se alguém editar a tarefa no plano depois, o fingerprint deixa de
bater e o `recover` REVOGA aquele PASS — a adoção histórica não passa a provar
uma definição nova.

### Rodar um PlanFile já existente

`dev-run-plan` é a entrada ergonômica para executar um plano já válido sobre um
repositório alvo. Não é um segundo executor: resolve o setup, inicializa o
runtime só quando ele ainda não existe e delega ao lifecycle canônico
(`dev-init` / `dev-orchestrate`). Uma task no YAML é uma tarefa; várias tasks
com `blocked_by` são um projeto/DAG — o mesmo comando serve para os dois.

Happy path:

```bash
cd /path/to/agent-strategy-lab
pnpm dev-run-plan \
  --repo ~/Projetos/minesweeper \
  --plan ~/Projetos/plans/minesweeper.yaml \
  --profile codex-build-worker-subscription-sol-medium-v2 \
  --autonomy routine
```

O repositório alvo **não** precisa conter `dev/profiles`, settings do Agent
Lab nem cópia do harness. Três raízes distintas:

- **profile / configuração** — catálogo versionado do Agent Strategy Lab
  (`dev/profiles/*.yaml` e settings relativos). Default de `dev-run-plan`.
- **repo** — somente o código inspecionado, modificado e validado; cwd do
  worker.
- **plan** — qualquer caminho absoluto; **não** é copiado para
  `<repo>/dev/plan.yaml`.
- **runtime** — default `<repo>/.dev`, persistente e separado do catálogo.

O operador não precisa encadear `dev-init` + `dev-orchestrate` no caso normal
de um plan novo. O arquivo em `--plan` é a identidade autoritativa: **não** é
copiado para `<repo>/dev/plan.yaml` e pode viver dentro ou fora do repo alvo.
`--profile-root` é override opcional; o happy path não o exige.

Runtime default: `<repo>/.dev` (o mesmo do harness histórico). `--runtime-dir`
é override aditivo. O runtime é persistente:

- primeira execução cria o runtime (NEW) e conduz o DAG;
- rerun com o mesmo plan continua de onde parou (RESUMED);
- ALL_DONE não relança worker;
- `--dry-run` valida repo/plan/profile/runtime sem provider, sem attempt e
  sem mutação autoritativa;
- plan SHA diferente no mesmo runtime falha fechado (`RUNTIME_PLAN_MISMATCH`):
  use outro `--runtime-dir` ou uma operação explícita de adoção/reset fora
  deste comando. Não há `--force` / `--yes` aqui.

`--profile` é obrigatório SEM `--authorization`: esta entrypoint não escolhe um
default implícito. `--plan-file` / `--runtime-dir` nas primitives (`dev-init`,
`dev-orchestrate`) são o mesmo override aditivo; omiti-los preserva
`<repo>/dev/plan.yaml` e `<repo>/.dev`.

### Rodar um PlanFile pelo lifecycle universal (`--authorization`)

Sem `--authorization`, `dev-run-plan` é o wrapper histórico: um profile por
invocação, budget do launcher, parada no repair esgotado. **Com**
`--authorization <agentlab-run.yaml>`, a mesma run atravessa o control plane
universal (M71–M84) — e continua usando exatamente as mesmas primitives de
execução (select, packet, launch, close, validação oficial, automatic repair,
recover, evidência). Não existe segundo executor: o control plane só DECIDE.

```bash
pnpm dev-run-plan \
  --repo ~/Projetos/minesweeper \
  --plan ~/Projetos/plans/minesweeper.yaml \
  --authorization ~/Projetos/plans/minesweeper-run.yaml \
  --autonomy routine
```

Duas coisas ficam DELIBERADAMENTE separadas:

- **work definition** — tarefas, acceptance, dependências e validation vêm do
  PlanFile e são tratadas como confiáveis. Nenhum planning worker é chamado
  para reescrevê-las.
- **execution authorization** — quais capabilities o harness pode exercer
  sozinho, quais profiles são elegíveis e qual é a política de cobrança vêm do
  `agentlab-run.yaml`. `--profile` nunca autoriza nada; quando informado junto
  da policy, precisa pertencer a ela.

O que o PlanFile histórico não carrega (risco, taxonomy, envelope de recursos)
é DECLARADO em `work_units`, com override por task. Nada disso é inferido:
classificação ausente é erro de setup, não default permissivo.

Por work unit o output mostra caminho (`DIRECT`/`REVIEWED`), proveniência da
inspeção, assessment, profile escolhido pelo routing, fonte do routing, worker
runtime budget, autorização do launch, validação, exigência e resultado de
review, repair, diagnosis, escalation e gate humano.

Escalation é autorizada pela ladder da policy (`capability_rank`) e reabre a
task pela primitive oficial (`dev-retry-failed`), sem gate humano por spawn.
Uma policy com **um único profile** é o modo benchmark: inspection, assessment,
budget, validação e review continuam acontecendo, mas uma escalation exigida
vira `HUMAN_REQUIRED` — a policy nunca é ampliada em silêncio.

`docs/agentlab-run.example.yaml` é o contrato comentado; a policy fixa usada em
benchmark A/B está em `docs/agentlab-run.codex-sol-medium-only.yaml`.

Harness self-maintenance (a recipe de manutenção da `--autonomy routine`)
pertence ao Agent Strategy Lab. Num repositório alvo externo ela é
**fail-closed**: um incidente de projeto nunca vira manutenção de harness
dentro do alvo.

`dev-recover-protocol-output` cobre somente o caso estreito em que um worker
terminou com report `SUCCESS`, handoff `PASS` e `candidate_commit == null`, mas
incluiu exatamente os próprios `report.json` e `handoff-draft.json` em
`changed_files`. Esses arquivos são protocol I/O: nunca fazem parte do patch.
Qualquer terceiro path proibido, divergência entre os dois arrays, arquivo real
extra ou ausente, index sujo, processo vivo ou HEAD divergente faz o comando
recusar sem modificar nada.

Antes de limpar o patch, o recovery publica de forma append-only os bytes e
hashes do report, handoff, LaunchRecord e de cada arquivo real, além do bundle
Git e de um `ProtocolInvalidAttemptRecord`. Só depois restaura os paths provados,
libera o inbox e, por último, devolve a task a `READY`. A classificação
`PROTOCOL_OUTPUT_INVALID` registra explicitamente que não houve capability
verdict nem official-validation verdict; uma repetição com a mesma evidência
converge, e bytes divergentes recusam.

`dev-recover-incomplete-worker-output` cobre o caso complementar: o processo
morreu, o LaunchRecord está finished, há patch real na working tree, e
`AgentCompletionReport` e/ou `HandoffDraft` estão ausentes. Não inventa
artifacts, não produz capability verdict nem official-validation verdict.
Preserva o patch (bundle + fingerprint), copia stdout/stderr/launch, registra
`AttemptAbandonmentRecord` com `report_present`/`handoff_present` factuais do
par completo, restaura só os arquivos do patch ao base e devolve a task a
`READY`. Routine autonomy pode executar isso quando
`protocol-output-recovery` recusa especificamente por artifact ausente;
preconditions insuficientes continuam `HUMAN_REQUIRED`. Não lança provider.

`dev-recover-infra` arquiva o attempt que morreu por **falha terminal do
provider** e devolve a tarefa a `READY` sem tocar em `attempts` — o attempt
continua na história como infraestrutura, e repetir é decisão do usuário: o
comando não lança nada.

Antes de liberar, ele copia para
`.dev/failed-attempts/<task>/attempt-<n>/` os bytes exatos de
`launch.infra.json`, `stdout.log` e `stderr.log`, com hash e tamanho no
`InfraFailedAttemptRecord`: o slot `.dev/logs/<task>.*` é do lançamento MAIS
RECENTE, e sem a cópia a evidência do incidente sumiria na primeira
retentativa. É fail-closed — recusa se houver patch na árvore, commit sobre o
`base_sha`, candidate commit, output do worker, timeout ou sobrevivente. Nada
de `AgentCompletionReport`, patch ou candidate é inventado: não houve solução.

Manutenção adotada no meio do caminho não torna o attempt irrecuperável. Um
attempt nascido em `A` continua sendo de `A` — `base_sha` NUNCA é reescrito —,
mas a recuperação é aceita quando `HEAD == authorized_head_sha` e a diferença
entre a base do attempt e a base autorizada está INTEIRAMENTE explicada por
`MaintenanceRecord`s adotados (`maintenanceChainBetween`, já verificada contra o
Git). Descendência não é argumento: `git merge-base` aceitaria trabalho externo
que ninguém auditou. Cadeia ausente, incompleta, ambígua, adulterada ou com
`plan_extension` ⇒ recusa. O record registra os dois fatos separados:
`source_base_sha` é a base HISTÓRICA do attempt, `head_sha` é o HEAD REAL do
instante da recuperação.

Output do worker **deste** attempt continua bloqueando a recuperação — aquele
caminho é do `dev-retry`. O que passa é o par `report.json` + `handoff-draft.json`
que comprovadamente sobrou de um `ValidationFailedAttempt` ANTERIOR: os dois
hashes precisam bater com o MESMO record, e aí os bytes são preservados no
diretório daquele attempt antes de os slots correntes serem liberados. Meio par,
um hash só ou nenhum record dono ⇒ recusa. Timestamp, `changed_files` e
semelhança de conteúdo não decidem posse — só hash e record.

LaunchRecord gravado ANTES do campo `provider_failure` não é reescrito à mão —
isso seria fabricar evidência. A falha é DERIVADA do stdout preservado do
próprio attempt, e só quando o transporte está íntegro (argv declarando
stream-json, exatamente um `result`, nenhuma linha inválida). A origem fica
registrada em `provider_failure_source`: classificação feita depois do fato
não se passa pela do lançamento.

### Autonomia rotineira bounded

`dev-orchestrate --autonomy routine` envolve somente um preflight bloqueado. O
modo classifica evidência conhecida como `AUTO_RECOVER`, `AUTO_MAINTENANCE`,
`TASK_REPAIR` ou `HUMAN_REQUIRED`; sem a opção, o comportamento conservador
anterior permanece inalterado.

`AUTO_RECOVER` executa apenas uma primitive determinística existente.
`AUTO_MAINTENANCE` usa um clone descartável fixado no `authorized_head`, uma
sessão maintainer e uma segunda sessão reviewer, limpa e read-only. O candidate
precisa ser um único commit filho direto, ter targeted tests e os quatro gates
oficiais verdes. Depois de `ACCEPT`, publicação é fast-forward normal, adoção é
exclusivamente por `adoptMaintenance`, recovery é oficial e o retry repete o
mesmo preflight uma vez. `TASK_REPAIR` continua pertencendo à política de
capability já existente.

O budget permite no máximo dois candidates (uma correção após `REJECT`), oito
arquivos de implementação/teste e um retry. A allowlist é `dev/**`,
`test/dev/**` e docs; `package.json` só aceita script comprovadamente necessário.
Mudança em `dev/plan.yaml`, `src/**`, billing, profiles/model/effort,
`schema_version`, evidência runtime/histórica ou qualquer ambiguidade vira
`HUMAN_REQUIRED`. Maintenance/review não chama `launchTask` e não consome
attempt de produto.
Os profiles de maintenance/review são fixos, distintos e subscription-only; o
reviewer Codex tem o sandbox convertido para `read-only` antes do spawn. Estado,
attempts e launch evidence do checkout original e do clone são comparados antes
e depois de cada sessão — zero é resultado medido, não declaração do agente.

Cada incidente recebe eventos imutáveis em
`.dev/autonomy/incidents/<incident-id>/` e um record terminal append-only em
`.dev/autonomy/incidents/<incident-id>.json`. O record guarda decisões e
evidência objetiva, nunca raciocínio interno. Se a automação recusar ou esgotar
o budget, a saída inclui `status: HUMAN_REQUIRED`, `incident_id`, uma decisão
específica, o motivo, opções e paths de evidência — nunca apenas o blocker cru.

### Saída dos comandos

`dev-doctor` e `dev-orchestrate` imprimem por padrão só o que serve para
acompanhar uma implementação, e aceitam `--verbose` para o payload detalhado.

- `dev-doctor`: perfil efetivo (`agent`, `model`, `reasoning_effort`,
  `billing_mode`, `credential_source`), `warnings` e `failures`. Os ~20 checks
  que passaram só aparecem com `--verbose`; **check FAIL nunca depende dele**.
- `dev-orchestrate`: perfil no topo (único na invocação) e, por iteração,
  `task_id`, `attempt`, `attempt_kind` (`FIRST_PASS` | `REPAIR`), `result`,
  `reason`, `implementation_duration_ms`
  (= `LaunchRecord.duration_ms`, tempo do worker — sem probe, validação oficial
  nem fechamento), `api_equivalent_usd` (= `provider_estimated_api_equivalent_usd`,
  equivalência estimada, não cobrança) e `subscription_usage` reduzido a
  `current_used_pct` + `consumed_pp` por janela. Falha terminal do provider entra
  resumida **sem** `--verbose`. FIRST_PASS e o único REPAIR automático bounded
  contam em iterações e em `total_api_equivalent_usd` separados — o custo do
  repair não é escondido dentro do primeiro attempt.

`--verbose` ACRESCENTA: probe, hashes, rótulos de janela, `rate_limit_observations`
e identidade do processo voltam em chaves próprias, e nenhum campo do resumo muda
de significado. A escolha é de apresentação: `.dev/`, LaunchRecord, CompletionRecord,
evidência e billing são gravados iguais nos dois modos.

Exit codes: `dev-doctor` 3 = algum check FAIL · `dev-next` 4 = fluxo
parado/ocupado · `dev-close` 5 = FAIL, 6 = guarda pendente · `dev-launch` 7 = TIMED_OUT, 8 = INFRA_ERROR ·
`dev-orchestrate` / `dev-run-plan` 9 = término bloqueante/anormal (`LIMIT_REACHED` usa 0; mismatch de plan no `dev-run-plan` também) · **10 = harness ocupado** (qualquer
comando que muda estado). `dev-run-plan` ainda usa 1 para setup inválido (repo/plan/profile) antes de qualquer launch.

## Exclusão mútua

`.dev/orchestrator.lock` é criado com `wx` (criação exclusiva) por todo
comando que **muda estado**: `dev-init`, `dev-launch`, `dev-close`,
`dev-recover` (sem `--dry-run`), `dev-recover-infra`,
`dev-recover-protocol-output`, `dev-recover-incomplete-worker-output` e `dev-orchestrate` —
este último segura o lock pelo loop inteiro. `dev-run-plan` não tem lock próprio:
delega para `dev-init` / `dev-orchestrate`. `--dry-run` do `dev-run-plan` é
somente leitura e não pega lock. `dev-next` e `dev-recover --dry-run` são somente
leitura e não pegam lock.

Sem isso, dois orquestradores podiam ler `READY`, gerar packet e lançar dois
workers para a mesma tarefa: `state.json` com tmp + rename evita arquivo
parcial, não evita corrida. O lock cobre a transição `READY -> RUNNING`.

Lock cujo dono morreu (pid + `proc_start_ticks` não conferem) ou cujo arquivo
está ilegível é órfão: removido e reclamado uma vez. Quem perder essa corrida
encontra dono vivo e recebe exit 10.

**`dev-orchestrate` com um perfil real gasta dinheiro** — uma sessão de agente
por microtarefa. Rodar só com autorização explícita.
