import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * O core novo COPIA o que reaproveita do control plane antigo; ele nunca o
 * importa. Um import relativo que sai do pacote reacopla o core ao grafo
 * congelado de `src/` e `dev/` (docs/PRODUCT_VISION.md §5).
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_SPECIFIER = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    }),
  );
  return nested.flat();
}

describe('fronteira do pacote', () => {
  it('nenhum arquivo de src/ importa algo fora de packages/core', async () => {
    const escapes: string[] = [];
    for (const file of await sourceFiles(path.join(PACKAGE_ROOT, 'src'))) {
      const text = await readFile(file, 'utf8');
      for (const match of text.matchAll(IMPORT_SPECIFIER)) {
        const specifier = match[1] ?? match[2];
        if (specifier === undefined || !specifier.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), specifier);
        if (!target.startsWith(PACKAGE_ROOT + path.sep)) {
          escapes.push(`${path.relative(PACKAGE_ROOT, file)} -> ${specifier}`);
        }
      }
    }
    expect(escapes).toEqual([]);
  });
});
