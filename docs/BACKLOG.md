# Backlog — visão humana

Espelho de [`dev/plan.yaml`](../dev/plan.yaml), que é a **definição versionada e
autoritativa** das microtarefas. Este arquivo existe para leitura; ele **nunca é
operacional**. Divergiu? `dev/plan.yaml` vence.

O **status** de cada tarefa não é espelhado aqui de propósito: ele vive em
`.dev/state.json`, que é runtime e não é versionado. Consultar com
`pnpm dev-next` ou `pnpm dev-recover --dry-run`.

A fase S (S01A–S06) não aparece no plano nem aqui: é o bootstrap manual do
próprio harness, feito antes de ele existir. Ver [HARNESS.md](HARNESS.md).

**Validação.** Toda tarefa roda `pnpm typecheck` e `pnpm test`. Quase todas
rodam também um arquivo de teste alvo — anotado abaixo como *Teste*. M01 e M40B
rodam `pnpm build` no lugar do teste alvo.

---

## Marco 0 — Contratos

Antes de qualquer storage ou runner. Contrato errado descoberto em M20 custa a
reescrita de tudo entre M10 e M20.

### M01 — Scaffold do produto
**Depende de:** — · **Gate:** `pnpm build`

Criar o layout `src/<área>` do produto (core, schemas, envelope, storage,
workspace, runner, adapters, strategies, evaluator, scorer, reporting, project,
cli), garantir os scripts build/test/typecheck e escrever `docs/ARCHITECTURE.md`,
`docs/BACKLOG.md`, `docs/LESSONS.md` e `docs/adr/ADR-0001-stack.md` com o texto
corrigido do SQLite.

- Diretórios de `src/` criados com um `index.ts` ou módulo inicial cada.
- `docs/ARCHITECTURE.md` descreve o modelo de dados e o layout de evidência.
- `docs/adr/ADR-0001-stack.md` registra a escolha do `better-sqlite3` e o risco
  de addon nativo.
- `docs/BACKLOG.md` espelha `dev/plan.yaml` para leitura humana.
- `pnpm typecheck`, `pnpm build` e `pnpm test` verdes.

### M02 — Enums separados das 3 dimensões
**Depende de:** M01 · **Teste:** `test/core/enums.test.ts`

Definir em `src/core` os enums de execução (COMPLETED/TIMED_OUT/CRASHED/
CANCELLED/INFRA_ERROR), avaliação (PASS/FAIL/PARTIAL/NOT_EVALUATED) e
qualificação (QUALIFIED/UNSCORABLE/MISSCOPED/CONTAMINATED/INVALID_ENVIRONMENT/
HISTORICAL_ONLY), mais os tipos core e a hierarquia de erros. Nenhum enum único
combinando dimensões.

- As três dimensões são tipos independentes; nenhum valor aparece em dois enums.
- Erros do lab têm classe base própria com código estável.
- Testes de parse cobrem valores válidos e inválidos de cada dimensão.

### M03 — TaskSpec mínimo (público, com budgets)
**Depende de:** M02 · **Teste:** `test/schemas/task-spec.test.ts`

Schema zod do TaskSpec público: id, descrição, critérios visíveis, classe,
dificuldade, stack, graders públicos e budgets (expected/maximum de duração,
tokens e arquivos alterados). É o material que **pode** ir ao workspace do
agente.

- TaskSpec valida entrada correta e rejeita budgets incoerentes
  (expected > maximum).
- Nenhum campo de grader oculto ou rubrica no TaskSpec.
- Testes de parse válido/inválido.

### M03B — EvaluationPlan mínimo (privado)
**Depende de:** M03 · **Teste:** `test/schemas/evaluation-plan.test.ts`

Schema zod do EvaluationPlan privado: graders ocultos, rubrica, pesos. Vive só
no lab; entra apenas no evaluation envelope e **nunca** no envelope de execução
nem no workspace do agente.

- EvaluationPlan é um tipo separado de TaskSpec, sem herança nem reuso que vaze
  campos ocultos.
- Teste garante que serializar um TaskSpec nunca inclui campos de
  EvaluationPlan.
- Testes de parse válido/inválido.

### M04 — AgentProfile e EnvironmentProfile
**Depende de:** M03B · **Teste:** `test/schemas/profiles.test.ts`

