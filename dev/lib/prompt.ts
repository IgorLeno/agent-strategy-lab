import { canonicalJson } from './canonical.js';
import type { ExecutionPolicy } from './execution-policy.js';
import type { TaskPacket } from './schemas.js';

/** Limite do preâmbulo fixo: o prompt não pode reintroduzir contexto pela porta dos fundos. */
export const MAXIMUM_PREAMBLE_BYTES = 5_120;

/**
 * Contrato do HandoffDraft v2, uma vez só, usado pelos dois modos de execução.
 * Curto de propósito: o worker precisa saber o que DECLARAR, não como
 * raciocinar. Nada aqui pede análise, justificativa longa ou passo a passo —
 * o protocolo coleta artifacts operacionais, não raciocínio interno.
 */
const HANDOFF_DRAFT_CONTRACT = `{"schema_version":2,"task_id":"<id do packet>","result":"PASS"|"FAIL",
 "changed_files":[<≤50>],"validations":[<mesmo formato acima>],
 "decisions":[<≤5>],"lessons":[<≤3>],"next_relevant_files":[<caminhos>],
 "what_i_did_not_check":[<itens curtos>],
 "evidence":[{"kind":"file","path":"<caminho>","lines":"<N-M>","claim":"<frase>"}
  |{"kind":"command","argv":[<comando>],"claim":"<frase>"}] (opcional),
 "open_questions":[<itens>] (opcional),"confidence":"<uma frase sua>" (opcional)}

   what_i_did_not_check é OBRIGATÓRIO: liste os aspectos relevantes que você
   reconhece NÃO ter verificado. [] é uma afirmação positiva — você olhou e não
   identificou nenhum — e NÃO significa campo ignorado; omitir o campo invalida
   o arquivo inteiro. evidence APONTA para a evidência (caminho+linhas ou
   comando): nunca conteúdo de arquivo, diff, stdout, stderr ou transcript.
   Em todo ponteiro, copie path, argv e identidade de record exatamente: nunca
   abrevie, trunque nem insira marcador de omissão dentro da identidade.
   Seja conciso e relevante: uma frase por item, fato que o próximo worker
   precisa. NÃO existe teto de bytes — trabalho grande produz draft grande, e
   truncar fato para caber em número nenhum é pior que o arquivo extenso.`

export interface PromptIo {
  readonly repoRoot: string;
  readonly packetPath: string;
  readonly reportPath: string;
  readonly handoffDraftPath: string;
}

/**
 * O prompt é gerado, determinístico e curto. Contém o packet e as regras de
 * encerramento — nada de transcript, conversa anterior ou raciocínio herdado.
 *
 * CONTROL THE BOUNDARIES, NOT THE IMPLEMENTATION: o prompt declara escopo,
 * ownership de commit/validação oficial, o que não pode ser tocado e o
 * protocolo de saída. Ele NÃO diz quais arquivos procurar, quantos ler,
 * quantas operações exploratórias fazer nem qual estratégia de implementação
 * usar — isso é decisão do coding agent.
 */
