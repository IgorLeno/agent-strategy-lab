# Política de cobrança: assinatura, nunca API

> assinatura não é API;
> estimativa em dólares não é cobrança;
> fonte de credencial desconhecida bloqueia o run.

Todo run real deste laboratório é pago pelas assinaturas do usuário:

| Agente | Credencial aceita | Como é provada |
| --- | --- | --- |
| Claude Code | assinatura Claude Pro (login/OAuth) | `claude auth status --json` → `authMethod=claude.ai` + `apiProvider=firstParty` + `subscriptionType` presente |
| Codex | assinatura ChatGPT Plus ("Sign in with ChatGPT") | `codex login status` → "Logged in using ChatGPT" |

Os dois comandos são **locais e gratuitos**: leem a sessão já autenticada e não
gastam turno de modelo. A saída do Claude traz e-mail e id de organização —
nada disso entra em relatório, log ou record.

Nenhum run pode usar Anthropic API, OpenAI API, créditos de Console ou cobrança
por chave.

## Onde a política é aplicada

1. **No carregamento do perfil** (`dev/lib/profile.ts`). Perfil de agente real
   precisa declarar `billing_mode`. Perfil `subscription_only` é recusado se
   tiver variável de API na `env_allowlist`/`env_extra`, ou uma flag que troca a
   fonte da credencial (`--bare`, `--with-api-key`, `--with-access-token`).
2. **No `dev-doctor`**, antes de qualquer run pago: modo de cobrança, variáveis
   de API que chegariam ao worker e prova positiva da fonte da credencial.
3. **No preflight do `dev-launch`/`dev-orchestrate`**, repetido a cada
   lançamento — o doctor pode ter rodado ontem, a máquina pode ter mudado.

O preflight recusa quando: `billing_mode` não é `subscription_only`; a fonte é
API; a fonte não pode ser verificada; ou uma variável de API está no ambiente
final do worker. A recusa acontece **antes do spawn** — nenhum processo nasce,
nenhum token é gasto — e classifica como `INFRA_ERROR`, nunca `FAIL`: não é
veredito sobre o worker.

**Ausência de chave de API não prova assinatura.** Sem resposta reconhecível da
CLI o veredito é `FAIL: credential source could not be verified`.

## `--bare` é incompatível com assinatura

`--bare` é a única flag que desliga auto-descoberta de CLAUDE.md, hooks, plugins
e auto-memory — e a própria CLI documenta que nesse modo "Anthropic auth is
strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`; OAuth and keychain are never
read".

Consequência assumida: **com assinatura não existe modo `controlled` para o
Claude**. Os perfis de assinatura são `real-world`, e os marcadores
`instruction_discovery`, `plugins_and_hooks` e `auto_memory` ficam registrados
como "não controlado" no LaunchRecord. Cobrança e ambiente são dimensões
separadas: `billing_mode` e `environment_mode` são campos distintos, e um perfil
`controlled` não seria "de graça" por isso.

## Variáveis bloqueadas

Verificadas contra os binários instalados (Claude Code 2.1.223, codex-cli
0.146.0) — todas aparecem literalmente no executável, ou seja, a CLI as
reconhece:

```
ANTHROPIC_API_KEY · ANTHROPIC_AUTH_TOKEN · ANTHROPIC_BASE_URL
ANTHROPIC_CUSTOM_HEADERS · ANTHROPIC_BEDROCK_BASE_URL · ANTHROPIC_VERTEX_BASE_URL
AWS_BEARER_TOKEN_BEDROCK · CLAUDE_CODE_API_KEY_HELPER_TTL_MS
CLAUDE_CODE_USE_BEDROCK · CLAUDE_CODE_USE_VERTEX · CLAUDE_CODE_USE_FOUNDRY
OPENAI_API_KEY · CODEX_API_KEY · CODEX_ACCESS_TOKEN · OPENAI_ORGANIZATION
OPENAI_BASE_URL (defensiva: não aparece no binário, mas é a variável padrão do SDK)
```

`CODEX_HOME` **não** entra: é diretório de configuração, não credencial.

O ambiente do worker é construído por allowlist, então nenhuma delas passa nem
se estiver exportada no shell do usuário. Só **nomes** aparecem em mensagens de
erro — valor de credencial nunca é registrado.

## Custo: equivalência estimada ≠ cobrança

O LaunchRecord traz um bloco `billing` com campos separados de propósito. Um
único `cost_usd` misturaria "o que a CLI estimou em preço de API" com "o que foi
cobrado", e são coisas diferentes:

```yaml
billing:
  mode: subscription_only
  credential_source: claude_subscription_oauth   # ou chatgpt_subscription
  included_allowance_consumed: true
  provider_estimated_api_equivalent_usd: 0.532   # estimativa por tokens
  actual_incremental_charge_usd: null            # sem fonte autoritativa
  authoritative_billing_verified: false
```

- `total_cost_usd` emitido pela CLI é **equivalência estimada segundo preços de
  API**, calculada sobre tokens. Com assinatura, o run consome a franquia
  incluída e o número não corresponde a cobrança adicional nenhuma.
- `actual_incremental_charge_usd` continua `null` salvo com fonte de faturamento
  autoritativa — o schema recusa valor sem `authoritative_billing_verified`.
  Inferir `0` seria a mesma mentira que chamar a estimativa de cobrança.
- Relatórios de terminal escrevem *"custo equivalente estimado (preço de API),
  não custo pago"*. Tokens, turnos e duração continuam registrados normalmente.

### Nota sobre os números do S15

Os artifacts do S15 não foram reescritos. Para o registro:

```
US$ 1,6238 foi o custo equivalente estimado pela CLI com base em tokens,
não uma cobrança adicional confirmada.
```

O mesmo vale para os parciais citados em `docs/S15-run-real.md` (US$ 0,5320,
US$ 0,3785, US$ 0,9105 e US$ 0,7133). Um teste compara o arquivo, byte a byte,
com a versão do commit que o gravou.

## Perfis

| Perfil | Cobrança | Ambiente |
| --- | --- | --- |
| `claude-build-worker-subscription-v1` | `subscription_only` | `real-world` |
| `codex-build-worker-subscription-v1` | `subscription_only` | `real-world` |
| `fake-worker-v1` | `not_applicable` | — |

`claude-build-worker-v1`, `claude-build-worker-v2` e `codex-build-worker-v1`
foram removidos: mantinham `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` na allowlist.
O git guarda o histórico deles.

Não existe perfil de API neste repositório, e ele **não** é fallback: se algum
for criado, precisa ter `api` no id, declarar `billing_mode: api`, nunca ser
default e só rodar com autorização manual explícita —
`AGENTLAB_ALLOW_API_BILLING=eu-autorizo-cobranca-por-api` no ambiente do
orquestrador.

O default de `dev-launch`, `dev-orchestrate` e `dev-doctor` vem de
`dev/lib/defaults.ts`, num lugar só, e é um perfil de assinatura.
