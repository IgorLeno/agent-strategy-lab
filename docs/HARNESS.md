# Harness de sessões descartáveis (Fase S)

Uma microtarefa = uma sessão nova = um processo novo. O worker que concluiu
uma tarefa nunca inicia a seguinte. A limpeza de contexto é garantida por
**encerramento real do processo**, não por instrução no prompt.

Este harness constrói o `agentlab`; ele **não** é o runner do produto. Runner
de verdade é M21–M24, dentro de `src/runner/`.

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

## Ciclo

```
dev-next       (somente leitura) seleciona a próxima READY e imprime o packet
                                 -> o orquestrador é quem persiste
dev-launch     processo NOVO (detached + timeout), só o task packet
                                 -> RUNNING / EXECUTING
   worker      valida SÓ a tarefa atual, cria EXATAMENTE UM candidate commit,
               escreve AgentCompletionReport + HandoffDraft, ENCERRA
                                 -> RUNNING / FINALIZING
dev-close      confirma commit e escopo, re-executa as validações do packet,
               deriva orchestrator_evidence, promove candidate -> accepted,
               grava CompletionRecord e sela o HandoffRecord
                                 -> PASS
dev-orchestrate  roda o loop acima; o worker nunca roda o loop
dev-recover      reconcilia plano + commits + completions + runtime
```

## Estados

`READY | RUNNING | PASS | FAIL | TIMED_OUT | MISSCOPED | INFRA_ERROR`, com
`phase: EXECUTING | FINALIZING` apenas dentro de `RUNNING`.

- **FAIL** — worker concluiu explicitamente com falha, OU validação obrigatória
  re-executada pelo orquestrador falhou.
- **TIMED_OUT** — timeout externo encerrou o process group. Não avança.
  `MISSCOPED` é reclassificação humana posterior, nunca decisão do timeout.
- **INFRA_ERROR** — launcher falhou (exit 125/126/127, término por sinal),
  `RUNNING/EXECUTING` com processo inexistente, ou o `result` do provider
  declarou término por falha (ver abaixo).
- **Guarda operacional incompleta ≠ FAIL** — draft/report ausente, tree suja,
  commit não localizado ou fora do escopo deixam a tarefa em
  `RUNNING/FINALIZING` com diagnóstico. Retry é legítimo.

`FAIL`, `TIMED_OUT`, `MISSCOPED` e `INFRA_ERROR` **param o fluxo**.

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

`dev-orchestrate` também para em `LIMIT_REACHED` (exit 9) quando esgota
`--max-iterations` com tarefa ainda pendente — sair com 0 e `ALL_DONE` ali
esconderia trabalho que ninguém fez.

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

- `TaskPacket` ≤ **12 KiB** UTF-8 — impede critérios e restrições de inflarem
  o prompt de volta.
- `HandoffRecord` / `HandoffDraft` ≤ **4 KiB** UTF-8.
- Preâmbulo do prompt ≤ 4 KiB.

Medidos em bytes sobre JSON canônico: schema válido acima do budget continua
sendo rejeição.

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

Perfis de experimento (mesmas garantias do baseline; só modelo e effort mudam):
`codex-build-worker-subscription-{high,sol-medium,terra-high,terra-medium,luna-medium}-v2`
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
pnpm dev-orchestrate --profile claude-build-worker-subscription-v1
```

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

LaunchRecord gravado ANTES do campo `provider_failure` não é reescrito à mão —
isso seria fabricar evidência. A falha é DERIVADA do stdout preservado do
próprio attempt, e só quando o transporte está íntegro (argv declarando
stream-json, exatamente um `result`, nenhuma linha inválida). A origem fica
registrada em `provider_failure_source`: classificação feita depois do fato
não se passa pela do lançamento.

### Saída dos comandos

`dev-doctor` e `dev-orchestrate` imprimem por padrão só o que serve para
acompanhar uma implementação, e aceitam `--verbose` para o payload detalhado.

- `dev-doctor`: perfil efetivo (`agent`, `model`, `reasoning_effort`,
  `billing_mode`, `credential_source`), `warnings` e `failures`. Os ~20 checks
  que passaram só aparecem com `--verbose`; **check FAIL nunca depende dele**.
- `dev-orchestrate`: perfil no topo (único na invocação) e, por iteração,
  `task_id`, `attempt`, `result`, `reason`, `implementation_duration_ms`
  (= `LaunchRecord.duration_ms`, tempo do worker — sem probe, validação oficial
  nem fechamento), `api_equivalent_usd` (= `provider_estimated_api_equivalent_usd`,
  equivalência estimada, não cobrança) e `subscription_usage` reduzido a
  `current_used_pct` + `consumed_pp` por janela. Falha terminal do provider entra
  resumida **sem** `--verbose`.

`--verbose` ACRESCENTA: probe, hashes, rótulos de janela, `rate_limit_observations`
e identidade do processo voltam em chaves próprias, e nenhum campo do resumo muda
de significado. A escolha é de apresentação: `.dev/`, LaunchRecord, CompletionRecord,
evidência e billing são gravados iguais nos dois modos.

Exit codes: `dev-doctor` 3 = algum check FAIL · `dev-next` 4 = fluxo
parado/ocupado · `dev-close` 5 = FAIL, 6 = guarda pendente · `dev-launch` 7 = TIMED_OUT, 8 = INFRA_ERROR ·
`dev-orchestrate` 9 = fluxo parado · **10 = harness ocupado** (qualquer
comando que muda estado).

## Exclusão mútua

`.dev/orchestrator.lock` é criado com `wx` (criação exclusiva) por todo
comando que **muda estado**: `dev-init`, `dev-launch`, `dev-close`,
`dev-recover` (sem `--dry-run`), `dev-recover-infra` e `dev-orchestrate` —
este último segura o lock pelo loop inteiro. `dev-next` e `dev-recover --dry-run` são somente
leitura e não pegam lock.

Sem isso, dois orquestradores podiam ler `READY`, gerar packet e lançar dois
workers para a mesma tarefa: `state.json` com tmp + rename evita arquivo
parcial, não evita corrida. O lock cobre a transição `READY -> RUNNING`.

Lock cujo dono morreu (pid + `proc_start_ticks` não conferem) ou cujo arquivo
está ilegível é órfão: removido e reclamado uma vez. Quem perder essa corrida
encontra dono vivo e recebe exit 10.

**`dev-orchestrate` com um perfil real gasta dinheiro** — uma sessão de agente
por microtarefa. Rodar só com autorização explícita.
