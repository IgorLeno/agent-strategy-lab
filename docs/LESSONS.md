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

[2026-08-05] Contexto: S15 — primeiro run com agente real.
Mistake: descrever o contrato dos arquivos de saída (report e handoff draft)
em prosa, com o schema validado de forma estrita do outro lado. O agente
escreveu um JSON plausível e errado — campos inventados, `candidate_commit`
abreviado — e o fechamento ficou pendente com o trabalho pronto e correto.
Rule: contrato validado estritamente é comunicado por esqueleto, não por
descrição: o prompt carrega o JSON exato, com nomes, tipos, enums e limites.
E toda rejeição por schema nomeia campo e problema — a sessão que escreveu o
arquivo já morreu e não pode ser perguntada.

[2026-08-05] Contexto: S15 — política de permissões em modo não interativo.
Mistake: montar allow list pensando em comandos isolados. `node --test test/
2>&1; echo "EXIT=$?"` foi negado porque `echo` não estava na lista: comando
composto exige que TODA parte esteja liberada.
Rule: allow list cobre os utilitários de leitura óbvios, e o prompt manda um
comando por chamada. Nunca alargar uma regra para consertar isso quando o
alargamento libera o perigoso junto (`Bash(git -C:*)` liberaria `push`).

[2026-08-05] Contexto: S14/S15 — matar sobrevivente por process group.
Mistake: usar pgid como sinal de POSSE e mandar SIGKILL. O kernel recicla
PIDs; um processo alheio pode cair num grupo cujo id coincide com o do
worker já encerrado, e o harness derrubaria processo de terceiro. Apareceu
como falha intermitente de um teste vizinho na suíte paralela.
Rule: matar só o que a tag única do lançamento confirma. Sinal fraco
(coincidência de identificador reciclado) serve para DETECTAR e relatar,
nunca para agir destrutivamente.

[2026-08-06] Contexto: S16 — política de cobrança dos perfis de worker.
Mistake: os perfis reais mantinham `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` na
`env_allowlist` "por precaução". Isso não é neutro: bastava a variável existir
no shell para o run inteiro trocar de fonte de cobrança — de assinatura para
API — sem nenhum sinal no LaunchRecord. O doctor ainda tratava ausência de
chave como se fosse prova de assinatura.
Rule: fonte de credencial se PROVA com comando local e gratuito da CLI
(`claude auth status --json`, `codex login status`), a cada lançamento e não só
no doctor. Ausência de chave não prova nada; sem resposta reconhecível o run é
bloqueado (`FAIL: credential source could not be verified`). Variável que a CLI
reconhece para autenticar nunca entra em allowlist de perfil de assinatura, e
só o NOME dela aparece em mensagem de erro.

[2026-08-06] Contexto: S16 — registro de custo dos runs.
Mistake: chamar de "custo" o `total_cost_usd` que a CLI emite. Ele é preço de
API calculado sobre tokens; com assinatura o run consome a franquia incluída e
não gera cobrança adicional nenhuma. Um campo único `cost_usd` misturava
estimativa com valor cobrado, e os números do S15 (US$ 1,6238) já estavam sendo
lidos como se tivessem sido pagos.
Rule: separar `provider_estimated_api_equivalent_usd` (estimativa da CLI) de
`actual_incremental_charge_usd` (só com fonte de faturamento autoritativa; na
falta dela, `null`, nunca `0`). Relatório de terminal escreve "custo
equivalente estimado", não "custo pago".

[2026-08-06] Contexto: S16 — `--bare` e assinatura.
Mistake: manter no plano a ideia de um perfil `controlled` para o Claude. A
própria CLI documenta que `--bare` força auth por `ANTHROPIC_API_KEY` e nunca lê
OAuth nem keychain — ou seja, modo controlado e assinatura são mutuamente
exclusivos, e não é uma questão de configuração.
Rule: enquanto a política for assinatura, `--bare` é flag proibida e todo perfil
real é `real-world`. `billing_mode` e `environment_mode` são campos separados:
um perfil `controlled` não seria "de graça", e um perfil de assinatura não vira
controlado por vontade.

