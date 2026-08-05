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
5. Rode as validações do packet você mesmo antes de commitar.
6. Escreva o AgentCompletionReport em ${io.reportPath}
   e o HandoffDraft em ${io.handoffDraftPath} (máx. 4 KiB, JSON).
   O report declara self_reported_result SUCCESS ou FAILURE, candidate_commit,
   changed_files e validations. Você NÃO decide se o commit foi aceito:
   não escreva accepted_commit.
7. Encerre a sessão. Não inicie a próxima tarefa.

Packet (também em ${io.packetPath}):
`;

  const size = Buffer.byteLength(preamble, 'utf8');
  if (size > MAXIMUM_PREAMBLE_BYTES) {
    throw new Error(`preâmbulo do prompt excede ${MAXIMUM_PREAMBLE_BYTES} bytes: ${size}`);
  }
  return `${preamble}${canonicalJson(packet)}\n`;
}
