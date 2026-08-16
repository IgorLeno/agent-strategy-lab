import type { EnvironmentProfile } from '../../schemas/index.js';
import type {
  AdapterInvocation,
  BuildInvocationOptions,
} from '../contract.js';

/** Identidade da implementação Claude do adapter, independente da versão da CLI executada. */
export const CLAUDE_ADAPTER_IDENTITY = { name: 'claude', version: '1.0.0' } as const;

/**
 * Monta a invocation não interativa e JSONL do Claude Code.
 *
 * Esta função é deliberadamente pura: não resolve binário, não consulta o
 * ambiente global e não inicia processo. Spawn, timeout, cleanup e records
 * continuam pertencendo ao runtime comum.
 */
export function buildClaudeInvocation(options: BuildInvocationOptions): AdapterInvocation {
  const { agent_profile: agent, compiled_prompt: prompt, environment_profile: environment } =
    options.manifest;

  return {
    argv: [
      agent.cli,
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      agent.model,
      ...agent.flags,
    ],
    env: buildEnvironment(environment, options.sourceEnv, options.sanitizedHome),
    stdin: prompt,
  };
}

function buildEnvironment(
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