[2026-08-06] Contexto: testes do harness executados dentro de um worker real.
Mistake: o helper de subprocessos espalhava `process.env`, permitindo que um
`dev-doctor --help` entregasse ao fake worker o packet, o repositório e os
caminhos reais do worker pai; o fixture interpretou a introspecção como tarefa e
criou commit.
Rule: subprocesso de teste parte de allowlist operacional mínima e recebe
`AGENTLAB_*` ou credencial somente por override explícito do cenário. Fixtures
que alteram Git tratam `--help`/`-h` antes de ler ambiente ou produzir efeitos.

[2026-08-06] Contexto: correção de harness necessária entre duas tarefas do plano.
Mistake: a guarda derivava a próxima base diretamente do `accepted_commit`,
então um commit legítimo de manutenção só podia ser ignorado, atribuído
historicamente à tarefa anterior ou bloquear a progressão.
Rule: a base operacional da próxima tarefa é um campo explícito e só avança por
fechamento PASS ou por MaintenanceRecord atômico que prova cadeia linear,
escopo permitido e validações; manutenção nunca reescreve artifacts de tarefa.

[2026-08-06] Contexto: doctor de configuração explícita por argv.
Mistake: contar apenas overrides válidos fazia um valor correto esconder outra
ocorrência duplicada e malformada da mesma opção.
Rule: validação fail-closed contabiliza também ocorrências malformadas e exige
exatamente uma ocorrência válida; entrada inválida nunca é descartada antes da
decisão de unicidade.

[2026-08-06] Contexto: abandono de tentativa bloqueada enquanto uma correção do
harness precisava virar commit de manutenção.
Mistake: exigir sempre `HEAD == base_sha` tornava o retry impossível depois que
a própria correção necessária fosse commitada.
Rule: retry com manutenção pendente é modo explícito e aceita somente um commit
filho direto da base ainda autorizada, com allowlist de arquivos; não avança a
base, e a guarda continua bloqueando workers até a adoção separada.

[2026-08-06] Contexto: HOME sanitizado para impedir descoberta de contexto
pessoal num worker que precisa criar commit.
Mistake: remover o HOME pessoal também remove a identidade de `~/.gitconfig`,
fazendo o worker falhar tarde no commit.
Rule: HOME sanitizado nunca copia gitconfig; perfis de build fornecem identidade
determinística por `GIT_AUTHOR_*`/`GIT_COMMITTER_*`, e o doctor prova autor e
committer no ambiente exato do worker antes do run.

[2026-08-07] Contexto: callbacks e metadados opcionais com
`exactOptionalPropertyTypes` habilitado.
Mistake: montar object literals com propriedades opcionais explicitamente
iguais a `undefined`, o que quebra o typecheck mesmo quando a API aceita a
ausência do campo.
Rule: quando o valor opcional não existe, omitir a propriedade com spread
condicional; `undefined` explícito só entra no tipo quando é parte deliberada
do contrato.

[2026-08-07] Contexto: finalização normal com commit ownership do orquestrador.
Mistake: tratar campos de policy como opções independentes e validar whitespace
somente no diff não staged deixaria combinações sem semântica e arquivos novos
fora da prova oficial.
Rule: policies multifield aceitam somente tuples implementados; a finalização
amarra o patch por fingerprint antes/depois das validações, stageia paths exatos
e exige `git diff --cached --check` sobre o conteúdo que será commitado.

[2026-08-08] Contexto: M23 — teste de escalada SIGTERM → graça → SIGKILL, sob
`pnpm test` completo.
Mistake: um `timeoutMs` curto (300ms) numa tentativa anterior mandava o SIGTERM
antes de o processo filho terminar o próprio startup do Node (fork+exec até a
primeira linha JS, que é quando `process.on("SIGTERM", ...)` é registrado).
Sob a suíte inteira rodando em paralelo, essa janela de startup competia por
CPU e passava do timeout: o filho morria pela ação padrão do SIGTERM antes de
instalar o handler que deveria ignorá-lo, e o teste via exatamente o sintoma
que existia para pegar (SIGTERM em vez do SIGKILL da escalada) por um motivo
que não tinha nada a ver com a escalada em si — startup lento, não escalada
quebrada.
Rule: teste de sinal contra processo filho real usa `timeoutMs` com folga
generosa (≥1s) sobre o pior caso de startup do interpretador sob carga, nunca
o menor valor que passa isolado. Asserção de tempo mínimo (`elapsed >= timeout
+ graça`) é segura contra essa folga — só falha se a escalada disparar cedo
demais, o que timers reais não fazem.

