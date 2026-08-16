import type { EnvironmentProfile } from '../schemas/index.js';

/**
 * Constrói o ambiente explícito compartilhado pelas invocations de providers.
 * Nenhum adapter consulta `process.env`; somente nomes permitidos atravessam.
 */
export function buildInvocationEnvironment(
  profile: EnvironmentProfile,
  source: Readonly<Record<string, string | undefined>>,
  sanitizedHome: string | undefined,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of profile.env_allowlist) {
    if (profile.home === 'sanitized' && name === 'HOME') continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }

  if (profile.home === 'sanitized') {
    if (sanitizedHome === undefined || sanitizedHome.length === 0) {
      throw new Error(`${profile.id}: HOME sanitizado não foi fornecido`);
    }
    env['HOME'] = sanitizedHome;
  }

  return env;
}
