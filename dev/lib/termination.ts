/**
 * SUPERVISÃO DE PROCESSO e causa de término.
 *
 * A remoção do task deadline tirou do caminho a única coisa que encerrava um
 * worker vivo. Sem um substituto explícito sobraria uma janela onde um
 * processo pode se tornar imortal — e `killSurvivors` NÃO cobre essa janela:
 * ele roda DEPOIS que o worker terminou, para varrer descendentes que
 * escaparam, e nunca teve como pedir o término de um worker ainda vivo.
 *
 * Este supervisor é esse caminho de cancelamento explícito. Ele sinaliza o
 * GRUPO (o launcher usa `detached: true`, então pgid = pid do worker), na
 * ordem SIGTERM -> graça -> SIGKILL, e registra QUAL autoridade pediu o
 * término. Autoridade é o ponto: um record que só diz `timed_out: true` não
 * distingue um deadline de task legado de um failsafe de máquina.
 */

/**
 * Autoridade que pediu o término de um worker.
 *
 * - `LEGACY_TASK_DEADLINE` — o antigo deadline derivado da duração prevista da
 *   task. Preservado para LER histórico; runs novas do project lifecycle nunca
 *   o produzem.
 * - `MACHINE_SAFETY_CEILING` — failsafe de infraestrutura. Única causa
 *   automática ativa nesta fase.
 * - `STALL_GUARD` — reservado para quando a distribuição real de silêncio
 *   estiver calibrada. NÃO é produzido nesta fase observacional.
 * - `EXPLICIT_CANCELLATION` — alguém (operador ou control plane) pediu.
 */
export const TERMINATION_CAUSES = [
  'LEGACY_TASK_DEADLINE',
  'MACHINE_SAFETY_CEILING',
  'STALL_GUARD',
  'EXPLICIT_CANCELLATION',
] as const;
export type TerminationCause = (typeof TERMINATION_CAUSES)[number];

/** Causas que uma execução NOVA pode legitimamente produzir. */
export const ACTIVE_TERMINATION_CAUSES: readonly TerminationCause[] = [
  'MACHINE_SAFETY_CEILING',
  'EXPLICIT_CANCELLATION',
];

export interface TerminationRequest {
  readonly cause: TerminationCause;
  readonly requested_at: string;
  readonly detail: string;
  /** Sinais REALMENTE enviados, na ordem. SIGKILL só aparece se foi preciso. */
  readonly signals_sent: readonly string[];
  readonly grace_period_ms: number;
  readonly provenance: string;
}

export interface WorkerSupervisorInput {
  readonly pid: number;
  readonly pgid: number;
  /** Graça entre o pedido (SIGTERM) e o SIGKILL. Nunca duração máxima da task. */
  readonly gracePeriodMs: number;
  /** Resolve quando o processo termina; é ela que decide se SIGKILL é preciso. */
  readonly exited: Promise<unknown>;
  /** Injetável para teste; por padrão sinaliza o GRUPO do worker. */
  readonly signal?: (pgid: number, signal: NodeJS.Signals) => void;
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // ESRCH: o grupo já não existe. O fim desejado, alcançado antes do sinal.
  }
}

/**
 * Corrida entre o término real e a graça. Resolve `true` se o processo saiu
 * dentro da graça — só então o SIGKILL é dispensável.
 */
function exitedWithin(exited: Promise<unknown>, graceMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, graceMs);
    timer.unref?.();
    void exited.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

export class WorkerSupervisor {
  readonly #input: WorkerSupervisorInput;
  readonly #signal: (pgid: number, signal: NodeJS.Signals) => void;
  #request: TerminationRequest | null = null;
  #ceilingTimer: NodeJS.Timeout | null = null;
  #inFlight: Promise<TerminationRequest> | null = null;

  constructor(input: WorkerSupervisorInput) {
    this.#input = input;
    this.#signal = input.signal ?? signalProcessGroup;
  }

  /** O pedido efetivo, com os sinais que de fato saíram. `null` se ninguém pediu. */
  get terminationRequest(): TerminationRequest | null {
    return this.#request;
  }

  /**
   * O término do processo e a conclusão da escada de sinais são eventos
   * DIFERENTES: o worker morre no SIGTERM enquanto a escada ainda está
   * esperando a graça. Ler `terminationRequest` no instante do término
   * devolveria `null` e o record perderia a autoridade que o encerrou — por
   * isso o launcher espera aqui antes de classificar.
   */
  async settled(): Promise<TerminationRequest | null> {
    if (this.#inFlight === null) return null;
    return this.#inFlight;
  }

  /**
   * Arma o failsafe de máquina. Não é deadline de task: o valor vem de
   * `machineSafetyCeiling()`, que não conhece planner, profile nem estimativa.
   */
  armMachineSafetyCeiling(ceilingMs: number, provenance: string): void {
    if (this.#ceilingTimer !== null) return;
    this.#ceilingTimer = setTimeout(() => {
      void this.requestTermination(
        'MACHINE_SAFETY_CEILING',
        `nenhum processo do harness é imortal: o teto de segurança de máquina (${ceilingMs}ms, ${provenance}) foi atingido`,
      );
    }, ceilingMs);
    this.#ceilingTimer.unref?.();
  }

  disarm(): void {
    if (this.#ceilingTimer === null) return;
    clearTimeout(this.#ceilingTimer);
    this.#ceilingTimer = null;
  }

  /**
   * Caminho de cancelamento EXPLÍCITO. Idempotente: o primeiro pedido é o que
   * vale, e um segundo chamador recebe o mesmo resultado em vez de disparar
   * uma segunda escada de sinais sobre um grupo que já está morrendo.
   */
  requestTermination(cause: TerminationCause, detail: string): Promise<TerminationRequest> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.#escalate(cause, detail);
    return this.#inFlight;
  }

  async #escalate(cause: TerminationCause, detail: string): Promise<TerminationRequest> {
    this.disarm();
    const requestedAt = new Date().toISOString();
    const signals: string[] = [];

    this.#signal(this.#input.pgid, 'SIGTERM');
    signals.push('SIGTERM');
    const exitedInGrace = await exitedWithin(this.#input.exited, this.#input.gracePeriodMs);
    if (!exitedInGrace) {
      // Worker que ignora SIGTERM é exatamente o caso que o failsafe existe
      // para cobrir. SIGKILL não pode ser ignorado.
      this.#signal(this.#input.pgid, 'SIGKILL');
      signals.push('SIGKILL');
    }

    this.#request = {
      cause,
      requested_at: requestedAt,
      detail,
      signals_sent: signals,
      grace_period_ms: this.#input.gracePeriodMs,
      provenance: `WorkerSupervisor(pid=${this.#input.pid}, pgid=${this.#input.pgid})`,
    };
    return this.#request;
  }
}

/**
 * Causa de término de um record — inclusive dos ANTIGOS, que não têm o campo.
 *
 * História não é reescrita: um LaunchRecord anterior a esta política registra
 * `timed_out: true` sem causa nenhuma, e o que aquele `true` significava era
 * justamente o deadline derivado da task. Ler isso como
 * `LEGACY_TASK_DEADLINE` é interpretação explícita do leitor, não um campo
 * inventado no arquivo.
 */
export function terminationCauseOf(record: {
  readonly timed_out: boolean;
  readonly termination_cause?: TerminationCause | null;
}): TerminationCause | null {
  if (record.termination_cause != null) return record.termination_cause;
  return record.timed_out ? 'LEGACY_TASK_DEADLINE' : null;
}
