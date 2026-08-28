# Agent Lab — recuperacao operacional Semi-Imperium ate ALL_DONE

**Data:** 2026-08-28

**Status:** EM ANDAMENTO

**Branch inicial da recuperacao:** `fix/semi-imperium-live-control-plane-recovery`

**Branch ativa:** `fix/additional-repair-authorization-one-shot`

**Baseline Agent Lab:** `852a81cb67e8c4935c6b25847b6d8937aa1350b7`

**Runtime canonico:**
`data/project-runs/grimperium-d08cac29/semi-imperium-real-01`

**Target:** `/home/plasma-test/Projetos/grimperium`

## Objetivo terminal

Conduzir o runtime canonico pelo lifecycle publico `pnpm lab resume` ate
`ALL_DONE`, corrigindo apenas defeitos reais do control plane provados pela
execucao. Encerrar antes de `ALL_DONE` somente por decisao humana genuina,
bloqueio externo sem recuperacao autorizada ou decisao de arquitetura do
control plane que nao possa ser tomada com seguranca nesta autorizacao.

## Limites e invariantes

- [x] Partir de `main == origin/main == 852a81c...` e arvore limpa.
- [x] Usar uma unica branch de recuperacao durante toda a sessao.
- [x] Preservar o runtime existente; nao criar, copiar, substituir ou editar
  manualmente seus records, state ou autorizacao.
- [x] Nao modificar manualmente o Grimperium; apenas workers do Agent Lab podem
  implementar ou reparar o target.
- [x] Preservar a autorizacao historica Claude/Codex subscription-only; nao
  adicionar OpenCode, OpenRouter, billing API ou novo provider.
- [x] Preservar quota observada de forma fresca por atividade; UNKNOWN continua
  distinto de zero e de EXHAUSTED.
- [x] Preservar provas read-only antes e depois da resolucao efetiva do argv.
- [x] Nao alargar gates, budgets, retries ou escopo para obter um resultado
  verde.
- [x] Nao fazer merge; ao final, push da branch e uma unica PR nao mesclada.

## Baseline operacional

- Agent Lab: branch inicial `main`, HEAD `852a81c...`, arvore limpa.
- Grimperium: branch `main`, arvore limpa, `HEAD=be5ff5a...` e
  `origin/main=2701620...`.
- Estado: tres tasks `PASS`; `crest_selection_workflow` esta
  `RUNNING/FINALIZING`, attempt 1; tres tasks posteriores estao `READY`.
- Candidate preservado de Crest: `be5ff5a76517c3d13477087db560db5cd87246e3`.
- Incidente inicial reproduzido nesta branch:
  `RoleOverlayError: role reviewer: argv lancado nao prova overlay read-only Claude`.

## Ciclo verificavel por incidente

- [x] Inspecionar a evidencia primaria e registrar estado/stage/comando.
- [x] Determinar se houve inferencia de worker/provider antes da falha.
- [x] Classificar: target normal, control plane, humano ou externo.
- [x] Para defeito do Lab, rastrear a causa raiz no caminho de producao.
- [x] Adicionar uma regressao que falha pelo motivo esperado antes do patch.
- [x] Aplicar a menor correcao coerente sem mudancas especulativas.
- [x] Rodar o teste focado e regressao relacionada.
- [x] Rodar `pnpm typecheck`, `pnpm test`, `pnpm build` e `git diff --check`.
- [x] Revisar escopo e criar um commit coerente do incidente.
- [x] Retomar o mesmo runtime pela interface publica e repetir o ciclo.

## Incidente 1 — prova read-only Claude pos-resolucao

- [x] Reproduzir o erro no runtime canonico.
- [x] Rastrear `buildRoleArgv -> resolveRoleOverlayArgv -> resolveProfileArgv ->
  assertReadOnlyArgv` no caminho real de reviewer.
- [x] Provar a diferenca entre recurso relativo autoritativo do catalogo e argv
  efetivo absoluto no cwd externo.
- [x] RED com catalogo do Agent Lab diferente do cwd do target.
- [x] Cobrir aceite somente do recurso canonico resolvido e rejeicao de:
  arquivo homonimo local ao target, lookalike absoluto, permission mode errado
  e setting sources enfraquecido.
