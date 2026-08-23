# Operational Boundary Audit — Wave 1

> Escopo: SOMENTE as fronteiras que uma execução operacional real atravessa
> entre `ProjectIntake` e `History`. Não é uma análise geral do codebase.
>
> Origem: primeiro piloto real (Augmented Chess, work unit
> `foundation_app_scaffold`), que produziu 7 blockers antes de qualquer task
> chegar a PASS.
>
> Baseline auditado: `4751aa1e5a7bd374c5721cc4dd52482e6c82520c`.

## Baseline verificado localmente

Antes de qualquer alteração, no ambiente oficial/local:

| Gate | Resultado |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm build` | PASS |
| `pnpm test` | PASS — 145 arquivos, 2057 testes, 0 falhas |
| `git diff --check` | limpo |

Relato externo de regressão em ambiente containerizado:

| Relato | Classificação |
|---|---|
| regressão do access-contract | **NOT REPRODUCED** — `test/dev/access-contract.test.ts` passa local |
| failures de timing SIGTERM/timeout | **NOT REPRODUCED** — suite de runner/timeout passa local |

Conclusão: o baseline do Lab está compreendido e verde. Os relatos são
**ENVIRONMENT-SPECIFIC** ao container, não regressões do repositório. Nenhuma
mudança desta onda foi motivada por eles.

## O padrão

O piloto não encontrou 7 bugs independentes. Encontrou 7 instâncias de um
padrão:

```text
INTERNAL CONTRACT ASSUMPTION
        ↓
REAL WORLD DISAGREES
        ↓
HUMAN_REQUIRED / CRASH
        ↓
