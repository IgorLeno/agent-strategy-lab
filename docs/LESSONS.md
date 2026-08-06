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

[2026-08-05] Contexto: S04 — autenticação do perfil de worker Claude.
Mistake: assumir que "processo novo" bastava para contexto limpo e que o
modo controlado sairia de graça. `--bare` é a única flag que desliga
auto-descoberta de CLAUDE.md, hooks, plugins e auto-memory — e ela força
auth por ANTHROPIC_API_KEY, ignorando OAuth e keychain. Sem a chave, o modo
controlado simplesmente não roda.
Rule: modo controlado tem pré-requisito de credencial, e isso se verifica
ANTES de planejar a execução. Perfil sem `--bare` é `real-world`: registrar
`instruction_discovery`/`plugins` como "não controlado" no LaunchRecord e
nunca comparar seus resultados com os de um perfil `controlled`.

[2026-08-05] Contexto: S02 — teste de budget dos packets.
Mistake: verificar o budget rodando o CLI uma vez por tarefa do plano; 33
spawns de `tsx` levaram 87s e tornariam lento o `pnpm test` que TODA tarefa
re-executa no `dev-close`.
Rule: propriedade sobre dados (todo packet cabe em 12 KiB) se testa na
biblioteca, com o pior caso construído à mão. Spawn de processo só quando o
comportamento de processo é o objeto do teste.

[2026-08-05] Contexto: S07 — selagem do HandoffRecord.
Mistake: montar o record final com `{ ...draft }` do worker. Como o
`task_id` do record decide o arquivo de destino, um draft mentiroso
sobrescrevia o handoff de outra tarefa, e `changed_files` do relato virava
contexto da próxima sessão.
Rule: record que o orquestrador assina é montado campo a campo, nunca por
spread da entrada de outro ator. Todo campo que o orquestrador consegue
derivar (id, resultado, commit, arquivos, validações) vem da evidência; da
entrada só sobrevive o que é opinião. E identificador que decide caminho de
arquivo é validado contra o contexto ANTES de qualquer escrita.

[2026-08-05] Contexto: S09 — recuperação de fechamento.
Mistake: tratar `tmp + rename` como se resolvesse integridade do
fechamento. Ele garante que cada arquivo não fica pela metade, não que o
CONJUNTO de arquivos esteja completo: crash entre completion e handoff
deixava evidência parcial que o recovery aceitava como PASS.
Rule: fechamento com mais de um arquivo precisa de um marcador escrito por
último que amarre as peças (hash de cada uma). Recovery exige o marcador;
bundle incompleto volta a pendente, nunca a aceito.

[2026-08-05] Contexto: S10/S11 — concorrência e limite de iterações.
Mistake: (a) confiar em escrita atômica como se fosse exclusão mútua — dois
orquestradores liam READY ao mesmo tempo e lançavam dois workers para a
mesma tarefa; (b) inicializar o motivo de parada como sucesso e só alterá-lo
nos `break`, o que fazia o loop esgotado por limite reportar ALL_DONE com
exit 0.
Rule: escrita atômica não serializa processos — quem muda estado pega lock
de criação exclusiva com identidade de processo (pid + starttime) para
distinguir dono vivo de órfão. E laço com limite trata "esgotou o limite"
como motivo de parada explícito: o estado inicial de um resumo é o
pessimista, nunca o de sucesso.

[2026-08-05] Contexto: S11B — base da tarefa seguinte.
Mistake: capturar `base_sha` direto do HEAD, tratando "o harness fechou a
tarefa anterior" como se garantisse que nada mais mexeu no repositório.
Commit manual entre sessões entrava na base da tarefa seguinte e, como o
dev-close exige exatamente um commit sobre o base_sha, viraria trabalho do
worker na evidência.
Rule: progressão exige base provada (árvore limpa + HEAD igual ao último
accepted_commit ou ao baseline registrado); recuperação NÃO exige, porque
reconciliar fechamento histórico não pode depender do checkout atual.
Divergência de base para o fluxo sem virar veredito sobre a tarefa.

[2026-08-05] Contexto: S14 — auditoria de descendentes.
Mistake: aceitar "o processo pai morreu" como prova de sessão encerrada. O
descendente do modo leak nascia com setsid, saía do process group e
sobrevivia — invisível para qualquer verificação baseada em pgid.
Rule: auditar sobrevivente por DOIS sinais — process group e tag única de
ambiente por lançamento, que o filho herda mesmo depois do setsid. Quando o
mecanismo tem furo conhecido (processo que troca o próprio environment),
documentar o furo em vez de anunciar garantia completa.

[2026-08-05] Contexto: S12 — perfil de agente real.
Mistake: escrever perfil com flags e permissões plausíveis sem conferir a
CLI instalada. `--permission-mode acceptEdits` aprova edições e não autoriza
Bash; em `--print` não existe quem responda a pedido de permissão, então o
perfil funcionaria só na máquina de quem o escreveu.
Rule: perfil de agente pago se valida ANTES de rodar, de graça: binário no
PATH, flags conferidas contra o `--help` da versão instalada, política de
permissões versionada no repositório, modelo fixo e cobertura dos comandos
de validação do plano. Permissão pessoal da máquina não é parte do
experimento.
