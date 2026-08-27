# Agent Lab — bounded repair para rejeição de review independente

**Data:** 2026-08-27

**Status:** IMPLEMENTADO E VERIFICADO — runtime canônico não retomado

**Baseline Agent Lab:** `3617098b307eddfdce570d15dc2cbeec4c084567`

**Runtime canônico:** `data/project-runs/grimperium-d08cac29/semi-imperium-real-01`

**Candidate rejeitado:** `e0abc6378a204cbb03610a6684f3fd2eb83d9d70`

## Objetivo terminal

Substituir a política incondicional `REVIEW_REJECTED -> HUMAN_REQUIRED` por uma
decisão estrutural e auditável: defeito de implementação contra aceitação já
definida entra no único bounded-repair lifecycle existente; decisão genuína de
produto/escopo/autorização e autonomia seguramente esgotada continuam em
`HUMAN_REQUIRED`. Depois, provar a retomada numa cópia descartável do runtime e
do target sem alterar manualmente Semi-Imperium nem promover o candidate
rejeitado.

## Evidência observada antes do desenho

- [x] Agent Lab limpo em `main == origin/main == 3617098...`.
- [x] Grimperium em `main`, árvore limpa, `HEAD=e0abc637...`, três commits à
  frente de `origin/main`; remote corresponde a `IgorLeno/grimperium_V2.git`.
- [x] Runtime canônico `RESUMABLE`: `molecule_resolution_validation` permanece
  `RUNNING/FINALIZING`, attempt 1, sem `accepted_commit`; base/authorized head
  continuam `3c4e7b1...`.
- [x] `OrchestratedFinalizationRecord` preserva candidate, changed files e duas
  validações oficiais PASS; `CandidateReviewRecord` append-only preserva REJECT.
- [x] A aceitação explícita exige desambiguação de identidades molecularmente
  diferentes; o motivo da review descreve violação concreta desse contrato.
- [x] `reviewValidatedCandidate` envia ambos os caminhos de REJECT — novo ou já
  persistido — diretamente a `reviewBlocked(...)`/`HUMAN_REQUIRED`.
- [x] A retomada executa `resumePendingAcceptance` antes do preflight e retorna
  imediatamente quando a aceitação fica bloqueada; portanto o repair atual
  nunca é consultado.
- [x] O bounded repair existente é de fato bounded e usa a primitive oficial
  `retryFailedAttempt`, bundle append-only, reset seletivo, reabertura a READY,
  `previous_attempt_diagnostics`, fresh worker e escalation configurada.
- [x] Essa primitive está corretamente especializada em validation FAIL:
  requer `CompletionRecord FAIL`, ao menos uma validação oficial malsucedida e
  ausência de candidate. Forjar esses fatos para uma review REJECT violaria os
  schemas e a integridade do lifecycle.
- [x] O authorization snapshot canônico inclui `BOUNDED_REPAIR` no boundary
  autônomo e mantém `SCOPE_EXPANSION`,
  `UNRESOLVED_ARCHITECTURE_OR_PRODUCT_DECISION`, `INSUFFICIENT_EVIDENCE`,
  `SAFE_ESCALATION_EXHAUSTED` e fronteiras de safety/billing como capacidades
  human-gated. A classificação proposta reutiliza essa separação; não concede
  autoridade nova.

## Decisão arquitetural proposta

### 1. Classificação estruturada na fronteira de review

Evoluir o contrato de saída do reviewer para incluir uma disposição fechada,
independente da prosa do motivo. Taxonomia mínima proposta:

- `IMPLEMENTATION_DEFECT`: candidate viola aceitação/constraints já definidas;
- `REQUIREMENT_OR_SCOPE_DECISION`: falta decisão de produto, ciência ou escopo;
- `SAFETY_OR_AUTHORIZATION_DECISION`: correção exigiria ultrapassar segurança,
  credencial, billing, deploy/efeito externo ou autorização;
- `INSUFFICIENT_EVIDENCE`: não há prova suficiente para continuação autônoma.

Somente `IMPLEMENTATION_DEFECT` pode habilitar reparo, e ainda depende de
`BOUNDED_REPAIR`, base íntegra e budget disponível. O texto `reason` nunca
concede autonomia. `ACCEPT` não carrega disposição de rejeição.

