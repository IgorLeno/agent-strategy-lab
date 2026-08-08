/**
 * Captura de stdout e stderr para `stdout.log` e `stderr.log`, redigida antes
 * de tocar o disco.
 *
 * A saída vai para o arquivo enquanto o processo ainda roda. Não é otimização:
 * um agente pode falar por dezenas de minutos e produzir centenas de MiB, e a
 * alternativa — juntar tudo em memória e escrever no fim — perde a evidência
 * inteira exatamente nos casos em que ela importa mais (o run que estourou, o
 * que foi morto, o que derrubou o lab por falta de memória).
 *
 * Redigir é o que impõe a única memória retida aqui: o corte é feito em fim de
 * linha, porque um secret partido entre dois chunks não casa com formato nenhum
 * e escaparia se cada pedaço fosse redigido sozinho. O que fica pendurado é a
 * linha em andamento, não o processo. Bloco multi-linha — chave privada — é
 * segurado a partir do `BEGIN` pelo mesmo motivo, com o mesmo teto.
 *
 * O teto existe porque uma linha sem fim é possível: processo que emite
 * megabytes sem um `\n` transformaria "reter a linha em andamento" em "reter
 * tudo". Estourado o teto, o texto é redigido e escrito em pedaços. Um secret
 * partido exatamente nesse corte escapa — é o preço explícito de não deixar o
 * lab morrer de memória por causa de um processo mal comportado, e a cauda
 * retida a cada corte torna esse caso raro em vez de provável.
 *
 * Timeout é deste módulo (M23): SIGTERM ao vencer o prazo, SIGKILL se a graça
 * também vencer sem o processo sair. Sinal ao process group é M24A — aqui o
 * sinal vai só ao processo iniciado, pelo handle que `startProcess` expõe.
 *
 * O sinal reportado no resultado nunca é o que este módulo *mandou* — é o que
 * `spawn.ts` leu do evento `close` do Node, que reflete o motivo real da morte
 * segundo o kernel. Gravar o sinal enviado em vez de esperar esse evento é
 * como um SIGTERM ignorado vira "morto por SIGTERM" na evidência mesmo
 * quando o SIGKILL da escalada é quem de fato encerrou o processo.
 */

import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

import { openMultilineSecretIndex, redactString } from '../storage/index.js';
import { startProcess, type ProcessResult, type SpawnProcessOptions } from './spawn.js';

/** Nomes fixos: a seção `execution/` do run é lida por esses caminhos. */
export const STDOUT_LOG_NAME = 'stdout.log';
export const STDERR_LOG_NAME = 'stderr.log';

/** Teto do texto retido à espera de fim de linha, em unidades de UTF-16. */
const DEFAULT_MAX_PENDING_CHARS = 1 << 20;

/**
 * Fração do teto que fica retida a cada corte forçado. Retê-la dá ao secret
 * que ainda não terminou a chance de chegar inteiro antes do próximo corte, em
 * vez de ser partido na primeira vez que o teto estoura.
 */
const FORCED_FLUSH_CARRY_DIVISOR = 16;

/**
 * Prazo padrão entre o SIGTERM do timeout e o SIGKILL da escalada, quando
 * `timeoutMs` está definido e `gracePeriodMs` não veio explícito.
 */
const DEFAULT_GRACE_PERIOD_MS = 10_000;

export interface CaptureProcessOptions extends SpawnProcessOptions {
  /** Diretório de `stdout.log` e `stderr.log`. Criado se ainda não existir. */
  readonly logDir: string;
  /**
   * Teto do texto retido à espera de fim de linha. Default: 1 MiB. Existe como
   * opção para que o corte forçado possa ser exercitado sem gerar 1 MiB.
   */
  readonly maxPendingChars?: number;
  /**
   * Tempo de execução tolerado antes de mandar SIGTERM. Ausente: sem timeout,
   * o processo roda até terminar por conta própria.
   */
  readonly timeoutMs?: number;
  /**
   * Prazo entre o SIGTERM do timeout e o SIGKILL da escalada. Só importa
   * quando `timeoutMs` está definido. Default: 10s.
   */
  readonly gracePeriodMs?: number;
}

