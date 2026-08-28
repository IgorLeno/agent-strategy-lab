# Lições

Correções que custaram tempo ou que mudariam uma decisão se esquecidas.
Regra, não narrativa: cada entrada termina numa restrição aplicável.

---

[2026-08-28] Context: regressão de uma porta assíncrona que captura o argv de
lançamento para asserções posteriores.
Mistake: esperar que o TypeScript estreitasse uma variável inicialmente `null`
depois de uma atribuição feita dentro de callback assíncrono.
Rule: em testes que capturam argumentos de callbacks, grave-os em um objeto
mutável tipado e verifique suas propriedades; não dependa de narrowing entre
fronteiras assíncronas.

[2026-08-28] Context: regressão do selamento na finalização orquestrada.
Mistake: fixar no teste a quantidade de validations declarada no plano e
esquecer que o diff-check oficial também integra a evidência final.
Rule: em testes do handoff selado, compare validations com o record autoritativo
da finalização; não recalcule nem fixe uma contagem parcial do pipeline.

[2026-08-24] Context: helper de subprocesso carregado por Vitest/Vite precisava
resolver o entrypoint público de uma dependência fora do worktree descartável.
Mistake: usar `import.meta.resolve`, disponível no Node 22 direto, sem considerar
que o transform SSR do Vite substitui `import.meta` e não implementa `resolve`.
Rule: em módulos de teste transformados pelo Vite, resolva entrypoints de pacote
com `createRequire(import.meta.url).resolve`; valide o helper através do Vitest,
não apenas com uma invocação direta de Node.

[2026-08-24] Context: review independente de candidate já aprovado nos gates
oficiais do self-run real.
Mistake: tratar um único `ACCEPT` sem `coverage` como bloqueio terminal, embora
o prompt já exigisse o campo e nenhum record append-only tivesse sido gravado.
Rule: quando uma saída probabilística omite evidência estrutural obrigatória,
permita no máximo uma nova invocação com os erros exatos do schema; nunca
complete a evidência no adapter, nunca repita `REJECT` e, após a segunda
omissão, preserve `null` e falhe fechado.

[2026-08-23] Context: interface canônica `pnpm lab run`.
Mistake: tratar flags CLI (`--repo`, `--self`, `--publish`) e frases do
prompt como se carregassem a mesma autoridade.
Rule: a Run Directive colada é o artefato de produto; INTENT ≠ AUTHORIZATION;
só o header estruturado (sobre o preset) concede capability; texto livre
nunca autoriza; flags avançadas que contradizem o header falham fechadas.

[2026-08-23] Context: porta de produto `pnpm lab` e self-maintenance.
Mistake: exigir que o humano escreva ProjectIntakeRequest/agentlab-run.yaml
— ou editar o control repo no mesmo working tree que carrega as primitives —
reintroduz um orquestrador humano entre a instrução e o Lab.
Rule: o texto raw é a autoridade humana e é persistido antes de qualquer
provider; autorização vem de preset versionado, nunca do prompt; self-run
usa worktree isolado e só integra por fast-forward se main não divergiu.

[2026-08-23] Context: planner Claude com --output-format json no primeiro projeto real.
Mistake: extractJsonObject(stdout) tratou o envelope da CLI (is_error, result,
session_id) como o draft do modelo; SCHEMA_NORMALIZATION recusou o transporte.
Rule: stdout de Claude --output-format json é transporte; só o campo textual
`result` entra em extractJsonObject. Falha terminal do envelope (is_error /
terminal_reason) não vira payload do modelo.

[2026-08-23] Context: planner/reviewer Claude sobre repositório alvo externo.
Mistake: resolveProfileArgv rodou no profile base e o overlay read-only
reintroduziu `--settings` relativo depois; o subprocesso com cwd no alvo
procurou o arquivo lá e falhou antes do PlanFile.
Rule: recurso relativo introduzido pelo role overlay resolve contra
profileCatalogRoot DEPOIS do overlay e ANTES do spawn. Overlay depois de
catalog resolution reintroduz path relativo.

[2026-08-22] Context: fixtures YAML para binding de identidade do plano gerado.
Mistake: hashes formados só por dígitos foram emitidos sem aspas e o parser YAML
os converteu em números, fazendo o teste parar no schema em vez de alcançar a
regra de binding.
Rule: strings de identidade em fixtures YAML (SHA/hash/id) são sempre emitidas
entre aspas, mesmo quando o valor atual parece inequivocamente textual.

[2026-08-22] Context: fixture de integração reutilizando o helper runGit.
Mistake: o resultado estruturado CliResult foi passado como se fosse stdout,
adiando uma falha simples até o gate de schema do intake.
Rule: helpers de subprocesso são consumidos pelo tipo de retorno completo;
extraia stdout/stderr/exitCode explicitamente antes de montar dados de contrato.

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

