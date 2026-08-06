# Codex Writable Sessions and Auditable Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir sessões Codex lean com escrita limitada e devolver a tentativa M02 abandonada a READY por uma transação auditável.

**Architecture:** O perfil declara controles que o schema e o doctor validam fail-closed; o ambiente separa HOME sanitizado de CODEX_HOME sem copiar conteúdo. O retry escreve um AttemptAbandonmentRecord imutável antes do state e aceita, em modo explícito, somente um commit de manutenção filho direto da base ainda autorizada.

**Tech Stack:** TypeScript 5.7 ESM, Zod, YAML, Vitest, Node.js 22, Git por argv e fixtures locais.

## Global Constraints

- Não implementar nem executar M02.
- Não executar `codex exec` real, modelo, API, Claude, push, PR ou merge.
- Não editar `.dev/state.json` manualmente.
- Preservar `gpt-5.6-sol`, reasoning `high`, stdin, JSONL, strict config e assinatura ChatGPT.
- Manter `environment_mode: real-world` e registrar separadamente `instruction_environment: sanitized_user_home`.
- Criar exatamente um commit local: `fix(harness): enable writable Codex sessions and retry abandoned attempts`.
- Adotar o commit somente depois de `dev-retry --allow-pending-maintenance`.

---

### Task 1: Perfil lean, HOME sanitizado e doctor fail-closed

**Files:**
- Modify: `test/dev/doctor.test.ts`
- Modify: `test/dev/billing.test.ts`
- Modify: `fixtures/fake-clis/codex`
- Modify: `dev/lib/profile.ts`
- Modify: `dev/lib/doctor.ts`
- Modify: `dev/lib/launch.ts`
- Modify: `dev/profiles/codex-build-worker-subscription-high-v1.yaml`

**Interfaces:**
- Consumes: `LauncherProfile`, `buildEnvironment`, `diagnose`, `codex login status` falso.
- Produces: ambiente com HOME sanitizado/CODEX_HOME real e `DoctorReport` com fatos separados.

- [x] **Step 1: Escrever testes RED das guardas do perfil**

Cobrir `workspace-write` obrigatório, `read-only`, `danger-full-access`,
`--dangerously-bypass-approvals-and-sandbox`, ausência de `--ephemeral`, ausência
de `--ignore-rules` e HOME pessoal recusado no perfil lean.

- [x] **Step 2: Rodar os testes focais e confirmar falhas pelo contrato ausente**

Run: `pnpm exec vitest run test/dev/doctor.test.ts test/dev/billing.test.ts`
Expected: FAIL nas novas expectativas de sandbox, persistence e sanitização.

- [x] **Step 3: Implementar o contrato mínimo do perfil e ambiente**

Adicionar `instruction_environment` ao schema; derivar CODEX_HOME de
`source.CODEX_HOME ?? path.join(source.HOME, '.codex')`; substituir HOME pelo
caminho dedicado recebido do runtime; recusar separação impossível. Acrescentar
as quatro variáveis Git determinísticas ao `env_extra`.

- [x] **Step 4: Implementar checks independentes no doctor**

Produzir os campos literais:

```ts
{
  instruction_environment: 'sanitized_user_home',
  sandbox: 'workspace-write',
  session_persistence: 'ephemeral',
  user_config_ignored: true,
  execpolicy_rules_ignored: true,
}
```

Executar `git var GIT_AUTHOR_IDENT` e `git var GIT_COMMITTER_IDENT` com o mesmo
ambiente sanitizado, reportando apenas sucesso/falha, nunca conteúdo de auth.

- [x] **Step 5: Fazer launcher, billing probe e fixtures usarem o mesmo ambiente**

`launchWorker` passa `.dev/homes/<profile-id>` ao builder; o fake Codex só
responde a help/login status e permite afirmar HOME, CODEX_HOME e identidade
sem executar um run.

- [x] **Step 6: Rodar os testes focais e confirmar GREEN**