export interface CapturedStream {
  readonly path: string;
  /** Bytes que foram para o disco — os redigidos, não os que o processo emitiu. */
  readonly bytesWritten: number;
}

export interface CaptureResult extends ProcessResult {
  readonly stdout: CapturedStream;
  readonly stderr: CapturedStream;
  /**
   * `true` quando `timeoutMs` venceu e este módulo mandou o SIGTERM que deu
   * início ao desfecho — a dimensão de execução TIMED_OUT, para quem monta o
   * `ExecutionRecord` a decidir. Não depende de qual sinal matou o processo
   * de fato: SIGTERM aceito ou SIGKILL da escalada contam igual como timeout.
   */
  readonly timedOut: boolean;
}

/**
 * A saída do processo não pôde ser persistida.
 *
 * Distinta de um desfecho do processo: disco cheio ou destino sem permissão
 * significam que a evidência do run não existe, e um run sem evidência é
 * `INFRA_ERROR`, não um agente que falhou.
 */
export class ProcessCaptureError extends Error {
  readonly path: string;

  constructor(target: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`não foi possível persistir a captura em ${target}: ${reason}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = new.target.name;
    this.path = target;
  }
}

/**
 * Executa `argv` até o fim, persistindo stdout e stderr redigidos enquanto o
 * processo roda.
 *
 * Rejeita com `ProcessSpawnError` quando o processo não inicia e com
 * `ProcessCaptureError` quando a saída não chega ao disco.
 */
export async function captureProcess(options: CaptureProcessOptions): Promise<CaptureResult> {
  const stdoutPath = path.join(options.logDir, STDOUT_LOG_NAME);
  const stderrPath = path.join(options.logDir, STDERR_LOG_NAME);
  const maxPendingChars = options.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS;

  // Antes do spawn: destino que não dá para criar é problema de infra do lab, e
  // descobrir isso com o agente já rodando custaria o run inteiro.
  await mkdir(options.logDir, { recursive: true });

  const started = await startProcess(options);
  const escalation = scheduleTimeoutEscalation(
    started.child,
    options.timeoutMs,
    options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS,
  );
  const stdout = persist(started.stdout, stdoutPath, maxPendingChars);
  const stderr = persist(started.stderr, stderrPath, maxPendingChars);

  // Os três são esperados sempre: desistir no primeiro erro deixaria o outro
  // pipeline escrevendo em um arquivo que ninguém mais fecha. A escalada em si
  // não entra nesse `allSettled`: ela não tem desfecho próprio para esperar,
  // só sinaliza o processo cujo desfecho já está sendo observado ali.
  const [outcome, stdoutWritten, stderrWritten] = await Promise.allSettled([
    started.result,
    stdout,
    stderr,
  ]);

  // Falha de escrita antes de falha de desfecho: ela traz a causa concreta
  // (ENOSPC, EACCES) e diz que o log no disco não descreve o run.
  if (stdoutWritten.status === 'rejected') throw stdoutWritten.reason;
  if (stderrWritten.status === 'rejected') throw stderrWritten.reason;
  if (outcome.status === 'rejected') throw outcome.reason;

  return {
    ...outcome.value,
    stdout: { path: stdoutPath, bytesWritten: stdoutWritten.value },
    stderr: { path: stderrPath, bytesWritten: stderrWritten.value },
    timedOut: escalation.timedOut(),
  };
}

/**
 * Arma o SIGTERM de `timeoutMs` e, se `child` seguir vivo depois da graça, o
 * SIGKILL da escalada. `timeoutMs` ausente desarma tudo — comportamento
 * idêntico ao de antes do M23.
 *
 * O `exit` do processo é o que desarma os timers, não o envio do sinal: um
 * SIGTERM aceito e um SIGTERM ignorado só se distinguem por o processo ter
 * saído ou não, e só o evento diz isso. Cancelar pelo envio do sinal armaria o
 * SIGKILL mesmo quando o SIGTERM já bastou.
 */
function scheduleTimeoutEscalation(
  child: ChildProcess,
  timeoutMs: number | undefined,
  gracePeriodMs: number,
): { timedOut: () => boolean } {
  if (timeoutMs === undefined) {
    return { timedOut: () => false };
  }

  let timedOut = false;
  let sigtermTimer: NodeJS.Timeout | undefined;
  let sigkillTimer: NodeJS.Timeout | undefined;

  sigtermTimer = setTimeout(() => {
    sigtermTimer = undefined;
    timedOut = true;
    child.kill('SIGTERM');
    sigkillTimer = setTimeout(() => {
      sigkillTimer = undefined;
      child.kill('SIGKILL');
    }, gracePeriodMs);
  }, timeoutMs);

  // `once`: o processo só sai uma vez. Isso corre depois de qualquer timer que
  // já tenha disparado no mesmo instante, então limpar aqui nunca reabre um
  // timer que já mandou seu sinal.
  child.once('exit', () => {
    if (sigtermTimer !== undefined) clearTimeout(sigtermTimer);
    if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
  });

  return { timedOut: () => timedOut };
}

/**
 * Stream que redige o que passa por ele.
 *
 * Só entrega texto que já pode ser redigido com segurança — linhas completas —
 * e devolve a linha parcial do fim do stream como ela veio, sem `\n` inventado:
 * o log é a saída do processo, não uma versão arrumada dela.
 */
export function createRedactingStream(
  maxPendingChars: number = DEFAULT_MAX_PENDING_CHARS,
): Transform {
  // Um caractere multibyte partido entre dois chunks viraria caractere de
  // substituição: o decoder segura os bytes incompletos até o resto chegar.
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      const step = advance(pending + decoder.write(chunk), maxPendingChars);
      pending = step.rest;
      callback(null, step.out === '' ? undefined : step.out);
    },

    flush(callback: TransformCallback) {
      const rest = pending + decoder.end();
      pending = '';
      callback(null, rest === '' ? undefined : redactString(rest));
    },
  });
}

async function persist(source: Readable, target: string, maxPendingChars: number): Promise<number> {
  const file = createWriteStream(target);

  try {
    // `pipeline` é quem faz a captura ser incremental de verdade: a contrapressão
    // do arquivo chega até o pipe do processo, em vez de virar fila em memória.
    await pipeline(source, createRedactingStream(maxPendingChars), file);
  } catch (cause) {
    throw new ProcessCaptureError(target, cause);
  }

  return file.bytesWritten;
}

interface PendingStep {
  /** Texto já redigido, pronto para o disco. */
  readonly out: string;
  /** Texto retido: ainda pode fazer parte de um secret que não terminou. */
  readonly rest: string;
}

function advance(pending: string, maxPendingChars: number): PendingStep {
  const boundary = safeBoundary(pending);
  let out = '';
  let rest = pending;

  if (boundary > 0) {
    out = redactString(pending.slice(0, boundary));
    rest = pending.slice(boundary);
  }
  if (rest.length <= maxPendingChars) return { out, rest };

  // Teto estourado: não há fronteira segura à vista e esperar por uma seria
  // guardar o processo inteiro. Redigir tudo antes de cortar preserva a
  // garantia para todo secret já completo; a cauda retida volta a ser redigida
  // no próximo corte, o que é seguro porque redigir é idempotente.
  const redacted = redactString(rest);
  const carry = Math.floor(maxPendingChars / FORCED_FLUSH_CARRY_DIVISOR);
  const cut = Math.max(0, surrogateSafeIndex(redacted, redacted.length - carry));

  return { out: out + redacted.slice(0, cut), rest: redacted.slice(cut) };
}

/** Fim da última linha completa, ou o começo do bloco multi-linha em aberto. */
function safeBoundary(pending: string): number {
  const afterLastLine = pending.lastIndexOf('\n') + 1;
  if (afterLastLine === 0) return 0;

  const open = openMultilineSecretIndex(pending.slice(0, afterLastLine));
  return open === null ? afterLastLine : open;
}

/**
 * Recua o corte que cairia no meio de um par surrogate. Cortar ali escreveria
 * meio caractere no arquivo e o outro meio depois — bytes preservados, texto
 * corrompido.
 */
function surrogateSafeIndex(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;

  const previous = text.charCodeAt(index - 1);
  return previous >= 0xd800 && previous <= 0xdbff ? index - 1 : index;
}
