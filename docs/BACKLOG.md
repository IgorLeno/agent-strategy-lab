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

---

## PRE-M2 — Charter, performance histórica e extensibilidade

Preparação documental e de contratos antes do Marco 2 (avaliação de
performance de agentes e extensões). M53 em diante só entra em
`dev/plan.yaml` após aprovação humana explícita na revisão de M52.

### M41 — ADR-0002 e LAB_CHARTER
**Depende de:** M40B · **Gate:** `pnpm test`

`docs/adr/ADR-0002-evidence-kernel.md` ("AgentLab as Evidence Kernel and
Development Control Plane") e `docs/LAB_CHARTER.md`. Formaliza o baseline
histórico do M1, a missão, o STABLE KERNEL com os 4 critérios de inclusão,
experiment plane vs control plane, execution contract com agentes
substituíveis, extensions com incubação DISCOVERED→CANDIDATE→SANDBOXED→
BENCHMARKED→PROMOTED, modo EXPERIMENTAL vs OPERATIONAL, autoridades
(humano = produto/design; lab = processo/evidência) e non-goals. Nenhum
arquivo de `src/` é alterado.

- ADR-0002 registra o baseline sha do M1 e os 4 critérios de inclusão no
  kernel.
- LAB_CHARTER.md cobre missão, autoridades, dois modos, incubation
  lifecycle e non-goals em seções nomeadas.
- Nenhuma alteração em `src/` ou `test/`.

### M42 — Mapa kernel/planos e freeze do harness
**Depende de:** M41 · **Gate:** `pnpm test`

`docs/ARCHITECTURE.md` ganha uma tabela mapeando cada área de `src/` para
STABLE KERNEL, EXPERIMENT PLANE, CONTROL PLANE, EXECUTION CONTRACT ou
EXTENSIONS, e registra duas divergências documentais: o índice usa
`node:sqlite` (DatabaseSync), não `better-sqlite3` (ADR-0001, decisão D1);
e `src/reporting/` é placeholder — o relatório de run vive em
`src/cli/report.ts`. `docs/HARNESS.md` ganha a política de freeze: manutenção
em `dev/` só por defeito reproduzível, risco à validade experimental,
perda/corrupção de evidência ou incapacidade objetiva de executar o plano.

- Tabela área→camada cobre todas as áreas de `src/`.
- Texto do driver SQLite corrigido para `node:sqlite` com referência ao
  ADR-0001.
- HARNESS.md contém a seção de freeze com as 4 condições.

### M43 — Métrica genérica com provenance e ExecutionMetrics estendida
**Depende de:** M42 · **Teste:** `test/schemas/execution-record.test.ts`

`src/schemas/execution-record.ts`: métrica-com-provenance generalizada para
números não negativos com decimais (USD), e `ExecutionMetrics` estendida com
campos opcionais `input_tokens`, `cached_input_tokens`, `output_tokens`,
`reasoning_tokens` (inteiros) e `api_equivalent_usd` (decimal), cada um
`{ value, provenance }`. `fresh_input_tokens` não é armazenado — é derivado
na camada de performance. Ausência de medição é sempre null com provenance.

- ExecutionRecord antigo (sem os campos novos) parseia sem mudança.
- Campos novos aceitam null com provenance e rejeitam número sem provenance
  ou negativo.
- `api_equivalent_usd` aceita decimal; campos de token rejeitam não inteiro.

### M44 — Schema QuotaUsage provider-neutro do produto
**Depende de:** M43 · **Teste:** `test/schemas/quota-usage.test.ts`

`src/schemas/quota-usage.ts` (produto, nunca importa de `dev/lib`):
`QuotaWindow` com `window_id` definido pelo provider, `before_used_pct`/
`after_used_pct`/`consumed_pp` nuláveis, `same_window` e `reason_code`
(`OK` | `RATE_LIMIT_WINDOW_RESET` | `MEASUREMENT_UNAVAILABLE` |
`WINDOW_LABEL_UNPARSEABLE` | `OBSERVED_DELTA_NEGATIVE`), com provenance por
janela. `QuotaUsage` agrega `provider`, `observation` (`status`: `OBSERVED` |
`UNAVAILABLE`, `reason_code`, `provenance`) e `windows`. `OBSERVED` pode ter
`windows: []` (zero janelas observadas); `UNAVAILABLE` **exige** `windows: []`
— nunca inventar `QuotaWindow` para representar indisponibilidade.
`consumed_pp` nunca soma entre janelas incompatíveis e só é comparável entre
mesmo `window_id` e mesmo provider.

- Parse cobre cada `reason_code`, `window_id` arbitrário não vazio,
  `OBSERVED` com `windows: []` e `UNAVAILABLE` com `windows: []`; `window_id`
  vazio e `UNAVAILABLE` com `windows` não vazia são rejeitados.
- `consumed_pp` numérico com `same_window: false` é rejeitado.
- Docstrings declaram não-somabilidade entre janelas, comparabilidade
  restrita a mesmo `window_id`+provider e a distinção `OBSERVED([])` vs
  `UNAVAILABLE([])`.

### M45 — InterventionRecord e fatos ortogonais de attempt
**Depende de:** M44 · **Teste:** `test/performance/attempt-facts.test.ts`

`src/schemas/intervention.ts` (`InterventionRecord`: id, type
`operational_cleanup | manual_fix | design_decision | other`, descrição não
vazia, `occurred_at`, `affects_autonomy`) e `src/performance/` com
`deriveAttemptFacts`, que produz dimensões ORTOGONAIS por attempt:
`execution_status` (inalterado), `had_inference` (`true`/`false`/`null` com
provenance — `true` só com evidência positiva de inferência, `false` só com
prova positiva de ZERO inferência, `null` quando a evidência não permite
afirmar nenhum dos dois; proibido `absence_of_event => false`),
`evaluation_outcome`, `attempt_role` (vem da história, nunca inferido) e
`interventions` (lista, ou `null`/`unknown` sem registro). Não existe
classificação binária INFRA vs INFERENCE_BEARING.

- `INFRA_ERROR` sem eventos e sem prova de zero inference produz
  `had_inference: null` (nunca `false`).
- `INFRA_ERROR` com prova positiva de zero produz `false`; com prova de
  inferência produz `true`; `TIMED_OUT` com eventos de modelo produz `true`.
- Evidência insuficiente produz `null` com provenance, nunca `false` por
  ausência; `InterventionRecord` rejeita descrição vazia e type fora do
  enum.

### M46 — Schemas RunPerformanceRecord e TaskPerformanceRecord
**Depende de:** M45 · **Teste:** `test/schemas/performance.test.ts`

`src/schemas/performance.ts` (schema_version 1). `RunPerformanceRecord`:
IDENTITY (task_id, taxonomy quando presente, stack, agent_cli, model,
reasoning_effort, strategy, environment_profile, envelopes, referências
pinadas `evaluation_id`/`score_id`); QUALITY (status/outcome/qualification,
`score_profile_id`/version, `sub_scores`, `coverage` espelhando ScoreRecord
— sem scalar `aggregate_score`/`total_score`/`weighted_score` inventado);
FACTS (`had_inference`, `attempt_role`, `interventions`); COST (duração,
tokens com `fresh_input_tokens` derivado, `api_equivalent_usd`,
`quota_usage`). `TaskPerformanceRecord`: ATTEMPTS com contagens ortogonais
que particionam `operational_attempts` sem invariante cruzada com
`infra_error_attempts`; SUCCESS (`first_operational_pass`,
`first_inference_bearing_pass`, `autonomous_first_pass`, `final_pass`);
INTERVENTION (`human_intervention` nulável com provenance, nunca default
`false`). `autonomous_first_pass: true` exige `human_intervention: false`
comprovado. Records são derivados e recomputáveis.

- Parse válido/inválido de ambos os records, incluindo `had_inference: null`,
  `human_intervention: null` com provenance e QUALITY sem scalar de score.
- Partição `attempts_with_inference + attempts_without_inference +
  attempts_inference_unknown == operational_attempts` validada;
  `infra_error_attempts` pode intersectar `attempts_with_inference`.
- `autonomous_first_pass: true` com `human_intervention` `true` ou `null` é
  rejeitado; parse rejeita scalars de score inventados.

### M47 — derivePerformance e fixtures históricas
**Depende de:** M46 · **Teste:** `test/performance/derive.test.ts`

Função pura `derivePerformance(history)` em `src/performance/` que produz
`TaskPerformanceRecord` a partir de uma `AttemptHistory` normalizada.
Fixtures sintéticas determinísticas (nunca acopladas a `.dev/` nem ao
runtime local) reproduzindo a semântica dos casos históricos:
**M26-like** — 1 attempt PASS com intervenção operacional resulta em
`final_pass: true` e `autonomous_first_pass: false`; **M33-like** — attempt 1
INFRA_ERROR com prova positiva de ZERO inferência, attempt 2 com inferência
real e PASS; **infra-inference-unknown** — attempt INFRA_ERROR sem eventos e
sem prova de inferência nem de zero (`had_inference: null`), distinto do
M33-like; **M39B-like** — attempt 1 FAIL legítimo, attempt 2 role `repair`
PASS; **M23-like** — repair falho no mesmo effort e attempt role `escalation`
que passa; **infra-after-inference** — attempt 1 INFRA_ERROR com
`had_inference: true`, attempt 2 PASS, distinto do M33-like e do
infra-inference-unknown; **unknown-intervention** — história sem registro de
intervenção resulta em `human_intervention: null` (provenance
`not_recorded`) e `autonomous_first_pass: null`, nunca supostos.

- As sete fixtures produzem records distintos exatamente como descrito no
  objective.
- Três casos INFRA distintos (M33-like, infra-inference-unknown,
  infra-after-inference) provados sem `absence_of_event => false` e sem
  ausência de intervenção virando `false`.
- `derivePerformance` é determinística (mesma entrada, mesmos bytes
  canônicos).

### M48 — AttemptHistory a partir de data/runs com seleção pinada
**Depende de:** M47 · **Teste:** `test/performance/history.test.ts`

Leitor somente-leitura em `src/performance/` que constrói `AttemptHistory` de
um trial a partir de `data/runs/`: agrupa por `trial_id`, ordena por run-id
ULID, lê `execution-record.json` e deriva os fatos do M45. Um run pode ter N
evaluations e N scores: a derivação nunca escolhe "mais recente" — recebe uma
`EvaluationSelection` explícita (`run_id` → `evaluation_id`/`score_id`
pinados); run sem seleção produz `evaluation_outcome: none` e campos de score
`null` com provenance `not_selected`. Helper `listEvaluations(run)` enumera
candidatos sem default automático. Se `execution/quota-usage.json` existir,
verifica integridade e expõe `QuotaUsage` (M44) parseado; se não existir,
`quota_usage.value = null` com provenance `artifact_not_present` (nunca
inventa `windows: []`). Artifact inválido/adulterado é reportado e excluído
com motivo, não ignorado silenciosamente. Nenhuma escrita em disco.

- Fixture com dois runs do mesmo trial (INFRA_ERROR depois COMPLETED/PASS)
  produz a semântica M33-like fim a fim a partir do disco, com seleção
  pinada gravada no record.
- Acrescentar uma segunda evaluation ao mesmo run não muda o record derivado
  com a seleção original; sem seleção, outcome é `none`/`not_selected`.
- Run histórico sem `quota-usage.json` produz `quota_usage: null` com
  `artifact_not_present`; run com artifact válido expõe `QuotaUsage`
  parseado; run adulterado aparece excluído com motivo.

### M49 — Taxonomia v1 opcional e backward-compatible no TaskSpec
**Depende de:** M48 · **Teste:** `test/schemas/task-spec.test.ts`

`src/schemas/task-spec.ts` ganha um bloco opcional e versionado `taxonomy`:
`version` (literal 1), `task_class`, `difficulty_declared`, e opcionais
`complexity`, `ambiguity` e `verification`. Os campos existentes `task_class`
e `difficulty` do TaskSpec permanecem strings livres — nenhum campo existente
é estreitado, e todo TaskSpec histórico continua parseando inalterado.
`difficulty_declared` é a dificuldade declarada pelo autor; a dificuldade
observada será derivada dos experimentos no futuro. `docs/ARCHITECTURE.md`
registra que a Capability Matrix é derivada dos experimentos — nenhuma
matriz hardcoded antes de existirem dados.

- TaskSpec da era M1 com `task_class`/`difficulty` livres e sem `taxonomy`
  parseia inalterado (regressão explícita).
- `taxonomy` presente rejeita `version` diferente de 1 e valores fora dos
  enums; ausente continua válido.
- Testes cobrem presença/ausência do bloco e valores válidos/inválidos de
  cada campo.

### M50 — ExtensionManifest imutável e IncubationState separado
**Depende de:** M49 · **Teste:** `test/schemas/extension.test.ts`

`src/schemas/extension.ts` com dois schemas separados: `ExtensionManifest`
(identidade/configuração imutável e versionada — `kind`, `name`, `version`,
`description`, `requires`; sem nenhum campo de lifecycle/status) e
`IncubationState` (estado mutável em arquivo próprio — `status`
`DISCOVERED | CANDIDATE | SANDBOXED | BENCHMARKED | PROMOTED`, `updated_at`,
referência à identidade do manifest). `loadExtension(repoRoot, kind, name,
version)` lê `extensions/<kind>/<name>/<version>/extension.yaml` e, se
existir, `incubation.yaml` no mesmo diretório (ausente = `DISCOVERED`
default em memória, nada gravado), com a mesma guarda de identidade do
`loadStrategy`. Mudar o status nunca altera o manifest nem seu hash
canônico. Sem registry além disso; `strategies/` existentes não migram.

- Manifest válido carrega; identidade divergente do caminho falha nomeando
  o esperado; manifest com campo de status é rejeitado.
- `incubation.yaml` com status fora do enum ou identidade divergente é
  rejeitado; ausência produz `DISCOVERED` default sem escrita em disco.
- Hash canônico do manifest não muda quando `incubation.yaml` muda;
  `strategies/direct/1` continua carregando pelo caminho antigo, inalterado.

### M51A — ProviderAdapter contract, registry e fake shape
**Depende de:** M50 · **Teste:** `test/adapters/contract.test.ts`

`src/adapters/contract.ts` define o `ProviderAdapter` mínimo — `identity`,
`preflight` opcional (não implementado ainda), `buildInvocation(options)` →
`{ argv, env, stdin? }`, e contrato de parser/observações (stream bruto →
eventos normalizados + observações de usage/custo/classificação terminal).
Registry `resolveAdapter(cli)` mapeia `AgentProfile.cli` para o adapter
registrado e falha com erro acionável para cli desconhecida. `src/adapters/
fake` é adaptado à forma do contrato sem criar ainda o runtime comum
`executeWithAdapter`; `runFakeAgent` permanece exportado e o comportamento
observável é preservado. Nenhum provider real.

- `resolveAdapter('fake')` retorna o adapter fake registrado; cli
  desconhecida falha com erro acionável nomeando adapters/clis registrados.
- Fake implementa a forma `ProviderAdapter` (buildInvocation + observações)
  sem `executeWithAdapter` completo; `runFakeAgent` permanece exportado.
- Suíte existente de adapters verde sem mudança de comportamento observável.

### M51B — executeWithAdapter runtime comum e equivalência fake
**Depende de:** M51A · **Teste:** `test/adapters/execute-with-adapter.test.ts`

`executeWithAdapter(adapter, options)` sobre `src/runner`: spawn, timeout,
cleanup de process-group, fatos objetivos de processo (exit code, sinal,
duração, survivors) e montagem do `ExecutionRecord` autoritativo (fatos de
processo do runtime + observações do adapter, com provenance separada).
Nenhum adapter replica spawn/timeout/cleanup/montagem de record. `options`
cobre o que `runFakeAgent` já recebia. O fake passa a executar através desse
runtime, com equivalência observável provada contra o comportamento
anterior. Nenhum provider real ainda.

- `resolveAdapter('fake')` + `executeWithAdapter` reproduz o comportamento
  observável anterior do fake (teste de equivalência).
- A montagem do `ExecutionRecord` ocorre no runtime comum, não no adapter
  (teste estrutural).
- Suíte existente de adapters e e2e verde sem modificação de expectativa.

### M52 — Revisão PRE-M2 (parada obrigatória)
**Depende de:** M51B · **Gate:** `pnpm build`

Fecha o PRE-M2: este arquivo espelhando M41–M51B, `docs/LESSONS.md` com as
correções acumuladas no formato datado e `docs/reviews/PRE-M2-REVIEW.md` com
o pacote de revisão humana — contratos criados, fixtures sintéticas e o que
cada uma prova, taxonomia v1, contratos de extension, ProviderAdapter e
runtime comum, `QuotaUsage.observation`, leitura de `quota-usage.json`,
divergências documentais tratadas, o plano do Marco 2 proposto como
documento (M53–M68 fora de `dev/plan.yaml`) e o Pilot Benchmark proposto.
Última task do plano operacional atual: M53–M68 só entram em
`dev/plan.yaml` por uma segunda alteração após aprovação humana explícita.
**Parada obrigatória para revisão do usuário depois desta tarefa.**

- BACKLOG.md reflete o estado real de M41 a M51B.
- `docs/reviews/PRE-M2-REVIEW.md` existe com as seções do objective.

A revisão humana de M52 encontrou um gap semântico em M51B (§ M52A) e uma
proposta de Marco 2 superdimensionada com duas propostas concorrentes no
documento (§ M52B) — corrigidos pelas duas tarefas a seguir.

### M52A — Provider observations preservadas no runtime comum
**Depende de:** M52 · **Teste:** `test/adapters/provider-observations.test.ts`

Corrige o gap encontrado pela revisão humana de M52: `executeWithAdapter`
chamava `adapter.parseLine(raw)` — que devolve `ParsedProviderLine { event,
observation? }` — mas preservava só `.event`, descartando `.observation`
antes de alimentar o resultado do runtime comum. `AdapterExecutionRun` ganha
`parsedLines: ParsedProviderLine[]`, uma entrada por linha não vazia de
stdout, na mesma ordem/índice de `events`, para que a correlação entre uma
`ProviderObservation` e a linha de origem nunca fique ambígua mesmo com
várias observations. `ExecutionRecord` continua reunindo só fatos objetivos
de processo (exit code, sinal, duração, survivors, `ExecutionStatus`) vindos
do runtime; `metrics.tokens` e `metrics.api_equivalent_usd` passam a vir da
observation do último evento `result` (ausência vira `null` com provenance,
custo só alimenta a métrica quando já expresso em USD/API-equivalent, sem
conversão de moeda); `terminal` permanece observation e nunca sobrescreve
`ExecutionStatus`. Nenhum adapter replica spawn/timeout/cleanup/montagem de
record; `src/schemas/execution-record.ts` não é expandido para armazenar
`terminal` ou um blob de provider. Integração real
`resolveAdapter → buildInvocation → executeWithAdapter` continua diferida
para M62.

- `ParsedProviderLine.observation` não é descartada pelo runtime comum.
- `usage`, `cost` e `terminal` permanecem acessíveis no resultado da
  execução via `parsedLines`, sem ambiguidade sobre a origem de cada
  observation.
- Suíte existente de adapters e e2e verde sem modificação de expectativa.

### M52B — Revisão PRE-M2 corrigida após auditoria humana
**Depende de:** M52A · **Gate:** `pnpm build`

Corrige `docs/reviews/PRE-M2-REVIEW.md`, `docs/BACKLOG.md` e
`docs/LESSONS.md` após a auditoria humana de M52. O documento de revisão
passa a descrever corretamente M51B e M52A e substitui a proposta de Marco 2
anterior (superdimensionada, com duas propostas de M2 concorrentes) por uma
única sequência final: M53 corpus experimental inicial, M54 billing guard,
M55 credential proof, M56 Claude invocation, M57 Claude stream parser, M58
Claude ProviderAdapter, M59 Claude quota probe, M60 Codex invocation, M61
Codex ProviderAdapter, M62 executeRun / integração de adapter, M63 CLI
experimental, M64 ExperimentSpec freeze, M65 experiment runner
seeded/counterbalanced, M66 compare, M67 E2E, M68 revisão M2 + pilot
checklist. Score v2, intervalo de confiança, suite de 8–12 tasks,
incubação/sandbox, promoção `BENCHMARKED → PROMOTED`, Capability Matrix
completa e marketplace saem da sequência inicial e ficam registrados como
candidatos a Marco 3 ou follow-up pós-piloto. O piloto preservado é Claude
Sonnet 5 Medium vs Claude Sonnet 5 High, 2 arms, 3 tasks, 2 repetições por
task/arm, 12 slots inference-bearing planejados, sequential, seeded e
interleaved/counterbalanced, mesmo `TaskSpec`/`Strategy`/`EnvironmentProfile`
`controlled`; só `QUALIFIED` entra no compare; `INFRA` consome retry slot
sem virar capability FAIL; resultados por task antes do agregado global;
quota stop em ≥80%; billing guard pode impedir novo launch; Codex é smoke
real mínimo, não um segundo braço completo; nenhuma execução adicional sem
billing authorization. `docs/LESSONS.md` ganha uma lesson datada sobre
semantic/contract coverage (caso concreto: `parseLine`/observation
descartada por `executeWithAdapter` sob full suite verde). M53–M68
continuam ausentes de `dev/plan.yaml`. **Nova parada obrigatória para
revisão humana depois desta tarefa.**

- `docs/reviews/PRE-M2-REVIEW.md` descreve corretamente M51B e M52A e não
  contém duas propostas de M2 concorrentes.
- O M2 final usa exatamente a sequência M53–M68 acima; itens de score v2,
  intervalo de confiança, suite de 8–12 tasks, incubação/sandbox, promoção
  `BENCHMARKED → PROMOTED`, Capability Matrix completa e marketplace não
  aparecem como requisitos.
- BACKLOG.md inclui M52A e M52B; `docs/LESSONS.md` contém a lesson datada de
  semantic/contract coverage.
- M53–M68 permanecem ausentes de `dev/plan.yaml`; nova parada obrigatória
  registrada. Gates completos verdes.
- Gates completos verdes.

### M52C — Fronteira M67/M68 e pilot pós-M2 corrigida
**Depende de:** M52B · **Gate:** `pnpm build`

Corrige exclusivamente a fronteira documental entre a prova E2E do M2, a
revisão/checklist e o pilot benchmark posterior. M67 passa a provar a
infraestrutura experimental completa (`ExperimentSpec → ProviderAdapter →
executeRun → evidence → evaluation → qualification → performance → compare`)
com fixtures, fake adapters, ambientes determinísticos e evidência
sintética/controlada. Smoke real mínimo só é permitido quando explicitamente
autorizado, necessário para provar integração real, liberado pelo billing
guard e precedido por credential proof; M67 não executa o pilot de 12 slots e
não produz conclusão comparativa final Medium vs High.

M68 é a última tarefa operacional do M2 antes do pilot real: revisão M2,
checklist completo e parada humana obrigatória. O checklist exige M53–M67
`PASS`, gates verdes, `recover CLEAN`, evidence contracts íntegros, billing
guard/credential proof/quota probe funcionais, `ExperimentSpec` congelado,
corpus de 3 tasks aprovado, seed/order/counterbalancing definidos, retry policy
de `INFRA`, compare somente com `QUALIFIED`, quota stop em ≥80%, profiles
Medium/High corretos, Codex somente smoke e custo máximo/billing authorization
definidos. M68 não lança nenhum slot do pilot.

O pilot real mantém o desenho aprovado após auditoria humana: Claude Sonnet 5
Medium vs High, 2 arms × 3 tasks × 2 repetições = 12 slots inference-bearing,
sequential, seeded e interleaved/counterbalanced, com o mesmo
`TaskSpec`/`Strategy`/`EnvironmentProfile` controlled. Só `QUALIFIED` entra no
compare; `INFRA` usa retry slot e não vira capability FAIL; resultados por task
precedem o agregado; quota stop em ≥80% e billing guard podem interromper o
launch; Codex permanece smoke only; não há execução extra sem billing
authorization. Os 12 slots só começam após aprovação humana explícita nova,
posterior a M68. M53–M68 continuam ausentes de `dev/plan.yaml`.
**Nova parada obrigatória para revisão humana depois desta tarefa.**

- M67 é prova E2E da infraestrutura/pipeline e não execução do pilot completo.
- M68 verifica todos os pré-requisitos e termina em parada humana antes do
  primeiro dos 12 slots.
- O desenho Medium vs High, as regras de quota, qualificação, retry,
  counterbalancing, billing e o escopo smoke-only do Codex permanecem
  inalterados.
- Nenhuma alteração em `src/`, `test/` ou `dev/plan.yaml`; nenhum provider
  real executado.

## Marco 2 — Piloto Claude Medium vs High

Sequência final aprovada em `PRE-M2-REVIEW.md` §5–§6: corpus fixo, guardas de
billing/credencial, os dois primeiros `ProviderAdapter`s reais (Claude,
Codex smoke-only), `ExperimentSpec` congelado, runner seeded/counterbalanced,
compare QUALIFIED-only e a prova E2E da infraestrutura — fechando com a
revisão e o checklist de M68 antes do pilot real de 12 slots.

### M53 — Corpus experimental inicial
**Depende de:** M52C · **Teste:** `test/corpus/pilot-v1.test.ts`

`corpus/pilot-v1/`: exatamente três tasks (`fix-stable-tag-normalization`,
`add-bounded-retry`, `add-jsonl-summary-cli`), cada uma com `TaskSpec`
público válido, workspace deliberadamente não resolvido, grader público
determinístico (`node --test .../public-tests.mjs`) e um `README.md` que
documenta o critério de escolha (baixo custo/ambiguidade, sem
rede/relógio/aleatoriedade, formas de trabalho diferentes) fixado antes de
qualquer resultado experimental. Não amplia para a suite de 8–12 tasks — essa
ampliação continua deferida para Marco 3/pós-piloto.

- Exatamente 3 tasks, `TaskSpec` público e versionado cada.
- Nenhum `EvaluationPlan` ou grader oculto vazado para o worker.
- Corpus reproduzível sem dependências externas (Node ≥ 22.13.0 só).

### M54 — Billing guard do produto
**Depende de:** M53 · **Teste:** `test/billing/guard.test.ts`

`decideExecutionAuthorization` (`src/billing/guard.ts`): guarda
provider-neutral que decide ALLOW/BLOCK antes do launch de uma execução
`REAL_INFERENCE`, separando autorização, modo de cobrança, quota
conhecida/desconhecida, custo/budget e a provenance de cada evidência.
`FIXTURE` é sempre ALLOW; `REAL_INFERENCE` sem evidência é BLOCK; ausência de
evidência numérica nunca vira zero implícito. Budget só é exigido quando
`billing_mode === 'API'`. Não reaproveita `dev/lib/billing.ts` como
arquitetura pública — é uma guarda nova do produto.

- Contrato provider-neutral, decisão auditável (`reasons` + `policy`
  versionada).
- Nenhuma execução real ocorre sob decisão BLOCK.
- API-equivalent nunca alimenta cobrança real; testes só com fixtures/fakes.

### M55 — Credential proof provider-neutral
**Depende de:** M54 · **Teste:** `test/credentials/proof.test.ts`

`decideCredentialProof` (`src/credentials/proof.ts`): contrato que distingue
`SUBSCRIPTION_VERIFIED`, `API_VERIFIED`, `UNKNOWN` e `NOT_APPLICABLE` antes de
execução real, separado de billing e de quota. Ausência de API key nunca
prova assinatura; `UNKNOWN`/`NOT_APPLICABLE` são fail-closed quando o
`CredentialRequirement` do perfil exige assinatura ou credencial verificada.
`CredentialProof` guarda só o status sanitizado e um `verifier_id` opaco —
nunca saída bruta da CLI, token ou identificador de conta.

- Schema provider-neutral com provenance explícita do método de verificação.
- Unknown fail-closed quando assinatura é requisito.
- Nenhum segredo persistido; sem chamada paga nos testes.

### M56 — Claude invocation
**Depende de:** M55 · **Teste:** `test/adapters/claude-invocation.test.ts`

`buildInvocation` real para a Claude CLI (`src/adapters/claude/invocation.ts`)
sobre o contrato `ProviderAdapter` (M51A): monta argv/env/stdin
determinísticos a partir de `AgentProfile`/`EnvironmentProfile` explícitos —
herdar `process.env` tornaria a saída implícita e não reproduzível. Nenhum
spawn dentro do adapter; quem executa continua sendo `executeWithAdapter`
(M51B/M52A).

- `buildInvocation` determinístico e testado por fixture/snapshot.
- Sem spawn nem duplicação de runtime dentro do adapter.
- Nenhuma inferência real nos testes.

### M57 — Claude stream parser
**Depende de:** M56 · **Teste:** `test/adapters/claude-parser.test.ts`

`parseLine` real do stream da Claude CLI (`src/adapters/claude/parser.ts`):
produz `ParsedProviderLine{event, observation?}`, preservando `usage`, `cost`
e `terminal` na `ProviderObservation` sem que `terminal` jamais sobrescreva
`ExecutionStatus`. Custo só normaliza para `api_equivalent_usd` quando já
semanticamente compatível; ausência permanece ausência. Malformed input é
tratado deterministicamente, redigindo `session_id`/campos de token.

- Fixtures representativas do stream real (`fixtures/provider-streams/`).
- Usage, cost e terminal preservados sem ambiguidade de origem.
- Nenhuma chamada real ao provider.

### M58 — Claude ProviderAdapter
**Depende de:** M57 · **Teste:** `test/adapters/claude-adapter.test.ts`

Primeiro `ProviderAdapter` real completo (`src/adapters/claude/index.ts`):
identity + preflight + `buildInvocation` (M56) + `parseLine` (M57),
registrado em `resolveAdapter` (`src/adapters/registry.ts`). Nenhuma lógica de
runtime migra para o adapter; o fake continua funcionando pela mesma
interface.

- `resolveAdapter('claude')` identifica o adapter real; fake inalterado.
- Contrato `ProviderAdapter` permanece provider-neutral.
- Full suite verde sem exigir chamada real nos testes.

### M59 — Claude quota probe
**Depende de:** M58 · **Teste:** `test/adapters/claude-quota.test.ts`

`probeClaudeQuota`/`buildClaudeQuotaUsage`/`writeClaudeQuotaUsage`
(`src/adapters/claude/quota.ts`): mede consumo de cota via `/usage` e só
aceita a leitura quando o `result` da CLI prova custo/turnos/tokens de
inferência zero (`zeroInferenceViolations`) — qualquer violação vira
`UNAVAILABLE`, nunca uma leitura de 0%. Produz o contrato `QuotaUsage` (M44),
distinguindo janela igual (delta válido) de janela resetada/ilegível (delta
`null`), e grava em `execution/quota-usage.json` com `flag: 'wx'` (recusa
sobrescrever evidência existente).

- Contrato `QuotaUsage` M44 usado sem extensão.
- Same-window necessário para `consumed_pp`; reset invalida o delta.
- Unknown/unavailable nunca vira zero; testes só com probes fake/fixtures.

### M60 — Codex invocation
**Depende de:** M59 · **Teste:** `test/adapters/codex-invocation.test.ts`

`buildInvocation` real para a Codex CLI (`src/adapters/codex/invocation.ts`),
mesmo contrato do M56, reaproveitando `src/adapters/environment.ts` para o
ambiente allowlisted compartilhado. Modelo/effort vêm de `AgentProfile`
explícito; nenhum acoplamento ao adapter Claude. Codex é usado neste Marco 2
somente para provar generalização do contrato — não é um segundo braço do
benchmark.

- Invocation determinística, testada por fixture.
- Sem spawn dentro do adapter; nenhuma inferência real.

### M61 — Codex ProviderAdapter
**Depende de:** M60 · **Teste:** `test/adapters/codex-adapter.test.ts`

Segundo `ProviderAdapter` real completo (`src/adapters/codex/index.ts`):
identity + preflight + `buildInvocation` (M60) + `parseLine`
(`src/adapters/codex/parser.ts`), registrado em `resolveAdapter`. Prova que o
contrato M51A/M52A generaliza para pelo menos dois providers sem duplicar o
runtime comum. Codex permanece smoke-only: nenhuma tarefa executa inferência
Codex real nem produz benchmark.

- `resolveAdapter('codex')` identifica o adapter; Claude e fake continuam
  funcionando.
- `ProviderObservation` preservada; `terminal` não controla `ExecutionStatus`.
- Nenhum benchmark Codex.

### M62 — executeRun / integração de adapter
**Depende de:** M61 · **Teste:** `test/cli/run-execute.test.ts`

`executeRun` (`src/cli/run-execute.ts`) fecha a integração high-level adiada
em M51B/M52A: `resolveAdapter(profile.cli) → adapter.buildInvocation(...) →
executeWithAdapter(...) → evidence`, com fake/Claude/Codex pela mesma
trajetória estrutural. `executeWithAdapter` continua recebendo a invocation
já concreta — não chama `buildInvocation` diretamente.

- Registry → invocation → runtime comum ponta a ponta.
- `ParsedProviderLine`/observations preservadas; fatos de runtime separados
  de observations de provider.
- Testes sem provider real (attempt 1 caiu por incidente de protocolo de
  fechamento, não de capacidade — recuperado; attempt 2 fechou `PASS`).

### M63 — CLI experimental
**Depende de:** M62 · **Teste:** `test/cli/run.test.ts`

`agentlab run --experimental` (`src/cli/run.ts`): interface fina que lê um
`ExecutionRequest` de arquivo e delega inteiramente para `prepareRun`/
`executeRun` — nenhuma lógica de runner nasce na CLI. `--experimental` é
obrigatório porque o comando pode clonar, rodar o processo de um agente (fake
ou real) e gravar em `data/`. Billing BLOCK impede spawn antes de qualquer
clone.

- Comando explícito, help/erro claros.
- Caminho fake/dry testável sem provider real.
- BLOCK do billing guard impede spawn; nenhuma execução automática.

### M64 — ExperimentSpec freeze
**Depende de:** M63 · **Teste:** `test/experiment/freeze.test.ts`, `test/experiment/pilot.test.ts`

`ExperimentSpec` (`src/schemas/experiment-spec.ts`) congela, antes de
qualquer execução real: arms (só `AgentProfile` varia entre eles), corpus/
tasks, repetições, seed + esquema de ordenação
(`seeded_interleaved_counterbalanced`), strategy e environment
compartilhados, e a `ExperimentBillingPolicy` (billing mode, budget máximo,
`quota_stop_threshold_pct`). `freezeExperimentSpec` (`src/experiment/index.ts`)
valida contra o schema `.strict()`, aplica deep-freeze e calcula um hash
canônico determinístico — qualquer alteração produz um `ExperimentSpec`
diferente, nunca mutação silenciosa. `buildPilotExperimentSpec`
(`src/experiment/pilot.ts`) materializa o piloto concreto (2 arms Sonnet 5
Medium/High, as 3 tasks do M53, 2 repetições, seed fixa, 12 slots
planejados) só lendo `corpus/` e `strategies/` do repo — nenhum spawn.

- Schema strict/versionado; canonical hash determinístico; imutabilidade
  semântica (mutação em runtime lança `TypeError`).
- Arms, corpus, repetições, seed, ordering, strategy, environment e billing
  policy todos congelados.
- 2 arms Sonnet Medium vs High, 3 tasks, 2 repetições/task/arm,
  `planned_slot_count: 12`. Nenhum slot executado pela tarefa.

### M65 — Experiment runner seeded/counterbalanced
**Depende de:** M64 · **Teste:** `test/experiment/runner.test.ts`

`materializeSlotOrder`/`runExperimentSchedule` (`src/experiment/runner.ts`):
materializa a ordem concreta de execução a partir do `FrozenExperimentSpec` —
PRNG determinístico (mulberry32) embaralha blocos task×repetição pela seed
congelada, e a direção dos arms alterna a cada bloco (counterbalancing), então
nunca todos os slots de um arm rodam antes dos de outro. `INFRA_ERROR` nunca
vira capability FAIL: gera um `PlannedSlot{kind:'RETRY'}` enfileirado, até
`maxRetriesPerSlot` (default 1) tentativas por slot original. A billing/quota
guard é consultada antes de todo launch, incluindo retries; BLOCK interrompe
o schedule sem descartar o que já rodou. Só fakes nesta tarefa — não executa
os 12 slots reais.

- Mesma seed → mesma ordem; seed diferente pode embaralhar de forma diferente
  (ainda intercalada).
- Arms intercalados/counterbalanced; 12 planned slots derivados corretamente
  do spec do M64.
- `INFRA` gera retry separado, nunca fail de capacidade; billing BLOCK
  interrompe o launch. Testes fake-only.

### M66 — Compare
**Depende de:** M65 · **Teste:** `test/reporting/compare.test.ts`

`compareTaskPerformance` (`src/reporting/compare.ts`): compara
`TaskPerformanceRecord`s (M46) entre arms do piloto. Só observações
`QUALIFIED` entram no cálculo — `UNSCORABLE`/`MISSCOPED`/`CONTAMINATED`/
`INVALID_ENVIRONMENT`/`HISTORICAL_ONLY` só incrementam
`excluded_non_qualified`. Resultado sempre por task primeiro (`per_task`), só
depois agregado por arm (`aggregate`). `final_pass`/`human_intervention` nulos
ficam fora do denominador das respectivas taxas — missing nunca vira fail.
Nunca computa confidence interval, p-value ou Capability Matrix completa;
`posterior_counts` é só contagem bruta, matéria-prima para inferência futura.
`reporting/` deixa de ser placeholder (ver `docs/ARCHITECTURE.md` §6.1).

- QUALIFIED-only; per-task antes do agregado.
- `insufficient_n` explícito abaixo de `DEFAULT_MIN_QUALIFIED_N`.
- Missing/null preservado; fixtures determinísticas; nenhuma inferência real.

### M67 — E2E da infraestrutura experimental
**Depende de:** M66 · **Teste:** `test/e2e/experiment-fake-e2e.test.ts`

Prova ponta a ponta, só com fixtures/fake adapter:
`freezeExperimentSpec` → `runExperimentSchedule` (M65) → `prepareRun`/
`executeRun` com `FAKE_ADAPTER_IDENTITY` (M62) → `verifyRunIntegrity` →
`evaluateRun` → `scoreRun` (qualification) → `readTrialHistory`/
`derivePerformance` (M46) → `compareTaskPerformance` (M66). Spec de teste: 2
arms fake × 1 task × 2 repetições = 4 slots, bem abaixo dos 12 reais do
piloto — grader determinístico do teste diferencia os arms sem produzir
nenhuma conclusão comparativa real (compare só expõe contagem bruta
`QUALIFIED`, sem winner/confidence interval/Capability Matrix). Segundo
teste prova que um arm `REAL_INFERENCE` sem `RealExecutionAuthorization`
explícita é bloqueado pela billing guard (M54) antes de lançar qualquer
slot — sem autorização humana explícita nesta tarefa, permanece FAKE-ONLY.

- E2E fake ponta a ponta `PASS`; evidence válida (`verifyRunIntegrity` OK).
- Evaluation/qualification/performance/compare conectados sem gap.
- Zero necessidade dos 12 slots reais; nenhuma conclusão comparativa real.
- Real smoke opcional e bloqueado por default (billing guard).

### M68 — Revisão M2 + pilot checklist (parada obrigatória)
**Depende de:** M67 · **Gate:** `pnpm build`

Fecha o Marco 2: [`docs/reviews/M2-REVIEW.md`](reviews/M2-REVIEW.md) confere
M53–M67 `PASS`, gates, `recover` reconciliado, e cada item do checklist do
pilot (evidence contracts, billing guard, credential proof, quota probe,
`ExperimentSpec` congelado, corpus, seed/ordem/counterbalancing, retry
`INFRA`, compare QUALIFIED-only, quota stop ≥80%, profiles Medium/High,
Codex smoke-only, custo/budget máximo, billing authorization). A revisão
encontrou que o stop de quota em 80% é política congelada no
`ExperimentSpec` e medida objetivamente pela probe (M59), mas não existe
ainda uma função que converta automaticamente "consumo ≥ 80%" em `BLOCK` —
é um passo manual do operador do piloto a cada launch, registrado como risco
em aberto para a aprovação humana que vem depois deste documento. Nenhum dos
12 slots do pilot é lançado por esta tarefa.

- Documento de revisão final com checklist explícito por item.
- `docs/BACKLOG.md`/`docs/LESSONS.md`/`docs/ARCHITECTURE.md` coerentes com
  M53–M67.
- Gates verdes; nenhum pilot real lançado; parada humana registrada.

## Marco 3 — Control plane universal de projetos

O Agent Strategy Lab possui o control plane; Claude Code e Codex são workers
descartáveis subordinados. A sequência M71–M85 constrói intake, inspection,
planning AVC, routing, escalation, história comparável, roles estruturais e o
lifecycle universal, e M86 fecha com revisão humana antes de qualquer projeto
real. O `pilot-v1` do Marco 2 permanece congelado e disponível.

### M71 — Project Intake + Execution Authorization Contract
**Depende de:** M70 · **Teste:** `test/intake/intake-request.test.ts`

Contratos strict/versionados para pedido sobre repo externo e autorização de
escopo. `requested_scope` registra intenção, mas não autoriza billing,
credenciais, destruição, efeito externo, deploy, expansão ou provider/profile
fora da policy. O boundary permite workspaces, workers configurados, validation,
bounded repair e escalation autorizada sem gate por spawn.

### M72 — Repository Inspector + Context/Environment Facts
**Depende de:** M71 · **Teste:** `test/inspection/inspect-repository.test.ts`

Inspeção read-only com fatos e provenance. Instruções entram como mapa de
caminhos/source anchors, nunca como documentação concatenada; unknown não vira
READY nem valor inventado.

### M73 — Planning Task Schema / Adaptive Task Envelope
**Depende de:** M72 · **Teste:** `test/planner/planned-task.test.ts`

`PlannedTask` compõe taxonomia e budgets por task, acrescenta risk, requisitos
de contexto/ambiente e mantém separados estimated task duration, worker runtime
budget e timeout por validation command. Não existe teto universal de duração.

### M74 — AVC Task Decomposition Engine
**Depende de:** M73 · **Teste:** `test/planner/decomposition.test.ts`

Decomposição pura por Atomic Validatable Change: coesão, blast radius,
ambiguidade, contexto, retry, rollback e verificação objetiva. Duração absoluta
não obriga split e budget adequado não é substituído por fragmentação artificial.

### M75 — Plan Policy Validator
**Depende de:** M74 · **Teste:** `test/planner/validate-plan.test.ts`

Valida DAG e política Direct/Reviewed. DIRECT exige minimal factual preflight e
Direct Task Normalization sem fatos inventados; insuficiência encaminha ao fluxo
REVIEWED. Plano inválido falha fechado.

### M76 — Execution Assessment
**Depende de:** M75 · **Teste:** `test/planner/assess.test.ts`

Deriva risk, context pressure, environment readiness, verification, review e
confidence. UNKNOWN não é READY; review independente e diversidade de profile/
model/provider são dimensões separadas e proporcionais ao risco.

### M77 — Profile Capability Registry
**Depende de:** M76 · **Teste:** `test/routing/capability-registry.test.ts`

Registry provider-neutral derivado dos facts do doctor, com isolamento,
mutation/read-only, ownership e compatibilidade de role explícitos, sem inferir
capacidade de notes ou reparsear identidade do argv.

### M78 — Initial Router + Adaptive Execution Budget
**Depende de:** M77 · **Teste:** `test/routing/router.test.ts`

Router determinístico por work unit e capability. Deriva worker runtime budget
adaptativo e o valida somente contra seu runtime bound; violação produz
`BUDGET_UNSUPPORTED` nomeando o bound.

### M79 — Failure Diagnosis + Selective Escalation
**Depende de:** M78 · **Teste:** `test/routing/escalation.test.ts`

Diagnóstico precede escalation. Só CAPABILITY após bounded repair percorre uma
ladder finita autorizada; demais classes seguem recovery, environment repair,
context repair ou replan. Fora da policy termina em `HUMAN_REQUIRED`.

### M80 — Cross-provider Escalation
**Depende de:** M79 · **Teste:** `test/routing/escalation-cross-provider.test.ts`

Escalation Claude/Codex dentro de profiles de assinatura permitidos, com
billing/credential/quota preflight por degrau, decisão e provenance do control
plane. Degrau indisponível não vira capability FAIL.

### M81 — Performance History Query
**Depende de:** M80 · **Teste:** `test/performance/query.test.ts`

Consulta read-only de histórico e contrato puro `ComparableRunFacts` em `src`.
Identidade comparável usa profile id + fingerprint canônico; ausência permanece
`UNKNOWN` com provenance, sem backfill ou escrita.

### M82 — History-informed Router
**Depende de:** M81 · **Teste:** `test/routing/history-router.test.ts`

Usa apenas séries comparáveis e amostra suficiente; deriva recomendação e
runtime budget observados sem inventar precisão. Lacuna, empate ou ambiguidade
cai no fallback determinístico M78 inalterado.

### M83 — Project Plan Generator + Untrusted Planning Worker
**Depende de:** M82 · **Teste:** `test/planner/generate-plan.test.ts`

Compõe o plano autorizado e uma porta provider-agnostic para planner read-only.
Draft é não confiável, bounded e submetido ao pipeline determinístico antes de
projeção; não pode alterar policy, acceptance, safety ou authorization.

### M84 — Universal Project Orchestration Lifecycle
**Depende de:** M83 · **Teste:** `test/dev/project-orchestrate.test.ts`

Conecta DIRECT e REVIEWED ao orquestrador existente, roles estruturais,
budgets/bounds separados, writer aditivo de `ComparableRunFacts`, diagnosis,
review fresco e human gates proporcionais. Provider real existe desligado por
default; nenhum provider ou projeto real foi executado.

### M85 — External Project Fake E2E
**Depende de:** M84 · **Teste:** `test/e2e/project-orchestration-e2e.test.ts`

Oito cenários fake provam DIRECT, REVIEWED, CAPABILITY, INFRA, ENVIRONMENT,
TASK/CONTEXT, CROSS_PROVIDER e HUMAN_GATE, incluindo write→read dos facts,
autonomia dentro do boundary e zero spawn após a fronteira.

### M86 — Human Review + First Real Project Checklist
**Depende de:** M85 · **Gate:** `pnpm build`

[`docs/reviews/M3-REVIEW.md`](reviews/M3-REVIEW.md) confere M71–M85, gates,
recover, contratos/policies, preservação do `pilot-v1` e coerência documental.
Nenhum projeto real é executado. Termina com **HUMAN STOP**: o primeiro projeto
real depende de aprovação humana explícita posterior.

---

## Marco 4 — Realinhamento documental + Typed Handoff v2 (M87–M94)

Origem histórica: o plano datado
[`docs/superpowers/plans/2026-08-21-agentlab-control-plane-jcode-evolution.md`](superpowers/plans/2026-08-21-agentlab-control-plane-jcode-evolution.md)
(HISTÓRICO — ver o próprio arquivo). Dele só permaneceram as work units
M87–M94 (M-A = M87–M90, realinhamento documental; M-B = M91–M94, Typed
Handoff v2), executadas e fechadas. A continuação arquitetural que aquele
plano descrevia **não é mais uma sequência autorizada**: ver
[Ids aposentados — M95–M126](#ids-aposentados--m95m126).

### M87 — Root README — identidade de control plane
**Depende de:** M86 · **Gate:** `pnpm build`

README raiz apresenta o produto como control plane autônomo fundado em
evidência (D1); Experimental Plane como instrumento de aprendizado; separação
implemented / limitations / planned verificável no código.

### M88 — ADR-0003 — identidade, adaptive routing e vocabulário
**Depende de:** M87 · **Gate:** `pnpm build`

Formaliza a mudança de direção (adaptive router deixou de ser non-goal),
define Evidence Kernel / Orchestration Control Plane / Experimental Plane e
registra D4 (evidência global com identidade de projeto obrigatória).

### M89 — LAB_CHARTER, ARCHITECTURE e HARNESS realinhados
**Depende de:** M88 · **Gate:** `pnpm build`

Charter sem contradições e com missão D1; ARCHITECTURE documenta o control
plane real pós-M86 e a dualidade `src`/`dev`; HARNESS clarifica terminologia e
o ponto de entrada `--authorization`.

### M90 — Contrato agentlab-run documentado + comentário obsoleto
**Depende de:** M88 · **Gate:** `pnpm build`

`agentlab-run` explicado como contrato de condução de projeto; comentário
obsoleto de `dev/lib/project-run.ts` corrigido. Sem mudança de comportamento.

### M91 — Typed Handoff v2 — schema
**Depende de:** M89, M90 · **Teste:** `test/dev/schemas.test.ts`

Handoff v2 aditivo com `evidence` por referência, `open_questions`,
`what_i_did_not_check` (obrigatório; vazio = prova positiva) e `confidence`
leniente. Budget 4 KiB e compatibilidade v1 preservados.

### M92 — Handoff v2 — propagação na finalização
**Depende de:** M91 · **Teste:** `test/dev/finalize-orchestrated.test.ts`

Só opinião do draft sobrevive; fatos continuam derivados pelo orquestrador.
`previous_handoff` transporta os campos novos dentro do budget.

### M93 — Handoff v2 — contrato do worker e fixtures
**Depende de:** M91 · **Teste:** `test/dev/prompt.test.ts`

Prompt exige `what_i_did_not_check`; fake worker produz drafts v2; draft
inválido cai no recovery de protocolo existente.

### M94 — Reviewer coverage no handoff v2
**Depende de:** M92, M93 · **Teste:** `test/dev/candidate-review.test.ts`

Reviewer nomeia cobertura e endereça `what_i_did_not_check` por item; ACCEPT
sem cobertura mínima é estruturalmente inválido. Regra conjuntiva e 3 hashes
intactos; diversidade default inalterada (D5).

---

## Ids aposentados — M95–M126

Os ids M95–M126 existiram como decomposição pré-piloto de capabilities
pós-v0.1 (eventos de execução provider-neutral, plan store, decisão humana
persistida, retrieval estrutural, adapter externo, concorrência, knowledge
store). Foram **retirados de `dev/plan.yaml`** depois do primeiro piloto
externo real: deixaram de ser uma sequência de desenvolvimento autorizada e
não são backlog executável.

Os temas que sobreviveram estão em
[FUTURE_DIRECTIONS.md](FUTURE_DIRECTIONS.md) — que **não é plano**, não tem
ordem, não tem dependências e não autoriza implementação.

Esses ids ficam aposentados: **não reutilizar M95–M126** para trabalho novo.