Schemas do AgentProfile (CLI, versão, modelo, flags) e do EnvironmentProfile
(modo `controlled` | `real-world`, allowlist de env, fingerprint dos instruction
files, plugins/skills/MCPs registrados). Resultados de modos diferentes nunca se
misturam.

- EnvironmentProfile exige allowlist explícita e HOME sanitizado no modo
  `controlled`.
- Modo `real-world` registra o que **não** foi controlado, em vez de omitir.
- Testes de parse válido/inválido.

### M05 — StrategyDef e receita direct@1
**Depende de:** M04 · **Teste:** `test/schemas/strategy.test.ts`

Schema StrategyDef para receitas declarativas versionadas em
`strategies/<nome>/<versão>/strategy.yaml`, mais a receita `direct@1` (prompt
único, sem etapas intermediárias).

- StrategyDef carrega `strategies/direct/1/strategy.yaml` e valida.
- Nome e versão da estratégia são materiais para o envelope de execução.
- Testes de parse válido/inválido.

### M06 — Trial e ExecutionRequest
**Depende de:** M05 · **Teste:** `test/schemas/trial.test.ts`

Trial = tentativa planejada (Agent + Model + Strategy + EnvironmentProfile +
status do trial: PLANNED/EXECUTED/CANCELLED/REPEATED). ExecutionRequest = tudo
que o runner precisa para materializar um run a partir de um Trial.

- Trial separa falha de infra (trial repetido) de falha do agente (run FAIL).
- ExecutionRequest referencia trial, base SHA, budgets e timeout.
- Testes de parse válido/inválido.

### M07 — ExecutionRecord
**Depende de:** M06 · **Teste:** `test/schemas/execution-record.test.ts`

Schema do ExecutionRecord: status de execução (enum da dimensão de execução),
exit code, duração, `execution_envelope_sha256`, métricas com provenance **por
campo** (campo ausente = null + origem registrada).

- Métrica ausente é null com origem registrada, nunca zero silencioso.
- Status de execução aceita apenas valores da dimensão de execução.
- Testes de parse válido/inválido.

### M08 — EvaluationRecord
**Depende de:** M07 · **Teste:** `test/schemas/evaluation-record.test.ts`

Schema do EvaluationRecord: `evaluation_id`, outcome da dimensão de avaliação,
resultado por grader, versões dos graders e `evaluation_envelope_sha256`.

- Um run pode ter N EvaluationRecords; cada um com id e envelope próprios.
- Grader obrigatório falho força outcome FAIL.
- Testes de parse válido/inválido.

### M09 — ScoreRecord e QualificationRecord
**Depende de:** M08 · **Teste:** `test/schemas/score-record.test.ts`

Schemas do ScoreRecord (`score_profile_id` + versão, sub-scores, budgets usados,
coverage) e do QualificationRecord (status da dimensão de qualificação +
justificativa). Métrica ausente obrigatória resulta em UNSCORABLE; opcional
resulta em sub-score null e coverage reduzida, **sem redistribuir peso**.

- Peso de sub-score ausente nunca é redistribuído; coverage cai.
- QualificationRecord exige justificativa quando o status não é QUALIFIED.
- Testes de parse válido/inválido cobrindo as duas regras.

### M10 — Envelope hashes (execução e avaliação separados)
**Depende de:** M09 · **Teste:** `test/envelope/envelope.test.ts`

`src/envelope/` com `execution_envelope_sha256` (TaskSpec + Strategy + prompt
compilado + base SHA + AgentProfile + EnvironmentProfile + modelo + flags CLI +
adapter/versão + budgets + timeout) e `evaluation_envelope_sha256` (digest do
execution manifest + EvaluationPlan + versões dos graders + ambiente do
evaluator + comandos de avaliação), via serialização canônica.

- Mesma configuração produz o mesmo `execution_envelope_sha256`.
- Mudar uma flag CLI muda o envelope de execução.
- Mudar hidden grader muda **só** o `evaluation_envelope_sha256`.
- Ordem de chaves na entrada não afeta o hash.

---

## Evidência

### M11 — Run directory create e metadata inicial
**Depende de:** M10 · **Teste:** `test/storage/run-dir.test.ts`

`src/storage/`: criar `data/runs/<run-id>/` com `execution/`, metadata inicial e
run-id ULID. Data dir default `<lab>/data/`, sobrescrevível por
`AGENTLAB_DATA_DIR` ou config.

