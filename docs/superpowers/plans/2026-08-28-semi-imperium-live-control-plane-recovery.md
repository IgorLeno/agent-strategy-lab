# Agent Lab — recuperacao operacional Semi-Imperium ate ALL_DONE

**Data:** 2026-08-28

**Status:** EM ANDAMENTO

**Branch unica:** `fix/semi-imperium-live-control-plane-recovery`

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
- [ ] Revisar escopo e criar um commit coerente do incidente.
- [ ] Retomar o mesmo runtime pela interface publica e repetir o ciclo.

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
- [ ] Validar, commitar e retomar o runtime.

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

## Registro de resumes

| # | Estado antes | Stage maximo | Outcome | Provider/target work | Acao seguinte |
|---|---|---|---|---|---|
| 1 | Crest RUNNING/FINALIZING; candidate be5ff5a | PLAN_READY | RoleOverlayError, exit 1 | Nenhum reviewer/target novo | Corrigir proof canonico e validar |

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
