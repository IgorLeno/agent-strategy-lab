# Providers, scaffolds e pools de quota

> Este documento descreve o que EXISTE no código depois do Provider Expansion
> v1. Ele não é roadmap.

## 1. Sete dimensões, sete campos

O harness nasceu com um campo — `agent` — que significava, ao mesmo tempo:
qual executável roda, com quem ele fala, quem paga, e de qual franquia sai o
consumo. Enquanto existiam só Claude Code e Codex CLI as quatro respostas
coincidiam, e a coincidência passava por design.

OpenCode quebra a coincidência: o MESMO executável fala com três upstreams, com
três mecanismos de autenticação, dois modos de cobrança e três pools de quota.

| dimensão | onde vive | exemplo |
| --- | --- | --- |
| execution scaffold | `LauncherProfile.agent` | `opencode` |
| provider (upstream) | `LauncherProfile.provider` | `opencode_go` |
| model | argv (`--model`) | `opencode-go/deepseek-v4-flash` |
| auth method | derivado do contrato | `api_key` |
| billing mode | derivado do contrato | `subscription` |
| quota pool | derivado do contrato | `opencode_go_subscription` |
| capability | `LauncherProfile.capability_prior` | `tier: economy` |
| role permissions | `dev/lib/opencode-scaffold.ts` | `edit: deny` |

Auth, cobrança e pool NÃO são declarados por perfil: eles são consequência do
upstream, e a tabela que os define é `PROVIDER_CONTRACTS`
(`src/providers/identity.ts`). Deixar um YAML redeclará-los permitiria que um
arquivo contradissesse o contrato comercial.

## 2. As duas invariantes impostas

### auth != billing

    Uma chave de API do OpenCode Go autentica uma ASSINATURA de valor fixo.

A regra antiga do laboratório era `chave => cobrança por API`. Com ela, essa
combinação era irrepresentável sem enfraquecer a proteção de cobrança. O modelo
foi refinado em vez de afrouxado: `AuthMethod` e `BillingMode` são enums
separados, e a tabela de contratos é quem os liga.

| upstream | auth | cobrança | pool |
| --- | --- | --- | --- |
| `anthropic` | OAuth de assinatura | assinatura | `anthropic_subscription` |
| `openai` | OAuth ChatGPT | assinatura | `openai_chatgpt_subscription` |
| `opencode_go` | **chave de API** | **assinatura** | `opencode_go_subscription` |
| `openrouter` | chave de API | cobrança por uso | `openrouter_balance` |
| `none` | — | não se aplica | — |

### scaffold != provider != pool

    Codex CLI -> OpenAI e OpenCode -> OpenAI, na MESMA conta ChatGPT,
    consomem UMA franquia.

Provado experimentalmente: o probe de uso reagiu ao consumo do Codex CLI, e as
duas credenciais (Codex e OpenCode) referenciavam a mesma conta.

Consequências no código:

- `DiversityFacts.provider` é o UPSTREAM. Trocar de executável contra o mesmo
  provider não é uma segunda opinião independente.
- `EvidenceBalanceFacts.quota_headroom_by_pool` é indexado pelo POOL. Dois
  perfis do mesmo pool enxergam a MESMA folga e nunca somam capacidade.
- `EscalationAuthorization.cross_provider` é decidido pelos upstreams, e
  `shares_quota_pool` registra quando a franquia é a mesma.

## 3. Compatibilidade com perfis existentes

Perfis Claude e Codex já gravados não declaram nada disso e continuam válidos.
A identidade é DERIVADA de `agent` + `billing_mode` + o modelo já lido do argv
(`resolveProfileIdentity`, `src/providers/normalize.ts`).

Quando a combinação de um perfil legado não tem contrato declarado — cobrança
por API contra um upstream que o Lab não contratou —, o resultado é
`UNMAPPABLE` com motivo, e o caminho legado continua governando aquele perfil
intocado. Inventar um contrato mudaria a autorização de cobrança de um perfil
histórico, que é exatamente o que uma migração não pode fazer.

`legacyBillingAgrees` recusa qualquer normalização que troque quem paga.

Registros históricos continuam legíveis: `LaunchRecord.pool_capacity` e
`LaunchRecord.opencode_launch` são `null` nos records anteriores, e
`subscription_usage` (a medição Claude) permanece exatamente onde estava.

## 4. Segurança de role no OpenCode — estrutural

Planner e reviewer são read-only por MECANISMO, não por pedido no prompt.

O que foi lido no binário instalado (1.18.23) e é a base do desenho:

- `Permission.ask` avalia a regra ANTES de publicar qualquer pedido:
  `action === "deny"` levanta `DeniedError` na hora. O evento
  `permission.asked` — o único que `--auto` responde — nunca chega a existir
  para uma permissão negada. **`deny` não é contornável por `--auto`.**
- `Permission.disabled` remove do toolset VISÍVEL toda ferramenta cuja regra
  resolvida seja `*` + `deny`. A ferramenta negada não é recusada depois de
  escolhida: ela não é oferecida.
- `Permission.fromConfig` transforma o objeto de configuração numa lista de
  regras na ORDEM DAS CHAVES, e `evaluate` usa `findLast`. **A última regra que
  casa vence.** Por isso o catch-all `*` vem PRIMEIRO e as liberações vêm
  depois.
- Sem regra que case, o default é `ask`. Um `ask` num processo não interativo
  trava, e travar não é o mesmo que negar — por isso toda role fecha com um
  catch-all explícito.

O Lab escreve o objeto COMPLETO em `OPENCODE_PERMISSION`, que a CLI mescla por
ÚLTIMO sobre a configuração global e a de projeto. O objeto é completo porque a
mescla é POR CHAVE: uma chave omitida herdaria o que o usuário tiver
configurado.

| role | mutação | leitura | fronteira |
| --- | --- | --- | --- |
| planner | `deny` em edit/write/patch/apply_patch/bash | read/glob/grep/list/lsp | `external_directory: deny` |
| reviewer | idem | idem | idem |
| implementer | `allow` em edit/write/patch | tudo acima + bash | `external_directory: deny`; `git commit`/`git push` negados |

A configuração global do OpenCode do usuário NÃO é lida como garantia e NÃO é
modificada. `--auto` é proibida no argv de todo perfil OpenCode.

`assertReadOnlyArgv` prova a fronteira DEPOIS DO FATO, resolvendo a permissão
lançada pela mesma regra da CLI — uma tabela onde um curinga posterior
reabrisse `edit` é recusada.

## 5. Observação de quota

`PoolCapacityObservation` (`src/quota/observation.ts`) é o contrato normalizado.

| status | significado |
| --- | --- |
| `KNOWN` | medida numérica observada do provider |
| `AVAILABLE_WITHOUT_METER` | disponível, sem medidor de folga. Não é 100%, não é 0% |
| `EXHAUSTED` | o PROVIDER declarou esgotamento |
| `UNKNOWN` | não observado. Nunca interpretável como esgotado nem como livre |

### Fontes

| pool | fonte | janelas | precisão |
| --- | --- | --- | --- |
| `anthropic_subscription` | `claude -p /usage` (preservado) | 5h, 7d | fracionária |
| `openai_chatgpt_subscription` | `GET /backend-api/wham/usage` | primary (~5h), secondary (semanal) | percentual INTEIRO |
| `opencode_go_subscription` | `GET /zen/go/v1/usage` | rolling, weekly, monthly | percentual INTEIRO |
| `openrouter_balance` | `GET /api/v1/credits` | — | saldo em USD |

Nenhum probe faz inferência. Nenhum envia prompt ou escolhe modelo.

### Precisão nunca é inventada

O endpoint do OpenCode Go expõe INTEIRO; o dashboard do navegador mostra
fração (3,6% onde a API diz 3). A API é a fonte, o dashboard NÃO é raspado, e o
valor é gravado como veio com `precision: COARSE_INTEGER_PERCENT`.

    `percent: 0` significa "o inteiro reportado é 0".
    NÃO significa "nenhum token foi consumido".

Há consumo real abaixo da resolução do medidor, e ele não aparece ali. A TUI
marca essas janelas com `~` (`rolling=0%~ used`) para que o número não seja
lido como zero consumo.

Da mesma forma, um "Oi" moveu a janela OpenAI de 0% para 1% no experimento
real. Isso é a RESOLUÇÃO do medidor, não o custo de uma mensagem: cem "Oi" não
consomem a franquia inteira.

### Delta não atravessa reset

`windowDeltas` só subtrai quando as duas leituras pertencem à MESMA instância
de janela — identificada pelo instante de reset que o provider reportou. Se a
janela virou, o resultado é `consumed_pp: null` com `window_reset: true`, nunca
um consumo negativo inventado. É o mesmo princípio que a medição Claude já
seguia, generalizado.

### Delta é observação, não preço

Um ponto percentual de OpenAI **não** é um ponto percentual de OpenCode Go:
denominadores e políticas são diferentes. Os deltas são gravados; nenhuma
conversão universal é inventada.

### Segredos