- Run dir criado com estrutura esperada e run-id ULID ordenável.
- `AGENTLAB_DATA_DIR` sobrescreve o default.
- Criar duas vezes o mesmo run-id falha em vez de sobrescrever.

### M12 — JSONL append seguro
**Depende de:** M11 · **Teste:** `test/storage/jsonl.test.ts`

Append de eventos em JSONL sem corromper linhas: uma linha por evento, escrita
completa, newline garantida, sem interleaving parcial.

- Appends concorrentes produzem linhas íntegras e parseáveis.
- Objeto com newline embutida não quebra o formato.
- Arquivo termina sempre com newline.

### M13 — Primitives de manifest e ledger
**Depende de:** M12 · **Teste:** `test/storage/manifest.test.ts`

Manifest de hashes por seção (sha256 por artifact + digest agregado) e append no
`ledger.jsonl` da raiz do run. Cada seção (`execution`, `evaluations/<id>`,
`scores/<id>`) tem manifest próprio e independente.

- Manifest lista cada artifact com caminho relativo, tamanho e sha256.
- Digest agregado é determinístico e independente da ordem de leitura do
  diretório.
- Ledger registra cada adição sem reescrever entradas anteriores.

### M14 — Finalização da execução (selar `execution/`)
**Depende de:** M13 · **Teste:** `test/storage/finalize.test.ts`

Selar `execution/` exatamente uma vez com manifest próprio e entrada no ledger;
`evaluations/` e `scores/` passam a ser adições posteriores. Nenhum manifest raiz
sobrescrito.

- Selar duas vezes a mesma execução falha explicitamente.
- Após selar, adicionar evaluation cria entrada nova no ledger sem tocar em
  `execution/manifest.json`.
- Ledger é logicamente append-only.

### M15 — Integrity verification
**Depende de:** M14 · **Teste:** `test/storage/integrity.test.ts`

Verificação de integridade que detecta alteração de conteúdo (inclusive valor
válido em schema), remoção de artifact, reordenação de linhas de JSONL e
adulteração do ledger.

- Alterar um valor válido em schema é detectado pelo manifest.
- Remover um artifact listado é detectado.
- Reordenar linhas de `events.jsonl` é detectado.
- Editar uma entrada antiga do ledger é detectado.

### M16 — Redaction de strings
**Depende de:** M15 · **Teste:** `test/storage/redaction.test.ts`

Redaction de secrets em strings antes de qualquer persistência — tokens de
provider, chaves de API, bearer tokens, padrões de env sensível. Aplicada a
stdout, stderr e stream do provider.

- Tokens falsos de formato conhecido são substituídos por placeholder estável.
- Redaction preserva o restante da linha (a linha sanitizada continua útil).
- Nenhum secret sobrevive em round-trip de escrita e leitura.

### M17 — Redaction estruturada e de environment
**Depende de:** M16 · **Teste:** `test/storage/redaction-structured.test.ts`

Redaction recursiva em objetos e em mapas de variáveis de ambiente, preservando
forma e chaves, redigindo apenas valores sensíveis.

- Objetos aninhados são redigidos sem perder estrutura.
- Env vars fora da allowlist do EnvironmentProfile são redigidas ou omitidas de
  forma registrada.
- Chaves sensíveis por nome são redigidas mesmo com valor de formato
  desconhecido.

---

## Execução

### M18 — Disposable clone create a partir de base SHA
**Depende de:** M17 · **Teste:** `test/workspace/clone.test.ts`

`src/workspace/`: clone descartável **independente** do repo-alvo no base SHA.
Não usar linked worktree — worktree compartilha objects, refs e config com o
repo do usuário e o agente pode alcançá-los.

- O clone tem objects próprios; nenhum `alternates` apontando para o repo-alvo.
- O clone está exatamente no base SHA pedido.
- Nenhum remote com credencial é herdado.

### M19 — Clone cleanup garantido e proteção do repo-alvo
**Depende de:** M18 · **Teste:** `test/workspace/cleanup.test.ts`

Descarte do clone efêmero ao fim do run, inclusive em caminho de erro, e guarda
que impede qualquer escrita no repo-alvo original.

- Clone é removido mesmo quando o run falha.
- Tentativa de operar no repo-alvo original é rejeitada por guarda explícita.
- Cleanup não confirmado é reportado como erro, não silenciado.