Run: `pnpm exec vitest run test/dev/doctor.test.ts test/dev/billing.test.ts test/dev/dev-launch.test.ts`
Expected: PASS e nenhuma invocação real de provider.

### Task 2: Regras lean do prompt

**Files:**
- Create: `test/dev/prompt.test.ts`
- Modify: `dev/lib/prompt.ts`

**Interfaces:**
- Consumes: `TaskPacket.initial_files` e caminhos do inbox.
- Produces: preâmbulo determinístico dentro de `MAXIMUM_PREAMBLE_BYTES`.

- [x] **Step 1: Escrever teste RED do comportamento de descoberta**

O prompt deve orientar packet/initial_files primeiro, skills/subagentes apenas
sob pedido, `rg`/intervalos, limite de oito operações e proibição de revisão
geral/leitura integral desnecessária.

- [x] **Step 2: Rodar o teste focal e confirmar RED**

Run: `pnpm exec vitest run test/dev/prompt.test.ts`
Expected: FAIL porque as regras lean ainda não constam no preâmbulo.

- [x] **Step 3: Acrescentar somente as regras lean aprovadas**

Não alterar schemas de output, CompletionReport ou protocolo de fechamento.

- [x] **Step 4: Rodar o teste focal e confirmar GREEN**

Run: `pnpm exec vitest run test/dev/prompt.test.ts`
Expected: PASS e preâmbulo menor ou igual a 4096 bytes.

### Task 3: AttemptAbandonmentRecord e retry transacional