[2026-08-19] Contexto: identidade de profiles Codex antes do router (M78).
Mistake: `codex-build-worker-subscription-high-v2` fixava `gpt-5.6-sol` +
`high` no argv, mas o `profile_id` omitia a dimensão MODEL — inconsistente
com `luna-medium` / `terra-high` / `sol-medium`.
Rule: novos IDs Codex são `codex-build-worker-subscription-<model>-<effort>-vN`.
IDs históricos não se renomeiam. Modelo e effort saem do argv via doctor,
nunca de substring (`sol`/`terra`/`luna`/`medium`/`high`) no `profile_id`.

[2026-08-19] Context: M86 — revisão do control plane antes do primeiro projeto real.
Mistake: tratar intenção do usuário, duração estimada, runtime do worker e
timeout de validação como uma única autorização ou um único relógio tornaria
gates redundantes dentro do escopo e permissivos fora dele, além de induzir
decomposição artificial ou truncamento silencioso.
Rule: autorização é um boundary explícito de capabilities, nunca consequência
de `requested_scope` nem gate por spawn; AVC decide a unidade de mudança, e
estimated task duration, worker runtime budget e validation command timeout são
validados exclusivamente contra seus próprios bounds, com violação nomeada.

[2026-08-19] Contexto: teste de repair via entrypoint `dev-run-plan`.
Mistake: gravar o perfil `orchestrator-owned` no sandbox sem commitá-lo deixou
a working tree suja; o primeiro launch parou em guarda de base (exit 9) e o
repair bounded existente nem chegou a rodar — parecia falha do wrapper.
Rule: fixture de perfil no sandbox git entra no commit de baseline ANTES de
init/run-plan. Working tree suja não é caminho para exercitar repair, DAG ou
resume; a guarda de progressão continua valendo para a entrypoint ergonômica.

[2026-08-19] Contexto: `dev-run-plan` sobre repositório externo.
Mistake: resolver `--profile` com `loadProfile(paths.repoRoot, id)` obrigava o
alvo a copiar `dev/profiles` e fazia `--settings` relativos caírem no cwd do
worker (o target), não no catálogo do harness.
Rule: catálogo de profiles é a instalação do Agent Strategy Lab (módulo
versionado, nunca `process.cwd()`). O repositório alvo é só workspace. Recursos
relativos do profile resolvem contra o catalog root em runtime; `loadProfile`
histórico continua lendo `<repoRoot>/dev/profiles`.

[2026-08-20] Contexto: gate de review independente antes da promoção a PASS.
Mistake: a review era consultada por UM promotor, e não pela primitive de
selagem — um `dev-recover` ou uma retomada de finalização podiam promover um
candidate cujo reviewer havia REPROVADO.
Rule: um gate capaz de reprovar uma mudança precisa preceder a promoção
autoritativa; a invariável pertence à primitive de selagem compartilhada por
todos os promotores (`sealOrchestratedFinalization`), nunca apenas ao chamador.

[2026-08-20] Contexto: fatos de credencial e quota no control plane de projeto
externo.
Mistake: `authorizeProjectLaunch` recebia `quota_available: true` e
`credential_proved: true` hardcoded. O launcher continuava rodando o preflight
canônico, então nada era cobrado indevidamente — mas o relatório afirmava
"quota disponível" e "credencial provada" sem nenhuma observação por trás.
Rule: fato operacional é tri-state com proveniência (PROVEN TRUE / PROVEN
FALSE / UNKNOWN), nunca boolean. UNKNOWN não vira TRUE para destravar
progresso, e cada dimensão tem policy própria: credencial é probável local e
gratuitamente, então desconhecida BLOQUEIA; quota só é medida chamando o
provider, então desconhecida SEGUE — sem jamais ser reportada como disponível.

[2026-08-20] Contexto: `--dry-run` do `dev-run-plan --authorization`.
Mistake: o dry-run retornava antes de construir o control plane, então
prometia READY sem ter avaliado inspeção, review, readiness, routing, budget
nem o gate de launch — e ignorava um REJECT durável pendente em disco.
Rule: pré-visualização e execução compartilham a MESMA primitive de avaliação
(`assessWorkUnit`); o preview é a decisão real sem efeitos, nunca uma segunda
implementação. Um segundo assessment só para dry-run diverge do runtime
exatamente no dia em que a diferença importa.

[2026-08-20] Contexto: materialização de attempts de projeto externo como
história canônica para M81/M82.
Mistake: usar `trial` ao mesmo tempo como lifecycle completo da work unit e
como série comparável obrigaria escolher entre quebrar métricas de
repair/escalation ou misturar profiles diferentes na mesma identidade.
Rule: execution episode e comparable profile series são dimensões ortogonais.
O episódio agrupa INITIAL/REPAIR/ESCALATION para derivar lifecycle; cada trial
permanece homogêneo por fingerprint completo de profile, e um vínculo
versionado recompõe o episódio sem alterar a semântica histórica de trial.

