# Codex Sol High Subscription Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar e provar um perfil Codex `gpt-5.6-sol` com reasoning `high`, pago exclusivamente pela assinatura ChatGPT.

**Architecture:** O argv do perfil é a única fonte do modelo e do reasoning: `--model` fixa o modelo, enquanto `--config model_reasoning_effort="high"` fixa o esforço e `--ignore-user-config` elimina dependência de config pessoal. O doctor deriva as quatro dimensões auditáveis do argv e da sonda local de autenticação, falhando fechado quando qualquer prova falta.

**Tech Stack:** TypeScript 5.7, Zod, YAML, Vitest, Node.js 22, Codex CLI local apenas para help/version/status.

## Global Constraints

- Não executar M02 nem iniciar worker.
- Não executar `codex exec` como run, não chamar API e não fazer push.
- Modelo exato: `gpt-5.6-sol`.
- Reasoning effort exato: `high`.
- Cobrança exata: `subscription_only` com `chatgpt_subscription`.
- Preservar stdin, `--json`, `--strict-config`, timeout 1800 e proibições de continuidade.
- Criar exatamente um commit local: `feat(harness): add Codex Sol High subscription profile`.

---

### Task 1: Contrato testável do perfil e do doctor

**Files:**
- Modify: `test/dev/doctor.test.ts`

**Interfaces:**
- Consumes: `loadProfile`, `buildEnvironment`, `diagnose` e a CLI falsa em `fixtures/fake-clis/codex`.
- Produces: expectativas literais para os campos `model`, `reasoning_effort`, `billing_mode` e `credential_source`.

- [x] **Step 1: Escrever testes que descrevem o perfil High e as falhas fechadas**

```ts
expect(report).toMatchObject({
  model: 'gpt-5.6-sol',
  reasoning_effort: 'high',
  billing_mode: 'subscription_only',
  credential_source: 'chatgpt_subscription',
  ok: true,
});
```

Cobrir ainda reasoning ausente, `medium`, `xhigh`, autenticação API, remoção de
`OPENAI_API_KEY`/`CODEX_API_KEY` e carregamento do perfil legado sem
classificação High.

- [x] **Step 2: Rodar o arquivo focal e observar RED pela ausência do perfil/campos**

Run: `pnpm exec vitest run test/dev/doctor.test.ts`

Expected: FAIL porque o perfil High e os campos do relatório ainda não existem.

### Task 2: Perfil e extração explícita de configuração

**Files:**
- Create: `dev/profiles/codex-build-worker-subscription-high-v1.yaml`
- Modify: `dev/lib/doctor.ts`
- Modify: `fixtures/fake-clis/codex`

**Interfaces:**
- Consumes: `LauncherProfile.argv`, `probeCredentialSource` e help da CLI.
- Produces: `codexReasoningEffort(argv): string | null` e `DoctorReport` com as quatro dimensões separadas.

- [x] **Step 1: Criar o perfil mínimo preservando o contrato legado**

```yaml
argv:
  - codex
  - exec
  - --json
  - --strict-config
  - --ignore-user-config
  - --model
  - gpt-5.6-sol
  - --config
  - 'model_reasoning_effort="high"'
  - '-'
```

- [x] **Step 2: Extrair o override sem consultar configuração pessoal**

```ts
export function codexReasoningEffort(argv: readonly string[]): string | null {
  const overrides = configOverrides(argv).filter(({ key }) => key === 'model_reasoning_effort');
  return overrides.length === 1 ? overrides[0]!.value : null;
}
```

O parser aceitará a forma separada `--config key=value`, removerá aspas TOML
simples ou duplas do valor e rejeitará ausência, duplicação ou valor malformado.

- [x] **Step 3: Fazer os checks falharem fechado**

`checkModelPinned` exigirá `gpt-5.6-sol` para Codex. O novo check de reasoning
exigirá valor `high` e presença de `--ignore-user-config`. A sonda de credencial
devolverá simultaneamente o check e a fonte para evitar inferência duplicada.

- [x] **Step 4: Fazer a CLI falsa reconhecer as opções versionadas**

Adicionar `--config` e `--ignore-user-config` a `FLAGS`; qualquer invocação que
não seja help ou login status continuará encerrando com código 70.

- [x] **Step 5: Rodar o teste focal e observar GREEN**

Run: `pnpm exec vitest run test/dev/doctor.test.ts`

Expected: PASS sem qualquer chamada a Codex real.

### Task 3: Regressão da política de assinatura

**Files:**
- Modify: `test/dev/billing.test.ts`

**Interfaces:**
- Consumes: lista de perfis versionados e helper de perfil Codex falso.
- Produces: cobertura do novo perfil na política compartilhada de assinatura.

- [x] **Step 1: Incluir o perfil High na matriz de perfis versionados**

```ts
for (const id of [
  'claude-build-worker-subscription-v1',
  'codex-build-worker-subscription-v1',
  'codex-build-worker-subscription-high-v1',
]) {
  // carregar e provar ausência de credenciais de API
}
```

- [x] **Step 2: Atualizar apenas a fixture Codex para o contrato obrigatório**

A fixture Codex receberá modelo Sol, override High e opções anunciadas pela CLI
falsa. Fixtures Claude permanecem sem regra de reasoning Codex.

- [x] **Step 3: Rodar os testes focais do harness**

Run: `pnpm exec vitest run test/dev/doctor.test.ts test/dev/billing.test.ts`

Expected: PASS.

### Task 4: Gates, revisão, commit e adoção

**Files:**
- Modify: checkboxes deste plano conforme cada evidência for obtida.
- Runtime only after commit: `.dev/state.json` and `.dev/maintenance/<new-head>.json`.

**Interfaces:**
- Consumes: implementação completa e checkout atual autorizado.
- Produces: um commit local e checkpoint de manutenção adotado.

- [x] **Step 1: Rodar todos os gates solicitados**

Run, separadamente: `pnpm typecheck`, `pnpm build`, `pnpm test`,
`git diff --check`.

Expected: quatro exit codes 0.

- [x] **Step 2: Revisar escopo e integridade**

Conferir `git diff`, ausência de secrets, ausência de alterações M02 e estado
Git. Atualizar o índice local do grafo e usar a análise de impacto para revisar
as funções tocadas.

- [ ] **Step 3: Criar exatamente um commit local**

Run: `git commit -m "feat(harness): add Codex Sol High subscription profile"`

Expected: novo HEAD, árvore limpa, nenhum push.

- [ ] **Step 4: Adotar o commit como manutenção**

Run: `pnpm dev-adopt-maintenance --reason "adicionar perfil Codex Sol High por assinatura"`

Expected: `authorized_head_sha` igual ao novo HEAD; M01 `PASS`; M02 `READY`
com zero tentativas.

- [ ] **Step 5: Confirmar seleção sem lançar worker**

Run: `pnpm dev-next`

Expected: M02 selecionada, sem LaunchRecord, processo ou incremento de tentativa.

## Outcome note

TDD observado em RED e GREEN. Revisão independente final sem issues Critical ou
Important. Evidência pré-commit: testes focais 51/51, `pnpm typecheck` e
`pnpm build` com exit 0, suíte completa 192/192, `git diff --check` com exit 0
e doctor local com `ok: true`. Os passos 3–5 permanecem operacionais e serão
registrados no relatório final, pois ocorrem depois do único commit permitido.
