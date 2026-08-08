import { spawn } from 'node:child_process';
import path from 'node:path';

export const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

export interface CliResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Roda `agentlab` como processo real — exit code e stdout são o contrato que
 * o `doctor` expõe, e testar via import esconderia justamente isso.
 */
export function runAgentlabCli(
  args: readonly string[],
  env: Record<string, string> = {},
  cwd: string = REPO_ROOT,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(REPO_ROOT, 'src', 'cli', 'index.ts'),
        ...args,
      ],
      {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