manual maintenance
```

A causa estrutural comum: **o worker é tratado como autoridade sobre fatos que
o orquestrador consegue derivar sozinho.** O `AgentCompletionReport` declara
`changed_files`; o orquestrador compara essa declaração com o Git; qualquer
divergência trava a work unit — mesmo quando o Git sozinho já descreve um
candidate perfeitamente válido.

## Ordem de prova usada

Nenhuma premissa foi provada com inferência paga quando um degrau mais barato
bastava:

1. inspeção estática de código/contrato;
2. `--version` / `--help` / config da CLI local;
3. probe determinístico local (`codex sandbox`);
4. probe real da CLI sem inferência;
5. inferência real — **não foi necessária nesta auditoria**.

Custo de inferência da auditoria: **zero**.

---

## Fronteiras

### A. Provider argv construction — `PROVEN`

- **ASSUMPTION**: as flags que o launcher gera são aceitas pela versão instalada da CLI.
- **SOURCE OF TRUTH**: `LauncherProfile.argv` (`dev/profiles/*.yaml`), resolvido por `resolveProfileArgv` (`dev/lib/profile.ts:193`).
- **HOW PROVEN**: `codex exec --help` e `claude --help` na instalação real.
- **REAL EVIDENCE**: `codex-cli 0.149.0` aceita `exec --json --strict-config --ignore-user-config --sandbox workspace-write --ephemeral --ignore-rules --model -c/--config --add-dir`. `claude 2.1.241` aceita `--print --output-format --model --effort --settings --setting-sources --permission-mode --strict-mcp-config --no-session-persistence --add-dir`. Todas as flags dos profiles existem.
- **FAILURE IF WRONG**: spawn falha ou flag ignorada silenciosamente → policy não imposta.
- **SEVERITY**: alta.
- **ACTION**: nenhuma correção necessária. Coberto por teste de contrato de CLI real (Fase 3).

> **Achado colateral**: `src/adapters/claude/invocation.ts` e
> `src/adapters/codex/invocation.ts` constroem argv que **não é usado no
> caminho operacional** (nenhum importador fora de `src/adapters`). Eles
> divergem dos profiles reais — o adapter emite `--output-format stream-json`,
> o profile usa `json`. Classificação: `FIXTURE_ONLY`, pertencente ao plano
> experimental. Não é bug operacional; é ruído de leitura. Não alterado nesta
> onda.

### B. Provider output envelope parsing — `PARTIALLY_PROVEN`

- **ASSUMPTION**: o adapter interpreta o envelope real da CLI Claude.
- **SOURCE OF TRUTH**: `dev/lib/claude-stream.ts`, `dev/lib/claude-usage.ts`, `src/adapters/claude/parser.ts`.
- **HOW PROVEN**: profiles operacionais usam `--output-format json` (objeto único), não `stream-json`. `usesClaudeStreamJson` (`dev/lib/launch.ts:358`) seleciona o parser pelo argv real do profile, não por suposição.
- **FAILURE IF WRONG**: usage/tokens ficam `UNKNOWN` — degradação de telemetria, não bloqueio.
- **SEVERITY**: média.
- **ACTION**: nenhuma nesta onda. A seleção já é derivada do argv; o campo é `UNKNOWN ≠ 0` por contrato, e após 2K telemetria degradada não bloqueia progresso.

### C. Filesystem/sandbox permissions — `PROVEN`

- **ASSUMPTION**: os writable roots que o contrato declara são efetivamente concedidos pelo sandbox real.
- **SOURCE OF TRUTH**: `deriveWorkerAccessContract` + `translateAccessContract` (`dev/lib/access-contract.ts:153,410`), reconferido por `readEffectiveAccess` a partir do argv FINAL.
- **HOW PROVEN**: probe determinístico local com `codex sandbox`, zero inferência.
- **REAL EVIDENCE**:
  ```
  # sem o grant:
  codex sandbox -c 'sandbox_mode="workspace-write"' -- touch $D/outbox/x
  → touch: ... 'Sistema de arquivos somente para leitura'   (exit 1)

  # com a chave que translateAccessContract emite:
  codex sandbox -c 'sandbox_mode="workspace-write"' \
    -c 'sandbox_workspace_write.writable_roots=["'$D'/outbox"]' -- touch $D/outbox/x
  → exit 0, arquivo criado
  ```
- **FAILURE IF WRONG**: worker não consegue escrever o outbox do protocolo → attempt inteiro perdido (blocker #1 do piloto).
- **SEVERITY**: crítica.
- **ACTION**: já corrigido em `167b30b`. Confirmado contra a CLI real, não só contra fixture.

### D. HOME / cache / network — `PROVEN`

- **ASSUMPTION**: `network.dependency_fetch` do contrato liga rede de verdade para `npm install`.
- **SOURCE OF TRUTH**: `sandbox_workspace_write.network_access` emitido por `translateAccessContract`.
- **HOW PROVEN**: mesmo probe determinístico.
- **REAL EVIDENCE**:
  ```
  # sem grant:  getent hosts registry.npmjs.org → exit 2 (sem resolução)
  # com grant:  getent hosts registry.npmjs.org → 2606:4700::6810:522 ... exit 0
  ```
- **FAILURE IF WRONG**: instalação de dependência falha dentro do worker; a work unit vira falha de implementação aparente.
- **SEVERITY**: crítica.
- **ACTION**: nenhuma. `HOME` sanitizado + `CODEX_HOME` preservado já separam credencial de configuração pessoal.

### E. Environment/credential isolation — `PROVEN`

- **ASSUMPTION**: subscription-only; nenhuma credencial de API atravessa a fronteira.
- **SOURCE OF TRUTH**: `env_allowlist` do profile + `forbidden_flags` (`--bare`, `--api-key`, `--with-api-key`, `--with-access-token`) + `dev/lib/billing.ts` + `dev/lib/credentials`.
- **HOW PROVEN**: allowlist é fechada (não há `ANTHROPIC_API_KEY` em nenhum profile); `claude auth status --json` exigido no preflight com `authMethod=claude.ai`.
- **FAILURE IF WRONG**: cobrança não autorizada — fronteira humana.
- **SEVERITY**: crítica.
- **ACTION**: nenhuma. **Permanece fail-closed nesta onda por decisão explícita** (2K, exceção).

### F. Prompt-delivered paths — `PROVEN`

- **ASSUMPTION**: paths relativos no argv do profile resolvem contra a raiz certa.
- **SOURCE OF TRUTH**: `resolveProfileArgv` (`dev/lib/profile.ts:193`).
- **HOW PROVEN**: leitura direta — quando `catalogRoot !== workerCwd`, todo token que pareça resource path relativo é reescrito contra o catálogo do Lab.
- **FAILURE IF WRONG**: `--settings dev/profiles/claude-build-worker.settings.json` resolveria contra o repositório ALVO (blocker #3 do piloto), carregando permission policy inexistente.
- **SEVERITY**: alta.
- **ACTION**: já corrigido. Coberto por teste de runtime externo (Fase 3).

### G. Git working tree assumptions — `CONTRADICTED_BY_REAL_RUN` → corrigido nesta onda

- **ASSUMPTION**: o conjunto de arquivos do candidate é `report.changed_files`, e o Git só confirma.
- **SOURCE OF TRUTH (antes)**: `loadSource` em `dev/lib/finalize-orchestrated.ts` — `exactFiles(report.changed_files, ...)`, e depois `assertExactFiles(await workingTreeFiles(...), source.files)`.
- **REAL EVIDENCE**: state do piloto, `foundation_app_scaffold`, attempt 3:
  ```
  arquivos reais divergem do report:
    real   [..., src/chess/.gitkeep, src/game/.gitkeep, ...]
    report [..., src/chess/.gitkeep, src/coverage/.gitkeep, src/game/.gitkeep, ...]
  ```
  Diferença de UM path. `src/coverage/.gitkeep` existe no filesystem, mas
  `.gitignore: coverage/` faz o Git não representá-lo.
- **FAILURE IF WRONG**: task fica `RUNNING/FINALIZING` indefinidamente. Nenhum candidate é derivado, nenhuma validação oficial roda, nenhum repair é possível — apesar de o Git conseguir descrever um candidate válido com os outros 15 arquivos.
- **SEVERITY**: crítica — é o blocker terminal do piloto.
- **ACTION**: **Git passa a ser autoridade sobre o material do candidate.** O conjunto de arquivos é derivado de `workingTreeFiles` (HEAD na base) ou `changedFiles(candidate)` (candidate retomado). `report.changed_files` vira nota auxiliar registrada como `discrepancies`, sem poder de bloqueio.

### H. Ignored/untracked files — `CONTRADICTED_BY_REAL_RUN` → corrigido nesta onda

- **ASSUMPTION**: todo arquivo que o worker escreveu é representável pelo Git.
- **REAL EVIDENCE**: o mesmo `src/coverage/.gitkeep`.
- **FAILURE IF WRONG**: artifact ignorado vira categoria especial e exige decisão humana.
- **SEVERITY**: crítica.
- **ACTION**: deixa de ser categoria especial. Reduz-se naturalmente a *o candidate do Git não contém aquele artifact*. Explicitamente **NÃO** implementados: `git add -f`, alteração de `.gitignore` pelo control plane, recipe `ignored-file-recovery`, pergunta ao humano. Se o artifact importava para o comportamento, a validação oficial ou a aceitação detectam e o repair worker decide como corrigir; se não importava, não há motivo para bloquear.

### I. Commit-message derivation — `PROVEN`

- **ASSUMPTION**: `PlanTask.title` cabe em `CommitMessage` (≤ 200 bytes).
- **REAL EVIDENCE**: blocker #5 do piloto — título semanticamente válido, impossível de converter.
- **ACTION**: já corrigido em `b1418fa` (`dev/lib/commit-message.ts`): derivação determinística e **total**, com truncamento bounded de scope e summary. Campo semântico não vira artefato bounded por reuso direto.

### J. Task/report/handoff field bounds crossing layers — `CONTRADICTED_BY_REAL_RUN` → corrigido nesta onda

- **ASSUMPTION**: `AgentCompletionReport` e `HandoffDraft` são pré-condições obrigatórias da finalização.
- **SOURCE OF TRUTH (antes)**: `readRequired(reportFile, 'AgentCompletionReport')` e `readRequired(handoffFile, 'HandoffDraft')` — ausência ou JSON malformado lançava e a task ficava `PENDING`.
- **FAILURE IF WRONG**: um candidate real e válido no Git fica inacessível porque o worker não escreveu (ou escreveu mal) um arquivo de metadata **opcional por natureza**.
- **SEVERITY**: alta.
- **ACTION**: worker output passa a ser **AUXILIARY SEMANTIC INFORMATION**. Ausente/malformado → `UNKNOWN`, registrado em `discrepancies`, nunca bloqueio. `HandoffRecord` preserva intacta a propriedade boa que já tinha: `changed_files`, `validations`, `accepted_commit` e `sealed_at` continuam **derivados pelo orquestrador**, nunca lidos do draft.

### K. Process lifetime/timeout — `PROVEN`

- **ASSUMPTION**: o process runner é autoridade sobre exit code, duração e timeout.
- **SOURCE OF TRUTH**: `LaunchRecord` (`exit_code`, `duration_ms`, `timed_out`, `process`, `survivors_remaining`), `dev/lib/process-identity.ts`, `src/runner/*`.
- **HOW PROVEN**: `loadSource` já exige `LaunchRecord` finalizado e processo morto antes de finalizar; `report.validations` nunca substitui `revalidation`.
- **SEVERITY**: alta.
- **ACTION**: nenhuma — esta fronteira já estava correta. Formalizada no protocolo operacional.

### L. FINALIZING restart semantics — `CONTRADICTED_BY_REAL_RUN` → corrigido nesta onda

- **ASSUMPTION**: rerodar o entrypoint retoma uma task já `RUNNING/FINALIZING`.
- **SOURCE OF TRUTH (antes)**: `recover` (`dev/lib/recover.ts:753`) reconcilia `RUNNING/FINALIZING` com processo morto para *ele mesmo*, com diagnostics `"fechamento pendente — repita dev-close"`. Mas `runRecoverStage` (`dev/lib/orchestrate-preflight.ts:300`) marca `reconciliations.length > 0` como `ATTENTION`, e o preflight devolve `BLOCKED / RECOVERY_ATTENTION`. `resumePendingAcceptance` só age sobre candidate que **declara review exigida**.
- **REAL EVIDENCE**: state do piloto com `foundation_app_scaffold` em `RUNNING/FINALIZING` e incidentes `foundation_app_scaffold-{1,2}-d44d2e74a598-post-launch-pending`.
- **FAILURE IF WRONG**: o operador precisa conhecer `dev-close` / `dev-recover-*` — primitives internas — para destravar. Isso é cerimônia interna vazando para a interface (blocker #7 do piloto).
- **SEVERITY**: alta.
- **ACTION**: o entrypoint de topo passa a tentar **continuar a finalização antes de selecionar nova task**. As primitives continuam existindo; quem as orquestra é o runner. `pnpm dev-run-project ...` é a interface de resume, idempotente.

### M. Generated-plan reuse — `PROVEN`

- **ASSUMPTION**: restart não regenera plano nem chama o planner de novo.
- **SOURCE OF TRUTH**: `ensureGeneratedProjectPlan` (`dev/lib/run-project.ts`) — factory do planner é lazy; `assertReusableSource` amarra `intake_sha256` + `authorization_scope_sha256`; `assertGeneratedPlanBase` amarra `base_revision_sha`.
- **SEVERITY**: alta (custo de inferência + identidade do plano).
- **ACTION**: nenhuma. Fronteira correta.

### N. Official-validation material — `PROVEN`

- **ASSUMPTION**: o validador oficial é a autoridade sobre validação, e roda sobre o material real.
- **SOURCE OF TRUTH**: `runOfficialValidations` (`dev/lib/finalize-orchestrated.ts:254`) reexecuta os comandos do **plano** (não do packet, que é apenas conferido contra o plano) e compara `argv` de volta. `report.validations` do worker nunca entra.
- **SEVERITY**: crítica.
- **ACTION**: nenhuma — já correto. Formalizado no protocolo.

### O. Candidate acceptance/integration — `PROVEN`

- **ASSUMPTION**: PASS e `accepted_commit` pertencem ao orquestrador.
- **SOURCE OF TRUTH**: `sealOrchestratedFinalization` é o gargalo único de promoção; `assertCandidateReviewAccepted` guarda a fronteira para todos os promotores (normal, retomada, `dev-recover`); `promoteState` só avança `authorized_head_sha` para o candidate selado.
- **SEVERITY**: crítica.
- **ACTION**: nenhuma. Preservado integralmente — **inclusive o gate humano de review**, que continua bloqueando.

### P. Operational history materialization — `CONTRADICTED_BY_REAL_RUN` → corrigido nesta onda

- **ASSUMPTION**: materializar evidência benchmark-style é pré-condição do progresso operacional.
- **SOURCE OF TRUTH (antes)**: `afterWorkUnit` (`dev/lib/project-run.ts:1850`) chama `await materializeObservedAttempt(...)` **sem guarda**. Essa função monta `ExecutionEnvelope`, `ExecutionRecord`, `ComparableRunFacts`, `Evaluation`, `Score`, `Qualification`, manifests, index e binding (`dev/lib/project-history.ts`), e lança em condições próprias — por exemplo `environment_readiness !== READY`.
- **FAILURE IF WRONG**: uma work unit **já validada e já aceita** perde a run inteira porque um registro secundário de aprendizado falhou. O produto do usuário fica refém de scoring/indexing auxiliar.
- **SEVERITY**: alta.
- **ACTION**: separar **OPERATIONAL PROGRESS** de **EXPERIMENTAL/CANONICAL BENCHMARK MATERIALIZATION**. Falha de score/qualify/index/seal vira `OBSERVABILITY_DEGRADED` e o progresso continua. O Experimental Plane **não** é deletado; evidência útil é preservada.

### Q. HUMAN_REQUIRED classification — `PARTIALLY_PROVEN`

- **ASSUMPTION**: `HUMAN_REQUIRED` representa decisão genuinamente humana.
- **REAL EVIDENCE**: no piloto, chegaram a `HUMAN_REQUIRED` ou a bloqueio equivalente: arquivo ignorado pelo Git, declaração errada do worker e fechamento pendente após restart. Nenhum dos três é decisão humana.
- **SEVERITY**: alta — é a métrica central do README ("intervenção humana deve ser exceção").
- **ACTION nesta onda**: remover as três causas acima na origem (G, H, J, L, P). A regra global `maximum_attempts=1 / same_profile_required=true / UNKNOWN→human` **não** foi redesenhada — é candidata explícita da Onda 2.

---

## Achados de risco alto

| # | Fronteira | Achado | Status |
|---|---|---|---|
| 1 | G/H | Candidate derivado da declaração do worker, não do Git; artifact ignorado trava a work unit | corrigido nesta onda |
| 2 | J | `AgentCompletionReport`/`HandoffDraft` são pré-condição capaz de invalidar candidate real | corrigido nesta onda |
| 3 | L | `dev-run-project` não retoma `FINALIZING`; exige primitives internas | corrigido nesta onda |
| 4 | P | Falha de telemetria benchmark-style aborta run operacional válida | corrigido nesta onda |
| 5 | Q | `HUMAN_REQUIRED` usado para problema técnico | causas removidas; classificação geral fica para Onda 2 |
| 6 | A(colateral) | `src/adapters/*/invocation.ts` diverge dos profiles reais e não é usado no hot path | documentado, não alterado |

---

## Protocolo operacional resultante

Autoridades no caminho operacional, depois desta onda:

| Fato | Autoridade |
|---|---|
| material alterado / candidate | **Git** |
| exit code, duração, timeout | **process runner** (`LaunchRecord`) |
| usage / tokens | **telemetria do provider**, quando disponível; senão `UNKNOWN` |
| validação | **validador oficial** |
| PASS/FAIL e `accepted_commit` | **orquestrador** |
| summary, decisions, lessons, open questions, confidence | **worker** — auxiliar, nunca bloqueante |

Regra: **a technical problem is not a human decision.**

---

## Acceptance test real da Onda 1

`foundation_app_scaffold`, do piloto Augmented Chess, **chegou a PASS** — pelo
entrypoint de topo, sobre o repositório externo real, com Git real, sandbox
real, instalação de dependência real e validação oficial real.

O attempt 3 preservado (o mesmo que estava travado) foi **retomado** pelo novo
caminho de finalização: `pnpm dev-run-project` reencontrou a task em
`RUNNING/FINALIZING`, concluiu o fechamento antes de selecionar tarefa nova, e
não exigiu `dev-close`, `dev-recover-*` nem qualquer primitive interna.

| Fato | Valor |
|---|---|
| accepted_commit | `9b04c439e64268c7e3cf7889aa82803348639b02` |
| base | `d44d2e74a598c362450bee395652250fa8d2787c` |
| arquivos no candidate | 15, todos derivados do Git |
| `npm install` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npx vitest run` | exit 0 |
| `git diff --cached --check` | exit 0 |
| intervenções humanas | **0** |
| launches de provider consumidos na retomada | **0** |

O desfecho do artifact ignorado é exatamente o previsto por 2E:
`src/coverage/.gitkeep` **não entra** no commit, **continua intacto no disco**,
e o `.gitignore` do alvo não foi tocado. A validação oficial — que nunca
dependeu dele — passa inteira. O bloqueio era cerimônia, não requisito.

`report_matches_evidence: false` e a discrepância correspondente ficam
registradas no CompletionRecord: a declaração errada do worker é observável,
e não decide nada.

### Limitação conhecida

O caminho de RETOMADA conclui a finalização fora do laço de iteração e, por
isso, não passa pelos hooks de observação — não grava
`OperationalAttemptRecord` nem materialização canônica para o attempt
retomado. Nenhuma evidência é perdida (CompletionRecord, HandoffRecord e
OrchestratedFinalizationRecord são gravados normalmente), mas o registro leve
de aprendizado fica ausente nesse caminho. Não foi corrigido nesta onda por
disciplina de escopo; é candidato direto da Onda 2.

## WAVE 2 CANDIDATES

- planner contract simplification;
- isolated/disposable attempt workspace;
- contextual repair/escalation;
- plan revision;
- richer `ExecutionEpisode`;
- capabilities/extensions;
- adaptive learning.
