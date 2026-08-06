# S15 — primeiro teste empírico do protocolo com agente real

Data: 2026-08-06 · Perfil: `claude-build-worker-v2` · Modelo fixado:
`claude-opus-5` · Repositório: fixture descartável, fora deste repo.

Duas microtarefas triviais e encadeadas: **T1** cria `src/greet.mjs` +
`test/greet.test.mjs`; **T2** cria `src/farewell.mjs` + teste no mesmo estilo,
recebendo apenas o handoff selado da T1. Validação de cada uma: `node --test`.

## Resultado

```
run 1: PARADO em T1  — dev-close PENDING, report fora do schema
run 2: ALL_DONE      — T1 PASS, T2 PASS, exit 0
```

O run 1 não foi desperdício: ele produziu o achado que motivou as correções
listadas abaixo. O run 2 é o resultado válido do experimento.

## Critérios (run 2)

| Critério | Evidência |
| --- | --- |
| Dois PIDs distintos | 3652985 · 3663290 |
| Dois processos novos | `command_sha256` distintos; `fresh_process: true` nos dois LaunchRecords |
| Dois commits | `1a3780c` (T1) · `2145561` (T2), um por tarefa, sobre a base declarada |
| Nenhum transcript ou session ID reaproveitado | nenhuma flag de continuidade no argv; `session_id` distinto por sessão (`be11120e…`, `c5c49d46…`); `--no-session-persistence` |
| Primeiro encerrado antes do segundo | T1 `finished_at` 02:21:31.986Z < T2 `started_at` 02:21:33.493Z |
| Handoff pequeno | 1202 B (T1) e 1527 B (T2), budget 4096 B |
| Handoff é o único contexto herdado | `previous_handoff.accepted_commit` do packet T2 = `accepted_commit` selado da T1 |
| `HEAD` = último accepted commit | `2145561…` nos dois |
| Árvore limpa no fim | `git status --porcelain` vazio |
| Nenhum descendente sobrevivente | `survivors_killed` e `survivors_remaining` vazios nas duas sessões |
| Relato bate com evidência | `discrepancies: []` nos dois; revalidação do orquestrador exit 0 |
| Custo e modelo registrados | T1 US$ 0,5320 / 21 turnos / 127 s · T2 US$ 0,3785 / 16 turnos / 71 s · **total US$ 0,9105** (mais US$ 0,7133 do run 1) |

Modelos efetivamente usados por sessão: `claude-opus-5` (principal) e
`claude-haiku-4-5` (chamadas auxiliares da própria CLI).

## O que o run 1 quebrou, e por quê

**1. O contrato do report era prosa; o agente inventou a estrutura.**
O prompt descrevia os campos em texto corrido. O worker escreveu um JSON
plausível e errado: campos inventados (`base_sha`, `acceptance`,
`environment`, `notes`), ausência de `decisions`/`lessons`/`relevant_files`,
`validations` com outro formato e `candidate_commit` abreviado (`2e5d980`).
O schema é estrito, então o fechamento ficou `PENDING` — com o trabalho
commitado e correto.
→ O prompt passou a carregar o **esqueleto JSON exato** dos dois arquivos.

**2. O motivo do rejeito não dizia nada.**
`"AgentCompletionReport ausente ou inválido"` não permite corrigir — e a
sessão que escreveu o arquivo já morreu.
→ O `dev-close` agora nomeia campo e problema (`candidate_commit: esperado
SHA-1 de commit em hex minúsculo`).

**3. Comando composto é negado pela política.**
`node --test test/ 2>&1; echo "EXIT=$?"` foi negado: a allow list precisa
cobrir **toda** parte do comando, e `echo` não estava lá.
→ Utilitários de leitura entraram na política e o prompt manda usar um
comando por chamada.

**4. `node --test test/` não era um comando de validação válido** neste
ambiente (Node 22.22.2 trata o diretório como arquivo de entrada). Erro do
fixture, não do harness — o worker diagnosticou certo e reportou `FAILURE`.

No run 2 restaram 3 negações de permissão, todas contornadas pelo próprio
agente: `git -C <path> …` (a regra é `Bash(git status:*)`, sem `-C`) e
`git commit -m "$(printf …)"` (substituição de comando). Alargar a regra para
`Bash(git -C:*)` liberaria qualquer subcomando git, inclusive `push` — não
vale a troca.

## Limites deste resultado

- Perfil **real-world**, não controlled: sem `--bare`, `CLAUDE.md`, hooks e
  plugins do projeto ainda carregam. `--setting-sources project` exclui os
  settings pessoais (`user`, `local`), e a política de permissões é a
  versionada — mas não misture estes números com um run controlled.
- Duas tarefas triviais num fixture limpo. Nada aqui prova comportamento em
  tarefa longa, plano grande ou repositório com histórico.
- Custo medido é de tarefas mínimas; não extrapole para o plano M01–M24.