Nenhum token, chave, `account_id` ou e-mail entra em record, log ou teste. As
credenciais vivem dentro de `SealedCredential`, que as aplica a um header e
cujo `toJSON` devolve um rótulo. A identidade de conta atravessa apenas como
FINGERPRINT salgado e não reversível, usado só para igualdade — que é o que
prova se Codex e OpenCode observam o mesmo pool.

`/api/v1/credits` é usado em vez de `/api/v1/key` justamente porque a resposta
de `/key` inclui um rótulo derivado da própria chave.

## 5.1 Quota ATUAL é sempre observada agora

> **Invariante.** A quota usada para QUALQUER decisão de execução vem sempre de
> uma leitura fresca, feita imediatamente para a atividade corrente.

Quota histórica pode descrever consumo passado e alimentar analytics de
eficiência de modelo. Ela **nunca** descreve capacidade presente, e **nunca**
bloqueia nem autoriza uma atividade nova.

### O que é "atual"

| fonte | é quota atual? |
| --- | --- |
| observação feita por ESTA atividade, antes de rotear | sim |
| a mesma observação reusada dentro da MESMA decisão imediata | sim |
| `LaunchRecord.pool_capacity` de qualquer launch anterior | não |
| `LaunchRecord.subscription_usage` de qualquer launch anterior | não |
| `LaunchRecord.rate_limit_observations` de qualquer launch anterior | não |
| um `EXHAUSTED` observado numa work unit anterior | não |

### Ciclo por atividade

```
atividade vai começar
  -> candidatos autorizados e compatíveis com o role são conhecidos
  -> pools ÚNICOS desses candidatos são resolvidos
  -> probes read-only são executados AGORA (um por pool)
  -> currentCapacityByPool
  -> elegibilidade + routing
  -> profile selecionado
  -> o MESMO snapshot vira o `before` do LaunchRecord
  -> worker executa
  -> UMA observação `after`
```

A próxima atividade recomeça do topo. Não existe `quota_cache_ttl`, e não
existe reuso entre work units, entre turnos de deliberação ou entre roles.

### Escopo exato da deduplicação

Dentro de UMA decisão imediata, o snapshot é indexado por POOL e reusado. Codex
CLI e OpenCode/OpenAI compartilham `openai_chatgpt_subscription`: quando os dois
são candidatos do mesmo assessment, o endpoint é chamado **uma vez**. O mesmo
vale para os degraus de uma única decisão de escalation.

Fora dessa decisão, nada é reusado.

### UNKNOWN não tem substituto

Probe que falhou — rede, endpoint mudado, credencial ilegível, parse quebrado —
produz `UNKNOWN` com proveniência. `UNKNOWN` não vira `0%`, não vira
`EXHAUSTED`, não vira indisponibilidade e **não** é preenchido por histórico. Um
chamador isolado que não forneça observação fresca recebe `UNKNOWN`.

### Quem observa

`collectCurrentLaunchFacts` (`dev/lib/project-preflight.ts`) é o caminho ÚNICO
de todo role provider-backed — planner, deliberador, implementer, reviewer,
bounded repair e degrau de escalation. Não há um segundo regime de quota por
role.

### História de DESEMPENHO permanece intacta

Pass rate, repair rate, duração, tokens, resultado de validação e
`quota.consumed_pp.p90_total` continuam alimentando o routing por qualidade e
eficiência. Consumo passado é uma métrica de desempenho do modelo; capacidade
presente é outra pergunta, e só a leitura fresca a responde.

`LaunchRecord.pool_capacity.before/after/deltas` continua gravado, e continua
sendo evidência experimental do launch CONCLUÍDO. Nenhum código de produção o
lê para inferir quanta quota existe agora.

## 6. Quota é evidência de routing, não gate de execução

A ordem de decisão do routing é:

1. autorização
2. segurança
3. credencial/disponibilidade do provider
4. **capacidade suficiente**
5. história, quando decisiva
6. exploração / diversidade / folga de quota / custo
7. desempate determinístico

    Folga BAIXA é preferência. Só esgotamento REAL remove um perfil.

Não existe nenhuma regra do tipo `restante < X% => proibido`. O único código de
recusa por quota é `QUOTA_POOL_EXHAUSTED`, e ele exige que o PROVIDER tenha
declarado esgotamento (`limit_reached`, status de limite, saldo zerado).
Nenhum percentual, por menor que seja, o produz. Ele também é temporário: no
reset da janela o perfil volta a ser elegível, e por isso não vira
`HUMAN_REQUIRED` enquanto houver alternativa autorizada e capaz.

`UNKNOWN` nunca vira esgotado, e nunca vira zero. Quando um dos comparados tem
`UNKNOWN`, a quota simplesmente NÃO desempata — comparar um percentual
observado contra um ausente inventaria o lado que falta.

