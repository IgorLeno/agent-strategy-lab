# Plano — executor de plano desktop

> Status: **aprovado em 2026-10-06** (Q1–Q4, Q6, Q7 aceitas; Q5 e Q8 pendentes). Visão e lista de reaproveitamento em
> [docs/PRODUCT_VISION.md](../../PRODUCT_VISION.md). Branch:
> `feat/desktop-executor`. Nenhum código antes da aprovação deste documento.

Critério do MVP: **um projeto real concluído do início ao fim pelo app.** Ele
fecha no fim da Fase 2. Fases 3 e 4 são pós-MVP.

---

## Layout do pacote

```
agent-strategy-lab/
├── pnpm-workspace.yaml        # novo: packages: ['packages/*', 'apps/*']
├── package.json               # raiz = control plane antigo, CONGELADO (scripts dev-*, lab)
├── src/  dev/  test/          # congelados, intocados
├── packages/
│   └── core/                  # @asl/core — headless, Node puro, sem Electron
│       ├── src/
│       │   ├── providers/     # portado de src/providers/identity.ts
│       │   ├── quota/         # portado de src/quota/* + claude-usage + pool observer
│       │   ├── adapters/      # claude / codex / opencode: argv por modo + decoders de stream
│       │   ├── catalog/       # catálogo de modelos (YAML) com tier
│       │   ├── plan/          # parser/escritor de plan.md
│       │   ├── router/        # função pura tier + quota -> perfil
│       │   ├── broker/        # quota broker (probes frescos + leases)
│       │   ├── loop/          # loop runner, handoff, gate, retry, continuidade
│       │   ├── git/           # modos Direto / Branch / Worktree
│       │   ├── ledger/        # SQLite
│       │   └── cli.ts         # `asl run ...` headless
│       └── test/
└── apps/
    └── desktop/               # @asl/desktop — Electron main + preload + React renderer
        ├── src/main/          # hospeda o daemon (core), IPC
        ├── src/preload/       # ponte tipada, contextIsolation
        └── src/renderer/      # React
```

Justificativa:

- **Core separado do Electron** porque a Fase 1 precisa provar o loop sem UI,
  com `vitest` e Node puro. Electron vira só casca.
- **Workspace pnpm** (`packages/*`, `apps/*`) porque o repo já usa pnpm e a raiz
  continua sendo o pacote antigo: `tsconfig.json` da raiz inclui só
  `src/ dev/ test/`, então `pnpm typecheck` e `pnpm test` antigos não mudam.
  Cada pacote novo tem `tsconfig` e `vitest` próprios.
- **Cópia, não import**, dos módulos reaproveitados (ver visão §5): o core
  novo nunca importa `src/` ou `dev/`. Isso é verificável com um teste de
  fronteira (grep de imports).
- **Renderer não importa o core.** Só fala com o main por IPC tipado; o main é
  o único dono de processo, git e disco.

---

## Fase 1 — core headless

Objetivo: `asl run` executa um `plan.md` real até o fim, numa sessão nova de
CLI por step, com gate, retry, commit e ledger.

### 1.1 Base
- [ ] Criar `pnpm-workspace.yaml`, `packages/core` (`package.json`, `tsconfig`, `vitest.config`), mesmas opções estritas do `tsconfig` raiz
- [ ] Teste de fronteira: nenhum arquivo de `packages/core/src` importa `../../src` ou `../../dev`
- [ ] Confirmar que `pnpm typecheck` e `pnpm test` da raiz continuam verdes sem alteração

### 1.2 Portar módulos (visão §5)
- [ ] `providers/identity.ts` e `quota/{observation,probes,credentials}.ts` como estão, com testes portados de `test/` quando existirem
- [ ] `quota/claude-usage.ts` adaptado (só probe e parse; tipos locais no lugar de `dev/lib/schemas.ts`)
- [ ] `adapters/`: `events.ts`, contrato puro (`buildInvocation` + `parseLine`), decoders de `claude-stream`, `codex-transport`, `opencode-scaffold`, `worker-token-usage`, `redaction.ts`
- [ ] Reverificar decoders contra as CLIs instaladas: claude 2.1.281 (código verificado em 2.1.226), codex 0.158.0 (verificado em 0.149.x), opencode 1.18.23. Gravar um fixture real de cada stream em `packages/core/test/fixtures/`
- [ ] Adapter `fake` (script local que emite o stream) para testes sem gastar quota

