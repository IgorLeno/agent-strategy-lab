# Agent Lab — prova operacional self-hosted

**Data:** 2026-08-24

**Status:** EM EXECUCAO

**Baseline observado:** `main == origin/main == 0fe02178604babc00336a696805ba268f61b4017`, working tree limpa

**Criterio terminal:** primeira self-run real via `pnpm lab run` que publique `ALL_DONE`

## Invariantes

- [x] Preservar todos os runtimes historicos; em particular, nao modificar
  `data/project-runs/self/f6c7fa8e98cc201b-0fe02178604b`.
- [x] Preservar o gate que rejeita metacaracteres de shell em `validation[].argv`.
- [x] Preservar ownership de budget: validation oficial do orquestrador nao
  consome runtime do coding worker.
- [x] Preservar controller pinado, self worktree isolado, integracao
  fast-forward-only, divergence guard e publicacao estreita em `origin/main`.
- [x] Nao iniciar Wave 2, M95-M126 ou qualquer redesign generico.
- [x] Nao modificar nem executar o Augmented Chess; HEAD inicial observado:
  `2f77782cbddce347f4a18d90c2d6b7911de10068`.

## Ciclo 1 — draft corrigivel do planner

Evidencia de entrada:

- runtime: `data/project-runs/self/f6c7fa8e98cc201b-0fe02178604b`;
- ultimo estagio alcancado: `PLANNER_RUNNING`;
- failure stage: `SCHEMA_NORMALIZATION`;
- provider chamado: sim;
- planner chamado: sim, uma vez;
- PlanFile persistido: nao;
- coding worker chamado: nao;
- candidate criado: nao;
- validation oficial iniciada: nao;
- integracao iniciada: nao;
- falha concreta: `routing_budget_integration_regression.validation[0].argv`
  continha metacaractere de shell.

Hipotese confirmada na call graph: `runReviewedPath` delega a
`generateImplementationPlan`, que encerra imediatamente toda a run quando um
draft retornado normalmente falha em um gate deterministico. Nao existe hoje
uma revisao limitada do draft.

- [x] Adicionar regressao no nivel de `generateImplementationPlan` que exija:
  primeiro draft corrigivelmente invalido, feedback deterministico, segundo
  draft completo valido e exatamente duas invocacoes.
- [x] Provar que falha de provider/transport nao e repetida.
- [x] Provar que a segunda falha termina sem terceira invocacao.
- [x] Implementar no maximo uma revisao, sem merge nem correcao semantica do
  control plane; o planner precisa devolver um replacement draft completo.
- [x] Manter todos os gates deterministas inalterados na segunda tentativa.
- [x] Registrar a correcao em `docs/LESSONS.md`.
- [x] Rodar teste focado, `pnpm typecheck`, `pnpm build`, `pnpm test` e
  `git diff --check`.
- [ ] Revisar o diff, criar um commit coerente, confirmar arvore limpa e fazer
  push normal para `origin/main`.

## Acceptance loop

- [ ] Persistir em `/tmp` uma unica Run Directive de acceptance pequena, util,
  com `target.type: self`, `providers.policy: default` e publicacao autorizada
  somente em `origin/main`.
- [ ] Em cada nova run, usar o product path `pnpm lab run`, sem pin manual do
  planner/profile e sem editar o plano gerado.
- [ ] Aguardar estado terminal; silencio do worker nao e travamento.
- [ ] Antes de qualquer novo reparo, registrar: runtime, estagio anterior,
  failure stage, provider/planner/PlanFile/worker/candidate/validation/
  integration.
- [ ] Para blocker tecnico local: reproduzir, corrigir a menor causa estrutural,
  validar, commitar, publicar e iniciar uma nova acceptance.
- [ ] Para falha transitoria clara do provider: verificar estado e repetir a
  mesma acceptance uma vez antes de mudar codigo.
- [ ] Parar apenas em `ALL_DONE` ou em uma fronteira humana genuina definida na
  diretiva da missao.

## Auditoria de conclusao

- [ ] Runtime final observa `PREFLIGHT`, `PLANNER_RUNNING`, `PLAN_READY`,
  `WORKER_RUNNING`, `VALIDATING`, `TASK_ACCEPTED`, `INTEGRATING`, `PUBLISHED`
  e `ALL_DONE`.
- [ ] Coding worker foi realmente lancado, candidate foi produzido e validation
  oficial passou.
- [ ] Self integration foi fast-forward e a publicacao atualizou `origin/main`.
- [ ] `main == origin/main`, working tree limpa e controller integrity preservada.
- [ ] Augmented Chess permanece no SHA esperado e sem modificacao.
- [ ] Registrar neste arquivo o outcome final e os commits de bootstrap.
- [ ] Nao executar outra acceptance depois do primeiro `ALL_DONE`.
