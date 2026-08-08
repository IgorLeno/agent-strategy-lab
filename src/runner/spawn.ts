/**
 * Spawn do processo do run: argv, exit code e sinal.
 *
 * Sempre `argv`, nunca shell. Não é preferência de estilo: com shell no meio, um
 * caminho de repositório com espaço, um argumento com `$`, aspas ou `;` viraria
 * outra linha de comando, e o processo medido pelo experimento não seria o
 * processo descrito pela estratégia. `shell: false` é escrito explicitamente
 * para que a leitura do arquivo responda a pergunta sem depender do default.
 *
 * Falhar em INICIAR o processo não é um resultado do processo. `git`, `pnpm` ou
 * a CLI do provider que não existem no PATH, cwd que não existe, binário sem
 * permissão de execução: nenhum desses casos produziu um exit code, e reportar
 * um seria inventar evidência sobre um agente que nunca rodou. Todos viram
 * `ProcessSpawnError`, que a camada de execução mapeia para `INFRA_ERROR`.
 *
 * O `close` de um spawn que falhou é a armadilha concreta desse caso: o Node
 * emite `error` com `ENOENT` e, logo depois, `close` com `-2` — o errno negado,
 * ocupando a posição do exit code. Quem escutar só o `close` grava `-2` como
 * exit code do agente. E com shell o mesmo caso viraria um `127` legítimo aos
 * olhos de quem lê o record, indistinguível de um comando que rodou e falhou.
 *
 * Duas portas de entrada sobre o mesmo spawn: `spawnProcess`, que descarta o
 * stdio e só devolve o desfecho, e `startProcess`, que entrega o processo vivo
 * com os pipes abertos para quem precisa ler a saída enquanto ela acontece.
 *
 * Timeout e sinais são de M23 e M24A: aqui o processo é esperado até o fim.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

/** Faixa de um exit status POSIX. Fora dela não é exit code de processo nenhum. */
const MAX_EXIT_CODE = 255;

export interface SpawnProcessOptions {
  /**
   * Executável e argumentos, já separados. `argv[0]` é o programa — nunca uma
   * linha de comando para alguém partir depois.
   */
  readonly argv: readonly string[];
  /** cwd do processo. Explícito: herdar o cwd do lab escolheria o diretório por acidente. */
  readonly cwd: string;
  /** Ambiente COMPLETO do processo, não um acréscimo. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Como o processo terminou. Exatamente um dos dois campos é não-nulo: terminou
 * por conta própria com um exit code, ou foi morto por um sinal.
 */
export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Processo já iniciado, com os pipes de saída abertos e o desfecho pendente.
 *
 * `result` observa o processo desde o instante do spawn, e não a partir do
 * momento em que alguém resolve esperá-lo: um processo que morre no mesmo tick
 * em que nasce não perde o desfecho por um listener instalado tarde demais.
 *
 * Os pipes chegam ainda pausados. Ninguém lê a saída antes de quem recebeu
 * este objeto começar a ler, então nenhum byte é perdido no caminho — mas
 * alguém precisa lê-los: pipe cheio e sem leitor bloqueia o processo.
 */
export interface StartedProcess {
  readonly child: ChildProcess;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly result: Promise<ProcessResult>;
}

/**
 * O processo não chegou a rodar, ou terminou sem desfecho utilizável.
 *
 * Existe para ser distinguível de um exit code qualquer: um run que esbarra
 * nisto é `INFRA_ERROR`, e não um agente que falhou a tarefa.
 */
export class ProcessSpawnError extends Error {
  /** errno do sistema (`ENOENT`, `EACCES`, `ENOTDIR`); null quando não veio de um. */
  readonly code: string | null;
  readonly argv: readonly string[];

