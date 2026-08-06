import { canonicalJson } from './canonical.js';
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
export function buildWorkerPrompt(packet: TaskPacket, io: PromptIo): string {
  const preamble = `Você é um worker de sessão descartável do agent-strategy-lab.

Regras:
1. Execute SOMENTE a tarefa deste packet. Nada além do escopo.
2. Repositório: ${io.repoRoot}. Trabalhe a partir do base SHA do packet.
3. Não altere o runtime do orquestrador nem dev/plan.yaml. Fora do repositório,
   escreva SOMENTE nos dois caminhos de inbox indicados na regra 6.
4. Ao terminar, crie EXATAMENTE UM commit local com todo o trabalho. Sem push.
5. Rode as validações do packet você mesmo antes de commitar. Um comando por
   chamada: comando composto (;, &&, |, redirecionamento) é negado pela
   política de permissões.
6. Escreva os DOIS arquivos JSON abaixo. O schema é ESTRITO — nenhum campo a
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
7. Encerre a sessão. Não inicie a próxima tarefa.

Packet (também em ${io.packetPath}):
`;

  const size = Buffer.byteLength(preamble, 'utf8');
  if (size > MAXIMUM_PREAMBLE_BYTES) {
    throw new Error(`preâmbulo do prompt excede ${MAXIMUM_PREAMBLE_BYTES} bytes: ${size}`);
  }
  return `${preamble}${canonicalJson(packet)}\n`;
}