export function buildWorkerPrompt(
  packet: TaskPacket,
  io: PromptIo,
  executionPolicy: ExecutionPolicy,
): string {
  const validationInstructions =
    executionPolicy.worker_validation_policy === 'full'
      ? `Rode as validações do packet você mesmo antes de commitar. Um comando por
   chamada: comando composto (;, &&, |, redirecionamento) é negado pela
   política de permissões.`
      : `Prefira checks direcionados enquanto desenvolve. Pode rodar build ou uma
   suíte mais ampla quando isso for proporcional e útil para chegar a um
   candidate correto; não repita suítes globais sem necessidade.
   A validação oficial que decide PASS/FAIL pertence exclusivamente ao
   orquestrador e roda fora do sandbox do provider — você não decide o
   resultado, e não precisa reexecutar \`packet.validation\` inteiro para provar
   nada. Quando o patch estiver pronto, escreva AgentCompletionReport e
   HandoffDraft e encerre a sessão.
   Se iniciar um processo auxiliar (dev server, watcher), encerre-o antes de
   finalizar: nenhum processo pode sobreviver à sessão.`;
  const preamble =
    executionPolicy.commit_owner === 'worker'
      ? `Você é um worker de sessão descartável do agent-strategy-lab.

Regras:
1. Execute SOMENTE a tarefa deste packet. Nada além do escopo.
2. Repositório: ${io.repoRoot}. Trabalhe a partir do base SHA do packet.
3. Você tem autonomia para investigar e implementar esta work unit do jeito que
   considerar mais eficiente: explore o repositório, escolha o que ler, decida a
   abordagem, refatore e use as ferramentas auxiliares que o provider oferecer
   (incluindo skills e subagentes) quando isso ajudar. Fique dentro do budget e
   do escopo do packet.
4. Não faça trabalho fora do escopo desta work unit.
5. Não altere o runtime do orquestrador nem dev/plan.yaml. Fora do repositório,
   escreva SOMENTE nos dois caminhos de inbox indicados na regra 8.
6. Ao terminar, crie EXATAMENTE UM commit local com todo o trabalho. Sem push.
7. ${validationInstructions}
8. Escreva os DOIS arquivos JSON abaixo. O schema é ESTRITO — nenhum campo a
   mais, nenhum a menos, exatamente estes nomes. Campo inventado invalida o
   arquivo inteiro e o fechamento fica pendente.

${io.reportPath}
{"schema_version":1,"task_id":"<id do packet>",
 "self_reported_result":"SUCCESS"|"FAILURE","summary":"<texto>",
 "candidate_commit":"<sha completo, 40 hex minúsculos>"|null,
 "changed_files":[<≤50 caminhos>],
 "validations":[{"argv":[<comando>],"exit_code":<int|null>,
   "timed_out":<bool>,"duration_ms":<int≥0>}] (≤20),
 "decisions":[<≤5>],"lessons":[<≤3>],"relevant_files":[<caminhos>]}

${io.handoffDraftPath}
${HANDOFF_DRAFT_CONTRACT}

   Você NÃO decide se o commit foi aceito: não escreva accepted_commit.
9. Encerre a sessão. Não inicie a próxima tarefa.

Packet (também em ${io.packetPath}):
`
      : `Você é um worker de sessão descartável do agent-strategy-lab.

Regras:
1. Execute SOMENTE a tarefa deste packet. Nada além do escopo.
2. Repositório: ${io.repoRoot}. Trabalhe a partir do base SHA do packet.
3. Você tem autonomia para investigar e implementar esta work unit do jeito que
   considerar mais eficiente: explore o repositório, escolha o que ler, decida a
   abordagem, refatore e use as ferramentas auxiliares que o provider oferecer
   (incluindo skills e subagentes) quando isso ajudar. Fique dentro do budget e
   do escopo do packet, e não faça trabalho fora dele.
4. NÃO rode git add, git commit, git stash, git reset nem checkout de arquivos.
   Não altere HEAD nem index por qualquer outro comando.
5. Edite somente o patch da tarefa. Não altere o runtime do orquestrador,
   dev/plan.yaml, .dev, .dev-inbox, .claude, .agents ou .codex.
6. ${validationInstructions}
7. Escreva os DOIS arquivos JSON abaixo. O schema é ESTRITO.

${io.reportPath}
{"schema_version":1,"task_id":"<id do packet>",
 "self_reported_result":"SUCCESS"|"FAILURE","summary":"<texto>",
 "candidate_commit":null,"changed_files":[<≤50 caminhos>],
 "validations":[{"argv":[<comando>],"exit_code":<int|null>,
   "timed_out":<bool>,"duration_ms":<int≥0>}] (≤20),
 "decisions":[<≤5>],"lessons":[<≤3>],"relevant_files":[<caminhos>]}

   SUCCESS significa "patch pronto para validação oficial".
   candidate_commit deve ser null. changed_files deve descrever exatamente os
   arquivos alterados. changed_files lista exclusivamente os arquivos do patch dentro do repositório.
   NÃO inclua reportPath, handoffDraftPath, .dev, .dev-inbox ou qualquer arquivo de protocolo.
   validations contém somente comandos que realmente executou.

${io.handoffDraftPath}
${HANDOFF_DRAFT_CONTRACT}

   No HandoffDraft, PASS significa patch pronto para validação; FAIL significa
   que o worker não conseguiu produzir patch utilizável. Não escreva accepted_commit.
8. Encerre a sessão. Não inicie a próxima tarefa.

Packet (também em ${io.packetPath}):
`;

  const full = `${preamble}${repairNotice(packet)}${continuationNotice(packet)}`;
  const size = Buffer.byteLength(full, 'utf8');
  if (size > MAXIMUM_PREAMBLE_BYTES) {
    throw new Error(`preâmbulo do prompt excede ${MAXIMUM_PREAMBLE_BYTES} bytes: ${size}`);
  }
  return `${full}${canonicalJson(packet)}\n`;
}