### M20 — Git state e change bundle capture
**Depende de:** M19 · **Teste:** `test/workspace/change-bundle.test.ts`

Capturar o resultado do agente como change bundle — `changes.patch`,
`changes-manifest.json` (arquivos, hashes) e `material_tree_sha256`.

- `changes.patch` reaplica sobre o base SHA e reproduz a árvore do agente.
- `material_tree_sha256` é estável para a mesma árvore.
- Arquivos novos, removidos e renomeados aparecem no manifest.

### M21 — Basic process runner
**Depende de:** M20 · **Teste:** `test/runner/spawn.test.ts`

`src/runner/`: spawn de processo com argv (sem shell), coleta de exit code e
sinal.

- Exit code de sucesso e de falha são reportados corretamente.
- Comando inexistente vira erro de infra, não exit code inventado.
- Nenhuma interpolação de shell em nenhum caminho.

### M22 — Captura incremental de stdout e stderr
**Depende de:** M21 · **Teste:** `test/runner/capture.test.ts`

Captura incremental para `stdout.log` e `stderr.log`, com redaction aplicada
antes de persistir, sem bufferizar o processo inteiro em memória.

- Saída volumosa é persistida incrementalmente, sem estourar memória.
- Linha parcial no fim do stream é tratada sem perder bytes.
- Redaction acontece antes da escrita em disco.

### M23 — Timeout com SIGTERM e escalada SIGKILL
**Depende de:** M22 · **Teste:** `test/runner/timeout.test.ts`

Timeout externo — SIGTERM, período de graça, SIGKILL. Processo que ignora
SIGTERM ainda assim é encerrado.

- Processo que ignora SIGTERM é morto por SIGKILL após a graça.
- Execução que estoura o limite é marcada TIMED_OUT (dimensão de execução).
- Evidência parcial é preservada.

### M24A — Process-group: spawn em grupo próprio e sinais no grupo
**Depende de:** M23 · **Teste:** `test/runner/process-group.test.ts`

Spawn em process group próprio (`setsid`) e envio de sinais ao **grupo** —
SIGTERM, graça, SIGKILL. `execa` sozinho não mata a árvore.

- Descendente do processo alvo recebe o sinal.
- Sinal nunca escapa para fora do grupo criado.
- PGID é registrado na evidência do run.

### M24B — Verificação de sobreviventes pós-kill
**Depende de:** M24A · **Teste:** `test/runner/survivors.test.ts`

Após o kill do grupo, verificar sobreviventes. Cleanup não confirmado resulta em
INFRA_ERROR, nunca em COMPLETED silencioso.

- Descendente que sobrevive ao pai é detectado.
- Cleanup não confirmável marca o run como INFRA_ERROR.
- A verificação não depende de sleep fixo arbitrário para dar veredito.

### M25 — Fake adapter success
**Depende de:** M24B · **Teste:** `test/adapters/fake-success.test.ts`

`fixtures/fake-agent/` falando a **interface interna** do lab (não formato de
provider) e `src/adapters/fake/` consumindo-a — variante success.

- Um run fake completo produz ExecutionRecord COMPLETED.
- O fake agent não depende de nenhum formato de provider real.
- Eventos normalizados são emitidos pela interface interna.

### M26 — Fake adapter failure, timeout, malformed-stream, child-process-leak
**Depende de:** M25 · **Teste:** `test/adapters/fake-variants.test.ts`

Variantes restantes do fake agent, cada uma normalizada para o estado correto da
dimensão de execução. `malformed-stream` não pode ser fatal — linha bruta
sanitizada preservada, evento desconhecido armazenado.

- `failure` produz COMPLETED com resultado de falha, não CRASHED.
- `timeout` produz TIMED_OUT.
- `malformed-stream` não derruba o run; a linha sanitizada é preservada.
- `child-process-leak` deixa descendente detectável pela verificação do M24B.

---

## Avaliação e score

### M27A — Evaluator workspace separado
**Depende de:** M26 · **Teste:** `test/evaluator/workspace.test.ts`

Workspace do evaluator — novo clone do mesmo base SHA, apply do `changes.patch`
e injeção do EvaluationPlan **só ali**. Registra os componentes do evaluation
envelope; descarta o workspace ao fim.

- EvaluationPlan nunca aparece no workspace do agente.
- Patch aplica sobre o base SHA e reproduz a árvore avaliada.
- Workspace do evaluator é descartado inclusive em erro.

