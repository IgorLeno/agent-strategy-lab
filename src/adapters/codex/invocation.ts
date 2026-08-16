import type {
  AdapterInvocation,
  BuildInvocationOptions,
} from '../contract.js';
import { buildInvocationEnvironment } from '../environment.js';

/** Identidade da implementação Codex do adapter, independente da versão da CLI executada. */
export const CODEX_ADAPTER_IDENTITY = { name: 'codex', version: '1.0.0' } as const;

/**
 * Monta a invocation não interativa e JSONL do Codex CLI.
 *
 * A função somente traduz a configuração explícita do envelope em argv, env e
 * stdin. Resolução de binário, spawn e qualquer inferência pertencem ao runtime
 * comum, fora do adapter.
 */
export function buildCodexInvocation(options: BuildInvocationOptions): AdapterInvocation {
  const { agent_profile: agent, compiled_prompt: prompt, environment_profile: environment } =
    options.manifest;

  return {
    argv: [
      agent.cli,
      'exec',
      '--json',
      '--strict-config',
      '--model',
      agent.model,
      ...agent.flags,
      '-',
    ],
    env: buildInvocationEnvironment(environment, options.sourceEnv, options.sanitizedHome),
    stdin: prompt,
  };
}