[2026-08-20] Contexto: fechamento de M81 V2 -> M82 com história canônica de
projeto externo; todos os testes passavam, mas somente com história sintética
injetada direto no router.
Mistake: o leitor canônico fixava `interventions: null` para todo run lido do
disco e nenhum writer publicava esse fato, então `human_intervention_rate`
nascia UNAVAILABLE e M82 jamais poderia chegar a `source=HISTORY` com dados
reais — wiring verde e inerte.
Rule: quando uma camada consome um conjunto obrigatório de métricas, prove
end-to-end com dados produzidos pelo writer real que a decisão MUDA; teste com
fixture sintética do consumidor não prova que o produtor consegue satisfazê-lo.
E cada fato obrigatório precisa de um writer explícito: ausência de artifact é
UNKNOWN, lista vazia é prova positiva de zero, artifact inválido falha fechado.

[2026-08-21] Contexto: M-A/M-B (M87-M94) implementadas e aprovadas enquanto o
runtime do harness seguia congelado em M86, com o plano já estendido por um
commit misto (plano + documentação).
Mistake: as três primitives existentes recusavam a faixa — `dev-adopt-plan` por
exigir commit só de `dev/plan.yaml`, `dev-adopt-maintenance-range` por recusar
`dev/plan.yaml` e código de produto, `dev-recover` por só derivar PASS de close
bundle — e a saída "óbvia" era editar `.dev/state.json` ou fabricar
completion/handoff/finalization para as oito tarefas.
Rule: extensão de plano e execução de tarefa divergem durante bootstrap e
migração; isso NUNCA se resolve escrevendo runtime state na mão nem forjando
records de execução. Planned work feito fora do lifecycle exige uma primitive
própria — mapping explícito tarefa→commit, toda a faixa com papel declarado,
extensão provada append-only, revalidação independente dos comandos que a
tarefa declara, evidence imutável antes do state. E adoção não é execução:
`attempts` fica 0, handoff ausente continua `null`, e nada disso entra na
história de performance, que se alimenta de attempt real e não de
`TaskState.PASS`.

[2026-08-23] Contexto: primeira task do primeiro projeto real (Augmented
Chess, `foundation_app_scaffold`) lançada duas vezes com Codex Terra Medium.
Mistake: o launcher entregava ao worker três caminhos de escrita fora do repo
alvo — `report.json`, `handoff-draft.json` e o HOME sanitizado — sem nenhuma
representação única que provasse que o sandbox real do provider os concedia.
O worker fez o scaffold, saiu com exit 0 e não conseguiu escrever o protocolo
(`patch rejected: writing outside of the project`); `npm install` falhou com
`EAI_AGAIN` pela mesma razão estrutural: a rede também nunca foi declarada.
Duas execuções pagas para descobrir um mismatch mecânico.
Rule: todo requisito de acesso de um worker precisa estar representado num
contrato explícito, derivado UMA vez por lançamento, traduzido pelo provider e
PROVADO pela leitura do argv efetivo antes do spawn. Path entregue ao worker
não implica permissão. Contrato não provado é `PREFLIGHT_BLOCKED` — zero
launch, zero token, e nunca veredito sobre o modelo. Rede é capability de
desenvolvimento declarada, não exceção para `npm`; e continua sem autorizar
efeito externo, que segue nos gates próprios.

[2026-08-23] Contexto: attempt 3 de `foundation_app_scaffold` terminou com
exit 0, report e handoff presentes, e o finalizer do control plane crashou
ANTES da validação oficial com `ZodError: commit-message excede 200 bytes`.
Mistake: o harness reusava `PlanTask.title` — campo SEMÂNTICO, deliberadamente
ilimitado para explicar a work unit — diretamente como subject de commit, que
é bounded em 200 bytes. Os 13 titles do plano gerado, todos aprovados nos
gates do planner, estouravam o limite. Nada tinha falhado no worker: um plano
válido era, por construção, impossível de finalizar.
Rule: campo semântico NUNCA vira artefato operacional por reuso direto; vira
por derivação determinística e TOTAL, com o budget do lado de quem tem budget.
Toda representação bounded derivada de um contrato ilimitado precisa de uma
primitive própria — byte-aware em UTF-8, com scope e summary limitados
independentemente e fallback que a torne total — e de fonte ÚNICA para o
limite, lida tanto pelo validador quanto pelo gerador. Se um consumidor pode
recusar o que um produtor válido produz, a incompatibilidade é do consumidor,
não do plano: não se encurta o campo semântico nem se afrouxa o budget.