- [x] GREEN ate a porta de invocacao do provider, sem inferencia Claude real.
- [x] Validar, commitar e retomar o runtime.

### Evidencia do incidente 1

- Comando real: `pnpm lab resume
  data/project-runs/grimperium-d08cac29/semi-imperium-real-01`.
- Estado antes/depois: `crest_selection_workflow` permaneceu
  `RUNNING/FINALIZING`, attempt 1, candidate `be5ff5a...`; target permaneceu
  limpo no mesmo HEAD.
- Stage maximo: `PLAN_READY`; exit 1 no segundo proof de argv do reviewer.
- Nenhuma inferencia de reviewer ocorreu: nao existe review de Crest e a falha
  antecedeu `port.run`; o unico LaunchRecord de Crest continua sendo o worker
  implementer encerrado em 2026-08-27.
- Causa: o resolver canonico converteu
  `dev/profiles/claude-reviewer-readonly.settings.json` no path absoluto exato
  do catalogo, mas `assertReadOnlyArgv` comparou o argv efetivo somente com o
  literal relativo.
- RED: duas regressões falharam pelo `RoleOverlayError`, incluindo a porta de
  reviewer de producao com target externo e doubles de CLI/provider.
- Correcao: a prova efetiva deriva o settings esperado por `resolveProfileArgv`
  usando `profileCatalogRoot` e `repoRoot`; a mesma prova exige exatamente
  `--permission-mode plan` e `--setting-sources project`.
- GREEN: 135/135 focados; `pnpm typecheck` exit 0; `pnpm build` exit 0;
  `pnpm test` 175 arquivos e 2494/2494 testes; `git diff --check` exit 0.
- Commit coerente: `f112c0d28412e291113a97c54ed19bf65634f0b5`.

## Registro de resumes

| # | Estado antes | Stage maximo | Outcome | Provider/target work | Acao seguinte |
|---|---|---|---|---|---|
| 1 | Crest RUNNING/FINALIZING; candidate be5ff5a | PLAN_READY | RoleOverlayError, exit 1 | Nenhum reviewer/target novo | Corrigir proof canonico e validar |
| 2 | Crest RUNNING/FINALIZING; candidate be5ff5a | REVIEWED | HUMAN_REQUIRED com REVIEW_REPAIRABLE, exit 9 | Reviewer Claude read-only revisou o candidate; implementer nao foi relancado | Novo resume deve consumir o REJECT duravel e abrir bounded repair |
| 3 | Crest RUNNING/FINALIZING; REJECT IMPLEMENTATION_DEFECT duravel | PLAN_READY | RetryFailedAttemptError, exit 1 | Nenhum provider/target novo | Corrigir compatibilidade do archive com finalization legado de provenance parcial |
| 5 | Crest RUNNING/FINALIZING attempt 2; candidate c3cd117 | REVIEWED | HUMAN_REQUIRED REVIEW_INVOCATION_FAILED exit 1, stdout descartado | Reviewer Claude opus invocado; exit 1 em 6s; stderr vazio | Preservar stdout/stderr da invocacao falha |
| 6 | Crest FAIL attempt 3; grant one-shot consumido | WORKER_RUNNING | Claude `json` encerrou com `is_error=true`, `terminal_reason=api_error`, HTTP 429; launcher gravou `provider_failure=null`; validation exit 4 porque o teste nao existia | Worker deixou patch parcial sem report/handoff; HEAD permaneceu 5070358 | Corrigir leitura de falha terminal no transporte `json`, validar e recuperar pelo lifecycle oficial |

## Incidente 2 — archive de review repair com provenance parcial legado

- [x] Reproduzir no runtime canonico antes de qualquer novo worker.
- [x] Provar que o FinalizationRecord sela `report_sha256`, mas nao
  `handoff_draft_sha256`, embora o par atual exista e o report corresponda ao
  hash selado.
- [x] Confirmar que provenance de notas do worker e opcional no contrato de
  finalizacao e nao invalida candidate, validacao oficial ou review.
