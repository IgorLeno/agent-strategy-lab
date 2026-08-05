# Lições

Correções que custaram tempo ou que mudariam uma decisão se esquecidas.
Regra, não narrativa: cada entrada termina numa restrição aplicável.

---

[2026-08-05] Contexto: S04 — launcher de processo novo para o worker.
Mistake: o plano previa `timeout --signal=TERM --kill-after=10s 30m setsid <cli>`.
Nessa ordem o `setsid` cria uma sessão NOVA, fora do process group que o
`timeout` sinaliza — o worker sobreviveria ao próprio limite.
Rule: a sessão nova vem PRIMEIRO e o `timeout` roda dentro dela
(`spawn('timeout', [...], { detached: true })`). Nunca `timeout ... setsid`.

[2026-08-05] Contexto: S04 — classificação de TIMED_OUT.
Mistake: assumir exit 124 como assinatura do timeout. Sem `--foreground`, o
`timeout` do coreutils sinaliza o próprio process group e, como SIGKILL não
pode ser ignorado, morre junto: chega exit `null` com SIGKILL, não 124.
Rule: classificar timeout por exit 124 **ou** (duração ≥ limite **e** exit
`null`/137). Exit 125/126/127 são falha de invocação do launcher —
`INFRA_ERROR`, nunca veredito sobre o agente.

[2026-08-05] Contexto: S02 — teste de budget dos packets.
Mistake: verificar o budget rodando o CLI uma vez por tarefa do plano; 33
spawns de `tsx` levaram 87s e tornariam lento o `pnpm test` que TODA tarefa
re-executa no `dev-close`.
Rule: propriedade sobre dados (todo packet cabe em 12 KiB) se testa na
biblioteca, com o pior caso construído à mão. Spawn de processo só quando o
comportamento de processo é o objeto do teste.
