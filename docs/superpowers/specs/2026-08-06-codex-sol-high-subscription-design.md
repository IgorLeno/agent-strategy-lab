# Codex Sol High por assinatura — desenho

## Objetivo

Adicionar um perfil Codex não interativo cuja linha de comando seja prova
suficiente de que todo run usa `gpt-5.6-sol`, reasoning `high` e autenticação
da assinatura ChatGPT, sem deixar credenciais de API chegarem ao processo.

## Evidência local da CLI

O desenho usa somente a CLI instalada, `codex-cli 0.146.1`. O help de
`codex exec` não oferece uma flag própria de reasoning, mas reconhece
`--config <key=value>` como override explícito e `--ignore-user-config` para
não carregar `$CODEX_HOME/config.toml`. Por isso o argv versionado usará:

```text
--ignore-user-config --model gpt-5.6-sol
--config model_reasoning_effort="high"
```

`--strict-config` continuará presente, de modo que um run futuro recusará uma
chave de configuração que a versão instalada não aceite. Nenhum run será feito
durante esta manutenção.

## Componentes

- `dev/profiles/codex-build-worker-subscription-high-v1.yaml` preserva o
  contrato operacional do perfil atual e acrescenta somente a fixação explícita
  do reasoning e a independência do config pessoal.
- `dev/lib/doctor.ts` extrai modelo e reasoning do argv efetivo, exige
  `gpt-5.6-sol` e `high` para Codex, e publica `model`, `reasoning_effort`,
  `billing_mode` e `credential_source` como dimensões separadas.
- `fixtures/fake-clis/codex` anuncia as opções usadas pelo perfil, permitindo
  que o doctor valide o help sem chamar Codex real.
- `test/dev/doctor.test.ts` cobre o contrato High, valores incorretos, perfil
  legado, fonte de autenticação e saneamento do ambiente usando apenas a CLI
  falsa.

## Regras de decisão

Para Codex, reasoning ausente, duplicado ou malformado resulta em
`reasoning_effort: unknown` e check `FAIL`. Valores explícitos diferentes de
High, como `medium` e `xhigh`, aparecem como recebidos para diagnóstico, mas o
check permanece `FAIL`. O perfil legado segue válido no schema, mas não é
classificado como High. O check de flags precisa confirmar `--config` e
`--ignore-user-config` no help da CLI. Fonte de credencial desconhecida ou API
também mantém o relatório em `FAIL`.

Para Claude e worker falso, o novo contrato de reasoning Codex não se aplica;
os checks existentes continuam com `SKIP`. A autenticação Codex continua sendo
provada localmente por `codex login status`, sem turno de modelo ou API.

## Verificação e estado

Os testes são escritos e observados em RED antes da implementação. Depois do
GREEN serão executados `pnpm typecheck`, `pnpm build`, `pnpm test` e
`git diff --check`. Haverá exatamente um commit local com a mensagem solicitada.
Com a árvore limpa, `dev-adopt-maintenance` atualizará somente o checkpoint de
manutenção; M02 não será executada e nenhum worker será iniciado.
