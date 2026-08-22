# `agentlab-run.yaml` — contrato de entrada para condução de projeto

Este é o arquivo que um operador escreve para pedir ao Agent Strategy Lab que
conduza trabalho num repositório externo. É a superfície de produto do
Orchestration Control Plane: junto com um PlanFile, ele é tudo que o
`dev-run-plan --authorization` precisa.

```bash
pnpm dev-run-plan \
  --repo /caminho/do/projeto-alvo \
  --plan /caminho/do/plano.yaml \
  --authorization /caminho/do/agentlab-run.yaml
```

Exemplo comentado e completo: [`agentlab-run.example.yaml`](agentlab-run.example.yaml).
Schema autoritativo: `dev/lib/project-authorization.ts` (`schema_version: 1`,
zod strict — campo desconhecido é erro, não é ignorado).

---

## A separação que define o contrato

O arquivo **não define trabalho**. Ele autoriza execução. São duas fontes
deliberadamente distintas:

| | WORK DEFINITION | EXECUTION AUTHORIZATION |
| --- | --- | --- |
| Arquivo | PlanFile (`--plan`) | `agentlab-run.yaml` (`--authorization`) |
| Contém | tarefas, objetivos, acceptance, dependências (`blocked_by`), comandos de validação | boundary autônomo, gates humanos, billing, policy de profiles, classificação das work units |
| Confiança | tratado como definição confiável do que fazer | tratado como limite do que o control plane pode exercer sozinho |
| Quem nunca o altera | um planning worker jamais reescreve o PlanFile autorizado | o control plane jamais amplia a própria policy |

O SHA256 do PlanFile pina o runtime: rodar o mesmo runtime com um plano
diferente falha fechado (`RUNTIME_PLAN_MISMATCH`, exit 9) em vez de executar
silenciosamente outra coisa.

## Seções do contrato

- **`requested_scope`** — o que o usuário pediu, em texto. É registro, nunca
  autorização: pedir X não autoriza implicitamente Y. `constraints` e
  `exclusions` refinam o escopo.
- **`autonomous_execution_boundary`** — as capabilities que o harness exerce
  sem novo gate humano por spawn (workspace descartável, worker de assinatura
  configurado, validação determinística, repair bounded, escalation dentro da
  ladder, cross-provider dentro dos profiles permitidos). Lista mínima de 1;
  o que não está aqui não é autônomo.
- **`human_gated_capabilities`** — categorias que **sempre** produzem
  `HUMAN_REQUIRED`, independentemente do escopo pedido: billing não
  autorizado, mudança de modo de billing, ação destrutiva, deploy/produção,
  side-effect externo, expansão de escopo, credencial nova, decisão de
  arquitetura/produto não resolvida, ação crítica/security-sensitive, entre
  outras (`src/intake/index.ts`). A separação de tipos é o que impede "o
  usuário pediu X, logo Y está autorizado".
- **`billing`** — modos permitidos. `api` é rejeitado pelo schema
  (superRefine): cobrança por API exige decisão humana explícita fora deste
  arquivo, sempre.
- **`profile_policy`** — profiles elegíveis com `capability_rank`; a ordem dos
  ranks **é** a ladder de escalation. Um único profile = modo benchmark:
  qualquer escalation exigida vira `HUMAN_REQUIRED` em vez de ampliar a policy
  em silêncio. `allowed_providers` limita cross-provider.
- **`review`** — reviewer da policy. Omitido, o reviewer é o próprio
  implementer em invocação **nova e read-only** (default econômico, decisão
  D5); risco maior pode exigir profile distinto aqui.
- **`work_units`** — o que o PlanFile não carrega e o harness nunca inventa:
  taxonomia (`task_class`, `difficulty_declared`, `complexity`, `ambiguity`,
  `verification`), `risk` e `resource_envelope` (matéria-prima do worker
  runtime budget). `default` cobre todas as tasks; `overrides` ajusta por
  `task_id`. **Ausência é erro de setup, nunca default permissivo.**

## O que acontece com o arquivo

A cada work unit o control plane compõe a autorização com os fatos observados
(inspection, preflight tri-state de credencial/quota, capability dos profiles)
e decide: rotear e lançar; exigir review; reparar/escalar dentro da ladder; ou
parar com `HUMAN_REQUIRED` expondo decisão e opções — com **zero spawn depois
do gate**. Cada decisão sai no relatório do lifecycle com rationale e
provenance, e os attempts com inference provada viram runs canônicos que
alimentam o routing das execuções seguintes.

## Regras de leitura que não se negociam

- Campo ausente nunca vira permissão. Autorização é explícita ou não existe.
- `requested_scope` não autoriza nada — só registra.
- A policy nunca é ampliada pelo control plane: profile fora da lista, provider
  fora de `allowed_providers` ou modo de billing fora da lista terminam em
  `HUMAN_REQUIRED`.
- O arquivo autoriza **capacidades**, não spawns individuais: dentro do
  boundary, o harness progride sem aprovação repetitiva (human-on-the-loop,
  não human-in-every-step).