[2026-08-23] Contexto: attempt 3 de `foundation_app_scaffold` entregou um
scaffold Vite + React + TypeScript completo e correto — `npm install`,
`typecheck`, `build` e `vitest` todos verdes. O control plane travou a work
unit em `RUNNING/FINALIZING` indefinidamente porque o worker declarou
`src/coverage/.gitkeep` em `changed_files`, o arquivo existia no filesystem, e
o `.gitignore` do alvo (`coverage/`) fazia o Git não representá-lo. Nenhuma
validação oficial chegou a rodar, nenhum candidate foi derivado, nenhum repair
era possível — e o único caminho de saída passava por primitives internas
(`dev-close`, `dev-recover-*`) que o operador tinha que conhecer.
Mistake: o harness tratava o SELF-REPORT do worker como AUTORIDADE sobre um
fato que ele mesmo consegue derivar. `report.changed_files` definia o conjunto
do candidate e o Git apenas confirmava; qualquer divergência — arquivo
ignorado, arquivo extra, declaração errada, nota ausente ou malformada — virava
bloqueio terminal. A mesma inversão estava em `failed-attempt-source` e
`retry-failed`, então o FAIL também nascia irreparável.
Rule: no caminho operacional, cada fato pertence a quem consegue PROVÁ-LO —
Git sobre material alterado, process runner sobre exit/duração/timeout,
validador oficial sobre validação, orquestrador sobre PASS/FAIL e
`accepted_commit`. O worker contribui SEMÂNTICA (summary, decisions, lessons,
open questions, confidence), e semântica ausente ou errada vira discrepância
observável, nunca veto. Artifact que o Git ignora não é categoria especial:
ele simplesmente não entra no candidate — sem `git add -f`, sem editar
`.gitignore` pelo control plane, sem recipe nova e sem gate humano. Se ele
importava, a validação oficial ou a aceitação reprovam e o repair decide; se
não importava, nunca houve motivo para bloquear. Corolário operacional: uma
primitive interna que o operador precisa conhecer para destravar trabalho
legítimo é cerimônia vazando para a interface — quem orquestra primitives é o
runner de topo, e rerodar o mesmo comando é a interface de resume.

[2026-08-23] Contexto: ao desacoplar a materialização benchmark-style do
caminho operacional, ficou visível que `afterWorkUnit` chamava
`materializeObservedAttempt` sem guarda — e essa função monta envelope,
execution record, comparable facts, evaluation, score, qualification,
manifests, index e binding.
Mistake: uma work unit JÁ validada e JÁ aceita perdia a run inteira se
qualquer parte do registro secundário de aprendizado falhasse. Observabilidade
auxiliar tinha poder de veto sobre o produto do usuário.
Rule: separar OPERATIONAL PROGRESS de EXPERIMENTAL/CANONICAL MATERIALIZATION.
Falha de score, qualification, index ou seal vira `OBSERVABILITY_DEGRADED` e o
progresso segue; o Experimental Plane continua existindo e continua produzindo
evidência comparável, mas perde o poder de reverter trabalho válido. A exceção
permanece fail-closed e explícita: evidência necessária a segurança, billing,
autorização, integridade da base e identidade do candidate. Pela mesma razão,
histórico canônico ilegível no ROUTING degrada para o router determinístico —
que é estritamente mais conservador, porque história só consegue override sob
dominância de Pareto.

[2026-08-24] Contexto: a interface direta `pnpm lab run` nasceu com suíte
verde, mas os quatro primeiros usos reais falharam em fronteiras distintas —
gate humano falso por frase de PROIBIÇÃO, `user_intent.request` limitado a
4000 caracteres, e `DRAFT_NOT_PARSEABLE` porque o stdout JSONL do Codex era
tratado como um único JSON.
Mistake: os testes exercitavam cada módulo dentro do contrato que ele mesmo
declarava, e o caminho real do produto — Run Directive grande, colada por um
humano, com salvaguardas negativas, indo até um provider com transporte
próprio — nunca era percorrido de ponta a ponta. Teste verde provou os
módulos, não o produto.
Rule: toda fronteira de contrato do PRODUCT ENTRY PATH precisa de prova no
formato real do produto, não no formato conveniente do módulo: (a) input do
tamanho e da forma que o humano realmente cola, com byte equality na entrega
ao provider — substring esconde truncation; (b) transporte de provider provado
contra fixture capturada da CLI instalada, com os quatro diagnósticos
separados (transporte malformado, falha terminal do provider, payload de
modelo inválido, draft válido); (c) classificação lexical de intenção testada
nos dois sentidos e nos dois idiomas — negada não gera gate, afirmativa gera;
(d) um E2E que atravesse parser, autorização, packet e normalização reais com
apenas o provider substituído. Corolário de contrato: limite incidental de um
artefato interno nunca vira política de input do produto — se existe máximo
global, ele é declarado, justificado e falha explícito antes do provider.
Corolário de UX: resposta de gate humano só pode oferecer opções que a
política realmente concede, derivadas de uma fonte única de grantability.

