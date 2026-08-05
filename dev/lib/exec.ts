import { spawn } from 'node:child_process';
import type { ValidationCommand, ValidationResult } from './schemas.js';

/**
 * GNU coreutils `timeout` já coloca o comando em process group próprio e
 * sinaliza o GRUPO, então a árvore inteira morre — não acrescente `setsid`
 * aqui: uma nova sessão escaparia justamente desse grupo.
 *
 * Exit 124 = o próprio timeout encerrou o comando.
 */
export const TIMEOUT_EXIT_CODE = 124;
const KILL_AFTER = '10s';

export interface RunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}

export interface RunOutcome extends ValidationResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly signal: NodeJS.Signals | null;
}

export function buildTimeoutArgv(argv: readonly string[], timeoutSeconds: number): string[] {
  return [
    'timeout',
    '--signal=TERM',
    `--kill-after=${KILL_AFTER}`,
    `${timeoutSeconds}s`,
    ...argv,
  ];
}

/** Executa argv sem shell, com timeout externo. Nunca lança por exit != 0. */
export function runValidation(
  command: ValidationCommand,
  options: RunOptions,
): Promise<RunOutcome> {
  const [program, ...args] = buildTimeoutArgv(command.argv, command.timeout_seconds);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(program as string, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderr += text;
      options.onStderr?.(text);
    });
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({
        argv: [...command.argv],
        exit_code: exitCode,
        timed_out: exitCode === TIMEOUT_EXIT_CODE,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
        signal,
      });
    });
  });
}

export function toValidationResult(outcome: RunOutcome): ValidationResult {
  return {
    argv: outcome.argv,
    exit_code: outcome.exit_code,
    timed_out: outcome.timed_out,
    duration_ms: outcome.duration_ms,
  };
}