/**
 * O oposto exato do `repairNotice`: ali o patch anterior NÃO está em disco e a
 * solução foi reprovada; aqui o patch ESTÁ em disco e ninguém o julgou.
 *
 * Sem esta nota o worker encontraria a working tree suja num attempt que ele
 * acredita começar do base, e a leitura razoável seria "alguém sujou o
 * repositório" — ou pior, desfazer o trabalho para "partir limpo".
 */
function continuationNotice(packet: TaskPacket): string {
  const recovered = packet.recovered_work;
  if (recovered === undefined) return '';
  return `
CONTINUAÇÃO DE TRABALHO RECUPERADO — leia recovered_work no packet.
A working tree JÁ contém as mudanças do attempt ${recovered.source_attempt} DESTA MESMA tarefa.
Aquele attempt foi interrompido por falha terminal do provider antes de
completar o protocolo: o trabalho existe, mas NÃO foi validado, NÃO foi
revisado e não é candidate. O orquestrador o reaplicou no alvo para que você
CONTINUE dele em vez de reimplementar do zero.

Continue a partir do que está lá. Confira, corrija e complete o que faltar —
nada disso passou por gate nenhum. Ao final, changed_files deve declarar TODOS
os arquivos do patch entregue, inclusive os que já vieram recuperados.
Não desfaça o trabalho recuperado para "começar limpo": ele é o ponto de
partida desta tentativa.

`;
}

/**
 * Sem esta nota o campo chegaria como um objeto qualquer no meio do packet, e o
 * worker não teria como saber que ele descreve a própria tarefa reprovada. O
 * texto é fixo: todo o conteúdo variável mora no packet, derivado de record.
 */
function repairNotice(packet: TaskPacket): string {
  if (packet.previous_attempt_diagnostics === undefined) return '';
  // Um attempt de reparo PODE ter trabalho recuperado por cima: o reparo
  // começou, o provider morreu no meio e o que ele já tinha feito foi
  // reidratado. Dizer "o patch não está em disco" ali seria falso, e a nota de
  // continuação é que descreve o que existe na árvore.
  const patchLocation =
    packet.recovered_work === undefined
      ? `O patch anterior NÃO está em disco: a working tree já voltou ao
base. `
      : '';
  return `
ATTEMPT DE REPARO — leia previous_attempt_diagnostics no packet.
O attempt anterior DESTA MESMA tarefa declarou SUCCESS e foi REPROVADO pela
validação oficial do orquestrador. failed_validations lista os comandos que
falharam; validation_logs_dir aponta os logs oficiais no runtime do
orquestrador. ${patchLocation}Corrija a causa da falha; repetir a mesma solução reprova de novo.

`;
}