[2026-08-24] Contexto: o worker runtime budget do router somava
`resource_envelope.duration_ms.expected` e `validation_budget.expected` antes
de aplicar os multiplicadores, e comparava o total com o runtime bound do
coding-worker profile. Duas reproduções reais: `coverage_engine_core`
(1.996.000ms contra 1.800.000ms) e um deadlock de bootstrap em que a própria
task que corrigiria o defeito ficou HUMAN_REQUIRED por 1.849.000ms contra o
mesmo bound, com iteration_count=0.
Mistake: as duas grandezas eram somadas só porque ambas são milissegundos. Com
`official_validation_owner=orchestrator` e `worker_validation_policy=targeted`
o processo do coding worker termina no candidate e nunca executa a validação
oficial — o timeout dele carregava o custo previsto de trabalho de um stage
posterior, que outro processo faz. O limite reportado era verdadeiro sobre um
runtime que ninguém ia consumir.
Rule: budget de tempo pertence ao lifecycle stage que o consome. Só some ao
runtime de um processo o custo dos stages que ESSE processo executa, e derive
a inclusão da ownership estruturada que já existe
(`ProfileCapability.ownership`), nunca de profile id, provider, model,
repositório ou task id. O custo excluído continua observado no telemetry
(`aggregate_validation_cost_ms`) ao lado da parcela efetivamente cobrada
(`worker_owned_validation_cost_ms`), e a provenance diz qual dos dois casos
ocorreu e por quê — telemetry que soma o que não cobra é telemetry enganosa.
Corolário: a correção é sempre no consumidor. Nunca clampe o budget ao bound,
nunca aumente `timeout_seconds` do profile e nunca rebaixe a capability
classification para fazer o routing caber — um limite genuíno continua
verdadeiro e continua sendo BUDGET_UNSUPPORTED.

[2026-08-24] Context: uma self-run real recebeu do planner um draft completo,
mas `validation[].argv` continha uma linha de shell com metacaractere; o gate
deterministico recusou corretamente o conteudo e encerrou o projeto antes do
coding worker.
Mistake: tratar toda rejeicao de draft como falha terminal da run, mesmo quando
o provider respondeu normalmente e os issues determinísticos descreviam um
problema que um novo draft podia corrigir sem decisao humana.
Rule: depois de `DRAFT_RETURNED`, somente falhas de conteudo corrigiveis em
schema/projecao, decomposicao ou DAG podem receber UMA revisao; entregar os
issues determinísticos, exigir replacement completo sem patch/merge e executar
todos os gates novamente. Nunca revisar automaticamente packet construction,
provider/transport, autorizacao, billing, credencial, safety ou decisao humana;
duas invocacoes totais sao o limite absoluto.

[2026-08-24] Context: uma self-run real finalizou um candidate, passou os gates
oficiais e recebeu `REVIEW_REJECTED`; o task state ainda era
`RUNNING/FINALIZING`, mas o worktree HEAD já apontava para o commit candidato.
Mistake: classificar `PENDING + FINALIZING + commit_owner=orchestrator` como
protocol-output recovery sem provar que o HEAD ainda era a base autorizada. A
primitive recusou corretamente o candidate já commitado e mascarou o motivo
original da parada.
Rule: antes de despachar uma recipe pós-launch, prove no classificador todas as
pré-condições estruturais que distinguem seu estado conhecido; para
protocol-output recovery isso inclui `HEAD == task.base_sha ==
authorized_head_sha`. Se qualquer precondição falhar, preserve a razão original
e retorne `HUMAN_REQUIRED` sem invocar a primitive.

[2026-08-24] Context: uma self-run real planejou
`estimated_duration.expected=1.200.000ms` e
`validation_budget.expected=1.500.000ms`, mas somou ambos em
`resource_envelope.duration_ms.expected=2.700.000ms`; o routing recusou todos
os profiles advanced antes do coding worker.
Mistake: o schema e o router separavam corretamente as grandezas, porém o
prompt do planning worker declarava apenas campos e unidades, sem explicar a
ownership. O draft colapsou validação orchestrator-owned no envelope base do
worker.
Rule: contratos de output para planners devem declarar consumidor e lifecycle
stage, não só tipo e unidade. `resource_envelope.duration_ms` é o envelope base
do coding worker e nunca incorpora `validation_budget` no planner; o control
plane observa o budget separadamente e só o adiciona quando
`ProfileCapability.ownership.official_validation_owner` pertence ao worker.

