import { canonicalJson } from './canonical.js';
import type { ExecutionPolicy } from './execution-policy.js';
import type { TaskPacket } from './schemas.js';

/** Limite do preâmbulo fixo: o prompt não pode reintroduzir contexto pela porta dos fundos. */
export const MAXIMUM_PREAMBLE_BYTES = 4_096;

export interface PromptIo {
  readonly repoRoot: string;
  readonly packetPath: string;
  readonly reportPath: string;
  readonly handoffDraftPath: string;
}

/**
 * O prompt é gerado, determinístico e curto. Contém o packet e as regras de
 * encerramento — nada de transcript, conversa anterior ou raciocínio herdado.
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
      : `Execute SOMENTE checks pequenos necessários para desenvolver o patch.
   Pode executar typecheck, o teste direcionado da tarefa e testes adicionais pequenos e diretamente
   relacionados. NÃO execute o \`pnpm test\` completo. NÃO execute o \`pnpm build\` global.
   NÃO execute novamente toda a lista \`packet.validation\`. As validações oficiais completas
   pertencem exclusivamente ao orquestrador e serão executadas fora do sandbox do provider.
   Uma falha ambiental de uma validação global que o worker não deveria executar
   não deve ser investigada pelo worker.`;
  const preamble =
    executionPolicy.commit_owner === 'worker'
      ? `Você é um worker de sessão descartável do agent-strategy-lab.

Regras:
1. Execute SOMENTE a tarefa deste packet. Nada além do escopo.
2. Repositório: ${io.repoRoot}. Trabalhe a partir do base SHA do packet.
3. Comece pelo packet e pelos initial_files. Não carregue skills nem subagentes
   salvo pedido explícito do packet. Use rg e intervalos direcionados; não leia
   LESSONS.md ou ARCHITECTURE.md inteiros sem necessidade.
4. Em tarefa localizada, busque a primeira edição após no máximo 8 operações
   exploratórias. Não faça revisão geral do repositório para uma tarefa objetiva.
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
 "decisions":[<≤5>],"lessons":[<≤3>],"relevant_files":[<≤5>]}

${io.handoffDraftPath} (máx. 4 KiB)
{"schema_version":1,"task_id":"<id do packet>","result":"PASS"|"FAIL",
 "changed_files":[<≤50>],"validations":[<mesmo formato acima>],
 "decisions":[<≤5>],"lessons":[<≤3>],"next_relevant_files":[<≤5>]}

   Você NÃO decide se o commit foi aceito: não escreva accepted_commit.
9. Encerre a sessão. Não inicie a próxima tarefa.

Packet (também em ${io.packetPath}):
`
      : `Você é um worker de sessão descartável do agent-strategy-lab.

Regras:
1. Execute SOMENTE a tarefa deste packet. Nada além do escopo.
2. Repositório: ${io.repoRoot}. Trabalhe a partir do base SHA do packet.
3. Comece pelo packet e pelos initial_files. Não carregue skills nem subagentes
   salvo pedido explícito do packet. Use buscas e leituras direcionadas.
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
 "decisions":[<≤5>],"lessons":[<≤3>],"relevant_files":[<≤5>]}

   SUCCESS significa "patch pronto para validação oficial".
   candidate_commit deve ser null. changed_files deve descrever exatamente os
   arquivos alterados. validations contém somente comandos que realmente executou.

${io.handoffDraftPath} (máx. 4 KiB)
{"schema_version":1,"task_id":"<id do packet>","result":"PASS"|"FAIL",
 "changed_files":[<≤50>],"validations":[<mesmo formato acima>],
 "decisions":[<≤5>],"lessons":[<≤3>],"next_relevant_files":[<≤5>]}

   No HandoffDraft, PASS significa patch pronto para validação; FAIL significa
   que o worker não conseguiu produzir patch utilizável. Não escreva accepted_commit.
8. Encerre a sessão. Não inicie a próxima tarefa.

Packet (também em ${io.packetPath}):
`;

  const full = `${preamble}${repairNotice(packet)}`;
  const size = Buffer.byteLength(full, 'utf8');
  if (size > MAXIMUM_PREAMBLE_BYTES) {
    throw new Error(`preâmbulo do prompt excede ${MAXIMUM_PREAMBLE_BYTES} bytes: ${size}`);
  }
  return `${full}${canonicalJson(packet)}\n`;
}

/**
 * Sem esta nota o campo chegaria como um objeto qualquer no meio do packet, e o
 * worker não teria como saber que ele descreve a própria tarefa reprovada. O
 * texto é fixo: todo o conteúdo variável mora no packet, derivado de record.
 */
function repairNotice(packet: TaskPacket): string {
  if (packet.previous_attempt_diagnostics === undefined) return '';
  return `
ATTEMPT DE REPARO — leia previous_attempt_diagnostics no packet.
O attempt anterior DESTA MESMA tarefa declarou SUCCESS e foi REPROVADO pela
validação oficial do orquestrador. failed_validations lista os comandos que
falharam; validation_logs_dir aponta os logs oficiais no runtime do
orquestrador. O patch anterior NÃO está em disco: a working tree já voltou ao
base. Corrija a causa da falha; repetir a mesma solução reprova de novo.

`;
}
