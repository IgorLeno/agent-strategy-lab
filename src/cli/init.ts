/**
 * Lógica do `agentlab init --repo`: cria somente `.agentlab/project.yaml` no
 * repo-alvo. Arquivo fino de propósito — não deve tocar em mais nada do
 * projeto, e nunca sobrescreve config existente sem `force` explícito.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface RunInitOptions {
  /** Caminho do repositório-alvo onde `.agentlab/project.yaml` será criado. */
  readonly repo: string;
  /** Sobrescreve config existente; sem isso, init é idempotente. */
  readonly force?: boolean;
}

export interface InitResult {
  /** false quando já existia config e `force` não foi passado. */
  readonly created: boolean;
  readonly path: string;
}

const PROJECT_YAML_TEMPLATE = 'schema_version: 1\ndata_dir: data\n';

export async function runInit(options: RunInitOptions): Promise<InitResult> {
  const repoRoot = path.resolve(options.repo);
  const configPath = path.join(repoRoot, '.agentlab', 'project.yaml');

  if (!(options.force ?? false) && (await fileExists(configPath))) {
    return { created: false, path: configPath };
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, PROJECT_YAML_TEMPLATE, 'utf8');
  return { created: true, path: configPath };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
