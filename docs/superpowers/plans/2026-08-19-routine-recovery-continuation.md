# Routine Recovery Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar `RECOVERED` um resultado first-class no `dev-orchestrate` e permitir um único retry operacional da mesma task/profile dentro da mesma iteração primária.

**Architecture:** O contrato de resolução pós-launch e o contrato interno do orquestrador serão uniões discriminadas, eliminando combinações ambíguas de status e valores nulos. Um helper de estabilização pós-launch manterá o budget operacional da recipe separado de `--max-iterations`: após `RECOVERED`, ele relança a mesma task/profile/lineage uma vez; uma nova recovery no mesmo ciclo preserva a segunda evidência e encerra com `HUMAN_REQUIRED` por esgotamento operacional, sem terceiro launch.

**Tech Stack:** TypeScript 5.7 estrito, Node.js 22, Vitest, Git sandboxes, fake worker local.

## Global Constraints

- Não executar M71, provider real nem `dev-orchestrate` contra o checkout principal.
- Não alterar `dev/plan.yaml`, `src/**`, `dev/profiles/**`, billing, authorization, safety kernel ou `schema_version`.
- Não implementar enforcement estrutural de `worker_validation_policy = targeted`.
- Criar exatamente um maintenance commit: `fix(harness): continue after routine recovery`.
- Adotar somente pela primitive oficial após todos os gates.

---

### Task 1: Reproduzir incomplete output no dev-orchestrate

**Files:**
- Modify: `fixtures/fake-worker.mjs`
- Create: `test/dev/routine-recovery-continuation.test.ts`

**Interfaces:**
- Produces: fake modes que criam patch e encerram sem `AgentCompletionReport`/`HandoffDraft` no primeiro attempt ou em todos os attempts.
- Verifies: fluxo real `dev-orchestrate -> routine-autonomy -> runtime -> incomplete recovery -> retry -> close`.

- [x] Adicionar fake mode `incomplete-output-then-success`, detectando o attempt já abandonado pela evidência append-only e emitindo artifacts válidos somente no retry.
- [x] Adicionar fake mode `incomplete-output-always`, omitindo artifacts em todos os launches.
- [x] Escrever E2E para recovery seguida de PASS, verificando patch/logs preservados, ausência de verdicts, mesma task/profile, attempt seguinte, validation oficial, avanço do HEAD e árvore limpa.
- [x] Escrever E2Es `--max-iterations 1` e `2`, provando que recovery + retry pertencem à mesma iteração primária.
- [x] Escrever E2E de incidente repetido, provando duas evidências preservadas, zero capability FAIL e ausência de terceiro launch.
- [x] Rodar `pnpm vitest run test/dev/routine-recovery-continuation.test.ts` e confirmar RED causado pelo contrato `RECOVERED` ainda não integrado.

### Task 2: Tornar os estados pós-launch impossíveis de confundir

**Files:**
- Modify: `dev/lib/routine-autonomy.ts`
- Modify: `dev/cli/dev-orchestrate.ts`
- Modify: `test/dev/routine-autonomy.test.ts`

**Interfaces:**
- Produces: `RoutinePostLaunchResolution<T>` discriminada por `status`.
- Produces: `RoutinePostLaunchHandling` discriminada com `execution` obrigatório somente em `RETRIED` e `human_required` obrigatório somente em `HUMAN_REQUIRED`.
- Consumes: `ROUTINE_RECIPES[].retry_budget`, sem criar um segundo budget incompatível.

- [x] Converter `RoutinePostLaunchResolution<T>` em união discriminada mantendo `RETRIED`, `RECOVERED` e `HUMAN_REQUIRED`.
- [x] Atualizar o mapper `handleRoutinePostLaunch()` com `switch` exaustivo; `RECOVERED + retry=null` deve retornar estado válido, nunca exception.
- [x] Extrair estabilização pós-launch para reutilização tanto no FIRST/primary quanto no REPAIR, preservando profile e `repairSourceAttempt`.
- [x] Após `RECOVERED`, executar no máximo `recipe.retry_budget` retries da mesma task dentro da chamada atual.
- [x] Quando o budget já tiver sido usado, permitir a segunda recovery para preservar/resetar sua evidência e então emitir `HUMAN_REQUIRED` com motivo explícito de budget operacional esgotado.
- [x] Atualizar o teste unitário do estado `RECOVERED` e adicionar cobertura de narrowing/exaustividade.

### Task 3: Verificar RED/GREEN e safety boundaries

**Files:**
- Test: `test/dev/routine-recovery-continuation.test.ts`
- Test: `test/dev/routine-autonomy.test.ts`
- Review: todos os arquivos alterados

- [x] Rodar `pnpm vitest run test/dev/routine-recovery-continuation.test.ts test/dev/routine-autonomy.test.ts`.
- [x] Confirmar nos E2Es: `PENDING -> AUTO_RECOVER -> READY -> retry -> PASS`, HEAD avançado e working tree limpa.
- [x] Confirmar `--max-iterations 1` mantém T2 READY e `--max-iterations 2` executa T2.
- [x] Confirmar incidente repetido termina bounded, preserva attempts 1 e 2 e não produz capability/validation FAIL.
- [x] Confirmar `git diff --name-only` sem `dev/plan.yaml`, `src/**` ou `dev/profiles/**`.

### Task 4: Gates, commit e adoção oficial

**Files:** somente o plano e os arquivos permitidos das Tasks 1–3.

- [x] Executar separadamente `pnpm typecheck`, `pnpm build`, `pnpm test` e `git diff --check`.
- [ ] Revisar diff/staged diff e criar exatamente um commit `fix(harness): continue after routine recovery`.
- [ ] Executar `pnpm dev-adopt-maintenance --reason "continue orchestration after capability-neutral routine recovery"`.
- [ ] Executar `pnpm dev-recover --dry-run` e exigir `CLEAN`.
- [ ] Executar `pnpm dev-next` e exigir M71, attempt 3, READY.
- [ ] Confirmar HEAD autorizado final, árvore limpa, `dev/plan.yaml`/`src/**` intactos e nenhum provider/M71 executado.
