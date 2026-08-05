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
`dev-orchestrate` 9 = fluxo parado.

**`dev-orchestrate` com um perfil real gasta dinheiro** — uma sessão de agente
por microtarefa. Rodar só com autorização explícita.
