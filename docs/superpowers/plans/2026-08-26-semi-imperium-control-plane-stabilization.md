# Agent Lab — estabilizacao iterativa do planning Semi-Imperium

**Data:** 2026-08-26

**Status:** CONCLUIDO — `PLAN_READY` e handoff provados em target descartavel;
implementacao interrompida deliberadamente antes de mutacao material

**Branch:** `fix/avc-retry-isolation`

**Baseline Agent Lab:** `eb28d1d7a3590a20f267bf8b18bc5a14d68f14e8`

**Baseline Grimperium canonico:** `main == origin/main == 2701620a959eca95e9596172c775812d38c64f1d`; arvore limpa

## Objetivo terminal

Usar a Run Directive real do Semi-Imperium como teste de integracao do
control plane, corrigindo somente defeitos demonstrados do Agent Lab, ate que
o planning atinja `PLAN_READY` (incluindo deliberation quando habilitada), o
handoff seja provado com alvo descartavel, ou exista um bloqueio legitimo do
target/provider/environment/humano.

## Invariantes

- [x] Confirmar que o baseline contem `87f761e` (evidencia por tentativa) e
  `eb28d1d` (canonicalizacao de `schema_version` aninhada).
- [x] Ler os drafts, validations e revision request das duas tentativas de
  `semi-imperium-retry-02`; nao inferir pelo resumo terminal.
- [x] Capturar HEAD, remote e arvore limpa do Grimperium canonico.
- [x] Nao modificar nem executar implementacao no Grimperium canonico.
- [x] Preservar drafts crus e evidencia append-only por tentativa.
- [x] Preservar schema estrito: omissao herdavel de metadata v1 continua
  aceita; conflito explicito continua rejeitado.
- [x] Preservar `unbounded_rollback_boundary` e demais gates com justificativa
  concreta; nao tornar toda task `ATOMIC`.
- [x] Nao alterar billing, provider policy ou `evidence_balanced`.
- [x] Nao codificar task ids, paths ou detalhes Semi-Imperium no produto.

## Evidencia e hipotese inicial

`semi-imperium-retry-02` rejeitou primeiro `mopac_minimum_workflow` e pediu
replacement completo. A revisao separou otimizacao, classificacao de minimo e
recovery, mas as tres unidades permaneceram `critical` com dependencias
cientificas legitimas e foram rejeitadas novamente por `retry_not_isolated`.
A hipotese a provar contra o lifecycle e: `blocked_by` descreve precedencia no
DAG, nao compartilhamento necessario da fronteira de retry/rollback.

## Plano verificavel

- [x] **1. Provar a semantica do lifecycle.** Rastrear selecao por DAG,
  `authorized_head_sha`, base de cada task, candidate/accepted commit, bounded
  repair e rollback/recovery. Registrar se predecessores estao aceitos e
  autoritativos antes do downstream e de onde um retry realmente parte.
- [x] **2. Reproduzir antes do patch.** Adicionar regressao focada com uma DAG
  legitima: predecessor separavel e downstream `critical`, delimitada e
  validavel. Executar o teste contra a implementacao antiga e registrar a falha
  da expectativa corrigida.
- [x] **3. Aplicar a menor correcao coerente.** Alterar apenas a fronteira AVC
  cuja provenance nao prova nao-isolamento; manter o vocabulario historico se
  necessario e nao inventar novo sinal sem propriedade observavel existente.
- [x] **4. Provar comportamento focado.** Cobrir downstream critico dependente,
  conflito/ausencia de sinal, provenance dos hard blocks remanescentes e
  `unbounded_rollback_boundary`.
- [x] **5. Rodar regressao completa.** Executar teste focado, `pnpm typecheck`,
  `pnpm test`, `pnpm build` e `git diff --check`, com exit status explicitos.
- [x] **6. Criar commit coerente.** Revisar escopo/impacto e commitar apenas o
  defeito comprovado; nao fazer push sem autorizacao separada.
- [x] **7. Reexecutar planning real em runtime novo.** Reusar a Run Directive
  integral e `evidence_balanced`; nunca sobrescrever runtimes anteriores.
  Parar antes de qualquer mutacao do Grimperium canonico.
- [x] **8. Classificar cada novo outcome.** Para target plan defect, planner
  contract defect, control-plane defect, provider/environment limitation ou
  human decision, inspecionar a evidencia primaria e corrigir somente novos
  defeitos concretos do Lab.
- [x] **9. Iterar ate condicao terminal util.** Para qualquer prova de handoff
  posterior a `PLAN_READY`, usar clone/copia descartavel do Grimperium no SHA
  base e impedir publicacao/efeito externo.
- [x] **10. Auditoria final requisito a requisito.** Revalidar os dois fixes
  anteriores, AVC remanescente, billing/providers, todos os runtimes novos e a
  identidade/limpeza byte-observavel do Grimperium canonico; produzir comandos
  exatos de integracao e proxima execucao real.

## Gate de implementacao