**Files:**
- Create: `dev/lib/retry.ts`
- Create: `dev/cli/dev-retry.ts`
- Create: `test/dev/retry.test.ts`
- Modify: `dev/lib/schemas.ts`
- Modify: `dev/lib/paths.ts`
- Modify: `dev/lib/records.ts`
- Modify: `dev/lib/state.ts`
- Modify: `dev/lib/maintenance.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: state, LaunchRecord, Git, process identity, report/handoff paths e lock.
- Produces: `retryAbandonedAttempt(input): Promise<RetryResult>` e record imutável em `.dev/attempts`.

- [x] **Step 1: Escrever testes RED das precondições e transação**

Cobrir processo morto/vivo, árvore suja, HEAD divergente, report, handoff,
candidate, LaunchRecord, outro RUNNING, ordem record-before-state, crash e
idempotência; verificar M01 intacta e M02 READY com attempts 1.

- [x] **Step 2: Escrever testes RED do modo pending-maintenance**

Aceitar exatamente um filho direto simultâneo de `base_sha` e
`authorized_head_sha`; recusar dois commits, parent divergente, `src/**`,
`dev/plan.yaml`, `.dev/**`, `.dev-inbox/**` e artifact histórico.

- [x] **Step 3: Rodar o arquivo focal e confirmar RED**

Run: `pnpm exec vitest run test/dev/retry.test.ts`
Expected: FAIL porque schema, record, biblioteca e CLI não existem.

- [x] **Step 4: Implementar schema, paths e I/O atômico**

Adicionar `AttemptAbandonmentRecord`, `attemptsDir`, path
`<task>/<attempt>-abandoned.json` e funções read/write validadas. O record
inclui todos os campos mínimos aprovados e o `head_sha` observado.

- [x] **Step 5: Implementar validação e state transition**

Validar as dez condições, o modo normal ou pending-maintenance, escrever/reusar
o record e somente então aplicar `withTaskState`, preservando tasks alheias,
attempts e authorized head. Expor hook de teste após o record para provar ordem
e reconciliação após crash.

- [x] **Step 6: Adicionar CLI, lock e script pnpm**

Parsear `--task`, `--reason`, `--allow-pending-maintenance`; executar sob
`withHarnessLock`; emitir status, record e state resultante sem lançar worker.

- [x] **Step 7: Rodar o teste focal e confirmar GREEN**

Run: `pnpm exec vitest run test/dev/retry.test.ts`
Expected: PASS sem Codex, Claude ou API.

### Task 4: Adoção repetível e guarda entre retry e adoção

**Files:**
- Modify: `test/dev/maintenance.test.ts`
- Modify: `test/dev/base-guard.test.ts`
- Modify: `dev/lib/maintenance.ts`

**Interfaces:**
- Consumes: MaintenanceRecord já escrito, state ainda na base e HEAD de manutenção.
- Produces: adoção idempotente e bloqueio de progressão antes dela.

- [x] **Step 1: Escrever testes RED de crash/repetição**

Provar que record escrito antes do state pode ser adotado novamente sem
divergência e que, após retry mas antes da adoção, a guarda bloqueia qualquer
worker porque HEAD difere de `authorized_head_sha`.

- [x] **Step 2: Rodar os testes focais e confirmar RED**

Run: `pnpm exec vitest run test/dev/maintenance.test.ts test/dev/base-guard.test.ts`
Expected: FAIL no caminho de adoção pendente.

- [x] **Step 3: Reconciliar MaintenanceRecord existente antes de gerar outro**

Verificar cadeia, arquivos e HEAD do record; quando ele começa no authorized
head atual, atualizar somente o state e devolver `alreadyAdopted: true`.

- [x] **Step 4: Rodar os testes focais e confirmar GREEN**

Run: `pnpm exec vitest run test/dev/maintenance.test.ts test/dev/base-guard.test.ts`
Expected: PASS.

### Task 5: Gates, commit, retry, adoção e leitura final

**Files:**
- Modify: checkboxes e outcome note deste plano.
- Runtime after commit: `.dev/attempts/M02/1-abandoned.json`, `.dev/state.json`, `.dev/maintenance/<head>.json`.

**Interfaces:**
- Consumes: implementação e runtime M02 conhecido.
- Produces: único commit local adotado, M02 READY e nenhum worker iniciado.

- [x] **Step 1: Rodar os gates completos separadamente**

Run: `pnpm typecheck`; `pnpm build`; `pnpm test`; `git diff --check`.
Expected: quatro exit codes 0.

- [x] **Step 2: Revisar diff, escopo e ausência de credenciais**

Conferir que `src/**`, `dev/plan.yaml`, output schemas e artifacts históricos
não mudaram e que nenhum teste contém chamada real de provider.

- [ ] **Step 3: Criar exatamente um commit local**

Run: `git commit -m "fix(harness): enable writable Codex sessions and retry abandoned attempts"`
Expected: HEAD filho direto do base M02; sem push.

- [ ] **Step 4: Abandonar a tentativa usando o modo explícito**

Run: `pnpm dev-retry --task M02 --allow-pending-maintenance --reason "attempt 1 bloqueado pelo sandbox Codex read-only"`
Expected: record escrito; M02 READY; attempts 1; authorized head antigo.

- [ ] **Step 5: Adotar o commit de manutenção**

Run: `pnpm dev-adopt-maintenance --reason "corrigir sandbox Codex e adicionar retry auditável"`
Expected: authorized head igual ao novo HEAD; tentativa e M01 preservadas.

- [ ] **Step 6: Executar somente verificações de leitura**

Run: `pnpm dev-recover --dry-run`; `pnpm dev-doctor --profile codex-build-worker-subscription-high-v1`; `pnpm dev-next`.
Expected: M01 PASS, M02 READY attempts 1, doctor writable/ephemeral/sanitized e dev-next seleciona M02 sem launch.

## Outcome note

TDD observado em RED e GREEN. Antes do commit: testes focais do harness 125/125,
`pnpm typecheck`, `pnpm build` e `git diff --check` com exit 0, e suíte completa
226/226. O diff permanece limitado ao harness, testes, fixtures e documentação;
`src/**`, `dev/plan.yaml`, output schemas e artifacts históricos não mudaram.
