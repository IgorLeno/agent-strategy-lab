import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { StrategyDef, type StrategyDef as Strategy } from '../schemas/strategy.js';

export { StrategyDef } from '../schemas/strategy.js';
export type { Strategy };

/**
 * Carrega uma receita declarativa em
 * `strategies/<nome>/<versão>/strategy.yaml`. A identidade é conferida contra
 * o caminho solicitado para que um arquivo movido ou copiado não se apresente
 * silenciosamente como outra estratégia.
 */
export async function loadStrategy(
  repoRoot: string,
  name: string,
  version: number,
): Promise<Strategy> {
  const requested = StrategyDef.pick({ name: true, version: true }).parse({ name, version });
  const file = path.join(
    repoRoot,
    'strategies',
    requested.name,
    String(requested.version),
    'strategy.yaml',
  );
  const strategy = StrategyDef.parse(parseYaml(await readFile(file, 'utf8')));

  if (strategy.name !== requested.name || strategy.version !== requested.version) {
    throw new Error(
      `estratégia ${file} declara ${strategy.name}@${strategy.version}, ` +
        `esperado ${requested.name}@${requested.version}`,
    );
  }

  return strategy;
}