[2026-08-08] Contexto: M23 — attempts 2 e 3 rejeitados pela validation oficial e
arquivados por `dev-retry-failed`; attempt 4 passou e criou candidate commit.
Mistake: `dev-retry-failed` preservava patch, manifesto e
`ValidationFailedAttemptRecord` do attempt reprovado, mas deixava o
CompletionRecord FAIL no slot corrente
(`.dev/completions/<task>.completion.json`). Na selagem do attempt seguinte,
`sealOrchestratedFinalization` comparou esse FAIL histórico com o
CompletionRecord PASS derivado do finalization record e parou em
"CompletionRecord existente diverge do finalization record" — com o commit já
criado e o fechamento pela metade.
Rule: quando um attempt é arquivado, todo artifact que representa o fechamento
DAQUELE attempt sai do slot corrente junto com o resto da evidência: os bytes do
CompletionRecord FAIL são preservados append-only em
`.dev/failed-attempts/<task>/attempt-<n>/completion.fail.json`, conferidos
contra `original_completion_sha256` do record (fonte única do hash), e só então
o slot corrente é liberado. Slot "mais recente" nunca pode reter estado de um
attempt já encerrado, e a retomada depois de crash lê a evidência arquivada em
vez de exigir o arquivo que o próprio fluxo removeu.

[2026-08-09] Contexto: M33 — a CLI do Claude perdeu a conexão com a API
(`ENOTFOUND`), fez dez `api_retry` e terminou com um `result` declarando
`is_error: true` e `terminal_reason: "api_error"`, zero turno, zero token,
exit 1.
Mistake: o launcher só classificava INFRA_ERROR por exit code do `timeout`
(125/126/127), término por sinal, sobrevivente ou violação do contrato do
transporte. O stream estava íntegro e o exit não era nenhum daqueles, então o
run passou por FINISHED, a tarefa foi para `RUNNING/FINALIZING` e o fechamento
parou em "AgentCompletionReport ausente" — pedindo para sempre um arquivo que
uma sessão sem inferência nenhuma jamais escreveria. O diagnóstico apontava
para o worker; a causa era a rede.
Rule: quando o provider declara COMO a sessão terminou, essa declaração é
evidência de primeira classe e precede FINISHED. A regra enumera o sucesso
(`is_error` falso E `terminal_reason` ausente ou `completed`), nunca a lista de
falhas — motivo terminal novo cai do lado seguro sozinho, e texto de erro
específico (`ENOTFOUND`) é diagnóstico de incidente, não contrato. Falha do
provider entra DEPOIS de timeout, sobrevivente, exit de launcher e contrato de
transporte, porque qualquer um deles pode produzi-la e trocar causa por sintoma
esconde o diagnóstico real. Consumo não entra na classe: API pode cair depois
de gastar franquia, e o consumo observado vai registrado como veio.

[2026-08-09] Contexto: M33 — recuperar o attempt morto para poder repetir.
Mistake: `.dev/logs/<task>.launch.json` e `.dev/logs/<task>.*.log` são do
lançamento MAIS RECENTE. Liberar a tarefa para o attempt 2 sem copiar nada
apagaria a única evidência do incidente na primeira retentativa — e o attempt 1
viraria um buraco na história.
Rule: attempt encerrado sem solução aceita arquiva a evidência ANTES de a
tarefa voltar a READY, byte a byte e append-only, com hash e tamanho no record.
Ordem transacional: evidência, record, state — nessa ordem, para que qualquer
crash no meio convirja na repetição. `attempts` nunca diminui: attempt 1
permanece na história como infraestrutura, não como tentativa reprovada, e
lançar de novo continua sendo decisão explícita do usuário.