Novos REJECTs persistem a disposição no `CandidateReviewRecord`. Records
legados continuam legíveis. Um REJECT legado sem disposição não será inferido
por keyword: uma classificação read-only, fresca e estruturada reexamina o
packet autoritativo e o veredito já persistido, publicando um record append-only
ligado por hashes ao review/candidate. Falha, divergência ou classificação não
reparável permanece `HUMAN_REQUIRED`.

Essa classificação legada é uma invocation de reviewer e, portanto, exige a
mesma autorização `CONFIGURED_SUBSCRIPTION_WORKER`, preflight de assinatura,
billing subscription-only, isolamento read-only e limite de máquina das reviews
normais. Ela não é executada por dry-run. Se ainda não houver classificação
persistida, o dry-run relata essa próxima ação necessária sem chamar provider e
sem presumir a disposição; depois de publicada, preview e execução consomem o
mesmo record.

### 2. Uma única máquina de bounded repair, com fontes tipadas

Generalizar o lifecycle de rejeição já usado por validation, sem criar outro
loop. A fonte capability-bearing passa a ser uma união fechada:

- `OFFICIAL_VALIDATION_FAILURE` (comportamento atual, invariantes intactas);
- `REPAIRABLE_REVIEW_REJECTION` (novo record próprio e fatos próprios).

O novo record de attempt rejeitado por review ligará task/attempt/base/profile,
candidate/finalization/review/classification por hashes, changed files, bundle
preservado, motivo objetivo e timestamp. Ele não alegará validation FAIL: as
validações continuam registradas como PASS e o veredito continua sendo REJECT.

A mesma política contará fontes capability-bearing conectadas, atravessará os
records capability-neutral já existentes, autorizará no máximo o repair já
previsto e encaminhará exaustão ao mesmo `onRepairExhausted`/ladder. Nenhum
segundo contador ou laço de retry será criado.

### 3. Rejeitar, preservar, voltar à base e só então reabrir

Para `REPAIRABLE_REVIEW_REJECTION` autorizado:

1. conferir state, HEAD, candidate, finalization, review, classificação e hashes;
2. preservar patch/bundle e inbox do attempt N em caminhos append-only;
3. preservar os records originais nos caminhos atuais — nunca sobrescrever;
4. mover o checkout descartável do candidate rejeitado para o
   `authorized_head_sha`/base provado, sem aceitar/adotar o commit;
5. reabrir somente a mesma task como READY, mantendo `attempts` monotônico;
6. lançar attempt N+1 em sessão nova pelo fluxo canônico.

Toda mutação ocorre depois de toda evidência necessária estar publicada e
validada. Crash intermediário deve ser retomável/idempotente. Divergência de
base, arquivo, hash ou record falha fechado.

### 4. Diagnóstico canônico no TaskPacket

Evoluir `PreviousAttemptDiagnostics` de modo aditivo para representar a fonte
da rejeição. No caso de review, transportar somente fatos estruturados:

- attempt/profile/candidate;
- `reason_code=REPAIRABLE_REVIEW_REJECTION`;
- review disposition e reason;
- acceptance e validation já existentes no TaskPacket;
- changed files e referências estáveis aos records/evidence.

Não transportar transcript, chain-of-thought ou conversa de reviewer. O
worker novo continua recebendo um único canal de entrada e uma sessão fresca.

### 5. Retomada e dry-run compartilham a mesma decisão

`inspectPendingAcceptance` continuará read-only. A decisão comum deve expor
três estados: promoção permitida, rejeição reparável e bloqueio humano. O
runtime real reconcilia a rejeição reparável no mesmo lock antes do preflight;
o dry-run relata a próxima ação sem escrever, resetar ou chamar provider.

O `HUMAN_REQUIRED` histórico do runtime canônico permanece evidência. A nova
execução pode produzir um record de reconciliação posterior, nunca reescrever
o evento antigo.

## Regressões obrigatórias

- [x] REJECT `IMPLEMENTATION_DEFECT` + autoridade + budget: sem gate humano,
  review/candidate preservados, archival/reopen e repair selecionado.
- [x] REJECT -> repair -> validation PASS -> review ACCEPT: task PASS apenas no
  candidate reparado; candidate original segue histórico e não aceito.
- [x] Rejeições repetidas: bound determinístico, sem loop; terminal informa
  autonomia segura esgotada.
