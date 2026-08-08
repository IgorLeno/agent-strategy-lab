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
 * Captura de stdout e stderr é de M22, timeout e sinais são de M23 e M24A: aqui
 * o stdio é descartado e o processo é esperado até o fim.
 */

import { spawn } from 'node:child_process';

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
  const [command, ...args] = argv;

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });

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