[2026-08-24] Context: todo worker do harness era lançado sob `timeout <N>s`,
onde N vinha da duração PREVISTA da task, e o router recusava profile quando a
previsão excedia `LauncherProfile.timeout_seconds` (1800s em todo o catálogo).
Mistake: tratar uma ESTIMATIVA como autorização. O número que o planner
inventava passava a decidir qual modelo era permitido e quando o processo
morria, contaminando o experimento — o que estava sendo medido deixava de ser a
capacidade do agente e passava a ser a aderência do planner a um teto
arbitrário —, e prejudicando execução long-horizon.
Rule: previsão de duração é HIPÓTESE e nunca autorização. Nenhum forecast pode
impedir routing, rejeitar profile, virar wall-clock deadline ou encerrar
worker; ele é registrado como ADVISORY e comparado depois com o tempo
observado. Ao remover um limite de tempo, prove que nenhuma janela de processo
imortal ficou aberta: substitua-o por um failsafe de INFRAESTRUTURA explícito e
separado (`MACHINE_SAFETY_CEILING`), com proveniência própria, independente de
planner/profile/estimativa, e justificado como policy operacional — não como
duração ótima de tarefa. Trocar o número no mesmo campo não é solução.

[2026-08-24] Context: a primeira infraestrutura de detecção de stall poderia,
de graça, ter recebido autoridade de matar processo silencioso.
Mistake potencial: dar poder de termination a uma janela de silêncio nunca
observada empiricamente. Um worker saudável que pensa em silêncio seria morto,
e a evidência de que a janela estava errada seria destruída junto com o run.
Rule: um detector novo nasce OBSERVACIONAL. Colete a distribuição real do sinal
(por provider, model, reasoning effort, task class, dificuldade e outcome)
antes de conceder autoridade de encerrar qualquer coisa, e registre no próprio
telemetry que a autoridade é nula (`termination_authority`), para que nenhum
leitor futuro precise inferir se aquilo matou algo. Corolário: nunca trate
atividade de I/O bruto como prova de progresso semântico — nem silêncio como
prova de travamento.

[2026-08-26] Context: run real contra repositório externo parou em
`PLANNER_RUNNING` → `SCHEMA_NORMALIZATION`, com 12 issues
`tasks.N.schema_version: Invalid literal value, expected 1`. O runtime apontado
como evidência continha só intake, directive, authorization e observability.
Mistake: o pipeline determinístico descartava o draft não confiável assim que o
gate o rejeitava. Nenhum postmortem conseguia distinguir se `schema_version`
tinha sido omitido, vindo como string, como outro número ou alterado entre a
saída do provider e a normalização — e, sem o draft, qualquer mudança de schema
seria especulação.
Rule: um gate que REJEITA uma saída não confiável precisa PERSISTIR essa saída
antes de descartá-la. O artifact rejeitado é a evidência primária da rejeição;
stage e lista de issues sozinhos não reconstroem a causa. Preserve por
tentativa, append-only, e faça o relatório de falha apontar o artifact exato em
vez da raiz genérica do runtime. A camada pura não ganha caminho de
filesystem para isso: ela emite um record e o adapter de runtime persiste.
Corolário: nunca "conserte" o schema com coerção, default ou reparo
heurístico antes de ter o draft cru em mãos.

[2026-08-26] Context: com o draft cru finalmente preservado, o postmortem do
run real ficou trivial: o envelope externo trazia `schema_version: 1`, e as 14
tasks da revisão de substituição OMITIAM o mesmo campo repetido. O plano em si
estava correto — o planner tinha entendido o protocolo v1 no draft inicial e
respondido à rejeição de AVC decompondo 9 tasks em 14.
Mistake: exigir que um provider não confiável reproduza, dentro de cada objeto
aninhado, uma versão de protocolo que o control plane JÁ validou no envelope
externo. Isso não acrescenta informação nenhuma e transforma metadado de
control plane num ponto de falha probabilístico, que derruba um plano inteiro
por um motivo que não é de planejamento.
Rule: separe METADADO DE PROTOCOLO de DECISÃO SUBSTANTIVA na fronteira não
confiável. Metadado de protocolo já validado no envelope pode ser propagado
deterministicamente para um filho que o OMITE, antes do parse estrito; tudo o
que é decisão (objective, taxonomy, risk, acceptance, validation, envelope)
continua estrito, sem default, alias, coerção ou reparo heurístico. A regra é
de sentido único: campo PRESENTE nunca é reescrito, então uma versão explícita
incompatível continua rejeitando. Canonicalização nunca muta o candidato — a
evidência crua do provider tem que continuar mostrando o que ele devolveu.

[2026-08-26] Context: a revisão de um plano científico real decompôs uma task
crítica em três unidades menores, mas todas conservaram dependências legítimas
e foram novamente recusadas por `retry_not_isolated`.
Mistake: inferir que `risk=critical` e `blocked_by` não vazio provavam uma
fronteira de retry compartilhada. O lifecycle exige dependências `PASS`, parte
do último commit aceito e reseta somente o patch do attempt downstream; a
topologia descrevia precedência, não rollback conjunto.
Rule: hard gate de decomposição só pode usar uma propriedade observável que
prove que execução, retry ou rollback excede a work unit. Nunca converta
dependência DAG ordinária em prova de não-isolamento; sem provenance suficiente,
preserve o sinal apenas para compatibilidade histórica e não o emita.