- [x] RED com FinalizationRecord realista que sela somente report.
- [x] Ligar criptograficamente os dois bytes arquivados ao
  ReviewRejectedAttemptRecord sem reescrever evidencia historica.
- [x] Preservar fail-closed para par ausente/incompleto ou hash declarado
  divergente.
- [x] Rodar testes focados e gates do Agent Lab, commitar e retomar o runtime.

## Incidente 3 — review nao parseavel com evidence_paths fantasma

- [x] Confirmar no runtime: attempt 2 sem `reviews/.../attempt-2/review.json`.
- [x] Confirmar no codigo: `launchProjectReviewer` descarta stdout e
  `reviewValidatedCandidate` aponta HUMAN_REQUIRED para `review.json`.
- [x] RED de producao: reviewer devolve prosa nao parseavel com secret;
  evidence_paths inclui review.json inexistente.
- [x] Persistir `ReviewParseFailureRecord` append-only (nao e veredito).
- [x] HUMAN_REQUIRED referencia somente paths existentes; stdout redigido.
- [x] Fail-closed: ausencia de parse nao vira ACCEPT/REJECT nem review.json.

## Incidente 4 — exit nao-zero do reviewer descarta stdout

- [x] Resume #5: reviewer Claude opus exit 1 em ~6s; stderr vazio; stdout
  descartado pelo port; evidence_paths so validation-logs.
- [x] RED: processo/porta de reviewer com exit 1 e envelope no stdout.
- [x] Port passa a lancar ProviderRoleInvocationError com stdout+stderr.
- [x] Persistencia append-only reusa o record de invocacao indisponivel.
- [x] HUMAN_REQUIRED referencia somente paths reais; secrets redigidos.

## Incidente 5 — falha terminal Claude em `json` passa como FINISHED

- [x] Auditar state, LaunchRecord, stdout/stderr, completion, validation logs,
  grant consumido e working tree do attempt 3.
- [x] Provar a causa exata do pytest exit 4: arquivo
  `tests/unit/semi_imperium/test_conformer_selection.py` ausente, sem mudanca de
  config/layout do pytest.
- [x] Provar a falha primaria do provider no envelope preservado:
  `is_error=true`, `terminal_reason=api_error`, `api_error_status=429` e limite
  de sessao, sem report/handoff.
- [x] RED no launcher de producao com profile Claude `--output-format json` e
  envelope terminal valido.
- [x] Isolar o stdout vazio das fixtures: o mesmo `node` direto produz o stream,
  mas `child_process.spawn` aninhado no sandbox retorna exit 0 com zero bytes;
  tratar como bloqueio ambiental e validar esta regressao fora da restricao.
- [x] Ler o objeto unico `json` com o mesmo `providerTerminalFailure` usado pelo
  transporte `stream-json`, sem adivinhar por texto de erro.
- [x] Provar que falha terminal `json` vira `INFRA_ERROR`, entra no LaunchRecord
  e impede validacao de patch incompleto em attempts futuros.
- [x] Rodar testes focados e gates do Agent Lab: regressao 1/1, arquivo focado
  49/49, `pnpm typecheck`, `pnpm build`, `git diff --check` e suite completa
  175 arquivos/2507 testes; registrar a licao ambiental.
- [ ] Commitar a correcao do Agent Lab antes de retomar o runtime.
- [ ] Emitir novo grant one-shot com provenance desta autorizacao continuada e
  retomar o mesmo runtime sem edicao manual do target.

## Auditoria terminal

- [ ] Provar cada uma das sete tasks com estado, attempts, profile/model,
  validation, review, repair/escalation e accepted commit.
- [ ] Provar recuperacao do candidate Crest sem relaunch incorreto.
- [ ] Provar fresh quota e ausencia de autorizacao/billing ampliados.
- [ ] Se `ALL_DONE`, executar somente a suite canonica final do target,
  read-only quanto a reparos manuais.
- [ ] Rodar todos os gates finais do Agent Lab e registrar contagens/exits.
- [ ] Confirmar arvores, HEADs e ausencia de edicao externa do target.
- [ ] Push da branch, abrir uma PR, confirmar `NOT MERGED`.
- [ ] Entregar relatorio requisito a requisito e verdict terminal exato.
