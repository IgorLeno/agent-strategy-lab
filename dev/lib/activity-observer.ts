/**
 * LIVE ACTIVITY OBSERVATION v1 — observação de atividade DURANTE o run.
 *
 * Até aqui o launcher só sabia ler o worker DEPOIS do término: stdout ia para
 * arquivo, o processo era aguardado, e só então os parsers post-hoc
 * (`readClaudeStream`, `decodeCodexEventStream`) liam a string inteira. O
 * transporte JSONL do Codex já era compreendido — o que não existia, para
 * NENHUM provider, era qualquer leitura do worker enquanto ele ainda rodava.
 *
 * FRONTEIRA SEMÂNTICA, declarada e não negociável:
 *
 *   raw I/O activity != semantic progress.
 *
 * Um byte em stdout prova que o processo está VIVO e falando. Não prova que
 * ele está progredindo, que o que ele escreve faz sentido, ou que ele vai
 * terminar. Nenhum consumidor deste módulo pode tratar atividade como prova de
 * avanço semântico — nem o inverso: silêncio não prova travamento.
 *
 * Por isso os sinais desta v1 são deliberadamente baratos e provider-neutros:
 * timestamp de chunk em stdout, timestamp de chunk em stderr, e os intervalos
 * de silêncio entre eles. Nada aqui interpreta o conteúdo dos bytes.
 */

export type WorkerActivityState = 'RUNNING_ACTIVE' | 'RUNNING_IDLE' | 'STALL_SUSPECTED';

export type ActivitySource = 'stdout' | 'stderr';

export interface WorkerActivityTelemetry {
  readonly schema: 'WORKER_ACTIVITY_V1';
  readonly state: WorkerActivityState;
  /** Instante em que a observação começou (spawn), não o início da task. */
  readonly observation_started_at: string;
  /** `null` enquanto o worker não emitiu um único byte. */
  readonly last_activity_at: string | null;
  readonly last_activity_source: ActivitySource | null;
  readonly stdout_chunks: number;
  readonly stderr_chunks: number;
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
  /** Silêncio corrente no instante do snapshot. */
  readonly current_idle_ms: number;
  /** Maior silêncio observado no run inteiro — o número a calibrar. */
  readonly max_idle_ms: number;
  readonly idle_threshold_ms: number;
  readonly stall_suspicion_threshold_ms: number;
  /** `null` quando nenhum silêncio atravessou o threshold observacional. */
  readonly stall_suspected_at: string | null;
  /**
   * Registrado no próprio telemetry para que nenhum leitor futuro precise
   * inferir se STALL_SUSPECTED matou algo. Nesta fase, nunca matou.
   */
  readonly termination_authority: 'NONE_OBSERVATION_ONLY';
  readonly provenance: readonly string[];
}

export interface ActivityObserverOptions {
  /** RUNNING_ACTIVE -> RUNNING_IDLE. Parâmetro OBSERVACIONAL. */
  readonly idleThresholdMs?: number;
  /** RUNNING_IDLE -> STALL_SUSPECTED. Parâmetro OBSERVACIONAL, sem autoridade. */
  readonly stallSuspicionMs?: number;
  /** Cadência do relógio interno; só precisa ser menor que os thresholds. */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  /**
   * Instante do SPAWN. O observador é construído alguns milissegundos depois
   * dele, e ancorar o relógio de silêncio na própria construção esconderia
   * justamente o começo do run — o trecho onde um worker que nunca fala é mais
   * interessante de observar.
   */
  readonly startedAtMs?: number;
  /**
   * Chamado UMA vez, quando o silêncio corrente cruza `stallSuspicionMs`.
   * Observacional: quem escuta persiste evento e telemetria; encerrar o worker
   * a partir daqui é proibido nesta fase.
   */
  readonly onStallSuspected?: (telemetry: WorkerActivityTelemetry) => void;
}