[2026-08-09] Contexto: M39B — a validation oficial reprovou o attempt 1
(`test/e2e/failure-paths.test.ts` timing-sensitive), o finalization gravou
`status = FAIL` + CompletionRecord oficial + patch rejeitado no disco, e
`dev-retry-failed` recusou com "RevalidationSourceBinding ausente".
Mistake: o `RevalidationSourceBinding` era exigido por `dev-retry-failed` e por
`dev-revalidate`, mas o único produtor era o `dev-revalidation-bind` manual — o
caminho normal do FAIL nunca o materializava. A tarefa terminava com veredito
oficial publicado, evidência completa e NENHUMA intervenção suportada capaz de
tocá-la: nem revalidar, nem reparar. Não era falta de evidência, era falta de
selo sobre a evidência que já existia.
Rule: um desfecho que deixa trabalho rejeitado em disco tem que nascer com a
fonte selada, no mesmo fluxo que publica o veredito e ANTES dele — se um estado
final admite intervenção humana, o artifact que essa intervenção exige é parte
do próprio desfecho, não um passo manual posterior. Corolários que custaram o
incidente: (1) quando dois comandos exigem o mesmo artifact, a DERIVAÇÃO dele é
um helper único e fail-closed, nunca duas verdades sobre os mesmos bytes;
(2) o nome histórico de um record não é argumento para duplicá-lo — verifique se
os campos falam do domínio que o nome sugere antes de criar um paralelo;
(3) recuperar um registro faltante é DERIVAR dos bytes que sobraram, com hashes
reais e proveniência que diga que a observação é de agora, jamais fingir que o
artifact existia no instante original; (4) guarda de HEAD em código de reparo
tem que declarar CONTRA QUAL commit observa — exigir a base histórica quebra o
reparo assim que uma manutenção adotada move o authorized head, que foi
exatamente o segundo modo de falha deste mesmo incidente.

[2026-08-11] Contexto: teste da view compacta de divergência entre HEAD e base
autorizada no `dev-recover`.
Mistake: mover o HEAD sobre um state de fixture com `authorized_head_sha: null`;
o recovery legado deriva o autorizado do HEAD atual e eliminou a divergência
que o teste pretendia criar.
Rule: fixture de `BASE_DIVERGED` fixa explicitamente `baseline_sha` e
`authorized_head_sha` antes de avançar o HEAD; `null` testa migração legada, não
uma base autorizada pinada.

[2026-08-11] Contexto: separar a saída compacta e verbose de uma CLI do harness.
Mistake: atualizar os testes focados, mas deixar um teste de integração lendo na
saída padrão um campo detalhado movido para `--verbose`.
Rule: ao mover campos entre views de uma CLI, procurar todos os consumidores das
chaves; diagnóstico opta por `--verbose`, enquanto uso operacional valida apenas
os campos compactos.

[2026-08-11] Contexto: resumir na view do `dev-next` se a próxima task pode ser
lançada.
Mistake: derivar readiness apenas de `HEAD == authorized_head_sha`, omitindo a
árvore limpa e a semântica de `authorized_head_sha: null` da guarda real.
Rule: views de readiness consomem o resultado estruturado da mesma primitive que
protege a progressão; nunca reimplementam parcialmente uma guarda operacional.

[2026-08-12] Contexto: recuperar a M50, cujo attempt 1 foi reprovado pela
validation oficial e arquivado, e cujo attempt 2 morreu com 401 do provider sem
escrever nada.
Mistake: o worker escreve em caminhos ESTÁVEIS por tarefa
(`.dev-inbox/<task>/report.json` e `handoff-draft.json`), e o archival de um
attempt preservava record, CompletionRecord e change bundle, mas deixava esse
par no slot compartilhado. O `dev-recover-infra` leu output do attempt 1 como se
fosse do attempt 2 e recusou a recuperação — evidência do attempt N atribuível
ao attempt N+1, que é o mesmo defeito que ameaçaria classificação, retry,
provenance e validade experimental.
Rule: todo artifact que o worker escreve num caminho COMPARTILHADO entre
attempts tem que ganhar cópia durável dentro do attempt dono antes de o slot ser
liberado, e a transação precisa conseguir retomar A PARTIR dessa cópia — nunca
depender de um arquivo que ela mesma apaga. Posse de artifact stale se decide
por hash contra o record do attempt, com o par COMPLETO batendo no MESMO record;
timestamp, `changed_files` e semelhança de conteúdo não são prova, e meia prova
é recusa. Quem só cria caminho novo sem publicar a cópia antes da liberação
apenas move o buraco de lugar.

