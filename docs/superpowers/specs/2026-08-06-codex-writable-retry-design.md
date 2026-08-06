# Codex Writable Sessions and Auditable Retry Design

## Goal

Corrigir exclusivamente o adapter Codex do harness: permitir escrita limitada
no workspace, remover descoberta pelo HOME pessoal e abandonar com evidência a
tentativa M02 que terminou sem output. M02, output schemas e o produto em
`src/` ficam fora deste trabalho.

## Profile and instruction environment

O perfil continua `environment_mode: real-world`, `subscription_only`, modelo
`gpt-5.6-sol` e reasoning `high`. O argv acrescenta exatamente
`--sandbox workspace-write`, `--ephemeral` e `--ignore-rules`; full access e
flags que ignoram sandbox/aprovação são recusadas no carregamento do perfil.

`instruction_environment: sanitized_user_home` é uma dimensão separada. O
launcher substitui `HOME` por `.dev/homes/<profile-id>` e torna explícito o
`CODEX_HOME` efetivo do usuário (`$CODEX_HOME` ou, quando ausente,
`$HOME/.codex`). Nenhum arquivo de configuração, skill ou auth é copiado. A
prova de autenticação permanece `codex login status`, executada com o mesmo
ambiente que o worker receberia. A identidade Git vem somente das quatro
variáveis `GIT_*_NAME`/`GIT_*_EMAIL`; o doctor usa `git var` para falhar antes
do run quando autor ou committer não puder ser resolvido.

O doctor reporta independentemente sandbox, persistência da sessão, config do
usuário, regras de execpolicy, ambiente de instruções, modelo, reasoning,
billing e fonte da credencial. `--ignore-rules` é descrito apenas como controle
de execpolicy; a ausência de `~/.agents` decorre do HOME sanitizado.

## Lean prompt

O preâmbulo do worker manda começar pelo packet e `initial_files`, não carregar
skills ou subagentes sem pedido explícito, preferir `rg` e leituras por
intervalo, evitar leitura integral de documentos gerais, buscar a primeira
edição em até oito operações exploratórias para tarefas localizadas e não
fazer revisão geral do repositório.

## Abandoned attempt transaction

`dev-retry` roda sob o lock do harness. Ele aceita apenas uma tarefa
`RUNNING/FINALIZING` cujo processo morreu, sem candidate/accepted commit,
report, handoff draft ou outra tarefa RUNNING, e exige LaunchRecord final.
Árvore suja sempre bloqueia.

No modo normal, HEAD precisa ser igual ao `base_sha`. Com
`--allow-pending-maintenance`, `base_sha` precisa ser também o
`authorized_head_sha`, e HEAD precisa ser exatamente um commit filho direto
dessa base. Cada arquivo do commit passa pela mesma allowlist da adoção de
manutenção; `src/**`, `dev/plan.yaml`, `.dev/**`, `.dev-inbox/**` e artifacts
históricos são recusados.

Antes do state, o comando grava atomicamente
`.dev/attempts/<task>/<attempt>-abandoned.json`. Só depois move M02 para READY,
zera fase/processo/candidate/accepted e timestamps operacionais, preserva
`attempts: 1`, M01, artifacts e `authorized_head_sha`. Repetir a mesma
solicitação reutiliza o record; record divergente falha fechado. Um crash após
o record é reconciliado repetindo `dev-retry`.

O commit de manutenção ainda não autorizado mantém a guarda de base bloqueada.
`dev-adopt-maintenance` adota o único commit depois do retry. Se um
MaintenanceRecord já tiver sido gravado antes do state, repetir a adoção
verifica o record e conclui apenas a atualização pendente, sem reescrever a
evidência.

## Verification

Fixtures substituem Codex, Claude e qualquer API. Os testes exercitam o perfil,
doctor, ambiente exato do subprocesso, prompt, todas as recusas do retry, ordem
record-before-state, reconciliação e preservação histórica. Os gates finais são
`pnpm typecheck`, `pnpm build`, `pnpm test` e `git diff --check`.
