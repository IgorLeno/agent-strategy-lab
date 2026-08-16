# Revisão M2 (M68) — checklist do pilot benchmark

Pacote de revisão humana ao final de M53–M67 (o Marco 2 aprovado em
[`PRE-M2-REVIEW.md`](PRE-M2-REVIEW.md) §5–§6). **Parada obrigatória**: este
documento fecha o plano operacional do Marco 2. Ele não autoriza, por si só,
o pilot real de 12 slots — ver §5.

---

## 1. O que foi construído em M53–M67

| Tarefa | Entrega | Onde |
| --- | --- | --- |
| M53 | Corpus experimental inicial: 3 tasks (`fix-stable-tag-normalization`, `add-bounded-retry`, `add-jsonl-summary-cli`), `TaskSpec` público + workspace + grader determinístico cada, critério de escolha documentado a priori | `corpus/pilot-v1/` |
| M54 | Billing guard provider-neutral do produto: `decideExecutionAuthorization` — ALLOW/BLOCK auditável, fail-closed por default sem evidência | `src/billing/guard.ts` |
| M55 | Credential proof provider-neutral: `decideCredentialProof` — SUBSCRIPTION_VERIFIED/API_VERIFIED/UNKNOWN/NOT_APPLICABLE, unknown fail-closed quando `SUBSCRIPTION`/`VERIFIED_CREDENTIAL` é requisito | `src/credentials/proof.ts` |
| M56 | `buildInvocation` real para Claude CLI, determinístico, sem spawn no adapter | `src/adapters/claude/invocation.ts` |
| M57 | `parseLine` real do stream Claude — `ParsedProviderLine{event, observation?}`, usage/cost/terminal preservados | `src/adapters/claude/parser.ts` |
| M58 | Primeiro `ProviderAdapter` real completo (Claude): identity + preflight + buildInvocation + parseLine, registrado em `resolveAdapter` | `src/adapters/claude/index.ts`, `src/adapters/registry.ts` |
| M59 | Probe de quota Claude via `/usage`, prova custo/inferência zero antes de aceitar a leitura, `QuotaUsage` M44 (OBSERVED/UNAVAILABLE, nunca 0% por omissão) | `src/adapters/claude/quota.ts` |
| M60 | `buildInvocation` real para Codex CLI, mesmo contrato do M56 | `src/adapters/codex/invocation.ts` |
| M61 | Segundo `ProviderAdapter` real (Codex) — prova que o contrato M51A generaliza além de Claude; smoke-only, nenhum benchmark | `src/adapters/codex/index.ts` |
| M62 | `executeRun`: `resolveAdapter(cli) → buildInvocation → executeWithAdapter` ponta a ponta, fake/Claude/Codex pela mesma trajetória estrutural | `src/cli/run-execute.ts` |
| M63 | CLI `agentlab run --experimental`: fina, delega para `prepareRun`/`executeRun`, billing BLOCK impede spawn | `src/cli/run.ts` |
| M64 | `ExperimentSpec` congelado: arms/corpus/repetitions/seed/ordering/strategy/environment/billing policy, hash canônico determinístico, deep-freeze; `buildPilotExperimentSpec` materializa o piloto concreto | `src/schemas/experiment-spec.ts`, `src/experiment/index.ts`, `src/experiment/pilot.ts` |
| M65 | Runner de scheduling: ordem seeded/interleaved/counterbalanced (mulberry32 + Fisher-Yates), retry slot para `INFRA_ERROR`, billing guard consultado antes de cada launch | `src/experiment/runner.ts` |
| M66 | `compareTaskPerformance`: só `QUALIFIED` entra, per-task antes do agregado, missing preservado como `null`, sem confidence interval nem vencedor automático | `src/reporting/compare.ts` |
| M67 | E2E fake ponta a ponta: `ExperimentSpec → runExperimentSchedule → prepareRun/executeRun → verifyRunIntegrity → evaluateRun → scoreRun → derivePerformance → compareTaskPerformance`; segundo teste prova que `REAL_INFERENCE` sem autorização é bloqueado antes do spawn | `test/e2e/experiment-fake-e2e.test.ts` |

