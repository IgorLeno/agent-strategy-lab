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
- **INFRA_ERROR** — launcher falhou (exit 125/126/127, término por sinal), ou
  `RUNNING/EXECUTING` com processo inexistente.
- **Guarda operacional incompleta ≠ FAIL** — draft/report ausente, tree suja,
  commit não localizado ou fora do escopo deixam a tarefa em
  `RUNNING/FINALIZING` com diagnóstico. Retry é legítimo.

`FAIL`, `TIMED_OUT`, `MISSCOPED` e `INFRA_ERROR` **param o fluxo**.

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
- `claude-build-worker-v1` — **real-world**, não controlled: sem `--bare`,
  CLAUDE.md, hooks, plugins e auto-memory do usuário carregam. Para modo
  controlado, adicionar `--bare` e exportar `ANTHROPIC_API_KEY` (com `--bare`,
  OAuth e keychain nunca são lidos).
- `codex-build-worker-v1` — sem equivalente ao `--bare`; parcialmente não
  controlado por natureza.

Nunca compare resultados de perfis `controlled` com `real-world`.

## Comandos

```bash
pnpm dev-init                 # cria .dev/ a partir de dev/plan.yaml
pnpm dev-next                 # imprime o packet da próxima tarefa (não grava)
pnpm dev-launch --task M01    # um processo novo para uma tarefa
pnpm dev-close                # valida e fecha a tarefa RUNNING
pnpm dev-recover --dry-run    # relata reconciliações sem gravar
pnpm dev-orchestrate --profile claude-build-worker-v1
```

Exit codes: `dev-next` 4 = fluxo parado/ocupado · `dev-close` 5 = FAIL, 6 =
guarda pendente · `dev-launch` 7 = TIMED_OUT, 8 = INFRA_ERROR ·
`dev-orchestrate` 9 = fluxo parado · **10 = harness ocupado** (qualquer
comando que muda estado).

## Exclusão mútua

`.dev/orchestrator.lock` é criado com `wx` (criação exclusiva) por todo
comando que **muda estado**: `dev-init`, `dev-launch`, `dev-close`,
`dev-recover` (sem `--dry-run`) e `dev-orchestrate` — este último segura o
lock pelo loop inteiro. `dev-next` e `dev-recover --dry-run` são somente
leitura e não pegam lock.

Sem isso, dois orquestradores podiam ler `READY`, gerar packet e lançar dois
workers para a mesma tarefa: `state.json` com tmp + rename evita arquivo
parcial, não evita corrida. O lock cobre a transição `READY -> RUNNING`.

Lock cujo dono morreu (pid + `proc_start_ticks` não conferem) ou cujo arquivo
está ilegível é órfão: removido e reclamado uma vez. Quem perder essa corrida
encontra dono vivo e recebe exit 10.

**`dev-orchestrate` com um perfil real gasta dinheiro** — uma sessão de agente
por microtarefa. Rodar só com autorização explícita.
