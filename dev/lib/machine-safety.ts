/**
 * MACHINE_SAFETY_CEILING — failsafe de INFRAESTRUTURA.
 *
 * NÃO é budget de task. Ele não conhece `estimated_duration`,
 * `resource_envelope`, difficulty, planner, routing ou profile: nenhuma dessas
 * grandezas entra no cálculo, e ele nunca rejeita um profile nem impede um
 * launch. A única pergunta que ele responde é operacional:
 *
 *   "existe um instante a partir do qual um processo deste harness deixou de
 *    ser trabalho em andamento e passou a ser uma máquina sequestrada?"
 *
 * POR QUE O DEFAULT É ESTE — decisão de POLICY OPERACIONAL, não estimativa de
 * duração ótima de tarefa:
 *
 * - Ele precisa ficar ACIMA de qualquer execução saudável imaginável, porque
 *   um teto que corta trabalho legítimo reintroduz exatamente o task deadline
 *   que foi removido — apenas com outro nome. As execuções observadas do Lab
 *   até aqui vivem na casa dos minutos; doze horas ficam ordens de grandeza
 *   acima disso.
 * - Ele precisa ficar ABAIXO do ponto em que um processo travado se torna
 *   invisível: um worker que atravessa um ciclo inteiro de sono do operador
 *   ainda é detectável de manhã; um que atravessa dias não é.
 *
 * Doze horas não é a duração de nenhuma task. É o ponto em que a hipótese
 * "isto ainda é trabalho" deixa de valer mais que a hipótese "isto é um
 * processo imortal", sem nenhuma pretensão de estar calibrado — a calibração
 * empírica é do stall detector observacional, que não tem autoridade de
 * termination nesta fase.
 */

export const MACHINE_SAFETY_CEILING_ENV = 'AGENTLAB_MACHINE_SAFETY_CEILING_SECONDS';

/** 12h. Justificativa acima: OPERATIONAL SAFETY POLICY, não duração de task. */
export const DEFAULT_MACHINE_SAFETY_CEILING_SECONDS = 43_200;

export interface MachineSafetyCeiling {
  readonly kind: 'MACHINE_SAFETY_CEILING';
  readonly seconds: number;
  /** De onde este valor veio — default, ambiente ou override de teste. */
  readonly provenance: string;
}

export class MachineSafetyCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineSafetyCeilingError';
  }
}

/**
 * Fracionário é ACEITO de propósito: o failsafe precisa ser exercitável em
 * milissegundos por um teste, senão a única prova de que nenhum processo é
 * imortal seria uma suíte de doze horas. O piso positivo continua valendo —
 * teto zero ou negativo mataria o worker antes de ele existir.
 */
function assertPositiveFinite(seconds: number, origin: string): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new MachineSafetyCeilingError(
      `machine safety ceiling inválido (${seconds}) vindo de ${origin}: precisa ser um número positivo de segundos`,
    );
  }
  return seconds;
}

export interface MachineSafetyCeilingInput {
  /** Override EXPLÍCITO — usado por testes para exercitar o failsafe em segundos. */
  readonly overrideSeconds?: number | undefined;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Precedência: override explícito > ambiente > default. A proveniência sempre
 * acompanha o valor para que nenhum record deixe dúvida sobre qual autoridade
 * encerrou um processo.
 */
export function machineSafetyCeiling(input: MachineSafetyCeilingInput = {}): MachineSafetyCeiling {
  if (input.overrideSeconds !== undefined) {
    return {
      kind: 'MACHINE_SAFETY_CEILING',
      seconds: assertPositiveFinite(input.overrideSeconds, 'override explícito'),
      provenance: 'override explícito do chamador (uso de teste)',
    };
  }

  const raw = (input.env ?? process.env)[MACHINE_SAFETY_CEILING_ENV];
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    return {
      kind: 'MACHINE_SAFETY_CEILING',
      seconds: assertPositiveFinite(parsed, MACHINE_SAFETY_CEILING_ENV),
      provenance: `${MACHINE_SAFETY_CEILING_ENV}=${raw}`,
    };
  }

  return {
    kind: 'MACHINE_SAFETY_CEILING',
    seconds: DEFAULT_MACHINE_SAFETY_CEILING_SECONDS,
    provenance: `default de policy operacional (${DEFAULT_MACHINE_SAFETY_CEILING_SECONDS}s, dev/lib/machine-safety.ts)`,
  };
}

export function machineSafetyCeilingMs(ceiling: MachineSafetyCeiling): number {
  return ceiling.seconds * 1_000;
}
