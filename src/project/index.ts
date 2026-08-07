import path from 'node:path';

/** Parte da configuração do projeto necessária para localizar a evidência. */
export interface DataDirectoryConfig {
  readonly data_dir?: string;
}

export interface ResolveDataDirectoryOptions {
  /** Raiz do agent-strategy-lab; caminhos relativos são resolvidos a partir dela. */
  readonly labRoot?: string;
  readonly config?: DataDirectoryConfig;
  /** Injetável para que consumidores e testes não precisem alterar `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve a raiz dos dados com a mesma precedência usada pela CLI:
 * ambiente, configuração do projeto e, por fim, `<lab>/data`.
 */
export function resolveDataDir(options: ResolveDataDirectoryOptions = {}): string {
  const labRoot = path.resolve(options.labRoot ?? process.cwd());
  const env = options.env ?? process.env;
  const configuredPath = nonEmptyPath(env['AGENTLAB_DATA_DIR']) ??
    nonEmptyPath(options.config?.data_dir) ??
    'data';

  return path.resolve(labRoot, configuredPath);
}

function nonEmptyPath(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