### 1.3 Catálogo e modos
- [ ] `catalog/models.yaml`: perfis (scaffold, provider, modelo, effort, tier, rank de custo), semeado dos argv verificados em `dev/profiles/` — tabela inicial a aprovar (pergunta Q2)
- [ ] Mapear modo de permissão → argv por scaffold (`Plan` read-only; `Edit` e `Auto` conforme Q1). Flags proibidas: `--resume`, `--continue`, `--bare`, `--dangerously-skip-permissions`
- [ ] Teste: cada (scaffold, modo) gera argv esperado; nenhum argv contém flag proibida

### 1.4 Plano, handoff e loop
- [ ] `plan/`: parser e escritor de `plan.md` (formato da visão §4); round-trip preserva texto do usuário byte a byte fora dos checkboxes
- [ ] Handoff: `plan.md` + `git diff` (cortado com aviso quando grande) + nota do step anterior; prompt pede ao agente uma nota final curta
- [ ] Spawn: sessão própria (`detached`), timeout de máquina por step, kill do process group, tag de ambiente por step (lições S04/S14)
- [ ] Gate: comando do projeto (configurável) roda depois do agente; exit 0 = verde
- [ ] Retry: gate vermelho ou falha do agente → nova sessão com o erro no contexto, até N (padrão 2). Esgotou → `- [!]` e pausa
- [ ] Falha de provider (stream terminal de erro / rate limit) → próximo perfil do mesmo tier, sem contar como retry do step
- [ ] Continuidade `Step a step` / `Por fase` / `Contínuo` e pausa (sinal ou comando: termina o step corrente e para), trocáveis entre steps
- [ ] Router mínimo: primeiro perfil disponível do tier, pulando os que falharam neste step (quota entra na Fase 3)

### 1.5 Git e ledger
- [ ] Modo `Branch` (padrão): cria `asl/<slug-do-plano>` a partir do HEAD; commit por step aceito com mensagem `<id>: <título>`
- [ ] Modo `Direto`: commit na branch atual; push desligado por padrão
- [ ] Modo `Worktree`: `git worktree add` por plano; remoção só por ação explícita
- [ ] Árvore suja no início → recusa iniciar com mensagem clara (não é gate novo: é pré-condição de commit)
- [ ] `ledger/`: SQLite com `projects`, `plans`, `steps`, `attempts` (perfil, modelo, tokens in/out/cached/reasoning, duração, exit, gate, quota antes/depois quando houver). Driver `node:sqlite` no core

### 1.6 CLI
- [ ] `asl run --project <dir> [--plan .asl/plan.md] [--mode plan|edit|auto] [--continuity step|phase|continuous] [--git direct|branch|worktree]`
- [ ] `asl status` e `asl ledger` (leitura)

### Verificação da Fase 1
- [ ] `pnpm --filter @asl/core typecheck` e `test` verdes; raiz `pnpm typecheck` e `pnpm test` verdes
- [ ] E2E com adapter `fake` num repo temporário: plano de 2 fases / 4 steps vai a 4×`[x]`, 4 commits, 4 linhas em `steps`; um step com gate vermelho na 1ª tentativa e verde na 2ª aparece com 2 `attempts`
- [ ] E2E com adapter `fake` que esgota retries: step vira `[!]`, loop pausa, nenhum commit desse step
- [ ] Pausa testada: pedido no meio de um step termina o step e não inicia o próximo
- [ ] **Real:** um projeto real escolhido pelo usuário (Q5) roda com CLIs de assinatura do primeiro ao último step via `asl run`; gate verde no final; ledger com tokens, modelo e duração de todos os steps. Registrar resultado e o que falhou

---

## Fase 2 — shell Electron (fecha o MVP)

Objetivo: o mesmo loop, dirigido pela UI, incluindo o chat de planejamento.