[2026-08-12] Contexto: recuperar a M50 depois de adotar a manutenção que
consertou o próprio harness.
Mistake: a guarda de HEAD do encerramento conhecia dois mundos — HEAD igual ao
`base_sha` e UM commit de manutenção pendente sobre ele. Adotar a manutenção
avançava `authorized_head_sha` de `A` para `C` e tornava o attempt de `A`
permanentemente irrecuperável: consertar o harness passava a ser incompatível
com usar o conserto.
Rule: quando um caminho de recuperação encontra o repositório à frente da base
histórica do attempt, a diferença só é aceitável se estiver INTEGRALMENTE
explicada por `MaintenanceRecord`s adotados e verificados
(`maintenanceChainBetween`) — ancestralidade, `merge-base` ou "descendente do
base_sha" não são prova, porque admitem trabalho externo não auditado. Cadeia
ausente, incompleta, ambígua ou adulterada recusa, e `plan_extension` não é
atravessado por política. Ampliar isso dentro da guarda global seria mudar
outros encerramentos de graça: o caminho histórico ganha primitive própria, e a
evidência registra os dois fatos separados — base histórica em
`source_base_sha`, HEAD real em `head_sha`.

[2026-08-12] Contexto: M50 — ValidationFailedAttempt no attempt 1, InfraFailedAttempt
no attempt 2, próximo launch seria attempt 3.
Mistake: `readPreviousAttemptDiagnostics` lia só o `attempts` corrente. INFRA_ERROR
no topo apagava os diagnostics do FAIL oficial e o próximo launch virava FIRST_PASS.
Rule: INFRA_ERROR é capability-neutral. A busca de PreviousAttemptDiagnostics
atravessa somente gaps comprovados por InfraFailedAttemptRecord; qualquer outro
gap interrompe a cadeia. Validation e Infra no mesmo attempt é fail closed.
REPAIR significa diagnostics conectados por evidência, não `attempt > 1`.

[2026-08-14] Contexto: revisão humana de M52 — `ProviderAdapter.parseLine`
(M51A) devolve `{ event, observation? }`; `executeWithAdapter` (M51B) monta o
`ExecutionRecord` a partir dos eventos.
Mistake: `executeWithAdapter` preservava só `.event` e descartava
`.observation` (usage/cost/terminal). O teste de equivalência de M51B
verificava apenas `record`/`events` contra o comportamento anterior do fake —
equivalência de output, não consumo do contrato inteiro — e a suíte completa
ficou verde com metade de `ParsedProviderLine` sendo jogada fora. A lacuna só
foi detectada pela revisão humana de M52, não por nenhum teste automatizado;
corrigida em M52A.
Rule: equivalência de output e `pnpm test` verde não provam que todas as
partes de um contrato abstrato novo estão sendo realmente consumidas. Todo
contrato abstrato que introduz uma forma nova (aqui, `ParsedProviderLine`)
exige teste de CONSUMO/semantic coverage — que cada campo do tipo devolvido
chega a algum lugar observável no resultado — além dos testes de shape (o
tipo tem os campos certos) e de equivalência da saída antiga (o comportamento
histórico não regrediu). Shape e equivalência provam que nada quebrou; só o
teste de consumo prova que o novo campo não está sendo silenciosamente
descartado.

[2026-08-15] Context: fechamento orchestrator-owned com report e handoff escritos
corretamente nos slots de protocol I/O.
Mistake: o prompt permitia interpretar `changed_files` como todos os arquivos
escritos, incluindo os próprios artefatos do `.dev-inbox`; editar a evidência ou
registrar FAIL transformaria um erro de protocolo em veredito de capacidade.
Rule: `changed_files` contém exclusivamente paths candidatos ao commit da task;
protocol I/O nunca entra no patch. Worker `SUCCESS` com metadata protocol-invalid
é abandonado com evidência original byte-exact e sem capability verdict — a
evidência nunca é alterada para fazer o fechamento passar.

[2026-08-15] Context: adoção oficial dentro do protocolo de autonomia rotineira.
Mistake: a primeira versão deixava uma recusa de `adoptMaintenance` escapar como
exceção genérica, embora o contrato de UX proíba devolver stack trace para um
incidente rotineiro já triado.
Rule: recusa de uma primitive oficial encerra o incidente em record append-only
e saída estruturada `HUMAN_REQUIRED`; automação nunca inventa um caminho
alternativo de adoção nem transforma a recusa em sucesso.