### M27B — Command grader
**Depende de:** M27A · **Teste:** `test/evaluator/command-grader.test.ts`

Grader que executa um comando (argv, sem shell) no workspace do evaluator e
converte exit code e saída em resultado de grader, com timeout próprio.

- Exit code 0 vira grader PASS; não-zero vira FAIL.
- Timeout do grader é distinto de falha do grader.
- Saída do grader é persistida em `grader-artifacts` com redaction.

### M28 — Evaluator com um grader
**Depende de:** M27B · **Teste:** `test/evaluator/evaluate.test.ts`

Orquestração da avaliação — roda os graders do EvaluationPlan, calcula o outcome
(grader obrigatório falho resulta em FAIL) e produz EvaluationRecord com
`evaluation_envelope_sha256` e manifest próprio.

- Grader obrigatório falho força outcome FAIL.
- Grader opcional falho permite PARTIAL, registrado.
- Reavaliar cria `evaluations/<novo-id>/` sem tocar na anterior.

### M29 — Score profile v1
**Depende de:** M28 · **Teste:** `test/scorer/score-profile.test.ts`

Perfil de score versionado v1 — sub-scores de tempo, tokens e escopo relativos
aos budgets do TaskSpec, teto por outcome. Score é de um run individual;
estatística agregada **não** entra aqui (fica no compare, fase C).

- Sub-scores usam budgets expected/maximum, não constantes mágicas.
- Outcome FAIL impõe teto de score.
- Métrica obrigatória ausente resulta em UNSCORABLE; opcional ausente resulta em
  sub-score null sem redistribuir peso.
- Nenhuma variância ou intervalo de confiança é calculado aqui.

### M30 — SQLite run index
**Depende de:** M29 · **Teste:** `test/storage/sqlite-index.test.ts`

Índice SQLite (`better-sqlite3`) com tabelas de runs, trials e tasks — insert e
query. O índice é derivado e descartável; a evidência em disco é a fonte de
verdade. Ver [ADR-0001](adr/ADR-0001-stack.md).

- Insert e query de run, trial e task funcionam.
- Schema do índice tem versão própria.
- Nenhum dado existe apenas no índice.

### M31 — SQLite rebuild a partir dos artifacts
**Depende de:** M30 · **Teste:** `test/storage/sqlite-rebuild.test.ts`

Reconstrução completa do índice varrendo `data/runs/` — apagar o db e
reconstruir dá paridade.

- Apagar o db e reconstruir produz o mesmo conteúdo lógico.
- Run com integridade quebrada é reportado no rebuild, não ignorado.
- Rebuild é idempotente.

---

## CLI e vertical slice

### M32 — `agentlab doctor`
**Depende de:** M31 · **Teste:** `test/cli/doctor.test.ts`

CLI base com `commander` e o comando `doctor` — verifica versões de node, git,
CLIs de agente disponíveis, data dir gravável e integridade básica.

- `doctor` reporta cada checagem com status próprio.
- Ausência de CLI de agente é aviso, não crash.
- Exit code reflete a existência de problemas bloqueantes.

### M33 — `agentlab init --repo`
**Depende de:** M32 · **Teste:** `test/cli/init.test.ts`

Comando `init` que cria **somente** `.agentlab/project.yaml` no repo-alvo —
arquivo fino, sem tocar em nada mais do projeto.

- Apenas `.agentlab/project.yaml` é criado no repo-alvo.
- Rodar duas vezes não sobrescreve config existente sem flag explícita.
- Smoke em repo git temporário.

### M34 — `agentlab task create` (não interativo)
**Depende de:** M33 · **Teste:** `test/cli/task-create.test.ts`

Criação não interativa de Task — TaskSpec público e EvaluationPlan privado em
arquivos separados, nunca no mesmo arquivo.

- TaskSpec e EvaluationPlan são gravados em caminhos separados.
- Entrada inválida falha com mensagem acionável, sem criar arquivo parcial.
- Nenhum prompt interativo.

### M35A — `agentlab run`: preparação
**Depende de:** M34 · **Teste:** `test/cli/run-prepare.test.ts`

Preparação do run — ExecutionRequest a partir do trial, clone descartável, run
dir e `execution_envelope_sha256`, tudo em disco **sem** executar o agente.