  constructor(argv: readonly string[], reason: string, cause?: unknown) {
    // argv serializado em JSON, e não juntado por espaços: a mensagem descreve
    // uma lista de argumentos, não um comando que alguém possa colar num shell.
    super(`não foi possível executar ${JSON.stringify(argv)}: ${reason}`, {
      ...(cause === undefined ? {} : { cause }),
    });
    this.name = new.target.name;
    this.argv = [...argv];
    this.code = errnoCode(cause);
  }
}

/**
 * Executa `argv` até o fim e devolve exit code ou sinal.
 *
 * Rejeita com `ProcessSpawnError` quando o processo não inicia ou quando o
 * Node não reporta desfecho nenhum — nesses casos não há exit code para
 * devolver, e a ausência precisa chegar a quem chamou como ausência.
 */
export function spawnProcess(options: SpawnProcessOptions): Promise<ProcessResult> {
  const argv = assertArgv(options.argv);
  // stdio descartado pelo sistema, não por este processo: sem ninguém lendo um
  // pipe, um processo falante enche o buffer do kernel e trava. Quem quer a
  // saída usa `startProcess` — ou `captureProcess`, que já a persiste.
  return launch(argv, options, 'ignore').result;
}

/**
 * Inicia `argv` e devolve o processo vivo, com stdout e stderr em pipe.
 *
 * Rejeita com `ProcessSpawnError` quando o processo não inicia — o mesmo caso
 * que `spawnProcess` trata, resolvido aqui antes de qualquer efeito colateral
 * de quem ia ler a saída.
 */
export function startProcess(options: SpawnProcessOptions): Promise<StartedProcess> {
  const argv = assertArgv(options.argv);

  return new Promise<StartedProcess>((resolve, reject) => {
    const { child, result } = launch(argv, options, 'pipe');

    // `result` só chega a quem chamou depois do `spawn`. Sem este consumidor, a
    // rejeição do processo que nem iniciou viraria unhandledRejection — ninguém
    // teve a chance de esperar por ela.
    result.catch(() => {});

    child.once('error', (error: unknown) => {
      reject(new ProcessSpawnError(argv, describeCause(error), error));
    });

    child.once('spawn', () => {
      const { stdout, stderr } = child;
      // Com `stdio: pipe` os dois existem; a checagem é o que permite tipá-los
      // como presentes para quem recebe, em vez de empurrar a dúvida adiante.
      if (stdout === null || stderr === null) {
        reject(new ProcessSpawnError(argv, 'processo iniciou sem pipe de stdout ou stderr'));
        return;
      }
      resolve({ child, stdout, stderr, result });
    });
  });
}

/**
 * O spawn em si e o observador do desfecho, nascidos juntos: os listeners são
 * instalados no mesmo tick do `spawn`, antes de qualquer await de quem chamou.
 */
function launch(
  argv: readonly [string, ...string[]],
  options: SpawnProcessOptions,
  output: 'ignore' | 'pipe',
): { child: ChildProcess; result: Promise<ProcessResult> } {
  const [command, ...args] = argv;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    stdio: ['ignore', output, output],
  });

  return { child, result: observeOutcome(argv, child) };
}

function observeOutcome(
  argv: readonly [string, ...string[]],
  child: ChildProcess,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve, reject) => {
    // `error` e `close` podem chegar os dois (é o que acontece no ENOENT), então
    // o primeiro desfecho é o que vale: o erro de início nunca é sobrescrito
    // pelo `close` sintético que vem atrás dele.
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      finish();
    };

    child.on('error', (error: unknown) => {
      settle(() => reject(new ProcessSpawnError(argv, describeCause(error), error)));
    });

    child.on('close', (exitCode, signal) => {
      settle(() => {
        // Morte por sinal tem precedência: onde o exit code também vier
        // preenchido, ele é derivado do sinal e não do processo.
        if (signal !== null) {
          resolve({ exitCode: null, signal });
          return;
        }
        if (exitCode === null || !Number.isInteger(exitCode)) {
          reject(new ProcessSpawnError(argv, `terminou sem exit code (code=${exitCode})`));
          return;
        }
        // Rede de segurança para o `-2` do spawn que falhou, caso ele chegue sem
        // o `error` que o antecede: fora da faixa POSIX não é exit code.
        if (exitCode < 0 || exitCode > MAX_EXIT_CODE) {
          reject(new ProcessSpawnError(argv, `exit code fora da faixa POSIX: ${exitCode}`));
          return;
        }
        resolve({ exitCode, signal: null });
      });
    });
  });
}

/**
 * argv chega de arquivo de estratégia e de task spec, então a forma é conferida
 * aqui: um `argv` vazio ou com byte nulo faria o próprio `spawn` lançar de forma
 * síncrona, quebrando a promessa desta função de reportar tudo pela Promise.
 */
function assertArgv(argv: readonly string[]): readonly [string, ...string[]] {
  const [command] = argv;
  if (command === undefined || command === '') {
    throw new TypeError('argv deve começar pelo executável');
  }
  for (const arg of argv) {
    if (arg.includes('\0')) {
      throw new TypeError(`argumento contém byte nulo: ${JSON.stringify(arg)}`);
    }
  }
  return [command, ...argv.slice(1)];
}

function describeCause(cause: unknown): string {
  const code = errnoCode(cause);
  const message = cause instanceof Error ? cause.message : String(cause);
  return code === null ? message : `${code} (${message})`;
}

function errnoCode(cause: unknown): string | null {
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') {
    return cause.code;
  }
  return null;
}