Todas as quinze tarefas fecharam `PASS` — confirmado tanto em
`.dev/completions/M53.completion.json`…`M67.completion.json`
(`status: "PASS"`) quanto em `.dev/state.json` (mesmo veredito, mais
`authorized_head_sha` == HEAD atual `881a42e`). Nenhuma tarefa deste
intervalo executou provider real: toda evidência vem de fixtures, fakes e
ambientes determinísticos.

---

## 2. Checklist obrigatório do M68

| # | Item | Veredito | Evidência |
| --- | --- | --- | --- |
| 1 | M53–M67 `PASS` | ✅ PASS | `.dev/completions/M53..M67.completion.json` (`status: PASS`); `.dev/state.json` mesmo veredito para as 15 tarefas. |
| 2 | Gates completos verdes | ✅ PASS | Cada completion registra `pnpm typecheck` / `pnpm build` / `pnpm test` com `exit_code: 0` em `orchestrator_evidence.revalidation`. Reconferido nesta revisão apenas `pnpm typecheck` (limpo); `pnpm build`/`pnpm test` completos ficam para a validação oficial do orquestrador, por instrução de escopo do worker. |
| 3 | `recover` CLEAN | ✅ PASS | `.dev/state.json`: `authorized_head_sha` == HEAD do repositório (`881a42e`), todas as tarefas M01–M67 com `status: PASS` e `accepted_commit` == `candidate_commit`. Não foi necessário reexecutar `pnpm dev-recover --dry-run` (ferramenta do orquestrador) porque o `state.json` já reflete essa reconciliação. |
| 4 | Evidence contracts íntegros | ✅ PASS | `test/e2e/experiment-fake-e2e.test.ts` chama `verifyRunIntegrity` sobre cada run produzido pelo scheduler e afirma integridade OK antes de seguir para evaluation/score/performance/compare. |
| 5 | Billing guard funcional | ✅ PASS | `src/billing/guard.ts`: `FIXTURE` sempre ALLOW; `REAL_INFERENCE` sem evidência é BLOCK; `AUTHORIZED`+quota+billing_mode conhecidos e (se `API`) budget ≥ projeção é a única combinação que libera. `runExperimentSchedule` consulta `authorizeSlot` antes de todo launch, inclusive retries. |
| 6 | Credential proof funcional | ✅ PASS | `src/credentials/proof.ts`: ausência de API key nunca prova assinatura; `UNKNOWN`/`NOT_APPLICABLE` são BLOCK quando o perfil exige credencial; nenhum material de credencial entra no contrato (`CredentialProof` guarda só status + `verifier_id` opaco). |
| 7 | Quota probe funcional | ✅ PASS | `src/adapters/claude/quota.ts`: `probeClaudeQuota` só aceita a leitura quando prova custo/turnos/tokens zero (`zeroInferenceViolations`); ausência de prova vira `UNAVAILABLE`, nunca 0%. `buildClaudeQuotaUsage` produz o contrato `QuotaUsage` (M44) com `observation.status` explícito. |
| 8 | `ExperimentSpec` congelado | ✅ PASS | `freezeExperimentSpec` valida contra schema `.strict()`, deep-freeze e calcula hash canônico determinístico; `buildPilotExperimentSpec` materializa o piloto concreto (2 arms, 3 tasks, 2 repetições, seed fixa) sem executar nenhum provider. |
| 9 | Corpus de 3 tasks aprovado | ✅ PASS | `corpus/pilot-v1/README.md` documenta as 3 tasks, critério de escolha (variedade de forma de trabalho, baixo custo/ambiguidade, sem rede/relógio/aleatoriedade) fixado antes de qualquer resultado experimental. |
| 10 | Seed/ordem/counterbalancing definidos | ✅ PASS | `ExperimentOrdering.scheme` é o literal `seeded_interleaved_counterbalanced`; `PILOT_SEED = 'agent-strategy-lab-pilot-v1'` congelada em `pilot.ts`; `materializeSlotOrder` embaralha blocos task×repetição por PRNG determinístico (mulberry32) e alterna a direção dos arms a cada bloco — nunca todos os slots de um arm antes do outro. |
| 11 | Retry policy para `INFRA` definida | ✅ PASS | `runExperimentSchedule`: `INFRA_ERROR` nunca vira capability FAIL — gera um `PlannedSlot{kind:'RETRY'}` enfileirado, até `maxRetriesPerSlot` (default 1) tentativas por slot original; billing guard é consultado de novo antes do retry. |
| 12 | Compare somente `QUALIFIED` | ✅ PASS | `compareTaskPerformance` filtra por `QualificationStatus.QUALIFIED`; observações não-`QUALIFIED` só incrementam `excluded_non_qualified`, nunca entram em `pass_count`/`pass_rate`. Resultado por task antes do agregado (`per_task` antes de `aggregate`). |
| 13 | Quota stop ≥80% | ⚠️ PASS COM RESSALVA | Ver §3 — a política está congelada (`quota_stop_threshold_pct: 80` em `buildPilotExperimentSpec`) e a probe (M59) produz os dados objetivos, mas **não existe hoje uma função que converta automaticamente "quota consumida ≥ 80%" em uma decisão `BLOCK`**. É um passo manual do operador do piloto a cada launch, não um freio automático dentro do billing guard/runner. |
| 14 | Profiles Sonnet Medium/High corretos | ✅ PASS | `buildPilotExperimentSpec`: os dois arms (`claude-sonnet-5-medium`, `claude-sonnet-5-high`) compartilham `cli: 'claude'`, `cli_version: '2.1.223'`, `model: 'claude-sonnet-5'`; só `flags: ['--effort', 'medium'|'high']` varia — exatamente a condição que torna a comparação válida (schema `ExperimentArm` só permite variar `agent_profile`, task/strategy/environment/billing são compartilhados). |
| 15 | Codex smoke-only | ✅ PASS | M60/M61 registram um `ProviderAdapter` Codex completo e funcional em `resolveAdapter`, mas nenhuma tarefa do intervalo executou inferência Codex real nem produziu benchmark; `dev/plan.yaml`/`PRE-M2-REVIEW.md` §5–6 mantêm Codex fora do primeiro benchmark comparativo. |
| 16 | Custo/budget máximo definido | ✅ PASS (nota) | `billing_policy.billing_mode: 'SUBSCRIPTION'` com `max_incremental_charge_usd: null` é a forma correta em modo assinatura — não existe cobrança incremental em USD a limitar (`decideExecutionAuthorization` só exige budget quando `billing_mode === 'API'`, que o piloto não usa). O teto de custo real do piloto é o teto de quota (`quota_stop_threshold_pct: 80`, item 13) e o teto de execução é `planned_slot_count: 12`, ambos congelados no `ExperimentSpec`. |
| 17 | Billing authorization necessária | ✅ PASS | `decideExecutionAuthorization('REAL_INFERENCE', undefined)` é sempre BLOCK; `runExperimentSchedule.authorizeSlot` é chamada antes de **todo** launch (incluindo retries) e uma decisão BLOCK interrompe o schedule imediatamente, devolvendo os slots restantes sem lançá-los (`test/e2e/experiment-fake-e2e.test.ts`, segundo teste). |