[2026-08-26] Context: uma deliberação real avaliou um plano autorizado contra
o contrato completo de `PlannedTask`, mas recebeu uma projeção que omitia dez
campos canônicos e transformava comandos estruturados em strings.
Mistake: rotular uma visão parcial como a versão corrente do plano e, no mesmo
prompt, exigir que o deliberador verifique um schema mais rico. Campos omitidos
pelo control plane ficaram indistinguíveis de campos ausentes no plano.
Rule: quando um modelo valida um objeto contra um contrato canônico, entregue o
objeto canônico completo ou torne cada omissão e sua provenance explícitas.
Nunca apresente uma projeção lossy como se fosse o artefato que será validado.

[2026-08-26] Context: ao preparar um retry real, o documento de estabilização
descrevia a Run Directive e apontava para seu artefato persistido, mas foi
copiado como se ele próprio fosse a directive executável.
Mistake: confundir um documento de controle com a entrada canônica que ele
referencia; o parser recusou corretamente a ausência de `target.type` antes de
qualquer provider ou runtime.
Rule: reproduza uma Run Directive somente a partir do `lab/run-directive.txt`
persistido da execução fonte e prove o diff byte a byte. Nunca reconstrua ou
substitua essa entrada por um documento que apenas a descreve.

[2026-08-26] Context: um handoff draft válido de 4002 bytes virou um
HandoffRecord de 4318 bytes ao ser selado, e o mesmo teto de 4 KiB que
protegia o payload do worker foi cobrado do record — matando a run real
`semi-imperium-real-01` depois de trabalho válido, validado e commitado.
Mistake: reutilizar uma constante de budget entre um artefato escrito pelo
worker e outro construído pelo orquestrador. O contrato ficou insatisfazível:
o worker não tinha como prever nem evitar o crescimento que o selo introduz.
Rule: todo budget de bytes pertence a quem AUTORA os bytes. Antes de aplicar
um teto, pergunte quem pode ficar abaixo dele por escolha própria; se o
artefato cresce por fato que outra camada acrescenta, o teto pertence à
fronteira onde esse artefato é transmitido, nunca ao ponto onde é selado.
Truncar fato autoritativo para caber num teto herdado é sempre pior que o
problema que o teto resolvia.

[2026-08-27] Context: a retomada de um REJECT legado publicou uma classificação
read-only append-only e caiu antes de concluir o archival; a repetição tentou
chamar outro classificador e colidiu corretamente com o record existente.
Mistake: tratar artifact append-only como simples saída de uma etapa, sem
consultá-lo como autoridade antes de repetir o efeito externo que o produziu.
Rule: toda etapa resumível que publica evidência append-only deve fazer
read-before-launch, verificar os vínculos canônicos do record e consumir o
record válido existente. Só ausência autoriza nova invocação; divergência falha
fechado, e uma repetição nunca recria decisão já persistida.

[2026-08-27] Context: a prova descartável copiou o runtime principal de uma run
externa, mas omitiu o inbox irmão; o repair preservou record e bundle e então
parou, corretamente, porque não podia provar os bytes do worker.
Mistake: considerar `runtimeDir` uma cópia operacional completa quando o
contrato separa artifacts derivados do orquestrador e artifacts autorados pelo
worker em raízes irmãs.
Rule: ao clonar um lifecycle para prova/recovery, derive todos os artifact roots
pela mesma primitive de paths usada pelo runtime e copie cada raiz sem
hardlinks. Antes de mutar a cópia, confira os hashes cruzados entre finalization,
inbox e records; ausência nunca é substituída por reconstrução ou inferência.

[2026-08-27] Context: a mesma run `semi-imperium-real-01` morreu de novo, agora
na task 04 (`crest_selection_workflow`): ~19 min de Opus 5 high, validação
oficial PASS, candidate já commitado em `be5ff5a`, e então
`BudgetExceededError: HandoffDraft excede o budget: 4438 bytes > 4096 bytes`.
A correção anterior tinha separado a PROPRIEDADE do budget (draft do worker vs.
record do orquestrador) mas manteve o teto do draft como autoridade.
Mistake: aceitar que um número interno inventado — sem contraparte em quota,
janela de contexto de provider, memória de máquina ou efeito externo — pudesse
encerrar lifecycle. Corrigir a atribuição do teto sem perguntar se o teto
deveria existir deixou o mesmo bottleneck vivo em outro artifact.
Rule: um limite só tem autoridade de execução se corresponder a uma restrição
REAL — autorização, segurança, capacidade de provider de fato recusada,
billing/credencial, correção determinística com reparo esgotado. Estimativa,
previsão e alvo de tamanho são telemetria: podem ser medidos e rotulados, e
nunca podem decidir PASS/FAIL, parar execução, criar HUMAN_REQUIRED, alterar
routing ou alterar cobrança. Ao encontrar um limite que para trabalho válido,
classifique-o antes de ajustá-lo: subir o número mantém o bug de categoria.