- Preparação materializa clone, run dir e envelope sem spawn do agente.
- Falha de preparação limpa o que criou.
- Envelope gravado bate com o recalculado a partir dos componentes.

### M35B — `agentlab run`: execução
**Depende de:** M35A · **Teste:** `test/cli/run-execute.test.ts`

Execução via fake adapter no runner — captura, change bundle e finalização
(selagem) de `execution/`.

- Run fake completo grava `execution/` selado com todos os artifacts.
- `provider-sanitized.jsonl` existe e passou por redaction.
- `changes/` contém patch e manifest coerentes.

### M35C — `agentlab run`: indexação e cleanup
**Depende de:** M35B · **Teste:** `test/cli/run-index.test.ts`

Indexar o run no SQLite e descartar o clone efêmero, inclusive em caminho de
erro.

- Linha correspondente aparece no índice.
- Clone é removido ao fim.
- Falha na indexação não deixa clone órfão.

### M36 — `agentlab evaluate`
**Depende de:** M35C · **Teste:** `test/cli/evaluate.test.ts`

Comando `evaluate` sobre um run existente, produzindo `evaluations/<id>/` com
manifest próprio e entrada no ledger.

- EvaluationRecord criado para o run do M35.
- Rodar de novo cria segundo diretório, sem sobrescrever o primeiro.
- Ledger ganha uma entrada por avaliação.

### M37 — `agentlab score`
**Depende de:** M36 · **Teste:** `test/cli/score.test.ts`

Comando `score` sobre uma avaliação existente, produzindo `scores/<score-id>/`
com manifest próprio e entrada no ledger.

- ScoreRecord criado a partir de um EvaluationRecord específico.
- Perfil de score diferente cria diretório novo, sem sobrescrever.
- QualificationRecord acompanha o score.

### M38 — `agentlab report`
**Depende de:** M37 · **Teste:** `test/cli/report.test.ts`

Relatório de run em terminal e em `--json`, mostrando as três dimensões
separadamente.

- Saída de terminal mostra execução, avaliação e qualificação separadas.
- `--json` produz saída estável e parseável.
- Métrica ausente aparece como null com origem, nunca como zero.

### M39A — E2E vertical slice: caminho feliz
**Depende de:** M38 · **Teste:** `test/e2e/happy-path.test.ts`

Teste ponta a ponta — init, task, trial, clone, fake agent, captura, evaluate em
workspace separado, score, SQLite e report.

- Slice completo verde em fixture repo.
- Layout de evidência conferido — `execution/` com `provider-sanitized.jsonl` e
  `changes/`, `evaluations/`, `scores/`, `ledger.jsonl`.
- EvaluationPlan ausente do workspace do agente, verificado por busca no
  snapshot.

### M39B — E2E: caminhos de falha
**Depende de:** M39A · **Teste:** `test/e2e/failure-paths.test.ts`

Ponta a ponta dos caminhos de falha — timeout (TIMED_OUT), fake failure e
child-process-leak.

- Timeout resulta em execution TIMED_OUT com evidência parcial preservada.
- Fake failure resulta em COMPLETED com avaliação FAIL.
- `child-process-leak` não deixa sobreviventes; cleanup não confirmado resulta
  em INFRA_ERROR.

### M40A — Hardening do Marco 1
**Depende de:** M39B · **Teste:** `test/e2e/hardening.test.ts`

Revisitar integridade, redaction e rebuild com os caminhos reais do slice —
adulteração detectada, zero vazamento de secrets em `data/`, paridade após
rebuild, envelopes estáveis.

- Adulterar artifact do slice real é detectado.
- Busca por secrets falsos em `data/` após run contaminado retorna zero
  ocorrências.
- Dois runs com mesma config produzem o mesmo `execution_envelope_sha256`;
  mudar hidden grader muda só o de avaliação.

### M40B — Revisão do Marco 1
**Depende de:** M40A · **Gate:** `pnpm build`

Fechar o Marco 1 — `docs/LESSONS.md` atualizado, `docs/BACKLOG.md` espelhando o
estado real, `docs/ARCHITECTURE.md` conferido contra o código e commit de marco.
**Parada obrigatória para revisão do usuário depois desta tarefa.**

- LESSONS.md contém as correções acumuladas no formato datado.
- BACKLOG.md reflete o estado real de M01 a M40A.
- ARCHITECTURE.md descreve o que existe, não o que se pretendia.
- Gates completos verdes.