---

## 3. Achado da revisão: quota stop ≥80% é política congelada, não freio automático

`ExperimentBillingPolicy.quota_stop_threshold_pct` (`src/schemas/experiment-spec.ts`)
é validado, congelado no `ExperimentSpec` do piloto e testado como dado
(`test/experiment/pilot.test.ts`: *"congela billing/quota policy do piloto
(quota stop >= 80%)"*). A probe de quota (M59) mede `before`/`after` e
produz `consumed_pp` por janela com provenance. Até aqui, os dois lados
existem e funcionam.

O que **não existe** é a ponte entre os dois: `decideExecutionAuthorization`
(`src/billing/guard.ts`) recebe `quota.availability` já como
`SUFFICIENT`/`INSUFFICIENT`/`null` — uma `Evidence` que o chamador decide
antes de invocar a guarda. Nenhum código do produto lê `QuotaUsage.windows`,
compara `consumed_pp`/`after_used_pct` contra `quota_stop_threshold_pct` e
escreve `INSUFFICIENT` quando o consumo cruza os 80%. Além disso, o próprio
design da guarda trata quota desconhecida como **não bloqueante** por
princípio — `QUOTA_UNKNOWN` permite o launch (mesma lógica de "ausência de
evidência não é prova negativa" usada em todo o kernel de performance,
M45/M47), e isso é testado explicitamente
(`test/billing/guard.test.ts`, *"mantém quota desconhecida como null e
permite assinatura autorizada"* → `decision: 'ALLOW'`).

Isso não é um bug: é uma decisão de design coerente com o resto do
codebase, mas tem uma consequência operacional que a aprovação humana do
pilot real precisa conhecer explicitamente **antes** de autorizar o
lançamento dos 12 slots: **o stop em 80% só funciona se o operador do
piloto (humano ou o próximo CLI que lançar os slots reais) rodar a probe de
quota antes de cada launch, comparar contra o threshold congelado e
preencher `quota.availability = INSUFFICIENT` manualmente quando o consumo
atingir 80%.** Sem esse passo manual, o billing guard libera o launch
normalmente — a ausência de probe não interrompe nada por conta própria.

Não corrigido nesta tarefa (M68 é revisão/checklist, não implementação; o
Marco 2 aprovado em `PRE-M2-REVIEW.md` não lista uma função de enforcement
automático como entrega de M53–M67). Registrado aqui como pré-requisito
operacional explícito do procedimento de lançamento do pilot real, e como
candidato de follow-up (ver §5) para fechar a lacuna automaticamente antes
ou durante os 12 slots reais.

---

## 4. Gates

`pnpm typecheck` limpo, reexecutado nesta revisão (não altera `src/`/`test/`).
`pnpm build` e `pnpm test` completos não foram reexecutados por este worker —
fora do escopo dele por instrução explícita do packet; a evidência de que
passaram em cada uma das quinze tarefas está em
`orchestrator_evidence.revalidation` de cada `.dev/completions/M5[3-9]|M6[0-7].completion.json`,
todos com `exit_code: 0`. A validação oficial completa (`pnpm typecheck`,
`pnpm build`, `pnpm test`) desta própria tarefa M68 é responsabilidade do
orquestrador.

---

## 5. Riscos e decisões em aberto antes do pilot real

1. **Quota stop ≥80% depende de um passo manual** (§3) — a aprovação humana
   que autoriza os 12 slots precisa decidir explicitamente: (a) aceitar o
   procedimento manual documentado acima como suficiente para o piloto de
   escopo pequeno, ou (b) exigir uma função de enforcement automático
   (`QuotaUsage` → `quota.availability`) como pré-requisito antes do
   primeiro slot real. Nenhuma das duas é decidida por este documento.
2. **Custo real de rodar adapters reais** — billing guard e credential proof
   bloqueiam por default; a autorização explícita por slot continua sendo
   responsabilidade de quem lançar os 12 slots, item por item.
3. **Codex permanece fora do primeiro benchmark** — nenhuma decisão de
   produto sobre Codex é tomada por este documento; M60/M61 provam só que o
   contrato generaliza.

---

## 6. Coerência documental

- `docs/BACKLOG.md` ganhou a seção "Marco 2 — Piloto Claude Medium vs High"
  com uma entrada por tarefa M53–M68, espelhando `dev/plan.yaml`.
- `docs/ARCHITECTURE.md` já refletia M53–M66 (`billing`, `credentials`,
  `experiment`, `reporting` na tabela §6, e o §6.1 já descreve `reporting/`
  como placeholder até M66) — nenhuma alteração adicional foi necessária.
- `docs/LESSONS.md` ganhou uma entrada datada sobre o achado do §3: uma
  política congelada como dado em um contrato imutável não é, por si só,
  um freio em runtime — precisa de um consumidor explícito que leia o
  valor observado e decida, ou permanece dado inerte.

---

## 7. Parada humana obrigatória

M68 é a última tarefa operacional do Marco 2. **Nenhum dos 12 slots do
pilot real foi lançado por esta tarefa ou por qualquer tarefa M53–M67** —
toda evidência usada nesta revisão vem de fixtures, fakes, ambientes
determinísticos e dos artefatos de fechamento já existentes em `.dev/`.
Nenhum provider real foi invocado.

O pilot real (Claude Sonnet 5 Medium vs High, 2 arms × 3 tasks ×
2 repetições, sequential/seeded/interleaved-counterbalanced, conforme
`PRE-M2-REVIEW.md` §6) só pode começar após uma aprovação humana explícita
**posterior a este documento**, que resolva no mínimo o risco do §5.1
(quota stop manual vs. automático) antes do primeiro slot real. Essa
aprovação autoriza exclusivamente o lançamento dentro do desenho já
aprovado — não autoriza ampliar o corpus, os arms, as repetições ou o
custo/quota máximo além do que está congelado em `buildPilotExperimentSpec`.