/**
 * Defaults OBSERVACIONAIS. Eles não foram calibrados — são o ponto de partida
 * grosseiro a partir do qual a distribuição real de silêncio (por provider,
 * model, reasoning effort, task class, dificuldade e outcome) vai ser coletada.
 * Só depois dessa coleta faz sentido discutir se algum múltiplo de sinais pode
 * receber autoridade de termination.
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 60_000;
export const DEFAULT_STALL_SUSPICION_MS = 600_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class ActivityObserver {
  readonly #idleThresholdMs: number;
  readonly #stallSuspicionMs: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #onStallSuspected: ((telemetry: WorkerActivityTelemetry) => void) | undefined;

  readonly #startedAtMs: number;
  #lastActivityMs: number;
  #lastActivitySource: ActivitySource | null = null;
  #stdoutChunks = 0;
  #stderrChunks = 0;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #maxIdleMs = 0;
  #stallSuspectedAtMs: number | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: ActivityObserverOptions = {}) {
    this.#idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.#stallSuspicionMs = options.stallSuspicionMs ?? DEFAULT_STALL_SUSPICION_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#now = options.now ?? Date.now;
    this.#onStallSuspected = options.onStallSuspected;
    this.#startedAtMs = options.startedAtMs ?? this.#now();
    // O relógio de silêncio nasce no spawn: um worker que nunca fala é o caso
    // mais importante a observar, e ele não tem primeiro chunk para ancorar.
    this.#lastActivityMs = this.#startedAtMs;
  }

  /**
   * Um chunk observado. Chamado do listener 'data', que convive com o `pipe`
   * para o arquivo de log — os dois recebem o MESMO chunk, então observar não
   * consome nem trunca byte nenhum do log preservado.
   */
  record(source: ActivitySource, bytes: number): void {
    const now = this.#now();
    this.#observeIdle(now);
    this.#lastActivityMs = now;
    this.#lastActivitySource = source;
    if (source === 'stdout') {
      this.#stdoutChunks += 1;
      this.#stdoutBytes += bytes;
    } else {
      this.#stderrChunks += 1;
      this.#stderrBytes += bytes;
    }
  }

  /** Avança o relógio de silêncio sem que nenhum byte tenha chegado. */
  poll(): WorkerActivityTelemetry {
    this.#observeIdle(this.#now());
    return this.snapshot();
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.poll(), this.#pollIntervalMs);
    // O observador NUNCA segura o processo vivo: ele é telemetria, não trabalho.
    this.#timer.unref?.();
  }

  stop(): WorkerActivityTelemetry {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    return this.poll();
  }

  snapshot(): WorkerActivityTelemetry {
    const now = this.#now();
    const currentIdleMs = Math.max(0, now - this.#lastActivityMs);
    return {
      schema: 'WORKER_ACTIVITY_V1',
      state: this.#stateAt(currentIdleMs),
      observation_started_at: new Date(this.#startedAtMs).toISOString(),
      last_activity_at:
        this.#lastActivitySource === null ? null : new Date(this.#lastActivityMs).toISOString(),
      last_activity_source: this.#lastActivitySource,
      stdout_chunks: this.#stdoutChunks,
      stderr_chunks: this.#stderrChunks,
      stdout_bytes: this.#stdoutBytes,
      stderr_bytes: this.#stderrBytes,
      current_idle_ms: currentIdleMs,
      max_idle_ms: Math.max(this.#maxIdleMs, currentIdleMs),
      idle_threshold_ms: this.#idleThresholdMs,
      stall_suspicion_threshold_ms: this.#stallSuspicionMs,
      stall_suspected_at:
        this.#stallSuspectedAtMs === null ? null : new Date(this.#stallSuspectedAtMs).toISOString(),
      termination_authority: 'NONE_OBSERVATION_ONLY',
      provenance: [
        'timestamp de chunk em stdout do worker (listener live, convive com o pipe do log)',
        'timestamp de chunk em stderr do worker (listener live, convive com o pipe do log)',
        'raw I/O activity != semantic progress: nenhum byte é tratado como prova de avanço',
        'thresholds OBSERVACIONAIS, sem autoridade de termination nesta fase',
      ],
    };
  }

  /**
   * O estado é uma LEITURA CORRENTE do silêncio, não um carimbo permanente:
   * um worker que voltou a falar depois de um silêncio longo está ativo de
   * novo. A evidência durável da suspeita fica em `stall_suspected_at`, que
   * nunca é apagada — é ela que alimenta a calibração.
   */
  #stateAt(currentIdleMs: number): WorkerActivityState {
    if (currentIdleMs >= this.#stallSuspicionMs) return 'STALL_SUSPECTED';
    if (currentIdleMs >= this.#idleThresholdMs) return 'RUNNING_IDLE';
    return 'RUNNING_ACTIVE';
  }

  #observeIdle(now: number): void {
    const idleMs = Math.max(0, now - this.#lastActivityMs);
    if (idleMs > this.#maxIdleMs) this.#maxIdleMs = idleMs;
    if (this.#stallSuspectedAtMs === null && idleMs >= this.#stallSuspicionMs) {
      this.#stallSuspectedAtMs = now;
      // Persistir/observar é tudo o que acontece aqui. Encerrar o worker a
      // partir de uma janela ainda não calibrada seria dar autoridade de
      // termination a um número inventado.
      this.#onStallSuspected?.(this.snapshot());
    }
  }
}
