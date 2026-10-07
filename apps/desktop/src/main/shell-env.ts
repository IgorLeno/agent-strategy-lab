/**
 * Ambiente do shell de login do usuário.
 *
 * Aberto pelo launcher do desktop, o app herda o ambiente da sessão gráfica,
 * sem o PATH do shell (`~/.local/bin`, `~/.opencode/bin`): `claude`, `codex`
 * e `opencode` não seriam encontrados. O daemon recebe o ambiente que um
 * terminal teria.
 */
import { execFile } from 'node:child_process';

const MARK = '__ASL_SHELL_ENV__';

/** Extrai `env -0` entre marcadores (o shell interativo pode imprimir antes/depois). */
export function parseEnvDump(output: string): Record<string, string> | null {
  const start = output.indexOf(MARK);
  const end = output.lastIndexOf(MARK);
  if (start === -1 || end <= start) return null;
  const env: Record<string, string> = {};
  for (const entry of output.slice(start + MARK.length, end).split('\0')) {
    const eq = entry.indexOf('=');
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/**
 * Em falha (shell ausente, rc quebrado, timeout) devolve `fallback` e o
 * motivo, para o app avisar em vez de seguir calado com um PATH incompleto.
 */
export function resolveShellEnv(
  fallback: NodeJS.ProcessEnv,
  timeoutMs = 10_000,
): Promise<{ env: NodeJS.ProcessEnv; warning: string | null }> {
  const shell = fallback['SHELL'] ?? '/bin/bash';
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' ${MARK}; env -0; printf '%s' ${MARK}`],
      { env: fallback, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        const parsed = parseEnvDump(stdout);
        if (parsed !== null) resolve({ env: parsed, warning: null });
        else resolve({ env: fallback, warning: `ambiente do shell (${shell}) indisponível: ${error?.message ?? 'saída sem marcadores'}` });
      },
    );
  });
}