A Run Directive recebida autorizou a estabilizacao iterativa e a correcao local
reversivel. As etapas 2–9 sao iterativas: um novo erro do control plane volta
para reproducao e causa-raiz; um erro externo legitimo encerra sem redesenho
oportunista.

## Prova do lifecycle antes do patch

- `selectNextTask` so libera uma task quando cada `blocked_by` esta `PASS`.
- `prepareNextTask` exige arvore limpa e `HEAD == authorized_head_sha`; o
  `base_sha` do packet e esse HEAD autoritativo.
- O fechamento/finalizacao exige candidate filho direto do `base_sha`; somente
  depois de validation e eventual review o state recebe `PASS`,
  `accepted_commit = candidate` e `authorized_head_sha = candidate`.
- Um FAIL de validation nao desfaz predecessores: o repair preserva a evidencia
  e reseta somente os arquivos da tentativa para `authorized_head_sha`, mantendo
  o HEAD e os commits aceitos anteriores. O novo attempt parte dessa mesma base.
- Conclusao: `blocked_by` prova precedencia e estado aceito anterior; nao prova
  que retry ou rollback do downstream alcance as dependencias.

Baseline focado, antes de qualquer mudanca: 3 arquivos de teste, 38 testes
passando (`decomposition`, evidencia por tentativa e canonicalizacao de versao).

## Evidencia RED/GREEN e correcao

- RED: `pnpm exec vitest run test/planner/validate-plan.test.ts` terminou com
  1 falha e 38 passes; o downstream critico e delimitado recebeu
  `DECOMPOSITION_REQUIRED` quando a expectativa correta era
  `REVIEWED_REQUIRED`.
- Correcao: `retry_not_isolated` continua aceito pelo schema historico, mas nao
  e mais emitido a partir de `risk=critical + blocked_by`. Nenhuma nova heuristica
  substitui a inferencia removida.
- GREEN focado: 60/60 em `validate-plan` + `decomposition`; planner completo:
  169/169.
- Gates ja concluidos: `pnpm typecheck` exit 0; `pnpm build` exit 0;
  `git diff --check` exit 0.
- Duas execucoes de `pnpm test` fora do sandbox tiveram 2306/2307 e a mesma
  falha sensivel a carga em `failure-paths`: o processo filho nao apareceu no
  snapshot antes do timeout. O arquivo isolado passou 3/3.
- Regressao completa com concorrencia limitada: `pnpm exec vitest run
  --minWorkers=8 --maxWorkers=8`, 164 arquivos e 2307/2307 testes, exit 0.

## Outcome

- Defeito do AVC corrigido e commitado em `161875e`.
- Com autorizacao explicita de envio por assinatura, `semi-imperium-retry-03`
  produziu plano autorizado, deliberacao cross-provider, `PLAN_READY` e
  `WORKER_RUNNING` em clone descartavel. O processo foi interrompido com exit
  130 antes de implementacao; nenhum target mudou.
- A evidencia primaria do retry-03 revelou **planner contract defect**: o plano
  persistido continha cada `PlannedTask` completa, mas `planViewOf` omitia dez
  campos e convertia validacoes estruturadas em strings, enquanto o prompt
  exigia avaliacao contra o contrato completo. Os dois deliberadores reagiram
  coerentemente a essa visao enganosa.
- RED: a regressao de `planViewOf` falhou por receber a projecao de sete campos.
  Correcao minima: `DeliberationPlanView.tasks` reutiliza `PlannedTask` e recebe
  diretamente cada task canonica. O overlay continua read-only e nao ganhou
  filesystem, processo, provider ou state.
- GREEN: modulo 17/17; planner 170/170; `pnpm typecheck` e `pnpm build` exit 0;
  suite completa fora do sandbox 164 arquivos e 2308/2308 testes, exit 0;
  `git diff --check` exit 0. Correcao commitada em `99e17b9`.
- `semi-imperium-retry-04` usou runtime novo e clone independente no mesmo SHA.
  O draft inicial foi `AUTHORIZED` sem issues e gerou sete tasks. Claude Opus 5
  High levantou quatro lacunas materiais reais; Codex Sol High propôs a menor
  revisao correspondente; ela foi `ACCEPTED_BY_GATES`, alterando o plano de
  `aec3d1c...` para `cac456c...`. A diversidade cross-provider foi satisfeita.
- O run publicou `PLAN_READY` para a versao revisada e chegou a
  `WORKER_RUNNING` na primeira task. Foi interrompido deliberadamente com exit
  130 antes de trabalho material. O PID registrado nao sobreviveu; clone e
  Grimperium canonico permanecem limpos em `2701620a...`.
- Classificacao terminal: **SUCCESS — valid plan plus deliberation transition e
  planning-to-execution handoff**. `MAX_TURNS_REACHED` encerrou a deliberacao,
  mas nao anulou a revisao aceita nem expandiu autorizacao. Billing continuou
  subscription-only, policy `evidence_balanced`, publish negado e nenhum push.