[2026-08-15] Context: review independente da primeira instalação de routine autonomy.
Mistake: declarar reviewer como read-only no prompt, conferir a árvore apenas
depois e preencher contadores de task activity com zero constante tratava
intenção como evidência de isolamento.
Rule: fronteira de agente é aplicada antes do spawn por sandbox efetivo; estado,
attempts e launch evidence são medidos antes/depois; qualquer divergência ou
falha de runtime termina em record append-only e `HUMAN_REQUIRED` estruturado.

[2026-08-16] Contexto: revisão M68 (`docs/reviews/M2-REVIEW.md`) — checklist
do pilot benchmark, item "quota stop ≥80%".
Mistake: `ExperimentBillingPolicy.quota_stop_threshold_pct` (M64) é validado,
congelado no `ExperimentSpec` do piloto e coberto por teste — o que fazia
parecer que o stop de quota em 80% já era uma regra em vigor. Mas
`decideExecutionAuthorization` (M54) só consome `quota.availability` como
`Evidence` já decidida pelo chamador, e trata `QUOTA_UNKNOWN` como ALLOW por
design (mesma lógica de "ausência não é prova negativa" do resto do kernel).
Nenhum código do produto lê `QuotaUsage.windows` da probe (M59) e converte
"consumido ≥ threshold" em `INSUFFICIENT`. Sem essa ponte, o valor de 80%
seria só um número congelado no schema, nunca aplicado.
Rule: um threshold declarado num contrato imutável (schema `.strict()`,
freeze, teste de shape) prova que o VALOR está congelado, nunca que ele é
ENFORÇADO em runtime. Toda vez que um contrato de política introduz um
threshold numérico, a revisão precisa localizar explicitamente o consumidor
que lê a medição observada e decide com base nele — se esse consumidor não
existe, o threshold é dado inerte, e isso precisa virar risco registrado
antes de qualquer aprovação humana que dependa dele.

[2026-08-19] Context: M71 attempt 2 — `worker_validation_policy=targeted`.
Mistake: o prompt já pedia para não rodar `pnpm test` completo, mas o worker
ainda lançou a suíte oficial em background e encerrou sem
`AgentCompletionReport` nem `HandoffDraft`. O recovery existente exigia os
dois artifacts e recusava, deixando o patch na working tree e o harness em
`HUMAN_REQUIRED`.
Rule: processo morto + LaunchRecord finished + patch real + completion
artifacts ausentes é PROTOCOL/OUTPUT INCOMPLETE, não capability failure.
Preserve-then-reset; nunca inventar report/handoff. Mitigação de prompt para
`targeted` é bootstrap — enforcement estrutural (bloquear `pnpm test` /
`pnpm build` / background jobs no sandbox targeted) ainda é necessário; não
resolver isso mutando profile ids históricos nem o settings compartilhado
com a policy `full`. Reset path-scoped que remove arquivos ADDED também
precisa podar diretórios pais que ficaram vazios: git fica limpo, mas
`readdir` ainda vê `src/intake` e o scaffold test falha na adoção.

[2026-08-19] Context: retry operacional capability-neutral ocorrido durante
um REPAIR bounded.
Mistake: derivar a lineage apenas do último lifecycle record fazia um
AttemptAbandonmentRecord interromper a busca e o retry seguinte virar
FIRST_PASS, embora o repair source continuasse autorizado.
Rule: retry operacional dentro de repair carrega o `repairSourceAttempt`
autorizado e reancora o packet diretamente nessa evidência; ausência ou
divergência do source falha fechado, e nunca fabrica nova capability escalation.

[2026-08-19] Contexto: atualização cirúrgica de expectativas repetidas de exit code.
Mistake: aplicar uma substituição sem contexto suficiente alcançou um teste
vizinho de `HUMAN_REQUIRED` em vez do segundo caso de `LIMIT_REACHED`.
Rule: patch em asserções repetidas inclui o nome do teste e o `stopped_by`
esperado no contexto; estado bloqueante nunca muda por substituição posicional.