[2026-08-27] Context: Provider Expansion v1 — OpenCode como terceiro scaffold.
Mistake: o campo `agent` significava scaffold, upstream, cobrança e pool ao
mesmo tempo. Enquanto só existiam Claude e Codex as quatro respostas coincidiam
e a coincidência passava por design; `cross_provider` comparava nome de
executável, e Codex -> OpenCode/openai teria contado como troca de provider
sendo a MESMA conta, o MESMO modelo e a MESMA franquia.
Rule: toda dimensão que pode divergir tem campo próprio. Antes de acrescentar
provider, perguntar quais das sete dimensões (scaffold, upstream, modelo, auth,
cobrança, pool, capability) o novo caso separa — e separar no schema, não no
comentário.

[2026-08-27] Context: a chave de API do OpenCode Go autentica uma assinatura.
Mistake: a regra `chave => cobrança por API` tornava a combinação
irrepresentável, e a saída fácil seria afrouxar a proteção de cobrança para
caber.
Rule: quando um caso novo não cabe na regra, refinar o modelo, nunca enfraquecer
a proteção. `AuthMethod` e `BillingMode` são enums separados ligados por uma
tabela de contratos comerciais; quem decide a cobrança é o upstream, não o
formato da credencial.

[2026-08-27] Context: `opencode models` custa ~4,6s e o doctor o chamava por
profile; com dez perfis OpenCode o teste que varre o catálogo estourou os 30s.
Mistake: uma leitura que não depende do profile foi colocada no laço por profile.
Rule: leitura invariante entre profiles é memoizada por processo. Antes de
acrescentar subprocesso ao doctor, perguntar de que ele depende — se não depende
do profile, ele roda uma vez.

[2026-08-27] Context: `runBillingPreflight` recebeu `provider` mas não o
repassou a `probeCredentialSource`; dois testes de preflight OpenCode falharam
com "sem upstream declarado" apesar de o perfil declarar.
Mistake: campo novo adicionado à borda de entrada e esquecido no ponto interno
que o consome.
Rule: ao acrescentar um campo que atravessa camadas, seguir o valor até o último
consumidor antes de dar por feito — o typecheck não pega parâmetro opcional
omitido.

[2026-08-27] Context: Provider Expansion v1 entregou probes read-only, schema de
capacidade e `LaunchRecord.pool_capacity`, mas `launchTask` chamava
`launchWorker` sem o `poolCapacityProbe` opcional e o routing lia só evidência
já persistida. Todo launch de produção gravava `pool_capacity: null`.
Mistake: a primitive foi dada por entregue porque tinha teste; o teste injetava
o probe à mão, então provava a primitive e não a chamada de produção.
Rule: capacidade opcional só está entregue quando um caller de PRODUÇÃO a
fornece. Teste de fiação exercita o caminho real (`runOrchestrate`/`launchTask`,
não `launchWorker` com probe injetado) e conta as chamadas — se remover a fiação
não quebra o teste, o teste não prova fiação nenhuma.

[2026-08-27] Context: `quotaFactOf` documentava que quota não era probada antes
do launch porque medi-la custaria o recurso medido. Os endpoints de capacidade
da v1 são read-only e não fazem inferência: a premissa virou falsa.
Mistake: a justificativa sobreviveu ao fato que a sustentava e continuaria
ensinando a próxima pessoa a não medir.
Rule: comentário que justifica uma AUSÊNCIA é revalidado junto com a mudança que
remove o motivo da ausência. Racional obsoleto é dívida, não histórico.

[2026-08-28] Context: `effectiveQuotaHeadroom` combinava probe fresco com o
último `LaunchRecord` do mesmo pool — probe UNKNOWN herdava 90% de folga de
outra work unit, e um `EXHAUSTED` antigo continuava recusando um profile cuja
janela já podia ter resetado.
Mistake: fallback foi tratado como robustez. Ele preservava um NÚMERO às custas
do fato de que ninguém sabia mais nada — e o número era de outra atividade.
Rule: medida de recurso externo só vale para a decisão que a observou. Falha
instrumental é UNKNOWN e permanece UNKNOWN; histórico responde "quanto isto
consumiu", nunca "quanto existe agora". Reuso só dentro da MESMA decisão
imediata, indexado pela chave do recurso — nunca por tempo decorrido.

[2026-08-28] Context: regressao de recovery precisava comparar hashes fora do
fixture que montava o FinalizationRecord.
Mistake: o digest helper foi declarado dentro do fixture e reutilizado pela
asserção fora daquele escopo, fazendo o teste GREEN falhar por erro do teste.
Rule: helper usado tanto na montagem quanto na asserção fica no escopo do
modulo ou reutiliza a primitive canonica de producao.