Sob `static_cost`, o esgotamento ATUAL continua afetando elegibilidade — ele é
um fato de disponibilidade real, não uma preferência. Já a folga não-esgotada
NÃO participa: `static_cost` desempata por custo estático, e 80% contra 20% não
muda essa ordem. `SelectionEvidence.quota_considered` registra isso.

## 7. evidence_balanced com perfis novos

Um perfil novo entra com zero amostras, o que é um FATO — e é justamente o fato
que a política de cold-start usa para preferir adquirir a evidência que falta.
A ordem do desempate, entre perfis JÁ do menor tier suficiente:

1. perfil menos amostrado
2. **upstream** menos amostrado
3. menor concentração nesta run
4. maior folga de quota OBSERVADA **nesta atividade** (só quando conhecida
   para TODOS)
5. custo estático declarado
6. `profile_id`

O balanceamento NÃO amplia elegibilidade. Um perfil de capacidade insuficiente
nunca vence por exploração, por quota nem por custo — a capacidade continua
sendo o filtro, e o equilíbrio é só o critério entre iguais. Quando a história
se torna decisiva, ela vence a exploração.

Não há nenhuma regra do tipo "modelo chinês é melhor" ou "modelo barato é
sempre preferido". O propósito do Lab é aprender isso empiricamente.

## 8. Como acrescentar outro modelo

Escrever um arquivo de perfil. Não editar o router.

```yaml
id: opencode-go-modelo-novo-v1
agent: opencode              # SCAFFOLD
provider: opencode_go        # UPSTREAM (auth/cobrança/pool vêm do contrato)
billing_mode: subscription_only
commit_owner: orchestrator
official_validation_owner: orchestrator
worker_validation_policy: targeted
argv: [opencode, run, --format, json, --model, opencode-go/modelo-novo]
prompt_delivery: argv
capability_prior:
  tier: intermediate         # PRIOR conservador, não benchmark
  model_cost_rank: 2
  rationale: 'por que este tier, em uma frase'
forbidden_flags: [--continue, -c, --session, -s, --fork, --auto, --share]
env_allowlist: [PATH, HOME, LANG, LC_ALL, TERM, USER, SHELL]
```

O que o schema verifica antes de qualquer execução:

- `provider` declarado (para `opencode` é obrigatório: o scaffold não determina
  o upstream);
- o prefixo do `--model` CONCORDA com o `provider` declarado — duas afirmações
  independentes sobre a mesma coisa, e a discordância pega o perfil rotulado
  como assinatura apontando para um modelo cobrado por uso;
- `billing_mode` concorda com o contrato comercial do upstream;
- `capability_prior` presente (sem ele o router não classifica o modelo e o
  perfil nunca seria elegível — melhor um erro de perfil do que um perfil
  silenciosamente inelegível descoberto no meio de uma run);
- `--auto` ausente.

`capability_prior` é um PRIOR de partida. Ele decide ELEGIBILIDADE — este
modelo é suficiente para esta classe de task? — e nunca preferência entre
elegíveis. Declarar tier alto não torna o modelo melhor: só o torna elegível
para tasks daquele tier, e o resultado observado confirma ou desmente.

Perfis que não declaram prior continuam classificados pela tabela histórica de
padrões de modelo do router, bit a bit. Um provider novo não entra nessa
tabela.

## 9. Autorização do OpenRouter

    Existir credencial NÃO é autorização para gastar.

Perfis OpenRouter são `billing_mode: api`, o que aciona duas proteções já
existentes e provadas:

1. o schema exige `api` no `id` do perfil — o nome é a única defesa que
   sobrevive a quem escolhe o perfil no shell;
2. o preflight exige `AGENTLAB_ALLOW_API_BILLING=eu-autorizo-cobranca-por-api`
   no ambiente do ORQUESTRADOR (não do worker).

E o router recusa perfis `api` implicitamente
(`API_BILLING_REQUIRES_EXPLICIT_SELECTION`), mesmo quando são os mais baratos e
os menos amostrados.

A suíte de testes nunca lança um perfil OpenRouter. Observar o saldo não gasta
nada e não autoriza gastá-lo. O Lab nunca compra crédito e nunca habilita
recarga automática.

## 10. Overage do OpenCode Go

A opção "usar saldo disponível após atingir os limites" fica como o usuário a
deixou. O Lab não a habilita, não a modifica e não depende dela. Quota Go
esgotada torna o perfil indisponível ATÉ O RESET — nunca um vazamento
silencioso para saldo pago.
