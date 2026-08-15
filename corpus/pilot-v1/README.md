# Corpus piloto v1

Este é o corpus experimental inicial do agent-strategy-lab. Ele contém
**exatamente três tasks** pequenas e deliberadamente não resolvidas. Não é a
suite definitiva de 8–12 tasks; essa ampliação permanece deferida para o
Marco 3 ou para um follow-up pós-piloto.

## Reprodução

Cada diretório contém somente o `TaskSpec` público e um workspace inicial com
testes públicos. O runner deve fixar o commit deste corpus como `base_sha` no
`ExecutionRequest` antes de iniciar um run. Não há `EvaluationPlan`, grader
oculto ou rubrica privada nesta árvore.

Os workspaces não têm dependências externas e usam apenas Node.js 22.13.0 ou
mais recente. A partir da raiz do repositório, os graders públicos são:

| Task | Classe | Dificuldade declarada | Grader público |
| --- | --- | --- | --- |
| `fix-stable-tag-normalization` | bugfix local | easy | `node --test corpus/pilot-v1/fix-stable-tag-normalization/workspace/public-tests.mjs` |
| `add-bounded-retry` | feature assíncrona | medium | `node --test corpus/pilot-v1/add-bounded-retry/workspace/public-tests.mjs` |
| `add-jsonl-summary-cli` | feature de CLI | medium | `node --test corpus/pilot-v1/add-jsonl-summary-cli/workspace/public-tests.mjs` |

## Critério de escolha

As três tasks foram escolhidas antes de qualquer resultado experimental. Elas
compartilham baixo custo, baixa ambiguidade, entradas locais e validação sem
rede, relógio ou aleatoriedade, mas exercitam formas diferentes de trabalho:
correção de transformação síncrona, controle de fluxo assíncrono e integração
de processo/arquivo em CLI. Essa variedade evita que o primeiro piloto meça
somente uma microclasse sem inflar o corpus inicial.
