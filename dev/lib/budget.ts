import { canonicalJson } from './canonical.js';

/** Budgets determinísticos do protocolo de sessões descartáveis. */
export const MAXIMUM_TASK_PACKET_BYTES = 12_288; // 12 KiB

/**
 * Teto do payload que o WORKER escreve. Vale para o `HandoffDraft` e só para
 * ele: é o worker que decide o tamanho de decisões, lições e lacunas, e é dele
 * que o protocolo precisa se defender.
 *
 * Não existe teto equivalente para o `HandoffRecord`, e é deliberado. O record
 * não é o draft com um carimbo: `sealHandoff` substitui `changed_files` e
 * `validations` pelos valores AUTORITATIVOS e acrescenta `accepted_commit` e
 * `sealed_at`. Um draft honesto de 4002 bytes vira um record de 4318 sem que o
 * worker tenha escrito um byte a mais — foi assim que a run real
 * `semi-imperium-real-01` morreu com trabalho válido já commitado. Cobrar do
 * record um teto que o orquestrador é quem estoura torna o contrato
 * insatisfazível, e a saída seria truncar fato — que é pior que o problema.
 *
 * A fronteira do contexto que de fato trafega para a próxima sessão continua
 * sendo `MAXIMUM_TASK_PACKET_BYTES`, cobrada na construção do TaskPacket.
 */
export const MAXIMUM_HANDOFF_DRAFT_BYTES = 4_096; // 4 KiB

export class BudgetExceededError extends Error {
  constructor(
    readonly kind: string,
    readonly actualBytes: number,
    readonly maximumBytes: number,
  ) {
    super(`${kind} excede o budget: ${actualBytes} bytes > ${maximumBytes} bytes`);
    this.name = 'BudgetExceededError';
  }
}

export function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}

export function assertByteBudget(kind: string, value: unknown, maximumBytes: number): void {
  const actual = byteSize(value);
  if (actual > maximumBytes) throw new BudgetExceededError(kind, actual, maximumBytes);
}
