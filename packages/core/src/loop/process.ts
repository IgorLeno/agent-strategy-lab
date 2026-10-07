/**
 * Spawn de UM processo de step.
 *
 * O filho nasce em sessão própria (`detached`: setsid), e todo sinal vai para
 * o GRUPO (`-pid`). Assim o kill alcança os netos que a CLI criou — matar só o
 * pid deixaria shells e test runners vivos (LESSONS S04/S14).
 *
 * O único teto é `timeoutMs`, um limite de máquina configurável. Ele não é
 * previsão de duração: existe para que um step travado não segure o loop para
 * sempre (LESSONS 2026-08-27: limite só com causa real).
 */
import { spawn } from 'node:child_process';

export interface ProcessRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin?: string;
  readonly timeoutMs: number;
  /** Tempo entre SIGTERM e SIGKILL no encerramento forçado. */
  readonly killGraceMs?: number;
  /** Cada linha completa do stdout, na ordem, enquanto o processo roda. */
  readonly onStdoutLine?: (line: string) => void;
  /** Aborto externo (app fechando): encerra o grupo como no timeout. */
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /** Erro de spawn (binário ausente etc.); `null` quando o processo existiu. */
  readonly spawnError: string | null;
}

export function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const started = Date.now();
  const grace = request.killGraceMs ?? 5_000;
  const [command, ...args] = request.argv;
  if (command === undefined) throw new Error('argv vazio');

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: request.cwd,
      // PWD herdado aponta para onde o loop roda, não para o repo do step. O
      // OpenCode 1.18 resolve o projeto por PWD e editou o repo errado num
      // probe real (2026-10-07); o cwd do spawn é a única fonte.
      env: { ...request.env, PWD: request.cwd },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let aborted = false;
    let spawnError: string | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Grupo já não existe: nada a encerrar.
      }
    };
    const terminate = (): void => {
      signalGroup('SIGTERM');
      killTimer ??= setTimeout(() => signalGroup('SIGKILL'), grace);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    if (request.signal?.aborted) onAbort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (request.onStdoutLine === undefined) return;
      pending += chunk;
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        request.onStdoutLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      spawnError = error.message;
    });
    // EPIPE quando o filho sai sem ler o stdin não é falha do step.
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.stdin ?? '');

    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
      request.signal?.removeEventListener('abort', onAbort);
      if (pending !== '' && request.onStdoutLine !== undefined) request.onStdoutLine(pending);
      // Netos podem ter sobrevivido ao líder do grupo: encerra o grupo de vez.
      signalGroup('SIGKILL');
      resolve({
        exitCode: code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        aborted,
        spawnError,
      });
    });
  });
}
