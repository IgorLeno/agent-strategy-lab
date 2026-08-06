# ADR-0001 — Stack do `agentlab` e driver de SQLite

- **Status:** aceito
- **Data:** 2026-08-06
- **Contexto da decisão:** M01 (scaffold do produto)
- **Substitui:** —

---

## Contexto

O `agentlab` executa CLIs de agente em clones descartáveis, captura evidência em
disco e a indexa para consulta. Isso põe três exigências sobre a stack:

1. **controle de processo de primeira classe** — spawn por argv sem shell,
   process group próprio, sinais no grupo, captura incremental de streams;
2. **evidência auditável** — hashing canônico, JSONL, manifests, verificação de
   integridade;
3. **índice consultável e descartável** — a fonte de verdade é o disco; o índice
   existe para responder pergunta agregada rápido.

A decisão precisa ser tomada agora porque o layout de `src/` e os scripts de
build/test/typecheck saem daqui, e trocar de runtime ou de driver depois de
M11–M20 significaria reescrever a camada de evidência.

---

## Decisão

### Runtime e linguagem

- **Node ≥ 22.13.0** (desenvolvido em v22.22.2), **TypeScript ESM** com
  `module`/`moduleResolution: NodeNext`, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes` e `verbatimModuleSyntax`.

O piso 22.13.0 não é arbitrário: é a versão a partir da qual `node:sqlite`
existe sem flag (ver abaixo), e fixá-lo mantém a opção de migrar aberta sem
mexer em `engines` depois.

### Dependências

| Pacote | Papel | Por quê |
| --- | --- | --- |
| `zod` | schemas dos contratos | validação em runtime **e** tipo estático da mesma definição; a fronteira do lab é dado de fora (YAML, JSON de provider), onde tipo de compilação não protege |
| `yaml` | receitas de estratégia, config do projeto | formato que humano edita à mão |
| `vitest` | testes | roda TS/ESM sem etapa de build separada |
| `tsx` | CLIs do harness (`dev/`) | executa TS direto, sem `dist/` |
| `typescript` | build (`tsc`) | emite `dist/` com `.d.ts` |
| `better-sqlite3` | índice de runs (a partir de **M30**) | ver a seção seguinte |

`better-sqlite3` **não** é instalado em M01: nada antes de M30 o usa, e trazer
um addon nativo para a árvore antes da primeira linha que o consome só antecipa
o custo de build. A escolha fica registrada aqui.

### Driver de SQLite: `better-sqlite3`

Escolhido por **maturidade e API síncrona** — não por causa de flag de runtime.

- **API síncrona** casa com o uso real: a indexação acontece no fim de um run,
  em lote, em processo de CLI de vida curta. Não há loop de eventos servindo
  requisição concorrente para bloquear. Código de índice síncrono é
  drasticamente mais simples de acertar em transação e em rollback — e é o
  código que M31 precisa reconstruir do zero e comparar por paridade.
- **Maturidade** — anos de uso em produção, comportamento conhecido em
  transação, `WAL` e prepared statements, e semântica estável entre versões.

Sobre o `node:sqlite` embutido, o registro correto do estado das coisas:

- ele **dispensa flag desde o Node 22.13.0** — `--experimental-sqlite` deixou de
  ser necessário ali;
- ele **segue marcado como experimental na linha 22**, o que significa que a API
  pode mudar em release minor.

Ou seja: **"precisa de flag" não é o motivo da recusa** — esse motivo deixou de
existir. O motivo é que uma API experimental que pode mudar em minor é uma base
ruim para a camada que M31 usa para provar paridade de rebuild, e a vantagem que
ele ofereceria (zero addon nativo) é justamente o risco que aceitamos com olhos
abertos abaixo.

---

## Consequências

### Positivas

- Um único vocabulário de schema (`zod`) da borda até os records.
- Indexação síncrona: transação e rollback triviais de verificar em teste.
- `dist/` com `.d.ts` desde M01, então o build é um gate real e não decorativo.

### Negativas — o risco de addon nativo, registrado

`better-sqlite3` é um **addon nativo**. Consequências assumidas:

1. **Depende de prebuild para a versão de Node/ABI em uso.** Sem prebuild
   compatível, a instalação compila do código-fonte e passa a exigir toolchain
   C++ (`node-gyp`, compilador, `python`) na máquina.
2. **Atualizar o Node pode quebrar a instalação** até sair prebuild da nova ABI —
   e o momento de descobrir isso costuma ser o pior possível.
3. **`pnpm` não roda script de build de dependência por padrão.** O pacote
   precisa entrar em `pnpm.onlyBuiltDependencies` no `package.json`, junto do
   `esbuild` que já está lá. Esquecer isso produz falha em runtime, não em
   install.
4. **Ambiente de CI e container precisam do mesmo cuidado** — imagem slim sem
   toolchain e sem prebuild compatível falha no install.

### Mitigação

O índice é **derivado e descartável**, por desenho — não é uma consequência
feliz, é a razão de o desenho ser esse. M31 exige que apagar o `.db` e
reconstruir a partir de `data/runs/` dê paridade lógica, e nenhum dado pode
existir apenas no índice.

Disso decorre que trocar de driver — para `node:sqlite` quando ele estabilizar
na linha LTS, ou para qualquer outro — é uma mudança contida em `src/storage/`,
sem migração de dados e sem perda de evidência. O acesso ao SQLite fica atrás da
interface de `src/storage/`; nenhuma outra área importa o driver diretamente.

---

## Alternativas consideradas

| Alternativa | Por que não |
| --- | --- |
| **`node:sqlite`** | sem flag desde 22.13.0, mas experimental na linha 22 — API pode mudar em minor, e é a camada que M31 usa para provar paridade. Reavaliar quando estabilizar |
| **`node-sqlite3-wasm` / `sql.js`** | evitam o addon nativo, mas trocam o risco por WASM mais lento e por um caminho de persistência menos direto, para ganhar num índice que já é descartável |
| **Índice só em JSON/JSONL** | zero dependências, mas consulta agregada sobre milhares de runs vira varredura completa; o índice existe exatamente para isso |
| **Postgres/serviço externo** | serviço para rodar antes de um benchmark local é atrito desproporcional; a evidência já é o disco |
| **Deno / Bun** | ecossistema de teste e de spawn com process group menos batido para o que M21–M24B exigem; Node é o caminho mais previsível |

---

## Revisar quando

- `node:sqlite` deixar de ser experimental numa linha LTS que possamos exigir;
- o addon nativo custar tempo real de instalação ou de CI mais de uma vez;
- o índice deixar de ser descartável — o que invalidaria a mitigação inteira e
  exigiria ADR nova antes de qualquer outra coisa.
