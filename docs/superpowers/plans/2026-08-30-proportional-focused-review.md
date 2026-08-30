# Agent Lab — proportional review e focused re-review

**Data:** 2026-08-30

**Status:** CONCLUIDO (PR aberta, sem merge)

**Branch:** `feat/proportional-focused-review`

**BASE_SHA:** `6593be2e266e176951be9f4387a3f8a7778a7e7c`

## Objetivo

Reduzir amplificacao de model review removendo `REPAIR` e escalacao como
motivos autonomos de review, distinguir findings blocking/advisory e limitar a
review posterior a repair de REJECT ao finding original e superficie impactada,
sem enfraquecer review obrigatoria, failover, PR A ou recovery do PR #16.

## Limites

- [x] Partir do `main` remoto pos-PR #17, limpo e em fast-forward.
- [x] Confirmar separacao `HumanAuthority` / `TechnicalBlocker` e integridade
  fail-closed de recovered work antes de editar producao.
- [x] Nao modificar gates de autorizacao, billing, credenciais ou efeitos
  externos.
- [x] Nao implementar staged validation, granularidade de planner, budgets ou
  retries arbitrarios.
- [x] Nao tocar nos advisories conhecidos do PR A sem dependencia direta.
- [ ] Nao mesclar a PR.

## 1. Baseline e hot path

- [x] Auditar o runtime historico Semi-Imperium read-only e registrar contagens
  factuais, UNKNOWN e evidencia de repeticao.
- [x] Rastrear producao de run/resume ate review, reject, repair, re-review e
  acceptance.
- [x] Registrar o modelo BEFORE e confirmar/rejeitar hipoteses de amplificacao.

### Baseline factual — `semi-imperium-real-01` (read-only)

| fato | valor |
| --- | --- |
| tasks | 7 (6 PASS, 1 INFRA_ERROR) |
| attempts com finalization | 11 |
| operational-attempts com telemetria | 13 (attempt 1 de `crest_selection_workflow` sem record: UNKNOWN) |
| implementer launches por papel | 6 initial + 7 repair registrados |
| escalation launches declarados (`escalated_from_profile_id`) | 0 — a troca de profile em `crest` attempt 4 nao ficou declarada: UNKNOWN |
| reviewer invocations com evidencia durável | 23 (11 `review.json` + 12 `unparseable-invocation-*`) |
| vereditos utilizaveis | 11 (6 ACCEPT, 5 REJECT) |
| invocations indisponiveis/malformadas | 12 (10 `REVIEW_INVOCATION_FAILED`, 2 `REVIEW_VERDICT_NOT_PARSEABLE`) |
| reviewer failovers | 2 attempts: `calculate` attempt 3 (4 falhas antes do ACCEPT) e `crest` attempt 4 (7 falhas, 6 delas do MESMO provider `opencode-go`) |
| REJECT dispositions | 4 IMPLEMENTATION_DEFECT + 1 REJECT legado sem disposition |
| review-driven repairs | 5 `review-rejected-attempt.json` |
| validation-driven repairs | 2 `validation-failed-attempt.json` |
| reviews repetidas na mesma lineage | `crest` 3, `calculate` 2, `molecule` 2, `mopac` 2 |
| wall-clock somado dos attempts | 11.011.631 ms (~3h03) |
| wall-clock e tokens de review | NAO registrados — UNKNOWN |

Toda finalization historica declara `required: true` com `diversity_requirement`
`preferred` (risk high) ou `required` (risk critical). Nenhuma review daquela run
existia SOMENTE por repair ou escalation: a amplificacao real foi review GERAL
repetida na mesma lineage e churn de disponibilidade de reviewer.

## 2. Ciclos RED-GREEN focados

- [x] RED/GREEN: repair e escalacao nao exigem review por si mesmos; risco e
  forca de verificacao continuam autoritativos e explicaveis.
- [x] RED/GREEN: findings advisory nao rejeitam, reparam ou reiniciam lifecycle;
  acceptance/correctness/integrity defects continuam blocking.
- [x] RED/GREEN: review-driven repair cria focused re-review estruturada,
  vinculada ao finding original, candidate reparado e fingerprints atuais.
- [x] RED/GREEN: ACCEPT/REJECT validos encerram selecao; indisponibilidade
  permite failover autorizado e failure-domain provado evita repeticao.
- [x] Rodar regressao focada apos cada ciclo e revisar a menor solucao coerente.

## 3. Validacao final

- [x] Rodar `pnpm typecheck`.
- [x] Rodar `pnpm test` (2700 passed / 182 files).
- [x] Rodar `pnpm build`.
- [x] Rodar `git diff --check`.
- [x] Fazer uma unica review final genuinamente independente no escopo estrito.

## 4. Entrega

- [x] Incorporar apenas finding blocking da review final, se houver, com
  verificacao focada e gates completos novamente.
- [x] Registrar outcome neste plano e lição somente se ocorrer correcao.
- [x] Commitar uma mudanca coerente, fazer push e abrir uma PR sem merge.
- [x] Entregar baseline, before/after, counterfactuals, gates, review e
  recomendacao Phase 2 sem alegar economia real nao medida.

## Outcome

Gates finais: `pnpm typecheck`, `pnpm test` (2703 passed / 182 files), `pnpm build`
e `git diff --check` — todos limpos.

A review final independente (contexto fresco, escopo estrito das oito perguntas)
devolveu tres findings BLOCKING, todos procedentes e corrigidos nesta mesma PR:

1. A conversao advisory-only ignorava `rejection_disposition`: um REJECT de
   `REQUIREMENT_OR_SCOPE_DECISION` / `SAFETY_OR_AUTHORIZATION_DECISION` /
   `INSUFFICIENT_EVIDENCE` com findings apenas ADVISORY virava ACCEPT e pulava a
   fronteira humana do PR A. A conversao passou a exigir
   `IMPLEMENTATION_DEFECT` declarado.
2. `findings` malformados geravam correcao protocolar, e a correcao redecide do
   zero — um REJECT valido podia virar ACCEPT por erro de forma na lista.
   Findings passaram a ser aditivos: malformados valem como ausentes e nunca
   descartam um veredito que ja satisfaz o contrato.
3. Remover o acoplamento lifecycle deixou a exigencia de review do candidate
   REJEITADO sem invariante: `confidence` varia entre attempts (readiness vem de
   inspecao fresca), entao o repair podia nascer sem review e virar PASS sem que
   ninguem verificasse o defeito bloqueante. Um `ReviewRejectedAttemptRecord`
   ainda nao verificado passou a ser razao de review por si so
   (`unresolved_review_reject=attempt N`), com busca para tras atravessando
   attempts INFRA/validation-failed.

## Licao

```
[2026-08-30] Contexto: PR B removeu repair/escalation como razoes de review.
Erro: remover o acoplamento de lifecycle sem substituir a INVARIANTE que ele
sustentava por acidente — um REJECT bloqueante nao verificado deixou de exigir
review quando o assessment do attempt seguinte, com inspecao fresca, mudou de
opiniao.
Regra: ao remover uma condicao que forcava um gate, enumerar o que aquela
condicao garantia na pratica e reancorar cada garantia em fato proprio antes de
apagar a condicao.
```