- [x] `REQUIREMENT_OR_SCOPE_DECISION`: `HUMAN_REQUIRED`, zero repair.
- [x] `SAFETY_OR_AUTHORIZATION_DECISION`/`INSUFFICIENT_EVIDENCE`: fail closed.
- [x] `IMPLEMENTATION_DEFECT` sem `BOUNDED_REPAIR`: zero launch e gate de
  autorização explícito.
- [x] Records/bundles N permanecem byte-idênticos após N+1.
- [x] Repair usa nova invocation/session e só `TaskPacket` estruturado.
- [x] Caminho existente de validation FAIL conserva comportamento e budget.
- [x] REJECT legado é classificado estruturalmente e ligado por hash; prosa
  isolada nunca decide.
- [x] Dry-run relata repair/human corretamente e permanece zero-mutation.
- [x] Crash points antes/depois de publish, reset e reopen convergem sem perda.

## Arquivos inicialmente esperados

- `dev/lib/project-orchestrate.ts`
- `dev/lib/project-run.ts`
- `dev/lib/candidate-review.ts`
- `dev/lib/finalize-orchestrated.ts`
- `dev/lib/automatic-repair.ts`
- `dev/lib/retry-failed.ts` (generalização cuidadosa; nome pode ser ajustado)
- `dev/lib/failed-attempt-bundle.ts`
- `dev/lib/schemas.ts`
- `dev/lib/records.ts`
- `dev/lib/orchestrate.ts`
- testes focados correspondentes e fixture do reviewer

O conjunto final será reduzido ao mínimo provado pela implementação; planner,
routing, profiles, billing e Semi-Imperium ficam fora de escopo.

## Gates

- [x] testes unitários focados de schema/classificação/record/retry;
- [x] testes de `project-run`, `project-orchestrate`, `finalize-orchestrated`,
  `automatic-repair` e `retry-failed` afetados;
- [x] e2e do lifecycle REJECT -> repair -> ACCEPT e exaustão;
- [x] `pnpm typecheck`;
- [x] `pnpm test`;
- [x] `pnpm build`;
- [x] `git diff --check`;
- [x] comparação explícita com o comportamento baseline onde aplicável.

## Prova de integração real sem risco canônico

- [x] Criar cópia/clone descartável do Grimperium no candidate e cópia isolada
  do runtime `semi-imperium-real-01`.
- [x] Confirmar hashes byte a byte dos records históricos antes do resume.
- [x] Rodar primeiro dry-run e depois lifecycle real somente na cópia até
  provar `REVIEW_REJECTED -> REPAIR` e fresh worker launch/selection.
- [x] Verificar que a cópia voltou à base autoritativa antes do repair e que o
  candidate rejeitado não virou accepted/adopted.
- [x] Recomparar árvore, HEAD, state e records do Grimperium/runtime canônicos;
  devem permanecer intocados.
- [x] Recomendar o comando de retomada do MESMO runtime canônico. Não executá-lo
  sem um novo check-in operacional, pois ele modifica o target real.

## Fora de escopo

- editar `resolve_name` ou qualquer arquivo de Semi-Imperium manualmente;
- mudar aceitação, planner, routing, `evidence_balanced`, profiles ou billing;
- aceitar/promover o candidate rejeitado;
- reduzir review, diversidade ou gates oficiais;
- criar retries ilimitados, taxonomia especulativa ou framework paralelo;
- iniciar runtime novo canônico, fazer commit, push ou efeitos externos.

## Outcome

Implementação concluída em 2026-08-27. A prova descartável publicou uma
classificação fresca `IMPLEMENTATION_DEFECT`, consumiu-a idempotentemente após
uma queda injetada por inbox ausente, restaurou `HEAD` à base autorizada
`3c4e7b1...`, selecionou `REPAIR` e lançou uma sessão fresca Sol High. O repair
real terminou em validation oficial FAIL no teste de regressão exato e o
lifecycle parou em `AUTOMATIC_REPAIR_EXHAUSTED`, sem terceiro launch. Isso prova
tanto a nova transição quanto o bound; o e2e determinístico cobre o desfecho
alternativo REJECT -> repair -> validation PASS -> review ACCEPT -> PASS.

O Grimperium canônico permaneceu limpo em `e0abc637...`; state, review e
finalization canônicos não foram alterados. A retomada canônica continua fora
desta implementação e exige check-in operacional separado.