- [ ] Spike: `node:sqlite` dentro do Electron instalado. Se indisponível, trocar o driver do ledger por `better-sqlite3` + rebuild para Electron atrás da mesma interface (decidir e registrar)
- [ ] `apps/desktop` com electron-vite + React + TypeScript (Q6); `contextIsolation` ligado, `nodeIntegration` desligado
- [ ] Daemon: core rodando no main (ou `utilityProcess`, Q4); lock de instância única com pid + starttime
- [ ] IPC tipado: comandos (adicionar projeto, iniciar, pausar, trocar modo/continuidade, aprovar plano) e eventos (transcript, estado do step, ledger)
- [ ] Sidebar: projetos e estado do loop de cada um
- [ ] Transcript: eventos `AgentEvent` do step corrente ao vivo; steps anteriores do ledger
- [ ] Painel do plano: fases, steps, tier, status; abrir `plan.md` no editor externo
- [ ] Controles: modo de permissão, continuidade e **Pausar** sempre visível
- [ ] Configuração por projeto: comando de gate, N de retries, Git mode (aviso explícito ao ligar push em `Direto`)
- [ ] Chat de planejamento: sessão em modo `Plan` com perfil premium produz `plan.md` no formato da visão §4; usuário edita e aprova; aprovação inicia o loop
- [ ] Empacotar para Fedora (AppImage ou rpm, Q6)

### Verificação da Fase 2
- [ ] Teste de UI automatizado (Playwright para Electron) com adapter `fake`: adicionar projeto, aprovar plano, rodar `Step a step`, ver transcript, pausar, retomar, terminar
- [ ] Renderer não importa `@asl/core` (teste de fronteira)
- [ ] **MVP:** um projeto real, do chat de planejamento ao último step, feito só pelo app instalado no Fedora. Ledger e commits conferidos

---

## Fase 3 — quota, roteamento automático e broker

- [ ] Broker: probes frescos por pool antes de cada rota (deduplicados por pool), `UNKNOWN` com motivo em falha; nunca reuso entre decisões (LESSONS 2026-08-28)
- [ ] Leases de execução por pool para loops paralelos; liberados no fim do step, inclusive em crash do processo filho
- [ ] Router: dentro do tier, maior folga observada; `UNKNOWN` não desempata; `EXHAUSTED` (ou `remaining 0` em janela viva) remove o pool; empate → menos leases → rank de custo → id
- [ ] Fallback: esgotou no meio do plano → outro provider do mesmo tier no próximo step; nenhum do tier disponível → pausa com motivo e horário de reset
- [ ] Ledger guarda quota antes/depois por step (delta só quando a janela não virou, `windowDeltas`)
- [ ] UI: medidores por pool (Claude 5h/7d, OpenAI primary/semanal, OpenCode Go rolling/weekly/monthly) com % usado, precisão (inteiro vs fracionário) e horário de reset; `UNKNOWN` aparece como desconhecido, nunca 0%
- [ ] Atualização dos medidores: na abertura, antes de cada step e por botão manual (sem polling de fundo, Q3)

### Verificação da Fase 3
- [ ] Testes de tabela do router: exhausted→fallback, unknown sem desempate, leases espalham dois loops, tier sem candidato → pausa
- [ ] Probes com `fetch` injetado e fixtures reais gravados (sem rede na suíte)
- [ ] Real: valores dos medidores conferem com `claude /usage` e com o `/status` do Codex dentro da resolução do provider
- [ ] Real: dois projetos rodando em paralelo; ledger mostra os dois e nenhum pool com mais leases que o configurado
- [ ] Simulação de esgotamento (probe fake devolvendo `EXHAUSTED`) troca de provider no próximo step, visível no ledger e na UI

---

## Fase 4 — polimento

- [ ] Editar o plano no meio: com o loop pausado, editar `plan.md` (ou pela UI); ao retomar, o parser relê e segue do primeiro `- [ ]`; steps `[x]` editados não são re-executados
- [ ] Retomar após reboot: no start, o daemon lê do ledger os loops que estavam ativos; step interrompido vira "interrompido", árvore é mostrada (diff) e o usuário escolhe refazer o step ou descartar mudanças; nada retoma sozinho
- [ ] Reaplicar a escolha de continuidade e modo salvos por projeto
- [ ] Notificação do sistema ao terminar fase / plano / pausa por falha

### Verificação da Fase 4
- [ ] `kill -9` do daemon no meio de um step: ao reabrir, step aparece interrompido, nenhum processo órfão de CLI (auditoria por tag de ambiente), retomar refaz o step e o plano termina
- [ ] Reboot real da máquina no meio de um plano, mesma expectativa
- [ ] Editar plano pausado (inserir step, mudar tier) e retomar: novo step roda com o tier novo

---

## Fora de escopo

- A/B, baterias, score, Capability Matrix, evidência write-once, recovery/adopt/revalidate.
- Perfis `metered_api` (OpenRouter) no roteamento automático.
- macOS/Windows.
- Qualquer edição em `src/`, `dev/` ou `test/` da raiz.

## Decisões (2026-10-06)

- **Q1 aceita.** `Plan` = read-only; `Edit` = edita arquivos e roda só a allowlist de comandos do projeto (gate, build, test, git de leitura); `Auto` = qualquer shell exceto `git commit/push` e destrutivos. `--dangerously-skip-permissions` proibido.
- **Q2 aceita.** `premium` = Claude Opus 5 high, Codex gpt-5.6-sol high; `standard` = Claude Sonnet 5 medium, Codex gpt-5.6-sol medium, OpenCode Go GLM 5.3; `economy` = Codex gpt-5.6-luna medium, OpenCode Go DeepSeek V4 Flash.
- **Q3 aceita.** Leases espalham carga entre providers do tier. Teto de leases por pool existe como configuração opcional, **sem teto por padrão** (limite só com causa real). Medidores atualizam por evento (abertura, antes de cada step, botão manual); sem polling de fundo.
- **Q4 aceita.** Daemon em `utilityProcess` do Electron.
- **Q6 aceita.** electron-vite + electron-builder (AppImage).
- **Q7 aceita.** `plan.md` em `.asl/plan.md` no repo alvo, commitado junto.
- **Q5 pendente** — projeto real para a verificação da Fase 1 e o MVP. Não bloqueia 1.1–1.6.
- **Q8 pendente** — destino da branch `fix/verification-process-recovery`.

## Perguntas originais (histórico)

- **Q1 — semântica de `Edit` vs `Auto` em modo headless.** Sem humano no loop, "pedir permissão" trava o processo (lição do OpenCode: `ask` não interativo trava). Proposta: `Plan` = read-only; `Edit` = edita arquivos e roda só comandos de uma allowlist do projeto (gate, build, test, git de leitura); `Auto` = qualquer shell, exceto `git commit/push` e destrutivos. `--dangerously-skip-permissions` continua proibido.
- **Q2 — catálogo inicial por tier.** Proposta: `premium` = Claude Opus 5 high, Codex gpt-5.6-sol high; `standard` = Claude Sonnet 5 medium, Codex gpt-5.6-sol medium, OpenCode Go GLM 5.3; `economy` = Codex gpt-5.6-luna medium, OpenCode Go DeepSeek V4 Flash. Confirmar ou ajustar.
- **Q3 — broker.** Precisa de teto de execuções simultâneas por pool (ex.: 1 por pool), ou só espalhar carga? Medidores atualizam só por evento (proposta) ou também em intervalo?
- **Q4 — daemon.** Core no processo main do Electron (mais simples) ou em `utilityProcess` (UI travada não derruba loops)? Proposta: `utilityProcess`.
- **Q5 — projeto real** para a verificação da Fase 1 e o MVP.
- **Q6 — toolchain Electron.** electron-vite + electron-builder (AppImage) ok?
- **Q7 — `plan.md`** fica em `.asl/plan.md` no repo alvo e é commitado junto? Ou fora do repo?
- **Q8 — branch anterior** `fix/verification-process-recovery` (4f52981, só docs, sem push/PR): enviar, abrir PR ou abandonar?
